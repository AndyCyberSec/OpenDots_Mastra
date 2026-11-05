import { expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import type { State } from '../src/shared/types.js';

const research = {
  mode: 'live' as const,
  apiKey: 'fixture',
  model: 'fixture-model',
  baseUrl: 'https://unused.invalid/v1',
  webSearchProvider: 'disabled' as const,
};

function fixture() {
  const store = new Store(':memory:');
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
  });
  return { store, app };
}

const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('keeps automatic Learning disabled by default and validates its interval', async () => {
  const { store, app } = fixture();
  try {
    const initial = (await (await app.request('/api/state')).json()) as State;
    expect(initial.settings).toMatchObject({
      learningAutoAnalyze: false,
      learningIntervalMinutes: 60,
    });

    const enabled = await app.request(
      '/api/settings',
      patch({ learningAutoAnalyze: true, learningIntervalMinutes: 15 }),
    );
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      learningAutoAnalyze: true,
      learningIntervalMinutes: 15,
    });

    for (const interval of [4, 10_081, 1.5, 0]) {
      const response = await app.request(
        '/api/settings',
        patch({ learningIntervalMinutes: interval }),
      );
      expect(response.status).toBe(400);
    }
    expect(store.settings().learningIntervalMinutes).toBe(15);
    expect(
      (
        await app.request(
          '/api/settings',
          patch({ learningAutoAnalyze: 'yes' }),
        )
      ).status,
    ).toBe(400);
  } finally {
    store.close();
  }
});
