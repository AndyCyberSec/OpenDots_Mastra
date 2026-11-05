import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { LearningService } from '../src/server/learning.js';
import { Store } from '../src/server/store.js';
import { startFakeModel, type FakeModel } from './fixtures/fake-model.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

function fixture(model: FakeModel) {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-learning-auto-'));
  const path = join(dir, 'opendots.sqlite');
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path);
  store.updateSettings({
    learningAutoAnalyze: true,
    learningIntervalMinutes: 5,
  });
  const learning = new LearningService(path, {
    ai: {
      provider: 'openai-compatible',
      baseUrl: model.baseUrl,
      apiKey: 'fixture',
      model: 'fixture-model',
      maxOutputTokens: 2200,
    },
    config: { evidenceLimit: 500 },
    timeoutMs: 5000,
    settings: () => {
      const settings = store.settings();
      return {
        paused: settings.paused,
        learningAutoAnalyze: settings.learningAutoAnalyze,
        learningIntervalMinutes: settings.learningIntervalMinutes,
      };
    },
  });
  resources.push(
    () => learning.close(),
    () => store.close(),
  );
  return { store, learning, path };
}

const evidence = (threadId: string, text = 'Prepare a weekly review') => [
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
    text: 'Summarized the week.',
  },
];

function backdate(path: string, containerId: string) {
  const db = new DatabaseSync(path);
  db.prepare(
    'UPDATE learning_containers SET lastAutoAttemptAt=0, lastAnalyzedAt=0, analyzedEvidenceAt=0 WHERE id=?',
  ).run(containerId);
  db.close();
}

function ready(learning: LearningService, containerId = 'research') {
  learning.createContainer(containerId, 'Research');
  learning.updateContainer(containerId, { threshold: 1 });
  learning.recordTurn(containerId, evidence('thread-1'));
}

function skillsResponse() {
  return {
    text: JSON.stringify({
      skills: [
        {
          name: 'weekly-review',
          description: 'Prepare a weekly review page.',
          content: 'Read last week, then summarize decisions.',
        },
      ],
    }),
  };
}

it('is disabled by default and does nothing on a scheduler tick', async () => {
  const model = await startFakeModel(skillsResponse());
  resources.push(() => void model.close());
  const f = fixture(model);
  f.store.updateSettings({ learningAutoAnalyze: false });
  ready(f.learning);
  const summary = f.learning.summary(f.learning.container('research')!);
  expect(summary.autoReason).toBe('disabled');
  expect(summary.nextEligibleAt).toBeNull();
  const result = await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(result.proposed).toBe(0);
  expect(model.requests).toHaveLength(0);
  expect(f.learning.skills('research')).toHaveLength(0);
});

it('analyzes one ready container and never publishes drafts', async () => {
  const model = await startFakeModel(skillsResponse());
  resources.push(() => void model.close());
  const f = fixture(model);
  ready(f.learning);
  const result = await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(result).toMatchObject({
    analyzedContainerId: 'research',
    proposed: 1,
  });
  expect(model.requests).toHaveLength(1);
  const skills = f.learning.skills('research');
  expect(skills).toHaveLength(1);
  expect(skills[0].status).toBe('draft');
  expect(f.learning.publishedSkills('research')).toHaveLength(0);
  const summary = f.learning.summary(f.learning.container('research')!);
  expect(summary.lastAnalyzedAt).toBeTypeOf('number');
  expect(summary.autoReason).toBe('no_new_evidence');
  expect(summary.nextEligibleAt).toBeGreaterThan(Date.now());
});

it('skips unchanged evidence, the interval, paused containers, and the paused workspace', async () => {
  const model = await startFakeModel(skillsResponse());
  resources.push(() => void model.close());
  const f = fixture(model);
  ready(f.learning);
  await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(model.requests).toHaveLength(1);

  // Same evidence and inside the interval: no call.
  await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(model.requests).toHaveLength(1);

  // New evidence but still inside the interval.
  f.learning.recordTurn('research', evidence('thread-2'));
  expect(f.learning.summary(f.learning.container('research')!).autoReason).toBe(
    'interval',
  );
  await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(model.requests).toHaveLength(1);

  // After the interval, new evidence is analyzed exactly once more.
  backdate(f.path, 'research');
  await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(model.requests).toHaveLength(2);

  // Paused container.
  f.learning.updateContainer('research', { paused: true });
  f.learning.recordTurn('research', evidence('thread-3'));
  backdate(f.path, 'research');
  expect(f.learning.summary(f.learning.container('research')!).autoReason).toBe(
    'paused',
  );
  await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(model.requests).toHaveLength(2);

  // Paused workspace.
  f.learning.updateContainer('research', { paused: false });
  f.store.updateSettings({ paused: true });
  backdate(f.path, 'research');
  expect(f.learning.summary(f.learning.container('research')!).autoReason).toBe(
    'workspace_paused',
  );
  await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(model.requests).toHaveLength(2);
});

it('waits for the readiness threshold', async () => {
  const model = await startFakeModel(skillsResponse());
  resources.push(() => void model.close());
  const f = fixture(model);
  f.learning.createContainer('research', 'Research');
  f.learning.updateContainer('research', { threshold: 15 });
  f.learning.recordTurn('research', evidence('thread-1'));
  expect(f.learning.summary(f.learning.container('research')!).autoReason).toBe(
    'not_ready',
  );
  await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(model.requests).toHaveLength(0);
});

it('records failures without retrying before the interval and clears them on success', async () => {
  const model = await startFakeModel({ status: 500 });
  resources.push(() => void model.close());
  const f = fixture(model);
  ready(f.learning);
  const failed = await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(failed.error).toBeDefined();
  expect(f.learning.skills('research')).toHaveLength(0);
  const afterFailure = f.learning.summary(f.learning.container('research')!);
  expect(afterFailure.lastAutoError).toMatch(/analysis failed/i);
  expect(afterFailure.autoReason).toBe('interval');
  const requestsAfterFailure = model.requests.length;
  await f.learning.autoAnalyzeTick(new AbortController().signal);
  expect(model.requests).toHaveLength(requestsAfterFailure);

  model.set(skillsResponse());
  backdate(f.path, 'research');
  const succeeded = await f.learning.autoAnalyzeTick(
    new AbortController().signal,
  );
  expect(succeeded.proposed).toBe(1);
  expect(
    f.learning.summary(f.learning.container('research')!).lastAutoError,
  ).toBeNull();
});

it('prevents concurrent automatic analyses', async () => {
  const model = await startFakeModel({ ...skillsResponse(), delayMs: 200 });
  resources.push(() => void model.close());
  const f = fixture(model);
  ready(f.learning);
  const signal = new AbortController().signal;
  await Promise.all([
    f.learning.autoAnalyzeTick(signal),
    f.learning.autoAnalyzeTick(signal),
  ]);
  expect(model.requests).toHaveLength(1);
});

it('stops automatic analysis when the scheduler signal aborts', async () => {
  const model = await startFakeModel({ ...skillsResponse(), delayMs: 2_000 });
  resources.push(() => void model.close());
  const f = fixture(model);
  ready(f.learning);
  const controller = new AbortController();
  const pending = f.learning.autoAnalyzeTick(controller.signal);
  setTimeout(() => controller.abort(), 50);
  const result = await pending;
  expect(result.proposed).toBe(0);
  expect(result.error).toMatch(/stopped|failed/i);
  expect(f.learning.skills('research')).toHaveLength(0);
});
