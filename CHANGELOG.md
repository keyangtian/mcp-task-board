# Changelog

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
