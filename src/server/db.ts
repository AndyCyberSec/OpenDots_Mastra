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
