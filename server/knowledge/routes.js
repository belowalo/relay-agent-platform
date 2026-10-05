import { errorEnvelope, PlatformError } from '../foundation/errors.js';
import { ZodError } from 'zod';

// Runtime supplies authenticated context + browser/multipart boundaries. No auth from request JSON.
export function registerKnowledgeRoutes(
  app,
  { pipeline, retrieve, answer, getContext, prefix = '/api/v1/knowledge' },
) {
  const route = (handler) => async (req, res) => {
    let ctx;
    try {
      ctx = await getContext(req);
      const result = await handler(ctx, req);
      res.json(result);
    } catch (error) {
      if (error instanceof ZodError)
        error = new PlatformError('VALIDATION_ERROR', 'Knowledge request failed validation.');
      res.status(error.status || 500).json(errorEnvelope(error, ctx?.requestId));
    }
  };
  app.post(
    prefix + '/documents',
    route((ctx, req) => pipeline.upsert(ctx, req.body)),
  );
  app.delete(
    prefix + '/documents/:id',
    route(async (ctx, req) => {
      await pipeline.delete(ctx, req.params.id);
      return { deleted: true };
    }),
  );
  app.post(
    prefix + '/documents/:id/reindex',
    route((ctx, req) => pipeline.reindex(ctx, req.params.id)),
  );
  app.get(
    prefix + '/jobs/:id',
    route((ctx, req) => pipeline.status(ctx, req.params.id)),
  );
  app.post(
    prefix + '/jobs/:id/cancel',
    route(async (ctx, req) => {
      await pipeline.cancel(ctx, req.params.id);
      return { cancelled: true };
    }),
  );
  app.post(
    prefix + '/collections/:id/search',
    route((ctx, req) => retrieve(ctx, req.params.id, req.body.query, req.body.options)),
  );
  if (answer)
    app.post(
      prefix + '/collections/:id/answer',
      route((ctx, req) => answer(ctx, req.params.id, req.body.question, req.body.options)),
    );
}
