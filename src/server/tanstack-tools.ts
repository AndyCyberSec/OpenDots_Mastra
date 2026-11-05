import { toolDefinition } from '@tanstack/ai';
import type { ToolDefinition } from '@copilotkit/runtime/v2';

/**
 * Convert OpenDots tool definitions to TanStack AI tools.
 *
 * CopilotKit supplies a verified snapshot of the turn (abort signal, client
 * tools) and `defineTool` executors are already bound to it, so this remains the
 * only adapter the TanStack AI agent needs.
 */
export function tanstackTools(tools: ToolDefinition[]) {
  return tools.map(({ name, description, parameters, execute }) => {
    if (!execute) throw new Error(`Server tool has no executor: ${name}`);
    return toolDefinition({
      name,
      description,
      inputSchema: parameters,
    }).server(execute);
  });
}
