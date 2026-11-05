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
import type { Dot } from '../src/shared/types.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

class ScriptedAgent extends AbstractAgent {
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
        { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: this.text },
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
  const dir = mkdtempSync(join(tmpdir(), 'opendots-dot-delete-'));
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
  return { app, store, workspace, platform, path };
}

const request = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function createDot(
  app: ReturnType<typeof fixture>['app'],
  workspace: WorkspaceStore,
  name: string,
) {
  const spaceId = workspace.spaces()[0].id;
  const response = await app.request(
    '/api/dots',
    request({
      spaceId,
      name,
      instructions: 'Be a specialist.',
      researchAllowed: false,
      memoryAllowed: false,
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as Dot;
}

async function seed(
  platform: ReturnType<typeof fixture>['platform'],
  threadId: string,
  text: string,
) {
  const agent = new ScriptedAgent(text);
  agent.setMessages([{ id: `user-${threadId}`, role: 'user', content: 'Hi' }]);
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

it('deletes a Dot and every related local record while keeping pages', async () => {
  const f = fixture();
  const dot = await createDot(f.app, f.workspace, 'Temporary');
  const conversation = await f.platform.createConversation(dot.id, 'Work');
  await seed(f.platform, conversation.id, 'Done.');
  const page = f.workspace.pages.create(dot.spaceId, { title: 'Kept page' });
  const pageConversation = await f.platform.pages.conversation(
    dot.spaceId,
    page.id,
    dot.id,
  );
  await seed(f.platform, pageConversation.id, 'Page done.');
  f.workspace.setDelegations(f.workspace.dots()[0].id, [dot.id], false);
  expect(f.workspace.canDelegate(f.workspace.dots()[0].id, dot.id)).toBe(true);
  f.workspace.saveCapture(conversation.id, { sample: false, text: 'capture' });
  f.workspace.createCall(conversation.id);
  f.platform.learning.createContainer('research', 'Research');
  f.platform.learning.recordTurn('research', [
    {
      threadId: conversation.id,
      dotId: dot.id,
      messageId: 'evidence-1',
      role: 'user',
      text: 'Learn',
    },
  ]);
  const task = f.store.createTask('Recurring', 3600);
  f.workspace.bindTask(task.id, conversation.id);

  const db = new DatabaseSync(f.path);
  db.prepare(
    'INSERT INTO slack_subscriptions (channelId, threadTs, threadId, createdAt) VALUES (?, ?, ?, ?)',
  ).run('C1', '1.1', conversation.id, Date.now());
  db.prepare(
    'INSERT INTO mcp_connections (id, dotId, name, url, token, tools, error, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
  ).run(
    'conn-1',
    dot.id,
    'Mail',
    'https://mail.invalid/mcp',
    '[]',
    Date.now(),
    Date.now(),
  );
  db.prepare('INSERT INTO mcp_approvals VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'approval-1',
    conversation.id,
    dot.id,
    'conn-1',
    'send',
    '{}',
    Date.now(),
  );
  db.prepare('INSERT INTO computer_permissions VALUES (?, ?)').run(
    dot.id,
    '{"enabled":false}',
  );
  db.prepare('INSERT INTO computer_audit VALUES (?, ?, ?, ?, ?, ?)').run(
    'audit-1',
    dot.id,
    'exec',
    'owner',
    'succeeded',
    Date.now(),
  );
  db.close();

  const response = await f.app.request(`/api/dots/${dot.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    deletedConversations: 2,
    cancelledTasks: 1,
  });

  expect(f.workspace.dots().some((item) => item.id === dot.id)).toBe(false);
  expect(f.workspace.canDelegate(f.workspace.dots()[0].id, dot.id)).toBe(false);
  expect(f.workspace.conversations()).toHaveLength(0);
  expect(f.store.task(task.id)?.status).toBe('cancelled');
  expect(f.workspace.pages.get(dot.spaceId, page.id).title).toBe('Kept page');
  expect(f.platform.learning.evidence('research', 100)).toHaveLength(0);

  const check = new DatabaseSync(f.path);
  try {
    for (const [table, column] of [
      ['thread_bindings', 'dotId'],
      ['agent_threads', 'agentId'],
      ['agent_runs', 'agentId'],
      ['page_threads', 'dotId'],
      ['captures', 'threadId'],
      ['calls', 'threadId'],
      ['task_threads', 'threadId'],
      ['learning_evidence', 'dotId'],
      ['slack_subscriptions', 'threadId'],
      ['mcp_connections', 'dotId'],
      ['mcp_approvals', 'dotId'],
      ['computer_permissions', 'dotId'],
      ['computer_audit', 'dotId'],
      ['dot_spaces', 'dotId'],
    ] as const) {
      const row = check
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`)
        .get(column === 'agentId' ? dot.id : dot.id) as { count: number };
      expect(Number(row.count), table).toBe(0);
    }
    const actions = check
      .prepare('SELECT COUNT(*) AS count FROM mcp_actions WHERE connectionId=?')
      .get('conn-1') as { count: number };
    expect(Number(actions.count)).toBe(0);
    const edges = check
      .prepare(
        'SELECT COUNT(*) AS count FROM dot_delegations WHERE callerDotId=? OR targetDotId=?',
      )
      .get(dot.id, dot.id) as { count: number };
    expect(Number(edges.count)).toBe(0);
  } finally {
    check.close();
  }
});

it('refuses to delete the last Dot', async () => {
  const f = fixture();
  const only = f.workspace.dots()[0];
  const response = await f.app.request(`/api/dots/${only.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(response.status).toBe(409);
  expect(f.workspace.dot(only.id)).toBeDefined();
});

it('refuses to delete a Dot with an active conversation run', async () => {
  const f = fixture();
  await createDot(f.app, f.workspace, 'Second');
  const dot = f.workspace.dots().find((item) => item.name === 'Second')!;
  const conversation = await f.platform.createConversation(dot.id, 'Busy');
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
        runId: 'run-busy',
        state: {},
        context: [],
        messages: agent.messages,
        tools: [],
        forwardedProps: {},
      },
    })
    .subscribe({ error: () => {} });
  const response = await f.app.request(`/api/dots/${dot.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(response.status).toBe(409);
  expect(f.workspace.dot(dot.id)).toBeDefined();
  release();
  await f.platform.runner.stop({ threadId: conversation.id });
  await new Promise((resolve) => setTimeout(resolve, 30));
});

it('returns 404 for an unknown Dot', async () => {
  const f = fixture();
  expect(
    (
      await f.app.request('/api/dots/missing', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
  ).toBe(404);
});
