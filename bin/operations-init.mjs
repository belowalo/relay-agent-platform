import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2] || '.operations-private');
const secrets = path.join(root, 'secrets');
const backups = path.join(root, 'backups');
await fs.mkdir(secrets, { recursive: true, mode: 0o700 });
await fs.mkdir(backups, { recursive: true, mode: 0o700 });
await fs.mkdir(path.join(root, 'models'), { recursive: true, mode: 0o755 });
const generate = () => crypto.randomBytes(32).toString('hex');
const values = {
  database_password: generate(),
  app_database_password: generate(),
  identity_database_password: generate(),
  rate_database_password: generate(),
  dispatch_database_password: generate(),
  parser_token: generate(),
  redis_password: generate(),
  encryption_key: generate(),
  metrics_token: generate(),
  s3_access_key: 'relay' + generate().slice(0, 16),
  s3_secret_key: generate(),
  backup_key: generate(),
};
values.app_database_url = `postgresql://relay_app:${values.app_database_password}@database:5432/relay`;
values.identity_database_url = `postgresql://relay_identity:${values.identity_database_password}@database:5432/relay`;
values.rate_database_url = `postgresql://relay_rate:${values.rate_database_password}@database:5432/relay`;
values.dispatch_database_url = `postgresql://relay_dispatch:${values.dispatch_database_password}@database:5432/relay`;
values.redis_url = `redis://:${values.redis_password}@queue:6379/0`;
values.vault_keyring = JSON.stringify({ primary: values.encryption_key });
// Compose file secrets retain host ownership. The parent directory is private; mounted files must be readable by each non-root service UID.
for (const [name, value] of Object.entries(values))
  await fs.writeFile(path.join(secrets, name), value + '\n', { mode: 0o444, flag: 'wx' });
await fs.writeFile(
  path.join(root, 'production.env'),
  `SECRETS_PATH=${secrets.replaceAll('\\', '/')}\nBACKUP_PATH=${backups.replaceAll('\\', '/')}\nBACKUP_UID=${process.getuid?.() || 1000}\nBACKUP_GID=${process.getgid?.() || 1000}\nPUBLIC_ORIGIN=https://relay.example.com\nRELAY_DOMAIN=relay.example.com\nQUEUE_PREFIX=relay-production\nMODELS_PATH=${path.join(root, 'models').replaceAll('\\', '/')}\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  JSON.stringify({
    initialized: true,
    secretValuesPrinted: false,
    environmentFile: path.join(root, 'production.env'),
  }),
);
