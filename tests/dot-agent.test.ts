import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { afterEach, expect, it } from 'vitest';
import { aiSettingsFromEnv } from '../src/server/ai.js';
import { DotAgent, type DotAgentDeps } from '../src/server/dot-agent.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { SetupTelemetry } from '../src/server/setup-telemetry.js';
import { SkillLibrary } from '../src/server/skills.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { startFakeModel, type FakeModel } from './fixtures/fake-model.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

function fixture(model: FakeModel, timeoutMs?: number) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  resources.push(
    () => store.close(),
    () => workspace.close(),
  );
  const dot = workspace.dots()[0];
  workspace.bindThread('thread-1', dot.id, 'Fixture conversation');
  const ai = aiSettingsFromEnv({
    AI_BASE_URL: model.baseUrl,
    AI_API_KEY: 'fixture-key-never-logged',
    AI_MODEL: 'fixture-model',
  })!;
  const config: PlatformConfig = {
    ai,
    databasePath: ':memory:',
    webSearchProvider: 'disabled',
    voiceName: 'marin',
    runtimeUrl: '',
    ...(timeoutMs ? { agentRunTimeoutMs: timeoutMs } : {}),
  };
  const deps: DotAgentDeps = {
    store,
    workspace,
    config,
    ai,
    skills: new SkillLibrary(join(tmpdir(), 'opendots-no-skills')),
    setupTelemetry: new SetupTelemetry(),
  };
  const agent = new DotAgent(deps, dot.id);
  agent.threadId = 'thread-1';
  agent.setMessages([{ id: 'user-1', role: 'user', content: 'Say hi' }]);
  return { store, workspace, dot, deps, agent };
}

async function collect(agent: DotAgent) {
  const events: BaseEvent[] = [];
  const result = await agent.runAgent(undefined, {
    onEvent: ({ event }) => {
      events.push(event);
    },
  });
  return { events, result };
}

it('streams an assistant answer through AG-UI with Mastra', async () => {
  const model = await startFakeModel({ text: 'Hello there from Mastra.' });
  resources.push(() => void model.close());
  const { agent } = fixture(model);
  const { events, result } = await collect(agent);

  expect(events[0].type).toBe(EventType.RUN_STARTED);
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  const text = events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => (event as unknown as { delta: string }).delta)
    .join('');
  expect(text).toContain('Hello there from Mastra.');
  expect(
    result.newMessages.some(
      (message) =>
        message.role === 'assistant' &&
        String(message.content).includes('Mastra'),
    ),
  ).toBe(true);
});

it('runs an authorized server tool and streams its result', async () => {
  const model = await startFakeModel({
    tool: { name: 'list_authorized_spaces', args: {} },
  });
  resources.push(() => void model.close());
  const { agent } = fixture(model);
  const { events } = await collect(agent);
  expect(events.some((event) => event.type === EventType.TOOL_CALL_START)).toBe(
    true,
  );
  expect(
    events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toBe(true);
  const resultText = JSON.stringify(
    events.find((event) => event.type === EventType.TOOL_CALL_RESULT),
  );
  expect(resultText).toContain('Everyday');
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('hands a human-in-the-loop client tool back to the client without executing it', async () => {
  const model = await startFakeModel({
    tool: {
      name: 'request_connection_action',
      args: { approvalId: 'a1', summary: 'Send mail' },
    },
  });
  resources.push(() => void model.close());
  const { agent } = fixture(model);
  const tools = [
    {
      name: 'request_connection_action',
      description: 'Ask the owner to approve an action.',
      parameters: {
        type: 'object',
        properties: {
          approvalId: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['approvalId', 'summary'],
        additionalProperties: false,
      },
    },
  ];
  const events: BaseEvent[] = [];
  await agent.runAgent(
    { tools },
    {
      onEvent: ({ event }) => {
        events.push(event);
      },
    },
  );
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ]),
  );
  expect(
    events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toBe(false);
});

it('reports the configured time limit instead of hanging a turn', async () => {
  const model = await startFakeModel({ delayMs: 3_000, text: 'Too late' });
  resources.push(() => void model.close());
  const { agent } = fixture(model, 150);
  const { events } = await collect(agent);
  const error = events.find((event) => event.type === EventType.RUN_ERROR);
  expect(error).toMatchObject({
    type: EventType.RUN_ERROR,
    message: expect.stringContaining('0.15 second time limit'),
  });
});

it('masks provider failures without leaking credentials', async () => {
  const model = await startFakeModel({ status: 401 });
  resources.push(() => void model.close());
  const { agent } = fixture(model);
  const { events } = await collect(agent);
  const error = events.find((event) => event.type === EventType.RUN_ERROR);
  expect(error).toBeDefined();
  expect(JSON.stringify(error)).not.toContain('fixture-key-never-logged');
});

it('refuses to run when the conversation belongs to another Dot', async () => {
  const model = await startFakeModel({ text: 'unused' });
  resources.push(() => void model.close());
  const { workspace, deps } = fixture(model);
  const other = workspace.createDot(
    workspace.spaces()[0].id,
    'Other',
    'Be other.',
    false,
    false,
  );
  const second = new DotAgent(deps, other.id);
  second.threadId = 'thread-1';
  second.setMessages([{ id: 'user-1', role: 'user', content: 'Hi' }]);
  const { events } = await collect(second);
  expect(events[0]).toMatchObject({
    type: EventType.RUN_ERROR,
    message: expect.stringContaining('does not belong'),
  });
});
