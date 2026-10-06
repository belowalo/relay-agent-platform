import crypto from 'node:crypto';
import { secretRefSchema } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
// Offline, security-owned import only. Legacy ciphertext lacks tenant AAD: validate
// the source row's workspace/connection ownership independently before calling.
export function migrateLegacyEnvelope(reference, envelope, legacyKey, destinationVault) {
  const ref = secretRefSchema.parse(reference);
  try {
    if (
      !Buffer.isBuffer(legacyKey) ||
      legacyKey.length !== 32 ||
      typeof envelope !== 'string' ||
      envelope.length > 100000
    )
      throw new Error();
    const parts = envelope.split('.');
    if (parts.length !== 3 || parts.some((s) => !/^[A-Za-z0-9+/]*={0,2}$/.test(s)))
      throw new Error();
    const [iv, tag, ciphertext] = parts.map((s) => Buffer.from(s, 'base64'));
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', legacyKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );
    return destinationVault.seal(ref, plaintext);
  } catch {
    throw new PlatformError('INTERNAL_ERROR', 'Legacy credential migration failed.');
  }
}
