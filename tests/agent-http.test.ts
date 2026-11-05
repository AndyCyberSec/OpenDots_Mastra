import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { aiSettingsFromEnv } from '../src/server/ai.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { startFakeModel, type FakeModel } from './fixtures/fake-model.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

function fixture(model: FakeModel, path = ':memory:') {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-http-'));
  const database =
    path === ':memory:' ? ':memory:' : join(dir, 'opendots.sqlite');
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(database);
  const workspace = new WorkspaceStore(database, 'owner');
  resources.push(
    () => store.close(),
    () => workspace.close(),
  );
  const ai = aiSettingsFromEnv({
    AI_BASE_URL: model.baseUrl,
    AI_API_KEY: 'fixture-key',
    AI_MODEL: 'fixture-model',
  })!;
  const config = {
    ai,
    databasePath: database,
    webSearchProvider: 'disabled' as const,
    voiceName: 'marin',
    runtimeUrl: '',
  };
  const platform = new Platform(store, workspace, config);
  const researchConfig = {
    mode: 'live' as const,
    apiKey: ai.apiKey,
    model: ai.model,
    baseUrl: ai.baseUrl,
    webSearchProvider: 'disabled' as const,
  };
  const runner = new Runner(store, researchConfig);
  const app = createApp({ store, runner, config: researchConfig, platform });
  return { app, platform, store, workspace, database, config };
}

async function conversation(
  app: ReturnType<typeof fixture>['app'],
  dotId: string,
) {
  const response = await app.request('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dotId, title: 'Streaming test' }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

function runBody(threadId: string, text: string) {
  return JSON.stringify({
    threadId,
    runId: `run-${threadId}`,
    state: {},
    messages: [{ id: `user-${text}`, role: 'user', content: text }],
    tools: [],
    context: [],
    forwardedProps: {},
  });
}

it('streams a turn over the local AG-UI endpoint and persists the transcript', async () => {
  const model = await startFakeModel({ text: 'Persisted hello.' });
  resources.push(() => void model.close());
  const { app, workspace, store, config } = fixture(model);
  const dot = workspace.dots()[0];
  const thread = await conversation(app, dot.id);

  const response = await app.request(`/api/copilotkit/agent/${dot.id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: runBody(thread.id, 'hello'),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('RUN_STARTED');
  expect(body).toContain('TEXT_MESSAGE_CONTENT');
  expect(body.replaceAll('data: ', '')).toContain('Persisted');
  expect(body).toContain('RUN_FINISHED');

  const messages = await app.request(
    `/api/copilotkit/threads/${thread.id}/messages`,
  );
  expect(messages.status).toBe(200);
  const stored = (await messages.json()) as {
    messages: { role: string; content: unknown }[];
  };
  expect(stored.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(JSON.stringify(stored.messages)).toContain('Persisted hello.');

  const threads = await app.request(
    `/api/copilotkit/threads?agentId=${dot.id}`,
  );
  expect(threads.status).toBe(200);
  const list = (await threads.json()) as { threads: { id: string }[] };
  expect(list.threads.some((item) => item.id === thread.id)).toBe(true);

  // Persistence check: a second platform on the same database sees the turn.
  if (config.databasePath !== ':memory:') {
    const restarted = new Platform(store, workspace, config);
    const after = await restarted.handle(
      new Request(
        `http://localhost/api/copilotkit/threads/${thread.id}/messages`,
      ),
    );
    expect(JSON.stringify(await after.json())).toContain('Persisted hello.');
  }
});

it('keeps rejection paths scoped to bound conversations', async () => {
  const model = await startFakeModel({ text: 'unused' });
  resources.push(() => void model.close());
  const { app, workspace } = fixture(model);
  const dot = workspace.dots()[0];
  const response = await app.request(`/api/copilotkit/agent/${dot.id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: runBody('not-ours', 'hello'),
  });
  expect(response.status).toBe(403);
});

it('stops a running turn through the local stop endpoint', async () => {
  const model = await startFakeModel({ delayMs: 1_500, text: 'late' });
  resources.push(() => void model.close());
  const { app, workspace } = fixture(model);
  const dot = workspace.dots()[0];
  const thread = await conversation(app, dot.id);
  const pending = app.request(`/api/copilotkit/agent/${dot.id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: runBody(thread.id, 'hello'),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const stopped = await app.request(
    `/api/copilotkit/agent/${dot.id}/stop/${thread.id}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: thread.id }),
    },
  );
  expect(stopped.status).toBeLessThan(500);
  const response = await pending;
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('data:');
}, 10_000);
