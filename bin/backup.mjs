import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createS3 } from '../server/observability/s3.js';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
async function run(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Backup subprocess failed')),
    );
  });
}
async function secret(name) {
  return (await fs.readFile(process.env[name + '_FILE'], 'utf8')).trim();
}
export async function backupCommand(command, filename) {
  const directory = path.resolve(process.env.BACKUP_DIRECTORY || '/backups');
  if (!/^[a-zA-Z0-9_-]+\.relay-backup$/.test(filename || ''))
    throw new Error('Invalid backup name');
  const output = path.join(directory, filename);
  const key = await secret('BACKUP_KEY');
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid backup key');
  const password = await secret('PGPASSWORD');
  const pgEnv = { ...process.env, PGPASSWORD: password };
  const s3 = createS3({
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET,
    accessKey: await secret('S3_ACCESS_KEY_ID'),
    secretKey: await secret('S3_SECRET_ACCESS_KEY'),
  });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-backup-'));
  const started = Date.now();
  try {
    if (command === 'create') {
      // Require a quiesced write boundary: stop API, workers, dispatchers and ingestion before invoking.
      if (process.env.BACKUP_QUIESCED !== 'true') throw new Error('Quiesced backup required');
      await run(
        'pg_dump',
        ['--format=custom', '--no-owner', '--no-acl', '--file', path.join(temp, 'database.dump')],
        pgEnv,
      );
      if ((await fs.stat(path.join(temp, 'database.dump'))).size > 256 * 1024 * 1024)
        throw new Error('Database backup exceeds support limit');
      const database = await fs.readFile(path.join(temp, 'database.dump'));
      const objects = [];
      let total = database.length;
      for (const objectKey of await s3.list()) {
        const body = await s3.get(objectKey);
        total += body.length;
        if (total > 256 * 1024 * 1024)
          throw new Error('Backup exceeds 256 MiB qualification support limit');
        objects.push({ key: objectKey, sha256: sha(body), body: body.toString('base64') });
      }
      const keyring = JSON.parse(await fs.readFile(process.env.VAULT_KEYRING_FILE, 'utf8'));
      if (
        !Object.keys(keyring).length ||
        !Object.entries(keyring).every(
          ([id, key]) => /^[a-zA-Z0-9_-]{1,64}$/.test(id) && /^[a-f0-9]{64}$/.test(key),
        )
      )
        throw new Error('Invalid vault keyring');
      const payload = Buffer.from(
        JSON.stringify({
          version: 1,
          createdAt: new Date(started).toISOString(),
          release: process.env.RELEASE_COMMIT || 'unspecified',
          database: database.toString('base64'),
          databaseSha256: sha(database),
          keyring,
          objects,
        }),
      );
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
      cipher.setAAD(Buffer.from('relay-backup-v1'));
      const encrypted = Buffer.concat([
        Buffer.from('RELAYBK1'),
        iv,
        cipher.update(payload),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(output + '.partial', encrypted, { mode: 0o600, flag: 'wx' });
      await fs.rename(output + '.partial', output);
      await fs.writeFile(output + '.sha256', sha(encrypted) + '\n', { mode: 0o600 });
      return {
        command,
        bytes: encrypted.length,
        objects: objects.length,
        elapsedMs: Date.now() - started,
        createdAt: new Date(started).toISOString(),
      };
    }
    if (!['verify', 'restore'].includes(command)) throw new Error('Invalid command');
    if ((await fs.stat(output)).size > 400 * 1024 * 1024)
      throw new Error('Backup exceeds support limit');
    const encrypted = await fs.readFile(output);
    if (encrypted.length > 400 * 1024 * 1024 || encrypted.subarray(0, 8).toString() !== 'RELAYBK1')
      throw new Error('Invalid backup');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key, 'hex'),
      encrypted.subarray(8, 20),
    );
    decipher.setAAD(Buffer.from('relay-backup-v1'));
    decipher.setAuthTag(encrypted.subarray(-16));
    const value = JSON.parse(
      Buffer.concat([decipher.update(encrypted.subarray(20, -16)), decipher.final()]).toString(),
    );
    const database = Buffer.from(value.database, 'base64');
    if (
      value.version !== 1 ||
      sha(database) !== value.databaseSha256 ||
      !Array.isArray(value.objects)
    )
      throw new Error('Backup integrity failed');
    for (const object of value.objects)
      if (sha(Buffer.from(object.body, 'base64')) !== object.sha256)
        throw new Error('Blob integrity failed');
    if (command === 'restore') {
      if (process.env.RESTORE_ALLOW_EMPTY_TARGET !== 'true')
        throw new Error('Explicit empty-target restore required');
      if ((await s3.list()).length !== 0) throw new Error('Restore bucket must be empty');
      // No --clean: existing conflicting schema objects cause failure; target provisioning is operator-owned.
      await fs.writeFile(path.join(temp, 'database.dump'), database, { mode: 0o600 });
      await run(
        'pg_restore',
        [
          '--exit-on-error',
          '--single-transaction',
          '--no-owner',
          '--no-acl',
          '--dbname',
          process.env.PGDATABASE,
          path.join(temp, 'database.dump'),
        ],
        pgEnv,
      );
      for (const object of value.objects) {
        const body = Buffer.from(object.body, 'base64');
        await s3.put(object.key, body);
        if (sha(await s3.get(object.key)) !== object.sha256)
          throw new Error('Restored object verification failed');
      }
      await fs.writeFile(
        path.join(directory, filename + '.restored-keyring'),
        JSON.stringify(value.keyring),
        { mode: 0o600, flag: 'wx' },
      );
    }
    return {
      command,
      objects: value.objects.length,
      elapsedMs: Date.now() - started,
      backupCreatedAt: value.createdAt,
      release: value.release,
    };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1]?.endsWith('backup.mjs')) {
  try {
    console.log(JSON.stringify(await backupCommand(process.argv[2], process.argv[3])));
  } catch {
    console.error(
      JSON.stringify({
        code: 'BACKUP_COMMAND_FAILED',
        message:
          'Check private configuration, backup integrity, target isolation, and support limits.',
      }),
    );
    process.exitCode = 1;
  }
}
