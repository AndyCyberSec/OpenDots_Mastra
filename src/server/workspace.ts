import { ComputerStore } from './computer-store.js';
import { ConnectionStore } from './connection-store.js';
import { Pages } from './pages.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateLearningSettings } from '../shared/learning.js';
import { migrate } from './db.js';
import type {
  CallReceipt,
  Conversation,
  ConversationPage,
  Dot,
  Space,
} from '../shared/types.js';
export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  readonly connections: ConnectionStore;
  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    for (const [table, column, definition] of [
      ['dots', 'learningContainerId', 'TEXT'],
      ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'appsAllowed', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'composioToolkits', "TEXT NOT NULL DEFAULT '[]'"],
      ['dots', 'composioSessionId', 'TEXT'],
      ['dots', 'composioPolicyHash', 'TEXT'],
      ['thread_bindings', 'learningContainerId', 'TEXT'],
      // Per-Dot model override. Null keeps the workspace default model.
      ['dots', 'model', 'TEXT'],
      ['thread_bindings', 'archived', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    this.computers = new ComputerStore(this.db);
    this.connections = new ConnectionStore(this.db);
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    migrate(this.db);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS thread_bindings_owner
        ON thread_bindings(ownerId, createdAt);
      CREATE INDEX IF NOT EXISTS thread_bindings_archive
        ON thread_bindings(ownerId, archived, createdAt);
    `);
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
  }
  close() {
    this.db.close();
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => ({
        ...row,
        spaceIds: this.db
          .prepare(
            'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
          )
          .all(String(row.id))
          .map((grant) => String(grant.spaceId)),
        researchAllowed: !!row.researchAllowed,
        memoryAllowed: !!row.memoryAllowed,
        appsAllowed: !!row.appsAllowed,
        composioToolkits: JSON.parse(String(row.composioToolkits ?? '[]')),
        skillDeliveryEnabled: !!row.skillDeliveryEnabled,
        model: typeof row.model === 'string' ? row.model : null,
      })) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    learningContainerId: string | null = null,
    skillDeliveryEnabled = false,
    appsAllowed = false,
    composioToolkits: string[] = [],
    model: string | null = null,
  ): Dot {
    this.validateSpaceAccess(spaceId, spaceIds);
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      appsAllowed,
      composioToolkits: [...new Set(composioToolkits)].sort(),
      composioSessionId: null,
      composioPolicyHash: null,
      learningContainerId,
      skillDeliveryEnabled,
      model,
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled, appsAllowed, composioToolkits, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          dot.createdAt,
          learningContainerId,
          +skillDeliveryEnabled,
          +appsAllowed,
          JSON.stringify(dot.composioToolkits),
          model,
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      | 'name'
      | 'instructions'
      | 'researchAllowed'
      | 'memoryAllowed'
      | 'appsAllowed'
      | 'composioToolkits'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      learningContainerId?: string | null;
      skillDeliveryEnabled?: boolean;
      model?: string | null;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const learningContainerId =
      patch.learningContainerId === undefined
        ? (current.learningContainerId ?? null)
        : patch.learningContainerId;
    const skillDeliveryEnabled =
      patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=?, appsAllowed=?, composioToolkits=?, model=? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          learningContainerId,
          +skillDeliveryEnabled,
          +patch.appsAllowed,
          JSON.stringify([...new Set(patch.composioToolkits)].sort()),
          (patch.model ?? current.model ?? null) || null,
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  saveComposioSession(id: string, sessionId: string, policyHash: string) {
    this.db
      .prepare(
        'UPDATE dots SET composioSessionId=?, composioPolicyHash=? WHERE id=?',
      )
      .run(sessionId, policyHash, id);
  }
  conversations(): Conversation[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM thread_bindings WHERE ownerId=? ORDER BY createdAt DESC',
        )
        .all(this.ownerId) as unknown as (Omit<Conversation, 'archived'> & {
        archived: number;
      })[]
    ).map((row) => ({ ...row, archived: !!row.archived }));
  }

  conversation(id: string): Conversation | undefined {
    return this.conversations().find((conversation) => conversation.id === id);
  }

  /**
   * Owner-facing conversation listing. Keyset pagination keeps the query
   * stable while new conversations are created; search matches the bound title
   * and, where practical, stored message content.
   */
  conversationPage(options: {
    limit: number;
    cursor?: string;
    query?: string;
    archived?: boolean;
  }): ConversationPage {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const query = (options.query ?? '').trim().slice(0, 200);
    const archived = options.archived ? 1 : 0;
    const cursor = parseConversationCursor(options.cursor);
    const filters = ['b.ownerId=?', 'b.archived=?'];
    const params: (string | number)[] = [this.ownerId, archived];
    if (query) {
      filters.push('(b.title LIKE ? OR t.messages LIKE ?)');
      const like = `%${query}%`;
      params.push(like, like);
    }
    if (cursor) {
      filters.push('(b.createdAt < ? OR (b.createdAt = ? AND b.id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.db
      .prepare(
        `SELECT b.*, t.messages AS storedMessages
         FROM thread_bindings b
         LEFT JOIN agent_threads t ON t.threadId = b.id
         WHERE ${filters.join(' AND ')}
         ORDER BY b.createdAt DESC, b.id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1) as unknown as (Omit<
      Conversation,
      'archived'
    > & {
      archived: number;
      storedMessages: string | null;
    })[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      conversations: page.map((row) => ({
        ...row,
        archived: !!row.archived,
        messageCount: countMessages(row.storedMessages),
      })),
      nextCursor:
        rows.length > limit && last ? `${last.createdAt}:${last.id}` : null,
    };
  }

  renameConversation(id: string, title: string): Conversation {
    const conversation = this.requireThread(id);
    const clean = title.trim().slice(0, 120);
    if (!clean) throw new Error('Conversation title is required.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('UPDATE thread_bindings SET title=? WHERE id=? AND ownerId=?')
        .run(clean, id, this.ownerId);
      this.db
        .prepare(
          'UPDATE agent_threads SET name=?, updatedAt=? WHERE threadId=?',
        )
        .run(clean, Date.now(), conversation.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.requireThread(id);
  }

  archiveConversation(id: string, archived: boolean): Conversation {
    this.requireThread(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'UPDATE thread_bindings SET archived=? WHERE id=? AND ownerId=?',
        )
        .run(+archived, id, this.ownerId);
      this.db
        .prepare(
          'UPDATE agent_threads SET archived=?, updatedAt=? WHERE threadId=?',
        )
        .run(+archived, Date.now(), id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.requireThread(id);
  }

  taskIdsForThread(threadId: string): string[] {
    return (
      this.db
        .prepare('SELECT taskId FROM task_threads WHERE threadId=?')
        .all(threadId) as { taskId: string }[]
    ).map((row) => row.taskId);
  }

  /**
   * Delete a conversation and every local record that points at it. One
   * transaction keeps workspace bindings, transcripts, approvals, captures,
   * calls, scheduled-task links, Learning evidence, and Slack subscriptions
   * consistent. Pages themselves are kept.
   */
  deleteConversation(id: string): boolean {
    const conversation = this.db
      .prepare('SELECT id FROM thread_bindings WHERE id=? AND ownerId=?')
      .get(id, this.ownerId);
    if (!conversation) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, column] of [
        ['agent_run_events', 'threadId'],
        ['agent_runs', 'threadId'],
        ['agent_threads', 'threadId'],
        ['page_reviews', 'threadId'],
        ['page_threads', 'threadId'],
        ['captures', 'threadId'],
        ['calls', 'threadId'],
        ['task_threads', 'threadId'],
        ['learning_evidence', 'threadId'],
        ['slack_subscriptions', 'threadId'],
      ] as const) {
        if (!this.tableExists(table)) continue;
        this.db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(id);
      }
      this.db
        .prepare('DELETE FROM thread_bindings WHERE id=? AND ownerId=?')
        .run(id, this.ownerId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private tableExists(table: string) {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
  }
  bindThread(id: string, dotId: string, title: string): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      learningContainerId: dot.learningContainerId ?? null,
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        dotId,
        this.ownerId,
        title,
        value.createdAt,
        value.learningContainerId ?? null,
      );
    return value;
  }
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.conversations().find((thread) => thread.id === id);
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
  }
}

function countMessages(value: string | null | undefined): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function parseConversationCursor(
  value: string | undefined,
): { createdAt: number; id: string } | undefined {
  if (!value) return undefined;
  const separator = value.indexOf(':');
  if (separator < 1) return undefined;
  const createdAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!Number.isFinite(createdAt) || !id) return undefined;
  return { createdAt, id };
}
