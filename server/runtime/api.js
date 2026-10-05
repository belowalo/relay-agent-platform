import express from 'express';
import helmet from 'helmet';
import { tenantContextSchema } from '../foundation/contracts.js';
import { decode, fail, safeCode, publicRow } from './core.js';
export function createRuntimeApi({
  repository,
  scheduler,
  authenticate,
  authorize,
  ready = async () => true,
  draining = () => false,
  registerRoutes,
  installMiddleware,
  validateWorkflow,
  usage,
}) {
  if (typeof authenticate !== 'function' || typeof authorize !== 'function')
    fail('MISSING_AUTHORIZATION_PORT');
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '3mb' }));
  installMiddleware?.(app);
  app.get('/api/health', async (req, res) =>
    res
      .status((await ready()) && !draining() ? 200 : 503)
      .json({ profile: 'production', runtimeIntegrated: true, draining: draining() }),
  );
  const router = express.Router({ mergeParams: true });
  router.use((req, res, next) => {
    const original = res.json.bind(res);
    res.json = (value) => original(Array.isArray(value) ? value.map(publicRow) : publicRow(value));
    next();
  });
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
  router.post('/workflows', async (req, res) => {
    validateWorkflow?.(req.body.graph);
    res.status(201).json({ id: await repository.createWorkflow(req.context, req.body) });
  });
  router.get('/workflows/:id', async (req, res) => {
    const workflow = await repository.tx(req.context, (s) =>
      s.one('SELECT * FROM relay.workflows WHERE id=$1 AND workspace_id=$2', [
        req.params.id,
        req.context.workspaceId,
      ]),
    );
    if (!workflow) fail('NOT_FOUND');
    res.json(workflow);
  });
  router.put('/workflows/:id', async (req, res) => {
    validateWorkflow?.(req.body.graph);
    res.json(await repository.updateWorkflow(req.context, req.params.id, req.body));
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
  router.post('/runs', async (req, res) => {
    const body = { ...req.body };
    body.versionId ||= await repository.publish(req.context, body.workflowId);
    res.status(202).json({ id: await repository.createRun(req.context, body) });
  });
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
    const approvals = await repository.tx(req.context, (s) =>
      s.all(
        "SELECT a.id,a.argument_hash,a.arguments AS input,a.status,s.node_id,t.name AS tool_name FROM relay.runtime_approvals a JOIN relay.steps s ON s.id=a.step_id AND s.workspace_id=a.workspace_id LEFT JOIN relay.actions action ON action.id=a.action_id LEFT JOIN relay.tools t ON t.id=action.tool_id AND t.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND a.run_id=$2 AND a.status='pending' ORDER BY a.created_at",
        [req.context.workspaceId, run.id],
      ),
    );
    const accounting = usage?.report
      ? await repository.tx(req.context, (s) =>
          s.one(
            "SELECT coalesce(sum(tokens) FILTER(WHERE status='settled'),0)::text AS tokens,sum(cost_micros) FILTER(WHERE status='settled')::text AS cost,count(*) FILTER(WHERE status='settled' AND cost_micros IS NULL)::int AS unknown_cost_calls,coalesce(sum(maximum_tokens) FILTER(WHERE status IN('reserved','uncertain')),0)::text AS reserved_tokens FROM relay.security_usage WHERE workspace_id=$1 AND run_id=$2",
            [req.context.workspaceId, run.id],
          ),
        )
      : null;
    res.json({
      ...run,
      runtimeProfile: 'production',
      events: (await repository.events(req.context, run.id)).map(publicRow),
      approvals: approvals.map(publicRow),
      ...(accounting
        ? {
            usage: {
              tokens: Number(accounting.tokens),
              reservedTokens: Number(accounting.reserved_tokens),
              estimatedCost:
                accounting.unknown_cost_calls || accounting.cost === null
                  ? null
                  : Number(accounting.cost) / 1_000_000,
              unknownCostCalls: accounting.unknown_cost_calls,
            },
          }
        : {}),
      steps: (await repository.getSteps(req.context, run.id)).map(publicRow),
    });
  });
  router.get('/runs/:id/events', async (req, res) => {
    let after = Number(req.query.after || req.headers['last-event-id'] || 0);
    if (!Number.isSafeInteger(after) || after < 0) fail('VALIDATION_ERROR');
    if ((req.headers.accept || '').includes('text/event-stream')) {
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      let stopped = false,
        ticking = false;
      const end = () => {
        stopped = true;
        clearInterval(timer);
        res.end();
      };
      const tick = async () => {
        if (stopped || ticking) return;
        ticking = true;
        try {
          const ctx = await authenticate(req);
          if (!(await authorize(ctx, { operation: 'api', method: 'GET', path: '/runs' })))
            return end();
          for (const event of await repository.events(ctx, req.params.id, after)) {
            after = Number(event.sequence);
            res.write(`id: ${after}\ndata: ${JSON.stringify(publicRow(event))}\n\n`);
          }
          res.write(': heartbeat\n\n');
        } catch {
          end();
        } finally {
          ticking = false;
        }
      };
      const timer = setInterval(tick, 1000);
      res.once('close', end);
      tick();
      return;
    }
    res.json(await repository.events(req.context, req.params.id, after));
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
  router.post('/runs/:id/steps/:stepId/usage-reconcile', async (req, res) => {
    if (
      !usage ||
      !(await authorize(req.context, {
        operation: 'reconcile',
        runId: req.params.id,
        stepId: req.params.stepId,
      }))
    )
      fail('FORBIDDEN');
    const { reservationId, resolution, actual, knownNotExecuted } = req.body;
    const run = await repository.getRun(req.context, req.params.id);
    const step = (await repository.getSteps(req.context, req.params.id)).find(
      (s) => s.id === req.params.stepId,
    );
    if (
      !run ||
      !['failed', 'cancelled'].includes(run.status) ||
      decode(step?.checkpoint)?.reservationId !== reservationId
    )
      fail('USAGE_RECONCILIATION_CONFLICT');
    if (resolution === 'settle') {
      if (
        !Number.isSafeInteger(actual?.tokens) ||
        actual.tokens < 0 ||
        !(
          actual.costMicros === null ||
          (Number.isSafeInteger(actual.costMicros) && actual.costMicros >= 0)
        ) ||
        typeof actual.provider !== 'string' ||
        typeof actual.model !== 'string'
      )
        fail('VALIDATION_ERROR');
      await usage.settle(req.context, reservationId, actual);
    } else if (resolution === 'release' && knownNotExecuted === true)
      await usage.release(req.context, reservationId);
    else fail('VALIDATION_ERROR');
    await repository.clearUsageCheckpoint(
      req.context,
      req.params.id,
      req.params.stepId,
      reservationId,
      resolution,
    );
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
  router.post('/schedules', async (req, res) => {
    const body = { ...req.body };
    body.versionId ||= await repository.publish(req.context, body.workflowId);
    res.status(201).json({ id: await scheduler.create(req.context, body) });
  });
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
  registerRoutes?.(app, { repository, scheduler, router });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const code = safeCode(error, 'INTERNAL_ERROR');
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
