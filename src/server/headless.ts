import type { Message } from '@ag-ui/core';

/**
 * Assistant text from the newest turn, used by voice compute, scheduled tasks,
 * and the direct Slack adapter. All of those run through the same durable,
 * local conversation store as web chat.
 */
export function currentTurnText(messages: Message[], error?: Error): string {
  if (error) throw error;
  const content = messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error('The current compute turn returned no assistant response.');
  return content;
}
