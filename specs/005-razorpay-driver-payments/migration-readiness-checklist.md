# Migration Readiness Checklist — T020 and the deferred T019 columns (T019c)

**Feature**: `005-razorpay-driver-payments` · **Updated**: 2026-10-21 (Phase 3A) · **Status**: preparation only.

**No migration is approved** for the shared dev DB, `zaroorat_test`, staging or production.

This checklist supersedes [phase3-preparation.md](./phase3-preparation.md) §3.4–§3.9 where they overlap. §3.1–§3.3 (schema differences, backfill, rollback summary) still apply.

Legend: ☐ open · ☑ done · ⛔ blocked · ⚑ needs Owner approval.

---

## A. Dev database is behind on other contributors' migrations

**Facts (read-only, 2026-10-21).**

- Dev (`zaroorat`) has 72 of the repository's 74 earlier migrations.
- The two missing ones are committed and merged (`cc1d2ad`, 2026-10-16), from other workstreams:
  - `20261010120000_ride_requests_created_at_index`: `CREATE INDEX IF NOT EXISTS "ride_requests_created_at_idx"`. 13 rows on dev; index absent.
  - `20261013120000_document_sides_distinct`: `CHECK (back_file_id IS NULL OR back_file_id <> file_id)` on `driver_documents` and `vehicle_documents`, added `NOT VALID` then `VALIDATE`. 0 violating rows on dev, so `VALIDATE` would pass.

**Checklist.**

- ☑ Both migrations identified, read, and pre-checked read-only on dev.
- ⚑ Their owners apply them on dev, or explicitly agree they go together with T020 (T006: owners "to be named").
- ☐ The same two pre-checks are added to the staging/production operator run if those environments are behind too. P6 in the runbook records each environment's latest migration.

## B. `migrate deploy` applies every pending migration

**Fact.** `prisma migrate deploy` applies **all** pending migrations in name order. It cannot apply T020 alone.

**Options.**

1. **Recommended:** the other workstreams' migrations are applied first, by their owners, then T020 in its own approved operation.
2. One approved operation naming all three migrations, each owner signing off.
3. Not recommended: apply only T020's SQL by hand (`prisma db execute`) and mark it applied (`prisma migrate resolve --applied`). This leaves history out of order and bypasses the tool's checks.

**Checklist.**

- ☐ Before any deploy, run `prisma migrate status` (read-only) against the target and record the exact pending list. **Stop** if it contains anything not named in the approval.
- ⚑ The approval names the target **and** the exact migration list.

## C. The running dev server

**Facts.**

- A dev API runs on :8000 against the unmigrated dev DB, using this working tree (Phase 1/2 code).
- The generated Prisma client already contains the T019 models (new tables only), so the server works today.
- Its review path (`payment_review_cases`) would fail on an unmigrated database if a mismatch occurred. The payment switches are OFF and dev uses the mock gateway, so that path is not reached in practice.

**Effect of applying T020 on dev.**

- Additive.
- The running server becomes consistent: its review writes start working.
- Its normal writes are unaffected: no code updates or deletes ledger or wallet-transaction rows, and the dev seed only inserts.
- Index builds on these tiny tables take milliseconds.

**Effect of T019c on dev.** The client must be regenerated **after** the migration is applied. A client with the new fields against an unmigrated database breaks every `payment_intents`/`gateway_events` query. `tsx watch` restarts the server when `src/generated` changes. The worker process (`npm run worker:dev`), if running, must be restarted by hand.

**Checklist.**

- ☐ Tell every workstream using this tree before `prisma generate` (T006).
- ☐ Order: migrate dev → `prisma migrate status` clean → `prisma generate` (T019c only) → restart worker.
- ⚑ Approval for the dev target (and `zaroorat_test`, which other sessions' integration runs use).

## D. `lock_timeout` in T020

**Fact.** `20261021120000_razorpay_payment_safeguards/migration.sql` sets no `lock_timeout`. Its index builds take `SHARE` locks, and its trigger statements take `SHARE ROW EXCLUSIVE`. On a busy table, a statement could queue behind a long transaction, and every write would then queue behind it.

**Proposed edit (not applied).** Insert as the first statement:

```sql
-- Fail fast instead of queueing behind long transactions; re-run in a quieter moment.
SET lock_timeout = '5s';
```

A session-level `SET` is used because `SET LOCAL` only works if Prisma wraps the migration in a transaction. Constitution §3.4 says it does, but a session `SET` is correct either way, and the migrate connection is not reused by the application.

**Checklist.**

- ⚑ Approve the edit. Editing the file changes its checksum. The only database with T020 applied, the retained `zaroorat_rzp005_test`, would then report a modified migration and must be re-created from `zaroorat_test`. **This needs the Owner's approval, because that database is retained for review.**
- ☐ After the edit: re-apply on a fresh disposable clone; re-run the payment suites twice.

## E. Safe `CONCURRENTLY` index execution

**When.** Required on any environment where M1 shows a payment table large enough that a blocking build is not acceptable. Rule of thumb: the build measured in item F takes more than a few seconds. On dev (6 rows) it is not needed.

**Procedure (operator, per index, outside any transaction, after its pre-check returns 0):**

```sql
SET lock_timeout = '5s';
-- Q1 = 0 first
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "payment_intents_gateway_intent_key"
  ON "payment_intents" ("gateway", "gateway_intent_id") WHERE "gateway_intent_id" IS NOT NULL;
-- Q4a = 0 first
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "payment_transactions_provider_payment_key"
  ON "payment_transactions" ("gateway", "gateway_txn_id")
  WHERE "txn_type" = 'PAYMENT' AND "status" IN ('SUCCEEDED', 'CAPTURED_REVIEW') AND "gateway_txn_id" IS NOT NULL;
-- Q9 = 0 first
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "payment_transactions_one_success_per_intent"
  ON "payment_transactions" ("intent_id") WHERE "txn_type" = 'PAYMENT' AND "status" = 'SUCCEEDED';
-- Q3 = 0 first
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "commission_wallet_one_credit_per_intent"
  ON "driver_commission_wallet_transactions" ("reference_id") WHERE "txn_type" = 'MANUAL_RECHARGE';

-- Every one must be valid before `migrate deploy`:
SELECT c.relname, i.indisvalid, i.indisready
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname IN ('payment_intents_gateway_intent_key', 'payment_transactions_provider_payment_key',
                    'payment_transactions_one_success_per_intent', 'commission_wallet_one_credit_per_intent');
```

**Hazards.**

- **An INVALID index is silently skipped by the migration's `IF NOT EXISTS`, and enforces nothing.** If any `indisvalid = false`: `DROP INDEX CONCURRENTLY "<name>";`, fix the cause (a duplicate inserted during the build, or a lock timeout), and rebuild.
- `CONCURRENTLY` waits for every older transaction to finish. Check M1b first; progress shows in `pg_stat_progress_create_index`.
- A duplicate written between the pre-check and the build makes the build fail and leaves an INVALID index. That is why the pre-check runs immediately before each build.

**Checklist.**

- ⛔ M1 sizes for staging/production (T004 blocked).
- ☐ Each build timed on the representative dataset (item F).

## F. Verification on representative non-empty data

The zero-row clone and the 6-row dev database prove only that the SQL runs.

**Plan.** Nothing has been created yet; this needs approval to create a **new** disposable clone named `*_test`.

1. **Synthetic dataset, no PII, no staging copy.**
   - Generated users, drivers and intents at production-like volume (from M1 once known; until then, an assumed 10⁵–10⁶ intents and transactions, stated as an assumption).
   - Shapes:
     - paid and credited recharges;
     - paid and activated subscriptions;
     - FAILED → SUCCEEDED intents;
     - multiple FAILED attempts per order;
     - refunds;
     - legacy SUCCEEDED rows storing an order id (UD-8 shape);
     - seed-shaped fixtures.
2. **Negative controls.** One deliberate violation per blocking check (Q1, Q3, Q4a, Q9) in a separate copy. Q1–Q9 must detect it and `migrate deploy` must refuse.
3. **Apply T020 (and T019c when written)** with timings: each index build, each lock wait, total.
4. **Run against the migrated clone:**
   - the **previous application version's** suite (HEAD worktree, `node_modules` junctioned, per the backend test baseline procedure);
   - the current payment suites;
   - the dev seed;
   - the T004 file again.
5. **Staging rehearsal inside staging** (operator; no data leaves): restore a snapshot in staging's own infrastructure, run T004, apply, time it. This is T020's own done-when.

**Acceptance.**

- Every negative control is caught.
- All positive data migrates.
- The previous version's suite has no new failures.
- The index build times decide item E.

**Checklist.**

- ⚑ Approval to create the new disposable clone and run steps 1–4.
- ⛔ Step 5: staging access.

## G. Previous-version compatibility and rollback

**Compatibility (verified by code search, 2026-10-21).**

- The previous application never updates or deletes ledger or wallet-transaction rows (`src/`, `prisma/seed`, `scripts/`).
- It never writes a second SUCCEEDED payment per intent or per provider payment in normal operation (a concurrent duplicate now fails at the index, which is intended).
- It never writes negative balances, and does not know the new tables.
- `prisma:reset` drops the schema (triggers do not block `DROP`).
- **Exceptions:**
  - an older integration harness without `zaroorat.allow_financial_truncate` cannot reset a migrated test database;
  - the `payment-reconciliation` backdating fixture needs its Phase 2 adaptation.

**Deploy order.**

1. Run T004 on the target.
2. Run `prisma migrate status` and confirm the pending list (B).
3. Pre-build the indexes if required (E).
4. `migrate deploy`.
5. Verify:
   - objects present;
   - `indisvalid = true`;
   - triggers `tgenabled = 'A'`;
   - runtime role (login B) lacks UPDATE/DELETE/TRUNCATE on the two tables.
6. Deploy the application.

**Rollback procedures.**

| Situation                                                          | Procedure                                                                                                                                                                                                                                   | Data effect                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| R-A: application problem after deploy                              | Redeploy the previous application version. **The schema stays** (additive, verified compatible)                                                                                                                                             | None                                             |
| R-B: an index or trigger blocks something legitimate in production | A **prepared forward "relief" migration**: `DROP TRIGGER …` (owner DDL) or `DROP INDEX CONCURRENTLY …` for the single object, plus `GRANT` to reverse the REVOKE. Written and reviewed **before** go-live; applied only with Owner approval | Removes a protection; must be re-added later     |
| R-C: `payment_review_cases`                                        | **Never dropped once it holds a row** (Finance records); a column fix is a forward migration                                                                                                                                                | —                                                |
| R-D: T019c                                                         | `DROP COLUMN` in a forward migration, **only before** T026/T031/T061 code that reads the columns ships                                                                                                                                      | Loses outcome/attempt history if any was written |
| R-E: restore from backup                                           | Last resort only: loses every payment, ledger and review row written since the snapshot                                                                                                                                                     | Data loss: Finance and Owner decision            |

**Checklist.**

- ☐ Write and review the R-B relief migration text before any production apply (not before dev/test).
- ⛔ Confirm production point-in-time recovery exists (DevOps).

## H. The five deferred T019 columns (T019c)

| Column                               | Type                         | Needed by                    | Why                                                                                                                |
| ------------------------------------ | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `payment_intents.last_reconciled_at` | `TIMESTAMP(3)` NULL          | **T061** (and its test T060) | TD-13 rotation (`last_reconciled_at NULLS FIRST, created_at, id`); fixes the 100-row starvation (CD-12)            |
| `gateway_events.outcome`             | `TEXT` NULL                  | **T031**, **T026**, R4       | Terminal outcomes incl. `PROCESSING_FAILED`/`PARKED` (T026) and `UNUSABLE_PAYLOAD` (R4, Owner-approved 2026-10-21) |
| `gateway_events.processing_attempts` | `INTEGER NOT NULL DEFAULT 0` | **T026**                     | Atomic attempt counter; parking at `RAZORPAY_WEBHOOK_MAX_PROCESSING_ATTEMPTS`                                      |
| `gateway_events.last_error`          | `TEXT` NULL                  | **T026**                     | Sanitized error (no body, no signature)                                                                            |
| `gateway_events.last_attempt_at`     | `TIMESTAMP(3)` NULL          | **T026**                     | Time of the last attempt                                                                                           |

**Now possible, because R4 is decided.** A `CHECK` on `outcome` with the full value list:

`APPLIED, STALE_IGNORED, TOO_OLD, MISMATCH, UNKNOWN_ORDER, NO_ACTION, PARKED, PROCESSING_FAILED, UNUSABLE_PAYLOAD`

Add it as `NOT VALID` then `VALIDATE`; existing NULLs pass.

**Dependencies.**

- T019c is a **separate migration after T020**.
- It must be applied to the test targets **before** T026, T031 or T061 can be tested, and deployed **before** any code that reads it.
- T026 needs T020 applied (tasks.md). T031 needs T026; T061 needs T020.

**Lock profile.** Metadata-only `ADD COLUMN` (PostgreSQL 17 on dev; ≥ 11 required). It needs a brief `ACCESS EXCLUSIVE` lock, so `lock_timeout` applies here as well.

**Backfill.** None. NULL means "before outcomes existed" or "never reconciled"; no outcome is fabricated.

**Checklist.**

- ⚑ Approval to write T019c (schema + migration) together with the first task that reads it.
- ☐ Prisma fields added in the same change; `prisma:format`/`validate`; `migrate diff` empty for these objects.

---

## Unresolved blockers

| #   | Blocker                                                                                                                                                                                                                      | Owner of the unblock                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Staging/production T004 (runbook prerequisites P1–P8)                                                                                                                                                                        | Owner + DevOps                                |
| 2   | Q10/Q10b through the API login in staging/production (SEC-7, U11)                                                                                                                                                            | DevOps                                        |
| 3   | Other workstreams' two migrations on dev: owners not named (T006)                                                                                                                                                            | Owner                                         |
| 4   | Approval naming target and migration list for dev and `zaroorat_test`                                                                                                                                                        | Owner                                         |
| 5   | `lock_timeout` edit (requires re-creating the retained clone)                                                                                                                                                                | Owner                                         |
| 6   | Representative non-empty verification: approval for a new disposable clone                                                                                                                                                   | Owner                                         |
| 7   | Staging rehearsal (T020 done-when)                                                                                                                                                                                           | DevOps                                        |
| 8   | Production point-in-time recovery confirmed; R-B relief migration reviewed                                                                                                                                                   | DevOps + Engineering                          |
| 9   | ~~`.env.example` holds real-looking test credentials~~. Values **removed 2026-10-21 (Phase 3B)**. **Rotation of the Razorpay test key is still required**: the secret was found in local AI-tooling stores and model context | Owner (rotation through the Razorpay account) |
