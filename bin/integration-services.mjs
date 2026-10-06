import { spawn } from 'node:child_process';
if (
  !process.env.FOUNDATION_TEST_DATABASE_URL ||
  !process.env.FOUNDATION_TEST_REDIS_URL ||
  !process.env.INTEGRATION_S3_ENDPOINT ||
  !process.env.INTEGRATION_S3_ACCESS_KEY ||
  !process.env.INTEGRATION_S3_SECRET_KEY
) {
  console.error(
    'Production composition checks require disposable PostgreSQL/pgvector, Redis and S3 configuration. No service qualification was performed.',
  );
  process.exitCode = 1;
} else {
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      'tests/production-import-services.test.js',
      'tests/production-composition-services.test.js',
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  child.on('error', () => {
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
