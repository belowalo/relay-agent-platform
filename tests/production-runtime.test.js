import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { argumentHash, limitsFor, checkGraph, plan, json } from '../server/runtime/core.js';
import { readImport } from '../server/runtime/import.js';
import { sqliteFixture, node, edge, linear } from './helpers/runtime-fixtures.js';
test('exact argument hashes canonicalize keys, retain types and reject non-JSON values', () => {
  assert.equal(argumentHash({ a: 1, b: ['x'] }), argumentHash({ b: ['x'], a: 1 }));
  assert.notEqual(argumentHash({ a: 1 }), argumentHash({ a: '1' }));
  assert.throws(() => argumentHash({ a: undefined }), /INVALID_ARGUMENTS/);
});
test('limits reject unbounded resources and graph cycles', () => {
  assert.throws(() => limitsFor({ rounds: 13 }), /INVALID_LIMITS/);
  assert.throws(() => limitsFor({ durationMs: 900001 }), /INVALID_LIMITS/);
  const graph = linear();
  graph.edges.push(edge('out', 'in'));
  assert.throws(() => checkGraph(graph), /Cycles/);
});
test('joins wait for every active parent and propagate skipped condition branches', () => {
  const graph = {
    nodes: [
      node('in', 'input'),
      node('c', 'condition'),
      node('yes', 'transform'),
      node('no', 'transform'),
      node('out', 'output'),
    ],
    edges: [
      edge('in', 'c'),
      edge('c', 'yes', 'true'),
      edge('c', 'no', 'false'),
      edge('yes', 'out'),
      edge('no', 'out'),
    ],
  };
  const rows = graph.nodes.map((n) => ({ node_id: n.id, status: 'queued', output: null }));
  rows[0].status = 'completed';
  rows[1] = {
    node_id: 'c',
    status: 'completed',
    output: json({ branch: 'true', value: { x: 1 } }),
  };
  let next = plan(graph, rows, {});
  assert.deepEqual(next.skipped, ['no']);
  assert.equal(next.ready[0].node.id, 'yes');
  rows[2] = { node_id: 'yes', status: 'completed', output: json({ x: 1 }) };
  rows[3].status = 'skipped';
  next = plan(graph, rows, {});
  assert.deepEqual(next.ready[0].input, { x: 1 });
});
test('SQLite import reads only a disposable synthetic copy, verifies ciphertext and quarantines legacy execution', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-runtime-import-'));
  const source = path.join(dir, 'synthetic.sqlite');
  try {
    const { key, envelope } = sqliteFixture(source);
    const before = await fs.readFile(source);
    const result = readImport(source, { legacyKey: key });
    assert.equal(result.counts.connections, 1);
    assert.equal(result.tables.get('connections')[0].secret, envelope);
    assert.equal(result.tables.get('actions')[0].status, 'uncertain');
    assert.equal(result.tables.get('events')[0].sequence, 1);
    assert.equal(result.tables.get('versions')[0].workspace_id, 'fixture_workspace');
    assert.equal(result.haltedRuns, 1);
    assert.deepEqual(await fs.readFile(source), before);
    assert.throws(() => readImport(source, { legacyKey: Buffer.alloc(32) }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
