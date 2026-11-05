import { expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { PageService } from '../src/server/page-service.js';
import type { SqliteAgentRunner } from '../src/server/agent-runner.js';

const fakeRunner = {
  registerThread: vi.fn(),
  getThreadMessages: vi.fn(() => []),
} as unknown as SqliteAgentRunner;

it('never reuses a deleted page conversation', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = ws.dots()[0];
    const page = ws.pages.create(dot.spaceId, { title: 'Temporary' });
    const service = new PageService(ws, () => fakeRunner);
    const thread = await service.conversation(dot.spaceId, page.id, dot.id);
    expect(ws.pages.forThread(thread.id)?.id).toBe(page.id);

    ws.pages.delete(dot.spaceId, page.id);
    expect(ws.pages.thread(page.id, dot.id)).toBeUndefined();
    expect(ws.pages.forThread(thread.id)).toBeUndefined();

    const replacement = ws.pages.create(dot.spaceId, { title: 'Replacement' });
    const next = await service.conversation(
      dot.spaceId,
      replacement.id,
      dot.id,
    );
    expect(next.id).not.toBe(thread.id);
    expect(ws.pages.forThread(next.id)?.id).toBe(replacement.id);

    await expect(
      service.conversation(dot.spaceId, page.id, dot.id),
    ).rejects.toThrow(/Page not found/);
  } finally {
    ws.close();
  }
});
