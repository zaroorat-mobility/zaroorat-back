import type { ProviderClient } from '@core/database/index.js';
import {
  BANK_ACCOUNT_KEY_VERSION,
  BANK_ENCRYPTION_VERIFIED_SETTING,
  decryptAccountNumber,
  hashAccountNumber,
  normalizeAccountNumber,
  protectAccountNumber,
} from '@shared/crypto/bank-account-crypto.js';

type Client = Pick<ProviderClient, 'driverBankAccount' | 'systemSetting'>;

/// Phase 1 — BACKFILL and VERIFY steps of expand → backfill → verify → contract.
///
/// Neither function ever modifies or clears the legacy plaintext column
/// (`account_number_enc`). Clearing it is the separate CONTRACT step, which
/// needs this verification to pass and an explicit sign-off. Reports carry row
/// ids and reasons only — never an account number.

export interface BackfillReport {
  scanned: number;
  encrypted: number;
  alreadyEncrypted: number;
  failed: string[];
}

/// Encrypts every legacy plaintext account number that has no ciphertext yet.
/// Idempotent and resumable: a row is written only while its ciphertext is
/// still NULL, and each value is decrypted and compared before it is stored.
export async function backfillBankAccountEncryption(
  client: Client,
  options: { batchSize?: number; dryRun?: boolean } = {},
): Promise<BackfillReport> {
  const batchSize = options.batchSize ?? 200;
  const report: BackfillReport = { scanned: 0, encrypted: 0, alreadyEncrypted: 0, failed: [] };
  let cursor: string | undefined;
  for (;;) {
    const rows = await client.driverBankAccount.findMany({
      where: { accountNumberEnc: { not: null } },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, accountNumberEnc: true, accountNumberCiphertext: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      report.scanned++;
      if (row.accountNumberCiphertext) {
        report.alreadyEncrypted++;
        continue;
      }
      try {
        const plaintext = row.accountNumberEnc as string;
        const protectedNumber = protectAccountNumber(plaintext);
        if (
          decryptAccountNumber(protectedNumber.ciphertext) !== normalizeAccountNumber(plaintext)
        ) {
          throw new Error('round-trip mismatch');
        }
        if (options.dryRun) {
          report.encrypted++;
          continue;
        }
        const { count } = await client.driverBankAccount.updateMany({
          where: { id: row.id, accountNumberCiphertext: null },
          data: {
            accountNumberCiphertext: protectedNumber.ciphertext,
            accountNumberLast4: protectedNumber.last4,
            accountNumberHash: protectedNumber.hash,
            encryptionKeyVersion: protectedNumber.keyVersion,
          },
        });
        if (count === 1) report.encrypted++;
        else report.alreadyEncrypted++;
      } catch {
        report.failed.push(row.id);
      }
    }
    cursor = rows[rows.length - 1]?.id;
  }
  return report;
}

export interface VerificationReport {
  checked: number;
  withoutAccountNumber: number;
  failed: { id: string; reason: string }[];
  verifiedAt: string | null;
}

/// Checks EVERY bank account: ciphertext present and intact, current key
/// version, last4 and hash consistent, and — while the legacy plaintext still
/// exists — equal to it. Only a clean run writes
/// `bank_accounts.encryption_verified_at`; any failure REMOVES it, so payouts
/// close again rather than stay open on stale evidence.
export async function verifyBankAccountEncryption(
  client: Client,
  now: Date = new Date(),
): Promise<VerificationReport> {
  const report: VerificationReport = {
    checked: 0,
    withoutAccountNumber: 0,
    failed: [],
    verifiedAt: null,
  };
  let cursor: string | undefined;
  for (;;) {
    const rows = await client.driverBankAccount.findMany({
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        accountNumberEnc: true,
        accountNumberCiphertext: true,
        accountNumberLast4: true,
        accountNumberHash: true,
        encryptionKeyVersion: true,
      },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      report.checked++;
      if (!row.accountNumberEnc && !row.accountNumberCiphertext) {
        report.withoutAccountNumber++;
        continue;
      }
      const reason = verifyRow(row);
      if (reason) report.failed.push({ id: row.id, reason });
    }
    cursor = rows[rows.length - 1]?.id;
  }
  if (report.failed.length === 0) {
    const value = now.toISOString();
    await client.systemSetting.upsert({
      where: { key: BANK_ENCRYPTION_VERIFIED_SETTING },
      create: {
        key: BANK_ENCRYPTION_VERIFIED_SETTING,
        value,
        category: 'bank_accounts',
        description: 'Set only by a clean bank-account encryption verification run',
        isSecret: false,
      },
      update: { value },
    });
    report.verifiedAt = value;
  } else {
    await client.systemSetting.deleteMany({ where: { key: BANK_ENCRYPTION_VERIFIED_SETTING } });
  }
  return report;
}

function verifyRow(row: {
  accountNumberEnc: string | null;
  accountNumberCiphertext: string | null;
  accountNumberLast4: string | null;
  accountNumberHash: string | null;
  encryptionKeyVersion: number | null;
}): string | null {
  if (!row.accountNumberCiphertext) return 'not encrypted';
  let decrypted: string;
  try {
    decrypted = decryptAccountNumber(row.accountNumberCiphertext);
  } catch {
    return 'ciphertext does not decrypt with the current key';
  }
  if (row.encryptionKeyVersion !== BANK_ACCOUNT_KEY_VERSION) return 'unexpected key version';
  if (row.accountNumberLast4 !== decrypted.slice(-4)) return 'last4 mismatch';
  if (row.accountNumberHash !== hashAccountNumber(decrypted)) return 'hash mismatch';
  if (row.accountNumberEnc && normalizeAccountNumber(row.accountNumberEnc) !== decrypted) {
    return 'ciphertext does not match the legacy value';
  }
  return null;
}
