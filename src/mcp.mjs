import process from 'node:process';
import {
  boardHome,
  registerAgent,
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
  listAgents,
} from './board.mjs';

/**
 * Minimal MCP (Model Context Protocol) stdio server exposing the board.
 * JSON-RPC 2.0, one JSON object per line, no dependencies.
 */

const TOOLS = [
  {
    name: 'board_post',
    description:
      'Post a task to the shared board. Use blocked_by for dependencies, capabilities for required skills, and client_token for idempotent retries.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line: what must be done' },
        body: { type: 'string', description: 'Details: acceptance criteria, where to put outputs, what not to touch' },
        from: { type: 'string', description: 'Your agent name' },
        to: { type: 'string', description: 'Only this agent may claim it (optional)' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Skills the claimant must have' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must be done first' },
        reply_to: { type: 'string', description: 'Task id this is a reply to (hop counting applies)' },
        max_attempts: { type: 'number', description: 'Default 3' },
        lease_ms: { type: 'number', description: 'Claim lease in ms, default 600000' },
        client_token: { type: 'string', description: 'Idempotency token' },
      },
      required: ['title'],
    },
  },
  {
    name: 'board_list',
    description: 'List tasks, optionally filtered by state or assignee.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['queued', 'claimed', 'done', 'failed', 'cancelled', 'any'] },
        to: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'board_claim',
    description:
      'Atomically claim the oldest task you are able to do. Exactly one claimant wins. Returns {ok:true,task} or {ok:false,reason}.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'string' } },
        id: { type: 'string', description: 'Claim this specific task id (optional)' },
        lease_ms: { type: 'number' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'board_renew',
    description: 'Extend your lease while still working (heartbeat).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, agent: { type: 'string' }, lease_ms: { type: 'number' } },
      required: ['id', 'agent'],
    },
  },
  {
    name: 'board_complete',
    description: 'Finish a claimed task with a summary, evidence, and artifact paths (files stay on disk; only refs and hashes are stored).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        agent: { type: 'string' },
        summary: { type: 'string' },
        evidence: { type: 'string', description: 'What proves it works: command output, test result, file diff' },
        artifacts: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'board_fail',
    description: 'Give up a claimed task. retryable=true puts it back on the board until max attempts.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        agent: { type: 'string' },
        reason: { type: 'string' },
        retryable: { type: 'boolean' },
      },
      required: ['id', 'reason'],
    },
  },
  {
    name: 'board_show',
    description: 'Read one task with its full history.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'board_stats',
    description: 'Board health: counts, blocked tasks, oldest queued, active leases.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'board_reap',
    description: 'Return expired leases to the board (run this from a cron/timer).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_register',
    description: 'Publish your capability card so others can route work to you.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agent_list',
    description: 'List registered agents and their capabilities.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function callTool(name, args, home) {
  switch (name) {
    case 'board_post': {
      const t = postTask({
        title: args.title,
        body: args.body,
        from: args.from ?? process.env.TASKBOARD_AGENT ?? 'unknown',
        to: args.to ?? null,
        capabilities: args.capabilities,
        blockedBy: args.blocked_by,
        replyTo: args.reply_to ?? null,
        maxAttempts: args.max_attempts,
        leaseMs: args.lease_ms,
        clientToken: args.client_token ?? null,
        home,
      });
      return { ok: true, id: t.id, deduplicated: Boolean(t.deduplicated), task: t };
    }
    case 'board_list':
      return { ok: true, tasks: listTasks({ state: args.state, to: args.to, limit: args.limit, home }) };
    case 'board_claim': {
      const r = claimTask({ agent: args.agent, capabilities: args.capabilities, id: args.id, leaseMs: args.lease_ms, home });
      return r.ok ? { ok: true, task: r.task } : { ok: false, reason: r.reason };
    }
    case 'board_renew':
      return { ok: true, task: renewLease({ id: args.id, agent: args.agent, leaseMs: args.lease_ms, home }) };
    case 'board_complete':
      return {
        ok: true,
        task: completeTask({
          id: args.id,
          agent: args.agent,
          summary: args.summary,
          evidence: args.evidence,
          artifacts: args.artifacts,
          home,
        }),
      };
    case 'board_fail':
      return {
        ok: true,
        task: failTask({ id: args.id, agent: args.agent, reason: args.reason, retryable: args.retryable, home }),
      };
    case 'board_show': {
      const hit = showTask(args.id, { home });
      if (!hit) return { ok: false, reason: 'not_found' };
      return { ok: true, state: hit.state, task: hit.task };
    }
    case 'board_stats':
      return { ok: true, stats: boardStats({ home }) };
    case 'board_reap':
      return { ok: true, ...reapExpired({ home }) };
    case 'agent_register':
      return {
        ok: true,
        agent: registerAgent({ agent: args.name, capabilities: args.capabilities, description: args.description, home }),
      };
    case 'agent_list':
      return { ok: true, agents: listAgents({ home }) };
    default:
      return { ok: false, reason: `unknown tool ${name}` };
  }
}

export function startMcpServer({ home = boardHome() } = {}) {
  let buf = '';
  const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        fail(null, -32700, 'parse error');
        continue;
      }
      const { id = null, method, params = {} } = req;
      if (id === null && method?.startsWith('notifications/')) continue;
      try {
        switch (method) {
          case 'initialize':
            reply(id, {
              protocolVersion: params.protocolVersion || '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'mcp-task-board', version: '0.1.0' },
            });
            break;
          case 'notifications/initialized':
            break;
          case 'tools/list':
            reply(id, { tools: TOOLS });
            break;
          case 'tools/call': {
            const result = callTool(params.name, params.arguments || {}, home);
            reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
            break;
          }
          case 'ping':
            reply(id, {});
            break;
          default:
            fail(id, -32601, `method not found: ${method}`);
        }
      } catch (e) {
        fail(id, -32603, String(e?.message ?? e));
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
