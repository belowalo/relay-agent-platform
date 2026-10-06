import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSecretVault } from '../server/foundation/secrets.js';
import { productionVault } from '../server/production/vault.js';
test('production loads retained decryption keys and rejects an inconsistent active key', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-keyring-test-'));
  try {
    const old = '12'.repeat(32),
      active = '34'.repeat(32),
      ctx = {
        workspaceId: 'vault-test',
        actor: { kind: 'user', id: 'owner' },
        requestId: 'vault-test',
      },
      ref = { workspaceId: 'vault-test', connectionId: 'connection', version: 1 };
    const envelope = createSecretVault({ old }, 'old').seal(ref, 'private-fixture');
    const file = path.join(dir, 'keyring');
    await fs.writeFile(file, JSON.stringify({ old, active }));
    const vault = productionVault(
      { encryptionKey: active, encryptionKeyId: 'active' },
      { VAULT_KEYRING_FILE: file },
    );
    assert.equal(vault.open(ctx, ref, envelope), 'private-fixture');
    assert.throws(
      () =>
        productionVault(
          { encryptionKey: old, encryptionKeyId: 'active' },
          { VAULT_KEYRING_FILE: file },
        ),
      /match/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
