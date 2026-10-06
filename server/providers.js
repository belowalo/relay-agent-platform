import { one, exec, decode, encode, encrypt, decrypt, hash } from './db.js';
import { callModel } from './connectors/models.js';
export const providerRegistry = {};
export function registerProvider(name, handler) {
  providerRegistry[name] = handler;
}
for (const provider of ['openai-compatible', 'anthropic']) {
  registerProvider(provider, ({ connection, config, ...args }) =>
    callModel({
      ...args,
      provider,
      endpoint: connection.endpoint,
      secret: decrypt(connection.secret),
      config: { ...config, model: config.model || connection.model },
      capabilities: decode(connection.config).capabilities,
      allowPrivate: !!decode(connection.config).allowPrivate,
    }).catch((error) => {
      // Existing local routes use HTTP 400 for provider failures; production ports retain normalized status.
      error.status = undefined;
      throw error;
    }),
  );
}
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
        onProgress: () => {
          emitted = true;
        },
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
