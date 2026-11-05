import { expect, it } from 'vitest';
import {
  aiProviderFromEnv,
  aiSettingsFromEnv,
  chatAdapter,
} from '../src/server/ai.js';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const deepseek = {
  AI_PROVIDER: 'openai-compatible',
  AI_BASE_URL: 'https://api.deepseek.com',
  AI_API_KEY: 'deepseek-key',
  AI_MODEL: 'deepseek-chat',
};
const ollama = {
  AI_PROVIDER: 'ollama',
  AI_BASE_URL: 'http://127.0.0.1:11434/v1',
  AI_MODEL: 'llama3.1',
};

it('parses DeepSeek-style OpenAI-compatible configuration', () => {
  expect(aiSettingsFromEnv(deepseek)).toEqual({
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'deepseek-key',
    model: 'deepseek-chat',
    maxOutputTokens: 2200,
  });
});

it('parses Ollama configuration without requiring a real key', () => {
  expect(aiSettingsFromEnv(ollama)).toMatchObject({
    provider: 'ollama',
    apiKey: 'ollama',
    model: 'llama3.1',
  });
});

it('keeps OPENAI_* names working for existing deployments', () => {
  expect(
    aiSettingsFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1/',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'gpt-fixture',
    }),
  ).toMatchObject({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'openai-key',
    model: 'gpt-fixture',
  });
});

it('rejects unknown providers and incomplete configuration', () => {
  expect(() => aiProviderFromEnv({ AI_PROVIDER: 'anthropic-cloud' })).toThrow(
    /AI_PROVIDER/,
  );
  expect(() =>
    aiSettingsFromEnv({ AI_BASE_URL: 'https://api.deepseek.com' }),
  ).toThrow(/AI_MODEL/);
  expect(() => aiSettingsFromEnv({ AI_MODEL: 'deepseek-chat' })).toThrow(
    /AI_API_KEY/,
  );
  expect(() =>
    aiSettingsFromEnv({
      AI_MODEL: 'x',
      AI_API_KEY: 'k',
      AI_BASE_URL: 'ftp://x',
    }),
  ).toThrow(/http/);
});

it('builds the original TanStack AI adapter for the configured URL only', () => {
  const settings = aiSettingsFromEnv(deepseek)!;
  const adapter = chatAdapter(settings);
  expect(adapter).toBeDefined();
  const overridden = chatAdapter(settings, 'deepseek-reasoner');
  expect(overridden).toBeDefined();
  expect(overridden).not.toBe(adapter);
});

it('reports setup without any CopilotKit Intelligence fields', () => {
  const config: PlatformConfig = {
    voiceName: 'marin',
    runtimeUrl: '',
    databasePath: ':memory:',
    ai: aiSettingsFromEnv(deepseek),
  };
  expect(setupStatus(config)).toMatchObject({
    model: true,
    local: true,
    missing: [],
    voice: false,
  });
  expect(setupStatus({ ...config, ai: undefined })).toMatchObject({
    model: false,
    missing: ['AI_API_KEY (or OPENAI_API_KEY)', 'AI_MODEL (or OPENAI_MODEL)'],
  });
});

it('serves the AG-UI info route locally without Intelligence credentials', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const platform = new Platform(store, workspace, {
      voiceName: 'marin',
      runtimeUrl: '',
      databasePath: ':memory:',
      ai: aiSettingsFromEnv(deepseek),
    });
    const response = await platform.handle(
      new Request('http://127.0.0.1/api/copilotkit/info'),
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(
      workspace.dots()[0].id,
    );
  } finally {
    store.close();
    workspace.close();
  }
});

it('answers with a setup error, not a crash, before a model is configured', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const platform = new Platform(store, workspace, {
      voiceName: 'marin',
      runtimeUrl: '',
      databasePath: ':memory:',
    });
    const response = await platform.handle(
      new Request('http://127.0.0.1/api/copilotkit/info'),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/AI_API_KEY/);
    await expect(
      platform.createConversation(workspace.dots()[0].id, 'x'),
    ).rejects.toThrow(/Setup required/);
  } finally {
    store.close();
    workspace.close();
  }
});
