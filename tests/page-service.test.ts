import { expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { PageService } from '../src/server/page-service.js';
import { pageAccess } from '../src/server/page-tools.js';
import type { SqliteAgentRunner } from '../src/server/agent-runner.js';
import type { Message } from '@ag-ui/core';

/**
 * PageService only needs two runner methods. Tests use a narrow double so the
 * page-binding behaviour stays unit-testable without a database or a model.
 */
function fakeRunner(messages: Message[] = []) {
  const registered: string[] = [];
  const runner = {
    registerThread: vi.fn((threadId: string) => {
      registered.push(threadId);
    }),
    getThreadMessages: vi.fn(() => messages),
  };
  return {
    runner: runner as unknown as SqliteAgentRunner,
    registered,
    getThreadMessages: runner.getThreadMessages,
  };
}

it('reuses one local thread per page and Dot under concurrent requests', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const page = ws.pages.create(dot.spaceId, { title: 'Design' });
  const fake = fakeRunner();
  const service = new PageService(ws, () => fake.runner);
  const [a, b] = await Promise.all([
    service.conversation(dot.spaceId, page.id, dot.id),
    service.conversation(dot.spaceId, page.id, dot.id),
  ]);
  expect(a.id).toBe(b.id);
  expect(fake.registered).toEqual([a.id]);
  expect((await service.conversation(dot.spaceId, page.id, dot.id)).id).toBe(
    a.id,
  );
  expect(ws.pages.forThread(a.id, dot.spaceId)?.id).toBe(page.id);
  ws.close();
});

it('exports canonical user/assistant text and rejects empty or oversized history', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  ws.bindThread('thread', dot.id, 'Thread');
  const fake = fakeRunner([
    {
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'Question' }],
    },
    { id: 'a', role: 'assistant', content: 'Answer' },
    { id: 't', role: 'tool', content: 'Secret tool response', toolCallId: 'c' },
  ]);
  const service = new PageService(ws, () => fake.runner);
  const page = await service.saveConversation('thread', 'Saved', null);
  expect(page.content).toBe('## You\n\nQuestion\n\n## Dot\n\nAnswer');
  expect(page.sourceThreadId).toBe('thread');

  fake.getThreadMessages.mockReturnValueOnce([]);
  await expect(
    service.saveConversation('thread', 'Empty', null),
  ).rejects.toThrow(/no persisted text/);
  fake.getThreadMessages.mockReturnValueOnce([
    { id: 'a', role: 'assistant', content: 'x'.repeat(100001) },
  ]);
  await expect(
    service.saveConversation('thread', 'Too long', null),
  ).rejects.toThrow(/exceeds/);
  expect(ws.pages.list(dot.spaceId)).toHaveLength(1);
  ws.close();
});

it('recovers a reserved thread that was never registered', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const page = ws.pages.create(dot.spaceId, { title: 'Recover' });
  ws.pages.reserveThread(page.id, dot.id, 'stable-thread');
  const fake = fakeRunner();
  const service = new PageService(ws, () => fake.runner);
  await expect(
    service.conversation(dot.spaceId, page.id, dot.id),
  ).rejects.toThrow(/being created/);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
  const result = await service.conversation(dot.spaceId, page.id, dot.id);
  expect(result.id).toBe('stable-thread');
  expect(fake.registered).toEqual(['stable-thread']);
  vi.restoreAllMocks();
  ws.close();
});

it('rejects a specialist in another Space before the runner is touched', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const space = ws.createSpace('Other', '');
  const page = ws.pages.create(space.id, { title: 'Other' });
  const getRunner = vi.fn(() => {
    throw new Error('Should not access the runner');
  });
  const service = new PageService(ws, getRunner);
  await expect(service.conversation(space.id, page.id, dot.id)).rejects.toThrow(
    /specialist in this Space/,
  );
  expect(getRunner).not.toHaveBeenCalled();
  ws.close();
});

it('grants multiple Spaces without changing thread identity and enforces revocation', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const other = ws.createSpace('Launch', '');
  const page = ws.pages.create(other.id, { title: 'Brief' });
  ws.updateDot(dot.id, { ...dot, spaceIds: [dot.spaceId, other.id] });
  const fake = fakeRunner([
    { id: 'a', role: 'assistant', content: 'Saved text' },
  ]);
  const service = new PageService(ws, () => fake.runner);
  const thread = await service.conversation(other.id, page.id, dot.id);
  const access = pageAccess(ws, dot.spaceId, thread.id, () => {});
  expect(access.context()?.id).toBe(page.id);
  expect(access.read(page.id).title).toBe('Brief');
  expect(access.spaces()).toHaveLength(2);
  expect(
    (await service.saveConversation(thread.id, 'Copy', null)).spaceId,
  ).toBe(other.id);
  ws.updateDot(dot.id, { ...dot, spaceIds: [dot.spaceId] });
  expect(() => access.read(page.id, other.id)).toThrow(/access/);
  expect(() =>
    access.edit(page.id, { expectedRevision: 1, content: 'No' }, other.id),
  ).toThrow(/access/);
  await expect(service.conversation(other.id, page.id, dot.id)).rejects.toThrow(
    /access/,
  );
  ws.close();
});
