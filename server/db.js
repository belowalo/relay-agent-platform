import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const dataDir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(dataDir, 'relay.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
for (const [version, file] of [
  [2, '002-publication-snapshots.sql'],
  [3, '003-execution-clock.sql'],
  [4, '004-platform-expansion.sql'],
  [5, '005-security-recovery.sql'],
  [6, '006-runtime-controls.sql'],
  [7, '007-source-metadata.sql'],
  [8, '008-tool-approvals.sql'],
  [9, '009-calendar-schedules.sql'],
]) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT version FROM migrations WHERE version=?').get(version))
      db.exec(fs.readFileSync(new URL('./migrations/' + file, import.meta.url), 'utf8'));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const encode = (v) => JSON.stringify(v ?? null);
export const decode = (v) => (v == null ? null : JSON.parse(v));
export const all = (sql, ...args) => db.prepare(sql).all(...args.map((v) => v ?? null));
export const one = (sql, ...args) => db.prepare(sql).get(...args.map((v) => v ?? null));
export const exec = (sql, ...args) => db.prepare(sql).run(...args.map((v) => v ?? null));
let transactionDepth = 0;
export function transaction(fn) {
  const nested = transactionDepth > 0,
    savepoint = 'relay_' + transactionDepth;
  db.exec(nested ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE');
  transactionDepth++;
  try {
    const result = fn();
    db.exec(nested ? 'RELEASE ' + savepoint : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(nested ? 'ROLLBACK TO ' + savepoint : 'ROLLBACK');
    if (nested) db.exec('RELEASE ' + savepoint);
    throw error;
  } finally {
    transactionDepth--;
  }
}
const keyPath = path.join(dataDir, 'vault.key');
if (!process.env.ENCRYPTION_KEY && !fs.existsSync(keyPath)) {
  try {
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
const key = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex')
  : fs.readFileSync(keyPath);
if (key.length !== 32) throw new Error('ENCRYPTION_KEY must contain 64 hex characters');
export function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), encrypted].map((v) => v.toString('base64')).join('.');
}
export function decrypt(value) {
  const [iv, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64'));
  const c = crypto.createDecipheriv('aes-256-gcm', key, iv);
  c.setAuthTag(tag);
  return Buffer.concat([c.update(data), c.final()]).toString('utf8');
}
export const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
export const safeError = (e) =>
  String(e?.message || e)
    .replace(/(?:sk-[\w-]+|Bearer\s+\S+)/gi, '[redacted]')
    .slice(0, 500);
export function redact(wid, value) {
  if (value == null || !wid) return value;
  const secrets = all('SELECT secret FROM connections WHERE workspace_id=?', wid)
    .map((row) => decrypt(row.secret))
    .filter((secret) => secret.length >= 4);
  function visit(item) {
    if (typeof item === 'string') {
      for (const secret of secrets) item = item.replaceAll(secret, '[redacted]');
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, visit(val)]));
    return item;
  }
  return visit(value);
}
export function audit(workspace, user, action, target) {
  exec('INSERT INTO audit VALUES(?,?,?,?,?,?)', id(), workspace, user, action, target, now());
}
