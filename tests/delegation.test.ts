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
import { startFakeModel, type FakeModel } from './fixtures/fake-model.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

function fixture(model: FakeModel) {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-delegation-'));
  const path = join(dir, 'opendots.sqlite');
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, 'owner');
  const ai = {
    provider: 'openai-compatible' as const,
    baseUrl: model.baseUrl,
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
    agentRunTimeoutMs: 5_000,
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
  const caller = workspace.dots()[0];
  const target = workspace.createDot(
    workspace.spaces()[0].id,
    'Developer',
    'Implement requests.',
    false,
    false,
  );
  return { app, store, workspace, platform, caller, target, path };
}

const signal = () => new AbortController().signal;

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

it('persists owner-managed delegation grants and validates targets', async () => {
  const model = await startFakeModel({ text: 'unused' });
  resources.push(() => void model.close());
  const f = fixture(model);
  const body = {
    name: f.caller.name,
    instructions: f.caller.instructions,
    researchAllowed: true,
    memoryAllowed: true,
    delegatesTo: [f.target.id],
    delegationApprovalRequired: false,
  };
  const response = await f.app.request(`/api/dots/${f.caller.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  expect(f.workspace.dot(f.caller.id)?.delegatesTo).toEqual([f.target.id]);
  expect(f.workspace.dot(f.caller.id)?.delegationApprovalRequired).toBe(false);
  expect(f.workspace.canDelegate(f.caller.id, f.target.id)).toBe(true);
  expect(f.workspace.canDelegate(f.target.id, f.caller.id)).toBe(false);

  for (const delegatesTo of [[f.caller.id], ['missing']]) {
    const invalid = await f.app.request(`/api/dots/${f.caller.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, delegatesTo }),
    });
    expect(invalid.status).toBe(400);
  }
  expect(f.workspace.dot(f.caller.id)?.delegatesTo).toEqual([f.target.id]);

  f.workspace.setDelegations(f.caller.id, [], true);
  expect(f.workspace.canDelegate(f.caller.id, f.target.id)).toBe(false);
  expect(f.workspace.dot(f.caller.id)?.delegationApprovalRequired).toBe(true);
});

it('runs a delegated turn in the target inbox without delegation tools', async () => {
  const model = await startFakeModel({ text: 'Target answer.' });
  resources.push(() => void model.close());
  const f = fixture(model);
  f.workspace.setDelegations(f.caller.id, [f.target.id], false);

  const outcome = await f.platform.delegations.delegate({
    callerDotId: f.caller.id,
    callerThreadId: 'caller-thread',
    targetDotId: f.target.id,
    request: 'Implement the task.',
    canApprove: false,
    signal: signal(),
  });
  expect(outcome).toMatchObject({
    status: 'completed',
    text: expect.stringContaining('Target answer'),
    target: { id: f.target.id, name: 'Developer' },
  });
  const threadId = f.platform.delegations.inboxThreadId(
    f.caller.id,
    f.target.id,
  );
  expect(outcome.threadId).toBe(threadId);
  expect(f.workspace.conversation(threadId)?.dotId).toBe(f.target.id);

  const messages = f.platform.runner.getThreadMessages(threadId);
  expect(messages[0].content).toContain('Delegated request from');
  expect(messages[0].metadata).toMatchObject({
    opendotsSource: 'delegation',
    fromDotId: f.caller.id,
  });

  const request = model.requests[0].body as {
    messages: { role: string; content: string }[];
    tools: { function: { name: string } }[];
  };
  expect(
    request.messages.some((message) =>
      String(message.content).includes('Delegated request from'),
    ),
  ).toBe(true);
  expect(request.tools.map((tool) => tool.function.name)).not.toContain(
    'delegate_to_dot',
  );
});

it('refuses delegation without a grant, to itself, or when the target is busy', async () => {
  const model = await startFakeModel({ text: 'unused' });
  resources.push(() => void model.close());
  const f = fixture(model);
  expect(
    await f.platform.delegations.delegate({
      callerDotId: f.caller.id,
      callerThreadId: 'thread',
      targetDotId: f.target.id,
      request: 'Do it',
      canApprove: true,
      signal: signal(),
    }),
  ).toMatchObject({ status: 'unavailable' });
  expect(model.requests).toHaveLength(0);

  f.workspace.setDelegations(f.caller.id, [f.target.id], false);
  expect(
    await f.platform.delegations.delegate({
      callerDotId: f.caller.id,
      callerThreadId: 'thread',
      targetDotId: f.caller.id,
      request: 'Do it',
      canApprove: true,
      signal: signal(),
    }),
  ).toMatchObject({ status: 'unavailable' });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const threadId = f.platform.delegations.inboxThreadId(
    f.caller.id,
    f.target.id,
  );
  const agent = new GateAgent(gate);
  agent.setMessages([{ id: 'u1', role: 'user', content: 'Hold' }]);
  f.platform.runner
    .run({
      threadId,
      agent,
      input: {
        threadId,
        runId: 'run-busy',
        state: {},
        context: [],
        messages: agent.messages,
        tools: [],
        forwardedProps: {},
      },
    })
    .subscribe({ error: () => {} });
  expect(
    await f.platform.delegations.delegate({
      callerDotId: f.caller.id,
      callerThreadId: 'thread',
      targetDotId: f.target.id,
      request: 'Do it',
      canApprove: true,
      signal: signal(),
    }),
  ).toMatchObject({ status: 'busy' });
  expect(model.requests).toHaveLength(0);
  release();
  await f.platform.runner.stop({ threadId });
  await new Promise((resolve) => setTimeout(resolve, 30));
});

it('requires approval, runs once, and records the result', async () => {
  const model = await startFakeModel({ text: 'Approved result.' });
  resources.push(() => void model.close());
  const f = fixture(model);
  f.workspace.setDelegations(f.caller.id, [f.target.id], true);

  const pending = await f.platform.delegations.delegate({
    callerDotId: f.caller.id,
    callerThreadId: 'caller-thread',
    targetDotId: f.target.id,
    request: 'Implement the approved task.',
    canApprove: true,
    signal: signal(),
  });
  expect(pending.status).toBe('approval_required');
  expect(pending.approvalId).toBeTypeOf('string');
  expect(model.requests).toHaveLength(0);

  const view = await f.app.request(
    `/api/delegations/approvals/${pending.approvalId}`,
  );
  expect(view.status).toBe(200);
  expect(await view.json()).toMatchObject({
    caller: { id: f.caller.id },
    target: { id: f.target.id, name: 'Developer' },
    request: 'Implement the approved task.',
    status: 'pending',
  });

  const approved = await f.app.request(
    `/api/delegations/approvals/${pending.approvalId}/actions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    },
  );
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({
    status: 'completed',
    text: expect.stringContaining('Approved result'),
  });
  expect(model.requests).toHaveLength(1);

  // A retry returns the saved result without running the target again.
  const retry = await f.app.request(
    `/api/delegations/approvals/${pending.approvalId}/actions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    },
  );
  expect(await retry.json()).toMatchObject({
    status: 'completed',
    text: expect.stringContaining('Approved result'),
  });
  expect(model.requests).toHaveLength(1);
});

it('declines without running and refuses expired or revoked approvals', async () => {
  const model = await startFakeModel({ text: 'unused' });
  resources.push(() => void model.close());
  const f = fixture(model);
  f.workspace.setDelegations(f.caller.id, [f.target.id], true);

  const declined = await f.platform.delegations.delegate({
    callerDotId: f.caller.id,
    callerThreadId: 'thread',
    targetDotId: f.target.id,
    request: 'Do not run this.',
    canApprove: true,
    signal: signal(),
  });
  expect(
    await f.platform.delegations.decide(
      declined.approvalId!,
      'decline',
      signal(),
    ),
  ).toMatchObject({ status: 'declined' });
  expect(model.requests).toHaveLength(0);
  expect(
    await f.platform.delegations.decide(
      declined.approvalId!,
      'decline',
      signal(),
    ),
  ).toMatchObject({ status: 'declined' });

  const expired = await f.platform.delegations.delegate({
    callerDotId: f.caller.id,
    callerThreadId: 'thread',
    targetDotId: f.target.id,
    request: 'Expired.',
    canApprove: true,
    signal: signal(),
  });
  const db = new DatabaseSync(f.path);
  db.prepare('UPDATE delegation_approvals SET expiresAt=0 WHERE id=?').run(
    expired.approvalId!,
  );
  db.close();
  expect(
    await f.platform.delegations.decide(
      expired.approvalId!,
      'approve',
      signal(),
    ),
  ).toMatchObject({
    status: 'unavailable',
    message: expect.stringContaining('expired'),
  });

  const revoked = await f.platform.delegations.delegate({
    callerDotId: f.caller.id,
    callerThreadId: 'thread',
    targetDotId: f.target.id,
    request: 'Revoked.',
    canApprove: true,
    signal: signal(),
  });
  f.workspace.setDelegations(f.caller.id, [], true);
  expect(
    await f.platform.delegations.decide(
      revoked.approvalId!,
      'approve',
      signal(),
    ),
  ).toMatchObject({
    status: 'unavailable',
    message: expect.stringContaining('revoked'),
  });
  expect(model.requests).toHaveLength(0);
});

it('wires delegate_to_dot into the caller and keeps the target at depth one', async () => {
  const model = await startFakeModel({
    respond(body) {
      const messages = (body.messages ?? []) as {
        role: string;
        content: string;
      }[];
      const text = messages
        .map((message) => String(message.content))
        .join('\n');
      if (text.includes('Delegated request from'))
        return { text: 'Target answer.' };
      if (messages.some((message) => message.role === 'tool'))
        return { text: 'Delegated and done.' };
      return {
        tool: {
          name: 'delegate_to_dot',
          args: { targetDotId: '', request: 'Implement it.' },
        },
      };
    },
  });
  resources.push(() => void model.close());
  // Rebuild with the real target id once known.
  const f = fixture(model);
  f.workspace.setDelegations(f.caller.id, [f.target.id], false);
  model.set({
    respond(body) {
      const messages = (body.messages ?? []) as {
        role: string;
        content: string;
      }[];
      const text = messages
        .map((message) => String(message.content))
        .join('\n');
      if (text.includes('Delegated request from'))
        return { text: 'Target answer.' };
      if (messages.some((message) => message.role === 'tool'))
        return { text: 'Delegated and done.' };
      return {
        tool: {
          name: 'delegate_to_dot',
          args: { targetDotId: f.target.id, request: 'Implement it.' },
        },
      };
    },
  });
  const conversation = await f.platform.createConversation(
    f.caller.id,
    'Delegating',
  );
  const response = await f.app.request(
    `/api/copilotkit/agent/${f.caller.id}/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: conversation.id,
        runId: 'run-delegate',
        state: {},
        messages: [
          { id: 'u1', role: 'user', content: 'Ask the developer to do it.' },
        ],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    },
  );
  const body = await response.text();
  const streamed = [...body.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`) as string)
    .join('');
  expect(response.status).toBe(200);
  expect(streamed).toContain('Delegated and done.');

  const callerRequest = model.requests[0].body as {
    tools: { function: { name: string } }[];
  };
  expect(callerRequest.tools.map((tool) => tool.function.name)).toContain(
    'delegate_to_dot',
  );
  const targetRequest = model.requests[1].body as {
    messages: { role: string; content: string }[];
    tools: { function: { name: string } }[];
  };
  expect(
    targetRequest.messages.some((message) =>
      String(message.content).includes('Delegated request from'),
    ),
  ).toBe(true);
  expect(targetRequest.tools.map((tool) => tool.function.name)).not.toContain(
    'delegate_to_dot',
  );
  expect(JSON.stringify(model.requests[2].body)).toContain('Target answer.');
});
