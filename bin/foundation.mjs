import 'dotenv/config';
import pg from 'pg';
import { loadConfig, configSummary } from '../server/foundation/config.js';
import { createPostgresDatabase } from '../server/foundation/database.js';
import { createJobQueue } from '../server/foundation/queue.js';
import { applyMigrations } from '../server/foundation/migrations.js';

const command = process.argv[2] || 'config';
try {
  const config = loadConfig();
  if (command === 'config') console.log(JSON.stringify(configSummary(config), null, 2));
  else if (command === 'migrate') {
    if (!config.migrationDatabaseUrl) throw new Error();
    const pool = new pg.Pool({
      connectionString: config.migrationDatabaseUrl,
      connectionTimeoutMillis: config.databaseTimeoutMs,
    });
    pool.on('error', () => {});
    try {
      console.log(JSON.stringify({ applied: await applyMigrations(pool) }));
    } finally {
      await pool.end();
    }
  } else if (command === 'probe') {
    if (!config.databaseUrl || !config.redisUrl) throw new Error();
    const database = createPostgresDatabase(config);
    const queue = createJobQueue(config);
    try {
      await database.assertApplicationRole();
      const [postgres, redis] = await Promise.all([database.probe(), queue.probe()]);
      console.log(
        JSON.stringify({
          postgres,
          redis,
          applicationRole: 'restricted',
          runtimeIntegrated: false,
        }),
      );
    } finally {
      await Promise.allSettled([database.close(), queue.close()]);
    }
  } else throw new Error();
} catch (error) {
  console.error(
    JSON.stringify({
      code: error.code || 'FOUNDATION_COMMAND_FAILED',
      message:
        error.status && error.status < 500
          ? error.message
          : 'Foundation command failed. Check configuration, roles, and dependency availability; no dependency credentials are logged.',
    }),
  );
  process.exitCode = 1;
}
