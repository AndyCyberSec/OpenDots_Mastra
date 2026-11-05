import { expect, it, vi } from 'vitest';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

/**
 * Self-hosted builds must not phone home. This probes a real Platform through
 * its HTTP surface with fetch intercepted, and asserts nothing leaves the
 * process for setup status, runtime discovery, or an invalid run request.
 */
it('never sends telemetry or contacts a hosted service', async () => {
  const requests: string[] = [];
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      requests.push(String(input));
      return new Response('{"ok":true}', { status: 202 });
    });
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const platform = new Platform(store, workspace, {
      ai: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'setup-key-never-sent',
        model: 'deepseek-chat',
        maxOutputTokens: 2200,
      },
      databasePath: ':memory:',
      voiceName: 'marin',
      runtimeUrl: '',
    });
    await platform.start();
    const info = await platform.handle(
      new Request('http://localhost/api/copilotkit/info'),
    );
    expect(info.status).toBe(200);
    const dot = workspace.dots()[0];
    workspace.bindThread('fixture-thread', dot.id, 'Fixture');
    const invalid = await platform.handle(
      new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: 'fixture-thread',
          messages: 'invalid',
        }),
      }),
    );
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    await platform.stop();
    expect(requests).toEqual([]);
  } finally {
    fetchSpy.mockRestore();
    store.close();
    workspace.close();
  }
});
