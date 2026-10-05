import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { PlatformError } from '../foundation/errors.js';
import { resourceId } from '../foundation/contracts.js';
import { templates, nodeCatalog, toolCatalog, validateGraph } from '../catalog.js';
import { setSessionCookie } from '../security/index.js';
import { publicRow, RuntimeError } from '../runtime/core.js';
import { registerConnectorRoutes } from '../connectors/routes.js';
import { registerKnowledgeRoutes } from '../knowledge/routes.js';
const uuid = () => crypto.randomUUID(),
  now = () => new Date().toISOString();
const decode = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const text = z.string().min(1).max(100);
export function assertNoInlineSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(secret|apiKey|password|authorization|x-api-key|api-key|secretRef)$/i.test(key) && child)
      throw new PlatformError(
        'VALIDATION_ERROR',
        'Store credentials in Connections and reference their ID.',
      );
    assertNoInlineSecrets(child);
  }
}
export function registerProductionRoutes(
  app,
  {
    router,
    repository,
    database,
    security,
    authenticate,
    middleware,
    connections,
    connectorPorts,
    pipeline,
    knowledgeRepository,
    retrieve,
    modelCall,
    config,
  },
) {
  const route = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };
  const context = (req) => req.context;
  const permission = (name, kind) => async (req, _res, next) => {
    try {
      await security.authorize(context(req), name, kind ? { kind, id: req.params.id } : null);
      next();
    } catch (e) {
      next(e);
    }
  };
  const tx = (req, fn) => database.transaction(context(req), fn);
  const scoped = async (req, table) => {
    const r = await tx(req, (s) =>
      s.one(`SELECT * FROM relay.${table} WHERE workspace_id=$1 AND id=$2`, [
        req.context.workspaceId,
        req.params.id,
      ]),
    );
    if (!r) throw new PlatformError('NOT_FOUND', 'Resource was not found.');
    return r;
  };
  async function newWorkspace(user, name) {
    const wid = uuid(),
      ctx = { workspaceId: wid, actor: { kind: 'user', id: user.id }, requestId: uuid() };
    await database.transaction(ctx, async (s) => {
      await s.query('INSERT INTO relay.workspaces(id,name,created_at) VALUES($1,$2,$3)', [
        wid,
        text.parse(name),
        now(),
      ]);
      await s.query('INSERT INTO relay.security_workspaces(workspace_id) VALUES($1)', [wid]);
      await s.query("INSERT INTO relay.security_memberships VALUES($1,$2,'owner')", [wid, user.id]);
    });
    for (const template of templates.slice(0, 1))
      await repository.createWorkflow(ctx, { name: template.name, graph: template.graph });
    return wid;
  }
  app.get('/api/auth/options', (_req, res) =>
    res.json({
      registration: process.env.ALLOW_REGISTRATION === 'true',
      sso: false,
      passwordReset: false,
      profile: 'production',
    }),
  );
  app.post(
    '/api/auth/register',
    middleware.rate('account'),
    route(async (req, res) => {
      if (process.env.ALLOW_REGISTRATION !== 'true')
        throw new PlatformError(
          'FORBIDDEN',
          'Account registration is disabled by the deployment administrator.',
        );
      const input = z
        .object({ email: z.email(), name: text, password: z.string().min(10).max(200) })
        .strict()
        .parse(req.body);
      const user = await security.identity.register({ ...input, id: uuid() }, req.requestId);
      const workspaceId = await newWorkspace(user, `${user.name.split(' ')[0]}'s workspace`);
      const session = await security.identity.login(input.email, input.password, req.requestId);
      setSessionCookie(res, session);
      res.status(201).json({ ...user, workspaceId });
    }),
  );
  app.post(
    '/api/auth/login',
    middleware.rate('login'),
    route(async (req, res) => {
      const b = z
        .object({ email: z.email(), password: z.string().max(200) })
        .strict()
        .parse(req.body);
      const session = await security.identity.login(b.email, b.password, req.requestId);
      if (!session.mfaRequired) setSessionCookie(res, session);
      res.json(session.mfaRequired ? session : { ok: true });
    }),
  );
  app.post(
    '/api/auth/mfa',
    middleware.rate('login'),
    route(async (req, res) => {
      const b = z
        .object({ challenge: z.string().max(100), code: z.string().max(32) })
        .strict()
        .parse(req.body);
      const session = await security.identity.verifyMfa(b.challenge, b.code, req.requestId);
      setSessionCookie(res, session);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/auth/logout',
    route(async (req, res) => {
      await security.identity.logout(req.cookies.relay_session, req.requestId);
      res.clearCookie('relay_session', { path: '/' });
      res.json({ ok: true });
    }),
  );
  app.get(
    '/api/me',
    middleware.session,
    route(async (req, res) =>
      res.json({
        user: req.user,
        workspaces: (await security.identity.workspaces(req.user.id)).map((w) => ({
          ...w,
          settings: decode(w.settings),
        })),
      }),
    ),
  );
  app.post(
    '/api/workspaces',
    middleware.session,
    route(async (req, res) =>
      res.status(201).json({ id: await newWorkspace(req.user, text.parse(req.body.name)) }),
    ),
  );
  app.get(
    '/api/account/security',
    middleware.session,
    route(async (req, res) => res.json(await security.identity.status(req.user.id))),
  );
  for (const action of ['setup', 'confirm', 'disable'])
    app.post(
      '/api/account/mfa/' + action,
      middleware.session,
      middleware.rate('login'),
      route(async (req, res) => {
        const session = req.cookies.relay_session;
        let result;
        if (action === 'setup')
          result = await security.identity.setupMfa(session, req.body.password, req.requestId);
        if (action === 'confirm')
          result = await security.identity.confirmMfa(session, req.body.code, req.requestId);
        if (action === 'disable') {
          const changed = await security.identity.disableMfa(
            session,
            req.body.password,
            req.body.code,
            req.requestId,
          );
          setSessionCookie(res, changed);
          result = { ok: true };
        }
        res.json(result);
      }),
    );
  app.post(
    '/api/account/password',
    middleware.session,
    middleware.rate('login'),
    route(async (req, res) => {
      const changed = await security.identity.changePassword(
        req.cookies.relay_session,
        req.body.current,
        req.body.password,
        req.body.code,
        req.requestId,
      );
      setSessionCookie(res, changed);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/invitations/accept',
    middleware.session,
    route(async (req, res) => {
      const b = z
        .object({ token: z.string(), workspaceId: resourceId.optional() })
        .strict()
        .parse(req.body);
      const workspaceId = await security.identity.invitationWorkspace(req.user.id, b.token);
      if (b.workspaceId && b.workspaceId !== workspaceId)
        throw new PlatformError('FORBIDDEN', 'Invitation is no longer valid.');
      const ctx = {
        workspaceId,
        actor: { kind: 'user', id: req.user.id },
        requestId: req.requestId,
      };
      await security.membership.accept(ctx, b.token);
      res.json({ workspaceId });
    }),
  );
  router.get('/catalog', (_req, res) =>
    res.json({
      nodes: nodeCatalog,
      tools: toolCatalog,
      templates,
      providers: ['openai-compatible', 'anthropic', 'credential'],
    }),
  );
  router.post(
    '/validate',
    route(async (req, res) => {
      assertNoInlineSecrets(req.body.graph);
      res.json(validateGraph(req.body.graph));
    }),
  );
  router.get(
    '/overview',
    route(async (req, res) =>
      res.json(
        await tx(req, async (s) => ({
          workflows: Number(
            (
              await s.one('SELECT count(*) AS n FROM relay.workflows WHERE workspace_id=$1', [
                context(req).workspaceId,
              ])
            ).n,
          ),
          agents: Number(
            (
              await s.one('SELECT count(*) AS n FROM relay.agents WHERE workspace_id=$1', [
                context(req).workspaceId,
              ])
            ).n,
          ),
          runs: (
            await s.all(
              'SELECT id,workflow_id,status,mode,usage,created_at,finished_at FROM relay.runs WHERE workspace_id=$1 AND parent_id IS NULL ORDER BY created_at DESC LIMIT 1000',
              [context(req).workspaceId],
            )
          ).map(publicRow),
          activity: [],
        })),
      ),
    ),
  );
  router.get(
    '/search',
    route(async (req, res) =>
      res.json(
        await tx(req, async (s) => {
          const q = '%' + String(req.query.q || '').slice(0, 100) + '%';
          const result = {};
          for (const table of ['workflows', 'agents'])
            result[table] = await s.all(
              `SELECT id,name FROM relay.${table} WHERE workspace_id=$1 AND name ILIKE $2 LIMIT 15`,
              [context(req).workspaceId, q],
            );
          return { ...result, sources: [], runs: [] };
        }),
      ),
    ),
  );
  router.post(
    '/workflows/:id/runs',
    permission('run.execute', 'workflow'),
    route(async (req, res) => {
      const versionId = await repository.publish(context(req), req.params.id);
      const id = await repository.createRun(context(req), {
        workflowId: req.params.id,
        versionId,
        input: req.body.input,
        mode: req.body.mode || 'live',
      });
      res.status(202).json({ id });
    }),
  );
  router.get(
    '/connections',
    route(async (req, res) =>
      res.json(
        await tx(req, (s) =>
          s.all(
            'SELECT id,name,provider,endpoint,model,config,created_at FROM relay.connections WHERE workspace_id=$1 ORDER BY created_at DESC',
            [context(req).workspaceId],
          ),
        ).then((rows) =>
          rows.map((r) => {
            const c = decode(r.config);
            const { secretRef, ...settings } = c;
            return { ...r, config: settings, hasCredential: !!secretRef };
          }),
        ),
      ),
    ),
  );
  const connectionSchema = z
    .object({
      name: text,
      provider: z.enum(['openai-compatible', 'anthropic', 'credential']),
      endpoint: z.string().max(4000),
      model: z.string().max(200),
      secret: z.string().max(65536).optional(),
      config: z
        .object({
          inputPrice: z.number().nonnegative().optional(),
          outputPrice: z.number().nonnegative().optional(),
          allowPrivate: z.boolean().optional(),
        })
        .strict()
        .default({}),
    })
    .strict();
  async function saveConnection(req, res, create) {
    const b = connectionSchema.parse(req.body),
      ctx = context(req),
      id = create ? uuid() : resourceId.parse(req.params.id);
    if (b.config.allowPrivate)
      throw new PlatformError(
        'FORBIDDEN',
        'Private endpoints require a deployment administrator outbound policy.',
      );
    const endpoint = new URL(b.endpoint);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.search ||
      !['http:', 'https:'].includes(endpoint.protocol)
    )
      throw new PlatformError(
        'VALIDATION_ERROR',
        'Configure an endpoint without embedded credentials.',
      );
    const prior = create ? null : await scoped(req, 'connections');
    if (create)
      await tx(req, (s) =>
        s.query(
          "INSERT INTO relay.connections(id,workspace_id,name,provider,endpoint,model,secret,config,created_at) VALUES($1,$2,$3,$4,$5,$6,'','{}',$7)",
          [id, ctx.workspaceId, b.name, b.provider, b.endpoint, b.model, now()],
        ),
      );
    let secretRef = prior ? decode(prior.config).secretRef : undefined;
    if (b.secret) {
      const version = await tx(
        req,
        async (s) =>
          Number(
            (
              await s.one(
                'SELECT coalesce(max(version),0) AS n FROM relay.security_credentials WHERE workspace_id=$1 AND connection_id=$2',
                [ctx.workspaceId, id],
              )
            ).n,
          ) + 1,
      );
      const reference = { workspaceId: ctx.workspaceId, connectionId: id, version };
      await security.secrets.store(ctx, reference, b.secret);
      secretRef = reference;
    }
    await tx(req, (s) =>
      s.query(
        'UPDATE relay.connections SET name=$3,provider=$4,endpoint=$5,model=$6,config=$7 WHERE workspace_id=$1 AND id=$2',
        [
          ctx.workspaceId,
          id,
          b.name,
          b.provider,
          b.endpoint,
          b.model,
          JSON.stringify({ ...b.config, secretRef }),
        ],
      ),
    );
    if (b.secret && prior && decode(prior.config).secretRef)
      await security.secrets.revoke(ctx, decode(prior.config).secretRef);
    res.status(create ? 201 : 200).json({ id });
  }
  router.post(
    '/connections',
    permission('secret.manage'),
    route((req, res) => saveConnection(req, res, true)),
  );
  router.put(
    '/connections/:id',
    permission('secret.manage', 'connection'),
    route((req, res) => saveConnection(req, res, false)),
  );
  router.post(
    '/connections/:id/test',
    permission('secret.manage', 'connection'),
    route(async (req, res) => {
      const id = uuid(),
        ctx = context(req);
      const result = await modelCall(ctx, {
        config: { connectionId: req.params.id, maxTokens: 32, temperature: 0 },
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        tools: [],
        meteredCall: async (b, fn) => {
          const held = await security.usage.reserve(ctx, { ...b, runId: id });
          try {
            const result = await fn();
            await security.usage.settle(ctx, held.id, {
              tokens: result.usage.tokens,
              costMicros: result.usage.costMicros,
              provider: result.provider,
              model: result.model,
            });
            return result;
          } catch (e) {
            await security.usage.markUncertain(ctx, held.id);
            throw e;
          }
        },
      });
      res.json({ ok: true, provider: result.provider, model: result.model, usage: result.usage });
    }),
  );
  router.delete(
    '/connections/:id',
    permission('secret.manage', 'connection'),
    route(async (req, res) => {
      await tx(req, async (s) => {
        await s.query(
          'UPDATE relay.security_credentials SET revoked_at=now() WHERE workspace_id=$1 AND connection_id=$2',
          [context(req).workspaceId, req.params.id],
        );
        await s.query('DELETE FROM relay.connections WHERE workspace_id=$1 AND id=$2', [
          context(req).workspaceId,
          req.params.id,
        ]);
      });
      res.json({ ok: true });
    }),
  );
  for (const [table, write] of [
    ['agents', 'workflow.write'],
    ['tools', 'workflow.write'],
    ['collections', 'document.write'],
  ]) {
    router.get(
      '/' + table,
      route(async (req, res) =>
        res.json(
          (
            await tx(req, (s) =>
              s.all(
                `SELECT id,name,config,created_at${table === 'tools' ? ',kind' : ''} FROM relay.${table} WHERE workspace_id=$1 ORDER BY created_at DESC`,
                [context(req).workspaceId],
              ),
            )
          ).map(publicRow),
        ),
      ),
    );
    const schema = z
      .object({
        name: text,
        config: z.record(z.string(), z.unknown()).default({}),
        ...(table === 'tools' ? { kind: z.string().min(1).max(80) } : {}),
      })
      .strict();
    async function save(req, res, create) {
      const b = schema.parse(req.body);
      assertNoInlineSecrets(b.config);
      const id = create ? uuid() : resourceId.parse(req.params.id);
      const wid = context(req).workspaceId;
      if (!create) await scoped(req, table);
      await tx(req, (s) =>
        create
          ? s.query(
              `INSERT INTO relay.${table}(id,workspace_id,name,config,created_at${table === 'tools' ? ',kind' : ''}) VALUES($1,$2,$3,$4,$5${table === 'tools' ? ',$6' : ''})`,
              [
                id,
                wid,
                b.name,
                JSON.stringify(b.config),
                now(),
                ...(table === 'tools' ? [b.kind] : []),
              ],
            )
          : s.query(
              `UPDATE relay.${table} SET name=$3,config=$4${table === 'tools' ? ',kind=$5' : ''} WHERE workspace_id=$1 AND id=$2`,
              [wid, id, b.name, JSON.stringify(b.config), ...(table === 'tools' ? [b.kind] : [])],
            ),
      );
      res.status(create ? 201 : 200).json({ id });
    }
    router.post(
      '/' + table,
      permission(write),
      route((req, res) => save(req, res, true)),
    );
    router.put(
      '/' + table + '/:id',
      permission(
        write,
        table === 'collections' ? 'collection' : table === 'tools' ? 'tool' : undefined,
      ),
      route((req, res) => save(req, res, false)),
    );
    router.delete(
      '/' + table + '/:id',
      permission(write),
      route(async (req, res) => {
        await scoped(req, table);
        if (table === 'collections') {
          const sources = await tx(req, (s) =>
            s.all(
              'SELECT id FROM relay.knowledge_sources WHERE workspace_id=$1 AND collection_id=$2 AND NOT deleted',
              [context(req).workspaceId, req.params.id],
            ),
          );
          for (const source of sources) await pipeline.delete(context(req), source.id);
          // Preserve tombstones/versions until retention is explicitly applied. Hide deletion rather than orphan evidence.
          await tx(req, (s) =>
            s.query(
              "UPDATE relay.collections SET config=jsonb_set(config::jsonb,'{archived}','true')::text WHERE workspace_id=$1 AND id=$2",
              [context(req).workspaceId, req.params.id],
            ),
          );
        } else
          await tx(req, (s) =>
            s.query(`DELETE FROM relay.${table} WHERE workspace_id=$1 AND id=$2`, [
              context(req).workspaceId,
              req.params.id,
            ]),
          );
        res.json({ ok: true });
      }),
    );
  }
  router.get(
    '/collections/:id',
    permission('document.read', 'collection'),
    route(async (req, res) => {
      const row = await scoped(req, 'collections');
      const sources = await tx(req, (s) =>
        s.all(
          'SELECT s.id,s.name,s.version,s.indexed_version,s.created_at,s.metadata,s.access,j.id AS job_id,j.state AS status,j.progress,j.error FROM relay.knowledge_sources s LEFT JOIN LATERAL(SELECT * FROM relay.knowledge_jobs WHERE source_id=s.id AND workspace_id=s.workspace_id ORDER BY created_at DESC LIMIT 1) j ON true WHERE s.workspace_id=$1 AND s.collection_id=$2 AND NOT s.deleted',
          [context(req).workspaceId, req.params.id],
        ),
      );
      const allowed = [];
      for (const source of sources) {
        try {
          await security.authorize(context(req), 'document.read', {
            kind: 'document',
            id: source.id,
          });
          allowed.push(source);
        } catch (e) {
          if (e.code !== 'FORBIDDEN') throw e;
        }
      }
      res.json({ ...publicRow(row), sources: allowed.map(publicRow) });
    }),
  );
  router.post(
    '/collections/:id/text',
    permission('document.write', 'collection'),
    route(async (req, res) => {
      const b = z
        .object({ name: text, text: z.string().max(2_000_000) })
        .strict()
        .parse(req.body);
      res.status(201).json(
        await pipeline.upsert(context(req), {
          collectionId: req.params.id,
          externalId: uuid(),
          name: b.name,
          text: b.text,
          metadata: {},
          access: { mode: 'workspace', principalIds: [] },
        }),
      );
    }),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 3 },
  }).single('file');
  router.post(
    '/collections/:id/upload',
    permission('document.write', 'collection'),
    middleware.rate('upload', (req) => context(req).workspaceId),
    upload,
    route(async (req, res) => {
      if (!req.file) throw new PlatformError('VALIDATION_ERROR', 'Choose a document file.');
      res.status(201).json(
        await pipeline.upload(
          context(req),
          {
            collectionId: req.params.id,
            externalId: uuid(),
            name: req.file.originalname,
            metadata: {},
            access: { mode: 'workspace', principalIds: [] },
          },
          req.file.buffer,
          req.file.mimetype,
        ),
      );
    }),
  );
  router.post(
    '/collections/:id/search',
    permission('document.read', 'collection'),
    route(async (req, res) => {
      const { query, ...options } = req.body;
      const result = await retrieve(context(req), req.params.id, query, options);
      res.json({ ...result, results: result.evidence.map((e) => e.citation) });
    }),
  );
  router.post(
    '/sources/:id/reindex',
    route(async (req, res) => res.json(await pipeline.reindex(context(req), req.params.id))),
  );
  router.delete(
    '/sources/:id',
    route(async (req, res) => {
      await pipeline.delete(context(req), req.params.id);
      res.json({ ok: true });
    }),
  );
  router.get(
    '/members',
    permission('membership.manage'),
    route(async (req, res) =>
      res.json(
        await tx(req, async (s) => ({
          members: await s.all(
            'SELECT m.user_id AS id,m.role,a.name,a.email FROM relay.security_memberships m JOIN relay.security_accounts a ON a.id=m.user_id WHERE m.workspace_id=$1',
            [context(req).workspaceId],
          ),
          invitations: await s.all(
            'SELECT id,email,role,expires_at FROM relay.security_invitations WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()',
            [context(req).workspaceId],
          ),
        })),
      ),
    ),
  );
  router.put(
    '/members/:id',
    permission('membership.manage'),
    route(async (req, res) => {
      await security.membership.change(context(req), req.params.id, req.body.role);
      res.json({ ok: true });
    }),
  );
  router.delete(
    '/members/:id',
    permission('membership.manage'),
    route(async (req, res) => {
      await security.membership.change(context(req), req.params.id);
      res.json({ ok: true });
    }),
  );
  router.delete(
    '/invitations/:id',
    permission('membership.manage'),
    route(async (req, res) => {
      await security.membership.revokeInvitation(context(req), req.params.id);
      res.json({ ok: true });
    }),
  );
  router.post(
    '/invitations',
    permission('membership.manage'),
    route(async (req, res) =>
      res.status(201).json({
        ...(await security.membership.invite(context(req), req.body)),
        workspaceId: context(req).workspaceId,
      }),
    ),
  );
  router.put(
    '/budget',
    permission('budget.manage'),
    route(async (req, res) => {
      await security.usage.configure(context(req), req.body);
      res.json({ ok: true });
    }),
  );
  router.get(
    '/usage',
    route(async (req, res) => res.json({ accounting: await security.usage.report(context(req)) })),
  );
  router.get(
    '/audit',
    permission('audit.read'),
    route(async (req, res) =>
      res.json(
        await tx(req, (s) =>
          s.all(
            'SELECT * FROM relay.security_audit WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1000',
            [context(req).workspaceId],
          ),
        ),
      ),
    ),
  );
  router.get(
    '/connectors',
    permission('secret.manage'),
    route(async (req, res) =>
      res.json(
        await tx(req, (s) =>
          s.all(
            'SELECT id,kind,config,generation,status,secret_ref IS NOT NULL AS has_credential FROM relay.connector_connections WHERE workspace_id=$1 ORDER BY updated_at DESC',
            [context(req).workspaceId],
          ),
        ),
      ),
    ),
  );
  async function saveConnector(req, res, create) {
    const b = z
      .object({
        kind: z.string().max(60),
        config: z.record(z.string(), z.unknown()),
        secret: z.string().max(65536).optional(),
      })
      .strict()
      .parse(req.body);
    assertNoInlineSecrets(b.config);
    const ctx = context(req),
      id = create ? uuid() : resourceId.parse(req.params.id);
    let prior = create ? null : await connections.get(ctx, id);
    if (create) await connections.save(ctx, id, { kind: b.kind, config: b.config });
    let secretRef = prior?.secretRef;
    if (b.secret) {
      const version = await tx(
        req,
        async (s) =>
          Number(
            (
              await s.one(
                'SELECT coalesce(max(version),0) AS n FROM relay.security_credentials WHERE workspace_id=$1 AND connection_id=$2',
                [ctx.workspaceId, id],
              )
            ).n,
          ) + 1,
      );
      secretRef = { workspaceId: ctx.workspaceId, connectionId: id, version };
      await security.secrets.store(ctx, secretRef, b.secret);
    }
    const saved = await connections.save(ctx, id, { kind: b.kind, config: b.config, secretRef });
    if (b.secret && prior?.secretRef) await security.secrets.revoke(ctx, prior.secretRef);
    res.status(create ? 201 : 200).json(saved);
  }
  router.post(
    '/connectors',
    permission('secret.manage'),
    route((req, res) => saveConnector(req, res, true)),
  );
  router.put(
    '/connectors/:id',
    permission('secret.manage', 'connection'),
    route((req, res) => saveConnector(req, res, false)),
  );
  router.delete(
    '/connectors/:id',
    permission('secret.manage', 'connection'),
    route(async (req, res) => {
      const c = await connections.get(context(req), req.params.id);
      await connections.disconnect(context(req), c.id);
      if (c.secretRef) await security.secrets.revoke(context(req), c.secretRef);
      res.json({ ok: true });
    }),
  );
  registerConnectorRoutes(router, {
    contextFor: async (req) => context(req),
    connections,
    portsFor: connectorPorts,
  });
  // v1 endpoints use a verified workspace path, never a JSON workspaceId or actor.
  registerKnowledgeRoutes(app, {
    pipeline,
    retrieve,
    prefix: '/api/w/:wid/knowledge',
    getContext: async (req) => authenticate(req),
  });
  const dist = path.resolve('dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (req, res, next) =>
      req.path.startsWith('/api/') || req.path.startsWith('/health/') || req.path === '/metrics'
        ? next()
        : res.sendFile('index.html', { root: dist }),
    );
  }
  app.use('/api', (req, res) =>
    res.status(404).json({
      error: 'Endpoint is not supported by this deployment.',
      code: 'NOT_FOUND',
      requestId: req.requestId,
    }),
  );
  app.use((error, req, res, next) => {
    if (error instanceof RuntimeError) {
      const code = error.code.includes('CONFLICT')
        ? 'CONFLICT'
        : error.code.startsWith('INVALID')
          ? 'VALIDATION_ERROR'
          : error.code === 'BACKPRESSURE'
            ? 'BUDGET_EXCEEDED'
            : error.code;
      const messages = {
        CONFLICT: 'The decision or resource changed. Reload and review it again.',
        VALIDATION_ERROR: 'Request validation failed.',
        BUDGET_EXCEEDED: 'Workspace capacity is exhausted.',
        FORBIDDEN: 'Permission is required.',
        NOT_FOUND: 'Resource was not found.',
      };
      error = new PlatformError(code, messages[code] || 'The operation could not be completed.');
    }
    if (error instanceof z.ZodError)
      error = new PlatformError('VALIDATION_ERROR', 'Request validation failed.');
    if (error?.code === '23505')
      error = new PlatformError(
        'CONFLICT',
        'A record already exists or another update won the race.',
      );
    if (error?.code?.startsWith('LIMIT_'))
      error = new PlatformError(
        'BUDGET_EXCEEDED',
        'Upload exceeds the allowed size or field count.',
      );
    return middleware.error(error, req, res, next);
  });
}
