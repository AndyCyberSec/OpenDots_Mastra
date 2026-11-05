import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';

/**
 * Provider-independent model configuration for the original TanStack AI path.
 *
 * OpenDots talks to any OpenAI-compatible chat-completions endpoint:
 *
 *   AI_PROVIDER=openai-compatible | ollama
 *   AI_BASE_URL=https://api.deepseek.com        (DeepSeek)
 *   AI_BASE_URL=http://127.0.0.1:11434/v1       (Ollama)
 *   AI_API_KEY=...
 *   AI_MODEL=...
 *
 * `OPENAI_*` names are still read for backwards compatibility, and a Dot may
 * override the model with its own `model` column. Nothing is hardcoded:
 * OpenDots never silently switches provider or model, and never sends data
 * anywhere except the configured base URL.
 */

export type AiProvider = 'openai-compatible' | 'ollama';

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
}

const MAX_OUTPUT_TOKENS_DEFAULT = 2200;
const MAX_OUTPUT_TOKENS_LIMIT = 200_000;

export function aiProviderFromEnv(
  env: Record<string, string | undefined>,
): AiProvider {
  const raw = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  if (!raw) return 'openai-compatible';
  if (raw === 'openai-compatible' || raw === 'openai' || raw === 'custom')
    return 'openai-compatible';
  if (raw === 'ollama') return 'ollama';
  throw new Error(
    'AI_PROVIDER must be "openai-compatible" or "ollama". OpenDots does not silently choose a provider.',
  );
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function withoutTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

export function aiSettingsFromEnv(
  env: Record<string, string | undefined>,
): AiSettings | undefined {
  const provider = aiProviderFromEnv(env);
  const model = clean(env.AI_MODEL) ?? clean(env.OPENAI_MODEL);
  const rawBaseUrl = clean(env.AI_BASE_URL) ?? clean(env.OPENAI_BASE_URL);
  const configuredKey = clean(env.AI_API_KEY) ?? clean(env.OPENAI_API_KEY);
  if (!model && !rawBaseUrl && !configuredKey) return undefined;
  const baseUrl =
    rawBaseUrl ??
    (provider === 'ollama'
      ? 'http://127.0.0.1:11434/v1'
      : 'https://api.openai.com/v1');
  // Ollama ignores the key but OpenAI-compatible clients require one.
  const apiKey =
    configuredKey ?? (provider === 'ollama' ? 'ollama' : undefined) ?? '';
  if (!model)
    throw new Error(
      'AI_MODEL (or OPENAI_MODEL) is required when a model provider is configured.',
    );
  if (!apiKey)
    throw new Error(
      'AI_API_KEY (or OPENAI_API_KEY) is required when a model provider is configured.',
    );
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('AI_BASE_URL must be an absolute URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('AI_BASE_URL must use http or https.');
  const rawMax = clean(env.AI_MAX_OUTPUT_TOKENS);
  let maxOutputTokens = MAX_OUTPUT_TOKENS_DEFAULT;
  if (rawMax) {
    const value = Number(rawMax);
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_OUTPUT_TOKENS_LIMIT
    )
      throw new Error(
        `AI_MAX_OUTPUT_TOKENS must be an integer between 1 and ${MAX_OUTPUT_TOKENS_LIMIT}.`,
      );
    maxOutputTokens = value;
  }
  return {
    provider,
    baseUrl: withoutTrailingSlash(baseUrl),
    apiKey,
    model,
    maxOutputTokens,
  };
}

function modelIdFor(settings: AiSettings, override?: string | null): string {
  return (override ?? '').trim() || settings.model;
}

/**
 * The TanStack AI chat adapter used by `BuiltInAgent` and local learning
 * analysis. DeepSeek and Ollama both speak the OpenAI chat-completions shape.
 */
export function chatAdapter(
  settings: AiSettings,
  modelOverride?: string | null,
) {
  return openaiCompatibleText(modelIdFor(settings, modelOverride), {
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl,
    api: 'chat-completions',
    maxRetries: 1,
  });
}
