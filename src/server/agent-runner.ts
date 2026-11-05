import { EventType, type BaseEvent, type Message } from '@ag-ui/core';
import { compactEvents, type AbstractAgent } from '@ag-ui/client';
import {
  AgentRunner,
  finalizeRunEvents,
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
import { ReplaySubject } from 'rxjs';
import { migrate } from './db.js';

/**
 * Durable, SQLite-backed AG-UI agent runner.
 *
 * This replaces CopilotKit Intelligence thread storage with local tables
 * (`agent_threads`, `agent_runs`) in the existing OpenDots database. It
 * implements the runtime's `LocalThreadEndpointRunner` contract, so the stock
 * CopilotKit client keeps working for:
 *
 *   - `GET  /api/copilotkit/threads`                (thread list)
 *   - `GET  /api/copilotkit/threads/:id/messages`   (transcript)
 *   - `GET  /api/copilotkit/threads/:id/events`     (replay)
 *   - `POST /api/copilotkit/agent/:id/connect`      (rehydration)
 *
 * Runs are appended transactionally when they finish, so a crash never leaves a
 * half-saved turn. A run interrupted by process exit is not written at all; the
 * previous completed snapshot stays authoritative. There is no retention limit
 * or expiry: history is kept until the owner deletes it.
 */
interface ActiveRun {
  isRunning: boolean;
  stopRequested: boolean;
  currentRunId: string | null;
  agent: AbstractAgent | null;
  subject: ReplaySubject<BaseEvent> | null;
  runSubject: ReplaySubject<BaseEvent> | null;
  finalize: { stopRequested: boolean } | null;
}

interface ThreadRow {
  threadId: string;
  agentId: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  messages: string;
}

interface RunRow {
  runId: string;
  threadId: string;
  agentId: string;
  parentRunId: string | null;
  events: string;
  createdAt: number;
}

export interface AgentThreadSummary {
  threadId: string;
  agentId: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export class SqliteAgentRunner
  extends AgentRunner
  implements LocalThreadEndpointRunner
{
  readonly ɵsupportsLocalThreadEndpoints = true;
  private readonly db: DatabaseSync;
  private readonly active = new Map<string, ActiveRun>();
  private closed = false;

  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    migrate(this.db);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const threadId of [...this.active.keys()]) this.stopRun(threadId);
    this.db.close();
  }

  // ---------------------------------------------------------------------
  // AgentRunner
  // ---------------------------------------------------------------------

  run(request: AgentRunnerRunRequest) {
    const existing = this.active.get(request.threadId);
    if (existing?.isRunning || existing?.stopRequested)
      throw new Error('Thread already running');
    const active: ActiveRun = {
      isRunning: true,
      stopRequested: false,
      currentRunId: request.input.runId,
      agent: request.agent,
      subject: new ReplaySubject<BaseEvent>(Infinity),
      runSubject: new ReplaySubject<BaseEvent>(Infinity),
      finalize: { stopRequested: false },
    };
    this.active.set(request.threadId, active);
    const subject = active.subject!;
    const runSubject = active.runSubject!;
    this.ensureThread(request.threadId, request.agent.agentId ?? 'default');

    const previous = this.threadRow(request.threadId);
    const historicMessageIds = new Set(
      this.parseMessages(previous?.messages).map((message) => message.id),
    );
    const seenMessageIds = new Set<string>();
    const events: BaseEvent[] = [];
    const parentRunId =
      (
        this.db
          .prepare(
            'SELECT runId FROM agent_runs WHERE threadId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1',
          )
          .get(request.threadId) as { runId?: string } | undefined
      )?.runId ?? null;

    const finalize = (options: { interruptionMessage?: string }) => {
      const isError = options.interruptionMessage !== undefined;
      const countBefore = events.length;
      const appended = finalizeRunEvents(events, {
        stopRequested: active.finalize?.stopRequested ?? false,
        ...(isError
          ? { interruptionMessage: options.interruptionMessage }
          : {}),
      });
      for (const event of appended) {
        runSubject.next(event);
        subject.next(event);
      }
      const ownsThread = active.currentRunId === request.input.runId;
      if (ownsThread && (!isError || countBefore > 0) && !this.closed) {
        const snapshot = Array.isArray(request.agent.messages)
          ? [...request.agent.messages]
          : [];
        try {
          this.persistRun({
            threadId: request.threadId,
            runId: request.input.runId,
            agentId: request.agent.agentId ?? 'default',
            parentRunId,
            events,
            messages: snapshot,
          });
        } catch (error) {
          // The run is over; a storage failure must not become an unhandled
          // rejection after shutdown. Details are logged by class only.
          console.error(
            'Conversation run could not be saved:',
            error instanceof Error ? error.name : 'Error',
          );
        }
      }
      if (ownsThread) {
        active.currentRunId = null;
        active.agent = null;
        active.runSubject = null;
        active.stopRequested = false;
        active.isRunning = false;
        active.finalize = null;
      }
      runSubject.complete();
      subject.complete();
      if (this.active.get(request.threadId) === active) active.subject = null;
    };

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
            runSubject.next(processed);
            subject.next(processed);
            events.push(processed);
          },
          onNewMessage: ({ message }) => {
            seenMessageIds.add(message.id);
          },
          onRunStartedEvent: () => {
            for (const message of request.input.messages ?? [])
              seenMessageIds.add(message.id);
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
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const thread = this.threadRow(request.threadId);
    if (!thread) {
      subject.complete();
      return subject.asObservable();
    }
    const compacted = this.compactedEvents(request.threadId);
    const emitted = new Set<string>();
    for (const event of compacted) {
      subject.next(event);
      if ('messageId' in event && typeof event.messageId === 'string')
        emitted.add(event.messageId);
    }
    const active = this.active.get(request.threadId);
    if (active?.subject && active.isRunning) {
      active.subject.subscribe({
        next: (event) => {
          if (
            'messageId' in event &&
            typeof event.messageId === 'string' &&
            emitted.has(event.messageId)
          )
            return;
          subject.next(event);
        },
        complete: () => subject.complete(),
        error: (error) => subject.error(error),
      });
    } else subject.complete();
    return subject.asObservable();
  }

  async isRunning(request: AgentRunnerIsRunningRequest) {
    return this.active.get(request.threadId)?.isRunning ?? false;
  }

  async stop(request: AgentRunnerStopRequest) {
    const active = this.active.get(request.threadId);
    if (!active?.isRunning) return false;
    if (request.runId !== undefined && active.currentRunId !== request.runId)
      return false;
    if (active.stopRequested) return false;
    active.stopRequested = true;
    active.isRunning = false;
    if (active.finalize) active.finalize.stopRequested = true;
    const agent = active.agent;
    if (!agent) {
      active.stopRequested = false;
      active.isRunning = true;
      if (active.finalize) active.finalize.stopRequested = false;
      return false;
    }
    try {
      agent.abortRun();
      return true;
    } catch {
      active.stopRequested = false;
      active.isRunning = true;
      if (active.finalize) active.finalize.stopRequested = false;
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

  getThreadEvents(threadId: string): BaseEvent[] {
    return this.compactedEvents(threadId);
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
    this.db.exec('DELETE FROM agent_runs; DELETE FROM agent_threads;');
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

  private toRecord(event: BaseEvent): Record<string, unknown> {
    return event as unknown as Record<string, unknown>;
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

  private runRows(threadId: string): RunRow[] {
    return this.db
      .prepare(
        'SELECT * FROM agent_runs WHERE threadId=? ORDER BY createdAt ASC, rowid ASC',
      )
      .all(threadId) as unknown as RunRow[];
  }

  private compactedEvents(threadId: string): BaseEvent[] {
    const all: BaseEvent[] = [];
    for (const row of this.runRows(threadId)) {
      try {
        const parsed = JSON.parse(row.events) as unknown;
        if (Array.isArray(parsed)) all.push(...(parsed as BaseEvent[]));
      } catch {
        // A corrupt row is skipped rather than breaking every future replay.
      }
    }
    return all.length ? compactEvents(all) : [];
  }

  private persistRun(input: {
    threadId: string;
    runId: string;
    agentId: string;
    parentRunId: string | null;
    events: BaseEvent[];
    messages: Message[];
  }) {
    if (this.closed) return;
    const compacted = compactEvents(input.events);
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureThread(input.threadId, input.agentId);
      this.db
        .prepare(
          'INSERT INTO agent_runs (runId, threadId, agentId, parentRunId, events, createdAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(runId) DO NOTHING',
        )
        .run(
          input.runId || randomUUID(),
          input.threadId,
          input.agentId,
          input.parentRunId,
          JSON.stringify(compacted.map((event) => this.toRecord(event))),
          now,
        );
      if (input.messages.length) {
        this.db
          .prepare(
            'UPDATE agent_threads SET messages=?, updatedAt=?, agentId=? WHERE threadId=?',
          )
          .run(
            JSON.stringify(input.messages),
            now,
            input.agentId,
            input.threadId,
          );
      } else {
        this.db
          .prepare(
            'UPDATE agent_threads SET updatedAt=?, agentId=? WHERE threadId=?',
          )
          .run(now, input.agentId, input.threadId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private stopRun(threadId: string) {
    const active = this.active.get(threadId);
    if (!active) return;
    try {
      active.agent?.abortRun();
    } catch {
      // The run is already finalizing; nothing else to release.
    }
    active.isRunning = false;
    active.stopRequested = false;
    this.active.delete(threadId);
  }
}
