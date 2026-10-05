import { z } from 'zod';
import { resourceId, tenantContextSchema } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';

export const limits = Object.freeze({
  bytes: 15 * 1024 * 1024,
  characters: 2_000_000,
  pages: 200,
  ocrPages: 25,
  renderedBytes: 32 * 1024 * 1024,
  chunks: 10000,
  parseMs: 30000,
  jobMs: 300000,
  batchSize: 16,
  dimension: 384,
});
export function processingBudgets(value = limits) {
  const result = { ...limits, ...value };
  for (const [key, max] of Object.entries(limits))
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > max)
      throw failure(
        'VALIDATION_ERROR',
        'Processing budgets must be positive integers within the documented maximums.',
      );
  if (result.dimension !== limits.dimension)
    throw failure('VALIDATION_ERROR', 'This index requires 384-dimensional embeddings.');
  return Object.freeze(result);
}
const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
export const principalId = z.string().regex(/^(user|application|service):[a-zA-Z0-9_-]{1,128}$/);
export const accessSchema = z
  .object({
    mode: z.enum(['workspace', 'restricted']),
    principalIds: z.array(principalId).max(100),
  })
  .strict()
  .refine((a) =>
    a.mode === 'restricted' ? a.principalIds.length > 0 : a.principalIds.length === 0,
  );
export const documentSchema = z
  .object({
    collectionId: resourceId,
    externalId: z.string().min(1).max(2000),
    name: z.string().min(1).max(500),
    text: z.string().max(limits.characters).optional(),
    url: z.url().max(4000).optional(),
    blob: z
      .object({
        workspaceId: resourceId,
        key: resourceId,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().nonnegative().max(limits.bytes),
        contentType: z.string().max(100),
      })
      .strict()
      .optional(),
    metadata: z
      .record(z.string().regex(/^[A-Za-z0-9_-]{1,60}$/), scalar)
      .refine((m) => Object.keys(m).length <= 30),
    access: accessSchema,
  })
  .strict()
  .refine(
    (d) => !(d.text !== undefined && d.blob) && (d.text !== undefined || d.blob || d.url),
    'Provide text, blob, or a URL; URL may accompany text/blob as provenance.',
  );
export const searchSchema = z
  .object({
    mode: z.enum(['keyword', 'vector', 'hybrid']).default('hybrid'),
    topK: z.number().int().min(1).max(20).default(5),
    metadata: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,60}$/), scalar).default({}),
    sourceIds: z.array(resourceId).max(100).optional(),
    minSimilarity: z.number().min(-1).max(1).optional(),
    minRerankScore: z.number().min(0).max(1).optional(),
    maxPerSource: z.number().int().min(1).max(20).default(2),
    rerank: z.boolean().default(false),
    exact: z.boolean().default(false),
  })
  .strict();
export function context(value) {
  return tenantContextSchema.parse(value);
}
export function failure(code, message, retryable = false) {
  return new PlatformError(code, message, { retryable });
}
export function checkSignal(signal) {
  signal?.throwIfAborted();
}
export function normalizeVectors(vectors, count, dimension = limits.dimension) {
  if (
    !Array.isArray(vectors) ||
    vectors.length !== count ||
    vectors.some(
      (v) => !Array.isArray(v) || v.length !== dimension || v.some((n) => !Number.isFinite(n)),
    )
  )
    throw failure(
      'DEPENDENCY_UNAVAILABLE',
      'Embedding output is invalid; verify the configured model and dimension.',
    );
  return vectors.map((v) => {
    const norm = Math.hypot(...v);
    if (!norm) throw failure('DEPENDENCY_UNAVAILABLE', 'Embedding output contains a zero vector.');
    return v.map((n) => n / norm);
  });
}
