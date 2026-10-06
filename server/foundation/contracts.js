import { z } from 'zod';

export const CONTRACT_VERSION = 1;
export const resourceId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const tenantContextSchema = z
  .object({
    workspaceId: resourceId,
    actor: z
      .object({
        kind: z.enum(['user', 'application', 'service']),
        id: resourceId,
      })
      .strict(),
    requestId: resourceId,
  })
  .strict();

// Queue entries contain references, never credentials, document bodies or model prompts.
export const jobSchema = z
  .object({
    version: z.literal(CONTRACT_VERSION),
    id: z.uuid(),
    workspaceId: resourceId,
    kind: z.enum([
      'workflow.run',
      'source.ingest',
      'connector.sync',
      'evaluation.run',
      'maintenance.retention',
    ]),
    resourceId,
    requestId: resourceId,
  })
  .strict();

export const secretRefSchema = z
  .object({
    workspaceId: resourceId,
    connectionId: resourceId,
    version: z.number().int().positive(),
  })
  .strict();

export const connectorDescriptorSchema = z
  .object({
    id: resourceId,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    auth: z.enum(['none', 'api-key', 'oauth2', 'database']),
    actions: z.array(
      z
        .object({
          id: resourceId,
          effect: z.enum(['read', 'write']),
          idempotency: z.enum(['none', 'provider-key', 'read-only']),
          requiresApproval: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.actions.map((action) => action.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Connector action IDs must be unique' });
    value.actions.forEach((action, index) => {
      if (action.effect === 'write' && action.idempotency === 'read-only')
        context.addIssue({
          code: 'custom',
          path: ['actions', index],
          message: 'Writes cannot declare read-only idempotency',
        });
    });
  });

export const citationSchema = z
  .object({
    workspaceId: resourceId,
    collectionId: resourceId,
    sourceId: resourceId,
    sourceVersion: z.number().int().positive(),
    chunkId: resourceId,
    text: z.string(),
    score: z.number().finite(),
    location: z
      .object({
        page: z.number().int().positive().optional(),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().nonnegative().optional(),
        url: z.url().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.location.start !== undefined &&
      value.location.end !== undefined &&
      value.location.end < value.location.start
    )
      context.addIssue({ code: 'custom', message: 'Citation end must not precede start' });
  });

export const RUN_STATES = Object.freeze([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);
export const ACTION_STATES = Object.freeze([
  'prepared',
  'started',
  'succeeded',
  'failed',
  'uncertain',
]);
