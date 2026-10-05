import crypto from 'node:crypto';
import { z } from 'zod';
import { resourceId } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
import { tokenHash } from '../security/tokens.js';
import { decode, json, publicRow } from '../runtime/core.js';
const uuid = () => crypto.randomUUID(),
  now = () => new Date().toISOString();
const settingsSchema = z
  .object({
    public: z.literal(false).default(false),
    mode: z.enum(['live', 'preview']).default('preview'),
    welcome: z.string().max(1000).optional(),
    accent: z.string().max(50).optional(),
  })
  .strict();
export function createProductionPublications({ database, security, repository }) {
  const tx = (ctx, fn) => database.transaction(ctx, fn);
  const absent = () => {
    throw new PlatformError('NOT_FOUND', 'Application was not found.');
  };
  async function get(ctx, id) {
    return (
      (await tx(ctx, (s) =>
        s.one('SELECT * FROM relay.applications WHERE workspace_id=$1 AND id=$2', [
          ctx.workspaceId,
          id,
        ]),
      )) || absent()
    );
  }
  async function issue(ctx, app) {
    const graph = decode(app.graph_snapshot),
      resources = new Set([`application:${app.id}`, `workflow:${app.workflow_id}`]),
      collections = new Set();
    function visit(g) {
      for (const n of g.nodes) {
        const c = n.data.config || {};
        if (c.connectionId) resources.add('connection:' + resourceId.parse(c.connectionId));
        for (const id of c.knowledgeIds || []) collections.add(resourceId.parse(id));
        if (c.collectionId) collections.add(resourceId.parse(c.collectionId));
        for (const t of [...(c.toolSnapshots || []), ...(c.toolSnapshot ? [c.toolSnapshot] : [])]) {
          resources.add('tool:' + t.id);
          if (t.config.connectionId) resources.add('connection:' + t.config.connectionId);
        }
        if (c.graphSnapshot) visit(c.graphSnapshot);
      }
    }
    visit(graph);
    for (const id of collections) {
      resources.add('collection:' + id);
      const sources = await tx(ctx, (s) =>
        s.all(
          'SELECT id FROM relay.knowledge_sources WHERE workspace_id=$1 AND collection_id=$2 AND NOT deleted LIMIT 501',
          [ctx.workspaceId, id],
        ),
      );
      for (const source of sources) resources.add('document:' + source.id);
    }
    if (resources.size > 500)
      throw new PlatformError(
        'VALIDATION_ERROR',
        'Publication exceeds the 500 explicit resource grant limit. Split the application or select smaller collections.',
      );
    return security.tokens.mint(ctx, {
      applicationId: app.id,
      permissions: [
        'run.execute',
        'run.read',
        'workflow.read',
        'document.read',
        'connector.invoke',
        'secret.resolve',
      ],
      resources: [...resources],
      expiresAt: Date.now() + 30 * 86400000,
    });
  }
  async function applicationContext(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer /i, '');
    if (!/^relay_[\w-]{43}$/.test(token))
      throw new PlatformError('UNAUTHENTICATED', 'Provide a scoped application API token.');
    const aid = resourceId.parse(req.params.aid),
      probe = {
        workspaceId: 'application-discovery',
        actor: { kind: 'application', id: aid },
        requestId: req.requestId,
      };
    const row = await tx(probe, (s) =>
      s.one('SELECT relay.application_tenant($1,$2) AS workspace_id', [aid, tokenHash(token)]),
    );
    if (!row.workspace_id)
      throw new PlatformError('UNAUTHENTICATED', 'Application token is no longer valid.');
    const ctx = await security.tokens.authenticate({
      workspaceId: row.workspace_id,
      applicationId: aid,
      token,
      requestId: req.requestId,
    });
    await security.rate.consume('public', ctx.actor.id);
    const app = await get(ctx, aid);
    if (decode(app.settings).disabled)
      throw new PlatformError('FORBIDDEN', 'Application is disabled.');
    return { ctx, app };
  }
  function register(app, router) {
    const route = (fn) => async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (e) {
        next(e);
      }
    };
    router.get(
      '/applications',
      route(async (req, res) =>
        res.json(
          (
            await tx(req.context, (s) =>
              s.all(
                "SELECT a.id,a.name,a.workflow_id,a.version_id,a.settings,a.created_at,v.revision FROM relay.applications a JOIN relay.versions v ON v.id=a.version_id AND v.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND NOT coalesce((a.settings::jsonb->>'disabled')::boolean,false) ORDER BY a.created_at DESC",
                [req.context.workspaceId],
              ),
            )
          ).map((r) => ({ ...publicRow(r), settings: decode(r.settings) })),
        ),
      ),
    );
    router.post(
      '/applications',
      route(async (req, res) => {
        await security.authorize(req.context, 'publication.manage');
        const b = z
          .object({
            name: z.string().min(1).max(100),
            workflowId: resourceId,
            settings: settingsSchema.default({ public: false, mode: 'preview' }),
          })
          .strict()
          .parse(req.body);
        const versionId = await repository.publish(req.context, b.workflowId),
          id = uuid();
        await tx(req.context, async (s) => {
          const v = await s.one(
            'SELECT graph FROM relay.versions WHERE workspace_id=$1 AND id=$2',
            [req.context.workspaceId, versionId],
          );
          await s.query(
            "INSERT INTO relay.applications(id,workspace_id,workflow_id,version_id,name,settings,token_hash,created_at,graph_snapshot) VALUES($1,$2,$3,$4,$5,$6,'',$7,$8)",
            [
              id,
              req.context.workspaceId,
              b.workflowId,
              versionId,
              b.name,
              json({ ...b.settings, publisherId: req.context.actor.id }),
              now(),
              v.graph,
            ],
          );
        });
        const grant = await issue(req.context, await get(req.context, id));
        res
          .status(201)
          .json({ id, token: grant.token, tokenId: grant.id, expiresAt: grant.expiresAt });
      }),
    );
    router.put(
      '/applications/:id',
      route(async (req, res) => {
        await security.authorize(req.context, 'publication.manage', {
          kind: 'application',
          id: req.params.id,
        });
        const current = await get(req.context, req.params.id),
          old = decode(current.settings),
          settings = settingsSchema.parse(req.body.settings || { public: false, mode: old.mode });
        const versionId = req.body.publishLatest
          ? await repository.publish(req.context, current.workflow_id)
          : current.version_id;
        await tx(req.context, async (s) => {
          const v = await s.one(
            'SELECT graph FROM relay.versions WHERE workspace_id=$1 AND id=$2',
            [req.context.workspaceId, versionId],
          );
          await s.query(
            'UPDATE relay.applications SET name=$3,settings=$4,version_id=$5,graph_snapshot=$6 WHERE workspace_id=$1 AND id=$2',
            [
              req.context.workspaceId,
              current.id,
              z
                .string()
                .max(100)
                .parse(req.body.name || current.name),
              json({ ...settings, publisherId: req.context.actor.id }),
              versionId,
              v.graph,
            ],
          );
          if (versionId !== current.version_id)
            await s.query(
              'UPDATE relay.security_tokens SET revoked_at=now() WHERE workspace_id=$1 AND application_id=$2 AND revoked_at IS NULL',
              [req.context.workspaceId, current.id],
            );
        });
        res.json({ ok: true, tokenRevoked: versionId !== current.version_id });
      }),
    );
    router.post(
      '/applications/:id/rotate',
      route(async (req, res) => {
        await security.authorize(req.context, 'token.manage', {
          kind: 'application',
          id: req.params.id,
        });
        const current = await get(req.context, req.params.id);
        await tx(req.context, (s) =>
          s.query(
            'UPDATE relay.security_tokens SET revoked_at=now() WHERE workspace_id=$1 AND application_id=$2 AND revoked_at IS NULL',
            [req.context.workspaceId, current.id],
          ),
        );
        const grant = await issue(req.context, current);
        res.json({ token: grant.token, tokenId: grant.id, expiresAt: grant.expiresAt });
      }),
    );
    router.post(
      '/applications/:id/revoke',
      route(async (req, res) => {
        await security.authorize(req.context, 'token.manage', {
          kind: 'application',
          id: req.params.id,
        });
        await tx(req.context, (s) =>
          s.query(
            'UPDATE relay.security_tokens SET revoked_at=now() WHERE workspace_id=$1 AND application_id=$2 AND revoked_at IS NULL',
            [req.context.workspaceId, req.params.id],
          ),
        );
        res.json({ ok: true });
      }),
    );
    router.delete(
      '/applications/:id',
      route(async (req, res) => {
        await security.authorize(req.context, 'publication.manage', {
          kind: 'application',
          id: req.params.id,
        });
        await tx(req.context, async (s) => {
          await s.query(
            'UPDATE relay.security_tokens SET revoked_at=now() WHERE workspace_id=$1 AND application_id=$2',
            [req.context.workspaceId, req.params.id],
          );
          await s.query(
            "UPDATE relay.applications SET settings=jsonb_set(settings::jsonb,'{disabled}','true')::text WHERE workspace_id=$1 AND id=$2",
            [req.context.workspaceId, req.params.id],
          );
        });
        res.json({ ok: true });
      }),
    );
    app.post(
      '/api/apps/:aid/invoke',
      route(async (req, res) => {
        const { ctx, app: a } = await applicationContext(req);
        await security.authorize(ctx, 'run.execute', { kind: 'application', id: a.id });
        const b = z.object({ input: z.unknown() }).strict().parse(req.body);
        const id = await tx(ctx, (s) =>
          repository.createInSession(s, {
            graph: decode(a.graph_snapshot),
            workflowId: a.workflow_id,
            versionId: a.version_id,
            applicationId: a.id,
            input: b.input,
            mode: decode(a.settings).mode,
          }),
        );
        res
          .status(202)
          .json({ id, runId: id, status: 'queued', poll: `/api/apps/${a.id}/runs/${id}` });
      }),
    );
    app.get(
      '/api/apps/:aid/runs/:rid',
      route(async (req, res) => {
        const { ctx, app: a } = await applicationContext(req);
        await security.authorize(ctx, 'run.read', {
          kind: 'run',
          id: resourceId.parse(req.params.rid),
        });
        const run = await repository.getRun(ctx, req.params.rid);
        if (!run || run.application_id !== a.id) absent();
        res.json({ id: run.id, status: run.status, output: decode(run.output), error: run.error });
      }),
    );
  }
  return { register };
}
