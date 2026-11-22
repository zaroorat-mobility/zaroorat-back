/**
 * Phase 1 — BACKFILL step of expand → backfill → verify → contract.
 * Encrypts every legacy plaintext driver bank-account number into the new
 * columns. Never modifies or clears the plaintext column. Idempotent; safe to
 * re-run. Prints row ids only — never an account number.
 *
 * Run: npx tsx scripts/bank-accounts-backfill.ts [--dry-run]
 * Then: npx tsx scripts/bank-accounts-verify.ts
 */
import { container } from '../src/core/di.js';
import { DatabaseService } from '../src/core/database/index.js';
import { backfillBankAccountEncryption } from '../src/modules/admin/driver-management/bank-accounts/bank-account-encryption.js';

async function main(): Promise<number> {
  const db = container.resolve<DatabaseService>('databaseService');
  const dryRun = process.argv.includes('--dry-run');
  const report = await backfillBankAccountEncryption(db.client, { dryRun });
  console.log(JSON.stringify({ dryRun, ...report }, null, 2));
  return report.failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
