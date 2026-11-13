# v0.1.0 — first cut

A task board for agents that do not share a runtime.

Your agents are different products: different auth, different models, different sandboxes. They cannot import each other, and a message bridge becomes an inbox nobody polls. This makes the shared directory the only thing they can agree on — so the board is a directory with the invariants of a queue.

## What is in it

- **Atomic claims.** `rename()` decides the winner. Tested with 12 processes racing for one task; also 6 tasks across 6 processes, each claimed exactly once.
- **Leases + reaper.** `renew` heartbeats; `reap` returns expired leases; attempts are counted at claim time, so a task that keeps killing its owner ends in `failed`.
- **Dependencies.** `blockedBy` gates claiming; cycles cannot be posted into existence.
- **Capability routing.** A task that needs `deploy` cannot be taken by an agent with only `read` — the failure mode where a read-only teammate grabs an implementation task.
- **Ranked refusal reasons.** A worker loop can tell "blocked" from "not my job" without parsing prose.
- **Artifacts as references.** Path + bytes + sha256; the board never carries payloads.
- **MCP + CLI.** Same core, two faces: 11 MCP tools, or a shell command with exit code 2 meaning "nothing to claim".

## Try it

```bash
node bin/taskboard.mjs init --agent planner
node bin/taskboard.mjs post --title "port the exporter" --cap code
node bin/taskboard.mjs claim --agent worker-a --cap code --json
node examples/demo.mjs   # race + dependency graph, no setup
npm test                 # 13 tests
```

## Known limits

- One host, or a filesystem with atomic rename (local disk, NTFS, ext4, most SMB/NFS). Object stores are not supported.
- Clock skew affects lease expiry; keep machines on NTP or use generous leases.
- Old `done/` tasks are not garbage collected; archive with your own cron.
- Capabilities are declarations, not proof of competence; the lease is the safety net.

## Next

- A2A adapter: agent card + `SendMessage` / `GetTask` / `SubscribeToTask` on top of the board, so remote agents can delegate without a shared filesystem.
- Optional HTTP transport, signed task envelopes.

MIT, Node ≥ 18, zero dependencies.
