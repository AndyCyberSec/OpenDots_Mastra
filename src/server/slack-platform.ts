import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * The narrow Platform surface the Slack adapter needs. Kept separate so the
 * adapter can be unit-tested with a fake platform and no HTTP server.
 */
export interface SlackPlatform {
  workspace: WorkspaceStore;
  store: Store;
  /** Bind a Slack thread to a Dot and register it with the conversation store. */
  bindSlackThread(input: {
    channelId: string;
    threadTs: string;
    threadId: string;
    dotId: string;
    title: string;
  }): void;
  /** Run one turn in the local conversation and return the assistant text. */
  turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string>;
}
