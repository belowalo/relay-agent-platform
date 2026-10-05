import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpload } from '../server/security/upload.js';

test('upload subprocess preserves UTF-8 and extracts markup as inert text', async () => {
  assert.equal(await parseUpload(Buffer.from('Résumé 🙂'), 'fixture.txt'), 'Résumé 🙂');
  const text = await parseUpload(
    Buffer.from('<script>throw new Error("execute")</script><p>Visible</p>'),
    'fixture.html',
  );
  assert.match(text, /Visible/);
  assert.doesNotMatch(text, /script|execute|<p>/);
});

test('upload input/output bounds, format signatures and production binary isolation gate', async () => {
  await assert.rejects(
    () => parseUpload(Buffer.alloc(15 * 1024 * 1024 + 1), 'large.txt'),
    /Invalid/,
  );
  await assert.rejects(() => parseUpload(Buffer.from('x'), 'fixture.exe'), /Unsupported/);
  await assert.rejects(() => parseUpload(Buffer.from('not a PDF'), 'fixture.pdf'), /signature/);
  await assert.rejects(() => parseUpload(Buffer.from('not a ZIP'), 'fixture.docx'), /signature/);
  await assert.rejects(
    () => parseUpload(Buffer.alloc(2_000_001, 65), 'text.txt'),
    /resource limits|text limit/,
  );
  const previous = process.env.RELAY_PROFILE;
  process.env.RELAY_PROFILE = 'production';
  try {
    await assert.rejects(() => parseUpload(Buffer.from('%PDF-1.7'), 'fixture.pdf'), /OS-isolated/);
    await assert.rejects(
      () => parseUpload(Buffer.from([80, 75, 3, 4]), 'fixture.docx'),
      /OS-isolated/,
    );
  } finally {
    if (previous === undefined) delete process.env.RELAY_PROFILE;
    else process.env.RELAY_PROFILE = previous;
  }
});
