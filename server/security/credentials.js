import { secretRefSchema } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
import { writeAudit } from './audit.js';
export function createSecretPort({ database, authorize, vault }) {
  function scoped(context, reference) {
    const ref = secretRefSchema.parse(reference);
    if (ref.workspaceId !== context.workspaceId)
      throw new PlatformError('FORBIDDEN', 'Credential is outside workspace.');
    return ref;
  }
  return Object.freeze({
    async resolve(context, reference) {
      const ref = scoped(context, reference);
      await authorize(context, 'secret.resolve', { kind: 'connection', id: ref.connectionId });
      return database.transaction(context, async (s) => {
        const row = await s.one(
          'SELECT envelope FROM relay.security_credentials WHERE workspace_id=$1 AND connection_id=$2 AND version=$3 AND revoked_at IS NULL',
          [ref.workspaceId, ref.connectionId, ref.version],
        );
        if (!row) throw new PlatformError('NOT_FOUND', 'Credential version is unavailable.');
        await writeAudit(s, context, 'secret.resolved', ref.connectionId);
        return vault.open(context, ref, row.envelope);
      });
    },
    async store(context, reference, plaintext) {
      const ref = scoped(context, reference);
      await authorize(context, 'secret.manage', { kind: 'connection', id: ref.connectionId });
      const envelope = vault.seal(ref, plaintext),
        keyId = JSON.parse(envelope).keyId;
      await database.transaction(context, async (s) => {
        await s.query(
          'INSERT INTO relay.security_credentials(workspace_id,connection_id,version,envelope,key_id) VALUES($1,$2,$3,$4,$5)',
          [ref.workspaceId, ref.connectionId, ref.version, envelope, keyId],
        );
        await writeAudit(s, context, 'secret.created', ref.connectionId);
      });
    },
    async revoke(context, reference) {
      const ref = scoped(context, reference);
      await authorize(context, 'secret.manage', { kind: 'connection', id: ref.connectionId });
      await database.transaction(context, async (s) => {
        await s.query(
          'UPDATE relay.security_credentials SET revoked_at=now() WHERE workspace_id=$1 AND connection_id=$2 AND version=$3',
          [ref.workspaceId, ref.connectionId, ref.version],
        );
        await writeAudit(s, context, 'secret.revoked', ref.connectionId);
      });
    },
    async rewrap(context, reference, destinationVault) {
      const ref = scoped(context, reference);
      await authorize(context, 'secret.manage', { kind: 'connection', id: ref.connectionId });
      await database.transaction(context, async (s) => {
        const row = await s.one(
          'SELECT envelope FROM relay.security_credentials WHERE workspace_id=$1 AND connection_id=$2 AND version=$3 AND revoked_at IS NULL FOR UPDATE',
          [ref.workspaceId, ref.connectionId, ref.version],
        );
        if (!row) throw new PlatformError('NOT_FOUND', 'Credential version is unavailable.');
        const envelope = destinationVault.seal(ref, vault.open(context, ref, row.envelope));
        await s.query(
          'UPDATE relay.security_credentials SET envelope=$4,key_id=$5 WHERE workspace_id=$1 AND connection_id=$2 AND version=$3',
          [ref.workspaceId, ref.connectionId, ref.version, envelope, JSON.parse(envelope).keyId],
        );
        await writeAudit(s, context, 'secret.key.rotated', ref.connectionId);
      });
    },
  });
}
