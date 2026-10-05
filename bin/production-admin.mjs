// Administrative provisioning runs with migration credentials on the private
// network. No public route can invoke it; secrets are read from mounted files.
import fs from 'node:fs/promises';
import pg from 'pg';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
const scrypt = promisify(crypto.scrypt);
let pool;
try {
  if (process.argv[2] !== 'create-owner') throw new Error('Unsupported admin command');
  const email = z.email().parse(process.env.PROVISION_EMAIL).toLowerCase(),
    name = z
      .string()
      .min(1)
      .max(80)
      .parse(process.env.PROVISION_NAME || 'Workspace owner');
  const password = z
    .string()
    .min(10)
    .max(200)
    .parse((await fs.readFile(process.env.PROVISION_PASSWORD_FILE, 'utf8')).trim());
  const salt = crypto.randomBytes(16).toString('hex'),
    digest = salt + ':' + (await scrypt(password, salt, 64)).toString('hex');
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID();
  pool = new pg.Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    password: (await fs.readFile(process.env.PGPASSWORD_FILE, 'utf8')).trim(),
  });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      'INSERT INTO relay.security_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
      [accountId, email, name, digest],
    );
    await c.query('INSERT INTO relay.workspaces(id,name,created_at) VALUES($1,$2,$3)', [
      workspaceId,
      process.env.PROVISION_WORKSPACE || 'Company workspace',
      new Date().toISOString(),
    ]);
    await c.query('INSERT INTO relay.security_workspaces(workspace_id) VALUES($1)', [workspaceId]);
    await c.query("INSERT INTO relay.security_memberships VALUES($1,$2,'owner')", [
      workspaceId,
      accountId,
    ]);
    await c.query(
      "INSERT INTO relay.security_identity_audit(id,user_id,action,request_id) VALUES($1,$2,'account.provisioned',$3)",
      [crypto.randomUUID(), accountId, crypto.randomUUID()],
    );
    await c.query('COMMIT');
    console.log(
      JSON.stringify({
        provisioned: true,
        workspaceId,
        accountId,
        passwordPrinted: false,
        budgetConfigurationRequired: true,
      }),
    );
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
} catch {
  console.error(
    JSON.stringify({
      code: 'PROVISIONING_FAILED',
      message: 'Check private provisioning files and duplicate account status.',
    }),
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
