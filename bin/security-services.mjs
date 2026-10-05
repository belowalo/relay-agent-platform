import { spawn } from 'node:child_process';
if (!process.env.SECURITY_TEST_DATABASE_URL) {
  console.error(
    'Security service qualification requires SECURITY_TEST_DATABASE_URL for a disposable relay_security_test database.',
  );
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ['--test', 'tests/security-services.test.js'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', () => (process.exitCode = 1));
  child.on('exit', (code) => (process.exitCode = code ?? 1));
}
