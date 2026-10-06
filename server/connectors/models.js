import { safeFetch, responseText } from '../network.js';
import { ConnectorError, httpError, schemaCheck, invalid, normalize, ajv } from './core.js';
import { tenantContextSchema, secretRefSchema } from '../foundation/contracts.js';

export const modelCapabilities = {
  'openai-compatible': { streaming: true, tools: true, structuredOutputs: true, usage: true },
  anthropic: { streaming: true, tools: true, structuredOutputs: true, usage: true },
};
export function validateModelCapabilities(provider, capabilities, config, tools) {
  const caps = { ...modelCapabilities[provider], ...capabilities };
  if (
    !modelCapabilities[provider] ||
    !caps.streaming ||
    (tools?.length && !caps.tools) ||
    (config.outputSchema && !caps.structuredOutputs)
  )
    throw invalid(
      'Model connection does not support the requested streaming, tools or structured outputs.',
    );
  if (
    !config.model ||
    !Number.isFinite(Number(config.temperature ?? 0.4)) ||
    !Number.isInteger(Number(config.maxTokens ?? 2048)) ||
    Number(config.maxTokens ?? 2048) < 1 ||
    Number(config.maxTokens ?? 2048) > 1000000
  )
    throw invalid('Choose a model, finite temperature and a bounded positive token limit.');
  return caps;
}
export async function modelError(response) {
  let body;
  try {
    body = JSON.parse(await responseText(response, 100000));
  } catch {}
  if (
    response.status === 429 &&
    (['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_exhausted'].includes(
      body?.error?.code,
    ) ||
      body?.error?.type === 'insufficient_quota')
  )
    return new ConnectorError(
      'BUDGET_EXCEEDED',
      'Model API quota is exhausted (HTTP 429). Add API credits or check your account spending limits.',
      { status: 429 },
    );
  if (response.status === 401)
    return new ConnectorError(
      'UNAUTHENTICATED',
      'Model authentication failed (HTTP 401). Check or rotate the API key.',
      { status: 401 },
    );
  if (response.status === 429) {
    const e = httpError(response);
    e.message = 'Model API rate limit reached (HTTP 429). Wait briefly or reduce concurrency.';
    return e;
  }
  return httpError(response);
}
/** Handles arbitrary byte boundaries, multiline data, CRLF and a bounded total stream. */
export async function* modelSse(response, signal) {
  if (!response.headers.get('content-type')?.includes('text/event-stream'))
    throw new ConnectorError(
      'DEPENDENCY_UNAVAILABLE',
      'Model returned an unsupported response content type.',
    );
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 4_000_000) throw invalid('Model stream exceeds the byte limit.');
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
          yield { type: 'relay_done' };
          continue;
        }
        try {
          yield JSON.parse(data);
        } catch (e) {
          if (e instanceof SyntaxError)
            throw new ConnectorError(
              'DEPENDENCY_UNAVAILABLE',
              'Model stream contained malformed JSON.',
            );
          throw e;
        }
      }
    }
    if (buffer.trim())
      throw new ConnectorError(
        'DEPENDENCY_UNAVAILABLE',
        'Model stream ended with an incomplete frame.',
      );
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function toolResult(calls, tools) {
  const ids = new Set();
  return [...calls.values()].map((c) => {
    if (!c.id || !c.name || ids.has(c.id) || !tools.some((t) => t.id === c.name))
      throw new ConnectorError(
        'DEPENDENCY_UNAVAILABLE',
        'Model returned an unknown or incomplete tool call.',
      );
    ids.add(c.id);
    let args;
    try {
      args = JSON.parse(c.arguments || '{}');
    } catch {
      throw new ConnectorError(
        'DEPENDENCY_UNAVAILABLE',
        'Model returned malformed tool arguments.',
      );
    }
    schemaCheck(tools.find((t) => t.id === c.name).config.inputSchema || { type: 'object' }, args);
    return { ...c, arguments: args };
  });
}
function structured(text, schema) {
  if (!schema) return;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConnectorError(
      'DEPENDENCY_UNAVAILABLE',
      'Model structured response is malformed or incomplete.',
    );
  }
  schemaCheck(schema, value);
  return value;
}
function tokens(v) {
  if (!Number.isSafeInteger(v) || v < 0)
    throw new ConnectorError('DEPENDENCY_UNAVAILABLE', 'Model returned invalid usage counts.');
  return v;
}

/** Pure production provider: plaintext only from authorized SecretPort at composition time. */
export async function callModel({
  provider,
  endpoint,
  secret,
  config,
  messages,
  tools = [],
  capabilities,
  signal,
  onToken = () => {},
  onProgress = () => {},
  fetchImpl = safeFetch,
  allowPrivate = false,
}) {
  const caps = validateModelCapabilities(provider, capabilities, config, tools);
  try {
    if (config.outputSchema) ajv.compile(config.outputSchema);
    if (
      new Set(tools.map((t) => t.id)).size !== tools.length ||
      tools.some((t) => !/^[\w-]{1,64}$/.test(t.id))
    )
      throw invalid('Model tool identifiers must be unique and valid.');
    for (const tool of tools) ajv.compile(tool.config?.inputSchema || { type: 'object' });
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    throw invalid('Model output or tool schema is invalid.');
  }
  signal = AbortSignal.any([
    signal || new AbortController().signal,
    AbortSignal.timeout(Math.min(300000, Math.max(1, Number(config.timeoutMs) || 120000))),
  ]);
  const anthropic = provider === 'anthropic',
    model = config.model;
  // Groq's schema mode supports neither streaming nor simultaneous tool selection.
  if (config.outputSchema && tools.length && new URL(endpoint).hostname === 'api.groq.com')
    throw invalid('Groq structured output requires a separate call without tools.');
  const buffered = !anthropic && !!config.outputSchema;
  const toolSchema = (t) => t.config?.inputSchema || { type: 'object', properties: {} };
  const body = anthropic
    ? {
        model,
        max_tokens: Number(config.maxTokens || 2048),
        temperature: Number(config.temperature ?? 0.4),
        stream: true,
        system: messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n'),
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) =>
            m.role === 'tool'
              ? {
                  role: 'user',
                  content: [
                    { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content },
                  ],
                }
              : m.tool_calls
                ? {
                    role: 'assistant',
                    content: [
                      ...(m.content ? [{ type: 'text', text: m.content }] : []),
                      ...m.tool_calls.map((t) => ({
                        type: 'tool_use',
                        id: t.id,
                        name: t.function.name,
                        input: JSON.parse(t.function.arguments),
                      })),
                    ],
                  }
                : m,
          ),
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                name: t.id,
                description: t.name,
                input_schema: toolSchema(t),
              })),
            }
          : {}),
        ...(config.outputSchema
          ? { output_config: { format: { type: 'json_schema', schema: config.outputSchema } } }
          : {}),
      }
    : {
        model,
        messages,
        temperature: Number(config.temperature ?? 0.4),
        max_tokens: Number(config.maxTokens || 2048),
        stream: !buffered,
        ...(!buffered && caps.usage ? { stream_options: { include_usage: true } } : {}),
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.id, description: t.name, parameters: toolSchema(t) },
              })),
            }
          : {}),
        ...(config.outputSchema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'relay_output', strict: true, schema: config.outputSchema },
              },
            }
          : {}),
      };
  const headers = {
    'Content-Type': 'application/json',
    ...(anthropic
      ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
      : secret
        ? { Authorization: 'Bearer ' + secret }
        : {}),
  };
  let response;
  try {
    response = await fetchImpl(
      endpoint.replace(/\/$/, '') + (anthropic ? '/messages' : '/chat/completions'),
      { method: 'POST', headers, body: JSON.stringify(body), signal, noRedirect: true },
      allowPrivate,
    );
  } catch (e) {
    const error = normalize(e);
    error.retryable = false;
    throw error; // A lost POST response cannot prove generation did not execute.
  }
  if (!response.ok) throw await modelError(response);
  onProgress(); // Accepted generation blocks fallback even if its first SSE frame is lost.
  let text = '',
    usage = { inputTokens: null, outputTokens: null },
    finish,
    done = false;
  const calls = new Map();
  try {
    if (buffered) {
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new ConnectorError(
          'DEPENDENCY_UNAVAILABLE',
          'Model returned an unsupported response content type.',
        );
      const result = JSON.parse(await responseText(response, 4_000_000));
      signal.throwIfAborted();
      const choice = result.choices?.[0],
        message = choice?.message;
      if (
        result.error ||
        message?.refusal ||
        !['stop', 'tool_calls'].includes(choice?.finish_reason)
      )
        throw new ConnectorError(
          'DEPENDENCY_UNAVAILABLE',
          'Model response is incomplete, truncated or refused; no tool actions were returned.',
        );
      text = message?.content ?? '';
      if (typeof text !== 'string' || text.length > 2_000_000)
        throw invalid('Model output exceeds the response limit.');
      if (result.usage)
        usage = {
          inputTokens: tokens(result.usage.prompt_tokens),
          outputTokens: tokens(result.usage.completion_tokens),
          cachedInputTokens: tokens(result.usage.prompt_tokens_details?.cached_tokens || 0),
          reasoningTokens: tokens(result.usage.completion_tokens_details?.reasoning_tokens || 0),
        };
      if ((message?.tool_calls?.length || 0) > 128)
        throw invalid('Model output exceeds the response limit.');
      for (const [index, call] of (message?.tool_calls || []).entries())
        calls.set(index, {
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments,
        });
      const toolCalls = toolResult(calls, tools);
      if ((choice.finish_reason === 'tool_calls') !== !!toolCalls.length)
        throw new ConnectorError(
          'DEPENDENCY_UNAVAILABLE',
          'Model completion does not match its tool results.',
        );
      const output = toolCalls.length ? undefined : structured(text, config.outputSchema);
      // Publish a validated complete result; this is not a synthetic token stream.
      if (text) onToken(text);
      return {
        text,
        toolCalls,
        usage: { ...usage, known: usage.inputTokens !== null && usage.outputTokens !== null },
        ...(output !== undefined ? { structuredOutput: output } : {}),
        providerRequestId:
          response.headers.get('x-request-id') || response.headers.get('request-id'),
        finishReason: choice.finish_reason,
      };
    }
    for await (const f of modelSse(response, signal)) {
      if (f.type === 'relay_done') {
        done = true;
        continue;
      }
      if (done)
        throw new ConnectorError(
          'DEPENDENCY_UNAVAILABLE',
          'Model sent content after completing the response.',
        );
      if (f.error || f.type === 'error')
        throw new ConnectorError(
          'DEPENDENCY_UNAVAILABLE',
          'Model stream reported a provider error.',
        );
      onProgress();
      if (anthropic) {
        if (f.type === 'message_start')
          usage = {
            ...usage,
            inputTokens: tokens(f.message?.usage?.input_tokens),
            cacheReadInputTokens: tokens(f.message?.usage?.cache_read_input_tokens || 0),
            cacheCreationInputTokens: tokens(f.message?.usage?.cache_creation_input_tokens || 0),
          };
        if (f.type === 'message_delta') {
          if (f.usage?.output_tokens !== undefined)
            usage.outputTokens = tokens(f.usage.output_tokens);
          finish = f.delta?.stop_reason || finish;
        }
        if (f.type === 'message_stop') done = true;
        if (f.type === 'content_block_start' && f.content_block?.type === 'tool_use')
          calls.set(f.index, {
            id: f.content_block.id,
            name: f.content_block.name,
            arguments: '',
            initial: f.content_block.input,
          });
        if (
          f.type === 'content_block_start' &&
          f.content_block?.type === 'text' &&
          f.content_block.text
        ) {
          text += f.content_block.text;
          onToken(f.content_block.text);
        }
        if (f.delta?.partial_json) {
          const c = calls.get(f.index);
          if (!c)
            throw new ConnectorError(
              'DEPENDENCY_UNAVAILABLE',
              'Model tool delta has no matching block.',
            );
          c.arguments += f.delta.partial_json;
        }
        if (f.delta?.text) {
          text += f.delta.text;
          onToken(f.delta.text);
        }
      } else {
        if (f.usage)
          usage = {
            inputTokens: tokens(f.usage.prompt_tokens),
            outputTokens: tokens(f.usage.completion_tokens),
            cachedInputTokens: tokens(f.usage.prompt_tokens_details?.cached_tokens || 0),
            reasoningTokens: tokens(f.usage.completion_tokens_details?.reasoning_tokens || 0),
          };
        const choice = f.choices?.[0],
          delta = choice?.delta;
        finish = choice?.finish_reason || finish;
        if (delta?.refusal)
          throw new ConnectorError('DEPENDENCY_UNAVAILABLE', 'Model refused the requested output.');
        if (delta?.content) {
          text += delta.content;
          onToken(delta.content);
        }
        for (const c of delta?.tool_calls || []) {
          if (!Number.isInteger(c.index) || c.index < 0 || c.index > 127)
            throw new ConnectorError(
              'DEPENDENCY_UNAVAILABLE',
              'Model returned an invalid tool index.',
            );
          const current = calls.get(c.index) || { id: '', name: '', arguments: '' };
          current.id = c.id || current.id;
          current.name += c.function?.name || '';
          current.arguments += c.function?.arguments || '';
          calls.set(c.index, current);
        }
      }
      if (text.length > 2_000_000 || calls.size > 128)
        throw invalid('Model output exceeds the response limit.');
    }
  } catch (e) {
    const error = normalize(e);
    error.retryable = false;
    throw error;
  }
  if (
    !done ||
    !(anthropic ? ['end_turn', 'tool_use', 'stop_sequence'] : ['stop', 'tool_calls']).includes(
      finish,
    )
  )
    throw new ConnectorError(
      'DEPENDENCY_UNAVAILABLE',
      'Model response is incomplete, truncated or refused; no tool actions were returned.',
    );
  for (const c of calls.values()) if (!c.arguments) c.arguments = JSON.stringify(c.initial || {});
  const toolCalls = toolResult(calls, tools),
    output = toolCalls.length ? undefined : structured(text, config.outputSchema);
  return {
    text,
    toolCalls,
    usage: { ...usage, known: usage.inputTokens !== null && usage.outputTokens !== null },
    ...(output !== undefined ? { structuredOutput: output } : {}),
    providerRequestId: response.headers.get('x-request-id') || response.headers.get('request-id'),
    finishReason: finish,
  };
}

export function createModelAdapter(provider, { authorize, secrets, outbound }) {
  if (!authorize || !secrets?.resolve)
    throw invalid('Model adapter requires security and secret ports.');
  return {
    capabilities: { ...modelCapabilities[provider] },
    async invoke(
      context,
      { secretRef, connection, config, messages, tools, signal, onToken, onProgress },
    ) {
      if (!secretRef)
        throw new ConnectorError(
          'UNAUTHENTICATED',
          'A scoped model credential reference is required.',
        );
      if (secretRef.workspaceId !== context.workspaceId)
        throw new ConnectorError('FORBIDDEN', 'Model credential belongs to another workspace.');
      try {
        context = tenantContextSchema.parse(context);
        secretRef = secretRefSchema.parse(secretRef);
      } catch {
        throw invalid();
      }
      try {
        await authorize(context, {
          connectionId: secretRef.connectionId,
          action: 'model.generate',
        });
        await outbound?.authorize?.(context, connection.endpoint);
      } catch {
        throw new ConnectorError(
          'FORBIDDEN',
          'Model connection authorization could not be verified.',
        );
      }
      let secret;
      try {
        secret = await secrets.resolve(context, secretRef);
      } catch {
        throw new ConnectorError(
          'UNAUTHENTICATED',
          'Model credential is revoked, stale or unavailable; reconnect.',
        );
      }
      return callModel({
        provider,
        endpoint: connection.endpoint,
        secret,
        config: { ...config, model: config.model || connection.model },
        capabilities: connection.capabilities,
        messages,
        tools,
        signal,
        onToken,
        onProgress,
        fetchImpl: outbound?.fetch || safeFetch,
      });
    },
  };
}
