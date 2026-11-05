import { EventType } from '@ag-ui/core';
import { z } from 'zod';

/**
 * Local-only setup events.
 *
 * The pre-migration build buffered setup/activation events and delivered them to
 * CopilotKit's telemetry endpoint. Self-hosted OpenDots sends nothing anywhere:
 * `SetupTelemetry` keeps the same small API the routes and Dot agent use, but
 * events are dropped in-process. No identifiers, prompts, or usage data leave
 * the machine. See docs/MASTRA_MIGRATION.md.
 */
const step = z.enum(['setup_required', 'ready', 'settings']);
const viewed = z.object({ kind: z.literal('step_viewed'), step }).strict();
const abandoned = z
  .object({ kind: z.literal('setup_abandoned'), step })
  .strict();
export const setupInputSchema = z.discriminatedUnion('kind', [
  viewed,
  abandoned,
]);
const eventSchema = z.discriminatedUnion('kind', [
  viewed,
  abandoned,
  z.object({ kind: z.literal('activated') }).strict(),
  z
    .object({
      kind: z.literal('setup_failed'),
      step,
      error_class: z.enum([
        'configuration_missing',
        'assistant_run_failed',
        'channel_start_failed',
      ]),
    })
    .strict(),
]);
export type SetupEvent = z.infer<typeof eventSchema>;

export class SetupTelemetry {
  /** Retained for API compatibility; never sent anywhere. */
  readonly identity = 'local';

  capture(input: SetupEvent): void {
    // Validate for route safety; discard rather than transmit.
    eventSchema.safeParse(input);
  }

  start(): void {}

  async stop(): Promise<void> {}
}

/** Observes whether a turn produced a real answer, for local setup UX. */
export function answerObserver(capture: (event: SetupEvent) => void) {
  let text = false;
  const assistantMessages = new Set<string>();
  let failed = false;
  return (event: {
    type: string;
    delta?: string;
    message?: string;
    messageId?: string;
    role?: string;
  }) => {
    if (
      event.type === EventType.TEXT_MESSAGE_START &&
      event.role === 'assistant' &&
      event.messageId
    )
      assistantMessages.add(event.messageId);
    if (
      event.type === EventType.TEXT_MESSAGE_CONTENT &&
      event.messageId &&
      assistantMessages.has(event.messageId) &&
      event.delta?.trim()
    )
      text = true;
    if (event.type === EventType.RUN_ERROR && !failed) {
      failed = true;
      capture({
        kind: 'setup_failed',
        step: 'ready',
        error_class: 'assistant_run_failed',
      });
    }
    if (event.type === EventType.RUN_FINISHED && text && !failed)
      capture({ kind: 'activated' });
  };
}
