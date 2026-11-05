import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { afterEach, expect, it } from 'vitest';
import { SqliteAgentRunner } from '../src/server/agent-runner.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

class ScriptedAgent extends AbstractAgent {
  constructor(private script: (input: RunAgentInput) => BaseEvent[]) {
    super({ agentId: 'dot-fixture' });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      for (const event of this.script(input)) subscriber.next(event);
      subscriber.complete();
    });
  }
}

function textTurn(input: RunAgentInput, text: string): BaseEvent[] {
  const messageId = `assistant-${input.runId}`;
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: 'assistant',
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId },
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    },
  ];
}

function execute(
  runner: SqliteAgentRunner,
  agent: AbstractAgent,
  threadId: string,
  messages: RunAgentInput['messages'],
) {
  agent.setMessages(messages);
  const input: RunAgentInput = {
    threadId,
    runId: `run-${Math.random().toString(36).slice(2)}`,
    state: {},
    context: [],
    messages,
    tools: [],
    forwardedProps: {},
  };
  const events: BaseEvent[] = [];
  return new Promise<BaseEvent[]>((resolve, reject) => {
    runner.run({ threadId, agent, input }).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

function fixture(path: string) {
  const runner = new SqliteAgentRunner(path, 'owner');
  resources.push(() => runner.close());
  return runner;
}

it('persists messages and replayable events across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'opendots.sqlite');
  const runner = fixture(path);
  const threadId = '11111111-1111-4111-8111-111111111111';
  runner.registerThread(threadId, 'dot-fixture', 'A conversation');

  await execute(
    runner,
    new ScriptedAgent((input) => textTurn(input, 'First')),
    threadId,
    [{ id: 'user-1', role: 'user', content: 'Hello' }],
  );
  await execute(
    runner,
    new ScriptedAgent((input) => textTurn(input, 'Second')),
    threadId,
    [
      { id: 'user-1', role: 'user', content: 'Hello' },
      { id: 'assistant-1', role: 'assistant', content: 'First' },
      { id: 'user-2', role: 'user', content: 'Again' },
    ],
  );

  expect(
    runner.getThreadMessages(threadId).map((message) => message.role),
  ).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(runner.listThreads()[0]).toMatchObject({
    id: threadId,
    agentId: 'dot-fixture',
    name: 'A conversation',
  });

  const replayed = runner.getThreadEvents(threadId);
  expect(replayed.some((event) => event.type === EventType.RUN_FINISHED)).toBe(
    true,
  );

  runner.close();
  const restarted = fixture(path);
  expect(restarted.getThreadMessages(threadId)).toHaveLength(4);
  expect(restarted.getThreadEvents(threadId).length).toBeGreaterThan(0);
  expect(restarted.getThreadState(threadId)).toBeNull();
  expect(await restarted.isRunning({ threadId })).toBe(false);

  const connection: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    restarted.connect({ threadId, agentId: 'dot-fixture' }).subscribe({
      next: (event) => connection.push(event),
      error: reject,
      complete: resolve,
    }),
  );
  expect(connection.some((event) => event.type === EventType.RUN_STARTED)).toBe(
    true,
  );
  expect(
    connection.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
  ).toBe(true);
});

it('stores only new input messages per run and keeps the thread transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'opendots.sqlite');
  const runner = fixture(path);
  const threadId = 'thread-input';
  runner.registerThread(threadId, 'dot-fixture', 'Inputs');
  await execute(
    runner,
    new ScriptedAgent((input) => textTurn(input, 'One')),
    threadId,
    [{ id: 'user-1', role: 'user', content: 'Hello' }],
  );
  const stored = runner.getThreadMessages(threadId);
  expect(stored.map((message) => message.role)).toEqual(['user', 'assistant']);
  await execute(
    runner,
    new ScriptedAgent((input) => textTurn(input, 'Two')),
    threadId,
    [...stored, { id: 'user-2', role: 'user', content: 'Again' }],
  );
  const inputs = runner
    .getThreadEvents(threadId)
    .filter((event) => event.type === EventType.RUN_STARTED)
    .map(
      (event) =>
        (event as { input?: { messages?: { id: string }[] } }).input
          ?.messages ?? [],
    );
  expect(inputs[0].map((message) => message.id)).toEqual(['user-1']);
  expect(inputs[1].map((message) => message.id)).toEqual(['user-2']);
});

it('records a stop as a finished, non-running thread with its partial events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const runner = fixture(join(dir, 'opendots.sqlite'));
  const threadId = 'thread-stop';
  runner.registerThread(threadId, 'dot-fixture', 'Stop');
  class HangingAgent extends AbstractAgent {
    constructor() {
      super({ agentId: 'dot-fixture' });
    }
    run(): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: 'thread-stop',
          runId: 'run-stop',
        });
      });
    }
  }
  const agent = new HangingAgent();
  agent.setMessages([{ id: 'user-1', role: 'user', content: 'Hang' }]);
  const input: RunAgentInput = {
    threadId,
    runId: 'run-stop',
    state: {},
    context: [],
    messages: agent.messages,
    tools: [],
    forwardedProps: {},
  };
  runner.run({ threadId, agent, input }).subscribe({ error: () => {} });
  expect(await runner.isRunning({ threadId })).toBe(true);
  expect(await runner.stop({ threadId, runId: 'run-stop' })).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await runner.isRunning({ threadId })).toBe(false);
});

it('keeps history when the owner clears every thread explicitly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const runner = fixture(join(dir, 'opendots.sqlite'));
  runner.registerThread('a', 'dot-fixture', 'A');
  expect(runner.listThreads()).toHaveLength(1);
  runner.clearThreads();
  expect(runner.listThreads()).toHaveLength(0);
  expect(runner.getThreadMessages('a')).toEqual([]);
});

class GatedAgent extends AbstractAgent {
  constructor(
    private script: (input: RunAgentInput) => BaseEvent[],
    private gate: Promise<void>,
  ) {
    super({ agentId: 'dot-fixture' });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      for (const event of this.script(input)) subscriber.next(event);
      void this.gate.then(() => subscriber.complete());
    });
  }
}

function streamScript(input: RunAgentInput, count: number): BaseEvent[] {
  const events: BaseEvent[] = [
    { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
    { type: EventType.TEXT_MESSAGE_START, messageId: 'assistant-stream', role: 'assistant' },
  ];
  for (let index = 0; index < count; index++)
    events.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'assistant-stream',
      delta: `${index},`,
    });
  events.push({ type: EventType.TEXT_MESSAGE_END, messageId: 'assistant-stream' });
  events.push({
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent);
  return events;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('persists events incrementally while the run is still streaming', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-incremental-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const runner = fixture(join(dir, 'opendots.sqlite'));
  const gate = deferred();
  const threadId = 'thread-incremental';
  const agent = new GatedAgent((input) => streamScript(input, 80), gate.promise);
  agent.setMessages([{ id: 'user-1', role: 'user', content: 'Stream' }]);
  const input: RunAgentInput = {
    threadId,
    runId: 'run-incremental',
    state: {},
    context: [],
    messages: agent.messages,
    tools: [],
    forwardedProps: {},
  };
  const events: BaseEvent[] = [];
  const finished = new Promise<void>((resolve, reject) =>
    runner.run({ threadId, agent, input }).subscribe({
      next: (event) => {
        events.push(event);
      },
      error: reject,
      complete: resolve,
    }),
  );

  // 80 events exceed the flush threshold, so they are durable before the run ends.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(runner.runStatus(threadId)?.status).toBe('running');
  const persisted = runner.getThreadEvents(threadId);
  expect(persisted.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).length).toBeGreaterThan(0);
  expect(runner.getThreadMessages(threadId).some((message) => message.role === 'user')).toBe(true);

  gate.resolve();
  await finished;
  expect(runner.runStatus(threadId)).toMatchObject({
    status: 'completed',
    eventCount: expect.any(Number),
  });
  expect(runner.runStatus(threadId)!.eventCount).toBeGreaterThanOrEqual(83);
});

it('marks an unfinished run interrupted on restart and keeps committed events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-recover-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'opendots.sqlite');
  let runner = fixture(path);
  const gate = deferred();
  const threadId = 'thread-recover';
  const agent = new GatedAgent((input) => streamScript(input, 70), gate.promise);
  agent.setMessages([{ id: 'user-1', role: 'user', content: 'Recoverable' }]);
  runner
    .run({
      threadId,
      agent,
      input: {
        threadId,
        runId: 'run-recover',
        state: {},
        context: [],
        messages: agent.messages,
        tools: [],
        forwardedProps: {},
      },
    })
    .subscribe({ error: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(runner.runStatus(threadId)?.status).toBe('running');
  const committed = runner.getThreadEvents(threadId).length;
  expect(committed).toBeGreaterThan(0);

  runner.close();
  runner = fixture(path);
  expect(runner.runStatus(threadId)).toMatchObject({
    status: 'interrupted',
    error: expect.stringContaining('Server stopped'),
  });
  expect(runner.getThreadEvents(threadId).length).toBeGreaterThanOrEqual(committed);
  expect(await runner.isRunning({ threadId })).toBe(false);
  gate.resolve();
});

it('keeps the in-memory streaming buffer bounded for long runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-bounded-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const runner = fixture(join(dir, 'opendots.sqlite'));
  const gate = deferred();
  const threadId = 'thread-bounded';
  const agent = new GatedAgent((input) => streamScript(input, 5_000), gate.promise);
  agent.setMessages([{ id: 'user-1', role: 'user', content: 'Long' }]);
  runner
    .run({
      threadId,
      agent,
      input: {
        threadId,
        runId: 'run-bounded',
        state: {},
        context: [],
        messages: agent.messages,
        tools: [],
        forwardedProps: {},
      },
    })
    .subscribe({ error: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(runner.bufferedEventCount(threadId)).toBeGreaterThan(0);
  expect(runner.bufferedEventCount(threadId)).toBeLessThanOrEqual(512);
  // The full journal still holds every event; only the live buffer is bounded.
  expect(runner.durableEventCount(threadId)).toBeGreaterThan(400);

  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(runner.runStatus(threadId)?.status).toBe('completed');
});

it('preserves event order across persistence flushes and replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-order-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const runner = fixture(join(dir, 'opendots.sqlite'));
  const threadId = 'thread-order';
  await execute(runner, new ScriptedAgent((input) => streamScript(input, 40)), threadId, [
    { id: 'user-1', role: 'user', content: 'Order' },
  ]);
  const text = runner
    .getThreadEvents(threadId)
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => (event as unknown as { delta: string }).delta)
    .join('');
  expect(text).toBe(
    Array.from({ length: 40 }, (_, index) => `${index},`).join(''),
  );
});

it('rejects a concurrent run on the same thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-concurrent-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const runner = fixture(join(dir, 'opendots.sqlite'));
  const gate = deferred();
  const threadId = 'thread-concurrent';
  const make = () => {
    const agent = new GatedAgent((input) => streamScript(input, 5), gate.promise);
    agent.setMessages([{ id: 'user-1', role: 'user', content: 'One' }]);
    return {
      agent,
      input: {
        threadId,
        runId: `run-${Math.random().toString(36).slice(2)}`,
        state: {},
        context: [],
        messages: agent.messages,
        tools: [],
        forwardedProps: {},
      } as RunAgentInput,
    };
  };
  const first = make();
  runner.run({ threadId, agent: first.agent, input: first.input }).subscribe({
    error: () => {},
  });
  const second = make();
  expect(() =>
    runner.run({ threadId, agent: second.agent, input: second.input }),
  ).toThrow(/already running/);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(runner.runStatus(threadId)?.status).toBe('completed');
});

it('fails a run instead of reporting success when an event exceeds the storage limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-limit-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const runner = new SqliteAgentRunner(join(dir, 'opendots.sqlite'), 'owner', {
    maxEventBytes: 2_048,
  });
  resources.push(() => runner.close());
  const threadId = 'thread-limit';
  const agent = new ScriptedAgent((input) => [
    { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'big',
      role: 'assistant',
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'big',
      delta: 'x'.repeat(4_096),
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'big' },
  ]);
  const events = await execute(runner, agent, threadId, [
    { id: 'user-1', role: 'user', content: 'Too big' },
  ]);
  expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(true);
  expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
  expect(runner.runStatus(threadId)?.status).toBe('failed');
});

it('reconnects to a live run without duplicates and finishes from the live stream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-connect-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const runner = fixture(join(dir, 'opendots.sqlite'));
  const gate = deferred();
  const threadId = 'thread-connect';
  const agent = new GatedAgent((input) => streamScript(input, 120), gate.promise);
  agent.setMessages([{ id: 'user-1', role: 'user', content: 'Reconnect' }]);
  runner
    .run({
      threadId,
      agent,
      input: {
        threadId,
        runId: 'run-connect',
        state: {},
        context: [],
        messages: agent.messages,
        tools: [],
        forwardedProps: {},
      },
    })
    .subscribe({ error: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const persistedBefore = runner.durableEventCount(threadId);
  expect(persistedBefore).toBeGreaterThan(0);

  const received: BaseEvent[] = [];
  const connected = new Promise<void>((resolve, reject) =>
    runner.connect({ threadId, agentId: 'dot-fixture' }).subscribe({
      next: (event) => {
        received.push(event);
      },
      error: reject,
      complete: resolve,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await connected;

  const text = received
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => (event as unknown as { delta: string }).delta)
    .join('');
  expect(text).toBe(
    Array.from({ length: 120 }, (_, index) => `${index},`).join(''),
  );
  expect(received.some((event) => event.type === EventType.RUN_FINISHED)).toBe(true);
});
