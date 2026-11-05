import type { DatabaseSync } from 'node:sqlite';

/**
 * Versioned schema migrations for the local SQLite database.
 *
 * The original OpenDots schema is created with `CREATE TABLE IF NOT EXISTS`
 * statements in `Store` and `WorkspaceStore`. Those statements stay in place so
 * existing databases keep working unchanged. This module adds versioned,
 * transactional migrations for the Mastra-era additions (agent conversations,
 * per-Dot model overrides) and records them in `schema_migrations` so a future
 * change can tell whether it already ran.
 *
 * Every migration must be safe to run twice: OpenDots opens the same file from
 * more than one store instance in the same process.
 */

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'agent-conversation-store',
    up: (db) => {
      // Canonical, durable AG-UI conversation store. Mastra memory writes into
      // its own `mastra_*` tables in the same database file; these tables hold
      // the client-visible transcript, tool calls, and replayable run events.
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_threads (
          threadId TEXT PRIMARY KEY,
          agentId TEXT NOT NULL,
          name TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          messages TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS agent_runs (
          runId TEXT PRIMARY KEY,
          threadId TEXT NOT NULL,
          agentId TEXT NOT NULL,
          parentRunId TEXT,
          events TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS agent_runs_thread
          ON agent_runs(threadId, createdAt);
        CREATE INDEX IF NOT EXISTS agent_threads_agent
          ON agent_threads(agentId, updatedAt);
      `);
    },
  },
  {
    version: 2,
    name: 'learning-store',
    up: (db) => {
      // Local replacement for CopilotKit Automatic Learning: containers group
      // evidence from enrolled conversations; the owner reviews proposed skills
      // before they are delivered to Dots.
      db.exec(`
        CREATE TABLE IF NOT EXISTS learning_containers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          paused INTEGER NOT NULL DEFAULT 0,
          threshold INTEGER NOT NULL DEFAULT 15,
          createdAt INTEGER NOT NULL,
          lastAnalyzedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS learning_evidence (
          id TEXT PRIMARY KEY,
          containerId TEXT NOT NULL,
          threadId TEXT NOT NULL,
          dotId TEXT NOT NULL,
          messageId TEXT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS learning_evidence_container
          ON learning_evidence(containerId, createdAt);
        CREATE UNIQUE INDEX IF NOT EXISTS learning_evidence_message
          ON learning_evidence(containerId, messageId)
          WHERE messageId IS NOT NULL;
        CREATE TABLE IF NOT EXISTS learning_skills (
          id TEXT PRIMARY KEY,
          containerId TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          evidenceCount INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          reviewedAt INTEGER,
          publishedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS learning_skills_container
          ON learning_skills(containerId, status, createdAt);
        CREATE TABLE IF NOT EXISTS learning_runs (
          id TEXT PRIMARY KEY,
          containerId TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          evidenceCount INTEGER NOT NULL,
          proposedCount INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          finishedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS learning_runs_container
          ON learning_runs(containerId, createdAt);
      `);
    },
  },
  {
    version: 3,
    name: 'slack-subscriptions',
    up: (db) => {
      // Direct Slack integration: a mention subscribes the thread; later plain
      // messages in that thread continue the same local conversation.
      db.exec(`
        CREATE TABLE IF NOT EXISTS slack_subscriptions (
          channelId TEXT NOT NULL,
          threadTs TEXT NOT NULL,
          threadId TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          PRIMARY KEY (channelId, threadTs)
        );
      `);
    },
  },
];

export function migrate(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAt INTEGER NOT NULL)',
  );
  const applied = new Set(
    (
      db.prepare('SELECT version FROM schema_migrations').all() as {
        version: number;
      }[]
    ).map((row) => Number(row.version)),
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
