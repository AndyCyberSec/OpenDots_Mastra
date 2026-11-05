import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';

/**
 * Owner API for Dot-to-Dot delegation approvals.
 *
 * `delegate_to_dot` creates a pending approval only when the caller Dot requires
 * one. The card in chat reads the exact request here, then approves or declines.
 * Approving claims the request atomically and runs the target Dot's turn once.
 */
export function delegationRoutes(platform: Platform) {
  const app = new Hono();

  app.get('/delegations/approvals/:id', (c) => {
    const view = platform.delegations.approvalView(c.req.param('id'));
    return view
      ? c.json(view)
      : c.json({ error: 'Delegation request not found.' }, 404);
  });

  app.post('/delegations/approvals/:id/actions', async (c) => {
    const parsed = z
      .object({ action: z.enum(['approve', 'decline']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Unknown delegation action.' }, 400);
    const outcome = await platform.delegations.decide(
      c.req.param('id'),
      parsed.data.action,
      c.req.raw.signal,
    );
    return c.json(outcome);
  });

  return app;
}
