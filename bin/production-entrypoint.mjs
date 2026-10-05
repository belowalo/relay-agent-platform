import fs from 'node:fs/promises';
import { loadConfig } from '../server/foundation/config.js';

try {
  for (const name of [
    'DATABASE_URL',
    'REDIS_URL',
    'ENCRYPTION_KEY',
    'METRICS_TOKEN',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'IDENTITY_DATABASE_URL',
    'RATE_DATABASE_URL',
    'RUNTIME_DISPATCH_DATABASE_URL',
    'PARSER_TOKEN',
  ]) {
    if (process.env[`${name}_FILE`]) {
      if (process.env[name]) throw new Error();
      process.env[name] = (await fs.readFile(process.env[`${name}_FILE`], 'utf8')).trim();
    }
  }
  const config = loadConfig();
  if (
    config.profile !== 'production' ||
    process.env.MIGRATION_DATABASE_URL ||
    !process.env.METRICS_TOKEN ||
    process.env.METRICS_TOKEN.length < 32
  )
    throw new Error();
  if (
    !process.env.S3_ENDPOINT ||
    !process.env.S3_BUCKET ||
    !process.env.S3_ACCESS_KEY_ID ||
    !process.env.S3_SECRET_ACCESS_KEY
  )
    throw new Error();
  const endpoint = new URL(process.env.S3_ENDPOINT);
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search
  )
    throw new Error();
  if (endpoint.protocol !== 'https:' && process.env.S3_INTERNAL_NETWORK !== 'true')
    throw new Error();
  const target = process.argv[2];
  if (target) {
    if (target !== 'qualification-service' || process.env.OPERATIONS_QUALIFICATION !== 'true')
      throw new Error();
    await import('../deploy/qualification/service.mjs');
  } else await import(config.role === 'worker' ? '../server/worker.js' : '../server/index.js');
} catch {
  console.error(
    JSON.stringify({ event: 'startup_rejected', code: 'CONFIGURATION_OR_RUNTIME_UNAVAILABLE' }),
  );
  process.exitCode = 1;
}
