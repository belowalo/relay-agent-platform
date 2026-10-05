import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkURL, safeFetch } from '../server/network.js';
test('private endpoints and embedded credentials are rejected by default', async () => {
  await assert.rejects(() => checkURL('http://127.0.0.1:8888'), /Private network/);
  await assert.rejects(() => checkURL('http://[::1]:8888'), /Private network/);
  await assert.rejects(
    () => checkURL('http://user:secret@example.com'),
    /without embedded credentials/,
  );
  await assert.rejects(() => checkURL('file:///tmp/example'), /HTTP or HTTPS/);
  assert.equal((await checkURL('http://127.0.0.1:8888', true)).hostname, '127.0.0.1');
});
