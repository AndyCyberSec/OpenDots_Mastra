import { expect, it } from 'vitest';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';

const base: PlatformConfig = {
  voiceName: 'marin',
  runtimeUrl: '',
  databasePath: 'data/opendots.sqlite',
  ai: {
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'fixture',
    model: 'deepseek-chat',
    maxOutputTokens: 2200,
  },
};

it('reports a ready local install without any cloud orchestration', () => {
  expect(setupStatus(base)).toMatchObject({
    model: true,
    browser: false,
    voice: false,
    composio: false,
    missing: [],
  });
});

it('requires a model and disables voice when it is absent', () => {
  expect(
    setupStatus({
      ...base,
      ai: undefined,
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({
    model: false,
    voice: false,
    missing: ['AI_API_KEY (or OPENAI_API_KEY)', 'AI_MODEL (or OPENAI_MODEL)'],
  });
});

it('enables optional integrations only when their configuration is complete', () => {
  expect(
    setupStatus({
      ...base,
      voiceKey: 'fixture',
      voiceModel: 'voice-model',
      browserUrl: 'http://127.0.0.1:4311',
      browserSecret: 'fixture-secret',
      composioApiKey: 'composio',
    }),
  ).toMatchObject({ voice: true, browser: true, composio: true });
  expect(setupStatus({ ...base, voiceKey: 'fixture' })).toMatchObject({
    voice: false,
  });
});
