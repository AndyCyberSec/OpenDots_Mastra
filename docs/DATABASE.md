# Database schema

OpenDots uses one SQLite file per deployment (`DATABASE_PATH`, default
`data/opendots.sqlite`). It contains the workspace, conversations, agent memory,
approvals, and background work. WAL mode and a 5 s busy timeout are enabled by
every connection.

## Workspace tables (preserved from upstream)

| Table                                             | Purpose                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `spaces`                                          | Spaces (name, description).                                                                              |
| `dots`                                            | Specialist Dots: instructions, permissions, default Space, model override, legacy Learning container id. |
| `dot_spaces`                                      | Many-to-many Space access grants per Dot.                                                                |
| `thread_bindings`                                 | Owner-visible conversations: thread id, Dot, title, creation time, archive flag.                         |
| `pages`                                           | Space pages with revision numbers and Markdown content.                                                  |
| `page_threads` / `page_reviews`                   | Page ↔ conversation bindings and review receipts.                                                        |
| `captures`                                        | Last research capture per conversation.                                                                  |
| `calls`                                           | Voice call receipts.                                                                                     |
| `mcp_connections`, `mcp_approvals`, `mcp_actions` | MCP connections, pending approvals, and action receipts.                                                 |
| `computers` and related tables                    | Per-Dot computer identifiers, state, and action audit.                                                   |
| `settings`, `tasks`, `runs`, `events`             | Workspace settings (including opt-in Learning automation) and durable background work.                   |
| `memories`                                        | Owner-curated long-term preferences injected into the prompt.                                            |
| `setup_telemetry`                                 | Legacy table; no longer written (no telemetry).                                                          |

## Conversation tables

```sql
CREATE TABLE agent_threads (
  threadId TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  name TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]',  -- transcript checkpoint (AG-UI messages)
  nextSeq INTEGER NOT NULL DEFAULT 0,   -- thread-local event sequence
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agent_runs (
  runId TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  agentId TEXT NOT NULL,
  parentRunId TEXT,
  events TEXT NOT NULL,                 -- legacy compacted events (pre-journal runs)
  createdAt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed', -- running|completed|failed|interrupted|cancelled
  startedAt INTEGER NOT NULL DEFAULT 0,
  finishedAt INTEGER,
  error TEXT,
  eventCount INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agent_run_events (       -- append-only journal
  runId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  seq INTEGER NOT NULL,               -- monotonic per thread
  event TEXT NOT NULL,                -- one AG-UI event
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (runId, seq)
);
```

### Durability model

- A run row is inserted with `status='running'` before the agent starts.
- Every event is appended to `agent_run_events` in batched transactions (64
  events or 250 ms), together with the thread `nextSeq` and a transcript
  checkpoint (`agent_threads.messages`, written at most once per flush).
  The transcript is never rewritten per token.
- At finalize, terminal events, run status, and the final transcript are
  committed in one transaction **before** the client receives `RUN_FINISHED`.
  If a journal or status write fails, the client receives `RUN_ERROR` and the
  run is recorded (best effort) as `failed`; OpenDots never claims a durable
  success it could not store.
- Finalization is idempotent. A normal completion, an error, and the forced stop
  fallback (2.5 s, when a provider ignores abort) all converge on one terminal
  write: the first finalize wins, the terminal status cannot be overwritten, and
  late events or a late agent resolution are ignored. `close()` marks the run
  finalized before recording `interrupted`, so a late resolution after shutdown
  cannot turn it into `completed`.
- On startup, any run still marked `running` is marked `interrupted` with its
  committed events intact. Nothing is retried automatically, so a possibly
  completed tool action is never repeated without owner review.
- `agent_threads.messages` is the canonical transcript the UI reads (via
  `GET /api/copilotkit/threads/:id/messages`) and that page-save, voice history,
  scheduled tasks, and Slack use.
- Replay (`/connect`) reads the journal in 500-row chunks and still understands
  legacy `agent_runs.events` rows, so databases from the previous branch upgrade
  without losing conversations.
- `GET /threads/:id/events` must return a materialized array (runtime interface),
  so it is bounded by `AGENT_THREAD_EVENTS_LIMIT` (default 10000). When a thread
  is longer, the response contains the most recent events preceded by a `CUSTOM`
  `opendots.history_truncated` event (`totalEvents`, `retainedEvents`). Nothing is
  deleted: `/connect` and the UI still replay the full journal and the transcript
  is complete. `getThreadState` uses a bounded lookup for the last state snapshot
  instead of materializing the thread.
- No retention limit or expiry. Deleting a conversation removes its runs and
  journal rows.

### Indexes

`agent_run_events(threadId, seq)`, `agent_runs(threadId, createdAt)`,
`agent_runs(status, threadId)`, `agent_threads(updatedAt)`,
`agent_threads(archived, updatedAt)`, `thread_bindings(ownerId, createdAt)`,
`thread_bindings(ownerId, archived, createdAt)`.

## Conversation management

`thread_bindings.archived` and `agent_threads.archived` are kept in sync by the
owner API. Listing uses keyset pagination on `(createdAt, id)` and searches the
bound title and stored messages. Deletion runs in one transaction and removes:

`thread_bindings`, `agent_threads`, `agent_runs`, `agent_run_events`,
`page_reviews`, `page_threads`, `captures`, `calls`, `task_threads`,
`learning_evidence`, and `slack_subscriptions` for that conversation. Pages are
kept (and can start a fresh page conversation). Scheduled tasks bound to the
conversation are cancelled first and the request is refused while a run is
active.

## Learning tables (new)

```sql
CREATE TABLE learning_containers (
  id TEXT PRIMARY KEY,          -- owner-chosen slug, frozen into conversations
  name TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  threshold INTEGER NOT NULL DEFAULT 15,
  createdAt INTEGER NOT NULL,
  lastAnalyzedAt INTEGER,
  lastAutoAttemptAt INTEGER,       -- last automatic attempt (success or failure)
  lastAutoError TEXT,              -- sanitized owner-visible failure
  analyzedEvidenceAt INTEGER,      -- newest evidence timestamp already analyzed
  analyzedEvidenceCount INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE learning_evidence (
  id TEXT PRIMARY KEY,
  containerId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  dotId TEXT NOT NULL,
  messageId TEXT,               -- unique per container when present (de-duplication)
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE learning_skills (
  id TEXT PRIMARY KEY,
  containerId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,         -- draft | published | rejected
  source TEXT NOT NULL,         -- model
  evidenceCount INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  reviewedAt INTEGER,
  publishedAt INTEGER
);
CREATE TABLE learning_runs (
  id TEXT PRIMARY KEY,
  containerId TEXT NOT NULL,
  status TEXT NOT NULL,         -- running | completed | failed
  error TEXT,
  evidenceCount INTEGER NOT NULL,
  proposedCount INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  finishedAt INTEGER
);
```

Evidence is a bounded rolling window (`LEARNING_EVIDENCE_LIMIT`, default 2000
rows per container). Conversations are never trimmed. Skill text is stored in
`learning_skills.content`.

Automatic analysis is opt-in (`settings.learningAutoAnalyze`, off by default)
with a minimum interval (`settings.learningIntervalMinutes`, default 60, range
5–10080). The auto state columns make eligibility survive restarts: a container
is analyzed only when it is not paused, the workspace is not paused, its
readiness threshold is met, there is evidence newer than `analyzedEvidenceAt`,
and the interval since `lastAutoAttemptAt`/`lastAnalyzedAt` has elapsed.
Analysis runs commit drafts only; publishing remains owner-only. A `running`
analysis left by a crash is marked failed on upgrade and is not retried
automatically. Manual analysis is unaffected by the interval.

## Slack tables (new)

```sql
CREATE TABLE slack_subscriptions (
  channelId TEXT NOT NULL,
  threadTs TEXT NOT NULL,
  threadId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (channelId, threadTs)
);
```

A mention subscribes a thread; later plain messages continue the same local
conversation.

## Migrations

`schema_migrations` (version, name, appliedAt) records versioned migrations from
`src/server/db.ts`. They run inside `BEGIN IMMEDIATE` transactions and are safe to
run from multiple store instances in one process.

The upstream `CREATE TABLE IF NOT EXISTS` statements remain, and new columns are
added with idempotent `ALTER TABLE ... ADD COLUMN` checks (for example
`dots.model`). This keeps existing databases working without a rewrite.

## Recovery

- **Backup:** stop the app, or copy `opendots.sqlite`, `-wal`, and `-shm`
  together.
- **Conversation repair:** `agent_threads.messages` is plain JSON; a corrupt row
  can be reset to `[]` without touching other tables. Corrupt journal or legacy
  event rows are skipped during replay rather than breaking the thread.
- **Interrupted agent runs:** runs left `running` at startup become
  `interrupted`. Their committed events are still replayable; the client sees the
  partial turn and the run status, and no action is retried automatically.
- **Interrupted background tasks:** the lease-based runner marks them
  **Interrupted**; review effects, then retry explicitly.
- **Learning analysis state:** stale `learning_runs` left `running` are marked
  failed during migration; the container's `lastAutoAttemptAt` still applies, so
  the next automatic attempt waits for the configured interval.
