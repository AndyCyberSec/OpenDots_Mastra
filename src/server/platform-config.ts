import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';
import { aiSettingsFromEnv, type AiSettings } from './ai.js';

/**
 * Server configuration.
 *
 * Model access is provider-independent and never hardcoded:
 * `AI_PROVIDER` / `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`, with `OPENAI_*`
 * fallbacks for existing deployments. CopilotKit Intelligence is no longer
 * read, required, or contacted.
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

export interface PlatformConfig extends WebConfig {
  /** Parsed model provider settings; undefined when no provider is configured. */
  ai?: AiSettings;
  /** SQLite file that stores workspace data, conversations, and Mastra memory. */
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
  runtimeUrl: string;
  ownerToken?: string;
}

/** Parse and validate the model provider configuration once at startup. */
export function aiSettings(config: {
  env: Record<string, string | undefined>;
}): { ai?: AiSettings } {
  return { ai: aiSettingsFromEnv(config.env) };
}

const MODEL_KEY_LABEL = 'AI_API_KEY (or OPENAI_API_KEY)';
const MODEL_NAME_LABEL = 'AI_MODEL (or OPENAI_MODEL)';

export function setupStatus(config: PlatformConfig): SetupStatus {
  const missing = [
    !config.ai?.apiKey && MODEL_KEY_LABEL,
    !config.ai?.model && MODEL_NAME_LABEL,
  ].filter((item): item is string => !!item);
  return {
    model: !!config.ai?.model && !!config.ai?.apiKey,
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    missing,
  };
}
