import { createTool } from '@mastra/core/tools';
import { jsonSchema } from '@mastra/schema-compat';
import type { ZodType } from 'zod';

/**
 * Framework-neutral tool definitions.
 *
 * OpenDots tools are declared once with a name, description, JSON-schema or Zod
 * parameters, and an executor. Mastra wraps them for the agent loop; the AG-UI
 * bridge receives only names and JSON schemas. Keeping this small type free of
 * framework imports means page/connection/computer/Composio modules do not
 * depend on any agent SDK.
 */

export type ToolParameters = ZodType | Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute?: (input: unknown, ...rest: unknown[]) => unknown;
}

type ToolExecutor = (input: unknown, signal: AbortSignal) => unknown;

type ExecutorInput<P> =
  P extends ZodType<infer T> ? T : Record<string, unknown>;

export function defineTool<P extends ToolParameters>(definition: {
  name: string;
  description: string;
  parameters: P;
  execute: (input: ExecutorInput<P>) => unknown;
}): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

function isZod(value: ToolParameters): value is ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    'safeParse' in value &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/**
 * Convert OpenDots tools to Mastra tools.
 *
 * Tool failures are reported to the model as `{ error }` rather than thrown:
 * an unreachable service or a revoked permission should end that tool call, not
 * the whole conversation turn (matching OpenDots' pre-migration behaviour).
 */
export function mastraTools(
  definitions: ToolDefinition[],
  signal: AbortSignal,
): Record<string, ReturnType<typeof createTool>> {
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const definition of definitions) {
    const execute = definition.execute;
    if (!execute)
      throw new Error(`Server tool has no executor: ${definition.name}`);
    tools[definition.name] = createTool({
      id: definition.name,
      description: definition.description,
      inputSchema: isZod(definition.parameters)
        ? definition.parameters
        : jsonSchema(definition.parameters),
      execute: async (input: unknown) => {
        signal.throwIfAborted();
        return (execute as unknown as ToolExecutor)(input, signal);
      },
    });
  }
  return tools;
}
