import { spawn } from 'node:child_process';
if (!process.env.FOUNDATION_TEST_DATABASE_URL || !process.env.FOUNDATION_TEST_REDIS_URL) {
  console.error(
    'Service qualification requires FOUNDATION_TEST_DATABASE_URL and FOUNDATION_TEST_REDIS_URL for disposable test services.',
  );
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ['--test', 'tests/foundation-services.test.js'], {
    stdio: 'inherit',
  });
  child.on('error', () => {
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
