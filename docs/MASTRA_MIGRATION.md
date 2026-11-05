# Mastra self-hosted migration

This repository is a private self-hosted fork of
[CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots). The original
project is untouched. The migration replaces CopilotKit Intelligence with
[Mastra](https://mastra.ai), keeps the existing React UI, and stores everything
locally.

## Goals and outcome

| Goal                                                 | Status                                       |
| ---------------------------------------------------- | -------------------------------------------- |
| Start without CopilotKit Intelligence credentials    | Done                                         |
| Run agents on Mastra (Apache-2.0)                    | Done                                         |
| DeepSeek, Ollama, and any OpenAI-compatible provider | Done                                         |
| Per-Dot model override                               | Done                                         |
| Conversations persist locally and survive restarts   | Done                                         |
| Local agent memory                                   | Done (Mastra Memory in the same SQLite file) |
| Spaces, pages, Dots unchanged                        | Done                                         |
| Streaming responses                                  | Done (AG-UI over SSE)                        |
| Tools, MCP connections, approvals, computers         | Done, adapted to Mastra                      |
| Background and scheduled work                        | Done, local and durable                      |
| LAN access                                           | Done (`HOST` + `OWNER_TOKEN`)                |
| No telemetry, no licensing/activation calls          | Done                                         |
| Slack Channels                                       | Not migrated (documented limitation)         |
| CopilotKit Learning / automatic skill learning       | Replaced with local skill folders            |

## Compatibility matrix

| Component                | Before                                        | After                                                   | Impact                     |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| UI                       | React 19 + CopilotKit React SDK (v2)          | Unchanged                                               | Minimal                    |
| Agent runtime            | CopilotKit `BuiltInAgent` + TanStack AI       | Mastra `Agent` + `@ag-ui/mastra` bridge                 | Significant                |
| AG-UI transport          | CopilotKit runtime, Intelligence mode         | CopilotKit runtime, local SSE mode with a custom runner | Significant                |
| Conversation persistence | CopilotKit Intelligence threads               | `agent_threads` / `agent_runs` SQLite tables            | Significant                |
| Agent memory             | Intelligence-managed                          | `@mastra/memory` + `@mastra/libsql` (`mastra_*` tables) | Significant                |
| Workspace data           | SQLite                                        | Same SQLite file, same tables                           | Minimal                    |
| Tools                    | `defineTool` (CopilotKit runtime)             | Framework-neutral `defineTool` → Mastra `createTool`    | Moderate                   |
| Human-in-the-loop        | CopilotKit client tools (`useHumanInTheLoop`) | Unchanged client tools, served through the AG-UI bridge | Low                        |
| MCP approvals            | DB-backed `mcp_approvals` / `mcp_actions`     | Unchanged                                               | None                       |
| Computers                | OpenBot service                               | Unchanged                                               | None                       |
| Background work          | SQLite lease-based `Runner`                   | Same runner, `Platform.turn` now runs Mastra            | Low                        |
| Voice compute            | Intelligence headless agent                   | Local `Platform.turn` through the durable runner        | Low                        |
| Slack                    | Managed Channels SDK (Intelligence)           | Removed                                                 | Feature loss, documented   |
| Learning                 | Intelligence Learning containers              | `SKILLS_DIR` local skills                               | Feature change, documented |
| Setup telemetry          | CopilotKit ingest                             | Removed; nothing leaves the process                     | Intended                   |

## Runtime architecture

```
React app ──AG-UI/SSE──► CopilotKit runtime (MIT, SSE mode, no Intelligence)
                              │
                              ▼
                     SqliteAgentRunner (agent_threads / agent_runs)
                              │  run() → agent.runAgent()
                              ▼
                     DotAgent (AbstractAgent)
                              │
                              ▼
        Mastra Agent ── tools, memory, model (OpenAI-compatible) ──► provider
```

- `src/server/agent-runner.ts` implements the runtime's
  `LocalThreadEndpointRunner` contract on SQLite. It powers `/threads`,
  `/threads/:id/messages`, `/threads/:id/events`, `/connect`, `/run`, and
  `/stop` without any hosted service.
- `src/server/dot-agent.ts` keeps the safety envelope (permission
  re-validation during a turn, time limit, credential-safe errors, tool
  allowlists) and delegates the model/tool loop to Mastra through the
  `@ag-ui/mastra` `MastraAgent` bridge.
- `src/server/platform.ts` wires the runtime in SSE mode with the local runner.
  No `CopilotKitIntelligence` instance is created and `CPK_INTELLIGENCE_API_KEY`
  / `INTELLIGENCE_API_KEY` are never read.

### Why the CopilotKit runtime is still a dependency

`@copilotkit/runtime` and `@copilotkit/react-core` are MIT-licensed and in SSE
mode they operate entirely in-process. They provide the AG-UI SSE framing,
thread REST endpoints, client-tool orchestration (human-in-the-loop), and the
React chat state that the OpenDots UI is built on. They do not require an
account, key, or network call in this configuration. Replacing them would have
meant rewriting the whole chat surface for no functional gain. The intelligence
client is never constructed.

## Database

Migrations are versioned in `schema_migrations` and run transactionally
(`src/server/db.ts`). The pre-existing schema is preserved; new columns are added
idempotently (the same pattern the upstream template used). See
[DATABASE.md](DATABASE.md).

- Canonical transcript: `agent_threads.messages` (AG-UI messages) and
  `agent_runs.events` (compacted AG-UI events per run).
- Model-facing memory: Mastra `mastra_*` tables in the same file.
- Existing owner-curated memories remain in `memories` and are injected into the
  system prompt.

Nothing has a retention cap or expiry. Delete a conversation or the database to
remove history. A run interrupted by process exit is not appended at all, so a
replay always shows the last completed snapshot; it never shows a half-written
turn.

## Background and scheduled work

The existing SQLite `Runner` is preserved: leases, ownership checks, pause,
cancel, retry, and the explicit **Interrupted** state. Each run executes
`Platform.turn`, which goes through the same durable runner as web chat, so the
turn is in the conversation transcript.

Guarantees:

- A run is recorded as completed/failed/interrupted/cancelled with a lease.
- On restart, a running task with an expired lease is marked **Interrupted** and
  requires review before retry.
- There is no automatic replay of non-idempotent tool calls after a crash.
- This is durable _state tracking_, not exactly-once execution. A crash between a
  side effect and the completion write can still leave an effect without a final
  result — which is why interrupted runs wait for a human.

## Known limitations

### Slack

The managed Channels integration is not migrated. `SLACK_*` variables,
`@copilotkit/channels`, and `slack-channel.ts` were removed. The upstream
feature depended on Intelligence-managed channel activation. Reintroducing Slack
locally would mean a Slack app with Socket Mode/Events, its own allowlist, and
routing messages into `Platform.turn`; that is a separate integration, not a
configuration flag.

### Automatic Learning

CopilotKit Learning (evidence collection and published-skill delivery) is a
hosted Intelligence feature and is not migrated. The replacement is deliberately
simpler and explicit:

- skills live in `SKILLS_DIR` as ordinary files (see [SKILLS.md](SKILLS.md));
- a Dot opt-in exposes them through `load_skill` / `read_skill_file`;
- nothing is learned automatically and no conversation evidence is uploaded.

The `learningContainerId` database column and API field are preserved for
backward compatibility, but the value is unused.

### Semantic memory

Mastra memory uses a rolling `lastMessages` window (40 messages) in the local
database. Semantic/vector recall is disabled because DeepSeek does not serve an
embedding endpoint; enabling it would either require a second provider or
silently degrade to keyword search. Owner-curated preferences (`memories`)
provide long-term context. A local embedder can be added later via
`@mastra/memory`'s `semanticRecall` option.

### Tool approvals

Approvals remain application-level: an approval-gated MCP tool returns
`approval_required`, the Dot calls the `request_connection_action` client tool,
and the owner decides in the chat. The approval record and its receipt are in
SQLite. Mastra's native tool-approval interrupts are not used, so there is no
dependency on Mastra workflow snapshots.

### Verification gaps

The following are implemented but cannot be verified in automated tests without
your services: live OpenBot browsing/file/shell, live speech calls, Live
DeepSeek/Ollama responses, and Slack (removed). The AG-UI transport, Mastra
streaming, tool execution, human-in-the-loop hand-off, persistence, replay,
cancellation, timeouts, and permissions are covered by automated tests with a
local fixture provider.

## Telemetry

- The upstream setup-event transport to `telemetry.copilotkit.ai` was removed.
  `SetupTelemetry` is now an in-process no-op.
- The AG-UI runtime's own telemetry is disabled before its module is evaluated
  (`src/server/telemetry-env.ts` sets `DO_NOT_TRACK=1` unless the operator has
  explicitly set `DO_NOT_TRACK` or `COPILOTKIT_TELEMETRY_DISABLED`).
- `tests/telemetry.test.ts` intercepts `fetch` and asserts zero outbound
  requests from a real `Platform`.
- No licensing, activation, or remote quota checks exist.

## Historical Intelligence data

Existing Intelligence conversations were never stored locally by the upstream
template, so this migration cannot invent them. They remain in your Intelligence
project. If you need them, export them there and import them into
`agent_threads` / `agent_runs`; the schema is plain JSON, and the migration does
not silently discard anything because there was nothing local to discard. New
conversations created after the migration are fully local.

Back up `DATABASE_PATH` before upgrading an existing deployment.
