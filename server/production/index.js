import pg from 'pg';
import crypto from 'node:crypto';
import cookieParser from 'cookie-parser';
import { createPostgresDatabase } from '../foundation/database.js';
import { createJobQueue } from '../foundation/queue.js';
import { createSecretVault } from '../foundation/secrets.js';
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
const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
export function runtimePermission(operation) {
  if (['recover', 'reconcile', 'admin'].includes(operation.operation)) return 'workspace.manage';
  if (operation.operation === 'approve') return 'run.approve';
  if (['execute', 'schedule'].includes(operation.operation)) return 'run.execute';
  if (operation.operation !== 'api')
    throw new PlatformError('FORBIDDEN', 'Unknown runtime operation.');
  const read = ['GET', 'HEAD'].includes(operation.method);
  const path = operation.path || '';
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
    const vault = createSecretVault(
      { [config.encryptionKeyId]: config.encryptionKey },
      config.encryptionKeyId,
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
    const knowledgeSecurity = createKnowledgeSecurity(security);
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
    const retrieve = createRetriever({
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
    const health = createHealth({
      integrated: true,
      probes: {
        database: () => database.probe(),
        queue: () => queue.probe(),
        storage: () => blobs.probe(),
        ...(identityPool
          ? {
              identity: async () => !!(await identityPool.query('SELECT 1')).rows.length,
              rate: async () => !!(await ratePool.query('SELECT 1')).rows.length,
            }
          : {}),
      },
    });
    let runtimeRepository;
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
      tools: toolPorts.tools,
      snapshotTool: toolPorts.snapshotTool,
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
      memory: {
        async read(ctx, q) {
          await security.authorize(ctx, 'run.execute');
          return database.transaction(ctx, (s) =>
            s.all(
              'SELECT content FROM relay.memories WHERE workspace_id=$1 AND agent_id=$2 AND ($3::text IS NULL OR conversation_id=$3) ORDER BY created_at DESC LIMIT $4',
              [ctx.workspaceId, q.agentId, q.conversationId || null, Math.min(30, q.limit || 6)],
            ),
          );
        },
        async write(ctx, q) {
          await security.authorize(ctx, 'run.execute');
          await database.transaction(ctx, (s) =>
            s.query(
              'INSERT INTO relay.memories(id,workspace_id,agent_id,conversation_id,content,created_at) VALUES($1,$2,$3,$4,$5,$6)',
              [
                crypto.randomUUID(),
                ctx.workspaceId,
                q.agentId,
                q.conversationId || null,
                JSON.stringify(q.messages || q.content),
                new Date().toISOString(),
              ],
            ),
          );
        },
      },
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
        runtimeRepository = repository;
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
        });
        registerOperations(app, { health, telemetry, metricsToken: env.METRICS_TOKEN });
        health.start();
        stopSampler = startOperationsSampler({
          telemetry,
          queueStats: () => queue.stats(),
          dependencyReady: async () => (await health.ready()).ready,
        });
      },
      telemetry: {
        event: (code, m) => telemetry.log(code.replaceAll('.', '_'), m),
        timing: () => {},
      },
      jobHandlers: {
        'source.ingest': (job) => pipeline.handleJob(job, { resolveContext: resolveIngestion }),
      },
      async maintenance(ctx) {
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
