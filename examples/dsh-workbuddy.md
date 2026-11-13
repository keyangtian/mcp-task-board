# Two desktop agents, one board (DeepSeek Harness ⇄ WorkBuddy)

Both apps are Electron shells around a full agent CLI. Neither exposes an
OpenAI-compatible model endpoint and neither shares its login with an external
process, so "just call the other one's API" is not available. A shared board is.

```
C:\agents\board\                     <- TASKBOARD_HOME for both agents
  tasks/ queued/ claimed/ done/ ...
  agents/dsh.json  agents/workbuddy.json
  events.jsonl
```

## 1. Create the board

```cmd
node C:\mcp-task-board\bin\taskboard.mjs init --home C:\agents\board --agent dsh --cap code,tests,review
node C:\mcp-task-board\bin\taskboard.mjs agents register --home C:\agents\board --name workbuddy --cap office,slides,research
```

Put `C:\mcp-task-board\bin` on `PATH` (or make a tiny `mcp-task-board.cmd`) so both
agents can call the CLI by name.

## 2. Register the board as an MCP server

**DeepSeek Harness** — either a shell tool call per task, or wrap it as a
configuration-only MCP bundle (see the `mcp` template in DSH's plugin docs) with:

```json
{
  "command": "node",
  "args": ["C:\\mcp-task-board\\bin\\taskboard.mjs", "mcp"],
  "env": { "TASKBOARD_HOME": "C:\\agents\\board", "TASKBOARD_AGENT": "dsh" }
}
```

**WorkBuddy** — its desktop sessions are launched with `--strict-mcp-config`
plus a generated `--mcp-config`, so editing `~/.workbuddy/mcp.json` does **not**
reach desktop sessions. Register the server through the app's connector / MCP
UI instead, with the same command, args and env as above (use
`C:\Users\<you>\.workbuddy\binaries\node\current\node.exe` if the app's PATH has
no `node`).

## 3. Let each side pull work

Give each agent one rule, wherever it reads project instructions
(`AGENTS.md` for DSH, the project rules / `.workbuddy` instructions for WorkBuddy):

```text
Before starting anything, run:
  mcp-task-board claim --agent <me> --cap <my caps> --json
Exit code 2 means there is nothing to do. When you finish:
  mcp-task-board complete <id> --agent <me> --summary "..." --evidence "..." --artifact <path>
While working longer than the lease: mcp-task-board renew <id> --agent <me>
```

Run `mcp-task-board reap` from a timer on one of the two machines. That is the only
scheduled piece; no agent has to be awake for the other one to finish.

## 4. Split the work the way the money works

The board does not decide who should do what — you do, by posting with the right
capabilities and budgets. A layout that survives contact with two billing pools:

- **Planning, review, verification** → the agent whose tokens are cheaper.
- **Bulk generation, slide decks, long documents** → the agent whose credits
  expire.
- Post a **verification task** with `--blocked-by <the work task>` and a different
  agent's capability, so the producer never verifies its own output.

## 5. What this buys you

- Work keeps moving when one app is closed or logged out.
- No transcript relay: results travel as `summary` + `evidence` + artifact hashes.
- Broken workers are recovered by leases, not by a human noticing.

## Known limits

- Both apps' CLIs still need a one-time sign-in for direct headless invocation;
  the board does not need it at all, because only the interactive agents claim
  work.
- If the two agents run on different machines, the board home must be a mount
  with atomic rename semantics (SMB/NFS are usually fine; object stores are not).
