import { expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, mastraTools } from '../src/server/tools.js';

it('converts zod tools to Mastra tools with validated inputs', async () => {
  const signal = new AbortController().signal;
  const tool = defineTool({
    name: 'echo',
    description: 'Echo text',
    parameters: z.object({ text: z.string() }),
    execute: ({ text }) => ({ echoed: text }),
  });
  const tools = mastraTools([tool], signal);
  expect(Object.keys(tools)).toEqual(['echo']);
  await expect(
    (
      tools.echo as unknown as { execute: (input: unknown) => Promise<unknown> }
    ).execute({
      text: 'hello',
    }),
  ).resolves.toEqual({ echoed: 'hello' });
});

it('converts JSON-schema tools used by MCP and Composio', async () => {
  const signal = new AbortController().signal;
  const tool = defineTool({
    name: 'search',
    description: 'Search',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    execute: (input) => ({ received: (input as { query: string }).query }),
  });
  const tools = mastraTools([tool], signal);
  await expect(
    (
      tools.search as unknown as {
        execute: (input: unknown) => Promise<unknown>;
      }
    ).execute({
      query: 'invoices',
    }),
  ).resolves.toEqual({ received: 'invoices' });
});

it('does not run a tool after the turn is aborted', async () => {
  const controller = new AbortController();
  const tool = defineTool({
    name: 'late',
    description: 'Late tool',
    parameters: z.object({}),
    execute: () => ({ ran: true }),
  });
  const tools = mastraTools([tool], controller.signal);
  controller.abort();
  await expect(
    (
      tools.late as unknown as { execute: (input: unknown) => Promise<unknown> }
    ).execute({}),
  ).rejects.toThrow();
});

it('rejects server tools without an executor', () => {
  expect(() =>
    mastraTools(
      [{ name: 'noop', description: 'No executor', parameters: z.object({}) }],
      new AbortController().signal,
    ),
  ).toThrow(/no executor/);
});
