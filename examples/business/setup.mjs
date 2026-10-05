import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { businessExamples } from './workflows.mjs';
const origin = new URL(process.env.RELAY_EXAMPLE_ORIGIN || 'http://127.0.0.1:4311').origin;
const wid = process.env.RELAY_EXAMPLE_WORKSPACE;
const cookie = process.env.RELAY_EXAMPLE_COOKIE;
assert.ok(
  wid && cookie,
  'Set RELAY_EXAMPLE_WORKSPACE and RELAY_EXAMPLE_COOKIE from your authorized synthetic workspace session',
);
assert.equal(process.env.RELAY_EXAMPLE_DISPOSABLE, 'yes', 'Use a disposable example workspace');
assert.ok(
  process.env.RELAY_EXAMPLE_CONNECTION_ID,
  'Connect and test your model first; set RELAY_EXAMPLE_CONNECTION_ID',
);
assert.ok(
  process.env.RELAY_EXAMPLE_RESEARCH_URL,
  'Set a public text/JSON evidence URL; use a local fixture only with permitted network access',
);
assert.ok(process.env.RELAY_EXAMPLE_ACTION_URL, 'Set an authorized synthetic action endpoint');
const base = `/api/w/${wid}`;
async function api(route, body, method = 'POST') {
  const response = await fetch(origin + base + route, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.ok(response.ok, `Example setup failed at ${route}: HTTP ${response.status}`);
  return data;
}
const collection = await api('/collections', {
  name: 'Synthetic North policies',
  config: { retrieval: 'lexical', chunkSize: 500, overlap: 40 },
});
const form = new FormData();
form.set(
  'file',
  new Blob([
    await fs.readFile(new URL('../../tests/fixtures/business/travel-policy.md', import.meta.url)),
  ]),
  'travel-policy.md',
);
const upload = await fetch(origin + base + `/collections/${collection.id}/upload`, {
  method: 'POST',
  headers: { Cookie: cookie },
  body: form,
});
assert.ok(upload.ok, 'Synthetic policy upload failed');
const research = await api('/tools', {
  name: 'Authorized external evidence',
  kind: 'http',
  config: {
    method: 'GET',
    url: process.env.RELAY_EXAMPLE_RESEARCH_URL,
    allowPrivate: process.env.RELAY_EXAMPLE_ALLOW_PRIVATE === 'yes',
  },
});
const action = await api('/tools', {
  name: 'Reviewed synthetic action',
  kind: 'http',
  config: {
    method: 'POST',
    url: process.env.RELAY_EXAMPLE_ACTION_URL,
    allowPrivate: process.env.RELAY_EXAMPLE_ALLOW_PRIVATE === 'yes',
    requireApproval: true,
  },
});
const examples = businessExamples({
  collectionId: collection.id,
  connectionId: process.env.RELAY_EXAMPLE_CONNECTION_ID,
  researchToolId: research.id,
  approvedToolId: action.id,
});
for (const example of examples) {
  const workflow = await api('/workflows', { name: example.name, graph: example.graph });
  process.stdout.write(`${example.id}: ${workflow.id}\n`);
}
process.stdout.write(
  'Five draft workflows created. Inspect them before running, scheduling or publishing. No run or external action was started.\n',
);
