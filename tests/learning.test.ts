import { afterEach, expect, it } from 'vitest';
import { LearningService } from '../src/server/learning.js';
import { startFakeModel } from './fixtures/fake-model.js';
import type { AiSettings } from '../src/server/ai.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

const ai: AiSettings = {
  provider: 'openai-compatible',
  baseUrl: 'https://unused.invalid/v1',
  apiKey: 'fixture',
  model: 'fixture-model',
  maxOutputTokens: 2200,
};

function service(options: { ai?: AiSettings } = {}) {
  const learning = new LearningService(':memory:', {
    ai: 'ai' in options ? options.ai : ai,
    config: { evidenceLimit: 200 },
    timeoutMs: 5000,
  });
  resources.push(() => learning.close());
  return learning;
}

const evidence = (threadId: string, text: string) => [
  {
    threadId,
    dotId: 'dot',
    messageId: `${threadId}-user`,
    role: 'user' as const,
    text,
  },
  {
    threadId,
    dotId: 'dot',
    messageId: `${threadId}-assistant`,
    role: 'assistant' as const,
    text: `Answer for ${threadId}`,
  },
];

it('creates containers with owner-controlled IDs and rejects duplicates', () => {
  const learning = service();
  expect(
    learning.createContainer('research-workflow', 'Research workflow'),
  ).toMatchObject({
    id: 'research-workflow',
    name: 'Research workflow',
    paused: false,
    threshold: 15,
  });
  expect(() => learning.createContainer('research-workflow', 'Again')).toThrow(
    /already exists/,
  );
  expect(() => learning.createContainer('Bad ID', 'Bad')).toThrow(/lowercase/);
  expect(learning.listContainers()).toHaveLength(1);
});

it('records bounded, de-duplicated evidence and reports readiness', () => {
  const learning = service();
  learning.createContainer('research', 'Research');
  learning.recordTurn('research', evidence('thread-1', 'First question'));
  // Repeating the same messages (same ids) is de-duplicated.
  learning.recordTurn('research', [
    evidence('thread-1', 'First question')[0],
    {
      threadId: 'thread-1',
      dotId: 'dot',
      messageId: 'thread-1-assistant',
      role: 'assistant',
      text: 'Answer for thread-1',
    },
  ]);
  learning.recordTurn('missing', evidence('thread-2', 'Ignored'));
  expect(learning.evidence('research')).toHaveLength(2);
  expect(learning.evidence('missing')).toHaveLength(0);
  const summary = learning.summary(learning.container('research')!);
  expect(summary).toMatchObject({
    evidenceCount: 2,
    threadCount: 1,
    ready: false,
  });
  learning.updateContainer('research', { threshold: 1 });
  expect(learning.summary(learning.container('research')!).ready).toBe(true);
});

it('bounds evidence per container without touching conversations', () => {
  const learning = new LearningService(':memory:', {
    ai,
    config: { evidenceLimit: 50 },
    timeoutMs: 5000,
  });
  resources.push(() => learning.close());
  learning.createContainer('bounded', 'Bounded');
  for (let index = 0; index < 120; index++)
    learning.recordTurn('bounded', [
      {
        threadId: `thread-${index}`,
        dotId: 'dot',
        messageId: `message-${index}`,
        role: 'user',
        text: `Question ${index}`,
      },
    ]);
  expect(learning.evidence('bounded', 500)).toHaveLength(50);
});

it('proposes draft skills with the configured model and never publishes automatically', async () => {
  const model = await startFakeModel({
    text: JSON.stringify({
      skills: [
        {
          name: 'weekly-review',
          description: 'Prepare a weekly review page.',
          content: '1. Read last week.\n2. Summarize.',
        },
      ],
    }),
  });
  resources.push(() => void model.close());
  const learning = service({
    ai: { ...ai, baseUrl: model.baseUrl },
  });
  learning.createContainer('research', 'Research');
  learning.recordTurn(
    'research',
    evidence('thread-1', 'Review my week please'),
  );

  const result = await learning.analyze(
    'research',
    new AbortController().signal,
  );
  expect(result).toMatchObject({ proposed: 1, analyzed: 2 });
  const [skill] = learning.skills('research');
  expect(skill).toMatchObject({
    name: 'weekly-review',
    status: 'draft',
    source: 'model',
  });
  expect(learning.publishedSkills('research')).toHaveLength(0);
  expect(learning.catalog('research')).toBe('');

  learning.setSkillStatus(skill.id, 'published');
  expect(learning.publishedSkills('research')).toHaveLength(1);
  expect(learning.catalog('research')).toContain('weekly-review');
});

it('skips duplicate proposals and records failed analyses', async () => {
  const model = await startFakeModel({
    text: JSON.stringify({
      skills: [
        { name: 'existing-skill', description: 'Already there.', content: 'x' },
      ],
    }),
  });
  resources.push(() => void model.close());
  const learning = service({ ai: { ...ai, baseUrl: model.baseUrl } });
  learning.createContainer('research', 'Research');
  learning.recordTurn('research', evidence('thread-1', 'Evidence'));
  await learning.analyze('research', new AbortController().signal);
  await learning.analyze('research', new AbortController().signal);
  expect(learning.skills('research')).toHaveLength(1);

  model.set({ text: 'not json' });
  await expect(
    learning.analyze('research', new AbortController().signal),
  ).rejects.toThrow(/proposal/);
  expect(learning.runs('research')[0]).toMatchObject({ status: 'failed' });
});

it('refuses analysis when paused, without evidence, or without a model', async () => {
  const learning = service();
  learning.createContainer('paused', 'Paused');
  learning.updateContainer('paused', { paused: true });
  await expect(
    learning.analyze('paused', new AbortController().signal),
  ).rejects.toThrow(/paused/);

  learning.createContainer('empty', 'Empty');
  await expect(
    learning.analyze('empty', new AbortController().signal),
  ).rejects.toThrow(/no conversation evidence/);

  const noModel = service({ ai: undefined });
  noModel.createContainer('no-model', 'No model');
  noModel.recordTurn('no-model', evidence('thread-1', 'Evidence'));
  await expect(
    noModel.analyze('no-model', new AbortController().signal),
  ).rejects.toThrow(/Model configuration/);
});

it('delivers only published skills through the upstream tool names', async () => {
  const model = await startFakeModel({
    text: JSON.stringify({
      skills: [
        {
          name: 'release-notes',
          description: 'Draft release notes from merged work.',
          content: 'Summarize the changes and ask for approval.',
        },
      ],
    }),
  });
  resources.push(() => void model.close());
  const learning = service({ ai: { ...ai, baseUrl: model.baseUrl } });
  learning.createContainer('research', 'Research');
  learning.recordTurn('research', evidence('thread-1', 'Evidence'));
  await learning.analyze('research', new AbortController().signal);
  const [draft] = learning.skills('research');

  expect(learning.catalog('research')).toBe('');
  await expect(
    learning.tools('research', () => {})[0].execute!({
      skill_name: 'release-notes',
    }),
  ).rejects.toThrow(/not available/);

  learning.setSkillStatus(draft.id, 'published');
  expect(learning.catalog('research')).toContain('release-notes');
  const tools = learning.tools('research', () => {});
  expect(tools.map((tool) => tool.name)).toEqual([
    'copilotkit_load_skill',
    'copilotkit_read_skill_file',
  ]);
  await expect(
    tools[0].execute!({ skill_name: 'release-notes' }),
  ).resolves.toMatchObject({
    name: 'release-notes',
    instructions: expect.stringContaining('ask for approval'),
  });
  const readFile = tools[1].execute as unknown as (input: {
    skill_name: string;
    path: string;
  }) => unknown;
  await expect(
    readFile({ skill_name: 'release-notes', path: 'notes.md' }),
  ).resolves.toMatchObject({ error: expect.stringContaining('inline') });
  await expect(tools[0].execute!({ skill_name: 'missing' })).rejects.toThrow(
    /not available/,
  );
  expect(learning.catalog('unknown-container')).toBeUndefined();
});

it('supports unpublishing, rejection, and deletion', async () => {
  const model = await startFakeModel({
    text: JSON.stringify({
      skills: [
        { name: 'release-notes', description: 'One.', content: 'Do it.' },
        { name: 'weekly-review', description: 'Two.', content: 'Do it.' },
      ],
    }),
  });
  resources.push(() => void model.close());
  const learning = service({ ai: { ...ai, baseUrl: model.baseUrl } });
  learning.createContainer('research', 'Research');
  learning.recordTurn('research', evidence('thread-1', 'Evidence'));
  await learning.analyze('research', new AbortController().signal);
  const [first, second] = learning.skills('research');
  learning.setSkillStatus(first.id, 'published');
  expect(learning.publishedSkills('research')).toHaveLength(1);
  learning.setSkillStatus(first.id, 'rejected');
  expect(learning.publishedSkills('research')).toHaveLength(0);
  expect(
    learning.skills('research').some((skill) => skill.status === 'rejected'),
  ).toBe(true);
  expect(learning.deleteSkill(second.id)).toBe(true);
  expect(learning.skill(second.id)).toBeUndefined();
  expect(() => learning.setSkillStatus('missing', 'published')).toThrow(
    /not found/,
  );
});

it('rejects overlapping analyses of the same container', async () => {
  const model = await startFakeModel({
    ...{
      text: JSON.stringify({
        skills: [
          { name: 'weekly-review', description: 'One.', content: 'Do it.' },
        ],
      }),
    },
    delayMs: 200,
  });
  resources.push(() => void model.close());
  const learning = service({ ai: { ...ai, baseUrl: model.baseUrl } });
  learning.createContainer('research', 'Research');
  learning.recordTurn('research', evidence('thread-1', 'Evidence'));
  const first = learning.analyze('research', new AbortController().signal);
  await expect(
    learning.analyze('research', new AbortController().signal),
  ).rejects.toThrow(/already running/);
  await first;
  expect(learning.skills('research')).toHaveLength(1);
});
