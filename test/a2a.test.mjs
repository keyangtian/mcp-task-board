import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createA2AServer } from '../src/a2a.mjs';
import { claimTask, completeTask, failTask, showTask } from '../src/board.mjs';

const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-board-a2a-'));

async function withServer(opts, fn) {
  const a2a = createA2AServer({ host: '127.0.0.1', port: 0, pollMs: 50, blockTimeoutMs: 5000, ...opts });
  const { url } = await a2a.listen();
  try {
    return await fn(a2a, url);
  } finally {
    a2a.server.closeAllConnections?.();
    await a2a.close();
  }
}

async function rpc(url, method, params, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}

test('agent card advertises v1.0 and streaming', async () => {
  const home = freshHome();
  await withServer({ home, agent: 'worker' }, async (_s, url) => {
    const res = await fetch(`${url}/.well-known/agent-card.json`);
    assert.equal(res.status, 200);
    const card = await res.json();
    assert.equal(card.protocolVersion, '1.0');
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.supportedInterfaces.length, 2);
    assert.ok(card.skills.some((s) => s.id === 'task-board'));
    assert.equal(card.url, url);
  });
});

test('message/send creates a board task and tasks/get reflects completion', async () => {
  const home = freshHome();
  await withServer({ home, agent: 'worker' }, async (_s, url) => {
    const sent = await rpc(url, 'message/send', {
      message: { messageId: 'msg-1', role: 'user', parts: [{ kind: 'text', text: 'Port the exporter\n\nacceptance: tests green' }] },
      configuration: { blocking: false },
    });
    assert.equal(sent.body.result.status.state, 'TASK_STATE_SUBMITTED');
    const id = sent.body.result.id;
    assert.equal(sent.body.result.contextId.length > 10, true);
    assert.equal(showTask(id, { home }).state, 'queued');

    const claimed = claimTask({ agent: 'worker', home });
    assert.equal(claimed.ok, true);
    completeTask({ id, agent: 'worker', summary: 'ported it', evidence: '14 passed', home });

    const got = await rpc(url, 'tasks/get', { id });
    assert.equal(got.body.result.status.state, 'TASK_STATE_COMPLETED');
    assert.match(got.body.result.artifacts[0].parts[0].text, /ported it/);
    assert.equal(got.body.result.metadata.claimedBy, 'worker');
  });
});

test('blocking message/send waits for the worker and returns the final task', async () => {
  const home = freshHome();
  await withServer({ home, agent: 'worker' }, async (_s, url) => {
    const pending = rpc(url, 'message/send', { message: { parts: [{ kind: 'text', text: 'blocking task' }] } });
    const claimed = await waitFor(() => {
      const c = claimTask({ agent: 'worker', home });
      return c.ok ? c : null;
    });
    completeTask({ id: claimed.task.id, agent: 'worker', summary: 'done blocking', home });
    const sent = await pending;
    assert.equal(sent.body.result.status.state, 'TASK_STATE_COMPLETED');
  });
});

test('message/stream emits status updates and a final event', async () => {
  const home = freshHome();
  await withServer({ home, agent: 'worker' }, async (_s, url) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'message/stream', params: { message: { parts: [{ kind: 'text', text: 'streamed task' }] } } }),
    });
    assert.equal(res.headers.get('content-type').startsWith('text/event-stream'), true);

    const events = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readNext = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
        const idx = buf.indexOf('\n\n');
        if (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) return JSON.parse(line.slice(6));
        }
      }
    };

    const first = await readNext();
    assert.equal(first.kind, 'task');
    const id = first.id;

    const claimed = await waitFor(() => {
      const c = claimTask({ agent: 'worker', home });
      return c.ok ? c : null;
    });
    assert.equal(claimed.task.id, id);
    completeTask({ id, agent: 'worker', summary: 'streamed done', home });

    let last = null;
    for (let i = 0; i < 60; i++) {
      const ev = await readNext();
      if (!ev) break;
      events.push(ev);
      if (ev.final) {
        last = ev;
        break;
      }
    }
    assert.ok(last, 'expected a final status update');
    assert.equal(last.status.state, 'TASK_STATE_COMPLETED');
    assert.deepEqual(
      new Set(events.map((e) => e.kind)),
      new Set(['status-update']),
    );
  });
});

test('cancel works while running and is refused on a finished task', async () => {
  const home = freshHome();
  await withServer({ home, agent: 'worker' }, async (_s, url) => {
    const sent = await rpc(url, 'message/send', {
      message: { parts: [{ kind: 'text', text: 'cancel me' }] },
      configuration: { blocking: false },
    });
    const id = sent.body.result.id;
    const cancelled = await rpc(url, 'tasks/cancel', { id });
    assert.equal(cancelled.body.result.status.state, 'TASK_STATE_CANCELED');

    const again = await rpc(url, 'tasks/cancel', { id });
    assert.equal(again.body.error.code, -32002);
  });
});

test('failed worker surfaces as TASK_STATE_FAILED', async () => {
  const home = freshHome();
  await withServer({ home, agent: 'worker' }, async (_s, url) => {
    const sent = await rpc(url, 'message/send', {
      message: { parts: [{ kind: 'text', text: 'will fail' }] },
      configuration: { blocking: false },
    });
    const id = sent.body.result.id;
    const claimed = await waitFor(() => {
      const c = claimTask({ agent: 'worker', home });
      return c.ok ? c : null;
    });
    failTask({ id: claimed.task.id, agent: 'worker', reason: 'no network', home });
    const got = await rpc(url, 'tasks/get', { id });
    assert.equal(got.body.result.status.state, 'TASK_STATE_FAILED');
    assert.match(got.body.result.status.message.parts[0].text, /no network/);
  });
});

test('REST variant and bearer auth', async () => {
  const home = freshHome();
  await withServer({ home, agent: 'worker', token: 's3cret' }, async (_s, url) => {
    const denied = await fetch(`${url}/message:send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { parts: [{ kind: 'text', text: 'nope' }] } }),
    });
    assert.equal(denied.status, 401);

    const res = await fetch(`${url}/message:send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer s3cret' },
      body: JSON.stringify({ message: { parts: [{ kind: 'text', text: 'rest task' }] } }),
    });
    assert.equal(res.status, 200);
    const task = await res.json();
    assert.equal(task.status.state, 'TASK_STATE_SUBMITTED');

    const fetched = await fetch(`${url}/tasks/${task.id}`, { headers: { authorization: 'Bearer s3cret' } });
    assert.equal((await fetched.json()).id, task.id);
  });
});

test('unknown method returns a JSON-RPC error', async () => {
  const home = freshHome();
  await withServer({ home, agent: 'worker' }, async (_s, url) => {
    const res = await rpc(url, 'no/such/method', {});
    assert.equal(res.body.error.code, -32601);
  });
});
