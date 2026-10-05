import { one, exec, decode, encode, encrypt, decrypt, hash } from './db.js';
import { safeFetch, responseText } from './network.js';
export const providerRegistry = {};
export function registerProvider(name, handler) {
  providerRegistry[name] = handler;
}
async function providerError(response) {
  const error = await describeProviderError(response);
  error.providerStatus = response.status;
  error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
  return error;
}
async function describeProviderError(response) {
  let code, type;
  try {
    const body = JSON.parse(await responseText(response, 100_000));
    code = body.error?.code;
    type = body.error?.type;
  } catch {}
  if (response.status === 401)
    return new Error(
      'Model authentication failed (HTTP 401). Check the API key; paste only its value.',
    );
  if (
    response.status === 429 &&
    (type === 'insufficient_quota' ||
      ['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_exhausted'].includes(
        code,
      ))
  )
    return new Error(
      'Model API quota is exhausted (HTTP 429). Add API credits or check your account spending limits.',
    );
  if (response.status === 429)
    return new Error(
      'Model API rate limit reached (HTTP 429). Wait briefly and try again, or reduce concurrency.',
    );
  return new Error(
    `Model connection returned HTTP ${response.status}; check its endpoint, model, and credential`,
  );
}
async function* sse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      if (buffer.length > 2_000_000) throw new Error('Model stream exceeded response size limit');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((x) => x.startsWith('data:'))
          .map((x) => x.slice(5).trim())
          .join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
registerProvider(
  'openai-compatible',
  async ({ connection, messages, config, tools, signal, onToken }) => {
    const url = connection.endpoint.replace(/\/$/, '') + '/chat/completions';
    const secret = decrypt(connection.secret);
    const body = {
      model: config.model || connection.model,
      messages,
      temperature: Number(config.temperature ?? 0.4),
      max_tokens: Number(config.maxTokens || 2048),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools?.length
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: {
                name: t.id,
                description: t.name,
                parameters: t.config.inputSchema || { type: 'object', properties: {} },
              },
            })),
          }
        : {}),
      ...(config.outputSchema ? { response_format: { type: 'json_object' } } : {}),
    };
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
        noRedirect: true,
      },
      !!decode(connection.config).allowPrivate,
    );
    if (!response.ok) throw await providerError(response);
    let text = '',
      usage = {},
      calls = {};
    for await (const frame of sse(response)) {
      if (frame.usage)
        usage = {
          inputTokens: frame.usage.prompt_tokens || 0,
          outputTokens: frame.usage.completion_tokens || 0,
        };
      const delta = frame.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        if (text.length > 2000000) throw new Error('Model output exceeded the response size limit');
        onToken(delta.content);
      }
      for (const call of delta?.tool_calls || []) {
        const current = calls[call.index] || { id: '', name: '', arguments: '' };
        current.id = call.id || current.id;
        current.name += call.function?.name || '';
        current.arguments += call.function?.arguments || '';
        calls[call.index] = current;
      }
    }
    return {
      text,
      usage,
      toolCalls: Object.values(calls).map((c) => ({
        ...c,
        arguments: JSON.parse(c.arguments || '{}'),
      })),
    };
  },
);
registerProvider('anthropic', async ({ connection, messages, config, tools, signal, onToken }) => {
  const secret = decrypt(connection.secret);
  const body = {
    model: config.model || connection.model,
    max_tokens: Number(config.maxTokens || 2048),
    temperature: Number(config.temperature ?? 0.4),
    system: messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n'),
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool')
          return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
          };
        if (m.tool_calls)
          return {
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
          };
        return m;
      }),
    stream: true,
    ...(tools?.length
      ? {
          tools: tools.map((t) => ({
            name: t.id,
            description: t.name,
            input_schema: t.config.inputSchema || { type: 'object', properties: {} },
          })),
        }
      : {}),
  };
  const r = await safeFetch(
    connection.endpoint.replace(/\/$/, '') + '/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': secret,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
      noRedirect: true,
    },
    !!decode(connection.config).allowPrivate,
  );
  if (!r.ok) throw await providerError(r);
  let text = '',
    usage = {},
    calls = {};
  for await (const frame of sse(r)) {
    if (frame.type === 'message_start') usage.inputTokens = frame.message.usage.input_tokens;
    if (frame.type === 'message_delta') usage.outputTokens = frame.usage?.output_tokens || 0;
    if (frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use')
      calls[frame.index] = {
        id: frame.content_block.id,
        name: frame.content_block.name,
        arguments: '',
      };
    if (frame.delta?.text) {
      text += frame.delta.text;
      if (text.length > 2000000) throw new Error('Model output exceeded the response size limit');
      onToken(frame.delta.text);
    }
    if (frame.delta?.partial_json && calls[frame.index])
      calls[frame.index].arguments += frame.delta.partial_json;
  }
  return {
    text,
    usage,
    toolCalls: Object.values(calls).map((c) => ({
      ...c,
      arguments: JSON.parse(c.arguments || '{}'),
    })),
  };
});
export async function modelCall(ctx, config, messages, tools = []) {
  ctx.assertLease?.();
  if (ctx.mode === 'preview') {
    const last = messages.findLast((m) => m.role === 'user')?.content || '';
    const text = `Development preview · ${config.role || config.label || 'Agent'}\n\nTask context:\n${String(last).slice(0, 5000)}\n\nInstructions: ${config.instructions || 'Process the incoming task.'}\n\nThis deterministic preview verifies orchestration and data flow. Connect a model for generated research or reasoning.`;
    for (const token of text.match(/.{1,80}/gs) || []) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      ctx.onToken(token);
      await new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(ctx.signal.reason);
        };
        const timer = setTimeout(() => {
          ctx.signal.removeEventListener('abort', abort);
          resolve();
        }, 20);
        ctx.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return { text, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [] };
  }
  const ids = [...new Set([config.connectionId, ...(config.fallbackConnectionIds || [])])];
  if (!config.connectionId)
    throw new Error('Choose a model connection from this workspace, or use development preview');
  if (ids.length > 5) throw new Error('Use at most four fallback connections');
  const connections = ids.map((cid) => {
    const connection = one('SELECT * FROM connections WHERE id=? AND workspace_id=?', cid, ctx.wid);
    if (!connection || !providerRegistry[connection.provider])
      throw new Error('Choose supported model connections from this workspace');
    return connection;
  });
  const ttl = Math.max(0, Math.min(86400, Number(config.cacheTtlSeconds) || 0));
  const cacheable =
    ttl > 0 && !tools.length && !messages.some((m) => m.role === 'tool' || m.tool_calls);
  const key = hash(
    encode({
      connections: connections.map((c) => [c.id, c.provider, c.endpoint, c.model, hash(c.secret)]),
      messages,
      model: config.model,
      temperature: config.temperature ?? 0.4,
      maxTokens: config.maxTokens || 2048,
      outputSchema: config.outputSchema,
    }),
  );
  if (cacheable) {
    const cached = one(
      'SELECT response FROM model_cache WHERE workspace_id=? AND cache_key=? AND expires_at>?',
      ctx.wid,
      key,
      new Date().toISOString(),
    );
    if (cached) {
      const result = decode(decrypt(cached.response));
      ctx.onToken?.(result.text);
      ctx.emit?.('model.cache', { hit: true, connectionId: result.connectionId });
      return {
        ...result,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: result.usage.inputTokens || 0,
          cachedOutputTokens: result.usage.outputTokens || 0,
        },
        cached: true,
      };
    }
  }
  for (let i = 0; i < connections.length; i++) {
    const connection = connections[i];
    let emitted = false;
    try {
      ctx.signal?.throwIfAborted();
      ctx.assertLease?.();
      const result = await providerRegistry[connection.provider]({
        connection,
        // A fallback uses its own default model identifier.
        config: i ? { ...config, model: undefined } : config,
        messages,
        tools,
        signal: ctx.signal,
        onToken: (token) => {
          emitted = true;
          ctx.onToken?.(token);
        },
      });
      ctx.signal?.throwIfAborted();
      ctx.assertLease?.();
      result.connectionId = connection.id;
      if (cacheable && !result.toolCalls?.length) {
        exec('DELETE FROM model_cache WHERE expires_at<=?', new Date().toISOString());
        exec(
          'INSERT OR REPLACE INTO model_cache VALUES(?,?,?,?)',
          ctx.wid,
          key,
          encrypt(encode(result)),
          new Date(Date.now() + ttl * 1000).toISOString(),
        );
        // Bound retention per workspace, even when many different prompts are used.
        exec(
          'DELETE FROM model_cache WHERE workspace_id=? AND cache_key NOT IN (SELECT cache_key FROM model_cache WHERE workspace_id=? ORDER BY expires_at DESC LIMIT 1000)',
          ctx.wid,
          ctx.wid,
        );
      }
      return result;
    } catch (error) {
      const retryable =
        error.retryable || (error instanceof TypeError && error.message === 'fetch failed');
      if (emitted || ctx.signal?.aborted || !retryable || i === connections.length - 1) throw error;
      ctx.emit?.('model.fallback', {
        from: connection.id,
        to: connections[i + 1].id,
        status: error.providerStatus,
      });
    }
  }
}
