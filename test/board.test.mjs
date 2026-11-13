import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureBoard,
  postTask,
  claimTask,
  completeTask,
  renewLease,
  failTask,
  reapExpired,
  listTasks,
  showTask,
  boardStats,
  registerAgent,
  listAgents,
} from '../src/board.mjs';

const CLI = fileURLToPath(new URL('../bin/taskboard.mjs', import.meta.url));

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-board-'));
}

function cli(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TASKBOARD_HOME: home, ...extraEnv },
  });
}

test('a task can be posted, claimed, completed', () => {
  const home = freshHome();
  const posted = postTask({ title: 'write the release notes', from: 'planner', home });
  assert.equal(posted.state, 'queued');

  const claim = claimTask({ agent: 'writer', capabilities: [], home });
  assert.equal(claim.ok, true);
  assert.equal(claim.task.id, posted.id);
  assert.equal(claim.task.attempts, 1);
  assert.ok(claim.task.claim.leaseUntil);

  const done = completeTask({ id: posted.id, agent: 'writer', summary: 'wrote them', evidence: 'file: NOTES.md', home });
  assert.equal(done.state, 'done');
  assert.equal(done.result.by, 'writer');
  assert.equal(showTask(posted.id, { home }).state, 'done');
});

test('exactly one claimant wins a race (CLI, separate processes)', () => {
  const home = freshHome();
  postTask({ title: 'the only task', home });
  const workers = 12;
  const results = [];
  for (let i = 0; i < workers; i++) {
    const r = cli(home, ['claim', '--agent', `bot-${i}`, '--json']);
    results.push(r);
  }
  const winners = results.filter((r) => r.stdout.trim().startsWith('{') && JSON.parse(r.stdout).ok === true);
  assert.equal(winners.length, 1, `expected 1 winner, got ${winners.length}`);
  const losers = results.filter((r) => r.status === 2);
  assert.equal(losers.length, workers - 1);
  assert.equal(listTasks({ state: 'claimed', home }).length, 1);
});

test('many tasks are each claimed exactly once', () => {
  const home = freshHome();
  const ids = Array.from({ length: 6 }, (_, i) => postTask({ title: `task ${i}`, home }).id);
  for (let i = 0; i < 6; i++) cli(home, ['claim', '--agent', `w-${i}`, '--json']);
  const claimed = listTasks({ state: 'claimed', home });
  assert.equal(claimed.length, 6);
  assert.deepEqual(new Set(claimed.map((t) => t.id)), new Set(ids));
});

test('dependencies and capabilities gate claiming', () => {
  const home = freshHome();
  const first = postTask({ title: 'build', capabilities: ['build'], home });
  const second = postTask({ title: 'deploy', capabilities: ['deploy'], blockedBy: [first.id], home });

  // with 'deploy' but not 'build': deploy is blocked by deps, build is out of reach
  const blocked = claimTask({ agent: 'ops', capabilities: ['deploy'], home });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'blocked_by_dependencies');

  const didFirst = claimTask({ agent: 'builder', capabilities: ['build'], home });
  assert.equal(didFirst.ok, true);
  assert.equal(didFirst.task.id, first.id);
  completeTask({ id: first.id, agent: 'builder', summary: 'built', home });

  const nowOk = claimTask({ agent: 'ops', capabilities: ['deploy'], home });
  assert.equal(nowOk.ok, true);
  assert.equal(nowOk.task.id, second.id);
});

test('a capability mismatch is reported instead of silently taking other work', () => {
  const home = freshHome();
  postTask({ title: 'needs write', capabilities: ['write'], home });
  const noCap = claimTask({ agent: 'reader', capabilities: ['read'], home });
  assert.equal(noCap.ok, false);
  assert.equal(noCap.reason, 'capability_mismatch');
});

test('addressed tasks only go to the named agent', () => {
  const home = freshHome();
  const t = postTask({ title: 'only for buddy', to: 'workbuddy', home });
  const wrong = claimTask({ agent: 'dsh', home });
  assert.equal(wrong.ok, false);
  const right = claimTask({ agent: 'workbuddy', home });
  assert.equal(right.ok, true);
  assert.equal(right.task.id, t.id);
});

test('leases are renewed and expired leases come back to the board', () => {
  const home = freshHome();
  const t = postTask({ title: 'slow job', maxAttempts: 1, home });
  claimTask({ agent: 'slow', leaseMs: 60, home });
  reapExpired({ home, now: new Date(Date.now() + 5_000) });
  const hit = showTask(t.id, { home });
  assert.equal(hit.state, 'failed');
  assert.match(hit.task.result.summary, /lease expired/);

  const home2 = freshHome();
  const t2 = postTask({ title: 'slow job 2', maxAttempts: 2, home: home2 });
  const c = claimTask({ agent: 'slow', leaseMs: 60, home: home2 });
  const renewed = renewLease({ id: t2.id, agent: 'slow', leaseMs: 60_000, home: home2 });
  assert.ok(Date.parse(renewed.claim.leaseUntil) > Date.now());
  assert.equal(c.ok, true);

  const home3 = freshHome();
  const t3 = postTask({ title: 'slow job 3', maxAttempts: 2, home: home3 });
  claimTask({ agent: 'slow', leaseMs: 60, home: home3 });
  const r = reapExpired({ home: home3, now: new Date(Date.now() + 5_000) });
  assert.equal(r.reclaimed.length, 1);
  const back = showTask(t3.id, { home: home3 });
  assert.equal(back.state, 'queued');
  assert.equal(back.task.attempts, 1);
});

test('retryable failures go back to the board, others are terminal', () => {
  const home = freshHome();
  const t = postTask({ title: 'flaky', maxAttempts: 3, home });
  claimTask({ agent: 'a', home });
  failTask({ id: t.id, agent: 'a', reason: 'network', retryable: true, home });
  assert.equal(showTask(t.id, { home }).state, 'queued');
  claimTask({ agent: 'a', home });
  failTask({ id: t.id, agent: 'a', reason: 'wrong input', home });
  assert.equal(showTask(t.id, { home }).state, 'failed');
});

test('client tokens make posting idempotent', () => {
  const home = freshHome();
  const a = postTask({ title: 'once', clientToken: 'req-42', home });
  const b = postTask({ title: 'once', clientToken: 'req-42', home });
  assert.equal(a.id, b.id);
  assert.equal(b.deduplicated, true);
  assert.equal(boardStats({ home }).queued, 1);
});

test('hop counting stops ping-pong delegation', () => {
  const home = freshHome();
  assert.throws(() => postTask({ title: 'again', replyTo: 'x', hops: 4, maxHops: 4, home }), /hop limit/);
});

test('completed tasks carry artifact references with hashes', () => {
  const home = freshHome();
  const artifact = path.join(home, 'out.txt');
  fs.writeFileSync(artifact, 'hello board');
  const t = postTask({ title: 'produce a file', home });
  claimTask({ agent: 'writer', home });
  const done = completeTask({ id: t.id, agent: 'writer', summary: 'made it', artifacts: [artifact], home });
  assert.equal(done.result.artifacts.length, 1);
  assert.equal(done.result.artifacts[0].path, path.resolve(artifact));
  assert.equal(done.result.artifacts[0].sha256.length, 64);
  assert.equal(done.result.artifacts[0].bytes, 11);
});

test('agents register capability cards', () => {
  const home = freshHome();
  registerAgent({ agent: 'dsh', capabilities: ['code', 'tests'], description: 'harness', home });
  registerAgent({ agent: 'dsh', capabilities: ['review'], home });
  const card = listAgents({ home }).find((a) => a.name === 'dsh');
  assert.deepEqual(card.capabilities, ['code', 'review', 'tests']);
  assert.equal(boardStats({ home }).agents, 1);
});

test('MCP server speaks initialize / tools/list / tools/call', () => {
  const home = freshHome();
  ensureBoard(home);
  const r = spawnSync(process.execPath, [CLI, 'mcp'], {
    encoding: 'utf8',
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'board_post', arguments: { title: 'from mcp', from: 'tester' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'board_stats', arguments: {} } }),
      '',
    ].join('\n'),
    env: { ...process.env, TASKBOARD_HOME: home },
  });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.id === 1).result.serverInfo.name, 'mcp-task-board');
  const tools = lines.find((l) => l.id === 2).result.tools;
  assert.ok(tools.length >= 10);
  assert.ok(tools.some((t) => t.name === 'board_claim'));
  const posted = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
  assert.equal(posted.ok, true);
  const stats = JSON.parse(lines.find((l) => l.id === 4).result.content[0].text);
  assert.equal(stats.stats.queued, 1);
});
