import crypto from 'node:crypto';
import { z } from 'zod';
import { resourceId, tenantContextSchema } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
import { writeAudit } from './audit.js';
export const tokenHash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const allowed = [
  'run.execute',
  'run.read',
  'workflow.read',
  'document.read',
  'connector.invoke',
  'secret.resolve',
];
const inputSchema = z
  .object({
    applicationId: resourceId,
    permissions: z.array(z.enum(allowed)).min(1).max(6),
    resources: z
      .array(
        z
          .string()
          .regex(
            /^(application|workflow|run|document|collection|connection|connector|tool):[\w-]{1,128}$/,
          ),
      )
      .min(1)
      .max(500),
    expiresAt: z.number().int().min(1),
  })
  .strict();
export function createTokenRepository({ database, authorize, applicationLookup }) {
  async function mint(context, input, replaces = null) {
    context = tenantContextSchema.parse(context);
    input = inputSchema.parse(input);
    if (context.actor.kind !== 'user')
      throw new PlatformError('FORBIDDEN', 'Only administrators may issue tokens.');
    if (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 90 * 86400000)
      throw new PlatformError('VALIDATION_ERROR', 'Token expiry must be within 90 days.');
    await authorize(context, 'token.manage', { kind: 'application', id: input.applicationId });
    // Authorize every delegated resource; no cross-tenant identifiers in grants.
    for (const value of input.resources) {
      const [kind, id] = value.split(':');
      await authorize(context, 'token.manage', { kind, id });
    }
    const id = crypto.randomUUID(),
      token = 'relay_' + crypto.randomBytes(32).toString('base64url');
    await database.transaction(context, async (s) => {
      // Serialize issuance with membership changes, then recheck the issuer after the wait.
      await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,20200))', [
        context.workspaceId,
      ]);
      const issuer = await s.one(
        `SELECT m.role FROM relay.security_memberships m
        JOIN relay.security_accounts a ON a.id=m.user_id JOIN relay.security_workspaces w ON w.workspace_id=m.workspace_id
        WHERE m.workspace_id=$1 AND m.user_id=$2 AND a.disabled_at IS NULL AND w.suspended_at IS NULL
        AND (NOT w.mfa_required OR a.mfa_enabled)`,
        [context.workspaceId, context.actor.id],
      );
      if (!['owner', 'administrator'].includes(issuer?.role))
        throw new PlatformError('FORBIDDEN', 'Token issuer is no longer authorized.');
      if (replaces) {
        const row = await s.one(
          'SELECT issuer_id,application_id FROM relay.security_tokens WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL FOR UPDATE',
          [context.workspaceId, replaces],
        );
        if (!row || row.application_id !== input.applicationId)
          throw new PlatformError('NOT_FOUND', 'Token is unavailable.');
        await s.query(
          'UPDATE relay.security_tokens SET revoked_at=now() WHERE workspace_id=$1 AND id=$2',
          [context.workspaceId, replaces],
        );
      }
      await s.query(
        `INSERT INTO relay.security_tokens(id,workspace_id,issuer_id,application_id,token_hash,permissions,resources,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          context.workspaceId,
          context.actor.id,
          input.applicationId,
          tokenHash(token),
          JSON.stringify(input.permissions),
          JSON.stringify(input.resources),
          new Date(input.expiresAt).toISOString(),
        ],
      );
      await writeAudit(s, context, replaces ? 'token.rotated' : 'token.created', id);
    });
    return { id, token, expiresAt: input.expiresAt };
  }
  async function lookup(context) {
    context = tenantContextSchema.parse(context);
    const row = await database.transaction(context, (s) =>
      s.one(
        `SELECT t.* FROM relay.security_tokens t
      JOIN relay.security_memberships m ON m.workspace_id=t.workspace_id AND m.user_id=t.issuer_id
      JOIN relay.security_accounts a ON a.id=m.user_id
      JOIN relay.security_workspaces w ON w.workspace_id=t.workspace_id
      WHERE t.workspace_id=$1 AND t.id=$2 AND t.revoked_at IS NULL AND t.expires_at>now()
      AND m.role IN ('owner','administrator') AND a.disabled_at IS NULL AND w.suspended_at IS NULL
      AND (NOT w.mfa_required OR a.mfa_enabled)`,
        [context.workspaceId, context.actor.id],
      ),
    );
    if (!row || !(await applicationLookup(context, row.application_id))) return null;
    return {
      workspaceId: row.workspace_id,
      expiresAt: new Date(row.expires_at).getTime(),
      permissions: row.permissions,
      resources: row.resources,
      applicationId: row.application_id,
    };
  }
  return Object.freeze({
    mint,
    lookup,
    rotate: (context, id, input) => {
      z.uuid().parse(id);
      return mint(context, input, id);
    },
    async authenticate({ workspaceId, applicationId, token, requestId }) {
      resourceId.parse(workspaceId);
      resourceId.parse(applicationId);
      resourceId.parse(requestId);
      if (typeof token !== 'string' || !/^relay_[\w-]{43}$/.test(token))
        throw new PlatformError('UNAUTHENTICATED', 'Invalid API token.');
      const probe = { workspaceId, actor: { kind: 'application', id: applicationId }, requestId };
      const row = await database.transaction(probe, (s) =>
        s.one(
          'SELECT id FROM relay.security_tokens WHERE workspace_id=$1 AND application_id=$2 AND token_hash=$3',
          [workspaceId, applicationId, tokenHash(token)],
        ),
      );
      if (!row) throw new PlatformError('UNAUTHENTICATED', 'Invalid API token.');
      const context = { ...probe, actor: { kind: 'application', id: row.id } };
      if (!(await lookup(context)))
        throw new PlatformError('UNAUTHENTICATED', 'API token is no longer valid.');
      return context;
    },
    async revoke(context, id) {
      z.uuid().parse(id);
      await authorize(context, 'token.manage');
      await database.transaction(context, async (s) => {
        await s.query(
          'UPDATE relay.security_tokens SET revoked_at=now() WHERE workspace_id=$1 AND id=$2',
          [context.workspaceId, id],
        );
        await writeAudit(s, context, 'token.revoked', id);
      });
    },
  });
}
