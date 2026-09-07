import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { logger } from '@shared/logger/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const MASKED_SECRET = '********';

/// Key material for settings encryption.
///
/// There used to be a third fallback here: a string literal in this file. Any
/// deployment that had set neither variable encrypted every provider credential,
/// payment key and SMS secret under a constant that ships in the repository, so
/// "encrypted at rest" meant nothing to anyone holding a database dump and a
/// clone. It is gone; there is no default.
///
/// `JWT_ACCESS_SECRET` remains as a fallback because the environment schema
/// already requires it everywhere, which keeps development and test working
/// without a second secret. It is not good enough for production — rotating the
/// JWT secret would silently make every stored credential undecryptable — so
/// `ENCRYPTION_KEY` is required outright in staging and production (see
/// `src/config/env/schema.ts`).
function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY ?? process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error(
      'ENCRYPTION_KEY (or JWT_ACCESS_SECRET) must be set to encrypt or decrypt settings. ' +
        'Refusing to fall back to a built-in key.',
    );
  }
  return scryptSync(secret, 'zaroorat_settings_salt', 32);
}

/**
 * Encrypts a sensitive string setting (API key, client secret) using AES-256-GCM.
 * Output format: enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext || plaintext.trim().length === 0) return '';
  if (plaintext.startsWith('enc:')) return plaintext; // Already encrypted

  try {
    const key = getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `enc:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (error) {
    logger.error({ error }, '[encryption] Failed to encrypt secret');
    throw new Error('Encryption failed', { cause: error });
  }
}

/// Raised when an `enc:` value cannot be decrypted.
///
/// Almost always means the key changed: ENCRYPTION_KEY was set, rotated, or is
/// now resolving differently than when the value was written. Distinct from "no
/// value stored", which is the distinction the old `return ''` destroyed.
export class SecretDecryptionError extends Error {
  constructor(cause?: unknown) {
    super(
      'Failed to decrypt a stored secret. This usually means ENCRYPTION_KEY differs from ' +
        'the key the value was encrypted with. Restore the previous key, or re-enter the ' +
        'affected credentials.',
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Decrypts an encrypted setting string. Returns input as-is if not encrypted with enc: prefix.
 *
 * Throws `SecretDecryptionError` when an `enc:` value will not decrypt. It used
 * to return `''`, which callers could not tell apart from an unset value: after
 * a key rotation every provider reported itself "not configured" and routing
 * returned 503 with nothing anywhere saying why. Callers that must survive one
 * bad row — `SystemSettingService` reading a whole category — catch it per row.
 */
export function decryptSecret(ciphertext: string | null | undefined): string {
  if (!ciphertext) return '';
  if (!ciphertext.startsWith('enc:')) return ciphertext;

  const parts = ciphertext.split(':');
  if (parts.length !== 4) {
    // Prefixed `enc:` but not in the format this module writes. Not decryptable,
    // and returning it verbatim would hand a caller a ciphertext to use as a key.
    throw new SecretDecryptionError();
  }

  try {
    const [, ivHex, authTagHex, encryptedHex] = parts;
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex!, 'hex');
    const authTag = Buffer.from(authTagHex!, 'hex');
    const encrypted = Buffer.from(encryptedHex!, 'hex');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    logger.error({ error }, '[encryption] Failed to decrypt secret');
    throw new SecretDecryptionError(error);
  }
}

/**
 * Masks a secret string for safe API output (e.g. "********").
 */
export function maskSecret(secret?: string | null): string {
  if (!secret || secret.trim().length === 0) return '';
  return MASKED_SECRET;
}
