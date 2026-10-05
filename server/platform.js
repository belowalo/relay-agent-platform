import { z } from 'zod';
import { all, one, exec, id, now, encode, decode, audit, transaction } from './db.js';
import { requireRole } from './auth.js';
import { startEvaluation, cancelEvaluation, evaluationDetail } from './evaluations.js';
const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
const scope = (table, rid, wid) => {
  const row = one(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`, rid, wid);
  if (!row) throw new Error('Resource was not found in this workspace');
  return row;
};
const datasetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(''),
  cases: z
    .array(z.object({ input: z.unknown(), expected: z.unknown().optional() }))
    .min(1)
    .max(100),
  revision: z.number().optional(),
});
const evalSchema = z.object({
  name: z.string().max(100).optional(),
  datasetId: z.string(),
  workflowId: z.string(),
  versionId: z.string().optional(),
  mode: z.enum(['preview', 'live']).default('preview'),
  threshold: z.number().min(0).max(1).default(1),
  rules: z
    .array(
      z.object({
        type: z.enum(['success', 'exact', 'contains', 'json', 'latency', 'tokens']),
        path: z.string().max(100).optional(),
        value: z.unknown().optional(),
        schema: z.record(z.string(), z.any()).optional(),
        maxMs: z.number().positive().optional(),
        maxTokens: z.number().positive().optional(),
      }),
    )
    .max(20)
    .default([]),
  judgeConnectionId: z.string().optional(),
  rubric: z.string().max(4000).optional(),
});
export function registerPlatform(api) {
  api.get('/datasets', (req, res) =>
    res.json(
      all(
        'SELECT * FROM datasets WHERE workspace_id=? ORDER BY updated_at DESC',
        req.workspace,
      ).map((d) => ({ ...d, cases: decode(d.cases) })),
    ),
  );
  api.post(
    '/datasets',
    requireRole('editor'),
    route((req, res) => {
      const b = datasetSchema.parse(req.body),
        did = id();
      exec(
        'INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?)',
        did,
        req.workspace,
        b.name,
        b.description,
        encode(b.cases),
        1,
        now(),
        now(),
      );
      audit(req.workspace, req.user.id, 'dataset.created', did);
      res.status(201).json({ id: did });
    }),
  );
  api.put(
    '/datasets/:did',
    requireRole('editor'),
    route((req, res) => {
      const d = scope('datasets', req.params.did, req.workspace),
        b = datasetSchema.parse(req.body);
      if (b.revision !== d.revision)
        return res.status(409).json({ error: 'Dataset changed; reload before saving' });
      exec(
        'UPDATE datasets SET name=?,description=?,cases=?,revision=revision+1,updated_at=? WHERE id=?',
        b.name,
        b.description,
        encode(b.cases),
        now(),
        d.id,
      );
      res.json({ id: d.id });
    }),
  );
  api.delete(
    '/datasets/:did',
    requireRole('editor'),
    route((req, res) => {
      scope('datasets', req.params.did, req.workspace);
      exec('DELETE FROM datasets WHERE id=?', req.params.did);
      res.json({ ok: true });
    }),
  );
  api.get('/evaluations', (req, res) =>
    res.json(
      all(
        'SELECT * FROM evaluations WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100',
        req.workspace,
      ).map((e) => ({
        ...e,
        config: decode(e.config),
        summary: decode(e.summary),
        dataset_snapshot: undefined,
      })),
    ),
  );
  api.get(
    '/evaluations/:eid',
    route((req, res) => res.json(evaluationDetail(req.params.eid, req.workspace))),
  );
  api.post(
    '/evaluations',
    requireRole('editor'),
    route((req, res) => {
      const eid = startEvaluation(req.workspace, evalSchema.parse(req.body));
      audit(req.workspace, req.user.id, 'evaluation.started', eid);
      res.status(201).json({ id: eid });
    }),
  );
  api.post(
    '/evaluations/:eid/cancel',
    requireRole('editor'),
    route((req, res) => {
      scope('evaluations', req.params.eid, req.workspace);
      cancelEvaluation(req.params.eid);
      res.json({ ok: true });
    }),
  );
  api.get(
    '/evaluations/:eid/compare/:baseline',
    route((req, res) => {
      const a = evaluationDetail(req.params.eid, req.workspace),
        b = evaluationDetail(req.params.baseline, req.workspace);
      if (JSON.stringify(a.dataset_snapshot.cases) !== JSON.stringify(b.dataset_snapshot.cases))
        throw new Error('Compare evaluations with the same frozen test cases');
      res.json({
        current: a.summary,
        baseline: b.summary,
        scoreDelta: (a.summary.meanScore || 0) - (b.summary.meanScore || 0),
        costDelta:
          a.summary.costConfigured === false || b.summary.costConfigured === false
            ? null
            : (a.summary.estimatedCost || 0) - (b.summary.estimatedCost || 0),
        cases: a.cases.map((c, i) => ({
          ordinal: i,
          current: c.score,
          baseline: b.cases[i]?.score,
          delta: c.score == null || b.cases[i]?.score == null ? null : c.score - b.cases[i].score,
        })),
      });
    }),
  );
  api.get('/prompts', (req, res) =>
    res.json(
      all(
        'SELECT * FROM prompt_library WHERE workspace_id=? ORDER BY updated_at DESC',
        req.workspace,
      ),
    ),
  );
  const promptSchema = z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1000).default(''),
    content: z.string().min(1).max(30000),
    revision: z.number().optional(),
  });
  api.post(
    '/prompts',
    requireRole('editor'),
    route((req, res) => {
      const b = promptSchema.parse(req.body),
        pid = id();
      transaction(() => {
        exec(
          'INSERT INTO prompt_library VALUES(?,?,?,?,?,?,?,?)',
          pid,
          req.workspace,
          b.name,
          b.description,
          b.content,
          1,
          now(),
          now(),
        );
        exec('INSERT INTO prompt_versions VALUES(?,?,?,?,?)', id(), pid, 1, b.content, now());
      });
      audit(req.workspace, req.user.id, 'prompt.created', pid);
      res.status(201).json({ id: pid });
    }),
  );
  api.put(
    '/prompts/:pid',
    requireRole('editor'),
    route((req, res) => {
      const p = scope('prompt_library', req.params.pid, req.workspace),
        b = promptSchema.parse(req.body);
      if (b.revision !== p.revision)
        return res.status(409).json({ error: 'Prompt changed; reload before saving' });
      transaction(() => {
        exec(
          'UPDATE prompt_library SET name=?,description=?,content=?,revision=revision+1,updated_at=? WHERE id=?',
          b.name,
          b.description,
          b.content,
          now(),
          p.id,
        );
        exec(
          'INSERT INTO prompt_versions VALUES(?,?,?,?,?)',
          id(),
          p.id,
          p.revision + 1,
          b.content,
          now(),
        );
      });
      res.json({ id: p.id });
    }),
  );
  api.get(
    '/prompts/:pid/versions',
    route((req, res) => {
      scope('prompt_library', req.params.pid, req.workspace);
      res.json(
        all(
          'SELECT * FROM prompt_versions WHERE prompt_id=? ORDER BY revision DESC',
          req.params.pid,
        ),
      );
    }),
  );
  api.delete(
    '/prompts/:pid',
    requireRole('editor'),
    route((req, res) => {
      scope('prompt_library', req.params.pid, req.workspace);
      exec('DELETE FROM prompt_library WHERE id=?', req.params.pid);
      res.json({ ok: true });
    }),
  );
  api.get('/schedules', (req, res) =>
    res.json(
      all(
        'SELECT s.*,w.name AS workflow FROM schedules s JOIN workflows w ON w.id=s.workflow_id WHERE s.workspace_id=? ORDER BY s.created_at DESC',
        req.workspace,
      ).map((s) => ({ ...s, input: decode(s.input) })),
    ),
  );
  api.post(
    '/schedules',
    requireRole('administrator'),
    route((req, res) => {
      const b = z
        .object({
          name: z.string().min(1).max(100),
          workflowId: z.string(),
          intervalMinutes: z.number().int().min(1).max(525600),
          input: z.unknown(),
          mode: z.enum(['preview', 'live']).default('preview'),
        })
        .parse(req.body);
      scope('workflows', b.workflowId, req.workspace);
      const sid = id();
      exec(
        'INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        sid,
        req.workspace,
        b.workflowId,
        b.name,
        b.intervalMinutes,
        encode(b.input),
        b.mode,
        1,
        Date.now() + b.intervalMinutes * 60000,
        null,
        now(),
      );
      audit(req.workspace, req.user.id, 'schedule.created', sid);
      res.status(201).json({ id: sid });
    }),
  );
  api.put(
    '/schedules/:sid',
    requireRole('administrator'),
    route((req, res) => {
      scope('schedules', req.params.sid, req.workspace);
      exec(
        'UPDATE schedules SET enabled=?,next_at=? WHERE id=?',
        z.boolean().parse(req.body.enabled) ? 1 : 0,
        Date.now() + scope('schedules', req.params.sid, req.workspace).interval_minutes * 60000,
        req.params.sid,
      );
      res.json({ ok: true });
    }),
  );
  api.delete(
    '/schedules/:sid',
    requireRole('administrator'),
    route((req, res) => {
      scope('schedules', req.params.sid, req.workspace);
      exec('DELETE FROM schedules WHERE id=?', req.params.sid);
      res.json({ ok: true });
    }),
  );
  api.get(
    '/runs/:rid/feedback',
    route((req, res) => {
      scope('runs', req.params.rid, req.workspace);
      res.json(
        all(
          'SELECT f.*,u.name FROM feedback f JOIN users u ON u.id=f.user_id WHERE run_id=?',
          req.params.rid,
        ),
      );
    }),
  );
  api.post(
    '/runs/:rid/feedback',
    route((req, res) => {
      scope('runs', req.params.rid, req.workspace);
      const b = z
        .object({
          rating: z.number().int().min(-1).max(1),
          comment: z.string().max(2000).default(''),
        })
        .parse(req.body);
      exec(
        'INSERT INTO feedback VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,user_id) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,created_at=excluded.created_at',
        id(),
        req.workspace,
        req.params.rid,
        req.user.id,
        b.rating,
        b.comment,
        now(),
      );
      res.json({ ok: true });
    }),
  );
  api.get(
    '/operations',
    requireRole('administrator'),
    route((req, res) => {
      const recent = all(
          "SELECT status,active_ms,usage FROM runs WHERE workspace_id=? AND created_at>=datetime('now','-7 days')",
          req.workspace,
        ),
        durations = recent
          .filter((r) => r.status === 'completed')
          .map((r) => r.active_ms)
          .sort((a, b) => a - b);
      const usage = recent.map((r) => decode(r.usage));
      res.json({
        workers: all('SELECT * FROM workers WHERE heartbeat>?', Date.now() - 15000),
        queue: all(
          'SELECT status,count(*) AS count FROM runs WHERE workspace_id=? GROUP BY status',
          req.workspace,
        ),
        metrics: {
          runs: recent.length,
          successRate:
            recent.filter((r) => r.status === 'completed').length /
            Math.max(
              1,
              recent.filter((r) => ['completed', 'failed', 'cancelled'].includes(r.status)).length,
            ),
          p50Ms: durations[Math.floor(durations.length * 0.5)] || 0,
          p95Ms:
            durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] || 0,
          inputTokens: usage.reduce((s, u) => s + (u.inputTokens || 0), 0),
          outputTokens: usage.reduce((s, u) => s + (u.outputTokens || 0), 0),
          estimatedCost: usage.reduce((s, u) => s + (u.estimatedCost || 0), 0),
        },
        failures: all(
          "SELECT id,error,created_at FROM runs WHERE workspace_id=? AND status='failed' ORDER BY created_at DESC LIMIT 20",
          req.workspace,
        ),
      });
    }),
  );
}
