import crypto from 'node:crypto';
import net from 'node:net';
import { Readable } from 'node:stream';
import { z } from 'zod';
import pg from 'pg';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { safeFetch } from '../network.js';
import { tenantContextSchema, resourceId, secretRefSchema } from '../foundation/contracts.js';
import { descriptor, invalid, ConnectorError, normalize, httpError } from './core.js';

const storageConfig = z
  .object({
    endpoint: z
      .url()
      .refine((v) => {
        const u = new URL(v);
        return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
      })
      .optional(),
    region: z
      .string()
      .regex(/^[\w-]+$/)
      .default('us-east-1'),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    prefix: z.string().max(512).default(''),
    forcePathStyle: z.boolean().default(true),
  })
  .strict();
function credentials(secret) {
  try {
    return z
      .object({
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
        sessionToken: z.string().optional(),
      })
      .strict()
      .parse(JSON.parse(secret));
  } catch {
    throw new ConnectorError(
      'UNAUTHENTICATED',
      'S3 credential must contain accessKeyId, secretAccessKey and optional sessionToken.',
    );
  }
}

/** SDK handles SigV4 and XML. Relay handles DNS policy, redirects and retry ownership. */
export function s3Client(config, credential, { signal, authorize, fetchImpl = safeFetch }) {
  return new S3Client({
    ...config,
    credentials: credential,
    maxAttempts: 1,
    requestHandler: {
      async handle(request, options = {}) {
        await authorize();
        const u = new URL(
          `${request.protocol}//${request.hostname}${request.port ? ':' + request.port : ''}${request.path}`,
        );
        for (const [k, v] of Object.entries(request.query || {}))
          for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, x ?? '');
        const r = await fetchImpl(u.href, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.any([signal, options.abortSignal || signal]),
          noRedirect: true,
          redirect: 'error',
        });
        return {
          response: {
            statusCode: r.status,
            reason: r.statusText,
            headers: Object.fromEntries(r.headers),
            body: r.body ? Readable.fromWeb(r.body) : Readable.from([]),
          },
        };
      },
      destroy() {},
    },
  });
}
async function collect(body, signal, maximum = 15 * 1024 * 1024) {
  const parts = [];
  let total = 0;
  try {
    for await (const part of body) {
      signal.throwIfAborted();
      const bytes = Buffer.from(part);
      total += bytes.length;
      if (total > maximum) throw invalid('Object exceeds the byte limit.');
      parts.push(bytes);
    }
    return Buffer.concat(parts);
  } finally {
    body?.destroy?.();
  }
}
function s3Error(e, write = false) {
  if (e instanceof ConnectorError) return e;
  const status = e.$metadata?.httpStatusCode;
  if (status) return httpError({ status, headers: new Headers() }, write);
  return normalize(e, write);
}
export function createS3Adapter({ clientFactory = s3Client } = {}) {
  return {
    validate: (c) => storageConfig.parse(c),
    descriptor: () => descriptor('s3', 'api-key', ['objects', 'document']),
    testAction: 'objects',
    testInput: () => ({ limit: 1 }),
    testCapabilities: () => ['objects'],
    validateInput(c, action, i) {
      if (action === 'document' && (typeof i.key !== 'string' || !i.key.startsWith(c.prefix)))
        throw new ConnectorError('FORBIDDEN', 'Object is outside the selected prefix.');
    },
    async invoke(a) {
      const client = clientFactory(a.config, credentials(await a.secret()), {
        signal: a.signal,
        authorize: async () => {
          await a.secret();
        },
        fetchImpl: (u, o) => a.request(u, o, 'response'),
      });
      try {
        if (a.action === 'objects') {
          const r = await client.send(
            new ListObjectsV2Command({
              Bucket: a.config.bucket,
              Prefix: a.config.prefix,
              ContinuationToken: a.input.cursor,
              MaxKeys: Math.max(1, Math.min(1000, Number(a.input.limit) || 100)),
            }),
            { abortSignal: a.signal },
          );
          return {
            data: r.Contents || [],
            nextCursor: r.NextContinuationToken,
            providerRequestId: r.$metadata?.requestId,
          };
        }
        const r = await client.send(
          new GetObjectCommand({
            Bucket: a.config.bucket,
            Key: a.input.key,
            ...(a.input.etag ? { IfMatch: a.input.etag } : {}),
          }),
          { abortSignal: a.signal },
        );
        if (r.ContentLength > 15 * 1024 * 1024) {
          r.Body?.destroy?.();
          throw invalid('Object exceeds the byte limit.');
        }
        return {
          data: {
            externalId: `s3:${a.config.bucket}:${a.input.key}`,
            name: a.input.key,
            bytes: await collect(r.Body, a.signal),
            contentType: r.ContentType || 'application/octet-stream',
            revision: r.VersionId || r.ETag,
          },
          providerRequestId: r.$metadata?.requestId,
        };
      } catch (e) {
        throw s3Error(e);
      } finally {
        client.destroy();
      }
    },
  };
}

/** Application-owned storage: never expose this as an unapproved external tool. */
export function createS3BlobStore(
  config,
  { authorize, secrets, secretRef, clientFactory = s3Client, maximumBytes = 15 * 1024 * 1024 },
) {
  config = storageConfig.parse(config);
  secretRef = secretRefSchema.parse(secretRef);
  if (!authorize || !secrets?.resolve)
    throw invalid('Authorized secret and blob policy ports are required.');
  async function operation(context, key, write, fn) {
    context = tenantContextSchema.parse(context);
    key = resourceId.parse(key);
    if (context.workspaceId !== secretRef.workspaceId)
      throw new ConnectorError('FORBIDDEN', 'Storage credential belongs to another workspace.');
    const signal = AbortSignal.timeout(30000);
    const check = async () => {
      signal.throwIfAborted();
      await authorize(context, { operation: write ? 'write' : 'read', key, secretRef });
    };
    await check();
    const client = clientFactory(config, credentials(await secrets.resolve(context, secretRef)), {
      signal,
      authorize: check,
    });
    try {
      return await fn(
        client,
        `${config.prefix}${context.workspaceId}/${key}`,
        signal,
        context,
        key,
      );
    } catch (e) {
      throw s3Error(e, write);
    } finally {
      client.destroy();
    }
  }
  return Object.freeze({
    put(context, key, data, contentType) {
      if (
        !(data instanceof Uint8Array) ||
        data.length > maximumBytes ||
        !/^\w[\w.+-]*\/[\w.+-]+$/.test(contentType)
      )
        throw invalid();
      return operation(context, key, true, async (client, k, signal, ctx, id) => {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: k,
            Body: data,
            ContentType: contentType,
            IfNoneMatch: '*',
          }),
          { abortSignal: signal },
        );
        return {
          workspaceId: ctx.workspaceId,
          key: id,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
          bytes: data.length,
          contentType,
        };
      });
    },
    get(context, key) {
      return operation(context, key, false, async (client, k, signal) => {
        const r = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: k }), {
          abortSignal: signal,
        });
        if (r.ContentLength > maximumBytes) {
          r.Body?.destroy?.();
          throw invalid();
        }
        return collect(r.Body, signal, maximumBytes);
      });
    },
    delete(context, key) {
      return operation(context, key, true, (client, k, signal) =>
        client
          .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: k }), { abortSignal: signal })
          .then(() => undefined),
      );
    },
  });
}

export function createPostgresAdapter({ clientFactory = (c) => new pg.Client(c) } = {}) {
  return {
    validate: (c) =>
      z
        .object({
          host: z.string().min(1),
          port: z.number().int().min(1).max(65535).default(5432),
          database: z.string().min(1),
          ssl: z.literal(true).default(true),
          queries: z.record(z.string().regex(/^[\w-]+$/), z.string().min(1).max(20000)),
          maximumRows: z.number().int().min(1).max(1000).default(100),
          statementTimeoutMs: z.number().int().min(1).max(30000).default(10000),
        })
        .strict()
        .parse(c),
    descriptor: () => descriptor('postgresql', 'database', ['query', 'health']),
    testAction: 'health',
    testCapabilities: () => ['health'],
    validateInput(c, action, i) {
      if (action === 'query') {
        if (!Object.hasOwn(c.queries, i.queryId) || !Array.isArray(i.parameters || []))
          throw invalid('Choose an administrator configured query and positional parameters.');
        const sql = c.queries[i.queryId];
        if (!/^\s*(SELECT|WITH)\b/i.test(sql) || sql.includes(';'))
          throw invalid('Configure one read-only SELECT statement.');
      }
    },
    async invoke(a) {
      let cred;
      try {
        cred = z
          .object({ user: z.string().min(1), password: z.string().min(1) })
          .strict()
          .parse(JSON.parse(await a.secret()));
      } catch {
        throw new ConnectorError(
          'UNAUTHENTICATED',
          'PostgreSQL credential must contain user and password.',
        );
      }
      let destination;
      try {
        destination = await a.ports.outbound?.authorizeDatabase?.(a.context, {
          host: a.config.host,
          port: a.config.port,
          database: a.config.database,
        });
      } catch {
        throw new ConnectorError(
          'FORBIDDEN',
          'Database destination is outside the administrator grant.',
        );
      }
      // Host/database access must be explicitly granted by security; HTTP DNS policy cannot protect a SQL socket.
      if (
        !destination ||
        !net.isIP(destination.address) ||
        (net.isIP(a.config.host)
          ? destination.servername
          : destination.servername !== a.config.host.toLowerCase())
      )
        throw new ConnectorError('FORBIDDEN', 'Database egress authorization is required.');
      const client = clientFactory({
        ...a.config,
        ...cred,
        host: destination.address,
        ssl: {
          rejectUnauthorized: true,
          ...(destination.servername ? { servername: destination.servername } : {}),
          ...(destination.ca ? { ca: destination.ca } : {}),
        },
        connectionTimeoutMillis: 10000,
        query_timeout: a.config.statementTimeoutMs,
      });
      const abort = () => {
        void client.end().catch(() => {});
      };
      a.signal.addEventListener('abort', abort, { once: true });
      try {
        await client.connect();
        a.signal.throwIfAborted();
        const role = await client.query(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user',
        );
        if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls)
          throw new ConnectorError(
            'FORBIDDEN',
            'Use a restricted PostgreSQL role without superuser or BYPASSRLS.',
          );
        await client.query('BEGIN READ ONLY');
        await client.query(
          "SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$1,true), set_config('search_path','pg_catalog',true)",
          [String(a.config.statementTimeoutMs)],
        );
        await a.secret();
        a.signal.throwIfAborted();
        const r = await client.query(
          a.action === 'health'
            ? 'SELECT 1 AS connected'
            : `SELECT * FROM (${a.config.queries[a.input.queryId]}) AS relay_scoped_query LIMIT ${a.config.maximumRows}`,
          a.action === 'health' ? [] : a.input.parameters || [],
        );
        a.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(r.rows)) > 15 * 1024 * 1024)
          throw invalid('Query result exceeds the byte limit; narrow the configured projection.');
        await client.query('ROLLBACK');
        return { data: r.rows };
      } catch (e) {
        if (e instanceof ConnectorError) throw e;
        const code = ['28P01', '28000'].includes(e.code)
          ? 'UNAUTHENTICATED'
          : e.code === '42501'
            ? 'FORBIDDEN'
            : 'DEPENDENCY_UNAVAILABLE';
        throw new ConnectorError(
          code,
          'PostgreSQL request failed; check the credential, SELECT grants, qualified table names and statement limits.',
        );
      } finally {
        a.signal.removeEventListener('abort', abort);
        await client.end().catch(() => {});
      }
    },
  };
}
