import express from 'express';
import helmet from 'helmet';
import { tenantContextSchema } from '../foundation/contracts.js';
import { decode, json, instant, fail, checkGraph } from './core.js';
export function createRuntimeApi({
  repository,
  scheduler,
  authenticate,
  authorize,
  ready = async () => true,
  draining = () => false,
  registerRoutes,
}) {
  if (typeof authenticate !== 'function' || typeof authorize !== 'function')
    fail('MISSING_AUTHORIZATION_PORT');
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '3mb' }));
  app.get('/api/health', async (req, res) =>
    res
      .status((await ready()) && !draining() ? 200 : 503)
      .json({ profile: 'production', runtimeIntegrated: true, draining: draining() }),
  );
  const router = express.Router({ mergeParams: true });
  router.use(async (req, res, next) => {
    try {
      const context = tenantContextSchema.parse(await authenticate(req));
      if (
        context.workspaceId !== req.params.wid ||
        !(await authorize(context, { operation: 'api', method: req.method, path: req.path }))
      )
        fail('FORBIDDEN');
      req.context = context;
      next();
    } catch (e) {
      next(e);
    }
  });
  router.get('/workflows', async (req, res) =>
    res.json(
      await repository.tx(req.context, (s) =>
        s.all(
          'SELECT id,name,description,graph,revision,created_at,updated_at FROM relay.workflows WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 1000',
          [req.context.workspaceId],
        ),
      ),
    ),
  );
  router.post('/workflows', async (req, res) =>
    res.status(201).json({ id: await repository.createWorkflow(req.context, req.body) }),
  );
  router.put('/workflows/:id', async (req, res) => {
    checkGraph(req.body.graph);
    await repository.tx(req.context, async (s) => {
      const updated = await s.one(
        'UPDATE relay.workflows SET name=$3,graph=$4,revision=revision+1,updated_at=$5 WHERE id=$1 AND workspace_id=$2 RETURNING id',
        [req.params.id, req.context.workspaceId, req.body.name, json(req.body.graph), instant()],
      );
      if (!updated) fail('NOT_FOUND');
    });
    res.json({ ok: true });
  });
  router.post('/workflows/:id/publish', async (req, res) =>
    res.json({ id: await repository.publish(req.context, req.params.id) }),
  );
  router.get('/workflows/:id/versions', async (req, res) =>
    res.json(
      await repository.tx(req.context, (s) =>
        s.all(
          'SELECT id,workflow_id,revision,name,graph,created_at FROM relay.versions WHERE workflow_id=$1 AND workspace_id=$2 ORDER BY revision DESC',
          [req.params.id, req.context.workspaceId],
        ),
      ),
    ),
  );
  router.post('/runs', async (req, res) =>
    res.status(202).json({ id: await repository.createRun(req.context, req.body) }),
  );
  router.get('/runs', async (req, res) =>
    res.json(
      await repository.tx(req.context, (s) =>
        s.all(
          'SELECT id,workflow_id,status,created_at,finished_at,error FROM relay.runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1000',
          [req.context.workspaceId],
        ),
      ),
    ),
  );
  router.get('/runs/:id', async (req, res) => {
    const run = await repository.getRun(req.context, req.params.id);
    if (!run) fail('NOT_FOUND');
    res.json({
      ...run,
      graph: decode(run.graph),
      input: decode(run.input),
      output: decode(run.output),
      usage: decode(run.usage),
      steps: await repository.getSteps(req.context, run.id),
    });
  });
  router.get('/runs/:id/events', async (req, res) => {
    const after = Number(req.query.after || 0);
    if (!Number.isSafeInteger(after) || after < 0) fail('VALIDATION_ERROR');
    res.json(
      (await repository.events(req.context, req.params.id, after)).map((row) => ({
        ...row,
        data: decode(row.data),
      })),
    );
  });
  router.post('/runs/:id/cancel', async (req, res) => {
    await repository.cancel(req.context, req.params.id);
    res.json({ ok: true });
  });
  router.post('/runs/:id/retry', async (req, res) => {
    if (!(await authorize(req.context, { operation: 'recover', runId: req.params.id })))
      fail('FORBIDDEN');
    await repository.retry(req.context, req.params.id);
    res.json({ ok: true });
  });
  router.get('/runs/:id/approvals', async (req, res) =>
    res.json(
      await repository.tx(req.context, (s) =>
        s.all(
          'SELECT id,action_id,step_id,argument_hash,arguments,status,created_at FROM relay.runtime_approvals WHERE run_id=$1 AND workspace_id=$2 ORDER BY created_at',
          [req.params.id, req.context.workspaceId],
        ),
      ),
    ),
  );
  router.post('/approvals/:id/decision', async (req, res) => {
    if (
      typeof req.body.approved !== 'boolean' ||
      !(await authorize(req.context, { operation: 'approve', approvalId: req.params.id }))
    )
      fail('FORBIDDEN');
    await repository.decide(req.context, req.params.id, req.body.argumentHash, req.body.approved);
    res.json({ ok: true });
  });
  router.get('/runs/:id/actions', async (req, res) =>
    res.json(
      await repository.tx(req.context, (s) =>
        s.all(
          'SELECT id,tool_id,status,argument_hash,arguments,result,provider_request_id,resolution FROM relay.actions WHERE run_id=$1 AND workspace_id=$2 ORDER BY created_at',
          [req.params.id, req.context.workspaceId],
        ),
      ),
    ),
  );
  router.post('/actions/:id/reconcile', async (req, res) => {
    if (!(await authorize(req.context, { operation: 'reconcile', actionId: req.params.id })))
      fail('FORBIDDEN');
    await repository.reconcile(
      req.context,
      req.params.id,
      req.body.status,
      req.body.result,
      req.body.note,
    );
    res.json({ ok: true });
  });
  router.get('/dead-letters', async (req, res) => {
    if (!(await authorize(req.context, { operation: 'recover' }))) fail('FORBIDDEN');
    res.json(
      await repository.tx(req.context, (s) =>
        s.all(
          'SELECT * FROM relay.runtime_dead_letters WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1000',
          [req.context.workspaceId],
        ),
      ),
    );
  });
  router.post('/schedules', async (req, res) =>
    res.status(201).json({ id: await scheduler.create(req.context, req.body) }),
  );
  router.get('/schedules', async (req, res) =>
    res.json(
      await repository.tx(req.context, (s) =>
        s.all(
          'SELECT id,name,workflow_id,version_id,enabled,next_at,cron_expression,timezone,last_run_id FROM relay.schedules WHERE workspace_id=$1 ORDER BY created_at',
          [req.context.workspaceId],
        ),
      ),
    ),
  );
  router.post('/schedules/:id/disable', async (req, res) => {
    await repository.tx(req.context, (s) =>
      s.query('UPDATE relay.schedules SET enabled=0 WHERE workspace_id=$1 AND id=$2', [
        req.context.workspaceId,
        req.params.id,
      ]),
    );
    res.json({ ok: true });
  });
  router.put('/runtime/capacity', async (req, res) => {
    const { maxRunning, maxQueued } = req.body;
    if (
      !Number.isInteger(maxRunning) ||
      maxRunning < 1 ||
      maxRunning > 128 ||
      !Number.isInteger(maxQueued) ||
      maxQueued < 1 ||
      maxQueued > 100000
    )
      fail('INVALID_LIMITS');
    if (!(await authorize(req.context, { operation: 'admin' }))) fail('FORBIDDEN');
    await repository.tx(req.context, (s) =>
      s.query(
        'INSERT INTO relay.runtime_capacity(workspace_id,max_running,max_queued) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET max_running=$2,max_queued=$3',
        [req.context.workspaceId, maxRunning, maxQueued],
      ),
    );
    res.json({ ok: true });
  });
  app.use('/api/w/:wid', router);
  registerRoutes?.(app, { repository, scheduler });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const code = error.code || 'INTERNAL_ERROR';
    const status = ['NOT_FOUND'].includes(code)
      ? 404
      : ['FORBIDDEN', 'APPROVAL_REQUIRED'].includes(code)
        ? 403
        : ['BACKPRESSURE'].includes(code)
          ? 429
          : code.includes('CONFLICT')
            ? 409
            : code.startsWith('INVALID') || code === 'VALIDATION_ERROR'
              ? 400
              : 500;
    res.status(status).json({
      error: status === 500 ? 'Runtime operation failed.' : code,
      code,
      requestId: req.context?.requestId,
    });
  });
  return app;
}
