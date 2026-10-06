import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PlatformError } from './errors.js';

export const migrationDirectory = new URL('../migrations/postgres/', import.meta.url);
export async function readMigrations(directory = migrationDirectory) {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => {
      if (!/^\d{4}-[a-z0-9-]+\.sql$/.test(name))
        throw new PlatformError('VALIDATION_ERROR', 'Invalid migration filename.');
      const sql = await fs.readFile(
        directory instanceof URL ? new URL(name, directory) : path.join(directory, name),
        'utf8',
      );
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

// Dedicated migration credentials only. A single pinned client owns the entire transaction.
export async function applyMigrations(pool, directory = migrationDirectory) {
  const manifest = await readMigrations(directory);
  const client = await pool.connect();
  let failure;
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('lock_timeout', '10000', true), set_config('statement_timeout', '120000', true)",
    );
    await client.query('SELECT pg_advisory_xact_lock(782514001)');
    await client.query('CREATE SCHEMA IF NOT EXISTS relay');
    await client.query(
      'CREATE TABLE IF NOT EXISTS relay.schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = (
      await client.query('SELECT name,checksum FROM relay.schema_migrations ORDER BY name')
    ).rows;
    const byName = new Map(manifest.map((entry) => [entry.name, entry]));
    for (const entry of applied)
      if (byName.get(entry.name)?.checksum !== entry.checksum)
        throw new PlatformError('CONFLICT', 'Migration history does not match this release.');
    const existing = new Set(applied.map((entry) => entry.name));
    const added = [];
    for (const entry of manifest) {
      if (existing.has(entry.name)) continue;
      if (applied.some((previous) => previous.name > entry.name))
        throw new PlatformError('CONFLICT', 'A migration was inserted before an applied version.');
      await client.query(entry.sql);
      await client.query('INSERT INTO relay.schema_migrations(name,checksum) VALUES($1,$2)', [
        entry.name,
        entry.checksum,
      ]);
      added.push(entry.name);
    }
    await client.query('COMMIT');
    return added;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      failure = error;
    }
    throw error;
  } finally {
    client.release(failure);
  }
}
