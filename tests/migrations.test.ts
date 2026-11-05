import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { SqliteAgentRunner } from '../src/server/agent-runner.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

/**
 * Represents a database created by the previous branch (`v1`–`v3` migrations):
 * conversation tables without `nextSeq`/status/journal columns, workspace
 * bindings without `archived`, and a legacy run stored as compacted event JSON.
 */
function legacyDatabase(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAt INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES
      (1, 'agent-conversation-store', 1),
      (2, 'learning-store', 2),
      (3, 'slack-subscriptions', 3);
    CREATE TABLE agent_threads (
      threadId TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      name TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE agent_runs (
      runId TEXT PRIMARY KEY,
      threadId TEXT NOT NULL,
      agentId TEXT NOT NULL,
      parentRunId TEXT,
      events TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE thread_bindings (
      id TEXT PRIMARY KEY,
      dotId TEXT NOT NULL,
      ownerId TEXT NOT NULL,
      title TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      learningContainerId TEXT
    );
    CREATE TABLE learning_containers (id TEXT PRIMARY KEY, name TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, threshold INTEGER NOT NULL DEFAULT 15, createdAt INTEGER NOT NULL, lastAnalyzedAt INTEGER);
    CREATE TABLE learning_evidence (id TEXT PRIMARY KEY, containerId TEXT NOT NULL, threadId TEXT NOT NULL, dotId TEXT NOT NULL, messageId TEXT, role TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE learning_skills (id TEXT PRIMARY KEY, containerId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, evidenceCount INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, reviewedAt INTEGER, publishedAt INTEGER);
    CREATE TABLE learning_runs (id TEXT PRIMARY KEY, containerId TEXT NOT NULL, status TEXT NOT NULL, error TEXT, evidenceCount INTEGER NOT NULL, proposedCount INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, finishedAt INTEGER);
    CREATE TABLE slack_subscriptions (channelId TEXT NOT NULL, threadTs TEXT NOT NULL, threadId TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY (channelId, threadTs));
  `);
  const now = Date.now();
  db.prepare(
    'INSERT INTO agent_threads (threadId, agentId, name, createdAt, updatedAt, messages) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'legacy-thread',
    'legacy-dot',
    'Legacy conversation',
    now - 1000,
    now - 1000,
    JSON.stringify([
      { id: 'u1', role: 'user', content: 'Old question' },
      { id: 'a1', role: 'assistant', content: 'Old answer' },
    ]),
  );
  db.prepare(
    'INSERT INTO agent_runs (runId, threadId, agentId, parentRunId, events, createdAt) VALUES (?, ?, ?, NULL, ?, ?)',
  ).run(
    'legacy-run',
    'legacy-thread',
    'legacy-dot',
    JSON.stringify([
      {
        type: 'RUN_STARTED',
        threadId: 'legacy-thread',
        runId: 'legacy-run',
      },
      {
        type: 'TEXT_MESSAGE_START',
        messageId: 'a1',
        role: 'assistant',
      },
      {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'a1',
        delta: 'Old answer',
      },
      { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
      {
        type: 'RUN_FINISHED',
        threadId: 'legacy-thread',
        runId: 'legacy-run',
      },
    ]),
    now - 1000,
  );
  db.prepare(
    'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId) VALUES (?, ?, ?, ?, ?, NULL)',
  ).run(
    'legacy-thread',
    'legacy-dot',
    'owner',
    'Legacy conversation',
    now - 1000,
  );
  db.close();
}

it('upgrades a previous-branch database without losing conversations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-migrate-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'opendots.sqlite');
  legacyDatabase(path);

  const runner = new SqliteAgentRunner(path, 'owner');
  resources.push(() => runner.close());

  // Legacy transcript and replay survive the upgrade.
  expect(runner.getThreadMessages('legacy-thread')).toHaveLength(2);
  const replayed = runner.getThreadEvents('legacy-thread');
  expect(replayed.some((event) => event.type === 'TEXT_MESSAGE_CONTENT')).toBe(
    true,
  );
  expect(runner.runStatus('legacy-thread')).toMatchObject({
    status: 'completed',
    eventCount: 0,
  });
  // New runs on the legacy thread work and get monotonic sequences.
  expect(runner.durableEventCount('legacy-thread')).toBe(0);
  runner.renameThread('legacy-thread', 'Renamed legacy');
  expect(runner.threadName('legacy-thread')).toBe('Renamed legacy');

  // Workspace tables gain `archived`; the binding remains readable and pageable.
  const workspace = new WorkspaceStore(path, 'owner');
  resources.push(() => workspace.close());
  expect(workspace.conversations()).toHaveLength(1);
  expect(workspace.conversation('legacy-thread')).toMatchObject({
    id: 'legacy-thread',
    title: 'Legacy conversation',
    archived: false,
    learningContainerId: null,
  });
  const page = workspace.conversationPage({ limit: 10 });
  expect(page.conversations).toHaveLength(1);
  expect(page.nextCursor).toBeNull();

  // Both migrations are recorded and the new columns/indexes exist.
  const db = new DatabaseSync(path);
  try {
    const versions = (
      db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as {
        version: number;
      }[]
    ).map((row) => row.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const threadColumns = db
      .prepare('PRAGMA table_info(agent_threads)')
      .all()
      .map((column) => column.name);
    expect(threadColumns).toEqual(
      expect.arrayContaining(['nextSeq', 'archived']),
    );
    const runColumns = db
      .prepare('PRAGMA table_info(agent_runs)')
      .all()
      .map((column) => column.name);
    expect(runColumns).toEqual(
      expect.arrayContaining([
        'status',
        'startedAt',
        'finishedAt',
        'error',
        'eventCount',
      ]),
    );
    const bindingColumns = db
      .prepare('PRAGMA table_info(thread_bindings)')
      .all()
      .map((column) => column.name);
    expect(bindingColumns).toContain('archived');
    const journal = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_run_events'",
      )
      .get();
    expect(journal).toBeDefined();
  } finally {
    db.close();
  }
});

it('marks a run left running by a previous process as interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-migrate-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'opendots.sqlite');
  const setup = new SqliteAgentRunner(path, 'owner');
  setup.registerThread('thread', 'dot', 'Interrupted');
  setup.close();

  const db = new DatabaseSync(path);
  db.prepare(
    "INSERT INTO agent_runs (runId, threadId, agentId, parentRunId, events, createdAt, status, startedAt, eventCount) VALUES ('run', 'thread', 'dot', NULL, '[]', ?, 'running', ?, 0)",
  ).run(Date.now(), Date.now());
  db.close();

  // Construction performs crash recovery before serving any request.
  const reopened = new SqliteAgentRunner(path, 'owner');
  resources.push(() => reopened.close());
  expect(reopened.runStatus('thread')).toMatchObject({
    status: 'interrupted',
    error: expect.stringContaining('Server stopped'),
  });
  expect(await reopened.isRunning({ threadId: 'thread' })).toBe(false);
});
