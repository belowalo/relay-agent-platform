import path from 'node:path';
import { PlatformError } from './errors.js';

const fail = (name) => {
  throw new PlatformError('VALIDATION_ERROR', `Invalid or missing configuration: ${name}`);
};
function integer(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) fail(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(name);
  return value;
}
function boolean(env, name, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback;
  if (!['true', 'false'].includes(env[name])) fail(name);
  return env[name] === 'true';
}
function url(value, name, protocols) {
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol) || !parsed.hostname || parsed.hash) fail(name);
    return parsed;
  } catch {
    fail(name);
  }
}

export function loadConfig(env = process.env) {
  const profile = env.RELAY_PROFILE || 'local';
  if (!['local', 'production'].includes(profile)) fail('RELAY_PROFILE');
  const role = env.ENGINE_ROLE || (profile === 'production' ? 'api' : 'embedded');
  if (!['api', 'worker', 'embedded'].includes(role)) fail('ENGINE_ROLE');
  if (profile === 'production' && role === 'embedded') fail('ENGINE_ROLE');
  const config = {
    profile,
    role,
    host: env.HOST || '127.0.0.1',
    port: integer(env, 'PORT', 4311, 1, 65535),
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    databaseUrl: env.DATABASE_URL,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL,
    redisUrl: env.REDIS_URL,
    origin: env.PUBLIC_ORIGIN,
    cookieSecure: boolean(env, 'COOKIE_SECURE', profile === 'production'),
    allowPrivateNetwork: boolean(env, 'ALLOW_PRIVATE_NETWORK', false),
    encryptionKey: env.ENCRYPTION_KEY,
    encryptionKeyId: env.ENCRYPTION_KEY_ID || 'primary',
    databasePoolMax: integer(env, 'DATABASE_POOL_MAX', 10, 1, 100),
    databaseTimeoutMs: integer(env, 'DATABASE_TIMEOUT_MS', 5000, 100, 60000),
    statementTimeoutMs: integer(env, 'DATABASE_STATEMENT_TIMEOUT_MS', 15000, 100, 300000),
    workerConcurrency: integer(env, 'WORKER_CAPACITY', 8, 1, 128),
    queuePrefix: env.QUEUE_PREFIX || 'relay',
    shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 30000, 1000, 120000),
  };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.queuePrefix)) fail('QUEUE_PREFIX');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.encryptionKeyId)) fail('ENCRYPTION_KEY_ID');
  if (config.databaseUrl) url(config.databaseUrl, 'DATABASE_URL', ['postgres:', 'postgresql:']);
  if (config.migrationDatabaseUrl)
    url(config.migrationDatabaseUrl, 'MIGRATION_DATABASE_URL', ['postgres:', 'postgresql:']);
  if (config.redisUrl) {
    const parsed = url(config.redisUrl, 'REDIS_URL', ['redis:', 'rediss:']);
    if (parsed.pathname && !/^\/\d+$/.test(parsed.pathname)) fail('REDIS_URL');
  }
  if (config.origin) {
    const parsed = url(config.origin, 'PUBLIC_ORIGIN', ['http:', 'https:']);
    if (parsed.username || parsed.password || parsed.search || parsed.pathname !== '/')
      fail('PUBLIC_ORIGIN');
    config.origin = parsed.origin;
    if (profile === 'production' && parsed.protocol !== 'https:') fail('PUBLIC_ORIGIN');
  }
  if (config.encryptionKey && !/^[a-fA-F0-9]{64}$/.test(config.encryptionKey))
    fail('ENCRYPTION_KEY');
  if (profile === 'production') {
    if (!config.databaseUrl) fail('DATABASE_URL');
    if (!config.redisUrl) fail('REDIS_URL');
    if (!config.origin) fail('PUBLIC_ORIGIN');
    if (!config.encryptionKey) fail('ENCRYPTION_KEY');
    if (!config.cookieSecure) fail('COOKIE_SECURE');
    if (config.allowPrivateNetwork) fail('ALLOW_PRIVATE_NETWORK');
  }
  return Object.freeze(config);
}

export function configSummary(config) {
  // Never serialize the complete config: URLs can contain database/Redis passwords.
  return {
    profile: config.profile,
    role: config.role,
    database: config.profile === 'production' ? 'postgresql' : 'sqlite',
    queue: config.profile === 'production' ? 'bullmq' : 'local-engine',
    vectors: config.profile === 'production' ? 'pgvector' : 'sqlite-scan',
    configured: {
      database: Boolean(config.databaseUrl),
      redis: Boolean(config.redisUrl),
      publicOrigin: Boolean(config.origin),
      encryptionKey: Boolean(config.encryptionKey),
    },
  };
}

export function assertLegacyEntryPoint(config) {
  if (config.profile !== 'local')
    throw new PlatformError(
      'DEPENDENCY_UNAVAILABLE',
      'The legacy SQLite entry point cannot run RELAY_PROFILE=production. Complete the runtime integration first.',
    );
}
