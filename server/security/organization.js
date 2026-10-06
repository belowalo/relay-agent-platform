import { z } from 'zod';
import { PlatformError } from '../foundation/errors.js';
import { writeAudit } from './audit.js';
// Workspace is the initial organization boundary. No implicit cross-workspace organization role.
export function createOrganizationControls({ database, authorize }) {
  return Object.freeze({
    async configure(context, input) {
      const b = z
        .object({
          mfaRequired: z.boolean(),
          emailDomains: z
            .array(
              z
                .string()
                .toLowerCase()
                .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
            )
            .max(100),
        })
        .strict()
        .parse(input);
      await authorize(context, 'workspace.manage');
      await database.transaction(context, async (s) => {
        const user = await s.one(
          `SELECT m.role,a.mfa_enabled FROM relay.security_memberships m JOIN relay.security_accounts a ON a.id=m.user_id
        WHERE m.workspace_id=$1 AND m.user_id=$2 AND a.disabled_at IS NULL FOR UPDATE OF m`,
          [context.workspaceId, context.actor.id],
        );
        if (
          context.actor.kind !== 'user' ||
          user?.role !== 'owner' ||
          (b.mfaRequired && !user.mfa_enabled)
        )
          throw new PlatformError(
            'FORBIDDEN',
            'An owner with MFA enabled must configure organization authentication.',
          );
        await s.query(
          'UPDATE relay.security_workspaces SET mfa_required=$2,email_domains=$3 WHERE workspace_id=$1',
          [context.workspaceId, b.mfaRequired, JSON.stringify(b.emailDomains)],
        );
        await writeAudit(s, context, 'organization.authentication.updated', context.workspaceId);
      });
    },
  });
}
