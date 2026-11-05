# Architecture decisions

Short records of the decisions that shape this self-hosted fork. Each entry
states the decision, the alternatives considered, and the consequences.

## ADR-001: Mastra for agent execution

**Decision.** Every Dot is a Mastra `Agent`, built per turn from the persisted
Dot configuration. Model calls, tool loops, and memory go through Mastra.

**Why.** The requirement is a self-hosted agent framework under a permissive
license with local execution, tool calling, memory, and a path to workflows.
Mastra is Apache-2.0 and runs entirely in-process.

**Alternatives.** LangGraph (also viable, but the AG-UI bridge and memory
packaging were less direct here); continuing with CopilotKit's `BuiltInAgent`
plus TanStack AI (works, but keeps the stack tied to the runtime being replaced
and provides no memory layer).

**Consequences.** Agents are dynamic, so no static agent files are needed. Model
setup is provider-independent. Mastra's release cadence is rapid, so the pinned
versions in `package.json` are part of the compatibility surface.

## ADR-002: Keep the CopilotKit runtime in local SSE mode; drop Intelligence

**Decision.** Use `CopilotSseRuntime` from `@copilotkit/runtime` (MIT) purely as
the AG-UI transport and thread-endpoint layer, with a custom SQLite runner. The
React app keeps using `@copilotkit/react-core` (MIT). `CopilotKitIntelligence` is
never constructed.

**Why.** The frontend is deeply built on the CopilotKit v2 hooks
(`useAgent`, `useHumanInTheLoop`, `useRenderTool`, thread store). The runtime in
SSE mode already supports a caller-provided `AgentRunner` and local
`/threads`/`/messages` endpoints when the runner implements
`LocalThreadEndpointRunner`. Replacing the frontend would have been a large,
risky rewrite with no user-visible benefit.

**Alternatives.** A from-scratch AG-UI SSE server plus `@ag-ui/client` and a
custom chat state layer (maximal independence, maximal regression risk);
retaining Intelligence (violates the goal).

**Consequences.** CopilotKit packages remain as pinned MIT dependencies. They
make no hosted calls in this configuration, and telemetry is opted out
(ADR-006). The runtime's `/threads` PATCH/DELETE routes still require
Intelligence, so thread rename/archive/delete are not exposed in the UI.

## ADR-003: SQLite as the single durable store, with a custom runner

**Decision.** Persist the client-visible transcript and replayable events in
`agent_threads` and `agent_runs` in the existing workspace database, and use the
runtime's `LocalThreadEndpointRunner` contract directly.

**Why.** The requirement is durability without a parallel database. The in-memory
runner shipped with the runtime is bounded and non-durable by design; its
semantics (per-run compacted events, thread-level message snapshot, replay
filtering) translate cleanly to tables.

**Alternatives.** A separate database (rejected: unnecessary); implementing
Mastra `MemoryStorage` as the only store (more surface area, and the AG-UI
replay format is what the client needs).

**Consequences.** Every run is appended atomically on completion. A run killed
mid-flight is not persisted, so the last completed snapshot remains consistent.
Multi-process writers are not supported (single-writer deployment).

## ADR-004: Mastra Memory in the same database file

**Decision.** Configure `@mastra/memory` with `@mastra/libsql` against the same
SQLite file; Mastra creates namespaced `mastra_*` tables.

**Why.** Model continuity belongs to the agent framework, and the requirement
asks for local Mastra memory. The same file keeps backup and recovery simple.

**Alternatives.** A second database file (avoids lock contention between two
SQLite libraries, but complicates backups); skipping Mastra memory and re-sending
full history (simpler, but no framework memory and no path to semantic recall).

**Consequences.** Two SQLite clients open the same file. Both set WAL and a busy
timeout; writes are small and single-owner. Semantic recall is off by default
(no embedder in DeepSeek). The canonical UI transcript is the runner tables, not
Mastra's tables.

## ADR-005: Application-level approvals instead of Mastra interrupts

**Decision.** Keep the upstream approval design: gated MCP tools return
`approval_required`, the model calls the `request_connection_action` client tool,
the owner decides in the chat, and the decision is recorded in SQLite.

**Why.** It already persists approvals and receipts server-side, is bound to the
right thread/Dot, and works with the existing cards. It has no dependency on
Mastra workflow snapshots.

**Alternatives.** Mastra's native tool approval (`requireApproval` +
`approveToolCall`/`declineToolCall` + resume). It is a good fit for new tools, but
would need a snapshot store and a UI switch to `useInterrupt`.

**Consequences.** Approval semantics stay auditable and durable. Mastra's native
suspension path remains available for future tools.

## ADR-006: No telemetry, and opt out before importing the SDK

**Decision.** Remove the setup-event transport; set `DO_NOT_TRACK=1` before the
AG-UI runtime module is evaluated unless the operator explicitly configured a
telemetry flag.

**Why.** The runtime reads its telemetry env at module import. Setting the flag in
the server entrypoint after imports is too late. A side-effect module imported
first (`src/server/telemetry-env.ts`) guarantees the ordering.

**Consequences.** `tests/telemetry.test.ts` asserts zero outbound requests from a
real platform instance. An operator can still opt in explicitly.

## ADR-007: Local skill folders instead of Learning containers

**Decision.** Replace hosted Learning skill delivery with `SKILLS_DIR` folders
(`SKILL.md` + reference files) and two tools. Keep the legacy column/API field for
compatibility.

**Why.** Learning is a hosted Intelligence feature and cannot be reused. A file
based library is auditable, requires no database, and works offline.

**Alternatives.** Building an evidence-collection pipeline (large, and not
requested by the product); removing skill delivery entirely (unnecessary feature
loss).

**Consequences.** No automatic learning. Skills are trusted local content, read
on demand, with traversal and size limits.

## ADR-008: Background durability is state tracking, not exactly-once

**Decision.** Keep the SQLite lease-based runner and its explicit
completed/failed/interrupted/cancelled states. Do not retry possibly
non-idempotent effects automatically.

**Why.** Exactly-once external side effects are not achievable without provider
support. The safe behaviour is to stop and ask.

**Consequences.** Interrupted runs require a human retry. This is documented in
the README and setup guide, and reflected in the UI.

## ADR-009: Keep upstream attribution and the MIT license

**Decision.** Preserve the MIT license and attribution, and link to the upstream
repository in the README and package metadata.

**Why.** Legal requirement and good practice for a fork. See
[LICENSE_AUDIT.md](LICENSE_AUDIT.md).
