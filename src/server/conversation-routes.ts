import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import type { Runner } from './runner.js';
import type { Store } from './store.js';

/**
 * Owner-facing conversation management.
 *
 * The CopilotKit runtime only exposes read routes for local threads (the write
 * routes are Intelligence-only), so rename/archive/restore/delete, pagination,
 * and search are application-owned endpoints. Every operation is scoped to the
 * workspace owner and the bound Dot; payloads stay local.
 */
export function conversationRoutes(
  platform: Platform,
  store: Store,
  runner: Runner,
) {
  const app = new Hono();

  const missing = (c: { json: (body: unknown, status?: number) => Response }) =>
    c.json({ error: 'Conversation not found.' }, 404);

  app.get('/conversations', (c) => {
    const url = new URL(c.req.url);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return c.json(
        { error: 'Use a limit between 1 and 100 conversations.' },
        400,
      );
    const query = url.searchParams.get('q') ?? '';
    if (query.length > 200)
      return c.json({ error: 'Search text is too long.' }, 400);
    return c.json(
      platform.workspace.conversationPage({
        limit,
        cursor: url.searchParams.get('cursor') ?? undefined,
        query,
        archived: url.searchParams.get('archived') === 'true',
      }),
    );
  });

  app.patch('/conversations/:id', async (c) => {
    const parsed = z
      .object({ title: z.string().trim().min(1).max(120) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Enter a conversation title.' }, 400);
    try {
      platform.workspace.requireThread(c.req.param('id'));
    } catch {
      return missing(c);
    }
    return c.json(
      platform.workspace.renameConversation(
        c.req.param('id'),
        parsed.data.title,
      ),
    );
  });

  app.post('/conversations/:id/archive', (c) => {
    try {
      return c.json(
        platform.workspace.archiveConversation(c.req.param('id'), true),
      );
    } catch {
      return missing(c);
    }
  });

  app.post('/conversations/:id/unarchive', (c) => {
    try {
      return c.json(
        platform.workspace.archiveConversation(c.req.param('id'), false),
      );
    } catch {
      return missing(c);
    }
  });

  app.delete('/conversations/:id', async (c) => {
    const id = c.req.param('id');
    try {
      platform.workspace.requireThread(id);
    } catch {
      return missing(c);
    }
    if (await platform.runner.isRunning({ threadId: id }))
      return c.json(
        {
          error:
            'Stop this conversation’s current run before deleting it. Nothing was deleted.',
        },
        409,
      );
    // Scheduled tasks bound to this conversation are cancelled before their
    // link row is removed, so they cannot run against a missing conversation.
    const taskIds = platform.workspace.taskIdsForThread(id);
    for (const taskId of taskIds) {
      try {
        runner.abort(taskId);
        store.action(taskId, 'cancel');
      } catch {
        // A task that cannot be cancelled is still unlinked by the deletion.
      }
    }
    if (!platform.workspace.deleteConversation(id)) return missing(c);
    platform.runner.forgetThread(id);
    return c.json({ ok: true, cancelledTasks: taskIds.length });
  });

  return app;
}
