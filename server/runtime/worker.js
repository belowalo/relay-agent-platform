import Ajv from 'ajv';
import { performance } from 'node:perf_hooks';
import {
  contextFor,
  decode,
  json,
  uuid,
  fail,
  limitsFor,
  boundOutput,
  plan,
  getPath,
  RuntimeError,
  safeCode,
  bestEffortTelemetry,
} from './core.js';
const WAIT = Symbol('waiting');
const stringify = (value) => (typeof value === 'string' ? value : json(value));
const schemaValidator = new Ajv({ allErrors: true, strict: false });
function validate(schema, value) {
  if (schema && !schemaValidator.compile(schema)(value)) fail('OUTPUT_SCHEMA');
}
function abortable(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new RuntimeError('CANCELLED'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
}
export function createRuntimeWorker({
  repository,
  authorize,
  usage,
  model,
  tools,
  knowledge,
  memory,
  telemetry = { event() {}, timing() {} },
  ownerId = uuid(),
  leaseMs = 30000,
  shutdownMs = 30000,
  nodeConcurrency = 8,
}) {
  if (typeof authorize !== 'function' || !usage?.reserve || !usage?.settle || !usage?.release)
    fail('MISSING_RUNTIME_PORTS');
  if (!Number.isInteger(nodeConcurrency) || nodeConcurrency < 1 || nodeConcurrency > 128)
    fail('INVALID_LIMITS');
  const active = new Map();
  telemetry = bestEffortTelemetry(telemetry);
  let activeNodes = 0;
  async function nodeSlot(signal, invoke) {
    while (activeNodes >= nodeConcurrency) {
      signal.throwIfAborted();
      await new Promise((r) => setTimeout(r, 10));
    }
    signal.throwIfAborted();
    activeNodes++;
    try {
      return await invoke();
    } finally {
      activeNodes--;
    }
  }
  let draining = false;
  async function permitted(context, run, signal) {
    signal.throwIfAborted();
    if (!(await authorize(context, { operation: 'execute', run }))) fail('FORBIDDEN');
  }
  async function toolCall(ctx, tool, args, checkpoint, callKey) {
    if (checkpoint.reservationId) fail('USAGE_RECONCILIATION_REQUIRED');
    await permitted(ctx.context, ctx.run, ctx.signal);
    await repository.assertLease(ctx.context, ctx.lease);
    if (!tools?.describe || !tools?.invoke) fail('TOOL_PORT_UNAVAILABLE');
    const descriptor = await tools.describe(ctx.context, tool);
    if (!['read', 'write'].includes(descriptor.effect)) fail('INVALID_TOOL_DESCRIPTOR');
    validate(descriptor.inputSchema, args);
    boundOutput(args, ctx.limits);
    let action;
    if (descriptor.effect === 'write') {
      action = await repository.prepareAction(
        ctx.context,
        ctx.lease,
        ctx.step,
        tool,
        args,
        checkpoint,
        descriptor.requiresApproval !== false,
        callKey,
      );
      if (action.status === 'succeeded') return decode(action.result);
      if (action.status === 'uncertain' || action.status === 'started') fail('UNCERTAIN_ACTION');
      if (action.status === 'failed') fail('ACTION_FAILED');
      if (action.approval?.status === 'rejected') fail('APPROVAL_REJECTED');
      if (action.approval?.status === 'pending') {
        await repository.waitStep(ctx.context, ctx.lease, ctx.step.id);
        return WAIT;
      }
    }
    // Approval decisions can wait indefinitely; check current permissions immediately before the effect.
    await permitted(ctx.context, ctx.run, ctx.signal);
    await repository.assertLease(ctx.context, ctx.lease);
    const reservation = descriptor.metered
      ? await usage.reserve(ctx.context, {
          runId: ctx.run.id,
          maximumTokens: descriptor.maximumTokens || 0,
          maximumCostMicros: descriptor.maximumCostMicros ?? null,
        })
      : null;
    if (reservation)
      await repository.checkpoint(ctx.context, ctx.lease, ctx.step.id, {
        ...checkpoint,
        reservationId: reservation.id,
      });
    try {
      if (action) await repository.startAction(ctx.context, ctx.lease, action.id, args);
      const started = performance.now();
      const result = await abortable(
        () =>
          tools.invoke(ctx.context, {
            tool,
            input: args,
            signal: ctx.signal,
            idempotencyKey:
              descriptor.idempotency === 'provider-key' ? action?.idempotency_key : undefined,
            actionId: action?.id,
          }),
        ctx.signal,
      );
      ctx.telemetry.timing('runtime.provider_ms', performance.now() - started, {
        runId: ctx.run.id,
        kind: 'tool',
      });
      boundOutput(result.data, ctx.limits);
      if (action)
        await repository.outcome(
          ctx.context,
          ctx.lease,
          action.id,
          'succeeded',
          result.data,
          result.providerRequestId,
        );
      if (reservation)
        await usage.settle(ctx.context, reservation.id, {
          tokens: result.usage?.tokens || 0,
          costMicros: result.usage?.costMicros ?? null,
          provider: result.usage?.provider || tool.kind,
          model: result.usage?.model || 'tool',
        });
      if (reservation) await repository.checkpoint(ctx.context, ctx.lease, ctx.step.id, checkpoint);
      return result.data;
    } catch (error) {
      // Provider adapters may assert known non-execution. Everything else after start is ambiguous.
      if (reservation && error.knownNotExecuted === true) {
        await usage.release(ctx.context, reservation.id);
        await repository.checkpoint(ctx.context, ctx.lease, ctx.step.id, checkpoint);
      }
      if (action)
        await repository
          .outcome(
            ctx.context,
            ctx.lease,
            action.id,
            error.knownNotExecuted === true ? 'failed' : 'uncertain',
            null,
          )
          .catch(() => {});
      throw error.knownNotExecuted === true
        ? error
        : new RuntimeError(action ? 'UNCERTAIN_ACTION' : safeCode(error, 'DEPENDENCY_UNAVAILABLE'));
    }
  }
  async function agent(ctx, c, input, orchestrator = false) {
    if (!model?.call) fail('MODEL_PORT_UNAVAILABLE');
    let cp = decode(ctx.step.checkpoint) || {};
    if (cp.reservationId) fail('USAGE_RECONCILIATION_REQUIRED');
    const assigned = input?.assignments?.find((a) => a.nodeId === ctx.node.id);
    const task = assigned
      ? { task: assigned.task, originalTask: input.context, plan: input.plan }
      : input;
    const connected = ctx.graph.edges
      .filter((e) => e.source === ctx.node.id)
      .map((e) => ctx.graph.nodes.find((n) => n.id === e.target))
      .filter((n) => n?.data.kind === 'agent');
    let evidence = cp.knowledge;
    if (!evidence) {
      evidence = [];
      for (const id of c.knowledgeIds || []) {
        if (!knowledge?.retrieve) fail('KNOWLEDGE_PORT_UNAVAILABLE');
        evidence.push(
          ...(await knowledge.retrieve(ctx.context, {
            collectionId: id,
            query: stringify(task),
            topK: c.topK || 4,
            signal: ctx.signal,
          })),
        );
      }
    }
    let memories = [];
    if (c.memory && c.memory !== 'none') {
      if (!memory) fail('MEMORY_PORT_UNAVAILABLE');
      memories = await memory.read(ctx.context, {
        agentId: c.agentId || ctx.node.id,
        conversationId: ctx.run.conversation_id,
        mode: c.memory,
        limit: Math.min(30, c.memoryWindow || 6),
      });
    }
    let messages = cp.messages || [
      {
        role: 'system',
        content:
          (c.instructions || 'Perform your assigned task.').replace(
            /\{\{\s*(input|task)(?:\.([^}]+))?\s*\}\}/g,
            (_, root, path) => {
              const v = path
                ? getPath(root === 'input' ? task : ctx.runInput, path)
                : root === 'input'
                  ? task
                  : ctx.runInput;
              if (v === undefined) fail('PROMPT_VARIABLE');
              return stringify(v);
            },
          ) +
          (orchestrator
            ? '\nReturn JSON {plan,assignments:[{nodeId,task}]} for specialists ' +
              stringify(connected.map((n) => ({ nodeId: n.id, label: n.data.label })))
            : '') +
          '\nEvidence: ' +
          stringify(evidence) +
          '\nMemory: ' +
          stringify(memories),
      },
      { role: 'user', content: stringify(task) },
    ];
    const assignedTools = c.toolSnapshots || [];
    const maxRounds = Math.min(ctx.limits.rounds, c.maxSteps || ctx.limits.rounds);
    for (let round = cp.round || 0; round < maxRounds; round++) {
      let result = cp.round === round ? cp.result : null;
      if (!result) {
        await permitted(ctx.context, ctx.run, ctx.signal);
        await repository.assertLease(ctx.context, ctx.lease);
        // The adapter must reserve each fallback through meteredCall too; no hidden fallback charge.
        const meteredCall = async (request, invoke) => {
          const reservation = await usage.reserve(ctx.context, {
            runId: ctx.run.id,
            maximumTokens: request.maximumTokens,
            maximumCostMicros: request.maximumCostMicros ?? null,
          });
          await repository.checkpoint(ctx.context, ctx.lease, ctx.step.id, {
            round,
            messages,
            knowledge: evidence,
            toolsUsed: cp.toolsUsed || 0,
            reservationId: reservation.id,
          });
          try {
            await permitted(ctx.context, ctx.run, ctx.signal);
            await repository.assertLease(ctx.context, ctx.lease);
            const start = performance.now();
            const response = await abortable(invoke, ctx.signal);
            ctx.telemetry.timing('runtime.provider_ms', performance.now() - start, {
              runId: ctx.run.id,
              kind: 'model',
            });
            await usage.settle(ctx.context, reservation.id, {
              tokens:
                response.usage?.tokens ??
                (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0),
              costMicros: response.usage?.costMicros ?? null,
              provider: response.provider || 'unknown',
              model: response.model || 'unknown',
            });
            return response;
          } catch (e) {
            if (e.knownNotExecuted === true) {
              await usage.release(ctx.context, reservation.id);
              await repository.checkpoint(ctx.context, ctx.lease, ctx.step.id, {
                round,
                messages,
                knowledge: evidence,
                toolsUsed: cp.toolsUsed || 0,
              });
            }
            throw e;
          }
        };
        let calls = 0;
        result = await model.call(ctx.context, {
          config: c,
          messages,
          tools: assignedTools,
          signal: ctx.signal,
          mode: ctx.run.mode,
          meteredCall: async (req, fn) => {
            calls++;
            return meteredCall(req, fn);
          },
        });
        if (!calls) fail('UNMETERED_MODEL');
        boundOutput(result, ctx.limits);
        cp = {
          round,
          messages,
          result,
          knowledge: evidence,
          toolsUsed: cp.toolsUsed || 0,
          toolIndex: 0,
        };
        await repository.checkpoint(ctx.context, ctx.lease, ctx.step.id, cp);
      }
      if (result.toolCalls?.length) {
        let next = cp.nextMessages || [
          ...messages,
          {
            role: 'assistant',
            content: result.text,
            tool_calls: result.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: json(call.arguments) },
            })),
          },
        ];
        for (let index = cp.toolIndex || 0; index < result.toolCalls.length; index++) {
          const call = result.toolCalls[index],
            tool = assignedTools.find((t) => t.id === call.name);
          if (!tool) fail('UNASSIGNED_TOOL');
          if ((cp.toolsUsed || 0) >= ctx.limits.tools) fail('TOOL_LIMIT');
          const out = await toolCall(
            ctx,
            tool,
            call.arguments,
            { ...cp, nextMessages: next },
            `round-${round}-tool-${index}`,
          );
          if (out === WAIT) return WAIT;
          next.push({ role: 'tool', tool_call_id: call.id, content: stringify(out) });
          cp = {
            ...cp,
            toolsUsed: (cp.toolsUsed || 0) + 1,
            toolIndex: index + 1,
            nextMessages: next,
          };
          await repository.checkpoint(ctx.context, ctx.lease, ctx.step.id, cp);
        }
        messages = next;
        cp = {
          round: round + 1,
          messages,
          result: null,
          knowledge: evidence,
          toolsUsed: cp.toolsUsed,
        };
        await repository.checkpoint(ctx.context, ctx.lease, ctx.step.id, cp);
        continue;
      }
      let output = result.text;
      if (orchestrator || c.outputSchema) {
        try {
          output = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        } catch {
          fail('INVALID_MODEL_JSON');
        }
        validate(c.outputSchema, output);
      }
      if (orchestrator) {
        if (
          !Array.isArray(output.assignments) ||
          connected.some(
            (n) => !output.assignments.some((a) => a.nodeId === n.id && typeof a.task === 'string'),
          )
        )
          fail('INVALID_ASSIGNMENTS');
        output = { ...output, orchestrator: ctx.node.id, context: input };
      }
      if (c.memory && c.memory !== 'none')
        await memory.write(ctx.context, {
          agentId: c.agentId || ctx.node.id,
          conversationId: ctx.run.conversation_id,
          mode: c.memory,
          content: stringify({ input: task, output }).slice(0, 20000),
        });
      return output;
    }
    fail('ROUND_LIMIT');
  }
  async function handle(ctx, c, input) {
    switch (ctx.node.data.kind) {
      case 'input':
        return ctx.runInput;
      case 'output':
      case 'parallel':
      case 'join':
        return input;
      case 'condition': {
        const v = c.path ? getPath(input, c.path) : input;
        const ops = {
          equals: () => String(v) === String(c.value),
          contains: () => String(v).includes(String(c.value)),
          gt: () => Number(v) > Number(c.value),
          exists: () => v != null,
          truthy: () => !!v,
        };
        if (!ops[c.operator || 'truthy']) fail('INVALID_OPERATOR');
        return { branch: ops[c.operator || 'truthy']() ? 'true' : 'false', value: input };
      }
      case 'transform':
        return c.mapping
          ? Object.fromEntries(
              Object.entries(c.mapping).map(([k, p]) => [k, getPath(input, p) ?? null]),
            )
          : c.path
            ? (getPath(input, c.path) ?? null)
            : c.template
              ? c.template.replace(/\{\{([^}]+)\}\}/g, (_, p) =>
                  stringify(getPath(input, p.trim()) ?? ''),
                )
              : input;
      case 'guardrail': {
        validate(c.schema, input);
        if (stringify(input).length > (c.maxChars || 100000)) fail('GUARDRAIL');
        if (
          (c.blockedTerms || []).some((t) =>
            stringify(input).toLowerCase().includes(t.toLowerCase()),
          )
        )
          fail('GUARDRAIL');
        const visit = (v) =>
          typeof v === 'string'
            ? (c.redactTerms || []).reduce(
                (str, t) => str.split(t).join('[redacted]'),
                c.redactEmails
                  ? v.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
                  : v,
              )
            : Array.isArray(v)
              ? v.map(visit)
              : v && typeof v === 'object'
                ? Object.fromEntries(Object.entries(v).map(([k, val]) => [k, visit(val)]))
                : v;
        return visit(input);
      }
      case 'knowledge':
        if (!knowledge?.retrieve) fail('KNOWLEDGE_PORT_UNAVAILABLE');
        return {
          query: stringify(input),
          sources: await knowledge.retrieve(ctx.context, {
            collectionId: c.collectionId,
            query: stringify(input),
            topK: c.topK || 4,
            options: c.retrievalOptions,
            signal: ctx.signal,
          }),
        };
      case 'agent':
      case 'orchestrator':
      case 'model':
        return agent(
          ctx,
          ctx.node.data.kind === 'model'
            ? { ...c, toolSnapshots: [], maxSteps: 1, memory: 'none' }
            : c,
          input,
          ctx.node.data.kind === 'orchestrator',
        );
      case 'tool':
        return toolCall(
          ctx,
          c.toolSnapshot || { id: 'inline-' + ctx.node.id, kind: c.kind, config: c },
          c.input ?? input,
          decode(ctx.step.checkpoint) || {},
          'node',
        );
      case 'approval': {
        const action = await repository.prepareAction(
          ctx.context,
          ctx.lease,
          ctx.step,
          { id: 'human-' + ctx.node.id },
          input,
          { input },
          true,
          'human',
        );
        if (action.approval.status === 'rejected') fail('APPROVAL_REJECTED');
        if (action.approval.status !== 'approved') {
          await repository.waitStep(ctx.context, ctx.lease, ctx.step.id);
          return WAIT;
        }
        await repository.startAction(ctx.context, ctx.lease, action.id, input);
        await repository.outcome(ctx.context, ctx.lease, action.id, 'succeeded', input);
        return input;
      }
      case 'subworkflow':
      case 'loop': {
        const items = c.itemsPath ? getPath(input, c.itemsPath) : null,
          max = Math.min(20, c.maxIterations || 3);
        if (items && (!Array.isArray(items) || items.length > max)) fail('LOOP_LIMIT');
        const count = ctx.node.data.kind === 'subworkflow' ? 1 : items ? items.length : max;
        const results = [];
        let previous = input;
        for (let i = 0; i < count; i++) {
          const child = await repository.child(
            ctx.context,
            ctx.lease,
            ctx.node,
            c.graphSnapshot,
            ctx.node.data.kind === 'subworkflow'
              ? input
              : items
                ? items[i]
                : { task: ctx.runInput, previous, iteration: i + 1 },
            i,
            ctx.limits,
          );
          if (['failed', 'cancelled'].includes(child.status)) fail('CHILD_FAILED');
          if (child.status !== 'completed') {
            await repository.waitStep(ctx.context, ctx.lease, ctx.step.id);
            return WAIT;
          }
          previous = decode(child.output);
          results.push(previous);
          if (c.stopPath && getPath(previous, c.stopPath)) break;
        }
        return ctx.node.data.kind === 'subworkflow' || c.result === 'last' ? previous : results;
      }
      default:
        fail('UNSUPPORTED_NODE');
    }
  }
  async function execute(reference) {
    if (reference.kind !== 'workflow.run') fail('UNSUPPORTED_JOB_KIND');
    if (draining || active.has(reference.resourceId)) return;
    // Queue-supplied workspace does not authenticate. Load under RLS, then recover saved authorized actor.
    const lookup = {
      workspaceId: reference.workspaceId,
      actor: { kind: 'service', id: ownerId },
      requestId: reference.requestId,
    };
    const persisted = await repository.getRun(lookup, reference.resourceId);
    if (!persisted?.actor) return;
    const context = contextFor(persisted);
    if (!(await authorize(context, { operation: 'execute', run: persisted }))) {
      await repository.cancel(context, persisted.id);
      return;
    }
    const claimed = await repository.claim(context, persisted.id, ownerId);
    if (!claimed) return;
    const { run, lease } = claimed,
      limits = { ...limitsFor(decode(run.limits)), depth: decode(run.limits).depth || 0 };
    const started = performance.now(),
      controller = new AbortController();
    active.set(run.id, controller);
    const remaining = limits.durationMs - Number(run.active_ms);
    const durationTimer = setTimeout(
      () => controller.abort(new RuntimeError('RUN_TIMEOUT')),
      Math.max(1, remaining),
    );
    let beating = false;
    const heartbeat = setInterval(
      async () => {
        if (beating) return;
        beating = true;
        try {
          await repository.heartbeat(context, lease);
          if (!(await authorize(context, { operation: 'execute', run })))
            controller.abort(new RuntimeError('FORBIDDEN'));
        } catch {
          controller.abort(new RuntimeError('STALE_LEASE'));
        } finally {
          beating = false;
        }
      },
      Math.max(50, Math.floor(leaseMs / 3)),
    );
    let providerMs = 0;
    const measured = {
      event: telemetry.event.bind(telemetry),
      timing(name, ms, attributes) {
        if (name === 'runtime.provider_ms') providerMs += ms;
        telemetry.timing(name, ms, attributes);
      },
    };
    try {
      if (remaining <= 0) fail('RUN_TIMEOUT');
      for (let wave = 0; wave <= limits.nodes; wave++) {
        controller.signal.throwIfAborted();
        await permitted(context, run, controller.signal);
        let steps = await repository.getSteps(context, run.id);
        const next = plan(decode(run.graph), steps, decode(run.input));
        if (next.skipped.length) await repository.skip(context, lease, next.skipped);
        if (!next.ready.length) {
          steps = await repository.getSteps(context, run.id);
          if (steps.some((s) => s.status === 'waiting')) {
            await repository.pause(context, lease);
            return;
          }
          if (steps.some((s) => ['queued', 'running'].includes(s.status))) {
            if (next.skipped.length) continue;
            fail('GRAPH_STALLED');
          }
          const outputs = decode(run.graph)
            .nodes.filter((n) => n.data.kind === 'output')
            .map((n) => steps.find((s) => s.node_id === n.id))
            .filter((s) => s.status === 'completed');
          const output =
            outputs.length === 1
              ? decode(outputs[0].output)
              : Object.fromEntries(outputs.map((s) => [s.node_id, decode(s.output)]));
          await repository.finish(
            context,
            lease,
            steps.some((s) => s.status === 'failed') || !outputs.length ? 'failed' : 'completed',
            output,
          );
          return;
        }
        let retry = false;
        // Parallelism is bounded per run; each handler has its own persisted checkpoint and timeout.
        await Promise.all(
          next.ready.slice(0, limits.parallelism).map(async (item) => {
            const step = await repository.startStep(context, lease, item.step.id, item.input);
            const signal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(
                Math.min(
                  limits.nodeTimeoutMs,
                  item.node.data.config?.timeoutMs || limits.nodeTimeoutMs,
                ),
              ),
            ]);
            const ctx = {
              context,
              run,
              lease,
              step,
              node: item.node,
              graph: decode(run.graph),
              runInput: decode(run.input),
              limits,
              signal,
              telemetry: measured,
            };
            try {
              const output = await abortable(
                () => nodeSlot(signal, () => handle(ctx, item.node.data.config || {}, item.input)),
                signal,
              );
              signal.throwIfAborted();
              if (output !== WAIT)
                await repository.completeStep(context, lease, step.id, boundOutput(output, limits));
            } catch (e) {
              if (e.code === 'STALE_LEASE') throw e;
              const code = safeCode(e, signal.aborted ? 'NODE_TIMEOUT' : 'EXECUTION_FAILED');
              const allowed = ['DEPENDENCY_UNAVAILABLE', 'RATE_LIMITED'].includes(code);
              retry =
                (await repository.failStep(
                  context,
                  lease,
                  step.id,
                  code,
                  allowed,
                  item.node.data.config?.retries || 0,
                )) || retry;
            }
          }),
        );
        if (retry) {
          await repository.pause(context, lease, 'queued');
          return;
        }
      }
      fail('GRAPH_STALLED');
    } catch (e) {
      await repository.finish(context, lease, 'failed', null, safeCode(e)).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      clearTimeout(durationTimer);
      active.delete(run.id);
      telemetry.timing('runtime.wall_ms', performance.now() - started, { runId: run.id });
      // Provider sum may exceed wall time during parallel calls; overhead uses separate measured spans below.
      telemetry.timing('runtime.provider_sum_ms', providerMs, { runId: run.id });
    }
  }
  return {
    execute,
    get active() {
      return active.size;
    },
    get draining() {
      return draining;
    },
    async close() {
      draining = true;
      const end = Date.now() + shutdownMs;
      while (active.size && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      for (const controller of active.values())
        controller.abort(new RuntimeError('WORKER_DRAINED'));
      while (active.size) await new Promise((r) => setTimeout(r, 25));
    },
  };
}
