import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph } from '../../server/catalog.js';
import { businessExamples } from '../../examples/business/workflows.mjs';
test('five business examples use executable graph kinds and explicit scoped dependency references', () => {
  const examples = businessExamples({
    collectionId: 'scoped-corpus',
    connectionId: 'scoped-model',
    researchToolId: 'read-evidence',
    approvedToolId: 'reviewed-action',
  });
  assert.equal(examples.length, 5);
  for (const example of examples) assert.deepEqual(validateGraph(example.graph), [], example.id);
  const assistant = examples[0].graph.nodes[1].data.config;
  assert.deepEqual(assistant.knowledgeIds, ['scoped-corpus']);
  assert.match(assistant.instructions, /untrusted data/);
  const research = examples[1].graph;
  assert.equal(research.nodes[2].data.config.toolId, 'read-evidence');
  assert.equal(examples[2].graph.nodes[1].data.config.toolId, 'reviewed-action');
  assert.ok(examples.every((example) => !JSON.stringify(example).includes('secret')));
});
