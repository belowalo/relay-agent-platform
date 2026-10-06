import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { applyMigrations } from '../server/foundation/migrations.js';
import { createProductionMemory } from '../server/production/memory.js';
test('same-agent and same-conversation memories stay within the writer principal; old unowned memories are quarantined', async () => {
  const pg = new PGlite({ extensions: { vector } });
  const query = async (sql, args) =>
    args?.length ? pg.query(sql, args) : { rows: (await pg.exec(sql)).at(-1)?.rows || [] };
  try {
    await applyMigrations({ connect: async () => ({ query, release() {} }) });
    await pg.query(
      "INSERT INTO relay.workspaces(id,name,created_at) VALUES('tenant','Tenant','now')",
    );
    await pg.query(
      "INSERT INTO relay.memories(id,workspace_id,agent_id,conversation_id,content,created_at) VALUES('legacy','tenant','agent','conversation','legacy private text','now')",
    );
    let revoked = false;
    const memory = createProductionMemory({
      database: {
        transaction: (_ctx, fn) => fn({ query, all: async (s, a) => (await query(s, a)).rows }),
      },
      security: {
        authorize: async () => {
          if (revoked) throw new Error('revoked');
        },
      },
    });
    const context = (kind, id) => ({
        workspaceId: 'tenant',
        actor: { kind, id },
        requestId: 'test',
      }),
      q = { agentId: 'agent', conversationId: 'conversation' };
    await memory.write(context('user', 'alice'), { ...q, content: 'Alice private text' });
    await memory.write(context('application', 'token'), {
      ...q,
      content: 'Application private text',
    });
    assert.deepEqual(await memory.read(context('user', 'bob'), q), []);
    assert.equal(
      (await memory.read(context('user', 'alice'), q))[0].content,
      '"Alice private text"',
    );
    assert.equal(
      (await memory.read(context('application', 'token'), q))[0].content,
      '"Application private text"',
    );
    assert.deepEqual(await memory.read(context('application', 'rotated-token'), q), []);
    await pg.exec(
      "CREATE ROLE memory_reader;GRANT USAGE ON SCHEMA relay TO memory_reader;GRANT SELECT,INSERT ON relay.memories TO memory_reader;SET ROLE memory_reader;SELECT set_config('relay.workspace_id','tenant',false);",
    );
    assert.deepEqual((await pg.query('SELECT content FROM relay.memories')).rows, []);
    await pg.query("SELECT set_config('relay.principal','user:alice',false)");
    assert.deepEqual((await pg.query('SELECT content FROM relay.memories')).rows, [
      { content: '"Alice private text"' },
    ]);
    await pg.query("SELECT set_config('relay.principal','user:bob',false)");
    assert.deepEqual((await pg.query('SELECT content FROM relay.memories')).rows, []);
    await assert.rejects(
      pg.query(
        "INSERT INTO relay.memories(id,workspace_id,agent_id,content,created_at,principal) VALUES('forged','tenant','agent','forged','now','user:alice')",
      ),
    );
    await pg.exec('RESET ROLE;');
    revoked = true;
    await assert.rejects(memory.read(context('user', 'alice'), q), /revoked/);
    await assert.rejects(
      memory.write(context('user', 'alice'), { ...q, content: 'new' }),
      /revoked/,
    );
  } finally {
    await pg.close();
  }
});
