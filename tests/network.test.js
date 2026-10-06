import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkURL,
  safeFetch,
  isPrivateAddress,
  createOutboundPolicy,
  responseText,
  assertCredentialDestination,
} from '../server/network.js';
import http from 'node:http';
import dns from 'node:dns/promises';
test('credentials cannot be sent to another origin, port or endpoint prefix', () => {
  assertCredentialDestination('https://provider.test/v1', 'https://provider.test/v1/search');
  for (const url of [
    'https://attacker.test/v1',
    'http://provider.test/v1',
    'https://provider.test:444/v1',
    'https://provider.test/v11',
    'https://provider.test/v1/../other',
  ])
    assert.throws(
      () => assertCredentialDestination('https://provider.test/v1', url),
      /destination/,
    );
});
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
test('non-global IPv4/IPv6, production exceptions, metadata and serialized policy bypasses', async () => {
  for (const ip of [
    '127.0.0.1',
    '100.64.1.1',
    '169.254.169.254',
    '198.18.0.1',
    '203.0.113.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111'])
    assert.equal(isPrivateAddress(ip), false, ip);
  const previous = process.env.NODE_ENV,
    legacy = process.env.ALLOW_PRIVATE_NETWORK;
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_PRIVATE_NETWORK = 'true';
  try {
    await assert.rejects(() => checkURL('http://127.0.0.1:8888', true), /administrator/);
    const policy = createOutboundPolicy({
      origins: ['http://127.0.0.1:8888'],
      privateCidrs: ['127.0.0.1/32'],
    });
    await checkURL('http://127.0.0.1:8888', policy);
    await assert.rejects(() => checkURL('http://127.0.0.1:8889', policy), /administrator/);
    await assert.rejects(
      () => checkURL('http://127.0.0.1:8888', { permits: () => true }),
      /administrator/,
    );
    await assert.rejects(
      () =>
        checkURL(
          'http://169.254.169.254',
          createOutboundPolicy({
            origins: ['http://169.254.169.254'],
            privateCidrs: ['169.254.0.0/16'],
          }),
        ),
      /administrator/,
    );
    for (const host of ['[::ffff:a9fe:a9fe]', '[fd00:ec2::254]', '100.100.100.200', '[fe80::1]']) {
      const origin = 'http://' + host;
      await assert.rejects(
        () =>
          checkURL(
            origin,
            createOutboundPolicy({
              origins: [origin],
              privateCidrs: ['0.0.0.0/0', '::/0'],
            }),
          ),
        /administrator/,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    if (legacy === undefined) delete process.env.ALLOW_PRIVATE_NETWORK;
    else process.env.ALLOW_PRIVATE_NETWORK = legacy;
  }
});
test('DNS rebinding is checked again before connection', async () => {
  const original = dns.lookup;
  let count = 0;
  dns.lookup = async () => [{ address: ++count === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  try {
    await assert.rejects(() => safeFetch('http://fixture.test'), /administrator/);
  } finally {
    dns.lookup = original;
  }
  assert.equal(count, 2);
});
test('redirects cannot forward custom credentials or bodies; response parsing is bounded', async () => {
  let received = 0;
  const sink = http.createServer((req, res) => {
    received++;
    res.end('leaked');
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const source = http.createServer((req, res) => {
    if (req.url === '/large') return res.end('123456789');
    res.writeHead(307, { Location: `http://127.0.0.1:${sink.address().port}/sink` });
    res.end();
  });
  await new Promise((r) => source.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${source.address().port}`;
    await assert.rejects(
      () => safeFetch(url, { headers: { 'X-Custom-Secret': 'synthetic-fixture' } }, true),
      /Cross-origin/,
    );
    await assert.rejects(
      () => safeFetch(url, { method: 'POST', body: 'private-fixture' }, true),
      /Cross-origin/,
    );
    assert.equal(received, 0);
    await assert.rejects(() => responseText(new Response('123456'), 5), /byte limit/);
    assert.equal(await responseText(await safeFetch(url + '/large', {}, true)), '123456789');
  } finally {
    source.closeAllConnections();
    sink.closeAllConnections();
    await Promise.all([new Promise((r) => source.close(r)), new Promise((r) => sink.close(r))]);
  }
});
