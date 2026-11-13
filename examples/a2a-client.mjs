#!/usr/bin/env node
/**
 * Round trip over A2A: a "remote" client posts a task to the endpoint, a local
 * worker claims and completes it, the client receives the artifact.
 *
 * Run: node examples/a2a-client.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createA2AServer } from '../src/a2a.mjs';
import { claimTask, completeTask } from '../src/board.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-board-a2a-demo-'));
const server = createA2AServer({ home, agent: 'worker', host: '127.0.0.1', port: 0, pollMs: 50, blockTimeoutMs: 10_000 });
const { url } = await server.listen();
console.log(`a2a endpoint: ${url}`);

const card = await (await fetch(`${url}/.well-known/agent-card.json`)).json();
console.log(`card: ${card.name} v${card.version}, streaming=${card.capabilities.streaming}, interfaces=${card.supportedInterfaces.map((i) => i.protocolVersion).join('/')}`);

const pending = fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        messageId: 'demo-msg-1',
        role: 'user',
        parts: [{ kind: 'text', text: 'Write the launch note\n\nAcceptance: mentions the release date and links the changelog.' }],
      },
    },
  }),
}).then((r) => r.json());

// The local worker: claim, do the thing, complete with evidence.
let claimed = null;
for (let i = 0; i < 100 && !claimed; i++) {
  const c = claimTask({ agent: 'worker', home });
  if (c.ok) claimed = c.task;
  else await new Promise((r) => setTimeout(r, 25));
}
console.log(`worker claimed: ${claimed.id} (${claimed.title})`);
const done = completeTask({
  id: claimed.id,
  agent: 'worker',
  summary: 'wrote the launch note',
  evidence: 'docs/launch.md, 4 paragraphs, mentions 2026-11-13 and links CHANGELOG.md',
  home,
});
console.log(`worker completed: ${done.state}`);

const response = await pending;
const task = response.result;
console.log(`remote client saw: ${task.status.state}`);
console.log(`artifact:\n${task.artifacts?.[0]?.parts?.[0]?.text ?? '(none)'}`);

server.server.closeAllConnections?.();
await server.close();
