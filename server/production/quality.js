import crypto from 'node:crypto';
import Ajv from 'ajv';
import { z } from 'zod';
import { PlatformError } from '../foundation/errors.js';
import { resourceId, tenantContextSchema } from '../foundation/contracts.js';
import { publicRow, decode, json } from '../runtime/core.js';
const uuid = () => crypto.randomUUID(),
  now = () => new Date().toISOString();
const ajv = new Ajv({ strict: false, allErrors: true });
const canonical = (v) =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? v.map(canonical)
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
    : v;
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
export function scoreProductionOutput(output, expected, rules, run) {
  const checks = (
    rules?.length ? rules : [{ type: expected === undefined ? 'success' : 'exact' }]
  ).map((rule) => {
    const value = rule.path
      ? rule.path
          .split('.')
          .filter(Boolean)
          .reduce((v, k) => v?.[k], output)
      : output;
    let passed = false;
    switch (rule.type) {
      case 'success':
        passed = run.status === 'completed';
        break;
      case 'exact':
        passed =
          JSON.stringify(canonical(value)) ===
          JSON.stringify(canonical(Object.hasOwn(rule, 'value') ? rule.value : expected));
        break;
      case 'contains':
        passed = !!text(value)
          ?.toLowerCase()
          .includes(text(Object.hasOwn(rule, 'value') ? rule.value : expected)?.toLowerCase());
        break;
      case 'json':
        try {
          passed = ajv.compile(rule.schema)(typeof value === 'string' ? JSON.parse(value) : value);
        } catch {}
        break;
      case 'latency':
        passed = Number(run.active_ms || 0) <= rule.maxMs;
        break;
      case 'tokens':
        passed = Number(run.tokens || 0) <= rule.maxTokens;
        break;
      default:
        throw new PlatformError('VALIDATION_ERROR', 'Unsupported evaluator.');
    }
    return { type: rule.type, passed: !!passed };
  });
  return { score: checks.filter((c) => c.passed).length / checks.length, checks };
}
const rule = z
  .object({
    type: z.enum(['success', 'exact', 'contains', 'json', 'latency', 'tokens']),
    path: z.string().max(200).optional(),
    value: z.unknown().optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    maxMs: z.number().nonnegative().optional(),
    maxTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export function createProductionQuality({ database, security, repository }) {
  const tx = (ctx, fn) => database.transaction(ctx, fn);
  async function pump(scope) {
    const pending = await tx(scope, (s) =>
      s.all(
        "SELECT id,config FROM relay.evaluations WHERE workspace_id=$1 AND status='running' AND config::jsonb ? 'context' ORDER BY created_at LIMIT 20",
        [scope.workspaceId],
      ),
    );
    for (const e of pending) {
      const config = decode(e.config),
        ctx = tenantContextSchema.parse(config.context);
      let permitted = true;
      try {
        await security.authorize(ctx, 'run.execute', { kind: 'workflow', id: config.workflowId });
      } catch (err) {
        if (['FORBIDDEN', 'NOT_FOUND'].includes(err.code)) permitted = false;
        else throw err;
      }
      if (!permitted) {
        const cases = await tx(scope, (s) =>
          s.all(
            'SELECT run_id FROM relay.evaluation_cases WHERE workspace_id=$1 AND evaluation_id=$2',
            [scope.workspaceId, e.id],
          ),
        );
        for (const c of cases) await repository.cancel(ctx, c.run_id);
        await tx(scope, (s) =>
          s.query(
            "UPDATE relay.evaluations SET status='cancelled',finished_at=$3 WHERE workspace_id=$1 AND id=$2",
            [scope.workspaceId, e.id, now()],
          ),
        );
        continue;
      }
      await tx(ctx, async (s) => {
        const current = await s.one(
          "SELECT id FROM relay.evaluations WHERE workspace_id=$1 AND id=$2 AND status='running' FOR UPDATE",
          [ctx.workspaceId, e.id],
        );
        if (!current) return;
        const rows = await s.all(
          "SELECT c.*,r.status AS run_status,r.output,r.error AS run_error,r.active_ms,coalesce((SELECT sum(u.tokens) FROM relay.security_usage u WHERE u.workspace_id=c.workspace_id AND u.run_id=c.run_id AND u.status='settled'),0)::text AS tokens FROM relay.evaluation_cases c JOIN relay.runs r ON r.id=c.run_id AND r.workspace_id=c.workspace_id WHERE c.workspace_id=$1 AND c.evaluation_id=$2 ORDER BY ordinal",
          [ctx.workspaceId, e.id],
        );
        for (const c of rows)
          if (
            c.status === 'queued' &&
            ['completed', 'failed', 'cancelled'].includes(c.run_status)
          ) {
            const result = scoreProductionOutput(
              decode(c.output),
              c.expected === null ? undefined : decode(c.expected),
              config.rules,
              { status: c.run_status, active_ms: c.active_ms, tokens: c.tokens },
            );
            c.score = c.run_status === 'completed' ? result.score : 0;
            c.status = c.run_status;
            await s.query(
              'UPDATE relay.evaluation_cases SET status=$3,score=$4,result=$5,error=$6 WHERE workspace_id=$1 AND id=$2',
              [
                ctx.workspaceId,
                c.id,
                c.status,
                c.score,
                json({ ...result, output: decode(c.output), runStatus: c.run_status }),
                c.run_error,
              ],
            );
          }
        const done = rows.every((c) => ['completed', 'failed', 'cancelled'].includes(c.status));
        const scored = rows.filter((c) => c.score !== null),
          summary = {
            total: rows.length,
            completed: scored.length,
            passed: scored.filter((c) => c.score >= config.threshold && c.status === 'completed')
              .length,
            meanScore: scored.length
              ? scored.reduce((n, c) => n + Number(c.score), 0) / scored.length
              : 0,
            synthetic: config.mode === 'preview',
            qualityEvidence:
              config.mode === 'preview'
                ? 'Preview behavior only'
                : 'Observed workflow outputs; live quality acceptance and human review are separate',
          };
        await s.query(
          'UPDATE relay.evaluations SET summary=$3,status=$4,finished_at=$5 WHERE workspace_id=$1 AND id=$2',
          [
            ctx.workspaceId,
            e.id,
            json(summary),
            done ? 'completed' : 'running',
            done ? now() : null,
          ],
        );
      });
    }
  }
  function register(router) {
    const route = (fn) => async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (e) {
        next(e);
      }
    };
    const ctx = (req) => req.context;
    const lookup = (req, table) =>
      tx(ctx(req), (s) =>
        s.one(`SELECT * FROM relay.${table} WHERE workspace_id=$1 AND id=$2`, [
          ctx(req).workspaceId,
          req.params.id,
        ]),
      );
    const requireRow = (row) => {
      if (!row) throw new PlatformError('NOT_FOUND', 'Resource was not found.');
      return row;
    };
    for (const [path, table] of [
      ['prompts', 'prompt_library'],
      ['datasets', 'datasets'],
    ]) {
      router.get(
        '/' + path,
        route(async (req, res) =>
          res.json(
            (
              await tx(ctx(req), (s) =>
                s.all(
                  `SELECT * FROM relay.${table} WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 1000`,
                  [ctx(req).workspaceId],
                ),
              )
            ).map((r) => ({
              ...publicRow(r),
              ...(path === 'datasets' ? { cases: decode(r.cases) } : {}),
            })),
          ),
        ),
      );
      const save = async (req, res, create) => {
        await security.authorize(ctx(req), 'workflow.write');
        const name = z.string().min(1).max(100).parse(req.body.name),
          description = z
            .string()
            .max(4000)
            .parse(req.body.description || ''),
          id = create ? uuid() : resourceId.parse(req.params.id);
        const content =
          path === 'prompts'
            ? z.string().max(100000).parse(req.body.content)
            : json(
                z
                  .array(
                    z
                      .object({ input: z.unknown(), expected: z.unknown().optional() })
                      .passthrough(),
                  )
                  .min(1)
                  .max(200)
                  .parse(req.body.cases),
              );
        await tx(ctx(req), async (s) => {
          const prior = create
            ? null
            : requireRow(
                await s.one(
                  `SELECT * FROM relay.${table} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
                  [ctx(req).workspaceId, id],
                ),
              );
          if (prior && Number(req.body.revision) !== Number(prior.revision))
            throw new PlatformError('CONFLICT', 'Revision changed. Reload before saving.');
          const revision = prior ? Number(prior.revision) + 1 : 1,
            column = path === 'prompts' ? 'content' : 'cases';
          if (create)
            await s.query(
              `INSERT INTO relay.${table}(id,workspace_id,name,description,${column},revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
              [id, ctx(req).workspaceId, name, description, content, revision, now()],
            );
          else
            await s.query(
              `UPDATE relay.${table} SET name=$3,description=$4,${column}=$5,revision=$6,updated_at=$7 WHERE workspace_id=$1 AND id=$2`,
              [ctx(req).workspaceId, id, name, description, content, revision, now()],
            );
          if (path === 'prompts')
            await s.query(
              'INSERT INTO relay.prompt_versions(id,workspace_id,prompt_id,revision,content,created_at) VALUES($1,$2,$3,$4,$5,$6)',
              [uuid(), ctx(req).workspaceId, id, revision, content, now()],
            );
        });
        res.status(create ? 201 : 200).json({ id });
      };
      router.post(
        '/' + path,
        route((req, res) => save(req, res, true)),
      );
      router.put(
        '/' + path + '/:id',
        route((req, res) => save(req, res, false)),
      );
      router.delete(
        '/' + path + '/:id',
        route(async (req, res) => {
          await security.authorize(ctx(req), 'workflow.write');
          requireRow(await lookup(req, table));
          await tx(ctx(req), (s) =>
            s.query(`DELETE FROM relay.${table} WHERE workspace_id=$1 AND id=$2`, [
              ctx(req).workspaceId,
              req.params.id,
            ]),
          );
          res.json({ ok: true });
        }),
      );
    }
    router.get(
      '/prompts/:id/versions',
      route(async (req, res) => {
        requireRow(await lookup(req, 'prompt_library'));
        res.json(
          (
            await tx(ctx(req), (s) =>
              s.all(
                'SELECT id,revision,content,created_at FROM relay.prompt_versions WHERE workspace_id=$1 AND prompt_id=$2 ORDER BY revision DESC',
                [ctx(req).workspaceId, req.params.id],
              ),
            )
          ).map(publicRow),
        );
      }),
    );
    router.get(
      '/evaluations',
      route(async (req, res) =>
        res.json(
          (
            await tx(ctx(req), (s) =>
              s.all(
                'SELECT * FROM relay.evaluations WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1000',
                [ctx(req).workspaceId],
              ),
            )
          ).map((r) => ({ ...publicRow(r), summary: decode(r.summary) })),
        ),
      ),
    );
    router.post(
      '/evaluations',
      route(async (req, res) => {
        await security.authorize(ctx(req), 'run.execute');
        const b = z
          .object({
            name: z.string().max(100).default('Evaluation'),
            datasetId: resourceId,
            workflowId: resourceId,
            versionId: resourceId.optional(),
            mode: z.enum(['live', 'preview']).default('preview'),
            threshold: z.number().min(0).max(1).default(1),
            rules: z.array(rule).max(30).default([]),
            judgeConnectionId: resourceId.optional(),
            rubric: z.string().max(10000).optional(),
          })
          .strict()
          .parse(req.body);
        if (b.judgeConnectionId)
          throw new PlatformError(
            'VALIDATION_ERROR',
            'Use a separate judging workflow; this evaluator supports explicit deterministic rules.',
          );
        const versionId = b.versionId || (await repository.publish(ctx(req), b.workflowId)),
          id = uuid();
        await tx(ctx(req), async (s) => {
          const dataset = requireRow(
            await s.one('SELECT * FROM relay.datasets WHERE workspace_id=$1 AND id=$2', [
              ctx(req).workspaceId,
              b.datasetId,
            ]),
          );
          const version = requireRow(
            await s.one(
              'SELECT * FROM relay.versions WHERE workspace_id=$1 AND id=$2 AND workflow_id=$3',
              [ctx(req).workspaceId, versionId, b.workflowId],
            ),
          );
          const cases = decode(dataset.cases),
            config = { ...b, context: ctx(req) };
          await s.query(
            "INSERT INTO relay.evaluations(id,workspace_id,dataset_id,dataset_snapshot,workflow_id,workflow_revision,name,status,config,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8,$9)",
            [
              id,
              ctx(req).workspaceId,
              dataset.id,
              json(dataset),
              b.workflowId,
              version.revision,
              b.name,
              json(config),
              now(),
            ],
          );
          for (const [ordinal, c] of cases.entries()) {
            const runId = await repository.createInSession(s, {
              graph: decode(version.graph),
              workflowId: b.workflowId,
              versionId,
              input: c.input,
              mode: b.mode,
            });
            await s.query(
              'INSERT INTO relay.evaluation_cases(id,workspace_id,evaluation_id,ordinal,input,expected,run_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [
                uuid(),
                ctx(req).workspaceId,
                id,
                ordinal,
                json(c.input),
                c.expected === undefined ? null : json(c.expected),
                runId,
              ],
            );
          }
        });
        res.status(202).json({ id });
      }),
    );
    router.get(
      '/evaluations/:id',
      route(async (req, res) => {
        const e = requireRow(await lookup(req, 'evaluations'));
        const cases = await tx(ctx(req), (s) =>
          s.all(
            'SELECT * FROM relay.evaluation_cases WHERE workspace_id=$1 AND evaluation_id=$2 ORDER BY ordinal',
            [ctx(req).workspaceId, e.id],
          ),
        );
        const config = decode(e.config);
        delete config.context;
        res.json({
          ...publicRow(e),
          config,
          summary: decode(e.summary),
          cases: cases.map((r) => ({
            ...publicRow(r),
            expected: r.expected === null ? null : decode(r.expected),
          })),
        });
      }),
    );
    router.post(
      '/evaluations/:id/cancel',
      route(async (req, res) => {
        await security.authorize(ctx(req), 'run.execute');
        requireRow(await lookup(req, 'evaluations'));
        await tx(ctx(req), (s) =>
          s.query(
            "UPDATE relay.evaluations SET status='cancelled',finished_at=$3 WHERE workspace_id=$1 AND id=$2 AND status='running'",
            [ctx(req).workspaceId, req.params.id, now()],
          ),
        );
        const cases = await tx(ctx(req), (s) =>
          s.all(
            'SELECT run_id FROM relay.evaluation_cases WHERE workspace_id=$1 AND evaluation_id=$2',
            [ctx(req).workspaceId, req.params.id],
          ),
        );
        for (const c of cases) await repository.cancel(ctx(req), c.run_id);
        res.json({ ok: true });
      }),
    );
  }
  return { pump, register };
}
