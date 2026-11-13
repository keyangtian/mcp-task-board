# v0.2.0 — remote agents can delegate now

0.1.0 was a board for agents that share a directory. 0.2.0 adds the wire for the ones that don't.

## A2A endpoint

```bash
node bin/taskboard.mjs a2a --agent dsh --port 7801 --token "$A2A_TOKEN"
```

- `GET /.well-known/agent-card.json` — v1.0 card, streaming, one `task-board` skill, JSON-RPC interfaces at `1.0` and `0.3`.
- `message/send` (blocking by default, `configuration.blocking: false` for async), `message/stream` (SSE, ends with `final: true`), `tasks/get`, `tasks/cancel`, `tasks/resubscribe`.
- REST: `POST /message:send`, `POST /message:stream`, `GET /tasks/<id>`, `POST /tasks/<id>/cancel`.
- One A2A task maps to one board task. Summary + evidence + artifact references come back as a single artifact.

The local worker does not change: it still runs `claim` / `complete`. The adapter never touches the model and never does work; it only accepts work and projects board state onto A2A's task model.

## Compatibility note

A2A v1.0 renamed JSON-RPC methods to PascalCase. Most shipped clients — the one inside WorkBuddy among them — still send the 0.3 lowercase names (`message/send`). The adapter accepts both, and advertises both versions in `supportedInterfaces`, so old and new clients find a door.

## Not implemented, on purpose

- **Push notifications / webhooks**: the card says `pushNotifications: false`; the operation is refused rather than half-done. Webhook delivery is a security surface (SSRF, per-task tokens, idempotency) that deserves its own review.
- **`INPUT_REQUIRED` pauses**: a task that needs a human currently fails with evidence; pausing needs adapter-owned state the board does not persist.

## Try it

```bash
node examples/a2a-client.mjs   # server + remote post + local worker + artifact, in one process
npm test                       # 21 tests
```

## Next

- Webhook push notifications.
- One A2A server in front of several boards (multi-tenant context).
- Signed task envelopes for untrusted peers.

MIT, Node ≥ 18, zero dependencies.
