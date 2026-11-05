import { DatabaseSync } from 'node:sqlite';
import { WebClient } from '@slack/web-api';
import { migrate } from './db.js';
import type { SlackSettings } from './platform-config.js';
import type { SlackPlatform } from './slack-platform.js';
import { safeFailure } from './safe-failure.js';

/**
 * Direct Slack integration (Socket Mode + Web API).
 *
 * The upstream template used CopilotKit Intelligence Channels, which managed the
 * Slack adapter, entitlements, and delivery. This adapter is local: it validates
 * the workspace and user allowlist, maps a Slack thread to one local
 * conversation, and runs the same Dot agent (through the durable runner) that
 * the web app uses. No public HTTPS endpoint is required and no Intelligence
 * credential is involved.
 *
 * Tests inject a fake `SlackClient`; production uses `@slack/web-api` and
 * `@slack/socket-mode`.
 */

export type SlackConnectionStatus =
  | 'not_configured'
  | 'setup_required'
  | 'starting'
  | 'online'
  | 'activation_failed';

export interface SlackEvent {
  type: 'app_mention' | 'message';
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
}

export interface SlackClient {
  authTest(): Promise<{ teamId: string }>;
  resolveChannel(channel: string): Promise<string>;
  postMessage(input: {
    channel: string;
    threadTs: string;
    text: string;
  }): Promise<void>;
  start(handler: (event: SlackEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

type Report = (operation: string, error: string) => void;

const SLACK_MENTION = /<@[A-Z0-9]+>/gi;

export class SlackService {
  private client?: SlackClient;
  private channelId?: string;
  private state: SlackConnectionStatus;
  private started = false;
  private subscriptions?: DatabaseSync;
  private queues = new Map<string, Promise<void>>();
  private report: Report;

  constructor(
    private platform: SlackPlatform,
    readonly settings: SlackSettings | undefined,
    private options: {
      databasePath: string;
      declared: boolean;
      client?: SlackClient;
      report?: Report;
      turnTimeoutMs?: number;
    },
  ) {
    this.state = settings
      ? 'starting'
      : options.declared
        ? 'setup_required'
        : 'not_configured';
    this.report =
      options.report ??
      ((operation, error) => console.error(`${operation}: ${error}`));
    this.client = options.client;
  }

  status() {
    return this.state;
  }

  /** Resolve the channel and start receiving Socket Mode events. */
  async start() {
    if (this.started || !this.settings) return;
    this.started = true;
    this.state = 'starting';
    try {
      const client =
        this.client ?? (await createProductionClient(this.settings));
      this.client = client;
      const auth = await client.authTest();
      if (auth.teamId && auth.teamId !== this.settings.teamId)
        throw new Error('Slack workspace does not match SLACK_TEAM_ID.');
      this.channelId = await client.resolveChannel(this.settings.channel);
      await client.start(async (event) => {
        await this.handle(event).catch((error) =>
          this.report('Slack event handling failed', safeFailure(error)),
        );
      });
      this.state = 'online';
    } catch (error) {
      this.state = 'activation_failed';
      this.report('Slack activation failed', safeFailure(error));
    }
  }

  async stop() {
    this.started = false;
    try {
      await this.client?.stop();
    } catch (error) {
      this.report('Slack stop failed', safeFailure(error));
    } finally {
      this.subscriptions?.close();
      this.subscriptions = undefined;
    }
  }

  private eligible(event: SlackEvent): boolean {
    if (!this.settings || !this.channelId) return false;
    if (event.teamId !== this.settings.teamId) return false;
    if (event.channelId !== this.channelId) return false;
    if (!this.settings.users.includes(event.userId)) return false;
    if (event.botId || (event.subtype && event.subtype !== 'thread_broadcast'))
      return false;
    return event.text.trim().length > 0;
  }

  private db(): DatabaseSync {
    if (!this.subscriptions) {
      const db = new DatabaseSync(this.options.databasePath);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      migrate(db);
      this.subscriptions = db;
    }
    return this.subscriptions;
  }

  private subscribed(channelId: string, threadTs: string): boolean {
    return !!this.db()
      .prepare(
        'SELECT 1 FROM slack_subscriptions WHERE channelId=? AND threadTs=?',
      )
      .get(channelId, threadTs);
  }

  private subscribe(channelId: string, threadTs: string, threadId: string) {
    this.db()
      .prepare(
        'INSERT OR IGNORE INTO slack_subscriptions (channelId, threadTs, threadId, createdAt) VALUES (?, ?, ?, ?)',
      )
      .run(channelId, threadTs, threadId, Date.now());
  }

  /**
   * One Slack event. Mentions always answer and subscribe the thread; plain
   * messages continue only threads the owner already mentioned the bot in,
   * matching the upstream "subscribe on mention" behaviour.
   */
  async handle(event: SlackEvent) {
    if (!this.eligible(event)) return false;
    const settings = this.settings!;
    const dotId = settings.dotId ?? this.platform.workspace.dots()[0]?.id;
    if (!dotId) return false;
    if (!this.platform.workspace.dot(dotId)) {
      this.report('Slack Dot is unavailable', 'Dot not found');
      return false;
    }
    const threadTs = event.threadTs ?? event.ts;
    if (event.type === 'message' && !this.subscribed(event.channelId, threadTs))
      return false;
    const threadId = `slack:${event.channelId}:${threadTs}`;
    const text = event.text.replace(SLACK_MENTION, '').trim();
    if (!text) return false;

    if (!this.subscribed(event.channelId, threadTs)) {
      this.platform.bindSlackThread({
        channelId: event.channelId,
        threadTs,
        threadId,
        dotId,
        title: `Slack: ${text.slice(0, 80)}`,
      });
      this.subscribe(event.channelId, threadTs, threadId);
    }

    await this.enqueue(threadId, async () => {
      if (this.platform.store.settings().paused) {
        await this.post(
          event.channelId,
          threadTs,
          'OpenDots is paused. Resume it in the app before asking me to continue.',
        );
        return;
      }
      try {
        const signal = AbortSignal.timeout(
          this.options.turnTimeoutMs ?? 120_000,
        );
        const reply = await this.platform.turn(threadId, text, signal, {
          opendotsSource: 'slack',
        });
        await this.post(event.channelId, threadTs, reply);
      } catch (error) {
        this.report(
          'Slack agent run failed; error reply posted',
          safeFailure(error),
        );
        await this.post(
          event.channelId,
          threadTs,
          'I couldn’t complete that request. Please check OpenDots and send a new message when you’re ready to try again.',
        ).catch((postError) =>
          this.report('Slack error reply failed', safeFailure(postError)),
        );
      }
    });
    return true;
  }

  private enqueue(key: string, task: () => Promise<void>) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task).catch((error) => {
      this.report('Slack queue failed', safeFailure(error));
    });
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  private async post(channelId: string, threadTs: string, text: string) {
    if (!this.client) throw new Error('Slack client is not connected.');
    await this.client.postMessage({ channel: channelId, threadTs, text });
  }
}

/** Production client: Web API for posting, Socket Mode for events. */
async function createProductionClient(
  settings: SlackSettings,
): Promise<SlackClient> {
  const web = new WebClient(settings.botToken);
  const { SocketModeClient } = await import('@slack/socket-mode');
  const socket = new SocketModeClient({ appToken: settings.appToken });
  return {
    async authTest() {
      const result = await web.auth.test();
      return { teamId: String(result.team_id ?? '') };
    },
    async resolveChannel(channel: string) {
      if (/^[CGD][A-Z0-9]{6,}$/.test(channel)) return channel;
      let cursor: string | undefined;
      do {
        const response = await web.conversations.list({
          types: 'public_channel,private_channel',
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        const match = response.channels?.find(
          (candidate) => candidate.name === channel.replace(/^#/, ''),
        );
        if (match?.id) return String(match.id);
        cursor = response.response_metadata?.next_cursor ?? undefined;
      } while (cursor);
      throw new Error('Slack channel was not found.');
    },
    async postMessage({ channel, threadTs, text }) {
      await web.chat.postMessage({ channel, thread_ts: threadTs, text });
    },
    async start(handler) {
      const wrap =
        (type: SlackEvent['type']) =>
        async ({
          event,
          ack,
        }: {
          event: Record<string, unknown>;
          ack: () => Promise<void>;
        }) => {
          await ack();
          await handler({
            type,
            teamId: String(event.team ?? ''),
            channelId: String(event.channel ?? ''),
            userId: String(event.user ?? ''),
            text: String(event.text ?? ''),
            ts: String(event.ts ?? ''),
            ...(typeof event.thread_ts === 'string'
              ? { threadTs: event.thread_ts }
              : {}),
            ...(typeof event.subtype === 'string'
              ? { subtype: event.subtype }
              : {}),
            ...(typeof event.bot_id === 'string'
              ? { botId: event.bot_id }
              : {}),
          });
        };
      socket.on('app_mention', wrap('app_mention'));
      socket.on('message', wrap('message'));
      await socket.start();
    },
    async stop() {
      await socket.disconnect();
    },
  };
}
