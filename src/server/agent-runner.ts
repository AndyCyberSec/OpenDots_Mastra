import { EventType, type BaseEvent, type Message } from '@ag-ui/core';
import { compactEvents, type AbstractAgent } from '@ag-ui/client';
import {
  AgentRunner,
  createRunEventFinalizer,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
  type LocalThreadEndpointRunner,
} from '@copilotkit/runtime/v2';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Observable, Subject } from 'rxjs';
import { migrate } from './db.js';

/**
 * Durable, SQLite-backed AG-UI agent runner.
 *
 * This replaces CopilotKit Intelligence thread storage with local tables in the
 * existing OpenDots database. It implements the runtime's
 * `LocalThreadEndpointRunner` contract, so the stock CopilotKit client keeps
 * working for:
 *
 *   - `GET  /api/copilotkit/threads`                (thread list)
 *   - `GET  /api/copilotkit/threads/:id/messages`   (transcript)
 *   - `GET  /api/copilotkit/threads/:id/events`     (replay)
 *   - `POST /api/copilotkit/agent/:id/connect`      (rehydration)
 *
 * Durability model:
 *
 *   - A run row is created with status `running` before the model is called.
 *   - Every AG-UI event is appended to `agent_run_events` in small batched
 *     transactions (WAL) while the run streams; the transcript snapshot is
 *     checkpointed on the same flushes, never on every token.
 *   - At finalize the terminal events, run status, and final messages are
 *     committed before the client is told the run finished. A storage failure
 *     turns the terminal event into `RUN_ERROR` instead of claiming success.
 *   - On startup, runs still marked `running` are marked `interrupted` with
 *     their committed events intact. Nothing is retried automatically.
 *
 * Memory model: live subscribers use plain `Subject`s. `connect` replays the
 * persisted journal in bounded chunks and then joins the live stream, using a
 * small ring buffer to cover events that have been emitted but not yet flushed.
 * Conversation history is never truncated by these buffers.
 */

const RING_CAPACITY = 512;
const FLUSH_EVENT_THRESHOLD = 64;
const FLUSH_INTERVAL_MS = 250;
const REPLAY_CHUNK = 500;
const DEFAULT_MAX_EVENT_BYTES = 512 * 1024;

interface SeqEvent {
  seq: number;
  event: BaseEvent;
}

interface ActiveRun {
  isRunning: boolean;
  stopRequested: boolean;
  currentRunId: string;
  agent: AbstractAgent;
  persistence: RunPersistence;
  finalizer: ReturnType<typeof createRunEventFinalizer>;
  subject: Subject<SeqEvent>;
  runSubject: Subject<BaseEvent>;
  recent: SeqEvent[];
  runError: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  forceFinalize?: () => void;
}

interface ThreadRow {
  threadId: string;
  agentId: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  messages: string;
  nextSeq: number;
}

interface RunRow {
  runId: string;
  threadId: string;
  agentId: string;
  parentRunId: string | null;
  events: string;
  createdAt: number;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  eventCount: number;
}

export interface AgentThreadSummary {
  threadId: string;
  agentId: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface AgentRunSummary {
  runId: string;
  threadId: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  eventCount: number;
}

export type RunStatus = AgentRunSummary['status'];

/**
 * Batched append-only journal writer for one run.
 *
 * Events receive a monotonically increasing thread-local sequence as they are
 * produced. They are buffered briefly (event count or time) and written in one
 * transaction together with the thread's sequence counter and a transcript
 * snapshot checkpoint. `finish` writes the terminal event(s), the run status,
 * and the final snapshot atomically before returning.
 */
class RunPersistence {
  private seq: number;
  private pending: { seq: number; json: string }[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private failed = false;
  private persisted = 0;
  private lastMessagesJson: string;

  constructor(
    private db: DatabaseSync,
    private threadId: string,
    private runId: string,
    private agentId: string,
    startSeq: number,
    messagesJson: string,
    private snapshot: () => Message[],
    private maxEventBytes: number,
    private onFailure: (error: unknown) => void,
  ) {
    this.seq = startSeq;
    this.lastMessagesJson = messagesJson;
  }

  get failedPermanently() {
    return this.failed;
  }

  get eventCount() {
    return this.persisted;
  }

  /** Assign a sequence and queue the event. Returns undefined if storage is down. */
  append(event: BaseEvent): number | undefined {
    if (this.failed) return undefined;
    let json: string;
    try {
      json = JSON.stringify(event);
    } catch {
      this.fail(new Error('Event could not be serialized.'));
      return undefined;
    }
    if (Buffer.byteLength(json, 'utf8') > this.maxEventBytes) {
      this.fail(new Error('Event payload exceeded the storage limit.'));
      return undefined;
    }
    this.seq += 1;
    const seq = this.seq;
    this.pending.push({ seq, json });
    if (this.pending.length >= FLUSH_EVENT_THRESHOLD) this.flush();
    else
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, FLUSH_INTERVAL_MS);
    return seq;
  }

  /** Persist buffered events and the transcript checkpoint. */
  flush(messages?: Message[]): boolean {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.failed) return false;
    const pending = this.pending;
    this.pending = [];
    const messagesJson = JSON.stringify(messages ?? this.snapshot());
    if (!pending.length && (!messagesJson || messagesJson === this.lastMessagesJson))
      return true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (pending.length) {
          const insert = this.db.prepare(
            'INSERT OR IGNORE INTO agent_run_events (runId, threadId, seq, event, createdAt) VALUES (?, ?, ?, ?, ?)',
          );
          const now = Date.now();
          for (const row of pending)
            insert.run(this.runId, this.threadId, row.seq, row.json, now);
        }
        this.db
          .prepare(
            'UPDATE agent_threads SET nextSeq=?, updatedAt=?, agentId=?, messages=COALESCE(?, messages) WHERE threadId=?',
          )
          .run(
            this.seq,
            Date.now(),
            this.agentId,
            messagesJson ?? null,
            this.threadId,
          );
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.persisted += pending.length;
      if (messagesJson) this.lastMessagesJson = messagesJson;
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /**
   * Atomically commit the terminal events, the run status, and the transcript.
   * Returns the terminal events that should be streamed to the client, or
   * `undefined` when persistence failed (the caller must report RUN_ERROR).
   */
  finish(input: {
    status: RunStatus;
    error?: string;
    stopRequested: boolean;
    interruptionMessage?: string;
    finalizer: ReturnType<typeof createRunEventFinalizer>;
    messages: Message[];
  }): { events: BaseEvent[]; seqs: number[]; status: RunStatus } | undefined {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const appended = input.finalizer.finalize({
      stopRequested: input.stopRequested,
      ...(input.interruptionMessage
        ? { interruptionMessage: input.interruptionMessage }
        : {}),
    });
    const terminalRows: { seq: number; json: string }[] = [];
    const terminalSeqs: number[] = [];
    const status: RunStatus = appended.some(
      (event) => event.type === EventType.RUN_ERROR,
    )
      ? 'failed'
      : input.status;
    if (!this.failed) {
      for (const event of appended) {
        const json = JSON.stringify(event);
        if (Buffer.byteLength(json, 'utf8') > this.maxEventBytes) {
          this.fail(new Error('Event payload exceeded the storage limit.'));
          break;
        }
        this.seq += 1;
        terminalRows.push({ seq: this.seq, json });
        terminalSeqs.push(this.seq);
      }
    }
    try {
      if (this.failed) throw new Error('Journal is unavailable.');
      const now = Date.now();
      const messagesJson = JSON.stringify(input.messages);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (terminalRows.length) {
          const insert = this.db.prepare(
            'INSERT OR IGNORE INTO agent_run_events (runId, threadId, seq, event, createdAt) VALUES (?, ?, ?, ?, ?)',
          );
          for (const row of terminalRows)
            insert.run(this.runId, this.threadId, row.seq, row.json, now);
        }
        if (this.pending.length) {
          const insert = this.db.prepare(
            'INSERT OR IGNORE INTO agent_run_events (runId, threadId, seq, event, createdAt) VALUES (?, ?, ?, ?, ?)',
          );
          for (const row of this.pending)
            insert.run(this.runId, this.threadId, row.seq, row.json, now);
        }
        this.db
          .prepare(
            "UPDATE agent_runs SET status=?, finishedAt=?, error=?, eventCount=? WHERE runId=?",
          )
          .run(
            status,
            now,
            input.error ?? null,
            this.persisted + this.pending.length + terminalRows.length,
            this.runId,
          );
        this.db
          .prepare(
            'UPDATE agent_threads SET nextSeq=?, messages=?, updatedAt=?, agentId=? WHERE threadId=?',
          )
          .run(this.seq, messagesJson, now, this.agentId, this.threadId);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.pending = [];
      this.persisted += terminalRows.length;
      return { events: appended, seqs: terminalSeqs, status };
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  private fail(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.pending = [];
    this.onFailure(error);
  }
}

export class SqliteAgentRunner
  extends AgentRunner
  implements LocalThreadEndpointRunner
{
  readonly ɵsupportsLocalThreadEndpoints = true;
  private readonly db: DatabaseSync;
  private readonly active = new Map<string, ActiveRun>();
  private readonly maxEventBytes: number;
  private closed = false;

  constructor(
    path: string,
    readonly ownerId: string,
    options: { maxEventBytes?: number } = {},
  ) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    migrate(this.db);
    const configured = Number(
      options.maxEventBytes ?? process.env.AGENT_MAX_EVENT_BYTES,
    );
    this.maxEventBytes =
      Number.isInteger(configured) && configured >= 1024
        ? configured
        : DEFAULT_MAX_EVENT_BYTES;
    this.recoverInterruptedRuns();
  }

  close() {
    if (this.closed) return;
    for (const [threadId, active] of this.active) {
      try {
        active.agent.abortRun();
      } catch {
        // The run may already be finalizing.
      }
      active.persistence.flush();
      try {
        this.db
          .prepare(
            "UPDATE agent_runs SET status='interrupted', finishedAt=?, error=? WHERE runId=? AND status='running'",
          )
          .run(
            Date.now(),
            'Server stopped during this run. Review completed effects before retrying.',
            active.currentRunId,
          );
      } catch {
        // Closing is best effort; committed events are already durable.
      }
      this.active.delete(threadId);
    }
    this.closed = true;
    this.db.close();
  }

  // ---------------------------------------------------------------------
  // AgentRunner
  // ---------------------------------------------------------------------

  run(request: AgentRunnerRunRequest) {
    const existing = this.active.get(request.threadId);
    if (existing?.isRunning || existing?.stopRequested)
      throw new Error('Thread already running');
    const runId = request.input.runId || randomUUID();
    this.ensureThread(request.threadId, request.agent.agentId ?? 'default');
    if (this.hasRunningRun(request.threadId))
      throw new Error('Thread already running');

    const thread = this.threadRow(request.threadId)!;
    const parentRunId =
      (
        this.db
          .prepare(
            'SELECT runId FROM agent_runs WHERE threadId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1',
          )
          .get(request.threadId) as { runId?: string } | undefined
      )?.runId ?? null;
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO agent_runs (runId, threadId, agentId, parentRunId, events, createdAt, status, startedAt, eventCount) VALUES (?, ?, ?, ?, '[]', ?, 'running', ?, 0)",
      )
      .run(
        runId,
        request.threadId,
        request.agent.agentId ?? 'default',
        parentRunId,
        now,
        now,
      );

    const historicMessageIds = new Set(
      this.parseMessages(thread.messages).map((message) => message.id),
    );
    const subject = new Subject<SeqEvent>();
    const runSubject = new Subject<BaseEvent>();
    const active: ActiveRun = {
      isRunning: true,
      stopRequested: false,
      currentRunId: runId,
      agent: request.agent,
      persistence: new RunPersistence(
        this.db,
        request.threadId,
        runId,
        request.agent.agentId ?? 'default',
        Number(thread.nextSeq ?? 0),
        thread.messages,
        () => (Array.isArray(request.agent.messages) ? [...request.agent.messages] : []),
        this.maxEventBytes,
        (error) => {
          active.runError = true;
          console.error(
            'Conversation events could not be persisted:',
            error instanceof Error ? error.name : 'Error',
          );
        },
      ),
      finalizer: createRunEventFinalizer(),
      subject,
      runSubject,
      recent: [],
      runError: false,
    };
    this.active.set(request.threadId, active);

    const emit = (seq: number, event: BaseEvent) => {
      active.recent.push({ seq, event });
      if (active.recent.length > RING_CAPACITY) active.recent.shift();
      runSubject.next(event);
      subject.next({ seq, event });
    };

    const finalize = (options: { interruptionMessage?: string }) => {
      if (active.stopTimer) {
        clearTimeout(active.stopTimer);
        active.stopTimer = undefined;
      }
      const status: RunStatus = active.stopRequested
        ? 'cancelled'
        : options.interruptionMessage !== undefined || active.runError
          ? 'failed'
          : 'completed';
      const messages = Array.isArray(request.agent.messages)
        ? [...request.agent.messages]
        : [];
      const finished = active.persistence.finish({
        status,
        ...(options.interruptionMessage !== undefined
          ? { error: options.interruptionMessage }
          : {}),
        stopRequested: active.stopRequested,
        ...(options.interruptionMessage !== undefined
          ? { interruptionMessage: options.interruptionMessage }
          : {}),
        finalizer: active.finalizer,
        messages,
      });
      const ownsThread = this.active.get(request.threadId) === active;
      if (finished) {
        finished.events.forEach((event, index) => {
          runSubject.next(event);
          const seq = finished.seqs[index] ?? 0;
          if (seq > 0) {
            active.recent.push({ seq, event });
            if (active.recent.length > RING_CAPACITY) active.recent.shift();
            subject.next({ seq, event });
          }
        });
      } else {
        console.error('Conversation run could not be saved durably.');
        try {
          this.db
            .prepare(
              "UPDATE agent_runs SET status='failed', finishedAt=?, error=? WHERE runId=?",
            )
            .run(
              Date.now(),
              'Run events could not be persisted to the local conversation store.',
              active.currentRunId,
            );
        } catch {
          // The database itself is unavailable; nothing else can be recorded.
        }
        runSubject.next({
          type: EventType.RUN_ERROR,
          message:
            'This turn could not be saved to the local conversation store. Check database access before relying on it.',
        });
      }
      if (ownsThread) {
        active.isRunning = false;
        active.stopRequested = false;
        this.active.delete(request.threadId);
      }
      runSubject.complete();
      subject.complete();
    };

    active.forceFinalize = () =>
      finalize({ interruptionMessage: 'Run stopped by user' });

    void (async () => {
      try {
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            let processed: BaseEvent = event;
            if (event.type === EventType.RUN_STARTED) {
              const started = event as BaseEvent & {
                input?: {
                  messages?: Message[];
                  [key: string]: unknown;
                };
              };
              if (!started.input) {
                const input = request.input;
                const messages = input.messages
                  ? input.messages.filter(
                      (message) => !historicMessageIds.has(message.id),
                    )
                  : undefined;
                started.input = {
                  ...input,
                  ...(messages !== undefined ? { messages } : {}),
                };
                processed = started as BaseEvent;
              }
            }
            if (processed.type === EventType.RUN_ERROR) active.runError = true;
            active.finalizer.observe(processed);
            const seq = active.persistence.append(processed);
            // Emit regardless: the client still sees the stream, but a storage
            // failure forces a RUN_ERROR terminal event at finalize.
            emit(seq ?? 0, processed);
          },
        });
        finalize({});
      } catch (error) {
        finalize({
          interruptionMessage:
            error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return runSubject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest) {
    return new Observable<BaseEvent>((subscriber) => {
      const thread = this.threadRow(request.threadId);
      if (!thread) {
        subscriber.complete();
        return;
      }
      let lastSeq = 0;
      // Bounded chunks: the persisted journal is streamed, not assembled in RAM.
      for (const entry of this.persistedEventChunks(request.threadId)) {
        lastSeq = Math.max(lastSeq, entry.seq);
        subscriber.next(entry.event);
      }
      const active = this.active.get(request.threadId);
      if (!active) {
        subscriber.complete();
        return;
      }
      for (const entry of active.recent)
        if (entry.seq > lastSeq) {
          lastSeq = entry.seq;
          subscriber.next(entry.event);
        }
      const subscription = active.subject.subscribe({
        next: (entry) => {
          if (entry.seq <= lastSeq) return;
          lastSeq = entry.seq;
          subscriber.next(entry.event);
        },
        complete: () => subscriber.complete(),
        error: (error) => subscriber.error(error),
      });
      return () => subscription.unsubscribe();
    });
  }

  async isRunning(request: AgentRunnerIsRunningRequest) {
    const active = this.active.get(request.threadId);
    if (active) return active.isRunning && !active.stopRequested;
    return this.hasRunningRun(request.threadId);
  }

  async stop(request: AgentRunnerStopRequest) {
    const active = this.active.get(request.threadId);
    if (!active?.isRunning) return false;
    if (request.runId !== undefined && active.currentRunId !== request.runId)
      return false;
    if (active.stopRequested) return false;
    active.stopRequested = true;
    try {
      active.agent.abortRun();
      // Abort should make the agent's stream settle. A run that ignores the
      // abort is force-finalized so it cannot hold the thread forever.
      active.stopTimer ??= setTimeout(() => {
        if (this.active.get(request.threadId) === active)
          active.forceFinalize?.();
      }, 2_500);
      active.stopTimer.unref?.();
      return true;
    } catch {
      active.stopRequested = false;
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // LocalThreadEndpointRunner
  // ---------------------------------------------------------------------

  listThreads(): LocalThreadEndpointRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_threads ORDER BY updatedAt DESC')
      .all() as unknown as ThreadRow[];
    return rows.map((row) => ({
      id: row.threadId,
      name: row.name,
      agentId: row.agentId,
      organizationId: '',
      createdById: '',
      archived: false,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  }

  getThreadMessages(threadId: string): Message[] {
    return this.parseMessages(this.threadRow(threadId)?.messages);
  }

  /** Full compacted event history. The runtime interface requires an array. */
  getThreadEvents(threadId: string): BaseEvent[] {
    const all: BaseEvent[] = [];
    for (const entry of this.persistedEventChunks(threadId))
      all.push(entry.event);
    return all.length ? compactEvents(all) : [];
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.getThreadEvents(threadId);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.type === EventType.STATE_SNAPSHOT) {
        const snapshot = (event as { snapshot?: unknown }).snapshot;
        if (
          snapshot &&
          typeof snapshot === 'object' &&
          !Array.isArray(snapshot)
        )
          return { ...(snapshot as Record<string, unknown>) };
        return null;
      }
    }
    return null;
  }

  clearThreads(): void {
    this.db.exec(
      'DELETE FROM agent_run_events; DELETE FROM agent_runs; DELETE FROM agent_threads;',
    );
  }

  // ---------------------------------------------------------------------
  // OpenDots helpers
  // ---------------------------------------------------------------------

  /** Threads known to the local store, newest first. */
  threads(): AgentThreadSummary[] {
    return (
      this.db
        .prepare('SELECT * FROM agent_threads ORDER BY updatedAt DESC')
        .all() as unknown as ThreadRow[]
    ).map((row) => ({
      threadId: row.threadId,
      agentId: row.agentId,
      name: row.name,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: this.parseMessages(row.messages).length,
    }));
  }

  hasThread(threadId: string): boolean {
    return !!this.threadRow(threadId);
  }

  runStatus(threadId: string): AgentRunSummary | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM agent_runs WHERE threadId=? ORDER BY startedAt DESC, rowid DESC LIMIT 1',
      )
      .get(threadId) as unknown as RunRow | undefined;
    return row
      ? {
          runId: row.runId,
          threadId: row.threadId,
          status: row.status as RunStatus,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          error: row.error,
          eventCount: row.eventCount,
        }
      : undefined;
  }

  /** Number of events buffered in memory for a live thread (bounded). */
  bufferedEventCount(threadId: string): number {
    return this.active.get(threadId)?.recent.length ?? 0;
  }

  /** Number of durable journal rows for a thread. */
  durableEventCount(threadId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM agent_run_events WHERE threadId=?')
      .get(threadId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  /** Register a thread before any run (used when the owner starts a chat). */
  registerThread(threadId: string, agentId: string, name: string): void {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO agent_threads (threadId, agentId, name, createdAt, updatedAt, messages) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(threadId) DO UPDATE SET name=excluded.name, agentId=excluded.agentId',
      )
      .run(threadId, agentId, name, now, now, '[]');
  }

  threadName(threadId: string): string | null {
    return this.threadRow(threadId)?.name ?? null;
  }

  renameThread(threadId: string, name: string): void {
    this.ensureThread(threadId, 'default');
    this.db
      .prepare('UPDATE agent_threads SET name=?, updatedAt=? WHERE threadId=?')
      .run(name, Date.now(), threadId);
  }

  deleteThread(threadId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('DELETE FROM agent_run_events WHERE threadId=?')
        .run(threadId);
      this.db.prepare('DELETE FROM agent_runs WHERE threadId=?').run(threadId);
      this.db
        .prepare('DELETE FROM agent_threads WHERE threadId=?')
        .run(threadId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Last `limit` displayable messages, newest last. */
  recentMessages(threadId: string, limit = 12): Message[] {
    const messages = this.getThreadMessages(threadId);
    return messages.slice(-limit);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private recoverInterruptedRuns() {
    this.db
      .prepare(
        "UPDATE agent_runs SET status='interrupted', finishedAt=?, error=? WHERE status='running'",
      )
      .run(
        Date.now(),
        'Server stopped during this run. Review completed effects before retrying.',
      );
  }

  private hasRunningRun(threadId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM agent_runs WHERE threadId=? AND status='running'")
      .get(threadId);
  }

  private ensureThread(threadId: string, agentId: string) {
    if (!threadId) throw new Error('A threadId is required.');
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO agent_threads (threadId, agentId, name, createdAt, updatedAt, messages) VALUES (?, ?, NULL, ?, ?, ?) ON CONFLICT(threadId) DO NOTHING',
      )
      .run(threadId, agentId, now, now, '[]');
  }

  private threadRow(threadId: string): ThreadRow | undefined {
    return this.db
      .prepare('SELECT * FROM agent_threads WHERE threadId=?')
      .get(threadId) as unknown as ThreadRow | undefined;
  }

  private parseMessages(value: string | undefined): Message[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as Message[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Yield persisted events in chronological order, reading the journal in
   * bounded chunks. Runs from the previous schema (compacted `events` JSON) are
   * still replayed so upgrades keep existing conversations.
   */
  private *persistedEventChunks(
    threadId: string,
  ): Generator<{ seq: number; event: BaseEvent }> {
    const runs = this.db
      .prepare(
        'SELECT runId, events, createdAt FROM agent_runs WHERE threadId=? ORDER BY createdAt ASC, rowid ASC',
      )
      .all(threadId) as unknown as {
      runId: string;
      events: string;
      createdAt: number;
    }[];
    for (const run of runs) {
      let lastSeq = 0;
      for (;;) {
        const rows = this.db
          .prepare(
            'SELECT seq, event FROM agent_run_events WHERE runId=? AND seq>? ORDER BY seq LIMIT ?',
          )
          .all(run.runId, lastSeq, REPLAY_CHUNK) as unknown as {
          seq: number;
          event: string;
        }[];
        if (!rows.length) break;
        for (const row of rows) {
          lastSeq = Number(row.seq);
          try {
            yield { seq: lastSeq, event: JSON.parse(row.event) as BaseEvent };
          } catch {
            // A corrupt journal row is skipped rather than breaking replay.
          }
        }
        if (rows.length < REPLAY_CHUNK) break;
      }
      if (lastSeq === 0 && run.events) {
        try {
          const parsed = JSON.parse(run.events) as unknown;
          if (Array.isArray(parsed))
            for (const event of parsed as BaseEvent[])
              yield { seq: 0, event };
        } catch {
          // Legacy row unreadable; ignore it.
        }
      }
    }
  }
}
