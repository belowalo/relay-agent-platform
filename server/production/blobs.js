import crypto from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { tenantContextSchema, resourceId } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
export function createProductionBlobs(env, security) {
  const endpoint = new URL(env.S3_ENDPOINT);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/' ||
    !(
      endpoint.protocol === 'https:' ||
      (endpoint.protocol === 'http:' && env.S3_INTERNAL_NETWORK === 'true')
    ) ||
    !env.S3_ACCESS_KEY_ID ||
    !env.S3_SECRET_ACCESS_KEY ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET)
  )
    throw new Error('S3_CONFIGURATION_REQUIRED');
  const client = new S3Client({
    endpoint: endpoint.href,
    region: env.S3_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    maxAttempts: 1,
  });
  const bucket = env.S3_BUCKET;
  async function send(ctx, key, command, write) {
    ctx = tenantContextSchema.parse(ctx);
    resourceId.parse(key);
    await security.authorize(ctx, write ? 'document.write' : 'document.read');
    try {
      return await client.send(command({ Bucket: bucket, Key: `${ctx.workspaceId}/${key}` }), {
        abortSignal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new PlatformError('DEPENDENCY_UNAVAILABLE', 'Shared document storage is unavailable.');
    }
  }
  return {
    async put(ctx, key, data, contentType) {
      if (
        !(data instanceof Uint8Array) ||
        data.length > 15 * 1024 * 1024 ||
        !/^\w[\w.+-]*\/[\w.+-]+$/.test(contentType)
      )
        throw new PlatformError('VALIDATION_ERROR', 'Invalid document upload.');
      await send(
        ctx,
        key,
        (p) =>
          new PutObjectCommand({ ...p, Body: data, ContentType: contentType, IfNoneMatch: '*' }),
        true,
      );
      return {
        workspaceId: ctx.workspaceId,
        key,
        bytes: data.length,
        contentType,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
      };
    },
    async get(ctx, key) {
      const result = await send(ctx, key, (p) => new GetObjectCommand(p), false);
      if (result.ContentLength > 15 * 1024 * 1024) {
        result.Body?.destroy();
        throw new PlatformError('BUDGET_EXCEEDED', 'Document exceeds storage budget.');
      }
      const parts = [];
      let n = 0;
      for await (const p of result.Body) {
        n += p.length;
        if (n > 15 * 1024 * 1024) {
          result.Body.destroy();
          throw new PlatformError('BUDGET_EXCEEDED', 'Document exceeds storage budget.');
        }
        parts.push(p);
      }
      return Buffer.concat(parts);
    },
    delete: (ctx, key) =>
      send(ctx, key, (p) => new DeleteObjectCommand(p), true).then(() => undefined),
    async probe() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }), {
          abortSignal: AbortSignal.timeout(2000),
        });
        return true;
      } catch {
        return false;
      }
    },
    close() {
      client.destroy();
    },
  };
}
