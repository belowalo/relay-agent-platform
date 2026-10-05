import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { decode, json, argumentHash, fail } from './core.js';
const manifest = JSON.parse(
  fs.readFileSync(new URL('./import-manifest.json', import.meta.url), 'utf8'),
);
const parentColumns = {
  versions: 'workflow_id',
  steps: 'run_id',
  events: 'run_id',
  actions: 'run_id',
  tool_approvals: 'step_id',
  evaluation_cases: 'evaluation_id',
  prompt_versions: 'prompt_id',
};
export function readImport(source, { legacyKey } = {}) {
  // Require a quiescent backup. Hashing only the main file of a live WAL database is not auditable.
  if (fs.existsSync(source + '-wal')) fail('IMPORT_REQUIRES_QUIESCENT_COPY');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('BEGIN');
    if (
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      fail('INVALID_IMPORT');
    if (Number(db.prepare('SELECT max(version) AS n FROM migrations').get().n) !== 9)
      fail('IMPORT_VERSION');
    const tables = new Map(
      manifest.map(({ name, columns }) => [
        name,
        db
          .prepare(`SELECT ${columns.join(',')} FROM "${name}"`)
          .all()
          .map((r) => ({ ...r })),
      ]),
    );
    const indices = new Map(
      [...tables].map(([name, rows]) => [name, new Map(rows.map((r) => [r.id, r]))]),
    );
    for (const { name, parent } of manifest)
      for (const row of tables.get(name)) {
        if (parent) {
          const p = indices.get(parent).get(row[parentColumns[name]]);
          if (!p) fail('IMPORT_REFERENCE');
          if (row.workspace_id && row.workspace_id !== p.workspace_id)
            fail('IMPORT_TENANT_MISMATCH');
          row.workspace_id = p.workspace_id;
        }
        if (row.workspace_id && !indices.get('workspaces').has(row.workspace_id))
          fail('IMPORT_TENANT_MISMATCH');
        if (name === 'actions')
          row.status =
            row.status === 'completed'
              ? 'succeeded'
              : ['prepared', 'succeeded', 'failed', 'uncertain'].includes(row.status)
                ? row.status
                : row.side_effect
                  ? 'uncertain'
                  : 'failed';
        if (name === 'tool_approvals') {
          decode(row.input);
          row.input_hash = argumentHash(decode(row.input));
        }
        if (name === 'connections' && row.secret) {
          if (!legacyKey || legacyKey.length !== 32) fail('LEGACY_KEY_REQUIRED');
          const [iv, tag, cipher] = row.secret.split('.').map((v) => Buffer.from(v, 'base64'));
          const decipher = crypto.createDecipheriv('aes-256-gcm', legacyKey, iv);
          decipher.setAuthTag(tag);
          decipher.update(cipher);
          decipher.final();
        }
      }
    // Validate every tenant-bound foreign key before any destination writes.
    for (const { name, fks } of manifest)
      for (const row of tables.get(name))
        for (const fk of fks) {
          if (row[fk.from] == null || fk.to !== 'id') continue;
          const parent = indices.get(fk.table)?.get(row[fk.from]);
          if (
            !parent ||
            (parent.workspace_id && row.workspace_id && parent.workspace_id !== row.workspace_id)
          )
            fail('IMPORT_TENANT_MISMATCH');
        }
    const sequences = new Map();
    for (const row of tables.get('events').sort((a, b) => Number(a.id) - Number(b.id))) {
      row.sequence = (sequences.get(row.run_id) || 0) + 1;
      sequences.set(row.run_id, row.sequence);
    }
    for (const row of tables.get('runs')) {
      row.event_seq = sequences.get(row.id) || 0;
      row.lease_owner = null;
      row.lease_until = null;
      row.active_since = null;
    }
    const counts = Object.fromEntries([...tables].map(([name, rows]) => [name, rows.length]));
    return {
      tables,
      counts,
      sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
      secretCompatibility: 'legacy envelopes verified, preserved; security-owned rewrap required',
      haltedRuns: tables
        .get('runs')
        .filter((r) => ['queued', 'running', 'waiting'].includes(r.status)).length,
    };
  } finally {
    db.close();
  }
}
export async function importToPostgres(pool, source, { dryRun = true, legacyKey } = {}) {
  const input = readImport(source, { legacyKey });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782514002)');
    for (const { name } of manifest) {
      const count = (await client.query(`SELECT count(*) AS n FROM relay.${name}`)).rows[0];
      if (Number(count.n)) fail('IMPORT_DESTINATION_NOT_EMPTY');
    }
    if (!dryRun) {
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const { name } of manifest)
        for (const row of input.tables.get(name)) {
          const cols = Object.keys(row);
          await client.query(
            `INSERT INTO relay.${name}(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')})`,
            cols.map((c) => row[c]),
          );
        }
      await client.query(
        "SELECT setval(pg_get_serial_sequence('relay.events','id'),greatest(coalesce((SELECT max(id) FROM relay.events),0),1),(SELECT count(*)>0 FROM relay.events))",
      );
      for (const { name } of manifest) {
        const count = (await client.query(`SELECT count(*) AS n FROM relay.${name}`)).rows[0];
        if (Number(count.n) !== input.counts[name]) fail('IMPORT_COUNT_MISMATCH');
      }
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return {
      dryRun,
      counts: input.counts,
      sourceSha256: input.sourceSha256,
      secretCompatibility: input.secretCompatibility,
      haltedRuns: input.haltedRuns,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
