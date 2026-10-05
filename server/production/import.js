import crypto from 'node:crypto';
import { migrateLegacyEnvelope } from '../security/legacy-secrets.js';
import { documentSchema, accessSchema } from '../knowledge/contracts.js';
import { hash } from '../knowledge/chunks.js';
const json = JSON.stringify;
// Called inside the legacy import transaction. No source file or plaintext is mutated/exported.
export function createIntegratedImport(vault) {
  return async (client, input, { legacyKey }) => {
    for (const table of [
      'security_accounts',
      'security_workspaces',
      'security_credentials',
      'knowledge_sources',
      'connector_connections',
    ]) {
      if (Number((await client.query(`SELECT count(*) AS n FROM relay.${table}`)).rows[0].n))
        throw new Error('INTEGRATION_IMPORT_DESTINATION_NOT_EMPTY');
    }
    for (const u of input.tables.get('users')) {
      let mfaSecret = null;
      if (u.mfa_secret)
        mfaSecret = migrateLegacyEnvelope(
          { workspaceId: 'identity', connectionId: u.id, version: 1 },
          u.mfa_secret,
          legacyKey,
          vault,
        );
      await client.query(
        'INSERT INTO relay.security_accounts(id,email,name,password_hash,mfa_secret,mfa_last_step,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [u.id, u.email.toLowerCase(), u.name, u.password, mfaSecret, u.mfa_last_step, u.created_at],
      );
    }
    for (const w of input.tables.get('workspaces'))
      await client.query('INSERT INTO relay.security_workspaces(workspace_id) VALUES($1)', [w.id]);
    for (const m of input.tables.get('members'))
      await client.query('INSERT INTO relay.security_memberships VALUES($1,$2,$3)', [
        m.workspace_id,
        m.user_id,
        m.role,
      ]);
    for (const c of input.tables.get('connections')) {
      let secretRef;
      if (c.secret) {
        secretRef = { workspaceId: c.workspace_id, connectionId: c.id, version: 1 };
        const envelope = migrateLegacyEnvelope(secretRef, c.secret, legacyKey, vault);
        await client.query(
          'INSERT INTO relay.security_credentials(workspace_id,connection_id,version,envelope,key_id) VALUES($1,$2,1,$3,$4)',
          [c.workspace_id, c.id, envelope, JSON.parse(envelope).keyId],
        );
      }
      const config = { ...JSON.parse(c.config), secretRef };
      delete config.allowPrivate;
      await client.query("UPDATE relay.connections SET secret='',config=$2 WHERE id=$1", [
        c.id,
        json(config),
      ]);
    }
    const chunks = input.tables.get('chunks'),
      vectors = new Map(input.tables.get('embeddings').map((v) => [v.chunk_id, v]));
    for (const s of input.tables.get('sources')) {
      const metadata = JSON.parse(s.metadata || '{}');
      // Legacy ACLs must be explicitly understood; unknown restrictions abort instead of widening access.
      let access = { mode: 'workspace', principalIds: [] };
      if (metadata.access) access = accessSchema.parse(metadata.access);
      if (metadata.visibility === 'restricted' || metadata.allowedUserIds) {
        const ids = metadata.allowedUserIds;
        if (!Array.isArray(ids) || !ids.length)
          throw new Error('LEGACY_DOCUMENT_ACL_REVIEW_REQUIRED');
        access = { mode: 'restricted', principalIds: ids.map((id) => 'user:' + id) };
      }
      const draft = {
        collectionId: s.collection_id,
        externalId: 'legacy:' + s.id,
        name: s.name,
        text: s.content,
        metadata: {},
        access,
      };
      documentSchema.parse(draft);
      const indexed = s.status === 'ready' && chunks.some((c) => c.source_id === s.id);
      await client.query(
        'INSERT INTO relay.knowledge_sources(id,workspace_id,collection_id,external_id,version,indexed_version,fingerprint,access,metadata,name,created_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10)',
        [
          s.id,
          s.workspace_id,
          s.collection_id,
          draft.externalId,
          indexed ? 1 : null,
          hash(json(draft)),
          json(access),
          json(draft.metadata),
          s.name,
          s.created_at,
        ],
      );
      await client.query(
        'INSERT INTO relay.knowledge_versions(workspace_id,source_id,version,input,extraction,content_hash) VALUES($1,$2,1,$3,$4,$5)',
        [
          s.workspace_id,
          s.id,
          json(draft),
          json({
            segments: [{ text: s.content }],
            method: 'legacy-text',
            warnings: [
              'Imported offsets are relative to each preserved chunk. Reindex for document offsets.',
            ],
          }),
          hash(s.content),
        ],
      );
      if (indexed)
        for (const c of chunks.filter((c) => c.source_id === s.id)) {
          await client.query(
            'INSERT INTO relay.knowledge_chunks(id,workspace_id,collection_id,source_id,version,ordinal,content,location) VALUES($1,$2,$3,$4,1,$5,$6,$7)',
            [
              c.id,
              c.workspace_id,
              c.collection_id,
              c.source_id,
              c.ordinal,
              c.content,
              json({ start: 0, end: c.content.length }),
            ],
          );
          const v = vectors.get(c.id);
          if (v) {
            const vector = JSON.parse(v.vector);
            if (vector.length !== 384 || vector.some((n) => !Number.isFinite(n)))
              throw new Error('IMPORT_VECTOR_DIMENSION_REVIEW_REQUIRED');
            await client.query('INSERT INTO relay.knowledge_vectors VALUES($1,$2,$3,$4::vector)', [
              v.workspace_id,
              v.chunk_id,
              v.model,
              v.vector,
            ]);
          }
        }
    }
    // Login sessions, invitations, reset tokens, and unattributed publications are not delegated to new security repositories.
    // Historical runs have no persisted principal and remain halted; budgets require an owner to configure them.
    input.secretCompatibility =
      'credentials and MFA rewrapped to tenant/version-bound envelopes; sessions and application grants revoked';
  };
}
