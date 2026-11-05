import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';

/**
 * Owner API for local Automatic Learning.
 *
 * The workflow mirrors the hosted feature: enroll conversations in a container,
 * inspect evidence readiness, ask the configured model for skill proposals, then
 * publish or reject them. Nothing is published automatically.
 */
export function learningRoutes(platform: Platform) {
  const app = new Hono();

  const fail = (
    c: { json: (body: unknown, status?: number) => Response },
    error: unknown,
  ) => {
    const message =
      error instanceof Error
        ? error.message
        : 'The Learning request could not be completed.';
    if (/not found/i.test(message)) return c.json({ error: message }, 404);
    if (/already exists/i.test(message)) return c.json({ error: message }, 409);
    if (
      /required|must|invalid|pause|evidence|proposal|available/i.test(message)
    )
      return c.json({ error: message }, 400);
    return c.json(
      {
        error:
          'The Learning request could not be completed. Check the server configuration.',
      },
      503,
    );
  };

  app.get('/learning/containers', (c) =>
    c.json({ containers: platform.learning.listContainers() }),
  );

  app.post('/learning/containers', async (c) => {
    const parsed = z
      .object({
        id: z.string().trim().min(1).max(64),
        name: z.string().trim().min(1).max(80).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Use 1–64 lowercase letters, numbers, and single hyphens for the container ID.',
        },
        400,
      );
    try {
      return c.json(
        platform.learning.createContainer(
          parsed.data.id,
          parsed.data.name ?? parsed.data.id,
        ),
        201,
      );
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get('/learning/containers/:id', (c) => {
    const container = platform.learning.container(c.req.param('id'));
    if (!container)
      return c.json({ error: 'Learning container not found.' }, 404);
    return c.json({
      container: platform.learning.summary(container),
      skills: platform.learning.skills(container.id),
      runs: platform.learning.runs(container.id),
    });
  });

  app.patch('/learning/containers/:id', async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        paused: z.boolean().optional(),
        threshold: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid Learning container settings.' }, 400);
    try {
      return c.json(
        platform.learning.summary(
          platform.learning.updateContainer(c.req.param('id'), parsed.data),
        ),
      );
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get('/learning/containers/:id/evidence', (c) => {
    if (!platform.learning.container(c.req.param('id')))
      return c.json({ error: 'Learning container not found.' }, 404);
    return c.json({
      evidence: platform.learning.evidence(c.req.param('id'), 50).slice(-50),
    });
  });

  app.post('/learning/containers/:id/analyze', async (c) => {
    try {
      const result = await platform.learning.analyze(
        c.req.param('id'),
        c.req.raw.signal,
      );
      return c.json(result);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/learning/skills/:id/actions', async (c) => {
    const parsed = z
      .object({ action: z.enum(['publish', 'reject']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Unknown skill action.' }, 400);
    try {
      return c.json(
        platform.learning.setSkillStatus(
          c.req.param('id'),
          parsed.data.action === 'publish' ? 'published' : 'rejected',
        ),
      );
    } catch (error) {
      return fail(c, error);
    }
  });

  app.delete('/learning/skills/:id', (c) =>
    platform.learning.deleteSkill(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Skill not found.' }, 404),
  );

  return app;
}
