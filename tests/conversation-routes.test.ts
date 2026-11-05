import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { ConversationPage } from '../src/shared/types.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

class OnceAgent extends AbstractAgent {
  constructor(private text: string) {
    super({ agentId: 'dot-fixture' });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const messageId = `assistant-${input.runId}`;
      for (const event of [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: 'assistant',
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: this.text,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ] as BaseEvent[])
        subscriber.next(event);
      subscriber.complete();
    });
  }
}

class GateAgent extends AbstractAgent {
  constructor(private gate: Promise<void>) {
    super({ agentId: 'dot-fixture' });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      void this.gate.then(() => subscriber.complete());
    });
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-conversations-'));
  const path = join(dir, 'opendots.sqlite');
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, 'owner');
  const ai = {
    provider: 'openai-compatible' as const,
    baseUrl: 'https://unused.invalid/v1',
    apiKey: 'fixture',
    model: 'fixture-model',
    maxOutputTokens: 2200,
  };
  const config = {
    ai,
    databasePath: path,
    webSearchProvider: 'disabled' as const,
    runtimeUrl: '',
    voiceName: 'marin',
  };
  const platform = new Platform(store, workspace, config);
  const background = new Runner(store, {
    mode: 'live' as const,
    apiKey: ai.apiKey,
    model: ai.model,
    baseUrl: ai.baseUrl,
    webSearchProvider: 'disabled' as const,
  });
  const app = createApp({
    store,
    runner: background,
    config: {
      mode: 'live' as const,
      apiKey: ai.apiKey,
      model: ai.model,
      baseUrl: ai.baseUrl,
      webSearchProvider: 'disabled' as const,
    },
    platform,
  });
  resources.push(
    () => platform.runner.close(),
    () => platform.learning.close(),
    () => store.close(),
    () => workspace.close(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  return { app, store, workspace, platform, background, path };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function createConversation(
  app: ReturnType<typeof fixture>['app'],
  dotId: string,
  title: string,
) {
  const response = await app.request(
    '/api/conversations',
    json({ dotId, title }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; title: string };
}

async function seed(
  platform: ReturnType<typeof fixture>['platform'],
  threadId: string,
  text: string,
) {
  const agent = new OnceAgent(text);
  agent.setMessages([
    { id: `user-${threadId}`, role: 'user', content: 'Question' },
  ]);
  await new Promise<void>((resolve, reject) =>
    platform.runner
      .run({
        threadId,
        agent,
        input: {
          threadId,
          runId: `run-${Math.random().toString(36).slice(2)}`,
          state: {},
          context: [],
          messages: agent.messages,
          tools: [],
          forwardedProps: {},
        },
      })
      .subscribe({ error: reject, complete: resolve }),
  );
}

it('lists, renames, archives, restores, searches, and paginates conversations', async () => {
  const f = fixture();
  const dot = f.workspace.dots()[0];
  const first = await createConversation(f.app, dot.id, 'Weekly review');
  await seed(f.platform, first.id, 'Review the launch checklist.');

  const list = await f.app.request('/api/conversations');
  expect(list.status).toBe(200);
  const page = (await list.json()) as ConversationPage;
  expect(page.conversations[0]).toMatchObject({
    id: first.id,
    title: 'Weekly review',
    messageCount: expect.any(Number),
  });
  expect(page.nextCursor).toBeNull();

  const renamed = await f.app.request(`/api/conversations/${first.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Renamed review' }),
  });
  expect(renamed.status).toBe(200);
  expect(f.workspace.conversation(first.id)?.title).toBe('Renamed review');
  expect(f.platform.runner.threadName(first.id)).toBe('Renamed review');

  const archived = await f.app.request(
    `/api/conversations/${first.id}/archive`,
    json({}),
  );
  expect(archived.status).toBe(200);
  const recent = (await (
    await f.app.request('/api/conversations')
  ).json()) as ConversationPage;
  expect(recent.conversations.some((item) => item.id === first.id)).toBe(false);
  const archivedPage = (await (
    await f.app.request('/api/conversations?archived=true')
  ).json()) as ConversationPage;
  expect(archivedPage.conversations.some((item) => item.id === first.id)).toBe(
    true,
  );
  expect(
    f.platform.runner.listThreads().find((thread) => thread.id === first.id)
      ?.archived,
  ).toBe(true);

  const restored = await f.app.request(
    `/api/conversations/${first.id}/unarchive`,
    json({}),
  );
  expect(restored.status).toBe(200);
  expect(f.workspace.conversation(first.id)?.archived).toBe(false);

  const byTitle = (await (
    await f.app.request('/api/conversations?q=Renamed')
  ).json()) as ConversationPage;
  expect(byTitle.conversations.map((item) => item.id)).toContain(first.id);
  const byMessage = (await (
    await f.app.request('/api/conversations?q=launch%20checklist')
  ).json()) as ConversationPage;
  expect(byMessage.conversations.map((item) => item.id)).toContain(first.id);
  const noMatch = (await (
    await f.app.request('/api/conversations?q=zzz-not-present')
  ).json()) as ConversationPage;
  expect(noMatch.conversations).toHaveLength(0);

  for (let index = 0; index < 4; index++)
    await createConversation(f.app, dot.id, `Paged ${index}`);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const query: string = cursor
      ? `/api/conversations?limit=2&cursor=${encodeURIComponent(cursor)}`
      : '/api/conversations?limit=2';
    const chunk = (await (
      await f.app.request(query)
    ).json()) as ConversationPage;
    seen.push(...chunk.conversations.map((item) => item.id));
    cursor = chunk.nextCursor;
    if (!cursor) break;
  }
  expect(new Set(seen).size).toBe(5);
  expect(seen).toContain(first.id);
});

it('rejects a new turn in an archived conversation', async () => {
  const f = fixture();
  const dot = f.workspace.dots()[0];
  const conversation = await createConversation(f.app, dot.id, 'Archived run');
  await f.app.request(
    `/api/conversations/${conversation.id}/archive`,
    json({}),
  );
  const response = await f.app.request(
    `/api/copilotkit/agent/${dot.id}/run`,
    json({
      threadId: conversation.id,
      runId: 'run-archived',
      state: {},
      messages: [{ id: 'u1', role: 'user', content: 'Continue' }],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('archived');
});

it('deletes a conversation and every related local record, keeping its page', async () => {
  const f = fixture();
  const dot = f.workspace.dots()[0];
  const page = f.workspace.pages.create(dot.spaceId, { title: 'Linked page' });
  const conversation = await f.platform.pages.conversation(
    dot.spaceId,
    page.id,
    dot.id,
  );
  await seed(f.platform, conversation.id, 'Saved to the page.');
  f.workspace.saveCapture(conversation.id, { sample: false, text: 'capture' });
  f.workspace.createCall(conversation.id);
  f.platform.learning.createContainer('research', 'Research');
  f.platform.learning.recordTurn('research', [
    {
      threadId: conversation.id,
      dotId: dot.id,
      messageId: 'evidence-1',
      role: 'user',
      text: 'Learn this',
    },
  ]);
  const task = f.store.createTask('Recurring work', 3600);
  f.workspace.bindTask(task.id, conversation.id);
  const extra = new DatabaseSync(f.path);
  extra
    .prepare(
      'INSERT INTO slack_subscriptions (channelId, threadTs, threadId, createdAt) VALUES (?, ?, ?, ?)',
    )
    .run('C1', '1.1', conversation.id, Date.now());
  extra.close();

  const response = await f.app.request(
    `/api/conversations/${conversation.id}`,
    { method: 'DELETE', headers: { 'Content-Type': 'application/json' } },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, cancelledTasks: 1 });

  expect(f.workspace.conversation(conversation.id)).toBeUndefined();
  expect(f.workspace.pages.get(dot.spaceId, page.id).title).toBe('Linked page');
  expect(f.workspace.pages.forThread(conversation.id)).toBeUndefined();
  expect(f.store.task(task.id)?.status).toBe('cancelled');
  expect(f.platform.learning.evidence('research', 100)).toHaveLength(0);

  const db = new DatabaseSync(f.path);
  try {
    for (const [table, column] of [
      ['thread_bindings', 'id'],
      ['agent_threads', 'threadId'],
      ['agent_runs', 'threadId'],
      ['agent_run_events', 'threadId'],
      ['page_reviews', 'threadId'],
      ['page_threads', 'threadId'],
      ['captures', 'threadId'],
      ['calls', 'threadId'],
      ['task_threads', 'threadId'],
      ['learning_evidence', 'threadId'],
      ['slack_subscriptions', 'threadId'],
    ] as const) {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`)
        .get(conversation.id) as { count: number };
      expect(Number(row.count), table).toBe(0);
    }
  } finally {
    db.close();
  }

  const after = await f.app.request(`/api/conversations/${conversation.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(after.status).toBe(404);
});

it('refuses to delete a conversation while a run is active', async () => {
  const f = fixture();
  const dot = f.workspace.dots()[0];
  const conversation = await createConversation(f.app, dot.id, 'Running');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const agent = new GateAgent(gate);
  agent.setMessages([{ id: 'u1', role: 'user', content: 'Hold' }]);
  f.platform.runner
    .run({
      threadId: conversation.id,
      agent,
      input: {
        threadId: conversation.id,
        runId: 'run-active',
        state: {},
        context: [],
        messages: agent.messages,
        tools: [],
        forwardedProps: {},
      },
    })
    .subscribe({ error: () => {} });
  const response = await f.app.request(
    `/api/conversations/${conversation.id}`,
    { method: 'DELETE', headers: { 'Content-Type': 'application/json' } },
  );
  expect(response.status).toBe(409);
  expect(f.workspace.conversation(conversation.id)).toBeDefined();
  release();
  await f.platform.runner.stop({ threadId: conversation.id });
  await new Promise((resolve) => setTimeout(resolve, 30));
});

it('validates conversation management requests and ownership', async () => {
  const f = fixture();
  const dot = f.workspace.dots()[0];
  const conversation = await createConversation(f.app, dot.id, 'Owned');
  expect(
    (
      await f.app.request(`/api/conversations/${conversation.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      })
    ).status,
  ).toBe(400);
  expect((await f.app.request('/api/conversations?limit=1000')).status).toBe(
    400,
  );
  expect(
    (await f.app.request('/api/conversations?q=' + 'x'.repeat(201))).status,
  ).toBe(400);
  expect(
    (
      await f.app.request('/api/conversations/missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Nope' }),
      })
    ).status,
  ).toBe(404);
  expect(
    (await f.app.request('/api/conversations/missing/archive', json({})))
      .status,
  ).toBe(404);
  expect(
    (
      await f.app.request('/api/conversations/missing', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
  ).toBe(404);
});
