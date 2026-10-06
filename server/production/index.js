import pg from 'pg';
import crypto from 'node:crypto';
import cookieParser from 'cookie-parser';
import { createPostgresDatabase } from '../foundation/database.js';
import { createJobQueue } from '../foundation/queue.js';
import { readMigrations } from '../foundation/migrations.js';
import { productionVault } from './vault.js';
import { PlatformError } from '../foundation/errors.js';
import { resourceId } from '../foundation/contracts.js';
import { createSecurityServices, createSecurityMiddleware } from '../security/index.js';
import { createOutboundPolicy, safeFetch, checkURL } from '../network.js';
import { createModelAdapter } from '../connectors/models.js';
import { createConnectionRepository, validateConnectorConfig } from '../connectors/index.js';
import {
  createKnowledgeRepository,
  createKnowledgePipeline,
  createRetriever,
  createKnowledgeSecurity,
  createKnowledgeOutbound,
  createLocalEmbeddings,
  createGroundedAnswer,
} from '../knowledge/index.js';
import { createHealth, registerOperations, requestTelemetry } from '../observability/health.js';
import { createTelemetry, otlpExporter } from '../observability/telemetry.js';
import { createProductionBlobs } from './blobs.js';
import { assertRepositoryRole } from './roles.js';
import { createProductionTools } from './tools.js';
import { registerProductionRoutes, assertNoInlineSecrets } from './routes.js';
import { createProductionParser } from './parser.js';
import { startOperationsSampler } from '../observability/sampler.js';
import { createProductionQuality } from './quality.js';
import { createProductionPublications } from './publications.js';
import { createProductionMemory } from './memory.js';
import { createProductionDocumentSync } from './document-sync.js';
const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
export function runtimePermission(operation) {
  if (['recover', 'reconcile', 'admin'].includes(operation.operation)) return 'workspace.manage';
  if (operation.operation === 'approve') return 'run.approve';
  if (['execute', 'schedule'].includes(operation.operation)) return 'run.execute';
  if (operation.operation !== 'api')
    throw new PlatformError('FORBIDDEN', 'Unknown runtime operation.');
  const read = ['GET', 'HEAD'].includes(operation.method);
  const path = operation.path || '';
  // Read-only retrieval carries a query body; its HTTP verb does not grant write authority.
  if (
    operation.method === 'POST' &&
    /^\/collections\/[a-zA-Z0-9_-]{1,128}\/(search|retrieve)$/.test(path)
  )
    return 'document.read';
  if (/^\/(runtime|dead-letters|actions)/.test(path)) return 'workspace.manage';
  if (/^\/approvals/.test(path)) return 'run.approve';
  if (/^\/runs/.test(path)) return read ? 'run.read' : 'run.execute';
  if (/^\/schedules/.test(path)) return read ? 'workspace.read' : 'run.execute';
  return read ? 'workflow.read' : 'workflow.write';
}
export async function createRuntimePorts({ config, env = process.env }) {
  if (
    (config.role === 'api' && (!env.IDENTITY_DATABASE_URL || !env.RATE_DATABASE_URL)) ||
    !env.METRICS_TOKEN ||
    env.METRICS_TOKEN.length < 32
  )
    throw new Error('PRODUCTION_REPOSITORY_CONFIGURATION_REQUIRED');
  const database = createPostgresDatabase(config);
  const queue = createJobQueue(config);
  let stopSampler;
  const pool = (url) => {
    const p = new pg.Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: config.databaseTimeoutMs,
    });
    p.on('error', () => {});
    return p;
  };
  const identityPool = config.role === 'api' ? pool(env.IDENTITY_DATABASE_URL) : undefined,
    ratePool = config.role === 'api' ? pool(env.RATE_DATABASE_URL) : undefined;
  let blobs,
    embeddings,
    closed = false;
  try {
    await database.assertApplicationRole();
    if (identityPool) await assertRepositoryRole(identityPool, 'identity');
    if (ratePool) await assertRepositoryRole(ratePool, 'rate');
    // App can read identity status, never passwords, sessions or MFA ciphertext.
    await database.transaction(
      { workspaceId: 'startup', actor: { kind: 'service', id: 'startup' }, requestId: 'startup' },
      async (s) => {
        const r = await s.one(
          "SELECT has_column_privilege(current_user,'relay.security_accounts','password_hash','SELECT') OR has_column_privilege(current_user,'relay.security_accounts','mfa_secret','SELECT') OR has_table_privilege(current_user,'relay.security_sessions','SELECT') AS forbidden",
        );
        if (r.forbidden) throw new Error('APPLICATION_IDENTITY_BOUNDARY_REQUIRED');
        const schema = await s.one(
          "SELECT EXISTS(SELECT 1 FROM relay.schema_migrations WHERE name='0500-integration.sql') AS ready",
        );
        if (!schema.ready) throw new Error('INTEGRATION_SCHEMA_REQUIRED');
      },
    );
    const vault = productionVault(config, env);
    const manifest = await readMigrations();
    await database.transaction(
      {
        workspaceId: 'startup',
        actor: { kind: 'service', id: 'schema-check' },
        requestId: 'schema-check',
      },
      async (s) => {
        const applied = new Map(
          (await s.all('SELECT name,checksum FROM relay.schema_migrations')).map((r) => [
            r.name,
            r.checksum,
          ]),
        );
        if (manifest.some((m) => applied.get(m.name) !== m.checksum))
          throw new Error('RELEASE_SCHEMA_REQUIRED');
      },
    );
    let security;
    const tableFor = {
      workflow: 'workflows',
      run: 'runs',
      tool: 'tools',
      collection: 'collections',
      application: 'applications',
      approval: 'runtime_approvals',
      action: 'actions',
    };
    async function resourceLookup(ctx, resource) {
      resourceId.parse(resource.id);
      if (resource.kind === 'document') {
        const source = await knowledgeRepository.getSource(ctx, resource.id);
        return source
          ? { workspaceId: source.workspace_id, access: source.access, disabled: source.deleted }
          : null;
      }
      if (resource.kind === 'connection')
        return database.transaction(ctx, async (s) => {
          const r = await s.one(
            "SELECT id FROM relay.connections WHERE workspace_id=$1 AND id=$2 UNION SELECT id FROM relay.connector_connections WHERE workspace_id=$1 AND id=$2 AND status='active'",
            [ctx.workspaceId, resource.id],
          );
          return r ? { workspaceId: ctx.workspaceId } : null;
        });
      const table = tableFor[resource.kind];
      if (!table) return null;
      return database.transaction(ctx, async (s) => {
        const r = await s.one(`SELECT * FROM relay.${table} WHERE workspace_id=$1 AND id=$2`, [
          ctx.workspaceId,
          resource.id,
        ]);
        if (
          r &&
          resource.kind === 'run' &&
          ctx.actor.kind === 'application' &&
          parse(r.actor)?.id !== ctx.actor.id
        )
          return null;
        return r ? { workspaceId: r.workspace_id, applicationId: r.application_id } : null;
      });
    }
    const knowledgeRepository = createKnowledgeRepository(database);
    security = createSecurityServices({
      database,
      identityPool,
      ratePool,
      vault,
      resourceLookup,
      applicationLookup: async (ctx, id) =>
        database.transaction(ctx, async (s) => {
          const r = await s.one(
            'SELECT id FROM relay.applications WHERE workspace_id=$1 AND id=$2',
            [ctx.workspaceId, id],
          );
          return r ? { workspaceId: ctx.workspaceId, id: r.id } : null;
        }),
      // No HTTP caller can obtain an unrestricted scheduler/dispatcher principal.
      serviceLookup: async () => null,
    });
    const middleware = createSecurityMiddleware(security, { publicOrigin: config.origin });
    const policy = createOutboundPolicy(
      env.OUTBOUND_POLICY_JSON ? JSON.parse(env.OUTBOUND_POLICY_JSON) : {},
    );
    const outbound = {
      authorize: async (_ctx, url) => checkURL(url, policy),
      fetch: (url, options) => safeFetch(url, options, policy),
    };
    const authorizeConnector = async (ctx, request) => {
      const id = request.connectionId || request.secretRef?.connectionId;
      const manage = ['connection.configure', 'connection.disconnect'].includes(request.action);
      await security.authorize(
        ctx,
        manage ? 'secret.manage' : 'connector.invoke',
        manage ? null : { kind: 'connection', id },
      );
    };
    const connections = createConnectionRepository(database, {
      authorize: authorizeConnector,
      validateConfig: validateConnectorConfig,
    });
    const knowledgeSecurity = createKnowledgeSecurity(security, {
      async documentScope(ctx) {
        if (ctx.actor.kind === 'user') return { principalIds: ['user:' + ctx.actor.id] };
        const grant = await security.tokens.lookup(ctx);
        if (!grant) throw new PlatformError('FORBIDDEN', 'Document scope is unavailable.');
        return {
          principalIds: ['application:' + ctx.actor.id],
          sourceIds: grant.resources
            .filter((v) => v.startsWith('document:'))
            .map((v) => v.slice(9)),
        };
      },
    });
    blobs = createProductionBlobs(env, security);
    embeddings = createLocalEmbeddings({
      cacheDir: env.EMBEDDING_CACHE_DIR || '/models',
      allowDownload: false,
    });
    const pipeline = createKnowledgePipeline({
      parse: createProductionParser(env),
      repository: knowledgeRepository,
      blobs,
      security: knowledgeSecurity,
      outbound: createKnowledgeOutbound({ safeFetch, policy }),
      embeddings,
    });
    await embeddings.embed(
      {
        workspaceId: 'startup',
        actor: { kind: 'service', id: 'readiness' },
        requestId: 'readiness',
      },
      ['Validate the offline embedding cache.'],
    );
    const rawRetrieve = createRetriever({
      repository: knowledgeRepository,
      security: knowledgeSecurity,
      embeddings,
    });
    const serviceName = 'relay-' + config.role;
    const telemetry = createTelemetry({
      service: serviceName,
      exporter: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        ? otlpExporter(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, serviceName)
        : undefined,
    });
    const retrieve = (ctx, ...args) =>
      telemetry.span('retrieval', { workspaceId: ctx.workspaceId, requestId: ctx.requestId }, () =>
        rawRetrieve(ctx, ...args),
      );
    const health = createHealth({
      integrated: true,
      probes: {
        database: () => database.probe(),
        queue: () => queue.probe(),
        storage: () => blobs.probe(),
        ...(env.PARSER_ENDPOINT
          ? {
              parser: async () => {
                const r = await fetch(new URL('/health/ready', env.PARSER_ENDPOINT), {
                  signal: AbortSignal.timeout(2000),
                });
                return r.ok && (await r.json()).ready === true;
              },
            }
          : {}),
        ...(identityPool
          ? {
              identity: async () => !!(await identityPool.query('SELECT 1')).rows.length,
              rate: async () => !!(await ratePool.query('SELECT 1')).rows.length,
            }
          : {}),
      },
    });
    let quality;
    const documentSync = createProductionDocumentSync({
      database,
      security,
      connections,
      connectorPorts: toolPortsConnector,
      outbound,
      pipeline,
      knowledgeRepository,
      blobs,
    });
    function toolPortsConnector(...args) {
      return toolPorts.connectorPorts(...args);
    }
    async function modelCall(ctx, { config: options, messages, tools = [], signal, meteredCall }) {
      await security.authorize(ctx, 'run.execute');
      const connection = await database.transaction(ctx, (s) =>
        s.one(
          'SELECT id,provider,endpoint,model,config FROM relay.connections WHERE workspace_id=$1 AND id=$2',
          [ctx.workspaceId, options.connectionId],
        ),
      );
      if (!connection) throw new PlatformError('NOT_FOUND', 'Model connection was not found.');
      const settings = parse(connection.config);
      await security.authorize(ctx, 'secret.resolve', { kind: 'connection', id: connection.id });
      const adapter = createModelAdapter(connection.provider, {
        authorize: authorizeConnector,
        secrets: security.secrets,
        outbound,
      });
      const ceiling =
        Buffer.byteLength(JSON.stringify({ messages, tools })) + Number(options.maxTokens || 2048);
      const prices = [settings.inputPrice, settings.outputPrice];
      const cost = prices.every((p) => Number.isFinite(p) && p >= 0)
        ? Math.ceil(ceiling * Math.max(...prices))
        : null;
      return meteredCall({ maximumTokens: ceiling, maximumCostMicros: cost }, async () => {
        const result = await telemetry.span(
          'provider',
          { workspaceId: ctx.workspaceId, requestId: ctx.requestId },
          () =>
            adapter.invoke(ctx, {
              connection,
              secretRef: settings.secretRef,
              config: options,
              messages,
              tools,
              signal,
            }),
        );
        if (!result.usage.known)
          throw new PlatformError(
            'DEPENDENCY_UNAVAILABLE',
            'Provider did not report usage; reconcile the reservation.',
          );
        return {
          ...result,
          provider: connection.provider,
          model: options.model || connection.model,
          usage: {
            ...result.usage,
            tokens: result.usage.inputTokens + result.usage.outputTokens,
            costMicros: prices.every((p) => Number.isFinite(p) && p >= 0)
              ? Math.ceil(
                  result.usage.inputTokens * prices[0] + result.usage.outputTokens * prices[1],
                )
              : null,
          },
        };
      });
    }
    const toolPorts = createProductionTools({ database, security, connections, outbound });
    async function authorize(ctx, op) {
      try {
        const runId = op.run?.id || op.runId;
        const resource = runId
          ? { kind: 'run', id: runId }
          : op.approvalId
            ? { kind: 'approval', id: op.approvalId }
            : op.actionId
              ? { kind: 'action', id: op.actionId }
              : null;
        await security.authorize(ctx, runtimePermission(op), resource);
        return true;
      } catch (e) {
        if (['FORBIDDEN', 'NOT_FOUND'].includes(e.code)) return false;
        throw e;
      }
    }
    const authenticate = async (req) => {
      const user = await security.identity.authenticate(req.cookies?.relay_session);
      req.user = user;
      await security.rate.consume('api', user.id);
      const ctx = {
        workspaceId: resourceId.parse(req.params.wid),
        actor: { kind: 'user', id: user.id },
        requestId: req.requestId || crypto.randomUUID(),
      };
      await security.authorize(ctx, 'workspace.read');
      return ctx;
    };
    async function resolveIngestion(job) {
      const scope = {
        workspaceId: job.workspaceId,
        actor: { kind: 'service', id: 'ingestion-discovery' },
        requestId: job.requestId,
      };
      const stored = await knowledgeRepository.getJob(scope, job.resourceId);
      if (!stored || stored.id !== job.id)
        throw new PlatformError('FORBIDDEN', 'Ingestion reference is invalid.');
      const ctx = { ...stored.context, requestId: job.requestId };
      await security.authorize(ctx, 'document.write');
      return ctx;
    }
    return {
      authenticate,
      database,
      queue,
      authorize,
      validateWorkflow: assertNoInlineSecrets,
      usage: security.usage,
      model: { call: modelCall },
      tools: {
        ...toolPorts.tools,
        invoke: (ctx, q) =>
          telemetry.span('tool', { workspaceId: ctx.workspaceId, requestId: ctx.requestId }, () =>
            toolPorts.tools.invoke(ctx, q),
          ),
      },
      snapshotTool: toolPorts.snapshotTool,
      captureTrace: () => telemetry.headers().traceparent,
      async runJob(job, callback) {
        const scope = {
          workspaceId: job.workspaceId,
          actor: { kind: 'service', id: 'trace-discovery' },
          requestId: job.requestId,
        };
        const parent =
          job.kind === 'workflow.run'
            ? await database.transaction(scope, (s) =>
                s.one('SELECT traceparent FROM relay.runs WHERE workspace_id=$1 AND id=$2', [
                  job.workspaceId,
                  job.resourceId,
                ]),
              )
            : null;
        return telemetry.job(job, parent?.traceparent, callback);
      },
      knowledge: {
        retrieve: async (ctx, q) =>
          (
            await retrieve(
              ctx,
              q.collectionId,
              q.query,
              { topK: q.topK, mode: q.mode || 'hybrid' },
              { signal: q.signal },
            )
          ).evidence.map((e) => e.citation),
        async answer(ctx, { config: c, question, signal, meteredCall }) {
          if (c.knowledgeIds.length !== 1 || c.toolSnapshots?.length || c.outputSchema)
            throw new PlatformError(
              'VALIDATION_ERROR',
              'Grounded agents use one collection and no tools or custom output schema; compose separate workflow steps.',
            );
          let usage;
          const answer = createGroundedAnswer({
            retrieve,
            security: knowledgeSecurity,
            repository: knowledgeRepository,
            generate: async (_ctx, p) => {
              const r = await modelCall(ctx, {
                config: { ...c, knowledgeIds: [] },
                messages: [
                  { role: 'system', content: p.system },
                  {
                    role: 'user',
                    content: JSON.stringify({ question: p.question, evidence: p.evidence }),
                  },
                ],
                tools: [],
                signal,
                meteredCall,
              });
              usage = r.usage;
              return r.text;
            },
          });
          const result = await answer(
            ctx,
            c.knowledgeIds[0],
            question,
            { topK: c.topK || 4 },
            { signal },
          );
          return {
            ...result,
            toolCalls: [],
            grounded: true,
            usage,
            verifiedNoEvidence: result.insufficient && !result.citations.length,
          };
        },
      },
      memory: createProductionMemory({ database, security }),
      installMiddleware(app) {
        app.set('trust proxy', 1);
        app.use(
          cookieParser(),
          middleware.request,
          middleware.browser,
          requestTelemetry(telemetry),
        );
        if (config.role === 'worker')
          app.use((req, res, next) =>
            req.path.startsWith('/api/') && req.path !== '/api/health'
              ? res.sendStatus(404)
              : next(),
          );
      },
      registerRoutes(app, { repository, router, scheduler }) {
        quality = createProductionQuality({ database, security, repository });
        const publications = createProductionPublications({ database, security, repository });
        registerProductionRoutes(app, {
          router,
          repository,
          scheduler,
          database,
          security,
          authenticate,
          middleware,
          connections,
          connectorPorts: toolPorts.connectorPorts,
          pipeline,
          knowledgeRepository,
          retrieve,
          modelCall,
          config,
          quality,
          publications,
          documentSync,
          workerStats: () => queue.workerStats(),
        });
        registerOperations(app, { health, telemetry, metricsToken: env.METRICS_TOKEN });
        health.start();
        stopSampler = startOperationsSampler({
          telemetry,
          queueStats: () => queue.stats(),
          workerStats: () => queue.workerStats(),
          dependencyReady: async () => (await health.ready()).ready,
        });
      },
      telemetry: {
        event: (code, m) => telemetry.log(code.replaceAll('.', '_'), m),
        timing: (kind, ms) => telemetry.observe(kind, ms),
      },
      jobHandlers: {
        'source.ingest': (job) => pipeline.handleJob(job, { resolveContext: resolveIngestion }),
        'connector.sync': (job) => documentSync.handle(job),
      },
      async maintenance(ctx) {
        await quality?.pump(ctx);
        await documentSync.recover(ctx);
        await database.transaction(ctx, (s) =>
          s.query(
            `UPDATE relay.job_outbox o SET state='pending',available_at=now(),lease_owner=NULL,lease_until=NULL
          WHERE o.workspace_id=$1 AND o.kind='source.ingest' AND o.state='published' AND o.published_at<now()-interval '5 seconds'
          AND EXISTS(SELECT 1 FROM relay.knowledge_jobs j WHERE j.id=o.resource_id::uuid AND j.workspace_id=o.workspace_id AND (j.state='queued' OR j.state='running' AND j.expires_at<(extract(epoch from clock_timestamp())*1000)::bigint))`,
            [ctx.workspaceId],
          ),
        );
      },
      drain: () => health.drain(),
      async close() {
        if (closed) return;
        closed = true;
        health.drain();
        stopSampler?.();
        await embeddings.close();
        blobs.close();
        await telemetry.flush();
        await Promise.all([database.close(), queue.close(), identityPool?.end(), ratePool?.end()]);
      },
    };
  } catch (error) {
    await embeddings?.close();
    blobs?.close();
    await Promise.allSettled([
      database.close(),
      queue.close(),
      identityPool?.end(),
      ratePool?.end(),
    ]);
    throw error;
  }
}
