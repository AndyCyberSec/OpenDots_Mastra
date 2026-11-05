# Architecture decisions

Records for this self-hosted branch. The guiding rule: **preserve OpenDots as
designed and remove only the mandatory CopilotKit Intelligence dependency.**

## ADR-001: Keep the original React UI, CopilotKit SDK, AG-UI, and TanStack AI

**Decision.** The React app, CopilotKit React SDK (v2), AG-UI protocol, and the
TanStack AI `BuiltInAgent` loop stay in place. `DotAgent` is the upstream class
with Intelligence-specific branches replaced by local services.

**Why.** This is the smallest change that removes the commercial dependency. A
framework migration (the earlier `feature/mastra-self-hosted` branch) replaced
working code and lost parity. Reusing mature components keeps behaviour,
capabilities, and test coverage.

**Consequences.** `@copilotkit/runtime`, `@copilotkit/react-core`,
`@copilotkit/core`, `@tanstack/ai`, and `@tanstack/ai-openai` remain as pinned MIT
dependencies. The earlier Mastra branch is preserved as a reference but is not
part of this architecture.

## ADR-002: CopilotKit runtime in local SSE mode, with a SQLite runner

**Decision.** `CopilotRuntime` is constructed **without** `intelligence` and with
`runner: SqliteAgentRunner`. The runtime's SSE mode exposes `/run`, `/connect`,
`/stop`, `/threads`, `/threads/:id/messages`, `/threads/:id/events`, `/info`, and
`/agent/:id/stop/:threadId` from that runner.

**Alternatives.** A hand-written AG-UI SSE server (more surface, no benefit);
keeping Intelligence (violates the goal); the earlier Mastra branch's approach
(same runner idea, but with a new agent engine — rejected here).

**Consequences.** Intelligence is never instantiated, no key is read, no WebSocket
or hosted route is contacted. Thread PATCH/DELETE remain Intelligence-only, so
rename/archive/delete are not exposed (they were not exercised by the UI either).

## ADR-003: One SQLite file for workspace, conversations, and learning

**Decision.** Extend the existing `DATABASE_PATH` with `agent_threads`,
`agent_runs`, learning tables, and Slack subscriptions. Versioned migrations run
in `BEGIN IMMEDIATE` transactions.

**Why.** The requirement is local persistence without a second database. Events
are appended per completed run (compacted), and a thread-level message snapshot
serves the UI.

**Consequences.** A run interrupted by process exit is not persisted at all, so
replay shows the last completed turn. Single-process writer; WAL plus busy
timeout. No retention limits on conversations; evidence windows are bounded
because they are learning input.

## ADR-004: Reproduce Automatic Learning locally instead of dropping it

**Decision.** Keep the container/assignment/delivery model and add local
evidence, explicit model analysis, owner review, and published-skill delivery
with the original `copilotkit_load_skill` / `copilotkit_read_skill_file` tools.

**Alternatives.** File-based skill folders (the earlier branch; not equivalent —
no learning from conversations) or removing the feature (unacceptable loss).

**Consequences.** Analysis is owner-triggered, not scheduled (cost control and no
unrestricted self-modification). The model can only propose draft text; only the
owner can publish. See [LEARNING.md](LEARNING.md).

## ADR-005: Direct Slack integration over official Slack APIs

**Decision.** Replace `@copilotkit/channels` (Intelligence-managed) with
`@slack/socket-mode` + `@slack/web-api`. A mention subscribes a thread; plain
messages continue it; each Slack thread maps to one local conversation.

**Why.** Slack support must not depend on a managed channel service. Socket Mode
avoids requiring a public HTTPS endpoint and is the standard self-hosted pattern.

**Consequences.** The operator creates a Slack app with two tokens. Workspace and
user allowlists, channel restriction, Dot selection, pause handling, and
serialization are preserved. Approval-gated tools remain web-only, as upstream.

## ADR-006: Provider-independent model configuration on the original adapter

**Decision.** Keep `@tanstack/ai-openai/compatible`; add `AI_PROVIDER`,
`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_MAX_OUTPUT_TOKENS` with `OPENAI_*`
fallbacks and a per-Dot model override.

**Consequences.** DeepSeek, Ollama, and any OpenAI-compatible endpoint work the
same way. Nothing is hardcoded, and OpenDots never switches provider or model on
its own.

## ADR-007: Telemetry removed, opted out before import

**Decision.** Delete the setup-event transport and set `DO_NOT_TRACK=1` in
`src/server/telemetry-env.ts`, imported before the AG-UI runtime is evaluated.

**Why.** The runtime reads its telemetry flag at module import; setting it later
is ineffective. `tests/telemetry.test.ts` intercepts `fetch` and asserts zero
outbound requests from a real `Platform`.

## ADR-008: Keep application-level approvals and the durable task runner

**Decision.** Do not replace the SQLite approval receipts or the lease-based
background runner.

**Why.** Both are already local, tested, and enforce explicit review. Replacing
them would add risk without removing any Intelligence dependency.

**Consequences.** Approvals are web-only (as upstream). Interrupted background
runs require a human retry; durability is state tracking, not exactly-once
execution.

## ADR-009: Append-only event journal with bounded live buffers

**Decision.** Persist AG-UI events incrementally in `agent_run_events` (thread
sequence, batched transactions), create a `running` run row before execution, and
use plain RxJS `Subject`s plus a 512-entry ring buffer for live streaming.
`connect` replays the journal in 500-row chunks, merges the ring for events not
yet flushed, and then joins the live subject.

**Why.** The previous design held every event in memory (`ReplaySubject(Infinity)`)
and wrote the transcript only at the end, so a crash lost the turn and long runs
grew without bound. The journal gives restart recovery, ordered replay, and
bounded memory without changing the AG-UI contract or the React client.

**Alternatives.** Keeping an in-memory history and flushing at the end (loses
work); per-token transcript rewrites (write amplification); a second database
(unnecessary).

**Consequences.** A crash can lose at most the last unflushed batch (≤64 events
or 250 ms). Terminal events and status are committed before the client sees
`RUN_FINISHED`; if that write fails the client gets `RUN_ERROR`. Recovery never
replays actions; interrupted runs wait for the owner.

Finalization is idempotent. A forced stop (provider ignores abort) sets the run
finalized before writing its terminal event; a later agent resolution finds the
run already finalized and cannot append events or overwrite the status. `close()`
does the same before recording `interrupted`, so shutdown cannot be reversed by a
late resolution.

The runtime's `/threads/:id/events` interface must return a materialized array.
That response is capped by `AGENT_THREAD_EVENTS_LIMIT` (default 10000) with a
`CUSTOM` truncation marker; `/connect` streams the complete journal in 500-row
chunks, so the UI path never loses history and memory stays bounded. State lookup
reads only the newest `STATE_SNAPSHOT` rather than replaying the thread.

## ADR-010: Conversation management owned by OpenDots, not the runtime

**Decision.** Rename, archive/restore, delete, pagination, and search are
application endpoints (`/api/conversations`). The runtime keeps its read routes;
its write routes remain Intelligence-only and are unused.

**Why.** Thread write routes are part of the commercial runtime surface. An
owner API can enforce OpenDots ownership, Dot/Space associations, and cascade
cleanup in one SQLite transaction without forking the MIT runtime.

**Consequences.** Deletion is refused while a run is active, cancels scheduled
tasks bound to the conversation, removes all referencing rows, and keeps pages.
Archived conversations reject new turns. The sidebar adds search, archived view,
pagination, and per-conversation actions without changing the overall UI.

## ADR-011: Opt-in automatic Learning analysis on the existing scheduler

**Decision.** Automatic analysis is a workspace setting (off by default) executed
by the existing `Runner` tick, at most one container per tick, gated by readiness,
new evidence, container/workspace pause, and a configurable interval (5 min–1
week). It can only create drafts; publishing stays owner-only.

**Why.** The hosted feature could analyze on a schedule, but unattended model
calls must be explicit and bounded. Reusing the durable background runner avoids
a second scheduler and inherits shutdown behavior.

**Consequences.** Eligibility and failures persist in `learning_containers`
(`lastAutoAttemptAt`, `lastAutoError`, `analyzedEvidenceAt`). Failed attempts wait
for the interval instead of retrying every tick. Overlapping manual/automatic
analyses are rejected. The review workflow is unchanged.
