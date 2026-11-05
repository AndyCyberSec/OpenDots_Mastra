import { expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  SlackService,
  type SlackClient,
  type SlackEvent,
} from '../src/server/slack.js';
import type { SlackPlatform } from '../src/server/slack-platform.js';
import type { SlackSettings } from '../src/server/platform-config.js';

const settings: SlackSettings = {
  botToken: 'xoxb-fixture',
  appToken: 'xapp-fixture',
  channel: 'opendots',
  teamId: 'T_TEAM',
  users: ['U_OWNER'],
};

function fixture(options: { paused?: boolean; turnError?: boolean } = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  if (options.paused) store.updateSettings({ paused: true });
  const bindings: string[] = [];
  const turns: { threadId: string; prompt: string }[] = [];
  const platform: SlackPlatform = {
    workspace,
    store,
    bindSlackThread(input) {
      bindings.push(input.threadId);
      return workspace.bindThread(input.threadId, input.dotId, input.title);
    },
    async turn(threadId, prompt) {
      turns.push({ threadId, prompt });
      if (options.turnError) throw new Error('provider secret leaked');
      return 'Reply from the Dot';
    },
  };
  const posts: { channel: string; threadTs: string; text: string }[] = [];
  const client: SlackClient = {
    authTest: vi.fn(async () => ({ teamId: 'T_TEAM' })),
    resolveChannel: vi.fn(async () => 'C_CHANNEL'),
    postMessage: vi.fn(async (input) => {
      posts.push(input);
    }),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const reports: string[] = [];
  const service = new SlackService(platform, settings, {
    databasePath: ':memory:',
    declared: true,
    client,
    report: (operation, error) => reports.push(`${operation}: ${error}`),
  });
  return {
    store,
    workspace,
    service,
    platform,
    client,
    posts,
    turns,
    bindings,
    reports,
  };
}

const mention = (overrides: Partial<SlackEvent> = {}): SlackEvent => ({
  type: 'app_mention',
  teamId: 'T_TEAM',
  channelId: 'C_CHANNEL',
  userId: 'U_OWNER',
  text: '<@UBOT> Summarize my week',
  ts: '1700000000.000100',
  ...overrides,
});

it('starts, resolves the channel, answers a mention, and subscribes the thread', async () => {
  const f = fixture();
  await f.service.start();
  expect(f.service.status()).toBe('online');
  expect(f.client.resolveChannel).toHaveBeenCalledWith('opendots');

  expect(await f.service.handle(mention())).toBe(true);
  expect(f.turns).toEqual([
    {
      threadId: 'slack:C_CHANNEL:1700000000.000100',
      prompt: 'Summarize my week',
    },
  ]);
  expect(f.posts).toEqual([
    {
      channel: 'C_CHANNEL',
      threadTs: '1700000000.000100',
      text: 'Reply from the Dot',
    },
  ]);
  expect(f.bindings).toEqual(['slack:C_CHANNEL:1700000000.000100']);

  // A later plain message in the subscribed thread continues the conversation.
  expect(
    await f.service.handle(
      mention({
        type: 'message',
        text: 'And tomorrow?',
        ts: '1700000000.000200',
        threadTs: '1700000000.000100',
      }),
    ),
  ).toBe(true);
  expect(f.turns.at(-1)).toMatchObject({ prompt: 'And tomorrow?' });
  expect(f.turns.at(-1)?.threadId).toBe(f.turns[0].threadId);
});

it('ignores other workspaces, channels, users, bots, and unsubscribed threads', async () => {
  const f = fixture();
  await f.service.start();
  expect(await f.service.handle(mention({ teamId: 'T_OTHER' }))).toBe(false);
  expect(await f.service.handle(mention({ channelId: 'C_OTHER' }))).toBe(false);
  expect(await f.service.handle(mention({ userId: 'U_OTHER' }))).toBe(false);
  expect(await f.service.handle(mention({ botId: 'B1' }))).toBe(false);
  expect(await f.service.handle(mention({ subtype: 'message_changed' }))).toBe(
    false,
  );
  expect(
    await f.service.handle(
      mention({
        type: 'message',
        text: 'Not mentioned',
        threadTs: '1700000000.999999',
      }),
    ),
  ).toBe(false);
  expect(f.turns).toHaveLength(0);
});

it('does not answer while the workspace is paused', async () => {
  const f = fixture({ paused: true });
  await f.service.start();
  await f.service.handle(mention());
  expect(f.turns).toHaveLength(0);
  expect(f.posts[0].text).toContain('paused');
});

it('posts a safe error and does not leak provider details', async () => {
  const f = fixture({ turnError: true });
  await f.service.start();
  await f.service.handle(mention());
  expect(f.posts.at(-1)?.text).toContain('couldn’t complete');
  expect(JSON.stringify(f.posts)).not.toContain('provider secret');
  expect(f.reports.join(' ')).toContain('Slack agent run failed');
});

it('serializes turns in the same Slack thread', async () => {
  const f = fixture();
  await f.service.start();
  const started: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  f.platform.turn = async (_threadId, prompt) => {
    started.push(prompt);
    if (started.length === 1) await firstGate;
    return 'Reply';
  };
  const first = f.service.handle(mention({ ts: '1.1' }));
  const second = f.service.handle(
    mention({ type: 'message', text: 'second', ts: '1.2', threadTs: '1.1' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(started).toEqual(['Summarize my week']);
  releaseFirst();
  await Promise.all([first, second]);
  expect(started).toEqual(['Summarize my week', 'second']);
  expect(f.posts).toHaveLength(2);
});

it('reports activation failures without throwing', async () => {
  const f = fixture();
  vi.mocked(f.client.authTest).mockResolvedValueOnce({ teamId: 'T_OTHER' });
  await f.service.start();
  expect(f.service.status()).toBe('activation_failed');
  expect(f.reports.join(' ')).toContain('Slack activation failed');
});

it('does not start when Slack is not configured', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const service = new SlackService(
    {
      workspace,
      store,
      bindSlackThread: () => {
        throw new Error('unused');
      },
      turn: async () => 'unused',
    },
    undefined,
    { databasePath: ':memory:', declared: false, report: () => {} },
  );
  expect(service.status()).toBe('not_configured');
  await service.start();
  expect(service.status()).toBe('not_configured');
  store.close();
  workspace.close();
});
