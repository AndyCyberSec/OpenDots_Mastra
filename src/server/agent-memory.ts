import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';

/**
 * Mastra's model-facing memory, backed by the same local SQLite file.
 *
 * Mastra keeps its state in namespaced `mastra_*` tables, so the OpenDots
 * workspace tables (Spaces, Dots, pages, conversations) are untouched. The
 * client-visible transcript lives in `agent_threads` / `agent_runs`
 * (see `agent-runner.ts`); this memory store is what gives the model continuity
 * across turns through Mastra's `lastMessages` window.
 *
 * Semantic recall needs an embedding model. It stays off unless
 * embeddings are not migrated: DeepSeek does not serve an embedding model, and
 * silently degrading to keyword search would be misleading. The migration notes
 * document how to add a local embedder.
 * Working memory is off: OpenDots already has an explicit owner-curated
 * memory list, and silently rewriting a hidden profile would duplicate it.
 */
export interface AgentMemoryOptions {
  databasePath: string;
  lastMessages?: number;
}

export function createAgentMemory(
  options: AgentMemoryOptions,
): Memory | undefined {
  // A `:memory:` database is per-connection; Mastra's pooled libsql client would
  // see an empty database on every turn, so local tests run without it.
  if (options.databasePath === ':memory:') return undefined;
  const url = `file:${options.databasePath}`;
  const storage = new LibSQLStore({ id: 'opendots-memory', url });
  return new Memory({
    storage,
    options: {
      lastMessages: options.lastMessages ?? 40,
      semanticRecall: false,
      workingMemory: { enabled: false },
    },
  });
}
