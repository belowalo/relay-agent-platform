import { one, decode, decrypt } from './db.js';
import { safeFetch, responseText } from './network.js';
export const providerRegistry = {};
export function registerProvider(name, handler) {
  providerRegistry[name] = handler;
}
async function providerError(response) {
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
  const connection = one(
    'SELECT * FROM connections WHERE id=? AND workspace_id=?',
    config.connectionId,
    ctx.wid,
  );
  if (!connection)
    throw new Error('Choose a model connection from this workspace, or use development preview');
  const provider = providerRegistry[connection.provider];
  if (!provider) throw new Error('Unsupported model provider');
  return provider({
    connection,
    config,
    messages,
    tools,
    signal: ctx.signal,
    onToken: ctx.onToken,
  });
}
