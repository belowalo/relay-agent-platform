import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { createDatabaseEgress } from '../server/production/database-egress.js';
const target = { host: 'db.example.test', port: 5432, database: 'selected' };
const grant = (extra = {}) =>
  createDatabaseEgress({
    OUTBOUND_DATABASE_POLICY_JSON: JSON.stringify([{ ...target, ...extra }]),
  });
test('database egress requires an exact administrator host, port and database grant before DNS', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', async () => {
    throw new Error('DNS should not be called');
  });
  for (const authorize of [createDatabaseEgress({}), grant()]) {
    for (const denied of [
      { ...target, host: 'attacker.test' },
      { ...target, port: 5433 },
      { ...target, database: 'other' },
      { ...target, privateCidrs: ['0.0.0.0/0'] },
    ])
      await assert.rejects(authorize({}, denied), { code: 'FORBIDDEN' });
  }
  assert.equal(lookup.mock.callCount(), 0);
});
test('database DNS approval pins a literal IP, preserves TLS identity and rejects unapproved mixed answers', async (t) => {
  let addresses = [{ address: '10.20.0.4', family: 4 }];
  const lookup = t.mock.method(dns, 'lookup', async () => addresses);
  const authorize = grant({ privateCidrs: ['10.20.0.0/24'] });
  const approved = await authorize({}, target);
  assert.deepEqual(approved, { address: '10.20.0.4', servername: 'db.example.test' });
  assert.equal(Object.isFrozen(approved), true);
  assert.equal(lookup.mock.callCount(), 1);
  addresses = [{ address: '169.254.169.254', family: 4 }];
  assert.equal(approved.address, '10.20.0.4'); // Approval cannot be changed by a later DNS answer.
  await assert.rejects(authorize({}, target), { code: 'FORBIDDEN' });
  addresses = [
    { address: '8.8.8.8', family: 4 },
    { address: '10.21.0.4', family: 4 },
  ];
  await assert.rejects(authorize({}, target), { code: 'FORBIDDEN' });
  addresses = [{ address: '10.20.0.4', family: 4 }];
  await assert.rejects(grant()({}, target), { code: 'FORBIDDEN' });
});
test('metadata ranges cannot be granted and public sockets still need an exact tuple', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  assert.deepEqual(await grant()({}, target), {
    address: '8.8.8.8',
    servername: 'db.example.test',
  });
  for (const ip of ['169.254.169.254', '100.100.100.200', 'fd00:ec2::254', 'fe80::1']) {
    const config = { ...target, host: ip, privateCidrs: ['0.0.0.0/0', '::/0'] };
    const authorize = createDatabaseEgress({
      OUTBOUND_DATABASE_POLICY_JSON: JSON.stringify([config]),
    });
    await assert.rejects(authorize({}, { ...target, host: ip }), { code: 'FORBIDDEN' });
  }
  const config = { ...target, host: '127.0.0.1', privateCidrs: ['127.0.0.1/32'] };
  assert.deepEqual(
    await createDatabaseEgress({ OUTBOUND_DATABASE_POLICY_JSON: JSON.stringify([config]) })(
      {},
      { ...target, host: '127.0.0.1' },
    ),
    { address: '127.0.0.1' },
  );
});
test('invalid administrator grants fail startup instead of silently widening policy', () => {
  for (const raw of [
    '{',
    '{}',
    JSON.stringify([{ ...target, host: 'user@host' }]),
    JSON.stringify([{ ...target, privateCidrs: ['10.0.0.0/99'] }]),
    JSON.stringify([{ ...target, rejectUnauthorized: false }]),
    JSON.stringify([{ ...target, caFile: 'missing-cert-file' }]),
  ])
    assert.throws(
      () => createDatabaseEgress({ OUTBOUND_DATABASE_POLICY_JSON: raw }),
      /Invalid administrator/,
    );
});
