import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * MCP Task Board — a filesystem task board that heterogeneous agents can share.
 *
 * The board is a directory tree; every transition is a rename, so two agents on
 * different runtimes (or different machines, over a mounted share) can race for
 * the same task and exactly one wins.
 *
 *   tasks/queued/<id>.json    waiting, may be blocked
 *   tasks/claimed/<id>.json   owned, with a lease
 *   tasks/done/<id>.json      finished, with evidence + artifacts
 *   tasks/failed/<id>.json    given up
 *   tasks/cancelled/<id>.json withdrawn
 *   agents/<name>.json        capability cards + heartbeat
 *   events.jsonl              append-only transition log
 *   locks/<id>/               short-lived critical sections
 */

export const SCHEMA = 1;
const TERMINAL = ['done', 'failed', 'cancelled'];

export function boardHome(env = process.env) {
  if (env.TASKBOARD_HOME) return path.resolve(env.TASKBOARD_HOME);
  if (env.TASKBOARD_DIR) return path.resolve(env.TASKBOARD_DIR);
  return path.join(os.homedir(), '.mcp-task-board');
}

export function paths(home) {
  return {
    home,
    tasks: path.join(home, 'tasks'),
    queued: path.join(home, 'tasks', 'queued'),
    claimed: path.join(home, 'tasks', 'claimed'),
    done: path.join(home, 'tasks', 'done'),
    failed: path.join(home, 'tasks', 'failed'),
    cancelled: path.join(home, 'tasks', 'cancelled'),
    agents: path.join(home, 'agents'),
    locks: path.join(home, 'locks'),
    events: path.join(home, 'events.jsonl'),
  };
}

export function ensureBoard(home = boardHome()) {
  const p = paths(home);
  for (const d of [p.tasks, p.queued, p.claimed, p.done, p.failed, p.cancelled, p.agents, p.locks]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return p;
}

const iso = (d = new Date()) => d.toISOString();
const idStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function newTaskId(now = new Date()) {
  return `ab-${idStamp(now)}-${crypto.randomBytes(3).toString('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows refuses rename onto an existing file; fall back for updates.
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

function appendEvent(p, event, task, extra = {}) {
  const line = JSON.stringify({
    at: iso(),
    event,
    id: task?.id ?? null,
    agent: extra.agent ?? null,
    ...extra,
  });
  fs.appendFileSync(p.events, `${line}\n`, 'utf8');
}

function findTask(p, id) {
  for (const state of ['queued', 'claimed', 'done', 'failed', 'cancelled']) {
    const file = path.join(p[state], `${id}.json`);
    if (fs.existsSync(file)) return { state, file, task: readJson(file) };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* locks                                                              */
/* ------------------------------------------------------------------ */

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(p, id, fn, { staleMs = 30_000, waitMs = 5_000 } = {}) {
  const dir = path.join(p.locks, `${id}.lock`);
  const deadline = Date.now() + waitMs;
  let held = false;
  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(dir);
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(dir).mtimeMs;
        if (age > staleMs) {
          fs.rmdirSync(dir);
          continue;
        }
      } catch {
        continue; // lock vanished, retry immediately
      }
      sleepMs(15);
    }
  }
  if (!held) throw new Error(`could not lock ${id}`);
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ */
/* agents                                                             */
/* ------------------------------------------------------------------ */

export function registerAgent({ agent, capabilities = [], description = '', home = boardHome() }) {
  if (!agent) throw new Error('agent is required');
  const p = ensureBoard(home);
  const file = path.join(p.agents, `${agent}.json`);
  const prev = fs.existsSync(file) ? readJson(file) : null;
  const card = {
    schema: SCHEMA,
    name: agent,
    description: description || prev?.description || '',
    capabilities: [...new Set([...(capabilities || []), ...(prev?.capabilities || [])])].sort(),
    registeredAt: prev?.registeredAt ?? iso(),
    lastSeenAt: iso(),
    heartbeats: (prev?.heartbeats ?? 0) + 1,
  };
  writeJsonAtomic(file, card);
  return card;
}

export function listAgents({ home = boardHome() } = {}) {
  const p = ensureBoard(home);
  return fs
    .readdirSync(p.agents)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(p.agents, f)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function agentCard(agent, home = boardHome()) {
  const file = path.join(paths(home).agents, `${agent}.json`);
  return fs.existsSync(file) ? readJson(file) : null;
}

/* ------------------------------------------------------------------ */
/* posting                                                            */
/* ------------------------------------------------------------------ */

function normalizeCaps(caps) {
  return [...new Set((caps || []).map((c) => String(c).trim()).filter(Boolean))].sort();
}

export function postTask({
  title,
  body = '',
  from = 'unknown',
  to = null,
  capabilities = [],
  blockedBy = [],
  replyTo = null,
  hops = 0,
  maxHops = 4,
  maxAttempts = 3,
  leaseMs = 10 * 60_000,
  clientToken = null,
  allowMissingDeps = false,
  meta = null,
  home = boardHome(),
} = {}) {
  if (!title) throw new Error('title is required');
  const p = ensureBoard(home);

  if (clientToken) {
    const hit = findByClientToken(p, clientToken);
    if (hit) return { ...hit.task, deduplicated: true };
  }
  if (replyTo && hops >= maxHops) {
    throw new Error(`hop limit reached (${hops}/${maxHops}); hand the task back to a human`);
  }
  for (const dep of blockedBy) {
    if (!findTask(p, dep)) {
      if (!allowMissingDeps) throw new Error(`blockedBy: unknown task ${dep}`);
      continue;
    }
  }

  const id = newTaskId();
  const now = iso();
  const task = {
    schema: SCHEMA,
    id,
    clientToken,
    title,
    body,
    meta: meta && typeof meta === 'object' ? meta : {},
    from,
    to,
    capabilities: normalizeCaps(capabilities),
    blockedBy: [...blockedBy],
    replyTo,
    hops: Number(hops) || 0,
    maxHops: Number(maxHops) || 4,
    state: 'queued',
    attempts: 0,
    budget: { maxAttempts: Number(maxAttempts) || 3, leaseMs: Number(leaseMs) || 600_000 },
    claim: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, event: 'posted', by: from }],
  };
  writeJsonAtomic(path.join(p.queued, `${id}.json`), task);
  appendEvent(p, 'posted', task, { agent: from });
  return task;
}

function findByClientToken(p, token) {
  if (!token) return undefined;
  for (const state of ['queued', 'claimed', 'done', 'failed', 'cancelled']) {
    for (const f of fs.readdirSync(p[state])) {
      if (!f.endsWith('.json')) continue;
      const t = readJson(path.join(p[state], f));
      if (t.clientToken === token) return { state, task: t, file: path.join(p[state], f) };
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* dependencies                                                       */
/* ------------------------------------------------------------------ */

export function depsSatisfied(p, task) {
  return (task.blockedBy || []).every((dep) => {
    const hit = findTask(p, dep);
    return hit && hit.state === 'done';
  });
}

/* ------------------------------------------------------------------ */
/* claiming                                                           */
/* ------------------------------------------------------------------ */

function capabilitiesFit(task, agentCaps) {
  if (!task.capabilities || task.capabilities.length === 0) return true;
  const have = new Set(agentCaps || []);
  return task.capabilities.every((c) => have.has(c));
}

function claimBlockReason(p, task, { agent, capabilities, now }) {
  if (task.to && task.to !== agent) return 'addressed_to_other';
  if (!capabilitiesFit(task, capabilities)) return 'capability_mismatch';
  if (!depsSatisfied(p, task)) return 'blocked_by_dependencies';
  if (task.attempts >= task.budget.maxAttempts) return 'attempts_exhausted';
  return null;
}

const BLOCK_PRIORITY = {
  no_tasks: -1,
  lost_race: 0,
  attempts_exhausted: 1,
  addressed_to_other: 2,
  capability_mismatch: 3,
  blocked_by_dependencies: 4,
};

function betterReason(a, b) {
  return (BLOCK_PRIORITY[b] ?? 0) > (BLOCK_PRIORITY[a] ?? 0) ? b : a;
}

/**
 * Claim one task. Atomic: the winner is whoever renames the file first.
 * Returns { ok, task } or { ok: false, reason }.
 */
export function claimTask({ agent, capabilities = [], id = null, leaseMs = null, home = boardHome() } = {}) {
  if (!agent) throw new Error('agent is required');
  const p = ensureBoard(home);
  const card = agentCard(agent, home);
  const caps = capabilities && capabilities.length ? capabilities : card?.capabilities ?? [];
  const now = Date.now();
  let lastReason = 'no_tasks';

  const candidates = (id ? [id] : fs.readdirSync(p.queued).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)))
    .map((candidate) => {
      const file = path.join(p.queued, `${candidate}.json`);
      return fs.existsSync(file) ? readJson(file) : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  for (const candidate of candidates) {
    const reason = claimBlockReason(p, candidate, { agent, capabilities: caps, now });
    if (reason) {
      lastReason = betterReason(lastReason, reason);
      continue;
    }
    const from = path.join(p.queued, `${candidate.id}.json`);
    const to = path.join(p.claimed, `${candidate.id}.json`);
    try {
      fs.renameSync(from, to); // <-- the whole race is settled here
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
        lastReason = 'lost_race';
        continue;
      }
      throw e;
    }
    const task = readJson(to);
    const lease = Number(leaseMs) || task.budget.leaseMs;
    const at = iso();
    task.state = 'claimed';
    task.claim = { by: agent, at, leaseUntil: iso(new Date(now + lease)), heartbeatAt: at };
    task.attempts += 1;
    task.updatedAt = at;
    task.history.push({ at, event: 'claimed', by: agent });
    writeJsonAtomic(to, task);
    appendEvent(p, 'claimed', task, { agent, leaseMs: lease });
    return { ok: true, task };
  }
  return { ok: false, reason: lastReason };
}

/* ------------------------------------------------------------------ */
/* lease, completion, failure                                         */
/* ------------------------------------------------------------------ */

export function renewLease({ id, agent, leaseMs = null, home = boardHome() } = {}) {
  const p = ensureBoard(home);
  return withLock(p, id, () => {
    const hit = findTask(p, id);
    if (!hit) throw new Error(`unknown task ${id}`);
    if (hit.state !== 'claimed') throw new Error(`task ${id} is ${hit.state}, not claimed`);
    if (hit.task.claim?.by !== agent) throw new Error(`task ${id} is owned by ${hit.task.claim?.by}`);
    const lease = Number(leaseMs) || hit.task.budget.leaseMs;
    const now = iso();
    hit.task.claim.leaseUntil = iso(new Date(Date.now() + lease));
    hit.task.claim.heartbeatAt = now;
    hit.task.updatedAt = now;
    hit.task.history.push({ at: now, event: 'renewed', by: agent });
    writeJsonAtomic(hit.file, hit.task);
    appendEvent(p, 'renewed', hit.task, { agent });
    return hit.task;
  });
}

function hashArtifact(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > 64 * 1024 * 1024) return { path: file, bytes: st.size, sha256: null };
    const buf = fs.readFileSync(file);
    return { path: file, bytes: st.size, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  } catch {
    return { path: file, bytes: null, sha256: null };
  }
}

export function completeTask({ id, agent = null, summary = '', evidence = '', artifacts = [], home = boardHome() } = {}) {
  const p = ensureBoard(home);
  return withLock(p, id, () => {
    const hit = findTask(p, id);
    if (!hit) throw new Error(`unknown task ${id}`);
    if (hit.state !== 'claimed') throw new Error(`task ${id} is ${hit.state}, not claimed`);
    if (agent && hit.task.claim?.by && hit.task.claim.by !== agent) {
      throw new Error(`task ${id} is owned by ${hit.task.claim.by}`);
    }
    const at = iso();
    hit.task.state = 'done';
    hit.task.result = {
      status: 'done',
      summary,
      evidence,
      artifacts: (artifacts || []).map((a) => hashArtifact(path.resolve(a))),
      by: agent || hit.task.claim?.by || 'unknown',
      at,
    };
    hit.task.updatedAt = at;
    hit.task.history.push({ at, event: 'completed', by: hit.task.result.by });
    writeJsonAtomic(path.join(p.done, `${id}.json`), hit.task);
    fs.rmSync(hit.file, { force: true });
    appendEvent(p, 'completed', hit.task, { agent: hit.task.result.by });
    return hit.task;
  });
}

export function failTask({ id, agent = null, reason = '', retryable = false, home = boardHome() } = {}) {
  const p = ensureBoard(home);
  return withLock(p, id, () => {
    const hit = findTask(p, id);
    if (!hit) throw new Error(`unknown task ${id}`);
    if (hit.state !== 'claimed') throw new Error(`task ${id} is ${hit.state}, not claimed`);
    const at = iso();
    const canRetry = retryable && hit.task.attempts < hit.task.budget.maxAttempts;
    if (canRetry) {
      hit.task.state = 'queued';
      hit.task.claim = null;
      hit.task.updatedAt = at;
      hit.task.history.push({ at, event: 'failed_retryable', by: agent || 'unknown', note: reason });
      writeJsonAtomic(path.join(p.queued, `${id}.json`), hit.task);
      fs.rmSync(hit.file, { force: true });
      appendEvent(p, 'failed_retryable', hit.task, { agent, note: reason });
      return hit.task;
    }
    hit.task.state = 'failed';
    hit.task.result = { status: 'failed', summary: reason, by: agent || hit.task.claim?.by || 'unknown', at };
    hit.task.updatedAt = at;
    hit.task.history.push({ at, event: 'failed', by: hit.task.result.by, note: reason });
    writeJsonAtomic(path.join(p.failed, `${id}.json`), hit.task);
    fs.rmSync(hit.file, { force: true });
    appendEvent(p, 'failed', hit.task, { agent, note: reason });
    return hit.task;
  });
}

export function cancelTask({ id, by = 'unknown', reason = '', home = boardHome() } = {}) {
  const p = ensureBoard(home);
  const hit = findTask(p, id);
  if (!hit) throw new Error(`unknown task ${id}`);
  if (TERMINAL.includes(hit.state)) throw new Error(`task ${id} is already ${hit.state}`);
  const at = iso();
  hit.task.state = 'cancelled';
  hit.task.result = { status: 'cancelled', summary: reason, by, at };
  hit.task.updatedAt = at;
  hit.task.history.push({ at, event: 'cancelled', by, note: reason });
  writeJsonAtomic(path.join(p.cancelled, `${id}.json`), hit.task);
  fs.rmSync(hit.file, { force: true });
  appendEvent(p, 'cancelled', hit.task, { agent: by, note: reason });
  return hit.task;
}

/**
 * Return expired leases to the board. Attempts are counted already at claim
 * time, so a task that keeps dying on its owner eventually lands in failed/.
 */
export function reapExpired({ agent = 'reaper', home = boardHome(), now = new Date() } = {}) {
  const p = ensureBoard(home);
  const reclaimed = [];
  const expired = [];
  for (const f of fs.readdirSync(p.claimed)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    const hit = findTask(p, id);
    if (!hit || hit.state !== 'claimed') continue;
    const until = hit.task.claim?.leaseUntil;
    if (!until || new Date(until) > now) continue;
    withLock(p, id, () => {
      const fresh = findTask(p, id);
      if (!fresh || fresh.state !== 'claimed') return;
      if (new Date(fresh.task.claim.leaseUntil) > now) return; // renewed meanwhile
      const at = iso();
      if (fresh.task.attempts >= fresh.task.budget.maxAttempts) {
        fresh.task.state = 'failed';
        fresh.task.result = { status: 'failed', summary: 'lease expired; attempts exhausted', by: agent, at };
        fresh.task.updatedAt = at;
        fresh.task.history.push({ at, event: 'lease_expired_final', by: agent });
        writeJsonAtomic(path.join(p.failed, `${id}.json`), fresh.task);
        fs.rmSync(fresh.file, { force: true });
        appendEvent(p, 'lease_expired_final', fresh.task, { agent });
        expired.push(fresh.task);
      } else {
        fresh.task.state = 'queued';
        fresh.task.claim = null;
        fresh.task.updatedAt = at;
        fresh.task.history.push({ at, event: 'lease_expired', by: agent });
        writeJsonAtomic(path.join(p.queued, `${id}.json`), fresh.task);
        fs.rmSync(fresh.file, { force: true });
        appendEvent(p, 'lease_expired', fresh.task, { agent });
        reclaimed.push(fresh.task);
      }
    });
  }
  return { reclaimed, expired };
}

/* ------------------------------------------------------------------ */
/* queries                                                            */
/* ------------------------------------------------------------------ */

export function listTasks({ state = 'any', to = null, agent = null, limit = 50, home = boardHome() } = {}) {
  const p = ensureBoard(home);
  const states = state && state !== 'any' ? [state] : ['queued', 'claimed', 'done', 'failed', 'cancelled'];
  const rows = [];
  for (const s of states) {
    if (!p[s]) continue;
    for (const f of fs.readdirSync(p[s])) {
      if (!f.endsWith('.json')) continue;
      const t = readJson(path.join(p[s], f));
      if (to && t.to !== to) continue;
      if (agent && t.claim?.by !== agent) continue;
      rows.push(t);
    }
  }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows.slice(0, limit);
}

export function showTask(id, { home = boardHome() } = {}) {
  return findTask(ensureBoard(home), id);
}

export function boardStats({ home = boardHome() } = {}) {
  const p = ensureBoard(home);
  const count = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  const queued = listTasks({ state: 'queued', home, limit: 10_000 });
  const claimed = listTasks({ state: 'claimed', home, limit: 10_000 });
  const done = listTasks({ state: 'done', home, limit: 10_000 });
  const failed = listTasks({ state: 'failed', home, limit: 10_000 });
  const blocked = queued.filter((t) => !depsSatisfied(p, t)).length;
  const oldest = queued.map((t) => Date.parse(t.createdAt)).sort((a, b) => a - b)[0];
  return {
    home: p.home,
    queued: count(p.queued),
    claimed: count(p.claimed),
    done: count(p.done),
    failed: count(p.failed),
    cancelled: count(p.cancelled),
    blocked,
    agents: listAgents({ home }).length,
    oldestQueuedMinutes: oldest ? Math.round((Date.now() - oldest) / 60_000) : null,
    claimed_leases: claimed.map((t) => ({ id: t.id, by: t.claim?.by, leaseUntil: t.claim?.leaseUntil })),
    recent_done: done.slice(0, 5).map((t) => ({ id: t.id, by: t.result?.by, at: t.result?.at })),
    recent_failed: failed.slice(0, 5).map((t) => ({ id: t.id, by: t.result?.by, summary: t.result?.summary })),
  };
}

export function readEvents({ home = boardHome(), tail = 20 } = {}) {
  const p = ensureBoard(home);
  if (!fs.existsSync(p.events)) return [];
  const lines = fs.readFileSync(p.events, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-tail).map((l) => JSON.parse(l));
}
