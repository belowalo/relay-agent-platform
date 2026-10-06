import crypto from 'node:crypto';
import Ajv from 'ajv';
import { setTimeout as delay } from 'node:timers/promises';
import {
  tenantContextSchema,
  secretRefSchema,
  connectorDescriptorSchema,
} from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
import { safeFetch, responseText } from '../network.js';

export const ajv = new Ajv({ strict: false, allErrors: true });
export class ConnectorError extends PlatformError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.outcome = options.outcome || 'failed';
    this.providerStatus = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
export function invalid(message = 'Connector configuration or input is invalid.') {
  return new ConnectorError('VALIDATION_ERROR', message);
}
export function normalize(error, write = false) {
  if (error instanceof ConnectorError) return error;
  return new ConnectorError(
    'DEPENDENCY_UNAVAILABLE',
    'Connector request failed; check connectivity and health diagnostics.',
    {
      retryable: !write,
      outcome: write ? 'uncertain' : 'failed',
    },
  );
}
export function schemaCheck(schema, data) {
  try {
    if (!ajv.compile(schema)(data)) throw invalid('Connector schema validation failed.');
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    throw invalid('Connector JSON schema is invalid.');
  }
}
export function descriptor(id, auth, reads, writes = []) {
  return connectorDescriptorSchema.parse({
    id,
    version: '1.0.0',
    auth,
    actions: [
      ...reads.map((id) => ({
        id,
        effect: 'read',
        idempotency: 'read-only',
        requiresApproval: false,
      })),
      ...writes.map((id) => ({ id, effect: 'write', idempotency: 'none', requiresApproval: true })),
    ],
  });
}
export function stableHash(value) {
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function retryAfter(headers) {
  const value = headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    return (
      Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()) || 0
    );
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  return reset ? Math.max(0, reset * 1000 - Date.now()) : 0;
}
export function httpError(response, write = false) {
  const status = response.status;
  const limited =
    status === 429 || (status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
  const code = limited
    ? 'RATE_LIMITED'
    : status === 401
      ? 'UNAUTHENTICATED'
      : status === 403
        ? 'FORBIDDEN'
        : status === 404
          ? 'NOT_FOUND'
          : [409, 412].includes(status)
            ? 'CONFLICT'
            : status < 500
              ? 'VALIDATION_ERROR'
              : 'DEPENDENCY_UNAVAILABLE';
  const messages = {
    RATE_LIMITED: 'Provider rate limit reached; reduce concurrency or wait for the reset.',
    UNAUTHENTICATED: 'Credential rejected or expired; reconnect or rotate the credential.',
    FORBIDDEN: 'Provider denied access; check resource selection, membership and granted scopes.',
    NOT_FOUND: 'Selected resource is absent or inaccessible.',
    CONFLICT: 'Provider rejected a conflicting operation.',
    VALIDATION_ERROR:
      'Provider rejected the request; check the configured action and input schema.',
    DEPENDENCY_UNAVAILABLE: 'Provider is unavailable; check connector health before retrying.',
  };
  return new ConnectorError(code, messages[code], {
    status,
    retryable: !write && (limited || [408, 500, 502, 503, 504].includes(status)),
    retryAfterMs: retryAfter(response.headers),
    outcome: write && status >= 500 ? 'uncertain' : 'failed',
  });
}

/** Security and runtime ports are mandatory enforcement seams, never caller-supplied tokens. */
export function createConnector(
  adapter,
  config,
  ports,
  { timeoutMs = 30000, maxAttempts = 3, maxRetryDelayMs = 2000, fetchImpl = safeFetch } = {},
) {
  if (!ports?.authorize) throw invalid('A security authorization port is required.');
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5 ||
    !Number.isFinite(maxRetryDelayMs) ||
    maxRetryDelayMs < 0 ||
    maxRetryDelayMs > 60000
  )
    throw invalid();
  try {
    config = adapter.validate(structuredClone(config));
  } catch {
    throw invalid();
  }
  const discovery = connectorDescriptorSchema.parse(adapter.descriptor(config));
  async function invoke(context, call) {
    try {
      context = tenantContextSchema.parse(context);
    } catch {
      throw invalid();
    }
    const action = discovery.actions.find((a) => a.id === call.action);
    if (!action) throw invalid('Connector capability is unsupported.');
    const write = action.effect === 'write';
    if (write && !ports.actions?.execute)
      throw new ConnectorError('FORBIDDEN', 'Runtime action approval and tracking are required.');
    let reference;
    try {
      reference = call.secretRef && secretRefSchema.parse(call.secretRef);
    } catch {
      throw invalid();
    }
    if (reference && reference.workspaceId !== context.workspaceId)
      throw new ConnectorError('FORBIDDEN', 'Credential reference belongs to another workspace.');
    if (discovery.auth !== 'none' && !reference)
      throw new ConnectorError('UNAUTHENTICATED', 'A scoped credential reference is required.');
    const input = structuredClone(call.input ?? {});
    try {
      adapter.validateInput?.(config, call.action, input);
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      throw invalid();
    }
    const signal = AbortSignal.any([
      call.signal || new AbortController().signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const resolvedSecrets = new Set();
    const authorize = async () => {
      if (signal.aborted)
        throw new ConnectorError(
          'DEPENDENCY_UNAVAILABLE',
          'Connector operation was cancelled or timed out.',
        );
      try {
        await ports.authorize(context, {
          connectorId: discovery.id,
          action: call.action,
          config: structuredClone(config),
          secretRef: reference,
        });
      } catch {
        throw new ConnectorError(
          'FORBIDDEN',
          'Connector authorization could not be verified; check current connection and actor permissions.',
        );
      }
      if (signal.aborted)
        throw new ConnectorError(
          'DEPENDENCY_UNAVAILABLE',
          'Connector operation was cancelled or timed out.',
        );
    };
    const secret = async () => {
      await authorize();
      if (!reference) return '';
      if (!ports.secrets?.resolve)
        throw new ConnectorError('UNAUTHENTICATED', 'Secret resolution is unavailable.');
      try {
        const value = await ports.secrets.resolve(context, reference);
        if (typeof value === 'string' && value) {
          resolvedSecrets.add(value);
          // OAuth/database credentials can be structured envelopes. Protect
          // individual values as well as the serialized envelope.
          try {
            const collect = (v) => {
              if (typeof v === 'string' && v.length >= 8) resolvedSecrets.add(v);
              else if (v && typeof v === 'object') Object.values(v).forEach(collect);
            };
            collect(JSON.parse(value));
          } catch {
            /* Plain API key. */
          }
        }
        return value;
      } catch {
        throw new ConnectorError(
          'UNAUTHENTICATED',
          'Credential is revoked, stale or unavailable; reconnect the selected connection.',
        );
      }
    };
    const request = async (url, options = {}, mode = 'json') => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await authorize();
        try {
          await ports.outbound?.authorize?.(context, String(url));
        } catch {
          throw new ConnectorError(
            'FORBIDDEN',
            'Connector endpoint is outside the permitted network scope.',
          );
        }
        let response;
        try {
          response = await fetchImpl(String(url), {
            ...options,
            signal,
            noRedirect: true,
            redirect: 'error',
          });
          if (!response.ok) throw httpError(response, write);
          const providerRequestId =
            response.headers.get('x-request-id') || response.headers.get('x-github-request-id');
          if (mode === 'response') return response;
          const text = await responseText(response, config.maximumBytes || 15 * 1024 * 1024);
          let data = text;
          if (mode === 'json') {
            try {
              data = JSON.parse(text);
            } catch {
              throw new ConnectorError(
                'DEPENDENCY_UNAVAILABLE',
                'Provider returned malformed JSON.',
                { outcome: write ? 'uncertain' : 'failed' },
              );
            }
          }
          return { data, headers: response.headers, providerRequestId };
        } catch (error) {
          await response?.body?.cancel().catch(() => {});
          const e = normalize(error, write);
          if (signal.aborted) e.retryable = false;
          if (
            signal.aborted ||
            write ||
            !e.retryable ||
            attempt + 1 === maxAttempts ||
            e.retryAfterMs > maxRetryDelayMs
          )
            throw e;
          await delay(
            Math.min(maxRetryDelayMs, Math.max(e.retryAfterMs || 0, 100 * 2 ** attempt)),
            undefined,
            { signal },
          );
        }
      }
    };
    const perform = async () => {
      await authorize();
      try {
        const result = await adapter.invoke({
          context,
          config,
          action: call.action,
          input: structuredClone(input),
          signal,
          secret,
          request,
          ports,
          idempotencyKey: call.idempotencyKey,
        });
        await authorize();
        const containsCredential = (v) => {
          if (typeof v === 'string') return [...resolvedSecrets].some((s) => v.includes(s));
          if (Buffer.isBuffer(v) || v instanceof Uint8Array)
            return [...resolvedSecrets].some((s) => Buffer.from(v).includes(Buffer.from(s)));
          return v && typeof v === 'object' && Object.values(v).some(containsCredential);
        };
        if (containsCredential(result))
          throw new ConnectorError(
            'DEPENDENCY_UNAVAILABLE',
            'Provider response echoed a credential and was withheld.',
            { outcome: write ? 'uncertain' : 'failed' },
          );
        return result;
      } catch (e) {
        throw normalize(e, write);
      }
    };
    await authorize();
    return write
      ? ports.actions.execute(
          context,
          {
            connectorId: discovery.id,
            connectorVersion: discovery.version,
            action: call.action,
            input: structuredClone(input),
            argumentHash: stableHash(input),
            configurationHash: stableHash(config),
            connectionId: reference?.connectionId,
            secretRef: reference,
            idempotencyKey: call.idempotencyKey,
            requiresApproval: true,
          },
          perform,
        )
      : perform();
  }
  return Object.freeze({
    descriptor: structuredClone(discovery),
    invoke,
    async test(context, secretRef, signal) {
      const start = Date.now();
      try {
        const result = await invoke(context, {
          action: adapter.testAction,
          input: adapter.testInput?.(config) || {},
          secretRef,
          signal,
        });
        return {
          ok: true,
          capabilities:
            adapter.testCapabilities?.(result, config) || discovery.actions.map((a) => a.id),
          latencyMs: Date.now() - start,
          version: discovery.version,
        };
      } catch (error) {
        const e = normalize(error);
        return {
          ok: false,
          capabilities: [],
          latencyMs: Date.now() - start,
          diagnostic: { code: e.code, message: e.message, retryable: e.retryable },
          version: discovery.version,
        };
      }
    },
  });
}
