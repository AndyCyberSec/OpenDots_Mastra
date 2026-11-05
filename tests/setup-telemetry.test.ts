import { createServer } from 'node:http';
import { EventType } from '@ag-ui/core';
import { expect, it, vi } from 'vitest';
import {
  SetupTelemetry,
  answerObserver,
  setupInputSchema,
} from '../src/server/setup-telemetry.js';

it('validates owner-supplied setup events without inventing fields', () => {
  expect(
    setupInputSchema.safeParse({ kind: 'step_viewed', step: 'settings' })
      .success,
  ).toBe(true);
  expect(
    setupInputSchema.safeParse({ kind: 'step_viewed', step: 'ready', extra: 1 })
      .success,
  ).toBe(false);
  expect(setupInputSchema.safeParse({ kind: 'activated' }).success).toBe(false);
});

it('never performs network delivery and never stores identifiers', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(202);
    response.end('{"ok":true}');
  });
  const requests: string[] = [];
  server.on('request', (request) => requests.push(request.url ?? ''));
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  try {
    const telemetry = new SetupTelemetry();
    telemetry.start();
    for (let index = 0; index < 50; index++)
      telemetry.capture({ kind: 'step_viewed', step: 'ready' });
    telemetry.capture({ kind: 'activated' });
    telemetry.capture({
      kind: 'setup_failed',
      step: 'ready',
      error_class: 'assistant_run_failed',
    });
    await telemetry.stop();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(telemetry.identity).toBe('local');
  } finally {
    fetchSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('still reports whether a turn produced a real answer', () => {
  const captured: string[] = [];
  const observe = answerObserver((event) => captured.push(event.kind));
  observe({
    type: EventType.TEXT_MESSAGE_START,
    role: 'assistant',
    messageId: 'a',
  });
  observe({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'a',
    delta: 'Hello',
  });
  observe({ type: EventType.RUN_FINISHED });
  expect(captured).toContain('activated');

  captured.length = 0;
  observe({ type: EventType.RUN_ERROR, message: 'failed' });
  expect(captured).toContain('setup_failed');
});
