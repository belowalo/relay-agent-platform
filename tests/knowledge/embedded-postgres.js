import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { createKnowledgeRepository } from '../../server/knowledge/repository.js';
import { fixtureSecurity } from './helpers.js';
// Actual embedded PostgreSQL, restricted role + tenant RLS; synthetic runtime fixture tables.
export async function embeddedPostgres() {
  const pg = new PGlite({ extensions: { vector } });
  await pg.exec('CREATE SCHEMA relay;');
  await pg.exec(
    await fs.readFile(
      new URL('../../server/migrations/postgres/0001-foundation.sql', import.meta.url),
      'utf8',
    ),
  );
  await pg.exec(
    'CREATE TABLE relay.workspaces(id text PRIMARY KEY); CREATE TABLE relay.collections(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES relay.workspaces(id));',
  );
  await pg.exec(
    await fs.readFile(
      new URL('../../server/migrations/postgres/0300-knowledge.sql', import.meta.url),
      'utf8',
    ),
  );
  await pg.exec(
    "INSERT INTO relay.workspaces VALUES('alpha'); INSERT INTO relay.collections VALUES('manual','alpha'); CREATE ROLE knowledge_app; GRANT USAGE ON SCHEMA relay TO knowledge_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA relay TO knowledge_app;",
  );
  let lastVectorQuery;
  const database = {
    transaction(ctx, callback) {
      return pg.transaction(async (t) => {
        await t.exec('SET LOCAL ROLE knowledge_app');
        await t.query("SELECT set_config('relay.workspace_id',$1,true)", [ctx.workspaceId]);
        return callback({
          context: ctx,
          query: async (q, v = []) => {
            const r = await t.query(q, v);
            return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
          },
          one: async (q, v = []) => (await t.query(q, v)).rows[0] || null,
          all: async (q, v = []) => {
            if (q.includes('FROM relay.knowledge_vectors e')) lastVectorQuery = { q, v };
            return (await t.query(q, v)).rows;
          },
        });
      });
    },
  };
  const repository = createKnowledgeRepository(database);
  return {
    pg,
    repository,
    security: fixtureSecurity(),
    pipeline: { upsert: repository.upsert },
    async explainVector(context) {
      const { q, v } = lastVectorQuery;
      return database.transaction(
        context,
        async (s) => (await s.all('EXPLAIN (FORMAT JSON) ' + q, v))[0]['QUERY PLAN'],
      );
    },
    close: () => pg.close(),
  };
}
