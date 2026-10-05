import { spawn } from 'node:child_process';
if (!process.env.KNOWLEDGE_TEST_DATABASE_URL) {
  console.error(
    'KNOWLEDGE_TEST_DATABASE_URL is required (disposable relay_knowledge_test database with pgvector >= 0.8). No production qualification was performed.',
  );
  process.exit(1);
}
const child = spawn(process.execPath, ['--test', 'tests/knowledge-postgres.test.js'], {
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code) => process.exit(code ?? 1));
