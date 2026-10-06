import crypto from 'node:crypto';
import { z } from 'zod';
import { resourceId } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
import { writeAudit } from '../security/audit.js';
export function registerProductionWorkspace(router, { database, security }) {
  const tx = (req, fn) => database.transaction(req.context, fn);
  const route = (permission, fn) => async (req, res, next) => {
    try {
      await security.authorize(req.context, permission);
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };
  router.get(
    '/projects',
    route('workspace.read', async (req, res) =>
      res.json(
        await tx(req, (s) =>
          s.all(
            'SELECT p.*,(SELECT count(*)::int FROM relay.workflows w WHERE w.workspace_id=p.workspace_id AND w.project_id=p.id) AS workflow_count FROM relay.projects p WHERE p.workspace_id=$1 ORDER BY created_at DESC LIMIT 1000',
            [req.context.workspaceId],
          ),
        ),
      ),
    ),
  );
  router.post(
    '/projects',
    route('workflow.write', async (req, res) => {
      const b = z
          .object({
            name: z.string().min(1).max(100),
            description: z.string().max(4000).default(''),
          })
          .strict()
          .parse(req.body),
        id = crypto.randomUUID();
      await tx(req, async (s) => {
        await s.query(
          'INSERT INTO relay.projects(id,workspace_id,name,description,created_at) VALUES($1,$2,$3,$4,$5)',
          [id, req.context.workspaceId, b.name, b.description, new Date().toISOString()],
        );
        await writeAudit(s, req.context, 'project.created', id);
      });
      res.status(201).json({ id });
    }),
  );
  router.put(
    '/settings',
    route('workspace.manage', async (req, res) => {
      const b = z
        .object({
          name: z.string().min(1).max(100),
          settings: z
            .object({ historyRetentionDays: z.literal(0).default(0) })
            .strict()
            .default({ historyRetentionDays: 0 }),
        })
        .strict()
        .parse(req.body);
      await tx(req, async (s) => {
        await s.query('UPDATE relay.workspaces SET name=$2,settings=$3 WHERE id=$1', [
          req.context.workspaceId,
          b.name,
          JSON.stringify(b.settings),
        ]);
        await writeAudit(s, req.context, 'workspace.updated', req.context.workspaceId);
      });
      res.json({ ok: true });
    }),
  );
  router.get(
    '/memories',
    route('workspace.read', async (req, res) =>
      res.json(
        await tx(req, (s) =>
          s.all(
            'SELECT id,agent_id,conversation_id,content,created_at FROM relay.memories WHERE workspace_id=$1 AND principal=$2 ORDER BY created_at DESC LIMIT 1000',
            [req.context.workspaceId, `${req.context.actor.kind}:${req.context.actor.id}`],
          ),
        ),
      ),
    ),
  );
  router.delete(
    '/memories/:id',
    route('run.execute', async (req, res) => {
      await tx(req, (s) =>
        s.query('DELETE FROM relay.memories WHERE workspace_id=$1 AND principal=$2 AND id=$3', [
          req.context.workspaceId,
          `${req.context.actor.kind}:${req.context.actor.id}`,
          resourceId.parse(req.params.id),
        ]),
      );
      res.json({ ok: true });
    }),
  );
  router.get(
    '/artifacts',
    route('workspace.read', async (req, res) =>
      res.json(
        await tx(req, (s) =>
          s.all(
            'SELECT id,name,created_at FROM relay.artifacts WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1000',
            [req.context.workspaceId],
          ),
        ),
      ),
    ),
  );
  router.get(
    '/artifacts/:id',
    route('workspace.read', async (req, res) => {
      const r = await tx(req, (s) =>
        s.one('SELECT name,content FROM relay.artifacts WHERE workspace_id=$1 AND id=$2', [
          req.context.workspaceId,
          resourceId.parse(req.params.id),
        ]),
      );
      if (!r) throw new PlatformError('NOT_FOUND', 'Artifact was not found.');
      res.attachment('relay-artifact.json').type('application/json').send(r.content);
    }),
  );
  router.get(
    '/runs/:id/feedback',
    route('run.read', async (req, res) => {
      await security.authorize(req.context, 'run.read', {
        kind: 'run',
        id: resourceId.parse(req.params.id),
      });
      res.json(
        await tx(req, (s) =>
          s.all(
            'SELECT f.*,a.name FROM relay.feedback f LEFT JOIN relay.security_accounts a ON a.id=f.user_id WHERE f.workspace_id=$1 AND f.run_id=$2 ORDER BY created_at DESC LIMIT 1000',
            [req.context.workspaceId, req.params.id],
          ),
        ),
      );
    }),
  );
  router.post(
    '/runs/:id/feedback',
    route('run.read', async (req, res) => {
      await security.authorize(req.context, 'run.read', {
        kind: 'run',
        id: resourceId.parse(req.params.id),
      });
      const b = z
        .object({
          rating: z.number().int().min(-1).max(1),
          comment: z.string().max(2000).default(''),
        })
        .strict()
        .parse(req.body);
      await tx(req, (s) =>
        s.query(
          'INSERT INTO relay.feedback(id,workspace_id,run_id,user_id,rating,comment,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            crypto.randomUUID(),
            req.context.workspaceId,
            req.params.id,
            req.context.actor.id,
            b.rating,
            b.comment,
            new Date().toISOString(),
          ],
        ),
      );
      res.status(201).json({ ok: true });
    }),
  );
  router.get(
    '/operations',
    route('workspace.manage', async (req, res) =>
      res.json(
        await tx(req, async (s) => {
          const wid = req.context.workspaceId;
          const rows = await s.all(
            "SELECT status,active_ms FROM relay.runs WHERE workspace_id=$1 AND created_at >= to_char((now()-interval '7 days') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') ORDER BY created_at DESC LIMIT 10000",
            [wid],
          );
          const terminal = rows.filter((r) =>
            ['completed', 'failed', 'cancelled'].includes(r.status),
          );
          const times = terminal.map((r) => Number(r.active_ms)).sort((a, b) => a - b);
          return {
            profile: 'production',
            metrics: {
              runs: rows.length,
              successRate: terminal.length
                ? terminal.filter((r) => r.status === 'completed').length / terminal.length
                : 0,
              p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : 0,
              truncated: rows.length === 10000,
            },
            workers: await s.all(
              "SELECT lease_owner AS id,lease_owner AS name,count(*)::int AS active FROM relay.runs WHERE workspace_id=$1 AND status='running' AND lease_until>(extract(epoch from clock_timestamp())*1000)::bigint GROUP BY lease_owner",
              [wid],
            ),
            queue: await s.all(
              'SELECT status,count(*)::int AS count FROM relay.runs WHERE workspace_id=$1 GROUP BY status',
              [wid],
            ),
            failures: await s.all(
              "SELECT id,error FROM relay.runs WHERE workspace_id=$1 AND status='failed' ORDER BY created_at DESC LIMIT 20",
              [wid],
            ),
          };
        }),
      ),
    ),
  );
  router.put(
    '/schedules/:id',
    route('workspace.manage', async (req, res) => {
      const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      await tx(req, (s) =>
        s.query('UPDATE relay.schedules SET enabled=$3 WHERE workspace_id=$1 AND id=$2', [
          req.context.workspaceId,
          resourceId.parse(req.params.id),
          b.enabled ? 1 : 0,
        ]),
      );
      res.json({ ok: true });
    }),
  );
  router.delete(
    '/schedules/:id',
    route('workspace.manage', async (req, res) => {
      await tx(req, (s) =>
        s.query('DELETE FROM relay.schedules WHERE workspace_id=$1 AND id=$2', [
          req.context.workspaceId,
          resourceId.parse(req.params.id),
        ]),
      );
      res.json({ ok: true });
    }),
  );
}
