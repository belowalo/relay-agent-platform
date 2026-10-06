import fs from 'node:fs';
import { createSecretVault } from '../foundation/secrets.js';
export function productionVault(config, env = process.env) {
  const keys = env.VAULT_KEYRING_FILE
    ? JSON.parse(fs.readFileSync(env.VAULT_KEYRING_FILE, 'utf8'))
    : { [config.encryptionKeyId]: config.encryptionKey };
  if (keys[config.encryptionKeyId] !== config.encryptionKey)
    throw new Error('Active vault key and keyring do not match');
  return createSecretVault(keys, config.encryptionKeyId);
}
