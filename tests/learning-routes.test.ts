import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { startFakeModel, type FakeModel } from './fixtures/fake-model.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

function fixture(model: FakeModel) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  resources.push(
    () => store.close(),
    () => workspace.close(),
  );
  const ai = {
    provider: 'openai-compatible' as const,
    baseUrl: model.baseUrl,
    apiKey: 'fixture',
    model: 'fixture-model',
    maxOutputTokens: 2200,
  };
  const config = {
    ai,
    databasePath: ':memory:',
    webSearchProvider: 'disabled' as const,
    runtimeUrl: '',
    voiceName: 'marin',
  };
  const platform = new Platform(store, workspace, config);
  resources.push(() => platform.learning.close());
  const research = {
    mode: 'live' as const,
    apiKey: ai.apiKey,
    model: ai.model,
    baseUrl: ai.baseUrl,
    webSearchProvider: 'disabled' as const,
  };
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    platform,
  });
  return { app, store, workspace, platform };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('exposes the owner Learning workflow over HTTP', async () => {
  const model = await startFakeModel({ text: 'unused' });
  resources.push(() => void model.close());
  const { app, workspace, platform } = fixture(model);

  const created = await app.request(
    '/api/learning/containers',
    json({ id: 'research-workflow', name: 'Research workflow' }),
  );
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({
    id: 'research-workflow',
    paused: false,
  });

  const dot = workspace.dots()[0];
  const updated = await app.request(`/api/dots/${dot.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: true,
      memoryAllowed: true,
      learningContainerId: 'research-workflow',
      skillDeliveryEnabled: true,
    }),
  });
  expect(updated.status).toBe(200);

  // Evidence arrives through the normal durable conversation path.
  platform.learning.recordTurn('research-workflow', [
    {
      threadId: 'thread',
      dotId: dot.id,
      messageId: 'evidence-1',
      role: 'user',
      text: 'Prepare a weekly review.',
    },
  ]);

  model.set({
    text: JSON.stringify({
      skills: [
        {
          name: 'weekly-review',
          description: 'Prepare a weekly review page.',
          content: 'Read last week, then summarize.',
        },
      ],
    }),
  });
  const analyzed = await app.request(
    '/api/learning/containers/research-workflow/analyze',
    json({}),
  );
  expect(analyzed.status).toBe(200);
  expect(await analyzed.json()).toMatchObject({ proposed: 1 });

  const detail = await app.request(
    '/api/learning/containers/research-workflow',
  );
  const detailBody = (await detail.json()) as {
    container: { evidenceCount: number; draftCount: number };
    skills: { id: string; status: string }[];
  };
  expect(detailBody.container).toMatchObject({
    evidenceCount: 1,
    draftCount: 1,
  });
  expect(detailBody.skills[0].status).toBe('draft');

  const published = await app.request(
    `/api/learning/skills/${detailBody.skills[0].id}/actions`,
    json({ action: 'publish' }),
  );
  expect(published.status).toBe(200);
  expect(await published.json()).toMatchObject({ status: 'published' });

  const evidence = await app.request(
    '/api/learning/containers/research-workflow/evidence',
  );
  expect(evidence.status).toBe(200);
  expect(JSON.stringify(await evidence.json())).toContain('weekly review');

  const paused = await app.request(
    '/api/learning/containers/research-workflow',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    },
  );
  expect(paused.status).toBe(200);
  expect(await paused.json()).toMatchObject({ paused: true });
  const blocked = await app.request(
    '/api/learning/containers/research-workflow/analyze',
    json({}),
  );
  expect(blocked.status).toBe(400);
  expect((await blocked.json()).error).toMatch(/paused/);
});

it('validates Learning requests', async () => {
  const model = await startFakeModel({ text: 'unused' });
  resources.push(() => void model.close());
  const { app } = fixture(model);
  expect(
    (
      await app.request(
        '/api/learning/containers',
        json({ id: 'Bad ID', name: 'Bad' }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(
        '/api/learning/containers',
        json({ id: 'research', name: 'Research' }),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await app.request(
        '/api/learning/containers',
        json({ id: 'research', name: 'Research' }),
      )
    ).status,
  ).toBe(409);
  expect((await app.request('/api/learning/containers/missing')).status).toBe(
    404,
  );
  expect(
    (await app.request('/api/learning/containers/missing/evidence')).status,
  ).toBe(404);
  expect(
    (
      await app.request(
        '/api/learning/skills/missing/actions',
        json({ action: 'publish' }),
      )
    ).status,
  ).toBe(404);
});
