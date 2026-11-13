# A2A adapter

The board is a directory; A2A is the wire. This adapter lets an agent that only
speaks HTTP delegate work to the machine that owns the board — the remote client
never sees the filesystem, the claim rules, or the leases.

One A2A task **is** one board task. That is the whole design: state lives on the
board, and the adapter only projects it onto A2A's task model.

## Run it

```bash
node bin/taskboard.mjs a2a --agent dsh --port 7801
# {"ok":true,"url":"http://127.0.0.1:7801","card":"http://127.0.0.1:7801/.well-known/agent-card.json"}
```

Flags:

| Flag | Meaning |
|---|---|
| `--agent` | the local agent name tasks are addressed to (`to` field) |
| `--port` | 7801 by default; `0` picks a free port |
| `--host` | `127.0.0.1` by default. Use `0.0.0.0` only behind a token and a firewall |
| `--public-url` | the URL written into the agent card when you are behind a proxy |
| `--token` | require `Authorization: Bearer <token>`; without it the endpoint is unauthenticated |

The local worker is unchanged: it keeps calling `claim` / `complete` as usual.
The A2A server does not do work; it only accepts work and reports status.

## What is implemented

| Operation | JSON-RPC | REST |
|---|---|---|
| send | `message/send`, `SendMessage` | `POST /message:send` |
| stream | `message/stream`, `SendStreamingMessage` | `POST /message:stream` |
| get | `tasks/get`, `GetTask` | `GET /tasks/<id>` |
| cancel | `tasks/cancel`, `CancelTask` | `POST /tasks/<id>/cancel` |
| resubscribe | `tasks/resubscribe`, `ResubscribeTask` | — |
| card | — | `GET /.well-known/agent-card.json` |
| health | — | `GET /health` |

Both spellings matter: A2A v1.0 renamed JSON-RPC methods to PascalCase, while
shipped clients (including the one inside WorkBuddy) still send `message/send`.
The adapter accepts both and advertises `1.0` and `0.3` in `supportedInterfaces`.

## Semantics

- `message/send` **blocks** until the task reaches a terminal state, or until the
  client sets `configuration.blocking: false` (or `returnImmediately: true`).
  The block timeout defaults to 25 s; past it the current state is returned.
- `message/stream` sends the initial `task` object, then `status-update` events
  (every `pollMs`, 250 ms by default), and closes on a terminal state with
  `final: true`.
- State mapping: `queued → TASK_STATE_SUBMITTED`, `claimed → TASK_STATE_WORKING`,
  `done → TASK_STATE_COMPLETED`, `failed → TASK_STATE_FAILED`,
  `cancelled → TASK_STATE_CANCELED`.
- A completed task's `summary`, `evidence` and artifact refs are returned as one
  artifact named `result`.
- `tasks/cancel` refuses terminal tasks with `TaskNotCancelableError` (-32002).
- `tasks/resubscribe` re-attaches to a running task; finished tasks cannot be
  resubscribed (`UnsupportedOperationError`).

## Errors

| Code | Name | When |
|---|---|---|
| -32001 | TaskNotFoundError | unknown task id |
| -32002 | TaskNotCancelableError | cancel after terminal |
| -32004 | UnsupportedOperationError | message to a finished task; resubscribe to a finished task |
| -32601 | MethodNotFound | unknown JSON-RPC method |
| -32602 | InvalidParams | message without text parts |
| -32603 | InternalError | anything else |

## What is not implemented (and why)

- **Push notifications / webhooks.** The card advertises
  `pushNotifications: false`, and the operation is not accepted. A webhook is a
  security decision (SSRF rules, per-task tokens, at-least-once delivery) that
  deserves its own review, not a half-version.
- **`INPUT_REQUIRED` / `AUTH_REQUIRED` interruption.** A board task that needs a
  human currently fails with evidence instead of pausing; pausing requires the
  adapter to own task state that the board does not persist.
- **Message history beyond the initial message.** The board stores a task, not a
  conversation. Follow-up messages on a finished task are refused, which is what
  the spec asks for anyway.
- **Extended agent card / per-skill auth.** Add when there is more than one
  tenant behind the endpoint.

## Client example

See [examples/a2a-client.mjs](../examples/a2a-client.mjs): it starts a server,
posts a task, prints the stream, claims and completes the task as a local worker,
and prints the returned artifact.
