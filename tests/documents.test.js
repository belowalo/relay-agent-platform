import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('PDF and DOCX source parsers extract actual document text', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-document-test-'));
  process.env.DATA_DIR = temp;
  const { parseDocument } = await import('../server/knowledge.js');
  try {
    for (const extension of ['pdf', 'docx']) {
      const buffer = fs.readFileSync(new URL(`./fixtures/knowledge.${extension}`, import.meta.url));
      const text = await parseDocument(buffer, `knowledge.${extension}`);
      assert.match(text, /Orion/);
      assert.match(text, /human approval/);
    }
  } finally {
    const { db } = await import('../server/db.js');
    db.close();
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error('Unexpected temporary directory');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
