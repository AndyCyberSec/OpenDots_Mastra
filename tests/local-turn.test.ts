import { afterEach, expect, it } from 'vitest';
import { Platform } from '../src/server/platform.js';
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
  const platform = new Platform(store, workspace, {
    ai,
    databasePath: ':memory:',
    webSearchProvider: 'disabled',
    runtimeUrl: '',
    voiceName: 'marin',
  });
  resources.push(
    () => platform.runner.close(),
    () => platform.learning.close(),
  );
  return { platform, workspace, store };
}

it('runs a local headless turn in the durable conversation', async () => {
  const model = await startFakeModel({ text: 'Local answer.' });
  resources.push(() => void model.close());
  const { platform, workspace } = fixture(model);
  const dot = workspace.dots()[0];
  const conversation = await platform.createConversation(dot.id, 'Voice call');
  const text = await platform.turn(
    conversation.id,
    'Hello from voice',
    new AbortController().signal,
    { opendotsSource: 'voice_receipt' },
  );
  expect(text).toContain('Local answer');

  const messages = platform.runner.getThreadMessages(conversation.id);
  expect(messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(messages[0].id.startsWith('opendots:voice_receipt:')).toBe(true);
  expect(JSON.stringify(messages)).toContain('Hello from voice');

  // The next turn sees the earlier turn, because history is local.
  model.requests.length = 0;
  await platform.turn(
    conversation.id,
    'Second turn',
    new AbortController().signal,
  );
  const request = model.requests[0].body as {
    messages: { role: string; content: string }[];
  };
  expect(request.messages.map((message) => message.role)).toEqual(
    expect.arrayContaining(['user', 'assistant', 'user']),
  );
  expect(JSON.stringify(request.messages)).toContain('Local answer');
});

it('rejects a turn when the caller aborts it', async () => {
  const model = await startFakeModel({ delayMs: 2000, text: 'late' });
  resources.push(() => void model.close());
  const { platform, workspace } = fixture(model);
  const dot = workspace.dots()[0];
  const conversation = await platform.createConversation(dot.id, 'Abort');
  const controller = new AbortController();
  const pending = platform.turn(
    conversation.id,
    'Will be stopped',
    controller.signal,
  );
  setTimeout(() => controller.abort(), 100);
  await expect(pending).rejects.toThrow(/stopped|aborted/i);
});
