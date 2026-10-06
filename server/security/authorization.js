import { tenantContextSchema, resourceId as opaqueIdSchema } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';

export const permissionMatrix = Object.freeze({
  'workspace.read': ['viewer', 'editor', 'administrator', 'owner'],
  'document.read': ['viewer', 'editor', 'administrator', 'owner'],
  'workflow.read': ['viewer', 'editor', 'administrator', 'owner'],
  'run.read': ['viewer', 'editor', 'administrator', 'owner'],
  'workflow.write': ['editor', 'administrator', 'owner'],
  'run.execute': ['editor', 'administrator', 'owner'],
  'run.approve': ['editor', 'administrator', 'owner'],
  'document.write': ['editor', 'administrator', 'owner'],
  'connector.invoke': ['editor', 'administrator', 'owner'],
  'secret.resolve': ['editor', 'administrator', 'owner'],
  'publication.manage': ['administrator', 'owner'],
  'token.manage': ['administrator', 'owner'],
  'secret.manage': ['administrator', 'owner'],
  'membership.manage': ['administrator', 'owner'],
  'workspace.manage': ['administrator', 'owner'],
  'audit.read': ['administrator', 'owner'],
  'budget.manage': ['owner'],
});
export function requirePermission(role, permission) {
  if (!permissionMatrix[permission]?.includes(role))
    throw new PlatformError('FORBIDDEN', 'Permission is required.');
}
// Repository lookups must read current state. Never cache positive authorization across work.
export function createAuthorization({
  database,
  applicationLookup,
  resourceLookup,
  serviceLookup,
}) {
  async function authorize(context, permission, resource = null) {
    context = tenantContextSchema.parse(context);
    if (!Object.hasOwn(permissionMatrix, permission))
      throw new PlatformError('FORBIDDEN', 'Unknown permission.');
    const { workspaceId, actor } = context;
    const workspace = await database.transaction(context, (s) =>
      s.one('SELECT suspended_at FROM relay.security_workspaces WHERE workspace_id=$1', [
        workspaceId,
      ]),
    );
    if (!workspace || workspace.suspended_at)
      throw new PlatformError('FORBIDDEN', 'Workspace is unavailable.');
    let principal;
    if (actor.kind === 'user') {
      principal = await database.transaction(context, (session) =>
        session.one(
          `SELECT m.role FROM relay.security_memberships m JOIN relay.security_accounts a ON a.id=m.user_id
         JOIN relay.security_workspaces w ON w.workspace_id=m.workspace_id
         WHERE m.workspace_id=$1 AND m.user_id=$2 AND a.disabled_at IS NULL AND w.suspended_at IS NULL
         AND (NOT w.mfa_required OR a.mfa_enabled)`,
          [workspaceId, actor.id],
        ),
      );
      requirePermission(principal?.role, permission);
    } else {
      principal = await (actor.kind === 'application'
        ? applicationLookup?.(context)
        : serviceLookup?.(context));
      if (
        !principal ||
        principal.workspaceId !== workspaceId ||
        principal.revoked ||
        !Number.isFinite(principal.expiresAt) ||
        principal.expiresAt <= Date.now() ||
        !principal.permissions?.includes(permission)
      )
        throw new PlatformError('FORBIDDEN', 'Actor scope is no longer valid.');
    }
    if (resource) {
      opaqueIdSchema.parse(resource.id);
      const row = await resourceLookup?.(context, resource);
      if (!row || row.workspaceId !== workspaceId || row.revoked || row.disabled)
        throw new PlatformError('NOT_FOUND', 'Resource was not found.');
      const applicationRun =
        resource.kind === 'run' &&
        row.applicationId === principal?.applicationId &&
        principal?.resources?.includes(`application:${row.applicationId}`);
      if (
        actor.kind !== 'user' &&
        !principal.resources?.includes(`${resource.kind}:${resource.id}`) &&
        !applicationRun
      )
        throw new PlatformError('FORBIDDEN', 'Resource is outside actor scope.');
      if (
        row.access?.mode === 'restricted' &&
        !row.access.principalIds?.includes(`${actor.kind}:${actor.id}`)
      )
        throw new PlatformError('FORBIDDEN', 'Document access is restricted.');
      if (row.access && !['workspace', 'restricted'].includes(row.access.mode))
        throw new PlatformError('FORBIDDEN', 'Unknown resource policy.');
    }
    return context;
  }
  return Object.freeze({ authorize });
}
