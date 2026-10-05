import { randomUUID } from 'node:crypto';
import { enqueueInTransaction } from '../foundation/outbox.js';
import { hash } from './chunks.js';
import { failure } from './contracts.js';

// New SQL is generated explicitly for each backend. No legacy SQL translation.
export function createKnowledgeRepository(
  database,
  { dialect = 'postgres', enqueue = enqueueInTransaction } = {},
) {
  const pg = dialect === 'postgres';
  const table = (name) => (pg ? 'relay.' : '') + 'knowledge_' + name;
  const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
  const decode = (row) =>
    row && {
      ...row,
      access: row.access && json(row.access),
      metadata: row.metadata && json(row.metadata),
      input: row.input && json(row.input),
      context: row.context && json(row.context),
      error: row.error && json(row.error),
      diagnostics: row.diagnostics && json(row.diagnostics),
      location: row.location && json(row.location),
    };
  function sql(session) {
    const values = [];
    const p = (value) => {
      values.push(value);
      return (pg ? '$' : '?') + values.length;
    };
    return {
      p,
      one: (text) => session.one(text, values),
      all: (text) => session.all(text, values),
      query: (text) => session.query(text, values),
    };
  }
  const tx = (ctx, fn) => database.transaction(ctx, fn);
  async function source(ctx, sid, session) {
    const s = sql(session),
      { p } = s;
    return decode(
      await s.one(
        `SELECT * FROM ${table('sources')} WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(sid)}`,
      ),
    );
  }
  async function job(ctx, jid, session) {
    const s = sql(session),
      { p } = s;
    return decode(
      await s.one(
        `SELECT * FROM ${table('jobs')} WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(jid)}`,
      ),
    );
  }
  async function putJob(ctx, sid, version, session) {
    const jid = randomUUID(),
      s = sql(session),
      { p } = s;
    await s.query(
      `INSERT INTO ${table('jobs')}(id,workspace_id,source_id,version,context) VALUES(${p(jid)},${p(ctx.workspaceId)},${p(sid)},${p(version)},${p(JSON.stringify(ctx))})`,
    );
    await enqueue(session, {
      version: 1,
      id: jid,
      workspaceId: ctx.workspaceId,
      kind: 'source.ingest',
      resourceId: jid,
      requestId: ctx.requestId,
    });
    return jid;
  }
  return {
    dialect,
    database,
    getSource: (ctx, sid) => tx(ctx, (s) => source(ctx, sid, s)),
    getExternal: (ctx, cid, eid) =>
      tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        return decode(
          await s.one(
            `SELECT * FROM ${table('sources')} WHERE workspace_id=${p(ctx.workspaceId)} AND collection_id=${p(cid)} AND external_id=${p(eid)}`,
          ),
        );
      }),
    getJob: (ctx, jid) => tx(ctx, (s) => job(ctx, jid, s)),
    async upsert(ctx, input, expectedPrior, expectedBlobSources) {
      const fingerprint = hash(
        JSON.stringify({
          ...input,
          metadata: Object.fromEntries(Object.entries(input.metadata).sort()),
          access: { ...input.access, principalIds: [...new Set(input.access.principalIds)].sort() },
        }),
      );
      return tx(ctx, async (session) => {
        // Serialize first inserts too, including concurrent connector refreshes.
        if (pg) {
          const s = sql(session);
          await s.query(
            `SELECT pg_advisory_xact_lock(hashtextextended(${s.p(ctx.workspaceId + ':' + input.collectionId + ':' + input.externalId)},0))`,
          );
        }
        let s = sql(session),
          { p } = s;
        let prior = decode(
          await s.one(
            `SELECT * FROM ${table('sources')} WHERE workspace_id=${p(ctx.workspaceId)} AND collection_id=${p(input.collectionId)} AND external_id=${p(input.externalId)}${pg ? ' FOR UPDATE' : ''}`,
          ),
        );
        if (input.blob) {
          if (pg) {
            const lock = sql(session);
            await lock.query(
              `SELECT pg_advisory_xact_lock(hashtextextended(${lock.p(ctx.workspaceId + ':blob:' + input.blob.key)},0))`,
            );
          }
          const check = sql(session);
          if (
            await check.one(
              `SELECT key FROM ${table('blob_gc')} WHERE workspace_id=${check.p(ctx.workspaceId)} AND key=${check.p(input.blob.key)}`,
            )
          )
            throw failure(
              'CONFLICT',
              'Blob has been retired; upload it under a new immutable key.',
            );
        }
        if (input.blob && expectedBlobSources !== undefined) {
          const check = sql(session),
            { p } = check;
          const referenced = await check.all(
            `SELECT DISTINCT s.id,s.fingerprint FROM ${table('versions')} v JOIN ${table('sources')} s ON s.id=v.source_id AND s.workspace_id=v.workspace_id WHERE v.workspace_id=${p(ctx.workspaceId)} AND s.deleted=${pg ? 'false' : '0'} AND ${pg ? "v.input->'blob'->>'key'" : "json_extract(v.input,'$.blob.key')"}=${p(input.blob.key)} ORDER BY s.id`,
          );
          if (JSON.stringify(referenced) !== expectedBlobSources)
            throw failure('CONFLICT', 'Blob document policy changed; retry ingestion.');
        }
        if (expectedPrior !== undefined && (prior?.fingerprint || null) !== expectedPrior)
          throw failure('CONFLICT', 'Document changed during authorization; retry refresh.');
        if (prior && !prior.deleted && prior.fingerprint === fingerprint) {
          s = sql(session);
          p = s.p;
          const latest = await s.one(
            `SELECT id FROM ${table('jobs')} WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(prior.id)} AND version=${p(prior.version)} ORDER BY created_at DESC,id DESC LIMIT 1`,
          );
          return { sourceId: prior.id, version: prior.version, jobId: latest.id };
        }
        const sid = prior?.id || randomUUID(),
          version = (prior?.version || 0) + 1;
        s = sql(session);
        p = s.p;
        await s.query(
          `INSERT INTO ${table('sources')}(id,workspace_id,collection_id,external_id,version,fingerprint,access,metadata,name,deleted) VALUES(${p(sid)},${p(ctx.workspaceId)},${p(input.collectionId)},${p(input.externalId)},${p(version)},${p(fingerprint)},${p(JSON.stringify(input.access))},${p(JSON.stringify(input.metadata))},${p(input.name)},${pg ? 'false' : '0'}) ON CONFLICT(id) DO UPDATE SET version=excluded.version,fingerprint=excluded.fingerprint,access=excluded.access,metadata=excluded.metadata,name=excluded.name,deleted=excluded.deleted`,
        );
        s = sql(session);
        p = s.p;
        await s.query(
          `INSERT INTO ${table('versions')}(workspace_id,source_id,version,input,content_hash) VALUES(${p(ctx.workspaceId)},${p(sid)},${p(version)},${p(JSON.stringify(input))},${p(input.blob?.sha256 || hash(input.text ?? input.url))})`,
        );
        s = sql(session);
        p = s.p;
        await s.query(
          `UPDATE ${table('jobs')} SET state='cancelled',phase='superseded',generation=generation+1 WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(sid)} AND state IN ('queued','running')`,
        );
        return { sourceId: sid, version, jobId: await putJob(ctx, sid, version, session) };
      });
    },
    async reindex(ctx, sid, expectedFingerprint) {
      return tx(ctx, async (session) => {
        if (pg) {
          const lock = sql(session);
          await lock.one(
            `SELECT id FROM ${table('sources')} WHERE workspace_id=${lock.p(ctx.workspaceId)} AND id=${lock.p(sid)} FOR UPDATE`,
          );
        }
        const row = await source(ctx, sid, session);
        if (!row || row.deleted) throw failure('NOT_FOUND', 'Document not found.');
        if (expectedFingerprint !== undefined && row.fingerprint !== expectedFingerprint)
          throw failure('CONFLICT', 'Document changed during authorization; retry reindex.');
        let s = sql(session),
          { p } = s;
        await s.query(
          `UPDATE ${table('jobs')} SET state='cancelled',generation=generation+1 WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(sid)} AND state IN ('queued','running')`,
        );
        return {
          sourceId: sid,
          version: row.version,
          jobId: await putJob(ctx, sid, row.version, session),
        };
      });
    },
    async claim(ctx, jid, owner, leaseMs = 15000) {
      return tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        const row = decode(
          await s.one(
            `UPDATE ${table('jobs')} SET state='running',phase='extracting',progress=5,owner_id=${p(owner)},generation=generation+1,expires_at=${p(Date.now() + leaseMs)},error=NULL WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(jid)} AND (state='queued' OR (state='running' AND expires_at<${p(Date.now())})) RETURNING *`,
          ),
        );
        if (!row) return null;
        let q = sql(session);
        const version = decode(
          await q.one(
            `SELECT input FROM ${table('versions')} WHERE workspace_id=${q.p(ctx.workspaceId)} AND source_id=${q.p(row.source_id)} AND version=${q.p(row.version)}`,
          ),
        );
        const current = await source(ctx, row.source_id, session);
        if (!current || current.deleted || current.version !== row.version) return null;
        return {
          ...row,
          source: { ...current, id: row.source_id, version: row.version, input: version.input },
        };
      });
    },
    async progress(ctx, lease, progress, phase) {
      return tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        return !!(
          await s.query(
            `UPDATE ${table('jobs')} SET progress=${p(progress)},phase=${p(phase)},expires_at=${p(Date.now() + 15000)} WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(lease.id)} AND owner_id=${p(lease.owner_id)} AND generation=${p(lease.generation)} AND state='running' AND expires_at>${p(Date.now())}`,
          )
        ).rowCount;
      });
    },
    async details(ctx, lease, details) {
      return tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        await s.query(
          `UPDATE ${table('jobs')} SET diagnostics=${p(JSON.stringify(details))} WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(lease.id)} AND generation=${p(lease.generation)} AND owner_id=${p(lease.owner_id)} AND state='running'`,
        );
      });
    },
    async snapshot(ctx, lease, extraction) {
      return tx(ctx, async (session) => {
        if (pg) {
          const lock = sql(session);
          await lock.one(
            `SELECT id FROM ${table('sources')} WHERE workspace_id=${lock.p(ctx.workspaceId)} AND id=${lock.p(lease.source_id)} FOR UPDATE`,
          );
        }
        let s = sql(session),
          { p } = s;
        const active = await s.one(
          `SELECT id FROM ${table('jobs')} WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(lease.id)} AND generation=${p(lease.generation)} AND owner_id=${p(lease.owner_id)} AND state='running' AND expires_at>${p(Date.now())}${pg ? ' FOR UPDATE' : ''}`,
        );
        const current = await source(ctx, lease.source_id, session);
        if (!active || !current || current.deleted || current.version !== lease.version)
          throw failure('CONFLICT', 'Ingestion was cancelled or superseded.');
        s = sql(session);
        p = s.p;
        const stored = await s.one(
          `SELECT input,extraction,content_hash FROM ${table('versions')} WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(current.id)} AND version=${p(current.version)}`,
        );
        const contentHash = hash(JSON.stringify(extraction));
        let version = current.version;
        if (stored.extraction && stored.content_hash !== contentHash) {
          version++;
          s = sql(session);
          p = s.p;
          await s.query(
            `INSERT INTO ${table('versions')}(workspace_id,source_id,version,input,extraction,content_hash) VALUES(${p(ctx.workspaceId)},${p(current.id)},${p(version)},${p(typeof stored.input === 'string' ? stored.input : JSON.stringify(stored.input))},${p(JSON.stringify(extraction))},${p(contentHash)})`,
          );
          s = sql(session);
          p = s.p;
          await s.query(
            `UPDATE ${table('sources')} SET version=${p(version)} WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(current.id)}`,
          );
          s = sql(session);
          p = s.p;
          await s.query(
            `UPDATE ${table('jobs')} SET version=${p(version)} WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(lease.id)}`,
          );
        } else {
          s = sql(session);
          p = s.p;
          await s.query(
            `UPDATE ${table('versions')} SET extraction=${p(JSON.stringify(extraction))},content_hash=${p(contentHash)} WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(current.id)} AND version=${p(version)}`,
          );
        }
        return version;
      });
    },
    async finish(ctx, lease, chunks, model) {
      return tx(ctx, async (session) => {
        if (pg) {
          const lock = sql(session);
          await lock.one(
            `SELECT id FROM ${table('sources')} WHERE workspace_id=${lock.p(ctx.workspaceId)} AND id=${lock.p(lease.source_id)} FOR UPDATE`,
          );
        }
        let s = sql(session),
          { p } = s;
        const locked = await s.one(
          `SELECT id FROM ${table('jobs')} WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(lease.id)} AND owner_id=${p(lease.owner_id)} AND generation=${p(lease.generation)} AND state='running' AND expires_at>${p(Date.now())}${pg ? ' FOR UPDATE' : ''}`,
        );
        const current = await source(ctx, lease.source_id, session);
        if (!locked || !current || current.deleted || current.version !== lease.version)
          return false;
        s = sql(session);
        p = s.p;
        await s.query(
          `DELETE FROM ${table('chunks')} WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(current.id)}`,
        );
        for (let offset = 0; offset < chunks.length; offset += 100) {
          const batch = chunks.slice(offset, offset + 100);
          s = sql(session);
          p = s.p;
          const values = batch
            .map(
              (c) =>
                `(${p(c.id)},${p(ctx.workspaceId)},${p(current.collection_id)},${p(current.id)},${p(current.version)},${p(c.ordinal)},${p(c.content)},${p(JSON.stringify(c.location))})`,
            )
            .join(',');
          await s.query(
            `INSERT INTO ${table('chunks')}(id,workspace_id,collection_id,source_id,version,ordinal,content,location) VALUES ${values}`,
          );
          if (batch[0].vector) {
            s = sql(session);
            p = s.p;
            const vectors = batch
              .map(
                (c) =>
                  `(${p(ctx.workspaceId)},${p(c.id)},${p(model)},${p(JSON.stringify(c.vector))}${pg ? '::vector' : ''})`,
              )
              .join(',');
            await s.query(
              `INSERT INTO ${table('vectors')}(workspace_id,chunk_id,model,embedding) VALUES ${vectors}`,
            );
          }
        }
        s = sql(session);
        p = s.p;
        await s.query(
          `UPDATE ${table('sources')} SET indexed_version=${p(current.version)} WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(current.id)}`,
        );
        s = sql(session);
        p = s.p;
        await s.query(
          `UPDATE ${table('jobs')} SET state='completed',phase='ready',progress=100,expires_at=NULL WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(lease.id)}`,
        );
        return true;
      });
    },
    async fail(ctx, lease, error) {
      return tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        await s.query(
          `UPDATE ${table('jobs')} SET state='failed',phase='failed',error=${p(JSON.stringify(error))},expires_at=NULL WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(lease.id)} AND owner_id=${p(lease.owner_id)} AND generation=${p(lease.generation)} AND state='running'`,
        );
      });
    },
    async cancel(ctx, jid) {
      return tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        await s.query(
          `UPDATE ${table('jobs')} SET state='cancelled',phase='cancelled',generation=generation+1,expires_at=NULL WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(jid)} AND state IN ('queued','running')`,
        );
      });
    },
    async delete(ctx, sid, expectedFingerprint) {
      return tx(ctx, async (session) => {
        if (pg) {
          const lock = sql(session);
          await lock.one(
            `SELECT id FROM ${table('sources')} WHERE workspace_id=${lock.p(ctx.workspaceId)} AND id=${lock.p(sid)} FOR UPDATE`,
          );
        }
        const current = await source(ctx, sid, session);
        if (expectedFingerprint !== undefined && current?.fingerprint !== expectedFingerprint)
          throw failure('CONFLICT', 'Document changed during authorization; retry deletion.');
        let s = sql(session),
          { p } = s;
        const versions = await s.all(
          `SELECT input FROM ${table('versions')} WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(sid)}`,
        );
        const keys = [
          ...new Set(versions.map((v) => json(v.input).blob?.key).filter(Boolean)),
        ].sort();
        for (const key of keys) {
          if (pg) {
            const lock = sql(session);
            await lock.query(
              `SELECT pg_advisory_xact_lock(hashtextextended(${lock.p(ctx.workspaceId + ':blob:' + key)},0))`,
            );
          }
          s = sql(session);
          p = s.p;
          await s.query(
            `INSERT INTO ${table('blob_gc')}(workspace_id,key) VALUES(${p(ctx.workspaceId)},${p(key)}) ON CONFLICT DO NOTHING`,
          );
        }
        s = sql(session);
        p = s.p;
        await s.query(
          `UPDATE ${table('sources')} SET deleted=${pg ? 'true' : '1'},indexed_version=NULL,name='',metadata='{}' WHERE workspace_id=${p(ctx.workspaceId)} AND id=${p(sid)}`,
        );
        s = sql(session);
        p = s.p;
        await s.query(
          `DELETE FROM ${table('chunks')} WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(sid)}`,
        );
        s = sql(session);
        p = s.p;
        await s.query(
          `UPDATE ${table('jobs')} SET state='cancelled',phase='deleted',generation=generation+1 WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(sid)} AND state IN ('queued','running')`,
        );
        s = sql(session);
        p = s.p;
        await s.query(
          `UPDATE ${table('versions')} SET input='{}',extraction=NULL WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(sid)}`,
        );
        s = sql(session);
        p = s.p;
        await s.query(
          `UPDATE ${table('jobs')} SET diagnostics=NULL WHERE workspace_id=${p(ctx.workspaceId)} AND source_id=${p(sid)}`,
        );
      });
    },
    async pendingBlobs(ctx) {
      return tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        return s.all(
          `SELECT key FROM ${table('blob_gc')} WHERE workspace_id=${p(ctx.workspaceId)} AND state='queued' LIMIT 100`,
        );
      });
    },
    async blobReferenced(ctx, key) {
      return tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        return !!(await s.one(
          `SELECT v.source_id FROM ${table('versions')} v JOIN ${table('sources')} s ON s.id=v.source_id AND s.workspace_id=v.workspace_id WHERE v.workspace_id=${p(ctx.workspaceId)} AND s.deleted=${pg ? 'false' : '0'} AND ${pg ? "v.input->'blob'->>'key'" : "json_extract(v.input,'$.blob.key')"}=${p(key)} LIMIT 1`,
        ));
      });
    },
    async blobSources(ctx, key) {
      return tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        return (
          await s.all(
            `SELECT DISTINCT s.* FROM ${table('versions')} v JOIN ${table('sources')} s ON s.id=v.source_id AND s.workspace_id=v.workspace_id WHERE v.workspace_id=${p(ctx.workspaceId)} AND s.deleted=${pg ? 'false' : '0'} AND ${pg ? "v.input->'blob'->>'key'" : "json_extract(v.input,'$.blob.key')"}=${p(key)} ORDER BY s.id`,
          )
        ).map(decode);
      });
    },
    async blobDeleted(ctx, key) {
      return tx(ctx, async (session) => {
        const s = sql(session),
          { p } = s;
        await s.query(
          `UPDATE ${table('blob_gc')} SET state='deleted' WHERE workspace_id=${p(ctx.workspaceId)} AND key=${p(key)}`,
        );
      });
    },
    async candidates(
      ctx,
      collectionId,
      query,
      vector,
      options,
      principalIds,
      model,
      authorizedSourceIds,
    ) {
      return tx(ctx, async (session) => {
        if (pg) {
          await session.query("SET LOCAL hnsw.iterative_scan = 'strict_order'");
          await session.query('SET LOCAL hnsw.ef_search = 100');
          if (options.exact) await session.query('SET LOCAL enable_indexscan = off');
        }
        function filter(s) {
          const { p } = s;
          let where = `c.workspace_id=${p(ctx.workspaceId)} AND c.collection_id=${p(collectionId)} AND s.workspace_id=c.workspace_id AND s.deleted=${pg ? 'false' : '0'} AND c.version=s.indexed_version AND (`;
          where += pg
            ? `s.access->>'mode'='workspace' OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(s.access->'principalIds') a WHERE a.value IN (SELECT jsonb_array_elements_text(${p(JSON.stringify(principalIds))}::jsonb))))`
            : `json_extract(s.access,'$.mode')='workspace' OR EXISTS(SELECT 1 FROM json_each(s.access,'$.principalIds') a WHERE a.value IN (SELECT value FROM json_each(${p(JSON.stringify(principalIds))}))))`;
          if (options.sourceIds)
            where += ` AND s.id IN (SELECT ${pg ? 'jsonb_array_elements_text(' + p(JSON.stringify(options.sourceIds)) + '::jsonb)' : 'value FROM json_each(' + p(JSON.stringify(options.sourceIds)) + ')'})`;
          if (authorizedSourceIds)
            where += ` AND s.id IN (SELECT ${pg ? 'jsonb_array_elements_text(' + p(JSON.stringify(authorizedSourceIds)) + '::jsonb)' : 'value FROM json_each(' + p(JSON.stringify(authorizedSourceIds)) + ')'})`;
          for (const [key, value] of Object.entries(options.metadata)) {
            where += pg
              ? ` AND s.metadata->${p(key)}=${p(JSON.stringify(value))}::jsonb`
              : ` AND json_extract(s.metadata,${p('$."' + key + '"')}) IS ${p(typeof value === 'boolean' ? Number(value) : value)}`;
          }
          return where;
        }
        const fields =
          'c.id,c.source_id,c.version,c.ordinal,c.content,c.location,s.name,s.metadata';
        let lexical = [],
          semantic = [];
        if (options.mode !== 'vector') {
          const s = sql(session);
          let where = filter(s);
          if (pg) {
            const match = s.p(query);
            where += ` AND c.search @@ websearch_to_tsquery('english',${match})`;
            const rank = s.p(query);
            const limit = s.p(options.topK * 8);
            lexical = await s.all(
              `SELECT ${fields},ts_rank_cd(c.search,websearch_to_tsquery('english',${rank})) AS score FROM ${table('chunks')} c JOIN ${table('sources')} s ON s.id=c.source_id WHERE ${where} ORDER BY score DESC,c.id LIMIT ${limit}`,
            );
          } else {
            const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 20) || [];
            if (terms.length) {
              const match = terms.map((t) => '"' + t + '"').join(' OR ');
              where += ` AND c.id IN (SELECT chunk_id FROM knowledge_search WHERE knowledge_search MATCH ${s.p(match)})`;
              lexical = await s.all(
                `SELECT ${fields},0 AS score FROM ${table('chunks')} c JOIN ${table('sources')} s ON s.id=c.source_id WHERE ${where}`,
              );
              const rank = session.all(
                'SELECT chunk_id,bm25(knowledge_search) AS rank FROM knowledge_search WHERE knowledge_search MATCH ? ORDER BY rank',
                [match],
              );
              const ranks = new Map((await rank).map((r) => [r.chunk_id, -r.rank]));
              lexical = lexical
                .map((r) => ({ ...r, score: ranks.get(r.id) || 0 }))
                .sort((a, b) => b.score - a.score)
                .slice(0, options.topK * 8);
            }
          }
        }
        if (options.mode !== 'keyword') {
          const s = sql(session);
          let where = filter(s);
          where += ` AND e.workspace_id=c.workspace_id AND e.model=${s.p(model)}`;
          if (pg) {
            const distance = `e.embedding <=> ${s.p(JSON.stringify(vector))}::vector`;
            const limit = s.p(options.topK * 8);
            semantic = await s.all(
              `SELECT ${fields},1-(${distance}) AS score FROM ${table('vectors')} e JOIN ${table('chunks')} c ON c.id=e.chunk_id JOIN ${table('sources')} s ON s.id=c.source_id WHERE ${where} ORDER BY ${distance} ASC,c.id LIMIT ${limit}`,
            );
          } else {
            semantic = (
              await s.all(
                `SELECT ${fields},e.embedding FROM ${table('vectors')} e JOIN ${table('chunks')} c ON c.id=e.chunk_id JOIN ${table('sources')} s ON s.id=c.source_id WHERE ${where}`,
              )
            )
              .map(({ embedding, ...row }) => ({
                ...row,
                score: json(embedding).reduce((n, v, i) => n + v * vector[i], 0),
              }))
              .sort((a, b) => b.score - a.score)
              .slice(0, options.topK * 8);
          }
        }
        return {
          lexical: lexical.map(decode),
          semantic: semantic.map((r) => ({ ...decode(r), similarity: Number(r.score) })),
        };
      });
    },
  };
}
