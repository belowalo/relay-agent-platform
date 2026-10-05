import assert from 'node:assert/strict';
import pg from 'pg';
assert.equal(
  process.env.GITHUB_ACTIONS,
  'true',
  'This initializer is restricted to disposable CI services.',
);
assert.equal(new URL(process.env.FOUNDATION_TEST_DATABASE_URL).pathname, '/relay_foundation_test');
const pool = new pg.Pool({ connectionString: process.env.FOUNDATION_TEST_DATABASE_URL });
try {
  for (const name of ['relay_security_test', 'relay_knowledge_test'])
    await pool.query(`CREATE DATABASE ${name}`);
} finally {
  await pool.end();
}
