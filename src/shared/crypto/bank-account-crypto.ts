import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/// Driver bank-account number protection (Phase 1).
///
/// Deliberately separate from `encryptSecret` (settings credentials):
///  - its own keys (`BANK_DATA_ENCRYPTION_KEY`, `BANK_ACCOUNT_HASH_KEY`), so
///    rotating a credential key never touches bank data and vice versa;
///  - a versioned format (`bank:v1:`), so a future key rotation can tell old
///    ciphertext from new;
///  - a keyed hash for finding one account used by several drivers without
///    decrypting anything.
///
/// `decryptAccountNumber` is exported only for the payout-provider
/// provisioning step and the encryption backfill/verification. A unit test
/// fails the build if any other module imports it.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const PREFIX = 'bank:v1:';
export const BANK_ACCOUNT_KEY_VERSION = 1;

type KeyName = 'BANK_DATA_ENCRYPTION_KEY' | 'BANK_ACCOUNT_HASH_KEY';

function key(name: KeyName, label: string): Buffer {
  const configured = process.env[name];
  if (configured && configured.length >= 32) {
    return createHash('sha256').update(configured).digest();
  }
  const environment = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
  if (environment === 'production' || environment === 'staging') {
    throw new Error(`${name} must be set (min 32 chars) when APP_ENV=${environment}`);
  }
  // Development/test only: a stable derivation so local data stays readable.
  const fallback = process.env.JWT_ACCESS_SECRET ?? 'zaroorat-development-only-bank-key';
  return createHash('sha256').update(`${label}:${fallback}`).digest();
}

/// Spaces and hyphens are formatting, not part of the number.
export function normalizeAccountNumber(raw: string): string {
  const normalized = raw.replace(/[\s-]/g, '').toUpperCase();
  if (normalized.length < 4) throw new Error('Bank account number is too short');
  return normalized;
}

export function hashAccountNumber(raw: string): string {
  return createHmac('sha256', key('BANK_ACCOUNT_HASH_KEY', 'zaroorat-bank-hash'))
    .update(normalizeAccountNumber(raw))
    .digest('hex');
}

export interface ProtectedAccountNumber {
  ciphertext: string;
  last4: string;
  hash: string;
  keyVersion: number;
}

export function protectAccountNumber(raw: string): ProtectedAccountNumber {
  const normalized = normalizeAccountNumber(raw);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(
    ALGORITHM,
    key('BANK_DATA_ENCRYPTION_KEY', 'zaroorat-bank-data'),
    iv,
  );
  const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`,
    last4: normalized.slice(-4),
    hash: hashAccountNumber(normalized),
    keyVersion: BANK_ACCOUNT_KEY_VERSION,
  };
}

/// Throws on anything that is not intact `bank:v1:` ciphertext under the
/// current key — a tampered or wrongly keyed value is never silently accepted.
export function decryptAccountNumber(ciphertext: string): string {
  if (!ciphertext.startsWith(PREFIX)) throw new Error('Not bank:v1 ciphertext');
  const [ivHex, tagHex, dataHex] = ciphertext.slice(PREFIX.length).split(':');
  if (!ivHex || !tagHex || dataHex === undefined) throw new Error('Malformed bank ciphertext');
  const decipher = createDecipheriv(
    ALGORITHM,
    key('BANK_DATA_ENCRYPTION_KEY', 'zaroorat-bank-data'),
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString(
    'utf8',
  );
}

/// The only form of an account number any API may return.
export function maskAccountNumber(last4: string | null | undefined): string | null {
  return last4 ? `****${last4}` : null;
}

/// Written only by the bank-account encryption verification run, and only when
/// every row decrypts correctly. Payouts and payout-enabling stay closed until
/// it exists.
export const BANK_ENCRYPTION_VERIFIED_SETTING = 'bank_accounts.encryption_verified_at';
