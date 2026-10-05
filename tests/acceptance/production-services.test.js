import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { citationSchema, jobSchema } from '../../server/foundation/contracts.js';

// This target is intentionally strict: missing infrastructure/composition is a failure,
// never a passing skipped production gate. The coordinator supplies a disposable adapter.
let service;
before(async () => {
  assert.equal(
    process.env.ACCEPTANCE_DISPOSABLE,
    'yes',
    'Production conformance requires explicit disposable infrastructure',
  );
  assert.ok(
    process.env.ACCEPTANCE_ADAPTER,
    'Set ACCEPTANCE_ADAPTER to a coordinator-owned executable adapter; see docs/production/VERIFICATION.md',
  );
  const module = await import(pathToFileURL(path.resolve(process.env.ACCEPTANCE_ADAPTER)).href);
  service = await module.openAcceptanceServices();
  assert.equal(service.profile, 'production');
  assert.ok(service.contextA.workspaceId !== service.contextB.workspaceId);
  assert.ok(service.contextA.actor.id !== service.contextB.actor.id);
  await service.database.assertApplicationRole();
});
after(async () => {
  await service?.close();
});

test('F02 K02 actual restricted-role storage isolates blobs, documents and versioned citations', async () => {
  const { contextA: a, contextB: b, blobs, documents } = service;
  const ref = await blobs.put(
    a,
    crypto.randomUUID(),
    Buffer.from('Synthetic travel evidence: limit 180 CAD.'),
    'text/plain',
  );
  await assert.rejects(blobs.get(b, ref.key));
  const source = await documents.upsert(a, {
    collectionId: service.collectionA,
    externalId: 'verification-policy',
    name: 'Synthetic policy',
    blob: ref,
    metadata: { team: 'north' },
    access: { mode: 'restricted', principalIds: [a.actor.id] },
  });
  assert.ok(source.sourceId);
  assert.ok(source.version >= 1);
  assert.ok(source.jobId);
  const evidence = await service.waitForRetrieval(a, service.collectionA, 'travel limit');
  assert.ok(evidence.length);
  for (const citation of evidence) {
    citationSchema.parse(citation);
    assert.equal(citation.workspaceId, a.workspaceId);
    assert.equal(citation.sourceId, source.sourceId);
    assert.equal(citation.sourceVersion, source.version);
  }
  assert.deepEqual(await service.retrieve(b, service.collectionA, 'travel limit'), []);
  assert.deepEqual(
    await service.retrieve(service.contextRestrictedPeer, service.collectionA, 'travel limit'),
    [],
  );
  await documents.delete(a, source.sourceId);
  assert.deepEqual(await service.retrieve(a, service.collectionA, 'travel limit'), []);
  await assert.rejects(blobs.get(a, ref.key));
});

test('U01 concurrent budget reservations, unknown-cost policy, idempotent settlement and release', async () => {
  const { usage, contextA: a } = service;
  await service.setBudget(a, {
    maximumTokens: 100,
    maximumCostMicros: 1000,
    allowUnknownCost: false,
  });
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      usage.reserve(a, { runId: service.runIds[i], maximumTokens: 30, maximumCostMicros: 100 }),
    ),
  );
  const reserved = attempts.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.ok(
    reserved.length > 0 && reserved.length <= 3,
    'Atomic reservation cannot over-allocate the 100-token budget',
  );
  for (const reservation of reserved) assert.equal(reservation.workspaceId, a.workspaceId);
  const result = { tokens: 10, costMicros: 50, provider: 'fixture', model: 'synthetic' };
  await usage.settle(a, reserved[0].id, result);
  await usage.settle(a, reserved[0].id, result);
  for (const reservation of reserved.slice(1)) await usage.release(a, reservation.id);
  const totals = await service.readUsage(a);
  assert.equal(totals.tokens, 10);
  assert.equal(totals.costMicros, 50);
  assert.equal(totals.reservedTokens, 0);
  await assert.rejects(
    usage.reserve(a, { runId: service.runIds[7], maximumTokens: 1, maximumCostMicros: null }),
  );
  await assert.rejects(usage.settle(service.contextB, reserved[0].id, result));
});

test('F03 R02 duplicate reference delivery cannot repeat an approved business write', async () => {
  const action = await service.prepareApprovedAction(service.contextA, {
    amount: 42,
    message: 'Synthetic purchase',
  });
  jobSchema.parse(action.job);
  const before = await service.readExternalWriteCount();
  await Promise.all(Array.from({ length: 8 }, () => service.queue.publish(action.job)));
  await service.waitForRun(action.runId);
  assert.equal(await service.readExternalWriteCount(), before + 1);
  await service.queue.publish(action.job);
  await service.waitForQuiescence();
  assert.equal(await service.readExternalWriteCount(), before + 1);
});

test('D01 O02 migrated and restored records preserve IDs, integrity, decryptability and recovery targets', async () => {
  const report = await service.migrateAndRestoreSyntheticData();
  assert.equal(report.dryRunChangedData, false);
  assert.deepEqual(report.sourceCounts, report.importedCounts);
  assert.deepEqual(report.importedCounts, report.restoredCounts);
  assert.ok(
    ['users', 'members', 'workflows', 'runs', 'connections', 'sources', 'chunks'].every(
      (table) => report.sourceCounts[table] > 0,
    ),
  );
  assert.equal(report.preservedIds, true);
  assert.equal(report.credentialsDecryptAfterRestore, true);
  assert.equal(report.vectorsAndBlobHashesMatch, true);
  assert.equal(report.crossWorkspaceDenied, true);
  assert.ok(report.rpoMs >= 0 && report.rpoMs <= 3600000);
  assert.ok(report.restoreMs > 0 && report.restoreMs <= 3600000);
});

test('D02 O01 production deployment has two instances, multiple hosts, readiness and bounded draining', async () => {
  const deployment = await service.deploymentSmoke();
  assert.ok(deployment.hostIds.length >= 2 && new Set(deployment.hostIds).size >= 2);
  assert.ok(deployment.apiInstances >= 2 && deployment.workers >= 2);
  assert.equal(deployment.database, 'postgresql');
  assert.equal(deployment.storage, 'shared-object-storage');
  assert.equal(deployment.httpsPassed, true);
  assert.equal(deployment.readinessFailsWithDependencyLoss, true);
  assert.equal(deployment.noLocalDiskDependency, true);
  assert.equal(deployment.drainPreservedActiveRuns, true);
  assert.equal(deployment.rollbackPassed, true);
});
