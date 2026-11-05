import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { LearningService } from '../src/server/learning.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { startFakeModel, type FakeModel } from './fixtures/fake-model.js';

const resources: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  resources.splice(0).forEach((close) => close());
});

function fixture(model: FakeModel, options: { delivery?: boolean } = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  resources.push(
    () => store.close(),
    () => workspace.close(),
  );
  const dot = workspace.dots()[0];
  workspace.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: options.delivery ?? true,
  });
  workspace.bindThread('thread', dot.id, 'Learning conversation');
  const ai = {
    provider: 'openai-compatible' as const,
    baseUrl: model.baseUrl,
    apiKey: 'fixture',
    model: 'fixture-model',
    maxOutputTokens: 2200,
  };
  const learning = new LearningService(':memory:', {
    ai,
    config: { evidenceLimit: 200 },
    timeoutMs: 5000,
  });
  resources.push(() => learning.close());
  learning.createContainer('research', 'Research');
  const config: PlatformConfig = {
    ai,
    databasePath: ':memory:',
    webSearchProvider: 'disabled',
    runtimeUrl: '',
    voiceName: 'marin',
  };
  const agent = new DotAgent(store, workspace, config, dot.id, learning);
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [
      { id: 'user-1', role: 'user', content: 'Prepare a weekly review.' },
    ],
    tools: [],
    forwardedProps: {},
  };
  return { store, workspace, dot, learning, agent, input };
}

async function publishSkill(learning: LearningService, model: FakeModel) {
  learning.recordTurn('research', [
    {
      threadId: 'thread',
      dotId: 'dot',
      messageId: 'evidence-1',
      role: 'user',
      text: 'Prepare a weekly review every Friday.',
    },
  ]);
  model.set({
    text: JSON.stringify({
      skills: [
        {
          name: 'weekly-review',
          description: 'Prepare a weekly review page.',
          content: 'Read last week, then summarize decisions.',
        },
      ],
    }),
  });
  await learning.analyze('research', new AbortController().signal);
  const [skill] = learning.skills('research');
  learning.setSkillStatus(skill.id, 'published');
}

it('delivers published skills with a catalogue and the upstream tools', async () => {
  const model = await startFakeModel({ text: 'Ready.' });
  resources.push(() => void model.close());
  const f = fixture(model);
  await publishSkill(f.learning, model);
  model.requests.length = 0;

  model.set({
    tool: {
      name: 'copilotkit_load_skill',
      args: { skill_name: 'weekly-review' },
    },
  });
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));

  const first = model.requests[0].body as {
    messages: { role: string; content: string }[];
    tools: { function: { name: string } }[];
  };
  const system = first.messages.find((message) => message.role === 'system');
  expect(system?.content).toContain('Published skills are available');
  expect(system?.content).toContain('weekly-review');
  expect(first.tools.map((tool) => tool.function.name)).toEqual(
    expect.arrayContaining([
      'copilotkit_load_skill',
      'copilotkit_read_skill_file',
    ]),
  );
  expect(
    events.some(
      (event) =>
        event.type === EventType.TOOL_CALL_START &&
        (event as { toolCallName?: string }).toolCallName ===
          'copilotkit_load_skill',
    ),
  ).toBe(true);
  expect(JSON.stringify(model.requests.at(-1)?.body)).toContain(
    'summarize decisions',
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

  // The completed turn is recorded as Learning evidence, not just chat history.
  const evidence = f.learning.evidence('research', 100);
  expect(evidence.some((row) => row.role === 'assistant')).toBe(true);
});

it('delivers nothing when the Dot disables skill delivery but still records evidence', async () => {
  const model = await startFakeModel({ text: 'Ready.' });
  resources.push(() => void model.close());
  const f = fixture(model, { delivery: false });
  await publishSkill(f.learning, model);
  model.requests.length = 0;
  model.set({ text: 'Ready.' });

  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  const request = model.requests.at(-1)?.body as {
    messages: { role: string; content: string }[];
    tools: { function: { name: string } }[];
  };
  const system = request.messages.find((message) => message.role === 'system');
  expect(system?.content).not.toContain('Published skills are available');
  expect(request.tools.map((tool) => tool.function.name)).not.toContain(
    'copilotkit_load_skill',
  );
  expect(f.learning.evidence('research', 100).length).toBeGreaterThan(0);
});

it('fails the turn when the frozen Learning container is unavailable', async () => {
  const model = await startFakeModel({ text: 'unused' });
  resources.push(() => void model.close());
  const f = fixture(model);
  // Simulate a database restored without its Learning container.
  f.learning.deleteSkill('none');
  const empty = new LearningService(':memory:', {
    ai: {
      provider: 'openai-compatible',
      baseUrl: model.baseUrl,
      apiKey: 'fixture',
      model: 'fixture-model',
      maxOutputTokens: 2200,
    },
    config: { evidenceLimit: 200 },
    timeoutMs: 5000,
  });
  resources.push(() => empty.close());
  const agent = new DotAgent(
    f.store,
    f.workspace,
    {
      ai: {
        provider: 'openai-compatible',
        baseUrl: model.baseUrl,
        apiKey: 'fixture',
        model: 'fixture-model',
        maxOutputTokens: 2200,
      },
      databasePath: ':memory:',
      webSearchProvider: 'disabled',
      runtimeUrl: '',
      voiceName: 'marin',
    },
    f.dot.id,
    empty,
  );
  const events = await lastValueFrom(agent.run(f.input).pipe(toArray()));
  expect(events[0]).toMatchObject({
    type: EventType.RUN_ERROR,
    message: expect.stringContaining('Learning container'),
  });
  expect(model.requests).toHaveLength(0);
});
