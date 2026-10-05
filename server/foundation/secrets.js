import crypto from 'node:crypto';
import { secretRefSchema, tenantContextSchema } from './contracts.js';
import { assertWorkspace } from './context.js';
import { PlatformError } from './errors.js';

export function createSecretVault(keys, activeKeyId) {
  const keyring = new Map(
    Object.entries(keys).map(([id, value]) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !/^[a-fA-F0-9]{64}$/.test(value))
        throw new PlatformError('VALIDATION_ERROR', 'Invalid vault key configuration.');
      return [id, Buffer.from(value, 'hex')];
    }),
  );
  if (!keyring.has(activeKeyId))
    throw new PlatformError('VALIDATION_ERROR', 'Active vault key is unavailable.');
  const aad = (ref) =>
    Buffer.from(JSON.stringify([ref.workspaceId, ref.connectionId, ref.version]));
  return Object.freeze({
    seal(ref, plaintext) {
      ref = secretRefSchema.parse(ref);
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > 65536)
        throw new PlatformError('VALIDATION_ERROR', 'Credential size is invalid.');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyring.get(activeKeyId), iv);
      cipher.setAAD(aad(ref));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return JSON.stringify({
        version: 1,
        keyId: activeKeyId,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      });
    },
    open(context, ref, envelope) {
      context = tenantContextSchema.parse(context);
      ref = secretRefSchema.parse(ref);
      assertWorkspace(ref.workspaceId, context);
      try {
        const value = JSON.parse(envelope);
        if (value.version !== 1 || !keyring.has(value.keyId)) throw new Error();
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          keyring.get(value.keyId),
          Buffer.from(value.iv, 'base64'),
        );
        decipher.setAAD(aad(ref));
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(value.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new PlatformError('INTERNAL_ERROR', 'Credential could not be decrypted.');
      }
    },
  });
}
