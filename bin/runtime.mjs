import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';
import { startProduction } from '../server/runtime/bootstrap.js';
import { importToPostgres } from '../server/runtime/import.js';
import { createIntegratedImport } from '../server/production/import.js';
import { createSecretVault } from '../server/foundation/secrets.js';
const command = process.argv[2] || 'start';
try {
  if (command === 'import') {
    if (!process.env.MIGRATION_DATABASE_URL || !process.argv.includes('--source'))
      throw new Error('IMPORT_CONFIGURATION_REQUIRED');
    const source = process.argv[process.argv.indexOf('--source') + 1];
    const keyFile = process.argv.includes('--legacy-key-file')
      ? process.argv[process.argv.indexOf('--legacy-key-file') + 1]
      : null;
    const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    try {
      console.log(
        JSON.stringify(
          await importToPostgres(pool, source, {
            dryRun: !process.argv.includes('--apply'),
            legacyKey: keyFile ? fs.readFileSync(keyFile) : undefined,
            integrate: process.env.ENCRYPTION_KEY
              ? createIntegratedImport(
                  createSecretVault(
                    { [process.env.ENCRYPTION_KEY_ID || 'primary']: process.env.ENCRYPTION_KEY },
                    process.env.ENCRYPTION_KEY_ID || 'primary',
                  ),
                )
              : undefined,
          }),
        ),
      );
    } finally {
      await pool.end();
    }
  } else if (command === 'start') {
    const runtime = await startProduction();
    console.log('Relay production runtime started.');
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () =>
        runtime.close().then(
          () => process.exit(0),
          () => process.exit(1),
        ),
      );
  } else throw new Error('UNKNOWN_RUNTIME_COMMAND');
} catch (error) {
  console.error(
    'Runtime command failed: ' + (error.code || 'RUNTIME_CONFIGURATION_OR_DEPENDENCY_ERROR'),
  );
  process.exitCode = 1;
}
