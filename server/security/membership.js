import crypto from 'node:crypto';
import { z } from 'zod';
import { resourceId } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
import { tokenHash } from './tokens.js';
import { writeAudit } from './audit.js';
export function createMembershipRepository({ database, authorize }) {
  const roleSchema = z.enum(['administrator', 'editor', 'viewer']);
  async function lock(s, context) {
    await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,20200))', [
      context.workspaceId,
    ]);
    const row = await s.one(
      `SELECT m.role FROM relay.security_memberships m JOIN relay.security_accounts a ON a.id=m.user_id
      JOIN relay.security_workspaces w ON w.workspace_id=m.workspace_id
      WHERE m.workspace_id=$1 AND m.user_id=$2 AND a.disabled_at IS NULL AND w.suspended_at IS NULL
      AND (NOT w.mfa_required OR a.mfa_enabled) FOR UPDATE OF m`,
      [context.workspaceId, context.actor.id],
    );
    if (context.actor.kind !== 'user' || !['owner', 'administrator'].includes(row?.role))
      throw new PlatformError('FORBIDDEN', 'Administrator access is required.');
    return row.role;
  }
  return Object.freeze({
    async invite(context, input) {
      await authorize(context, 'membership.manage');
      const b = z.object({ email: z.email(), role: roleSchema }).strict().parse(input);
      const id = crypto.randomUUID(),
        token = crypto.randomBytes(32).toString('base64url');
      await database.transaction(context, async (s) => {
        const role = await lock(s, context);
        const policy = await s.one(
          'SELECT email_domains FROM relay.security_workspaces WHERE workspace_id=$1',
          [context.workspaceId],
        );
        if (
          policy.email_domains.length &&
          !policy.email_domains.includes(b.email.toLowerCase().split('@')[1])
        )
          throw new PlatformError('FORBIDDEN', 'Invitation email domain is restricted.');
        if (b.role === 'administrator' && role !== 'owner')
          throw new PlatformError('FORBIDDEN', 'Owner access is required.');
        await s.query(
          `INSERT INTO relay.security_invitations(id,workspace_id,email,role,inviter_id,token_hash,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            context.workspaceId,
            b.email.toLowerCase(),
            b.role,
            context.actor.id,
            tokenHash(token),
            new Date(Date.now() + 7 * 86400000).toISOString(),
          ],
        );
        await writeAudit(s, context, 'invitation.created', id);
      });
      return { id, token };
    },
    async accept(context, token) {
      if (context.actor.kind !== 'user')
        throw new PlatformError('FORBIDDEN', 'User identity is required.');
      z.string()
        .regex(/^[\w-]{43}$/)
        .parse(token);
      return database.transaction(context, async (s) => {
        await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,20200))', [
          context.workspaceId,
        ]);
        const invitation = await s.one(
          `SELECT * FROM relay.security_invitations WHERE workspace_id=$1 AND token_hash=$2
          AND expires_at>now() AND revoked_at IS NULL AND accepted_at IS NULL FOR UPDATE`,
          [context.workspaceId, tokenHash(token)],
        );
        const user = await s.one(
          'SELECT email FROM relay.security_accounts WHERE id=$1 AND disabled_at IS NULL',
          [context.actor.id],
        );
        const policy = await s.one(
          'SELECT email_domains,suspended_at FROM relay.security_workspaces WHERE workspace_id=$1',
          [context.workspaceId],
        );
        const inviter =
          invitation &&
          (await s.one(
            `SELECT m.role FROM relay.security_memberships m JOIN relay.security_accounts a ON a.id=m.user_id
             JOIN relay.security_workspaces w ON w.workspace_id=m.workspace_id
             WHERE m.workspace_id=$1 AND m.user_id=$2 AND a.disabled_at IS NULL
             AND (NOT w.mfa_required OR a.mfa_enabled)`,
            [context.workspaceId, invitation.inviter_id],
          ));
        if (
          !invitation ||
          user?.email.toLowerCase() !== invitation.email ||
          !['administrator', 'owner'].includes(inviter?.role) ||
          (invitation.role === 'administrator' && inviter.role !== 'owner') ||
          !policy ||
          policy.suspended_at ||
          (policy.email_domains.length &&
            !policy.email_domains.includes(invitation?.email.split('@')[1]))
        )
          throw new PlatformError('FORBIDDEN', 'Invitation is no longer valid.');
        await s.query(
          'INSERT INTO relay.security_memberships VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO NOTHING',
          [context.workspaceId, context.actor.id, invitation.role],
        );
        await s.query(
          'UPDATE relay.security_invitations SET accepted_at=now() WHERE workspace_id=$1 AND id=$2',
          [context.workspaceId, invitation.id],
        );
        await writeAudit(s, context, 'invitation.accepted', invitation.id);
      });
    },
    async revokeInvitation(context, id) {
      z.uuid().parse(id);
      await authorize(context, 'membership.manage');
      await database.transaction(context, async (s) => {
        await lock(s, context);
        await s.query(
          'UPDATE relay.security_invitations SET revoked_at=now() WHERE workspace_id=$1 AND id=$2 AND accepted_at IS NULL',
          [context.workspaceId, id],
        );
        await writeAudit(s, context, 'invitation.revoked', id);
      });
    },
    async change(context, userId, newRole = null) {
      resourceId.parse(userId);
      if (newRole !== null) roleSchema.parse(newRole);
      await authorize(context, 'membership.manage');
      await database.transaction(context, async (s) => {
        const role = await lock(s, context);
        const target = await s.one(
          'SELECT role FROM relay.security_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',
          [context.workspaceId, userId],
        );
        if (
          !target ||
          target.role === 'owner' ||
          (role !== 'owner' && (target.role === 'administrator' || newRole === 'administrator'))
        )
          throw new PlatformError('FORBIDDEN', 'Membership change is not permitted.');
        if (newRole === null)
          await s.query(
            'DELETE FROM relay.security_memberships WHERE workspace_id=$1 AND user_id=$2',
            [context.workspaceId, userId],
          );
        else
          await s.query(
            'UPDATE relay.security_memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2',
            [context.workspaceId, userId, newRole],
          );
        await s.query(
          'UPDATE relay.security_invitations SET revoked_at=now() WHERE workspace_id=$1 AND inviter_id=$2 AND accepted_at IS NULL',
          [context.workspaceId, userId],
        );
        await s.query(
          'UPDATE relay.security_tokens SET revoked_at=now() WHERE workspace_id=$1 AND issuer_id=$2 AND revoked_at IS NULL',
          [context.workspaceId, userId],
        );
        await writeAudit(
          s,
          context,
          newRole === null ? 'member.removed' : 'member.role.changed',
          userId,
        );
      });
    },
  });
}
