# Changelog

## 0.2.0 (2026-11-13)

Remote delegation without a shared disk.

- **A2A endpoint** (`taskboard a2a`): agent card at `/.well-known/agent-card.json`, JSON-RPC `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`, plus REST variants `POST /message:send`, `POST /message:stream`, `GET /tasks/<id>`, `POST /tasks/<id>/cancel`.
- Both spellings accepted: v1.0 PascalCase (`SendMessage`) and the 0.3 lowercase names most shipped clients still send; `supportedInterfaces` advertises both versions.
- One A2A task is one board task: `queued → TASK_STATE_SUBMITTED`, `claimed → TASK_STATE_WORKING`, `done → TASK_STATE_COMPLETED`, `failed → TASK_STATE_FAILED`, `cancelled → TASK_STATE_CANCELED`. Summary, evidence and artifact refs come back as one artifact.
- Blocking `message/send` (25 s default, `configuration.blocking: false` for async) and SSE streaming with a `final: true` event.
- Optional bearer-token auth (`--token`); push notifications intentionally not implemented and advertised as `false`.
- Board tasks can carry `meta` (context id, message id, channel), which the adapter uses to keep A2A context grouped.
- 21 tests (8 new for the adapter): card, async send/get, blocking send, SSE stream, cancel and double-cancel, failure surfacing, REST + bearer auth, unknown method.

## 0.1.0 (2026-11-13)

First cut. A board, not a broker.

- Filesystem task board with `queued` / `claimed` / `done` / `failed` / `cancelled` states.
- Atomic claims: the winner is decided by `rename()`, so claiming is safe across processes, runtimes and machines sharing the directory.
- Leases with heartbeat (`renew`) and reaper (`reap`): a worker that dies loses the task, and a task that keeps dying reaches `failed` after `maxAttempts`.
- Dependency gating via `blockedBy`; blocked work cannot be claimed.
- Capability routing at claim time (`--cap` / capability cards), with ranked refusal reasons (`blocked_by_dependencies` > `capability_mismatch` > `addressed_to_other` > `attempts_exhausted` > `lost_race` > `no_tasks`).
- Hop budget (`reply_to` + `maxHops`) so agents cannot ping-pong a task forever.
- Idempotent posting via `client_token`.
- Artifact references with size and sha256; payloads never travel through the board.
- Append-only `events.jsonl` audit trail.
- CLI (`taskboard`) and MCP stdio server (`board_*` tools) over the same core.
- 13 tests, including a 12-process claim race and an MCP handshake.
