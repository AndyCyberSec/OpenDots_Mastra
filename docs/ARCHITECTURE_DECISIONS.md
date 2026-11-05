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
