# Design notes

## The problem this solves

Two agents, or twenty, that do not share a runtime. They are different products with different auth, different models, different sandboxes, sometimes different machines. There is no SDK to import and no process to call. The only thing they can agree on is a directory.

The board is that directory, plus a few invariants that make a directory behave like a queue.

## State machine

```
            post
             │
             ▼
          ┌──────┐   claim (rename)   ┌─────────┐   complete   ┌──────┐
          │queued├────────────────────▶│ claimed │─────────────▶│ done │
          └──┬───┘                     └────┬────┘              └──────┘
             │                              │ fail(retry)          
             │◀─────────────────────────────┘                      
             │                              │ fail / lease exhausted
             │                              ▼
             │                           ┌──────┐
             └──── cancel ───────────▶  │failed│
                                          └──────┘
                          cancel from queued/claimed → cancelled
```

A state change is always a file rename between `tasks/<state>/`. Readers never see a half-written task: updates are written to a temp file and renamed over the original.

## Exactly one claimant

Claims are a `rename()` of `tasks/queued/<id>.json` to `tasks/claimed/<id>.json`.

- On POSIX and on NTFS, a rename within the same directory tree is atomic: either the source existed and the rename happened, or it did not.
- The first process to rename wins. Everyone else gets `ENOENT` (the file is gone) or, on Windows, occasionally `EPERM`/`EBUSY` while another process holds the handle — both are handled by trying the next candidate.
- After winning, the claimant rewrites the file with its identity and lease. A loser can never observe the file in a half-claimed state, because it never sees the file at all.

The test suite spawns 12 processes for one task and asserts exactly one winner; a second test claims 6 tasks with 6 processes and asserts a bijection.

## Leases, not promises

A claim carries `claim.leaseUntil`. Nothing else stops a worker from dying.

- `renew` extends the lease (heartbeat).
- `reapExpired` returns expired leases to `queued`, keeping the attempt count.
- Attempts are incremented at claim time, so a task whose owner keeps dying reaches `failed` after `budget.maxAttempts` instead of looping forever.
- The reap step re-reads the task inside a per-task lock directory, so a lease renewed between the scan and the reap is not stolen.

`locks/<id>.lock` is a directory created with `mkdir()` (atomic on every filesystem that matters), removed in a `finally`, and treated as stale after 30 seconds so a killed process cannot brick a task.

## Dependencies

`blockedBy` is a list of task ids that must be `done`. A claim is refused with `blocked_by_dependencies` otherwise.

Cycles cannot form through the API: a task can only depend on already existing tasks, and there is no way to edit `blockedBy` after posting. If you need a different graph, post a new task.

## Capability routing

Tasks may require capabilities (`--cap deploy,network`); agents publish capability cards (`agents register`). A claim requires the task's capabilities to be a subset of the agent's. This is deliberate: availability-only self-claim is how agent teams end up with a read-only worker holding a task that needs write access.

Note what this is **not**: it is a static capability declaration, not a claim of competence. An agent that lies about its capabilities will still take the task and fail; the lease is what recovers from that.

## Hop budget

`reply_to` plus `hops`/`maxHops` bounds delegation ping-pong: agent A hands a task to B, B's reply to A counts as another hop, and when the budget is exhausted the post is refused with a message telling the caller to escalate to a human.

## Artifacts and evidence

`complete` takes `--summary`, `--evidence` and repeated `--artifact` paths.

- Artifacts are stored as `{path, bytes, sha256}` — never inlined. Large outputs belong on disk; the board is a routing layer, not a payload channel.
- `evidence` is free text: the command, the test output, the diff summary. Something a reviewer can check without re-running the work.

## Diagnostics: why a claim failed

A refused claim returns one reason, chosen by priority:

`blocked_by_dependencies` > `capability_mismatch` > `addressed_to_other` > `attempts_exhausted` > `lost_race` > `no_tasks`

Order-independent: scanning ten tasks always produces the most actionable reason, not the reason of whichever file `readdir` happened to return first.

## Assumptions and failure modes

- **One host, or a filesystem that offers atomic rename.** Local disk, NTFS, ext4, and most NFS/SMB mounts qualify; exotic object-store mounts do not.
- **Clocks agree.** Leases compare ISO timestamps written by the claimant. Machines with skewed clocks will reap early or late. Keep skew small (NTP) or use generous leases.
- **No garbage collection of old tasks.** `done/` grows forever; archive it with your own cron. The event log is append-only for the same reason.
- **Idempotency is per board.** `client_token` deduplicates within one board home, not across boards.
- **Capabilities are advisory.** See above.
- **The board does not decide who should do what.** Routing is the planner's job; the board only enforces the constraints the planner wrote down.

## How this compares

| | mcp-task-board | A2A tasks | Claude Code agent teams | LangGraph / CrewAI |
|---|---|---|---|---|
| Runs across different products | yes | yes | no (one product) | no (one SDK) |
| Needs a shared runtime | no | no (needs HTTP) | yes | yes |
| Durable, resumable queue | yes | yes (task store) | yes (local) | depends |
| Dependency graph | yes | per-task only | yes (blockedBy) | yes (graph) |
| Leases / dead owner recovery | yes | no | partially (manual) | no |
| Capability filtering | yes | skills (advisory) | **no** (known issue) | no |
| Works offline / air-gapped | yes | no | yes | yes |
| What it costs | a directory | a server + auth | one CLI | a framework |

The board is a **coordination substrate**, not a competing orchestration framework. A2A is the right choice when peers are remote and untrusted; a board is the right choice when the peers can see the same directory.
