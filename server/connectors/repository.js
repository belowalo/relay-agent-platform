import crypto from 'node:crypto';
import { tenantContextSchema, resourceId, secretRefSchema } from '../foundation/contracts.js';
import { ConnectorError, invalid } from './core.js';

/** Store configuration and references only. Secrets and OAuth refresh are security-owned. */
export function createConnectionRepository(database, { authorize, validateConfig }) {
  if (!authorize || !validateConfig) throw invalid();
  async function check(ctx, id, action) {
    tenantContextSchema.parse(ctx);
    resourceId.parse(id);
    await authorize(ctx, { connectionId: id, action });
  }
  return {
    async save(ctx, id, { kind, config, secretRef }) {
      await check(ctx, id, 'connection.configure');
      config = validateConfig(kind, config);
      if (secretRef) {
        secretRef = secretRefSchema.parse(secretRef);
        if (secretRef.workspaceId !== ctx.workspaceId || secretRef.connectionId !== id)
          throw new ConnectorError(
            'FORBIDDEN',
            'Credential must match this connection and workspace.',
          );
      }
      return database.transaction(ctx, async (s) => {
        const result = await s.one(
          `INSERT INTO relay.connector_connections(workspace_id,id,kind,config,secret_ref) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(workspace_id,id) DO UPDATE SET kind=EXCLUDED.kind,config=EXCLUDED.config,secret_ref=EXCLUDED.secret_ref,status='active',generation=relay.connector_connections.generation+1,updated_at=clock_timestamp() RETURNING id,generation`,
          [
            ctx.workspaceId,
            id,
            kind,
            JSON.stringify(config),
            secretRef ? JSON.stringify(secretRef) : null,
          ],
        );
        await s.query(
          'UPDATE relay.connector_sync SET generation=generation+1,owner_id=NULL,expires_at=NULL WHERE workspace_id=$1 AND connection_id=$2',
          [ctx.workspaceId, id],
        );
        return result;
      });
    },
    async get(ctx, id) {
      await check(ctx, id, 'connection.use');
      const r = await database.transaction(ctx, (s) =>
        s.one(
          'SELECT id,kind,config,secret_ref,generation,status FROM relay.connector_connections WHERE workspace_id=$1 AND id=$2',
          [ctx.workspaceId, id],
        ),
      );
      if (!r || r.status !== 'active')
        throw new ConnectorError('FORBIDDEN', 'Connection is absent or disconnected.');
      return {
        id: r.id,
        kind: r.kind,
        config: r.config,
        secretRef: r.secret_ref,
        generation: r.generation,
      };
    },
    async disconnect(ctx, id) {
      await check(ctx, id, 'connection.disconnect');
      await database.transaction(ctx, async (s) => {
        await s.query(
          "UPDATE relay.connector_connections SET status='disconnected',generation=generation+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, id],
        );
        await s.query(
          'UPDATE relay.connector_sync SET generation=generation+1,owner_id=NULL,expires_at=NULL WHERE workspace_id=$1 AND connection_id=$2',
          [ctx.workspaceId, id],
        );
      });
    },
    async initializeSync(ctx, id, connectionId) {
      await check(ctx, connectionId, 'connection.sync');
      resourceId.parse(id);
      const result = await database.transaction(ctx, (s) =>
        s.one(
          'INSERT INTO relay.connector_sync(workspace_id,id,connection_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,id) DO UPDATE SET connection_id=relay.connector_sync.connection_id WHERE relay.connector_sync.connection_id=EXCLUDED.connection_id RETURNING id',
          [ctx.workspaceId, id, connectionId],
        ),
      );
      if (!result)
        throw new ConnectorError(
          'CONFLICT',
          'Source synchronization already belongs to a different connection.',
        );
    },
  };
}

/** Every checkpoint is fenced; no network operation lives inside a transaction. */
export function createSyncState(database, { authorize, leaseMs = 60000 } = {}) {
  if (!authorize || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000)
    throw invalid();
  return {
    async withLease(ctx, id, fn) {
      tenantContextSchema.parse(ctx);
      resourceId.parse(id);
      await authorize(ctx, { sourceId: id, action: 'connector.sync' });
      const owner = crypto.randomUUID();
      const row = await database.transaction(ctx, (s) =>
        s.one(
          `UPDATE relay.connector_sync AS sync SET owner_id=$3,generation=sync.generation+1,expires_at=clock_timestamp()+$4*interval '1 millisecond'
      WHERE sync.workspace_id=$1 AND sync.id=$2 AND (sync.expires_at IS NULL OR sync.expires_at<clock_timestamp())
      AND EXISTS(SELECT 1 FROM relay.connector_connections c WHERE c.workspace_id=sync.workspace_id AND c.id=sync.connection_id AND c.status='active') RETURNING cursor,generation`,
          [ctx.workspaceId, id, owner, leaseMs],
        ),
      );
      if (!row)
        throw new ConnectorError(
          'CONFLICT',
          'Synchronization is running or its connection is disconnected.',
        );
      const values = [ctx.workspaceId, id, owner, row.generation];
      async function fenced(fn) {
        await authorize(ctx, { sourceId: id, action: 'connector.sync' });
        return database.transaction(ctx, async (s) => {
          const live = await s.one(
            `SELECT sync.id FROM relay.connector_sync sync JOIN relay.connector_connections c ON c.workspace_id=sync.workspace_id AND c.id=sync.connection_id
        WHERE sync.workspace_id=$1 AND sync.id=$2 AND sync.owner_id=$3 AND sync.generation=$4 AND sync.expires_at>clock_timestamp() AND c.status='active' FOR UPDATE OF sync`,
            values,
          );
          if (!live)
            throw new ConnectorError('CONFLICT', 'Synchronization lease was revoked or expired.');
          await s.query(
            "UPDATE relay.connector_sync SET expires_at=clock_timestamp()+$5*interval '1 millisecond' WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND generation=$4",
            [...values, leaseMs],
          );
          return fn(s);
        });
      }
      try {
        return await fn({
          cursor: row.cursor,
          assertCurrent: () => fenced(() => undefined),
          getItem: (externalId) =>
            fenced(async (s) => {
              const r = await s.one(
                'SELECT source_id,revision,removed FROM relay.connector_sync_items WHERE workspace_id=$1 AND sync_id=$2 AND external_id=$3',
                [ctx.workspaceId, id, externalId],
              );
              return r ? { sourceId: r.source_id, revision: r.revision, removed: r.removed } : null;
            }),
          recordItem: (externalId, item) => {
            if (
              typeof externalId !== 'string' ||
              externalId.length > 2048 ||
              typeof item.revision !== 'string'
            )
              throw invalid();
            return fenced((s) =>
              s.query(
                `INSERT INTO relay.connector_sync_items(workspace_id,sync_id,external_id,source_id,revision,removed) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(workspace_id,sync_id,external_id) DO UPDATE SET source_id=EXCLUDED.source_id,revision=EXCLUDED.revision,removed=EXCLUDED.removed`,
                [ctx.workspaceId, id, externalId, item.sourceId, item.revision, item.removed],
              ),
            );
          },
          commitCursor: (cursor) => {
            if (
              cursor !== null &&
              cursor !== undefined &&
              (typeof cursor !== 'string' || cursor.length > 8192)
            )
              throw invalid();
            return fenced((s) =>
              s.query(
                'UPDATE relay.connector_sync SET cursor=$5 WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND generation=$4',
                [...values, cursor ?? null],
              ),
            );
          },
        });
      } finally {
        await database.transaction(ctx, (s) =>
          s.query(
            'UPDATE relay.connector_sync SET owner_id=NULL,expires_at=NULL WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND generation=$4',
            values,
          ),
        );
      }
    },
  };
}
