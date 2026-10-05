import { enqueueInTransaction } from '../foundation/outbox.js';
import { tenantContextSchema, resourceId as opaqueId } from '../foundation/contracts.js';
import {
  json,
  decode,
  uuid,
  instant,
  fail,
  clockSql,
  limitsFor,
  checkGraph,
  argumentHash,
  boundOutput,
} from './core.js';

export function createRuntimeRepository(database, { leaseMs = 30000, snapshotTool } = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 200 || leaseMs > 120000) fail('INVALID_LEASE');
  const tx = (context, fn) => database.transaction(tenantContextSchema.parse(context), fn);
  const scoped = (s, table, id, lock = '') =>
    s.one(`SELECT * FROM relay.${table} WHERE id=$1 AND workspace_id=$2 ${lock}`, [
      id,
      s.context.workspaceId,
    ]);
  async function event(s, runId, type, nodeId = null, data = {}) {
    const r = await s.one(
      'UPDATE relay.runs SET event_seq=event_seq+1 WHERE id=$1 AND workspace_id=$2 RETURNING event_seq',
      [runId, s.context.workspaceId],
    );
    if (!r) fail('NOT_FOUND');
    await s.query(
      'INSERT INTO relay.events(run_id,workspace_id,type,node_id,data,created_at,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [runId, s.context.workspaceId, type, nodeId, json(data), instant(), r.event_seq],
    );
  }
  async function enqueue(s, runId, at = null) {
    const job = {
      version: 1,
      id: uuid(),
      workspaceId: s.context.workspaceId,
      kind: 'workflow.run',
      resourceId: runId,
      requestId: s.context.requestId,
    };
    await enqueueInTransaction(s, job);
    if (at) await s.query('UPDATE relay.job_outbox SET available_at=$2 WHERE id=$1', [job.id, at]);
    return job.id;
  }
  async function capacity(s) {
    await s.query(
      'INSERT INTO relay.runtime_capacity(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',
      [s.context.workspaceId],
    );
    return s.one('SELECT * FROM relay.runtime_capacity WHERE workspace_id=$1 FOR UPDATE', [
      s.context.workspaceId,
    ]);
  }
  async function snapshot(s, graph, stack = []) {
    checkGraph(graph);
    const result = structuredClone(graph);
    for (const node of result.nodes) {
      const c = (node.data.config ||= {});
      delete c.toolSnapshots;
      delete c.toolSnapshot;
      delete c.graphSnapshot;
      if (['tool', 'agent', 'orchestrator'].includes(node.data.kind)) {
        const ids = node.data.kind === 'tool' ? [c.toolId].filter(Boolean) : c.toolIds || [];
        const tools = [];
        for (const id of ids) {
          const tool = await scoped(s, 'tools', id);
          if (!tool) fail('TOOL_NOT_FOUND');
          const frozen = { ...tool, config: decode(tool.config) };
          tools.push(snapshotTool ? await snapshotTool(s, frozen) : frozen);
        }
        if (node.data.kind === 'tool' && tools.length) c.toolSnapshot = tools[0];
        else if (tools.length) c.toolSnapshots = tools;
      }
      if (['loop', 'subworkflow'].includes(node.data.kind)) {
        if (stack.length >= 5 || stack.includes(c.workflowId)) fail('RECURSIVE_WORKFLOW');
        const child = await scoped(s, 'workflows', c.workflowId);
        if (!child) fail('CHILD_NOT_FOUND');
        c.graphSnapshot = await snapshot(s, decode(child.graph), [...stack, c.workflowId]);
      }
    }
    return result;
  }
  async function createInSession(
    s,
    {
      graph,
      input,
      workflowId = null,
      versionId = null,
      applicationId = null,
      mode = 'live',
      parentId = null,
      childKey = null,
      limits,
      depth = 0,
    },
  ) {
    limits = limitsFor(limits);
    checkGraph(graph, limits);
    boundOutput(input, limits);
    if (!['live', 'preview'].includes(mode) || depth > limits.childDepth) fail('INVALID_RUN');
    const cap = await capacity(s);
    const count = await s.one(
      "SELECT count(*) AS n FROM relay.runs WHERE workspace_id=$1 AND status IN ('queued','running','waiting')",
      [s.context.workspaceId],
    );
    if (Number(count.n) >= Number(cap.max_queued)) fail('BACKPRESSURE');
    const id = uuid();
    await s.query(
      "INSERT INTO relay.runs(id,workspace_id,workflow_id,version_id,graph,input,status,mode,parent_id,child_key,created_at,actor,request_id,limits,application_id) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,$13,$14)",
      [
        id,
        s.context.workspaceId,
        workflowId,
        versionId,
        json(graph),
        json(input),
        mode,
        parentId,
        childKey,
        instant(),
        json(s.context.actor),
        s.context.requestId,
        json({ ...limits, depth }),
        applicationId,
      ],
    );
    for (const n of graph.nodes)
      await s.query(
        "INSERT INTO relay.steps(id,run_id,workspace_id,node_id,status) VALUES($1,$2,$3,$4,'queued')",
        [uuid(), id, s.context.workspaceId, n.id],
      );
    await event(s, id, 'run.queued');
    await enqueue(s, id);
    return id;
  }
  async function fence(s, lease) {
    const r = await s.one(
      `SELECT * FROM relay.runs WHERE id=$1 AND workspace_id=$2 AND status='running' AND lease_owner=$3 AND lease_generation=$4 AND lease_until>${clockSql} FOR UPDATE`,
      [lease.runId, s.context.workspaceId, lease.ownerId, lease.generation],
    );
    if (!r) fail('STALE_LEASE');
    return r;
  }
  // Consistent tenant-capacity -> run -> step/action lock order also covers child
  // creation and recursive cancellation, avoiding parent/child lock inversion.
  const fenced = (context, lease, fn) =>
    tx(context, async (s) => {
      await capacity(s);
      return fn(s, await fence(s, lease));
    });
  async function release(s, r, status) {
    await s.query(
      `UPDATE relay.runs SET status=$2,active_ms=active_ms+CASE WHEN active_since IS NULL THEN 0 ELSE greatest(0,${clockSql}-(extract(epoch from active_since::timestamptz)*1000)::bigint) END,active_since=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
      [r.id, status],
    );
  }
  async function finish(s, r, status, output = null, code = null) {
    await release(s, r, status);
    await s.query('UPDATE relay.runs SET output=$2,error=$3,finished_at=$4 WHERE id=$1', [
      r.id,
      json(output),
      code,
      instant(),
    ]);
    await event(s, r.id, 'run.' + status, null, code ? { code } : {});
    if (r.parent_id) {
      const parent = await scoped(s, 'runs', r.parent_id, 'FOR UPDATE');
      if (parent?.status === 'waiting') {
        await s.query("UPDATE relay.runs SET status='queued' WHERE id=$1", [parent.id]);
        await s.query(
          "UPDATE relay.steps SET status='queued' WHERE run_id=$1 AND workspace_id=$2 AND status='waiting' AND node_id IN (SELECT value->>'id' FROM jsonb_array_elements($3::jsonb->'nodes') WHERE value->'data'->>'kind' IN ('loop','subworkflow'))",
          [parent.id, s.context.workspaceId, parent.graph],
        );
        await enqueue(s, parent.id);
      }
    }
  }
  async function dead(s, r, code) {
    await finish(s, r, 'failed', null, code);
    await s.query(
      'INSERT INTO relay.runtime_dead_letters(id,workspace_id,run_id,code,attempts) VALUES($1,$2,$3,$4,$5)',
      [uuid(), s.context.workspaceId, r.id, code, r.recovery_count],
    );
  }
  return {
    tx,
    event,
    enqueue,
    createInSession,
    snapshot,
    async createWorkflow(context, { name, graph, id = uuid() }) {
      opaqueId.parse(id);
      checkGraph(graph);
      return tx(context, async (s) => {
        await s.query(
          'INSERT INTO relay.workflows(id,workspace_id,name,graph,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
          [id, context.workspaceId, name, json(graph), instant()],
        );
        return id;
      });
    },
    publish(context, id) {
      return tx(context, async (s) => {
        const w = await scoped(s, 'workflows', id, 'FOR UPDATE');
        if (!w) fail('NOT_FOUND');
        const existing = await s.one(
          'SELECT id FROM relay.versions WHERE workspace_id=$1 AND workflow_id=$2 AND revision=$3',
          [context.workspaceId, id, w.revision],
        );
        if (existing) return existing.id;
        const graph = await snapshot(s, decode(w.graph), [id]);
        const vid = uuid();
        await s.query(
          'INSERT INTO relay.versions(id,workspace_id,workflow_id,revision,name,graph,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [vid, context.workspaceId, id, w.revision, w.name, json(graph), instant()],
        );
        return vid;
      });
    },
    updateWorkflow(context, id, { name, graph, revision }) {
      if (!Number.isSafeInteger(revision) || revision < 1) fail('VALIDATION_ERROR');
      checkGraph(graph);
      return tx(context, async (s) => {
        const current = await scoped(s, 'workflows', id, 'FOR UPDATE');
        if (!current) fail('NOT_FOUND');
        if (Number(current.revision) !== revision) fail('CONFLICT');
        await s.query(
          'UPDATE relay.workflows SET name=$3,graph=$4,revision=revision+1,updated_at=$5 WHERE id=$1 AND workspace_id=$2',
          [id, context.workspaceId, name || current.name, json(graph), instant()],
        );
        return scoped(s, 'workflows', id);
      });
    },
    createRun(context, { workflowId, versionId, input, mode = 'live', limits }) {
      return tx(context, async (s) => {
        const v = await scoped(s, 'versions', versionId);
        if (!v || v.workflow_id !== workflowId) fail('NOT_FOUND');
        return createInSession(s, {
          graph: decode(v.graph),
          input,
          workflowId,
          versionId,
          mode,
          limits,
        });
      });
    },
    getRun(context, id) {
      return tx(context, (s) => scoped(s, 'runs', id));
    },
    getSteps(context, id) {
      return tx(context, (s) =>
        s.all('SELECT * FROM relay.steps WHERE run_id=$1 AND workspace_id=$2 ORDER BY node_id', [
          id,
          context.workspaceId,
        ]),
      );
    },
    events(context, id, after = 0) {
      return tx(context, (s) =>
        s.all(
          'SELECT * FROM relay.events WHERE run_id=$1 AND workspace_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 1000',
          [id, context.workspaceId, after],
        ),
      );
    },
    claim(context, runId, ownerId) {
      opaqueId.parse(ownerId);
      return tx(context, async (s) => {
        const cap = await capacity(s),
          r = await scoped(s, 'runs', runId, 'FOR UPDATE');
        if (!r || !r.actor || !['queued', 'running'].includes(r.status)) return null;
        const due = await s.one(
          `SELECT available_at<=now() AS due, coalesce(lease_until,0)>${clockSql} AS leased FROM relay.runs WHERE id=$1`,
          [runId],
        );
        if (!due.due || due.leased) return null;
        const count = await s.one(
          `SELECT count(*) AS n FROM relay.runs WHERE workspace_id=$1 AND status='running' AND lease_until>${clockSql}`,
          [context.workspaceId],
        );
        if (Number(count.n) >= Number(cap.max_running)) return null;
        if (r.status === 'running') {
          await s.query(
            "UPDATE relay.actions SET status='uncertain',updated_at=now() WHERE run_id=$1 AND workspace_id=$2 AND status='started'",
            [runId, context.workspaceId],
          );
          const uncertain = await s.one(
            "SELECT id FROM relay.actions WHERE run_id=$1 AND workspace_id=$2 AND status='uncertain'",
            [runId, context.workspaceId],
          );
          if (uncertain) {
            await dead(s, r, 'UNCERTAIN_ACTION');
            return null;
          }
          r.recovery_count = Number(r.recovery_count) + 1;
          if (r.recovery_count >= r.max_attempts) {
            await dead(s, r, 'RECOVERY_EXHAUSTED');
            return null;
          }
          await s.query(
            "UPDATE relay.steps SET status='queued' WHERE run_id=$1 AND workspace_id=$2 AND status='running'",
            [runId, context.workspaceId],
          );
          // Account crashed lease time, bounded by its expiry, rather than resetting the execution budget.
          await s.query(
            'UPDATE relay.runs SET active_ms=active_ms+CASE WHEN active_since IS NULL THEN 0 ELSE greatest(0,lease_until-(extract(epoch from active_since::timestamptz)*1000)::bigint) END WHERE id=$1',
            [runId],
          );
        }
        const row = await s.one(
          `UPDATE relay.runs SET status='running',lease_owner=$2,lease_generation=lease_generation+1,lease_until=${clockSql}+$3,active_since=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),recovery_count=$4 WHERE id=$1 RETURNING *`,
          [runId, ownerId, leaseMs, r.recovery_count],
        );
        await s.query(
          'UPDATE relay.runtime_capacity SET last_claimed_at=now() WHERE workspace_id=$1',
          [context.workspaceId],
        );
        await event(s, runId, 'run.running');
        return { run: row, lease: { runId, ownerId, generation: Number(row.lease_generation) } };
      });
    },
    heartbeat(context, lease) {
      return fenced(context, lease, (s) =>
        s.query(`UPDATE relay.runs SET lease_until=${clockSql}+$2 WHERE id=$1`, [
          lease.runId,
          leaseMs,
        ]),
      );
    },
    assertLease(context, lease) {
      return fenced(context, lease, async () => true);
    },
    startStep(context, lease, stepId, input) {
      return fenced(context, lease, async (s) => {
        const row = await s.one(
          "UPDATE relay.steps SET status='running',input=$3,attempt=attempt+1,started_at=$4 WHERE id=$1 AND run_id=$2 AND status='queued' RETURNING *",
          [stepId, lease.runId, json(input), instant()],
        );
        if (!row) fail('STEP_CONFLICT');
        await event(s, lease.runId, 'node.running', row.node_id);
        return row;
      });
    },
    checkpoint(context, lease, stepId, checkpoint) {
      return fenced(context, lease, (s, r) =>
        s.query('UPDATE relay.steps SET checkpoint=$3 WHERE id=$1 AND run_id=$2', [
          stepId,
          lease.runId,
          json(boundOutput(checkpoint, limitsFor(decode(r.limits)))),
        ]),
      );
    },
    completeStep(context, lease, stepId, output) {
      return fenced(context, lease, async (s) => {
        const row = await s.one(
          "UPDATE relay.steps SET status='completed',output=$3,error=NULL,checkpoint=NULL,finished_at=$4 WHERE id=$1 AND run_id=$2 AND status='running' RETURNING node_id",
          [stepId, lease.runId, json(output), instant()],
        );
        if (!row) fail('STEP_CONFLICT');
        await event(s, lease.runId, 'node.completed', row.node_id);
      });
    },
    skip(context, lease, nodeIds) {
      return fenced(context, lease, (s) =>
        s.query(
          "UPDATE relay.steps SET status='skipped',finished_at=$3 WHERE run_id=$1 AND node_id=ANY($2::text[]) AND status='queued'",
          [lease.runId, nodeIds, instant()],
        ),
      );
    },
    waitStep(context, lease, stepId) {
      return fenced(context, lease, (s) =>
        s.query("UPDATE relay.steps SET status='waiting' WHERE id=$1 AND run_id=$2", [
          stepId,
          lease.runId,
        ]),
      );
    },
    failStep(context, lease, stepId, code, retryable = false, retries = 0) {
      return fenced(context, lease, async (s) => {
        const step = await s.one('SELECT * FROM relay.steps WHERE id=$1 AND run_id=$2 FOR UPDATE', [
          stepId,
          lease.runId,
        ]);
        if (!step) fail('NOT_FOUND');
        const unsafe = await s.one(
          "SELECT id FROM relay.actions WHERE step_id=$1 AND status IN ('started','uncertain')",
          [stepId],
        );
        const retry =
          retryable && !unsafe && Number(step.attempt) <= Math.max(0, Math.min(3, retries));
        await s.query('UPDATE relay.steps SET status=$2,error=$3,finished_at=$4 WHERE id=$1', [
          stepId,
          retry ? 'queued' : 'failed',
          code,
          instant(),
        ]);
        if (retry)
          await s.query(
            "UPDATE relay.runs SET available_at=now()+($2*interval '1 millisecond') WHERE id=$1",
            [lease.runId, Math.min(30000, 250 * 2 ** (Number(step.attempt) - 1))],
          );
        await event(s, lease.runId, retry ? 'node.retry' : 'node.failed', step.node_id, { code });
        return retry;
      });
    },
    pause(context, lease, status = 'waiting') {
      return fenced(context, lease, async (s, r) => {
        if (status === 'waiting') {
          const waiting = await s.all(
            "SELECT node_id FROM relay.steps WHERE run_id=$1 AND status='waiting'",
            [r.id],
          );
          for (const step of waiting) {
            const node = decode(r.graph).nodes.find((n) => n.id === step.node_id);
            if (!['loop', 'subworkflow'].includes(node?.data.kind)) continue;
            const children = await s.all(
              'SELECT status FROM relay.runs WHERE parent_id=$1 AND starts_with(child_key,$2)',
              [r.id, step.node_id + ':'],
            );
            if (
              children.length &&
              children.every((c) => ['completed', 'failed', 'cancelled'].includes(c.status))
            ) {
              await s.query(
                "UPDATE relay.steps SET status='queued' WHERE run_id=$1 AND node_id=$2",
                [r.id, step.node_id],
              );
              status = 'queued';
            }
          }
        }
        await release(s, r, status);
        await event(s, r.id, 'run.' + status);
        if (status === 'queued') await enqueue(s, r.id, r.available_at);
      });
    },
    finish(context, lease, status, output = null, code = null) {
      return fenced(context, lease, (s, r) =>
        status === 'failed'
          ? dead(s, r, code || 'EXECUTION_FAILED')
          : finish(s, r, status, output, code),
      );
    },
    cancel(context, runId) {
      return tx(context, async (s) => {
        await capacity(s);
        const rows = await s.all(
          'WITH RECURSIVE tree AS (SELECT id FROM relay.runs WHERE id=$1 AND workspace_id=$2 UNION ALL SELECT r.id FROM relay.runs r JOIN tree t ON r.parent_id=t.id WHERE r.workspace_id=$2) SELECT r.* FROM relay.runs r JOIN tree t USING(id) ORDER BY r.id FOR UPDATE OF r',
          [runId, context.workspaceId],
        );
        for (const r of rows)
          if (!['completed', 'failed', 'cancelled'].includes(r.status)) {
            await s.query(
              "UPDATE relay.actions SET status='uncertain' WHERE run_id=$1 AND status='started'",
              [r.id],
            );
            await s.query(
              "UPDATE relay.steps SET status='cancelled' WHERE run_id=$1 AND status IN ('queued','running','waiting')",
              [r.id],
            );
            await finish(s, r, 'cancelled');
          }
      });
    },
    child(context, lease, node, graph, input, index, limits) {
      return fenced(context, lease, async (s, parent) => {
        const key = node.id + ':' + index;
        let r = await s.one(
          'SELECT * FROM relay.runs WHERE workspace_id=$1 AND parent_id=$2 AND child_key=$3',
          [context.workspaceId, lease.runId, key],
        );
        if (!r) {
          const id = await createInSession(s, {
            graph,
            input,
            parentId: lease.runId,
            applicationId: parent.application_id,
            childKey: key,
            limits,
            depth: (limits.depth || 0) + 1,
          });
          r = await scoped(s, 'runs', id);
        }
        return r;
      });
    },
    prepareAction(context, lease, step, tool, args, checkpoint, approval = true, callKey = 'node') {
      return fenced(context, lease, async (s, r) => {
        boundOutput(args, limitsFor(decode(r.limits)));
        boundOutput(checkpoint, limitsFor(decode(r.limits)));
        const hash = argumentHash(args);
        let a = await s.one(
          'SELECT * FROM relay.actions WHERE workspace_id=$1 AND run_id=$2 AND step_id=$3 AND call_key=$4 FOR UPDATE',
          [context.workspaceId, lease.runId, step.id, callKey],
        );
        if (a && (a.argument_hash !== hash || a.tool_id !== tool.id)) fail('ACTION_CONFLICT');
        if (!a) {
          a = { id: uuid(), status: 'prepared', argument_hash: hash, idempotency_key: uuid() };
          await s.query(
            "INSERT INTO relay.actions(id,workspace_id,run_id,step_id,tool_id,status,side_effect,created_at,arguments,argument_hash,idempotency_key,lease_generation,call_key) VALUES($1,$2,$3,$4,$5,'prepared',1,$6,$7,$8,$9,$10,$11)",
            [
              a.id,
              context.workspaceId,
              lease.runId,
              step.id,
              tool.id,
              instant(),
              json(args),
              hash,
              a.idempotency_key,
              lease.generation,
              callKey,
            ],
          );
        }
        if (approval) {
          await s.query(
            'INSERT INTO relay.runtime_approvals(id,workspace_id,run_id,step_id,action_id,argument_hash,arguments,checkpoint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(action_id) DO NOTHING',
            [
              uuid(),
              context.workspaceId,
              lease.runId,
              step.id,
              a.id,
              hash,
              json(args),
              json(checkpoint),
            ],
          );
          a.approval = await s.one('SELECT * FROM relay.runtime_approvals WHERE action_id=$1', [
            a.id,
          ]);
        }
        await s.query('UPDATE relay.steps SET checkpoint=$2 WHERE id=$1', [
          step.id,
          json(checkpoint),
        ]);
        return a;
      });
    },
    startAction(context, lease, actionId, args) {
      return fenced(context, lease, async (s) => {
        const a = await scoped(s, 'actions', actionId, 'FOR UPDATE');
        if (!a || a.argument_hash !== argumentHash(args) || a.status !== 'prepared')
          fail('ACTION_CONFLICT');
        const approval = await s.one('SELECT * FROM relay.runtime_approvals WHERE action_id=$1', [
          actionId,
        ]);
        if (
          approval &&
          (approval.status !== 'approved' || approval.argument_hash !== a.argument_hash)
        )
          fail('APPROVAL_REQUIRED');
        await s.query(
          "UPDATE relay.actions SET status='started',lease_generation=$2,updated_at=now() WHERE id=$1",
          [actionId, lease.generation],
        );
        return a;
      });
    },
    outcome(context, lease, actionId, status, result, providerRequestId = null) {
      if (!['succeeded', 'failed', 'uncertain'].includes(status)) fail('INVALID_ACTION_STATUS');
      return fenced(context, lease, async (s) => {
        const row = await s.one(
          "UPDATE relay.actions SET status=$3,result=$4,provider_request_id=$5,updated_at=now() WHERE id=$1 AND run_id=$2 AND status='started' AND lease_generation=$6 RETURNING id",
          [actionId, lease.runId, status, json(result), providerRequestId, lease.generation],
        );
        if (!row) fail('ACTION_CONFLICT');
      });
    },
    decide(context, approvalId, hash, approved) {
      return tx(context, async (s) => {
        await capacity(s);
        const a = await scoped(s, 'runtime_approvals', approvalId);
        if (!a) fail('NOT_FOUND');
        const run = await scoped(s, 'runs', a.run_id, 'FOR UPDATE');
        if (!run || run.status !== 'waiting' || a.argument_hash !== hash || a.status !== 'pending')
          fail('APPROVAL_CONFLICT');
        const action = await scoped(s, 'actions', a.action_id, 'FOR UPDATE');
        if (action?.status !== 'prepared' || action.argument_hash !== hash)
          fail('APPROVAL_CONFLICT');
        await s.query(
          'UPDATE relay.runtime_approvals SET status=$2,reviewer=$3,decision_at=now() WHERE id=$1',
          [a.id, approved ? 'approved' : 'rejected', json(context.actor)],
        );
        await s.query("UPDATE relay.steps SET status='queued' WHERE id=$1", [a.step_id]);
        await s.query("UPDATE relay.runs SET status='queued',available_at=now() WHERE id=$1", [
          run.id,
        ]);
        await event(s, run.id, approved ? 'approval.accepted' : 'approval.rejected');
        await enqueue(s, run.id);
      });
    },
    reconcile(context, actionId, status, result, note) {
      if (!['succeeded', 'failed'].includes(status) || !note) fail('INVALID_RECONCILIATION');
      return tx(context, async (s) => {
        await capacity(s);
        const a = await scoped(s, 'actions', actionId, 'FOR UPDATE');
        if (a?.status !== 'uncertain') fail('ACTION_CONFLICT');
        await s.query(
          'UPDATE relay.actions SET status=$2,result=$3,resolution=$4,updated_at=now() WHERE id=$1',
          [actionId, status, json(result), json({ actor: context.actor, note })],
        );
        await event(s, a.run_id, 'action.reconciled', null, { actionId, status });
      });
    },
    clearUsageCheckpoint(context, runId, stepId, reservationId, resolution) {
      return tx(context, async (s) => {
        await capacity(s);
        const run = await scoped(s, 'runs', runId, 'FOR UPDATE');
        if (!run || !['failed', 'cancelled'].includes(run.status)) fail('RUN_CONFLICT');
        const step = await s.one(
          'SELECT * FROM relay.steps WHERE id=$1 AND run_id=$2 AND workspace_id=$3 FOR UPDATE',
          [stepId, runId, context.workspaceId],
        );
        const cp = decode(step?.checkpoint);
        if (!cp || cp.reservationId !== reservationId) fail('USAGE_RECONCILIATION_CONFLICT');
        delete cp.reservationId;
        await s.query('UPDATE relay.steps SET checkpoint=$2 WHERE id=$1', [stepId, json(cp)]);
        await event(s, runId, 'usage.reconciled', step.node_id, {
          reservationId,
          resolution,
          reviewer: context.actor.id,
        });
      });
    },
    retry(context, runId) {
      return tx(context, async (s) => {
        await capacity(s);
        const r = await scoped(s, 'runs', runId, 'FOR UPDATE');
        if (!r || !['failed', 'cancelled'].includes(r.status)) fail('RUN_CONFLICT');
        if (
          await s.one(
            "SELECT id FROM relay.actions WHERE run_id=$1 AND status IN ('started','uncertain')",
            [runId],
          )
        )
          fail('UNCERTAIN_ACTION');
        await s.query(
          "UPDATE relay.steps SET status='queued',error=NULL WHERE run_id=$1 AND status IN ('failed','cancelled','skipped','running')",
          [runId],
        );
        await s.query(
          "UPDATE relay.runs SET status='queued',available_at=now(),error=NULL,finished_at=NULL,recovery_count=0 WHERE id=$1",
          [runId],
        );
        await s.query(
          'UPDATE relay.runtime_dead_letters SET recovered_at=now(),resolution=$2 WHERE run_id=$1 AND recovered_at IS NULL',
          [runId, json({ actor: context.actor })],
        );
        await enqueue(s, runId);
      });
    },
  };
}
