import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';
import { aiSettingsFromEnv, type AiSettings } from './ai.js';

/**
 * Server configuration for the self-hosted build.
 *
 * The only mandatory external dependency is the configured LLM provider.
 * CopilotKit Intelligence is no longer read, required, or contacted.
 */

export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function agentRunTimeoutMsFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.AGENT_RUN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)
    throw new Error(
      `AGENT_RUN_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  return value;
}

export interface SlackSettings {
  /** Bot token (`xoxb-...`) used for Web API calls. */
  botToken: string;
  /** App-level token (`xapp-...`) used for Socket Mode. */
  appToken: string;
  /** Channel name or ID that the bot listens to. */
  channel: string;
  teamId: string;
  users: string[];
  /** Dot that answers Slack messages; defaults to the first Dot. */
  dotId?: string;
}

export function slackSettingsFromEnv(
  env: Record<string, string | undefined>,
): SlackSettings | undefined {
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  const appToken = env.SLACK_APP_TOKEN?.trim();
  const channel =
    env.SLACK_CHANNEL_NAME?.trim() || env.SLACK_CHANNEL_ID?.trim();
  const teamId = env.SLACK_TEAM_ID?.trim();
  const users = (env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!botToken && !appToken && !channel && !teamId && !users.length)
    return undefined;
  if (!botToken || !appToken || !channel || !teamId || !users.length)
    return undefined;
  return {
    botToken,
    appToken,
    channel,
    teamId,
    users,
    dotId: env.SLACK_DOT_ID?.trim() || undefined,
  };
}

export interface LearningConfig {
  /** Maximum evidence rows retained per container. */
  evidenceLimit: number;
}

export function learningConfigFromEnv(
  env: Record<string, string | undefined>,
): LearningConfig {
  const raw = env.LEARNING_EVIDENCE_LIMIT?.trim();
  if (!raw) return { evidenceLimit: 2_000 };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 50 || value > 1_000_000)
    throw new Error(
      'LEARNING_EVIDENCE_LIMIT must be an integer between 50 and 1000000.',
    );
  return { evidenceLimit: value };
}

export interface PlatformConfig extends WebConfig {
  /** Parsed model provider settings; undefined when no provider is configured. */
  ai?: AiSettings;
  /** SQLite file that stores workspace data, conversations, and learning state. */
  databasePath: string;
  agentRunTimeoutMs?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  composioApiKey?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  /** Direct Slack integration (Socket Mode); undefined when not configured. */
  slack?: SlackSettings;
  /** Raw Slack declaration, used to report incomplete configuration. */
  slackDeclared?: boolean;
  learning?: LearningConfig;
  runtimeUrl: string;
  ownerToken?: string;
}

export function aiSettings(config: {
  env: Record<string, string | undefined>;
}): { ai?: AiSettings } {
  return { ai: aiSettingsFromEnv(config.env) };
}

const MODEL_KEY_LABEL = 'AI_API_KEY (or OPENAI_API_KEY)';
const MODEL_NAME_LABEL = 'AI_MODEL (or OPENAI_MODEL)';

export function setupStatus(
  config: PlatformConfig,
  slack: string = config.slack
    ? 'starting'
    : config.slackDeclared
      ? 'setup_required'
      : 'not_configured',
): SetupStatus {
  const missing = [
    !config.ai?.apiKey && MODEL_KEY_LABEL,
    !config.ai?.model && MODEL_NAME_LABEL,
  ].filter((item): item is string => !!item);
  return {
    model: !!config.ai?.model && !!config.ai?.apiKey,
    local: true,
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    slack,
    missing,
  };
}
