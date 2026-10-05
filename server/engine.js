import { all, one, exec, id, now, decode, encode, transaction, safeError, redact } from './db.js';
import { validateGraph } from './catalog.js';
import { modelCall } from './providers.js';
import { getTool, executeTool, validateSchema } from './tools.js';
import { retrieve } from './knowledge.js';
import {
  registerWorker,
  heartbeat,
  owns,
  claimRuns,
  stopWorker,
  workerCapacity,
  workerId,
} from './leases.js';
const controllers = new Map();
const active = new Map();
export const nodeHandlers = {};
export function registerNode(kind, handler) {
  nodeHandlers[kind] = handler;
}
export function emit(runId, type, nodeId, data) {
  const wid = one('SELECT workspace_id FROM runs WHERE id=?', runId)?.workspace_id;
  data = redact(wid, data);
  exec(
    'INSERT INTO events(run_id,type,node_id,data,created_at) VALUES(?,?,?,?,?)',
    runId,
    type,
    nodeId || null,
    encode(data),
    now(),
  );
}
export const getPath = (value, path) =>
  String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((v, k) => v?.[k], value);
export const stringify = (value) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function snapshotGraph(graph, wid, stack = []) {
  const result = structuredClone(graph);
  for (const n of result.nodes) {
    const config = n.data.config || {};
    if (n.data.kind === 'tool' && config.toolId && !config.toolSnapshot)
      config.toolSnapshot = getTool(wid, config.toolId);
    if (
      ['agent', 'orchestrator'].includes(n.data.kind) &&
      config.toolIds?.length &&
      !config.toolSnapshots
    )
      config.toolSnapshots = config.toolIds.map((t) => getTool(wid, t));
    n.data.config = config;
    if (!['loop', 'subworkflow'].includes(n.data.kind)) continue;
    const cfg = n.data.config || {};
    if (cfg.graphSnapshot) {
      n.data.config = cfg;
      continue;
    }
    if (stack.includes(cfg.workflowId))
      throw new Error('Recursive subworkflows are not supported; use bounded iteration');
    const w = one('SELECT graph FROM workflows WHERE id=? AND workspace_id=?', cfg.workflowId, wid);
    if (!w) throw new Error('Reusable workflow was not found in this workspace');
    cfg.graphSnapshot = snapshotGraph(decode(w.graph), wid, [...stack, cfg.workflowId]);
    n.data.config = cfg;
  }
  return result;
}
export function createRun({
  wid,
  workflowId = null,
  versionId = null,
  graph,
  input,
  mode = 'preview',
  conversationId = null,
  parentId = null,
}) {
  const errors = validateGraph(graph);
  if (errors.length) throw new Error(errors.join('; '));
  if (!['preview', 'live'].includes(mode)) throw new Error('Choose preview or live execution');
  const runnable = snapshotGraph(graph, wid, workflowId ? [workflowId] : []);
  const runId = id();
  transaction(() => {
    exec(
      'INSERT INTO runs(id,workspace_id,workflow_id,version_id,graph,input,status,mode,conversation_id,parent_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      runId,
      wid,
      workflowId,
      versionId,
      encode(runnable),
      encode(input),
      'queued',
      mode,
      conversationId,
      parentId,
      now(),
    );
    for (const n of runnable.nodes)
      exec(
        'INSERT INTO steps(id,run_id,node_id,status) VALUES(?,?,?,?)',
        id(),
        runId,
        n.id,
        'queued',
      );
    emit(runId, 'run.queued', null, { mode, input });
  });
  return runId;
}
function states(runId) {
  return all('SELECT * FROM steps WHERE run_id=?', runId);
}
function persistUsage(runId, usage) {
  const row = one('SELECT usage FROM runs WHERE id=?', runId);
  const current = decode(row.usage);
  for (const key of ['inputTokens', 'outputTokens'])
    current[key] = (current[key] || 0) + (usage[key] || 0);
  current.costConfigured =
    current.costConfigured !== false &&
    (usage.estimatedCost != null || !(usage.inputTokens || usage.outputTokens));
  if (current.costConfigured)
    current.estimatedCost = (current.estimatedCost || 0) + (usage.estimatedCost || 0);
  else delete current.estimatedCost;
  exec('UPDATE runs SET usage=? WHERE id=?', encode(current), runId);
}
function connectionUsage(wid, config, usage) {
  const c = config.connectionId
    ? one('SELECT config FROM connections WHERE id=? AND workspace_id=?', config.connectionId, wid)
    : null;
  const prices = c ? decode(c.config) : {};
  return {
    ...usage,
    ...(prices.inputPrice != null && prices.outputPrice != null
      ? {
          estimatedCost:
            ((usage.inputTokens || 0) * prices.inputPrice +
              (usage.outputTokens || 0) * prices.outputPrice) /
            1e6,
        }
      : {}),
  };
}
function pauseClock(runId) {
  const r = one('SELECT active_ms,active_since FROM runs WHERE id=?', runId);
  if (!r) return;
  const delta = r.active_since ? Math.max(0, Date.now() - new Date(r.active_since).getTime()) : 0;
  exec('UPDATE runs SET active_ms=active_ms+?,active_since=NULL WHERE id=?', delta, runId);
}
async function executeAgent(ctx, config, input, orchestrator = false) {
  const memories =
    config.memory === 'persistent'
      ? all(
          'SELECT content FROM memories WHERE workspace_id=? AND agent_id=? ORDER BY created_at DESC LIMIT ?',
          ctx.wid,
          config.agentId || ctx.node.id,
          Math.max(1, Math.min(30, Number(config.memoryWindow) || 6)),
        )
      : config.memory === 'conversation' && ctx.run.conversation_id
        ? all(
            'SELECT content FROM memories WHERE workspace_id=? AND agent_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT ?',
            ctx.wid,
            config.agentId || ctx.node.id,
            ctx.run.conversation_id,
            Math.max(1, Math.min(30, Number(config.memoryWindow) || 6)),
          )
        : [];
  const knowledge = [];
  for (const collectionId of config.knowledgeIds || [])
    knowledge.push(
      ...(await retrieve(
        ctx.wid,
        collectionId,
        typeof ctx.runInput === 'string' ? ctx.runInput : stringify(ctx.runInput),
        config.topK || 4,
      )),
    );
  let task = input;
  if (input?.assignments) {
    const assigned = input.assignments.find((a) => a.nodeId === ctx.node.id);
    if (assigned) {
      task = { task: assigned.task, originalTask: ctx.runInput, plan: input.plan };
      ctx.emit('agent.assignment', {
        from: input.orchestrator,
        to: ctx.node.id,
        task: assigned.task,
      });
    }
  }
  const connected = ctx.graph.edges
    .filter((e) => e.source === ctx.node.id)
    .map((e) => ctx.graph.nodes.find((n) => n.id === e.target))
    .filter((n) => n?.data.kind === 'agent');
  const planning = orchestrator
    ? `You supervise these connected specialists: ${connected.map((n) => `${n.id}: ${n.data.label} (${n.data.config?.role || n.data.config?.instructions || ''})`).join('; ')}. Return JSON with {"plan":"...","assignments":[{"nodeId":"exact specialist id","task":"specific task"}]}. The dependency graph dispatches these tasks concurrently and collects their results downstream.`
    : '';
  const messages = [
    {
      role: 'system',
      content: `${config.instructions || 'Perform your assigned task.'}\n${planning}\n${config.outputSchema ? 'Return JSON conforming to: ' + encode(config.outputSchema) : ''}\n${knowledge.length ? 'Retrieved context with citations:\n' + stringify(knowledge) : ''}\n${
        memories.length
          ? 'Prior memory:\n' +
            memories
              .reverse()
              .map((m) => m.content)
              .join('\n')
          : ''
      }`,
    },
    { role: 'user', content: stringify(task) },
  ];
  const tools =
    config.toolSnapshots || (config.toolIds || []).map((toolId) => getTool(ctx.wid, toolId));
  const maxRounds = Math.max(1, Math.min(12, Number(config.maxSteps) || 5));
  for (let round = 0; round < maxRounds; round++) {
    ctx.emit('agent.message', {
      role: 'user',
      content: messages.findLast((m) => m.role === 'user')?.content,
      round,
    });
    const usageBefore = decode(one('SELECT usage FROM runs WHERE id=?', ctx.run.id).usage);
    if (
      (usageBefore.inputTokens || 0) + (usageBefore.outputTokens || 0) >=
      Number(ctx.graph.settings?.maxTokens || 50000)
    )
      throw new Error('Workflow usage limit reached; no further model calls will start');
    const result = await modelCall(
      { ...ctx, mode: ctx.run.mode, onToken: (token) => ctx.emit('model.token', { token }) },
      {
        ...config,
        label: ctx.node.data.label,
        ...(orchestrator ? { outputSchema: { type: 'object' } } : {}),
      },
      messages,
      tools,
    );
    ctx.assertLease();
    persistUsage(ctx.run.id, connectionUsage(ctx.wid, config, result.usage));
    ctx.emit('model.usage', result.usage);
    ctx.emit('agent.message', {
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
      round,
    });
    if (result.toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: result.text || null,
        tool_calls: result.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: encode(c.arguments) },
        })),
      });
      for (const call of result.toolCalls) {
        const tool = tools.find((t) => t.id === call.name);
        if (!tool) throw new Error('Model requested an unassigned tool');
        const output = await executeTool(
          ctx,
          tool,
          call.arguments,
          `round-${round}-tool-${call.name}-${result.toolCalls.indexOf(call)}`,
        );
        messages.push({ role: 'tool', tool_call_id: call.id, content: stringify(output) });
      }
      continue;
    }
    let output = result.text;
    if (orchestrator) {
      if (ctx.run.mode === 'preview')
        output = {
          plan: 'Development preview: dispatch the original task to each connected specialist.',
          orchestrator: ctx.node.id,
          assignments: connected.map((n) => ({
            nodeId: n.id,
            task: `${n.data.label}: ${stringify(ctx.runInput)}`,
          })),
          context: input,
        };
      else {
        try {
          output = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        } catch {
          throw new Error('Orchestrator must return a JSON plan and assignments');
        }
        if (
          !Array.isArray(output.assignments) ||
          connected.some(
            (n) => !output.assignments.some((a) => a.nodeId === n.id && typeof a.task === 'string'),
          )
        )
          throw new Error('Orchestrator did not assign a task to every connected specialist');
        output.orchestrator = ctx.node.id;
      }
      ctx.emit('orchestrator.plan', output);
    } else if (config.outputSchema) {
      if (ctx.run.mode === 'preview')
        throw new Error(
          'Structured model output needs a live model connection; development preview does not fabricate structured reasoning',
        );
      try {
        output = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        throw new Error('The model did not return valid JSON');
      }
      validateSchema(config.outputSchema, output);
    }
    if (config.memory && config.memory !== 'none') {
      exec(
        'INSERT INTO memories VALUES(?,?,?,?,?,?)',
        id(),
        ctx.wid,
        config.agentId || ctx.node.id,
        config.memory === 'conversation' ? ctx.run.conversation_id : null,
        stringify({ input: task, output }).slice(0, 20000),
        now(),
      );
    }
    ctx.emit('agent.result', { agent: ctx.node.id, output, citations: knowledge });
    return output;
  }
  throw new Error('Agent reached its tool-call step limit');
}
registerNode('input', (ctx) => ctx.runInput);
registerNode('output', (ctx, c, input) => input);
registerNode('parallel', (ctx, c, input) => input);
registerNode('join', (ctx, c, input) => input);
registerNode('agent', (ctx, c, input) => executeAgent(ctx, c, input));
registerNode('model', (ctx, c, input) =>
  executeAgent(ctx, { ...c, toolIds: [], memory: 'none', maxSteps: 1 }, input),
);
registerNode('orchestrator', (ctx, c, input) => executeAgent(ctx, c, input, true));
registerNode('tool', (ctx, c, input) =>
  executeTool(
    ctx,
    c.toolSnapshot ||
      (c.toolId
        ? getTool(ctx.wid, c.toolId)
        : {
            id: 'inline-' + ctx.node.id,
            name: ctx.node.data.label,
            kind: c.kind,
            config: { ...c, allowPrivate: false },
          }),
    c.input ?? input,
  ),
);
registerNode('knowledge', async (ctx, c, input) => ({
  query: typeof input === 'string' ? input : stringify(input),
  sources: await retrieve(
    ctx.wid,
    c.collectionId,
    typeof input === 'string' ? input : stringify(input),
    c.topK,
  ),
}));
registerNode('condition', (ctx, c, input) => {
  const value = c.path ? getPath(input, c.path) : input;
  const expected = c.value;
  const operations = {
    equals: () => String(value) === String(expected),
    contains: () => String(value).includes(String(expected)),
    gt: () => Number(value) > Number(expected),
    exists: () => value !== undefined && value !== null,
    truthy: () => !!value,
  };
  const op = operations[c.operator || 'truthy'];
  if (!op) throw new Error('Choose a supported condition operator');
  return { branch: op() ? 'true' : 'false', value: input };
});
registerNode('transform', (ctx, c, input) => {
  if (c.mapping)
    return Object.fromEntries(
      Object.entries(c.mapping).map(([key, path]) => [key, getPath(input, path)]),
    );
  if (c.path) return getPath(input, c.path) ?? null;
  if (c.template)
    return c.template.replace(/\{\{([^}]+)\}\}/g, (_, p) =>
      stringify(getPath(input, p.trim()) ?? ''),
    );
  return input;
});
registerNode('approval', (ctx, c, input) => {
  exec("UPDATE steps SET status='waiting',input=? WHERE id=?", encode(input), ctx.stepId);
  ctx.emit('approval.required', { prompt: c.prompt || 'Approve this result to continue', input });
  return Symbol.for('waiting');
});
async function childResult(ctx, config, input, index) {
  const parentKey = `${ctx.run.id}:${ctx.node.id}:${index}`;
  let child = one('SELECT * FROM runs WHERE parent_id=?', parentKey);
  if (!child) {
    if (!config.graphSnapshot) throw new Error('Reusable workflow snapshot is missing');
    const rid = createRun({
      wid: ctx.wid,
      workflowId: config.workflowId,
      graph: config.graphSnapshot,
      input,
      mode: ctx.run.mode,
      conversationId: ctx.run.conversation_id,
      parentId: parentKey,
    });
    child = one('SELECT * FROM runs WHERE id=?', rid);
    ctx.emit('subworkflow.started', { runId: rid, iteration: index });
  }
  if (ctx.signal.aborted) {
    cancelRun(child.id);
    throw ctx.signal.reason;
  }
  child = one('SELECT * FROM runs WHERE id=?', child.id);
  if (child.status === 'completed') {
    if (
      !one(
        "SELECT id FROM events WHERE run_id=? AND node_id=? AND type='subworkflow.usage' AND json_extract(data,'$.runId')=?",
        ctx.run.id,
        ctx.node.id,
        child.id,
      )
    ) {
      persistUsage(ctx.run.id, decode(child.usage));
      ctx.emit('subworkflow.usage', { runId: child.id, usage: decode(child.usage) });
    }
    return decode(child.output);
  }
  if (['failed', 'cancelled'].includes(child.status))
    throw new Error(`Reusable workflow ${child.status}: ${child.error || 'cancelled'}`);
  return Symbol.for('child-pending');
}
registerNode('subworkflow', (ctx, c, input) => childResult(ctx, c, input, 0));
registerNode('loop', async (ctx, c, input) => {
  const max = Math.max(1, Math.min(20, Number(c.maxIterations) || 3));
  const items = c.itemsPath ? getPath(input, c.itemsPath) : null;
  if (items && !Array.isArray(items)) throw new Error('Loop item path must resolve to an array');
  if (items?.length > max) throw new Error('Input item count exceeds the bounded iteration limit');
  const results = [];
  let previous = input;
  const count = items ? items.length : max;
  for (let i = 0; i < count; i++) {
    ctx.emit('loop.iteration', { iteration: i + 1, total: count });
    previous = await childResult(
      ctx,
      c,
      items ? items[i] : { task: ctx.runInput, previous, iteration: i + 1 },
      i,
    );
    if (previous === Symbol.for('child-pending')) return previous;
    results.push(previous);
    if (c.stopPath && getPath(previous, c.stopPath)) break;
  }
  return c.result === 'last' ? previous : results;
});
async function executeStep(run, node, step, input) {
  const key = step.id;
  const controller = controllers.get(run.id) || new AbortController();
  controllers.set(run.id, controller);
  const timeout = AbortSignal.timeout(
    Math.max(1000, Math.min(600000, Number(node.data.config?.timeoutMs) || 60000)),
  );
  const signal = AbortSignal.any([controller.signal, timeout]);
  active.set(key, { runId: run.id });
  exec(
    "UPDATE steps SET status='running',input=?,started_at=?,attempt=attempt+1 WHERE id=?",
    encode(input),
    now(),
    key,
  );
  emit(run.id, 'node.running', node.id, { input, label: node.data.label });
  const graph = decode(run.graph),
    cfg = node.data.config || {};
  try {
    const output = await nodeHandlers[node.data.kind](
      {
        wid: run.workspace_id,
        run,
        runId: run.id,
        runInput: decode(run.input),
        stepId: step.id,
        node,
        graph,
        signal,
        assertLease: () => {
          if (!owns(run)) throw new Error('Worker lease was lost; stale execution stopped');
        },
        emit: (type, data) => {
          if (!owns(run)) throw new Error('Worker lease was lost; stale execution stopped');
          emit(run.id, type, node.id, data);
        },
      },
      cfg,
      input,
    );
    if (!owns(run)) return;
    if (output === Symbol.for('waiting')) return;
    if (output === Symbol.for('child-pending')) {
      exec("UPDATE steps SET status='waiting' WHERE id=?", key);
      emit(run.id, 'subworkflow.waiting', node.id, {
        reason: 'Waiting for reusable workflow checkpoint',
      });
      return;
    }
    if (one('SELECT status FROM runs WHERE id=?', run.id).status === 'cancelled') return;
    exec(
      "UPDATE steps SET status='completed',output=?,finished_at=?,error=NULL WHERE id=?",
      encode(output),
      now(),
      key,
    );
    emit(run.id, 'node.completed', node.id, {
      output,
      durationMs:
        Date.now() -
        new Date(one('SELECT started_at FROM steps WHERE id=?', key).started_at).getTime(),
    });
  } catch (e) {
    if (!owns(run)) return;
    if (one('SELECT status FROM runs WHERE id=?', run.id).status === 'cancelled') return;
    const uncertain = one('SELECT id FROM actions WHERE step_id=? AND side_effect=1', key);
    const retries = Math.max(0, Math.min(3, Number(cfg.retries) || 0));
    if (step.attempt < retries && !uncertain && !signal.aborted) {
      exec("UPDATE steps SET status='queued',error=? WHERE id=?", safeError(e), key);
      emit(run.id, 'node.retry', node.id, { error: safeError(e) });
    } else {
      exec(
        "UPDATE steps SET status='failed',error=?,finished_at=? WHERE id=?",
        safeError(e),
        now(),
        key,
      );
      emit(run.id, 'node.failed', node.id, { error: safeError(e) });
    }
  } finally {
    active.delete(key);
  }
}
function edgeActive(edge, rows) {
  const src = rows.find((s) => s.node_id === edge.source);
  if (!src || src.status !== 'completed') return false;
  const output = decode(src.output);
  return !output?.branch || (edge.data?.branch || edge.label) === output.branch;
}
function pumpRun(run) {
  const graph = decode(run.graph);
  let rows = states(run.id);
  for (const row of rows.filter((s) => s.status === 'waiting')) {
    const n = graph.nodes.find((n) => n.id === row.node_id);
    if (!['loop', 'subworkflow'].includes(n?.data.kind)) continue;
    const children = all(
      'SELECT status FROM runs WHERE parent_id LIKE ?',
      run.id + ':' + row.node_id + ':%',
    );
    if (
      children.length &&
      children.every((c) => ['completed', 'failed', 'cancelled'].includes(c.status))
    )
      exec("UPDATE steps SET status='queued' WHERE id=?", row.id);
  }
  rows = states(run.id);
  if (run.status === 'queued') {
    exec("UPDATE runs SET status='running' WHERE id=?", run.id);
    emit(run.id, 'run.running', null, {});
  }
  if (!controllers.has(run.id)) controllers.set(run.id, new AbortController());
  let inFlight = [...active.values()].filter((s) => s.runId === run.id).length;
  const concurrency = Math.max(1, Math.min(8, Number(graph.settings?.concurrency) || 4));
  for (const row of rows.filter((r) => r.status === 'queued')) {
    if (inFlight >= concurrency || active.size >= workerCapacity) break;
    const node = graph.nodes.find((n) => n.id === row.node_id);
    const incoming = graph.edges.filter((e) => e.target === node.id);
    const parents = incoming.map((e) => rows.find((s) => s.node_id === e.source));
    if (parents.some((s) => ['queued', 'running', 'waiting'].includes(s.status))) continue;
    if (incoming.length && !incoming.some((e) => edgeActive(e, rows))) {
      exec("UPDATE steps SET status='skipped',finished_at=? WHERE id=?", now(), row.id);
      emit(run.id, 'node.skipped', node.id, { reason: 'No active incoming route' });
      continue;
    }
    if (parents.some((s) => s.status === 'failed') && !node.data.config?.continueOnError) {
      exec(
        "UPDATE steps SET status='skipped',finished_at=?,error=? WHERE id=?",
        now(),
        'An upstream dependency failed',
        row.id,
      );
      continue;
    }
    const values = incoming
      .filter((e) => edgeActive(e, rows))
      .map((e) => {
        const source = rows.find((s) => s.node_id === e.source);
        const result = decode(source.output);
        return result?.branch ? result.value : result;
      });
    const input =
      values.length === 1
        ? values[0]
        : values.length
          ? Object.fromEntries(
              incoming.filter((e) => edgeActive(e, rows)).map((e, i) => [e.source, values[i]]),
            )
          : decode(run.input);
    inFlight++;
    void executeStep(run, node, row, input);
  }
  rows = states(run.id);
  if (rows.some((s) => s.status === 'waiting') && !rows.some((s) => s.status === 'running')) {
    if (run.status !== 'waiting') {
      pauseClock(run.id);
      exec("UPDATE runs SET status='waiting' WHERE id=?", run.id);
      emit(run.id, 'run.waiting', null, {});
    }
    return;
  }
  if (rows.some((s) => ['queued', 'running'].includes(s.status))) return;
  if (rows.some((s) => s.status === 'waiting')) {
    if (run.status !== 'waiting') {
      pauseClock(run.id);
      exec("UPDATE runs SET status='waiting' WHERE id=?", run.id);
      emit(run.id, 'run.waiting', null, {});
    }
    return;
  }
  const failures = rows.filter((s) => s.status === 'failed');
  const outputs = graph.nodes
    .filter((n) => n.data.kind === 'output')
    .map((n) => rows.find((s) => s.node_id === n.id))
    .filter((s) => s.status === 'completed');
  const output =
    outputs.length === 1
      ? decode(outputs[0].output)
      : Object.fromEntries(outputs.map((s) => [s.node_id, decode(s.output)]));
  const status = failures.length || !outputs.length ? 'failed' : 'completed';
  pauseClock(run.id);
  exec(
    'UPDATE runs SET status=?,output=?,error=?,finished_at=? WHERE id=?',
    status,
    encode(output),
    failures.map((s) => s.error).join('; ') ||
      (!outputs.length ? 'No final output was produced' : null),
    now(),
    run.id,
  );
  emit(run.id, 'run.' + status, null, {
    output,
    partial: outputs.length > 0 && failures.length > 0,
  });
  if (run.parent_id)
    exec(
      "UPDATE runs SET status='queued' WHERE id=? AND status='waiting'",
      run.parent_id.split(':')[0],
    );
  controllers.delete(run.id);
}
export function pump() {
  for (const [rid, controller] of controllers) {
    const r = one('SELECT status,lease_owner FROM runs WHERE id=?', rid);
    if (
      !r ||
      ['cancelled', 'failed', 'completed'].includes(r.status) ||
      r.lease_owner !== workerId
    ) {
      controller.abort(new Error('Run ended'));
      controllers.delete(rid);
    }
  }
  heartbeat(active.size);
  for (const run of claimRuns(recoverRun)) {
    try {
      const graph = decode(run.graph);
      if (run.status !== 'waiting') {
        const delta = run.active_since
          ? Math.max(0, Date.now() - new Date(run.active_since).getTime())
          : 0;
        run.active_ms = (run.active_ms || 0) + delta;
        if (!run.active_since || delta >= 1000)
          exec(
            'UPDATE runs SET active_ms=?,active_since=? WHERE id=?',
            run.active_ms,
            now(),
            run.id,
          );
      }
      if (run.status !== 'waiting' && run.active_ms > Number(graph.settings?.timeoutMs || 600000)) {
        cancelRun(run.id, 'Workflow time limit exceeded');
        continue;
      }
      pumpRun(run);
    } catch (e) {
      exec(
        "UPDATE runs SET status='failed',error=?,finished_at=? WHERE id=?",
        safeError(e),
        now(),
        run.id,
      );
      emit(run.id, 'run.failed', null, { error: safeError(e) });
      controllers.get(run.id)?.abort();
    }
  }
}
export function cancelRun(runId, reason = 'Cancelled by user') {
  const run = one('SELECT status FROM runs WHERE id=?', runId);
  if (!run || !['queued', 'running', 'waiting'].includes(run.status)) return;
  pauseClock(runId);
  exec(
    "UPDATE runs SET status='cancelled',error=?,finished_at=? WHERE id=? AND status IN ('queued','running','waiting')",
    reason,
    now(),
    runId,
  );
  exec(
    "UPDATE steps SET status='cancelled',finished_at=? WHERE run_id=? AND status IN ('queued','running','waiting')",
    now(),
    runId,
  );
  controllers.get(runId)?.abort(new Error(reason));
  emit(runId, 'run.cancelled', null, { reason });
  for (const child of all(
    "SELECT id FROM runs WHERE parent_id LIKE ? AND status IN ('queued','running','waiting')",
    runId + ':%',
  ))
    cancelRun(child.id, reason);
}
export function approveStep(runId, nodeId, approved, feedback = '') {
  const step = one(
    "SELECT * FROM steps WHERE run_id=? AND node_id=? AND status='waiting'",
    runId,
    nodeId,
  );
  if (!step) throw new Error('This step is not waiting for approval');
  exec(
    'UPDATE steps SET status=?,output=?,error=?,finished_at=? WHERE id=?',
    approved ? 'completed' : 'failed',
    encode(decode(step.input)),
    approved ? null : 'Approval rejected: ' + feedback,
    now(),
    step.id,
  );
  exec("UPDATE runs SET status='queued',active_since=NULL WHERE id=?", runId);
  emit(runId, approved ? 'approval.accepted' : 'approval.rejected', nodeId, {
    feedback,
    input: decode(step.input),
  });
}
export function retryRun(runId) {
  const run = one('SELECT * FROM runs WHERE id=?', runId);
  if (!run || !['failed', 'cancelled'].includes(run.status))
    throw new Error('Only failed or cancelled runs can be retried');
  const uncertain = all(
    "SELECT a.id FROM actions a JOIN steps s ON a.step_id=s.id WHERE a.run_id=? AND a.side_effect=1 AND (a.status!='completed' OR s.status IN ('failed','cancelled'))",
    runId,
  );
  if (uncertain.length)
    throw new Error(
      'This run has actions with uncertain outcomes. Inspect and reconcile them before retrying. Start a new run only after verifying external effects.',
    );
  for (const step of states(runId).filter((s) =>
    ['failed', 'skipped', 'cancelled'].includes(s.status),
  ))
    exec("UPDATE steps SET status='queued',error=NULL,finished_at=NULL WHERE id=?", step.id);
  exec(
    "UPDATE runs SET status='queued',error=NULL,finished_at=NULL,active_ms=0,active_since=NULL,created_at=? WHERE id=?",
    now(),
    runId,
  );
  emit(runId, 'run.retry', null, {});
}
function recoverRun(runId) {
  exec('UPDATE runs SET active_since=NULL WHERE id=?', runId);
  for (const step of all("SELECT * FROM steps WHERE status='running' AND run_id=?", runId)) {
    const actions = all('SELECT * FROM actions WHERE step_id=? AND side_effect=1', step.id);
    if (actions.length) {
      exec(
        "UPDATE steps SET status='failed',error=? WHERE id=?",
        'Server restarted during an external action. Outcome is uncertain; automatic replay was blocked.',
        step.id,
      );
      emit(step.run_id, 'node.failed', step.node_id, {
        error: 'External action interrupted; reconciliation required',
      });
    } else {
      exec("UPDATE steps SET status='queued' WHERE id=?", step.id);
      emit(step.run_id, 'node.recovered', step.node_id, {
        reason: 'Recovered persisted checkpoint',
      });
    }
  }
}
export function recover() {
  for (const source of all(
    "SELECT id FROM sources WHERE status='queued' OR (status='indexing' AND (index_lease_until IS NULL OR index_lease_until<?))",
    Date.now(),
  ))
    import('./knowledge.js').then((m) => m.indexSource(source.id));
}
export function startEngine({ maintenance = () => {} } = {}) {
  registerWorker();
  recover();
  const timer = setInterval(() => {
    pump();
    try {
      maintenance();
    } catch (error) {
      console.error('Worker maintenance failed:', safeError(error));
    }
  }, 75);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const c of controllers.values()) c.abort(new Error('Server stopped'));
    stopWorker();
  };
}
