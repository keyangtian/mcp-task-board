#!/usr/bin/env node
/**
 * Demo: one task, eight agents racing; then a small dependency graph that two
 * agents drain. Run with `node examples/demo.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { postTask, claimTask, completeTask, listTasks, boardStats, registerAgent, ensureBoard } from '../src/board.mjs';

const CLI = fileURLToPath(new URL('../bin/taskboard.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-board-demo-'));

console.log(`board: ${home}\n`);

// 1. race ------------------------------------------------------------------
const only = postTask({ title: 'seven agents, one task', from: 'planner', home });
const workers = 8;
const runs = [];
for (let i = 0; i < workers; i++) {
  runs.push(
    spawnSync(process.execPath, [CLI, 'claim', '--agent', `bot-${i}`, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, TASKBOARD_HOME: home },
    }),
  );
}
const winners = runs.filter((r) => r.stdout.trim().startsWith('{') && JSON.parse(r.stdout).ok === true);
console.log(`race: ${workers} processes, ${winners.length} winner(s), ${runs.filter((r) => r.status === 2).length} "nothing to claim"`);
console.log(`  ${only.id} went to ${JSON.parse(winners[0].stdout).task.claim.by}\n`);

// 2. dependency graph ------------------------------------------------------
registerAgent({ agent: 'analyst', capabilities: ['research'], home });
registerAgent({ agent: 'writer', capabilities: ['writing', 'review'], home });

const research = postTask({ title: 'gather the numbers', capabilities: ['research'], from: 'planner', home });
const draft = postTask({ title: 'write the first draft', capabilities: ['writing'], blockedBy: [research.id], from: 'planner', home });
const check = postTask({ title: 'review the draft', capabilities: ['review'], blockedBy: [draft.id], from: 'planner', home });

const script = {
  analyst: ['research'],
  writer: ['writing', 'review'],
};

for (let round = 0; round < 6; round++) {
  let progressed = false;
  for (const [agent, capabilities] of Object.entries(script)) {
    let r = claimTask({ agent, capabilities, home });
    while (r.ok) {
      const t = r.task;
      const outcome = completeTask({
        id: t.id,
        agent,
        summary: `${agent} did: ${t.title}`,
        evidence: 'demo (no real work performed)',
        home,
      });
      console.log(`  ${agent} -> ${outcome.id} [${outcome.state}] ${t.title}`);
      progressed = true;
      r = claimTask({ agent, capabilities, home });
    }
  }
  if (!progressed) break;
}

// 3. board state -----------------------------------------------------------
const stats = boardStats({ home });
const done = listTasks({ state: 'done', home });
console.log(`\nboard: queued=${stats.queued} claimed=${stats.claimed} done=${stats.done} failed=${stats.failed}`);
for (const t of done) console.log(`  done ${t.id} by ${t.result.by}: ${t.title}`);

const leftover = listTasks({ state: 'queued', home });
if (leftover.length) {
  console.log(`\nstill queued (nobody has the capability): ${leftover.map((t) => t.title).join(', ')}`);
}
console.log(`\nevents log: ${stats.home === home ? path.join(home, 'events.jsonl') : '?'}`);
ensureBoard(home);
