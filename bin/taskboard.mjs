#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  boardHome,
  ensureBoard,
  registerAgent,
  listAgents,
  postTask,
  listTasks,
  claimTask,
  renewLease,
  completeTask,
  failTask,
  cancelTask,
  reapExpired,
  showTask,
  boardStats,
  readEvents,
} from '../src/board.mjs';
import { startMcpServer } from '../src/mcp.mjs';

const HELP = `mcp-task-board — a shared task board for heterogeneous AI agents

USAGE
  mcp-task-board <command> [options]

BOARD
  post       --title "..." [--body "..." | --body-file f] [--to name] [--from name]
             [--cap a,b] [--blocked-by id,id] [--reply-to id] [--client-token t]
             [--max-attempts n] [--lease-min m]
  list       [--state queued|claimed|done|failed|cancelled|any] [--to name] [--agent name]
             [--limit n] [--json]
  show       <id> [--json]
  claim      --agent name [--cap a,b] [--id id] [--lease-min m] [--json]
  renew      <id> --agent name [--lease-min m]
  complete   <id> [--agent name] [--summary "..."] [--evidence "..."] [--artifact path]
  fail       <id> [--agent name] [--reason "..."] [--retry]
  cancel     <id> [--by name] [--reason "..."]
  reap       Return expired leases to the board
  stats      [--json]
  events     [--tail n] [--json]

AGENTS
  agents list
  agents register --name name [--cap a,b] [--description "..."]

INTEGRATION
  mcp        Run as an MCP stdio server (for Claude Code, WorkBuddy, DeepSeek Harness, ...)
  init       Create the board directory

GLOBAL
  --home <dir>        Board root (default $TASKBOARD_HOME or ~/.mcp-task-board)
  --json              Machine-readable output

EXIT CODES
  0 ok   1 error   2 nothing to claim

AGENT NAMES
  --agent name   who is acting (default $TASKBOARD_AGENT or "unknown")
`;

function parse(argv) {
  const out = { _: [], artifact: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'json' || key === 'retry' || key === 'help') {
      out[key] = true;
      continue;
    }
    if (key === 'artifact') {
      if (next === undefined) throw new Error('--artifact needs a path');
      out.artifact.push(next);
      i++;
      continue;
    }
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

const csv = (v) =>
  typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

function body(opts) {
  if (opts['body-file']) return fs.readFileSync(path.resolve(opts['body-file']), 'utf8');
  return typeof opts.body === 'string' ? opts.body : '';
}

function printTask(t) {
  const lease = t.claim?.leaseUntil ? ` lease=${t.claim.leaseUntil}` : '';
  const owner = t.claim?.by ? ` by=${t.claim.by}` : '';
  console.log(`${t.id}  [${t.state}]${owner}${lease}  ${t.title}`);
}

function table(tasks) {
  if (tasks.length === 0) {
    console.log('(no tasks)');
    return;
  }
  for (const t of tasks) printTask(t);
}

function run(argv) {
  const opts = parse(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const home = opts.home ? path.resolve(opts.home) : boardHome();
  const cmd = opts._[0];
  const agent = opts.agent ?? process.env.TASKBOARD_AGENT ?? 'unknown';

  switch (cmd) {
    case 'init': {
      const p = ensureBoard(home);
      registerAgent({ agent, capabilities: csv(opts.cap), home });
      console.log(JSON.stringify({ ok: true, home: p.home }, null, 2));
      return 0;
    }
    case 'post': {
      const t = postTask({
        title: opts.title,
        body: body(opts),
        from: opts.from ?? agent,
        to: opts.to ?? null,
        capabilities: csv(opts.cap),
        blockedBy: csv(opts['blocked-by']),
        replyTo: opts['reply-to'] ?? null,
        maxAttempts: opts['max-attempts'],
        leaseMs: opts['lease-min'] ? Number(opts['lease-min']) * 60_000 : undefined,
        clientToken: opts['client-token'] ?? null,
        home,
      });
      if (opts.json) console.log(JSON.stringify(t, null, 2));
      else {
        printTask(t);
        if (t.deduplicated) console.log('(deduplicated by client-token)');
      }
      return 0;
    }
    case 'list': {
      const tasks = listTasks({ state: opts.state, to: opts.to, agent: opts.agent, limit: opts.limit ? Number(opts.limit) : 50, home });
      if (opts.json) console.log(JSON.stringify(tasks, null, 2));
      else table(tasks);
      return 0;
    }
    case 'show': {
      const id = opts._[1];
      if (!id) throw new Error('show needs a task id');
      const hit = showTask(id, { home });
      if (!hit) throw new Error(`task ${id} not found`);
      console.log(JSON.stringify({ state: hit.state, task: hit.task }, null, 2));
      return 0;
    }
    case 'claim': {
      const r = claimTask({
        agent,
        capabilities: csv(opts.cap),
        id: opts.id ?? opts._[1] ?? null,
        leaseMs: opts['lease-min'] ? Number(opts['lease-min']) * 60_000 : undefined,
        home,
      });
      if (r.ok) {
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else printTask(r.task);
        return 0;
      }
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else console.log(`nothing to claim (${r.reason})`);
      return 2;
    }
    case 'renew': {
      const id = opts._[1];
      if (!id) throw new Error('renew needs a task id');
      const t = renewLease({ id, agent, leaseMs: opts['lease-min'] ? Number(opts['lease-min']) * 60_000 : undefined, home });
      printTask(t);
      return 0;
    }
    case 'complete': {
      const id = opts._[1];
      if (!id) throw new Error('complete needs a task id');
      const t = completeTask({
        id,
        agent: opts.agent ?? null,
        summary: typeof opts.summary === 'string' ? opts.summary : '',
        evidence: typeof opts.evidence === 'string' ? opts.evidence : '',
        artifacts: opts.artifact,
        home,
      });
      console.log(JSON.stringify({ ok: true, id: t.id, state: t.state, result: t.result }, null, 2));
      return 0;
    }
    case 'fail': {
      const id = opts._[1];
      if (!id) throw new Error('fail needs a task id');
      const t = failTask({
        id,
        agent: opts.agent ?? null,
        reason: typeof opts.reason === 'string' ? opts.reason : 'failed',
        retryable: Boolean(opts.retry),
        home,
      });
      printTask(t);
      return 0;
    }
    case 'cancel': {
      const id = opts._[1];
      if (!id) throw new Error('cancel needs a task id');
      const t = cancelTask({ id, by: opts.by ?? agent, reason: typeof opts.reason === 'string' ? opts.reason : '', home });
      printTask(t);
      return 0;
    }
    case 'reap': {
      const r = reapExpired({ home });
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`returned ${r.reclaimed.length} to the board, failed ${r.expired.length}`);
        table([...r.reclaimed, ...r.expired]);
      }
      return 0;
    }
    case 'stats': {
      const s = boardStats({ home });
      if (opts.json) console.log(JSON.stringify(s, null, 2));
      else {
        console.log(`board: ${s.home}`);
        console.log(`queued=${s.queued} (blocked ${s.blocked})  claimed=${s.claimed}  done=${s.done}  failed=${s.failed}  cancelled=${s.cancelled}  agents=${s.agents}`);
        if (s.oldestQueuedMinutes !== null) console.log(`oldest queued: ${s.oldestQueuedMinutes} min`);
        for (const l of s.claimed_leases) console.log(`  lease ${l.id} by ${l.by} until ${l.leaseUntil}`);
      }
      return 0;
    }
    case 'events': {
      const rows = readEvents({ home, tail: opts.tail ? Number(opts.tail) : 20 });
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(`${r.at}  ${r.event}  ${r.id ?? ''}  ${r.agent ?? ''}`);
      return 0;
    }
    case 'agents': {
      const sub = opts._[1] ?? 'list';
      if (sub === 'register') {
        const card = registerAgent({
          agent: opts.name ?? agent,
          capabilities: csv(opts.cap),
          description: typeof opts.description === 'string' ? opts.description : '',
          home,
        });
        console.log(JSON.stringify(card, null, 2));
        return 0;
      }
      const rows = listAgents({ home });
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else for (const a of rows) console.log(`${a.name}  [${a.capabilities.join(', ') || 'no caps'}]  seen ${a.lastSeenAt}`);
      return 0;
    }
    case 'mcp':
      startMcpServer({ home });
      return 0;
    case undefined:
    case 'help':
      console.log(HELP);
      return 0;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (e) {
  console.error(`mcp-task-board: ${e?.message ?? e}`);
  process.exitCode = 1;
}
