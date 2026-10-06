import pg from 'pg';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../foundation/config.js';
import { createPostgresDatabase } from '../foundation/database.js';
import { createJobQueue } from '../foundation/queue.js';
import { createRuntimeRepository } from './repository.js';
import { createRuntimeWorker } from './worker.js';
import { createDispatcher } from './dispatcher.js';
import { createRuntimeScheduler } from './scheduler.js';
import { createRuntimeApi } from './api.js';
import { fail, bestEffortTelemetry } from './core.js';
export async function startProduction({
  config = loadConfig(),
  ports,
  listen = true,
  env = process.env,
} = {}) {
  if (config.profile !== 'production') fail('PRODUCTION_PROFILE_REQUIRED');
  if (!ports) {
    if (!env.RUNTIME_ADAPTER_MODULE) fail('RUNTIME_ADAPTER_MODULE_REQUIRED');
    const module = await import(pathToFileURL(path.resolve(env.RUNTIME_ADAPTER_MODULE)).href);
    ports = await module.createRuntimePorts({ config });
  }
  if (!ports.authenticate || !ports.authorize || !ports.usage) fail('MISSING_RUNTIME_PORTS');
  ports = { ...ports, telemetry: bestEffortTelemetry(ports.telemetry) };
  const database = ports.database || createPostgresDatabase(config),
    queue =
      ports.queue ||
      createJobQueue(config, { onError: (code) => ports.telemetry?.event(code, {}) });
  let discovery,
    transport,
    server,
    timer,
    worker,
    dispatcher,
    closed = false,
    closing;
  try {
    await database.assertApplicationRole();
    await database.transaction(
      {
        workspaceId: 'runtime-readiness',
        actor: { kind: 'service', id: 'runtime' },
        requestId: 'runtime-startup',
      },
      async (s) => {
        const row = await s.one(
          "SELECT EXISTS(SELECT 1 FROM relay.schema_migrations WHERE name='0105-immutable-triggers.sql') AS ready",
        );
        if (!row?.ready) fail('RUNTIME_SCHEMA_NOT_READY');
      },
    );
    await queue.probe();
    const repository = createRuntimeRepository(database, {
      leaseMs: Number(env.RUNTIME_LEASE_MS || 30000),
      snapshotTool: ports.snapshotTool,
      captureTrace: ports.captureTrace,
    });
    const scheduler = createRuntimeScheduler({ repository, authorize: ports.authorize });
    const ready = async () => {
      try {
        return !closed && (await database.probe()) && (await queue.probe());
      } catch {
        return false;
      }
    };
    if (config.role === 'worker') {
      if (!env.RUNTIME_DISPATCH_DATABASE_URL) fail('DISPATCH_DATABASE_URL_REQUIRED');
      discovery = new pg.Pool({ connectionString: env.RUNTIME_DISPATCH_DATABASE_URL, max: 1 });
      discovery.on('error', () => {});
      const listWorkspaces = async () =>
        (await discovery.query('SELECT workspace_id FROM relay.runtime_workspaces()')).rows.map(
          (r) => r.workspace_id,
        );
      worker = createRuntimeWorker({
        repository,
        authorize: ports.authorize,
        usage: ports.usage,
        model: ports.model,
        tools: ports.tools,
        knowledge: ports.knowledge,
        memory: ports.memory,
        telemetry: ports.telemetry,
        leaseMs: Number(env.RUNTIME_LEASE_MS || 30000),
        shutdownMs: config.shutdownTimeoutMs,
        nodeConcurrency: config.workerConcurrency,
      });
      dispatcher = createDispatcher({
        repository,
        queue,
        listWorkspaces,
        onError: (code) => ports.telemetry?.event(code, {}),
      });
      transport = queue.createWorker(async (reference) => {
        const execute = async () => {
          if (reference.kind === 'workflow.run') return worker.execute(reference);
          const handler = ports.jobHandlers?.[reference.kind];
          if (!handler) fail('UNSUPPORTED_JOB_KIND');
          // Domain handler must reload its authoritative record, reauthorize, and fence its own claims.
          await handler(reference);
        };
        return ports.runJob ? ports.runJob(reference, execute) : execute();
      });
      let ticking = false;
      timer = setInterval(async () => {
        if (ticking || closed) return;
        ticking = true;
        try {
          await dispatcher.tick();
          for (const workspaceId of await listWorkspaces()) {
            await ports.maintenance?.({
              workspaceId,
              actor: { kind: 'service', id: 'runtime-dispatcher' },
              requestId: 'domain-maintenance',
            });
            await scheduler.tick({
              workspaceId,
              actor: { kind: 'service', id: 'scheduler' },
              requestId: 'scheduler-tick',
            });
          }
        } catch {
          ports.telemetry?.event('runtime.maintenance.failed', {});
        } finally {
          ticking = false;
        }
      }, 250);
    }
    const app = createRuntimeApi({
      repository,
      scheduler,
      authenticate: ports.authenticate,
      authorize: ports.authorize,
      ready,
      draining: () => closed,
      registerRoutes: ports.registerRoutes,
      installMiddleware: ports.installMiddleware,
      validateWorkflow: ports.validateWorkflow,
      usage: ports.usage,
    });
    if (listen)
      server = await new Promise((resolve, reject) => {
        const http = app.listen(config.port, config.host, () => resolve(http));
        http.on('error', reject);
      });
    async function close() {
      if (closing) return closing;
      closed = true;
      ports.drain?.();
      clearInterval(timer);
      closing = (async () => {
        if (server)
          await new Promise((r) => {
            server.close(r);
            server.closeIdleConnections();
          });
        await dispatcher?.close();
        await worker?.close();
        await transport?.close();
        await queue.close();
        await discovery?.end();
        await database.close();
        await ports.close?.();
      })();
      return closing;
    }
    return { app, repository, worker, dispatcher, scheduler, ready, close };
  } catch (e) {
    clearInterval(timer);
    await transport?.close().catch(() => {});
    await queue.close().catch(() => {});
    await discovery?.end().catch(() => {});
    await database.close().catch(() => {});
    await ports.close?.().catch(() => {});
    throw e;
  }
}
