import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionRuleSchema, scoreProductionOutput } from '../server/production/quality.js';
test('production evaluators reject incomplete or invalid schemas and score actual bounds', () => {
  for (const type of ['latency', 'tokens', 'json'])
    assert.equal(productionRuleSchema.safeParse({ type }).success, false);
  assert.equal(
    productionRuleSchema.safeParse({ type: 'json', schema: { type: 'invalid-type' } }).success,
    false,
  );
  const rules = [
    { type: 'latency', maxMs: 300 },
    { type: 'tokens', maxTokens: 25 },
    { type: 'json', schema: { type: 'object', required: ['answer'] } },
  ];
  assert.equal(
    scoreProductionOutput({ answer: 'x' }, undefined, rules, {
      status: 'completed',
      active_ms: 299,
      tokens: 24,
    }).score,
    1,
  );
  assert.equal(
    scoreProductionOutput({}, undefined, rules, { status: 'completed', active_ms: 301, tokens: 26 })
      .score,
    0,
  );
});
