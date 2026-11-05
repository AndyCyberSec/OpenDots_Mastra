import { createServer, type Server } from 'node:http';

/**
 * A tiny OpenAI-compatible chat-completions server for tests.
 *
 * Automated tests must never call a paid provider. This server speaks the SSE
 * streaming format used by DeepSeek/Ollama/OpenAI-compatible endpoints, and can
 * be told to answer with text, a tool call, an HTTP error, or nothing at all.
 */
interface FakeModelToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeModelOptions {
  text?: string;
  tool?: FakeModelToolCall;
  /** Return this HTTP status instead of a stream. Default 200. */
  status?: number;
  /** Delay the streaming response (ms). */
  delayMs?: number;
}

export interface FakeModel {
  baseUrl: string;
  requests: {
    messages: { role: string; content: unknown }[];
    body: Record<string, unknown>;
  }[];
  set(options: FakeModelOptions): void;
  close(): Promise<void>;
}

export async function startFakeModel(
  options: FakeModelOptions = {},
): Promise<FakeModel> {
  let current: FakeModelOptions = {
    text: 'Hello from the fake model.',
    ...options,
  };
  const requests: FakeModel['requests'] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        parsed = {};
      }
      const messages = Array.isArray(parsed.messages)
        ? (parsed.messages as { role: string; content: unknown }[])
        : [];
      requests.push({ messages, body: parsed });
      if (current.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, current.delayMs));
      }
      if (current.status && current.status !== 200) {
        response.writeHead(current.status, {
          'content-type': 'application/json',
        });
        response.end(JSON.stringify({ error: { message: 'fixture failure' } }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const chunk = (choices: unknown, extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices,
          ...extra,
        })}\n\n`;
      const usage = {
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      };
      response.write(
        chunk([
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          },
        ]),
      );
      const hasToolResult = messages.some((message) => message.role === 'tool');
      if (current.tool && !hasToolResult) {
        response.write(
          chunk([
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_fixture',
                    type: 'function',
                    function: {
                      name: current.tool.name,
                      arguments: JSON.stringify(current.tool.args),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ]),
        );
        response.write(
          chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage),
        );
      } else {
        for (const part of (current.text ?? 'Done.').split(' '))
          response.write(
            chunk([
              { index: 0, delta: { content: `${part} ` }, finish_reason: null },
            ]),
          );
        response.write(
          chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], usage),
        );
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fake model failed to bind.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    set(options) {
      current = options;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
