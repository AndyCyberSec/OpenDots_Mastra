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
