import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { afterEach, expect, it } from 'vitest';
import { SqliteAgentRunner } from '../src/server/agent-runner.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-edge-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'opendots.sqlite');
}

function runnerFor(
  path: string,
  options: { stopFinalizeMs?: number; maxThreadEvents?: number } = {},
) {
  const runner = new SqliteAgentRunner(path, 'owner', options);
  resources.push(() => runner.close());
  return runner;
}

function inputFor(
  threadId: string,
  agent: AbstractAgent,
  runId = `run-${Math.random().toString(36).slice(2)}`,
): RunAgentInput {
  agent.setMessages([
    { id: `user-${runId}`, role: 'user', content: 'Question' },
  ]);
  return {
    threadId,
    runId,
    state: {},
    context: [],
    messages: agent.messages,
    tools: [],
    forwardedProps: {},
  };
}

function execute(
  runner: SqliteAgentRunner,
  agent: AbstractAgent,
  threadId: string,
  events: BaseEvent[] = [],
) {
  const input = inputFor(threadId, agent);
  return new Promise<BaseEvent[]>((resolve, reject) => {
    runner.run({ threadId, agent, input }).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

class ScriptedAgent extends AbstractAgent {
  constructor(private script: (input: RunAgentInput) => BaseEvent[]) {
    super({ agentId: 'dot-edge' });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      for (const event of this.script(input)) subscriber.next(event);
      subscriber.complete();
    });
  }
}

/**
 * Emits a start event immediately, then waits for `late` before emitting more
 * events, and deliberately ignores abort so a forced finalization can race the
 * original completion (the edge case under test).
 */
class AbortIgnoringAgent extends AbstractAgent {
  constructor(private late: Promise<BaseEvent[]>) {
    super({ agentId: 'dot-edge' });
  }
  abortRun(): void {
    // Intentionally ignore: simulates a provider that does not settle promptly.
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      void this.late.then((events) => {
        for (const event of events) subscriber.next(event);
        subscriber.complete();
      });
    });
  }
}

function completionEvents(inputThreadId: string, text: string): BaseEvent[] {
  return [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'late',
      role: 'assistant',
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'late', delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'late' },
    {
      type: EventType.RUN_FINISHED,
      threadId: inputThreadId,
      runId: 'late-run',
    },
  ] as BaseEvent[];
}

it('finalizes once when a forced stop is followed by the original completion', async () => {
  const path = tempPath();
  const runner = runnerFor(path, { stopFinalizeMs: 25 });
  const threadId = 'thread-race';
  const gate = deferred<BaseEvent[]>();
  const agent = new AbortIgnoringAgent(gate.promise);
  const received: BaseEvent[] = [];
  const finished = new Promise<void>((resolve, reject) =>
    runner
      .run({
        threadId,
        agent,
        input: inputFor(threadId, agent, 'run-race'),
      })
      .subscribe({
        next: (event) => {
          received.push(event);
        },
        error: reject,
        complete: resolve,
      }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(await runner.stop({ threadId })).toBe(true);
  expect(await runner.stop({ threadId })).toBe(false);
  await finished;
  const afterStop = runner.runStatus(threadId)!;
  expect(afterStop.status).toBe('cancelled');
  const durableAfterStop = runner.durableEventCount(threadId);
  const terminalIndex = received.findIndex(
    (event) => event.type === EventType.RUN_FINISHED,
  );
  expect(terminalIndex).toBeGreaterThanOrEqual(0);
  expect(received.slice(terminalIndex + 1)).toHaveLength(0);

  // The original agent eventually resolves and tries to emit a full completion.
  gate.resolve(completionEvents(threadId, 'late text'));
  await new Promise((resolve) => setTimeout(resolve, 80));

  const afterLate = runner.runStatus(threadId)!;
  expect(afterLate.status).toBe('cancelled');
  expect(afterLate.finishedAt).toBe(afterStop.finishedAt);
  expect(afterLate.eventCount).toBe(afterStop.eventCount);
  expect(runner.durableEventCount(threadId)).toBe(durableAfterStop);
  expect(
    runner
      .getThreadEvents(threadId)
      .some(
        (event) =>
          event.type === EventType.TEXT_MESSAGE_CONTENT &&
          (event as unknown as { delta: string }).delta.includes('late text'),
      ),
  ).toBe(false);
  expect(
    received.filter((event) => event.type === EventType.RUN_FINISHED),
  ).toHaveLength(1);
  expect(
    received.filter((event) => event.type === EventType.RUN_ERROR),
  ).toHaveLength(0);

  // A later run on the same thread does not rewrite the cancelled run's status.
  await execute(
    runner,
    new ScriptedAgent((input) => [
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ]),
    threadId,
  );
  expect(runner.runStatus(threadId)?.status).toBe('completed');
  const db = new DatabaseSync(path);
  try {
    const original = db
      .prepare('SELECT status FROM agent_runs WHERE runId=?')
      .get('run-race') as { status: string };
    expect(original.status).toBe('cancelled');
  } finally {
    db.close();
  }
});

it('does not let a late resolution overwrite an interrupted run after shutdown', async () => {
  const path = tempPath();
  const runner = runnerFor(path, { stopFinalizeMs: 60_000 });
  const threadId = 'thread-close';
  const gate = deferred<BaseEvent[]>();
  const agent = new AbortIgnoringAgent(gate.promise);
  runner
    .run({
      threadId,
      agent,
      input: inputFor(threadId, agent, 'run-close'),
    })
    .subscribe({ error: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  runner.close();

  gate.resolve(completionEvents(threadId, 'too late'));
  await new Promise((resolve) => setTimeout(resolve, 80));

  const reopened = runnerFor(path);
  expect(reopened.runStatus(threadId)).toMatchObject({
    status: 'interrupted',
    error: expect.stringContaining('Server stopped'),
  });
});

it('bounds getThreadEvents while connect still replays the full journal', async () => {
  const runner = runnerFor(tempPath(), { maxThreadEvents: 8 });
  const threadId = 'thread-bounded-events';
  const total = 30;
  const agent = new ScriptedAgent(
    (input) =>
      [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: 'a',
          role: 'assistant',
        },
        ...Array.from({ length: total }, (_, index) => ({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'a',
          delta: `${index},`,
        })),
        { type: EventType.TEXT_MESSAGE_END, messageId: 'a' },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ] as BaseEvent[],
  );
  await execute(runner, agent, threadId);

  expect(runner.durableEventCount(threadId)).toBe(total + 4);
  const events = runner.getThreadEvents(threadId);
  expect(events[0]).toMatchObject({
    type: EventType.CUSTOM,
    name: 'opendots.history_truncated',
    value: { totalEvents: total + 4 },
  });
  expect(events.length).toBeLessThanOrEqual(1 + 8);

  // Persistent history is intact: connect replays every delta exactly once.
  const received: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    runner.connect({ threadId }).subscribe({
      next: (event) => {
        received.push(event);
      },
      error: reject,
      complete: resolve,
    }),
  );
  const text = received
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => (event as unknown as { delta: string }).delta)
    .join('');
  expect(text).toBe(
    Array.from({ length: total }, (_, index) => `${index},`).join(''),
  );
});

it('returns the latest state snapshot without materializing the whole thread', async () => {
  const runner = runnerFor(tempPath(), { maxThreadEvents: 5 });
  const threadId = 'thread-state';
  const agent = new ScriptedAgent(
    (input) =>
      [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        { type: EventType.STATE_SNAPSHOT, snapshot: { phase: 'old' } },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: 'state',
          role: 'assistant',
        },
        ...Array.from({ length: 20 }, (_, index) => ({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'state',
          delta: `${index},`,
        })),
        { type: EventType.TEXT_MESSAGE_END, messageId: 'state' },
        { type: EventType.STATE_SNAPSHOT, snapshot: { phase: 'new' } },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ] as BaseEvent[],
  );
  await execute(runner, agent, threadId);
  expect(runner.getThreadState(threadId)).toEqual({ phase: 'new' });

  const underLimit = runnerFor(tempPath(), { maxThreadEvents: 100 });
  const smallThread = 'thread-state-small';
  await execute(
    underLimit,
    new ScriptedAgent(
      (input) =>
        [
          {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          },
          { type: EventType.STATE_SNAPSHOT, snapshot: { phase: 'only' } },
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          },
        ] as BaseEvent[],
    ),
    smallThread,
  );
  expect(underLimit.getThreadState(smallThread)).toEqual({ phase: 'only' });
  expect(
    underLimit
      .getThreadEvents(smallThread)
      .some((event) => event.type === EventType.CUSTOM),
  ).toBe(false);
});
