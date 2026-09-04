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

/**
 * Decrypts an encrypted setting string. Returns input as-is if not encrypted with enc: prefix.
 */
export function decryptSecret(ciphertext: string | null | undefined): string {
  if (!ciphertext) return '';
  if (!ciphertext.startsWith('enc:')) return ciphertext;

  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 4) return ciphertext;

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
    return '';
  }
}

/**
 * Masks a secret string for safe API output (e.g. "********").
 */
export function maskSecret(secret?: string | null): string {
  if (!secret || secret.trim().length === 0) return '';
  return MASKED_SECRET;
}
