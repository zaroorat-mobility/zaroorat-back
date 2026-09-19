/**
 * Phase 1 — VERIFY step of expand → backfill → verify → contract.
 * Checks every driver bank account decrypts to its legacy value with matching
 * last4/hash. Only a clean run writes `bank_accounts.encryption_verified_at`
 * (the gate for payouts and payout-enabling); any failure removes it.
 * Prints row ids and reasons only — never an account number.
 *
 * Run: npx tsx scripts/bank-accounts-verify.ts
 */
import { container } from '../src/core/di.js';
import { DatabaseService } from '../src/core/database/index.js';
import { verifyBankAccountEncryption } from '../src/modules/admin/driver-management/bank-accounts/bank-account-encryption.js';

async function main(): Promise<number> {
  const db = container.resolve<DatabaseService>('databaseService');
  const report = await verifyBankAccountEncryption(db.client);
  console.log(JSON.stringify(report, null, 2));
  return report.verifiedAt ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
