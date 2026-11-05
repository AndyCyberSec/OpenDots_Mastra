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
| `thread_bindings`                                 | Owner-visible conversations: thread id, Dot, title, creation time.                                       |
| `pages`                                           | Space pages with revision numbers and Markdown content.                                                  |
| `page_threads` / `page_reviews`                   | Page ↔ conversation bindings and review receipts.                                                        |
| `captures`                                        | Last research capture per conversation.                                                                  |
| `calls`                                           | Voice call receipts.                                                                                     |
| `mcp_connections`, `mcp_approvals`, `mcp_actions` | MCP connections, pending approvals, and action receipts.                                                 |
| `computers` and related tables                    | Per-Dot computer identifiers, state, and action audit.                                                   |
| `settings`, `tasks`, `runs`, `events`             | Workspace settings and durable background work.                                                          |
| `memories`                                        | Owner-curated long-term preferences injected into the prompt.                                            |
| `setup_telemetry`                                 | Legacy table; no longer written (no telemetry).                                                          |

## Conversation tables (new)

```sql
CREATE TABLE agent_threads (
  threadId TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  name TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]'   -- JSON array of AG-UI messages
);

CREATE TABLE agent_runs (
  runId TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  agentId TEXT NOT NULL,
  parentRunId TEXT,
  events TEXT NOT NULL,                 -- JSON array of compacted AG-UI events
  createdAt INTEGER NOT NULL
);
```

- `agent_threads.messages` is the canonical transcript the UI reads (via
  `GET /api/copilotkit/threads/:id/messages`) and that page-save, voice history,
  scheduled tasks, and Slack use.
- `agent_runs.events` keeps the replayable event stream for `/connect` and
  `/threads/:id/events`. Each run stores only the new input messages plus its
  generated events.
- No retention limit or expiry. Deleting a thread deletes its runs.

## Learning tables (new)

```sql
CREATE TABLE learning_containers (
  id TEXT PRIMARY KEY,          -- owner-chosen slug, frozen into conversations
  name TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  threshold INTEGER NOT NULL DEFAULT 15,
  createdAt INTEGER NOT NULL,
  lastAnalyzedAt INTEGER
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
  can be reset to `[]` without touching other tables. Corrupt `agent_runs` rows
  are skipped during replay.
- **Interrupted background runs:** the lease-based runner marks them
  **Interrupted**; review effects, then retry explicitly.
