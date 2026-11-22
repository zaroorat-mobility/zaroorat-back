# Data Model: Production-Ready Razorpay Payments for Drivers

**Feature**: `005-razorpay-driver-payments` | **Date**: 2026-10-19 | **Revised**: 2026-10-19 (production-readiness review; second review: A6/A7 index interactions, `PARKED`, runtime-role REVOKE, Q10–Q11, §14; third review: `MANUAL_REVIEW → CANCELLED`, meaning of `processed`, UD-2/UD-7 dependencies, Q11 gateway count; fourth review: locked supersession from PENDING/FAILED/EXPIRED, atomic attempt counter, sweep catch-up window, Q11 by purpose) | **Decisions**: [decisions.md](./decisions.md) | **Normative rules**: [spec.md → Payment application rules](./spec.md#payment-application-rules)

All changes are **additive and forward-only** (constitution §3.2). Constraints Prisma cannot express are raw SQL in one migration (§3.3). Every constraint has a read-only pre-check that must return zero rows on each target database before deploy (§3.5, D-9). No existing row of a financial table is rewritten.

Status labels in this file:

- **EXISTING**: verified in code at `zaroorat-back@84cc104`; payment code is unchanged in the working tree.
- **PROPOSED**: this feature.
- **PENDING**: depends on an open decision.

## 1. Entities touched

| Entity (table)                                                | Today (EXISTING)                                                                                     | Change (PROPOSED)                                                                                                                                      | For                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Payment intent `payment_intents`                              | Free-text `status`; UNIQUE `idempotency_key`; `gateway_intent_id` **not unique**                     | New statuses `EXPIRED`, `MANUAL_REVIEW`; `CANCELLED` also means superseded; column `last_reconciled_at`; partial UNIQUE `(gateway, gateway_intent_id)` | INV-3, TD-11, TD-13 |
| Payment record `payment_transactions`                         | One row per transition; `gateway_txn_id` sometimes the **order id** (poll path, F-01); no uniqueness | Always the `pay_…` id; status `CAPTURED_REVIEW`; partial UNIQUE per provider payment; partial UNIQUE **one success per intent**                        | INV-2, INV-3        |
| Notification record `gateway_events`                          | UNIQUE `(gateway, gateway_event_id)`; a failure rolls back the row (nothing persisted)               | Columns `outcome`, `processing_attempts`, `last_error`, `last_attempt_at`; dedupe only on processed rows                                               | FR-021, FR-032      |
| Review case `payment_review_cases`                            | —                                                                                                    | **New table**                                                                                                                                          | TD-9                |
| Reconciliation run `payment_reconciliation_runs`              | — (`wallet_reconciliations` exists for wallet snapshots)                                             | **New table**                                                                                                                                          | TD-18, FR-033       |
| Commission wallet `driver_commission_wallets`                 | No CHECK                                                                                             | `CHECK (balance >= 0)` — **PENDING** Finance (D-2)                                                                                                     | INV-6               |
| Commission wallet txn `driver_commission_wallet_transactions` | Partial UNIQUE one `RIDE_COMMISSION` per ride; mutable                                               | Partial UNIQUE one `MANUAL_RECHARGE` per intent; append-only                                                                                           | INV-3, INV-5        |
| Ledger `payment_ledger_entries`                               | Balanced groups checked in code; mutable; no posting key                                             | Append-only; account `PAYMENT_SUSPENSE` — **PENDING** UD-2                                                                                             | INV-5               |
| Outbox `outbox_events`                                        | 8 attempts then `FAILED`; no requeue                                                                 | Conditional requeue (no schema change)                                                                                                                 | D-5                 |
| Subscription `driver_subscriptions`                           | Latest intent pointer only                                                                           | No schema change; one intent per pending subscription (behaviour, TD-11)                                                                               | FR-005              |

## 2. Payment intent

| Field                | Rule                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`             | `PENDING`, `PROCESSING` (legacy), `SUCCEEDED`, `FAILED`, `CANCELLED`, `EXPIRED`, `MANUAL_REVIEW`. `CREATED`, `REFUND_PENDING`, `REFUNDED` exist only on historical rows and are never written |
| `gateway_intent_id`  | The Razorpay order id; at most one intent per `(gateway, gateway_intent_id)`                                                                                                                  |
| `idempotency_key`    | Stored scoped: `subscription:{driverId}:{key}` (EXISTING), `recharge:{driverId}:{key}` (TD-6). The receipt is recomputed from it (TD-3), not stored                                           |
| `last_reconciled_at` | Nullable; reconciliation order `last_reconciled_at NULLS FIRST, created_at`                                                                                                                   |
| `user_id`            | The payer. The credited driver is always derived from it (`drivers.user_id`), never from provider data                                                                                        |

**Transitions** (the outcome column refers to spec rules A1–A12):

| From                                                | To            | Rule                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PENDING / PROCESSING / FAILED / EXPIRED             | SUCCEEDED     | A4 (EXPIRED → alert)                                                                                                                                                                                                                                            |
| PENDING / PROCESSING                                | FAILED        | A3                                                                                                                                                                                                                                                              |
| PENDING / PROCESSING / FAILED / EXPIRED / CANCELLED | MANUAL_REVIEW | A5 (amount or currency only: an order mismatch never moves this intent, decision R1), A6, A8 (A9 has no intent). A6 and A7 on a **SUCCEEDED** intent leave it SUCCEEDED; only the case and the hold row record the problem                                      |
| PENDING / FAILED                                    | EXPIRED       | FR-026 (> 5 days and nothing captured or authorized)                                                                                                                                                                                                            |
| PENDING / FAILED / EXPIRED (subscription)           | CANCELLED     | TD-11 supersession (plan change or expiry), under `SELECT … FOR UPDATE` on the old intent. Never from SUCCEEDED: then the subscription activates and no new intent is created                                                                                   |
| MANUAL_REVIEW                                       | SUCCEEDED     | Finance CREDIT (UD-1)                                                                                                                                                                                                                                           |
| MANUAL_REVIEW                                       | CANCELLED     | Finance REFUND resolution, or `RESOLVED_NO_ACTION` (only if UD-7 allows it). A terminal state, so the intent is never left "in review" after its case is closed. `GET /payments/intents/:id` reports it as `REFUNDED` when the linked case is `RESOLVED_REFUND` |
| SUCCEEDED                                           | —             | Downgrades are no-ops (A12); refunds use `refunds` (EXISTING)                                                                                                                                                                                                   |

## 3. Payment record (`payment_transactions`)

- `PAYMENT` rows written from now on always carry `gateway_txn_id = pay_…`.
- `CAPTURED_REVIEW` means captured at Razorpay and held for review; `amount` is the **provider-reported** amount.
  - CREDIT resolution moves the row to `SUCCEEDED`.
  - REFUND resolution keeps it as `CAPTURED_REVIEW` and links the refund.
- **Anchor indexes**:

```sql
-- INV-2: one applied-or-held record per Razorpay payment
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_provider_payment_key"
  ON "payment_transactions" ("gateway", "gateway_txn_id")
  WHERE "txn_type" = 'PAYMENT' AND "status" IN ('SUCCEEDED', 'CAPTURED_REVIEW') AND "gateway_txn_id" IS NOT NULL;

-- INV-3: one successful payment per intent
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_one_success_per_intent"
  ON "payment_transactions" ("intent_id")
  WHERE "txn_type" = 'PAYMENT' AND "status" = 'SUCCEEDED';
```

`admin` reconcile updates `variance_status` on these rows today (`finance.service.ts:324`), so this table is **not** append-only.

Interactions with the indexes:

- **Order mismatch (decision R1, 2026-10-21)**: never a hold row and never a status change on the claiming intent. The payment is routed to the intent that owns its order, or opens an `UNKNOWN_ORDER` case without intent; `verify` rejects it before the gate. A hold here would occupy `payment_transactions_provider_payment_key` and block the owner's own application.
- **A6 (`PAYMENT_ID_REUSED`)**: the `pay_…` id already has a SUCCEEDED row, so a `CAPTURED_REVIEW` row for it would violate `payment_transactions_provider_payment_key`. The case is opened **without** a hold row; `payment_review_cases.payment_transaction_id` points at the existing SUCCEEDED row.
- **A7 (`MULTIPLE_CAPTURES`)**: the extra payment has its own `pay_…` id and gets a `CAPTURED_REVIEW` row. Moving it to SUCCEEDED would violate `payment_transactions_one_success_per_intent`, so it can only be resolved as REFUND (decisions.md UD-1).
- **Concurrent duplicate** of any insert above: a unique violation (`P2002` / SQLSTATE `23505`) rolls back the whole transaction. The caller treats it as "already handled" and re-reads, never as a failure to retry forever.

## 4. Notification record (`gateway_events`)

| Field                 | Rule                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processed`           | `true` only after a terminal outcome is committed. It means "the webhook path will not process this event again". It does **not** mean that money moved; `outcome` says what happened                                                                                                                                         |
| `outcome`             | `APPLIED`, `STALE_IGNORED`, `TOO_OLD`, `MISMATCH`, `UNKNOWN_ORDER`, `NO_ACTION`, `PARKED` (terminal, `processed=true`); `PROCESSING_FAILED` (`processed=false`, retried by Razorpay). `PARKED` means `processing_attempts` reached `RAZORPAY_WEBHOOK_MAX_PROCESSING_ATTEMPTS` (TD-15a); its payment is left to reconciliation |
| `payload`             | Today, the full body, kept indefinitely (includes payer email, contact, VPA and card metadata). Future content and retention per **UD-10** (pending)                                                                                                                                                                          |
| `processing_attempts` | Incremented on every failed processing attempt with an atomic `processing_attempts = processing_attempts + 1`, so concurrent failures never lose a count                                                                                                                                                                      |
| `last_error`          | Sanitised error code and message (no body, no signature)                                                                                                                                                                                                                                                                      |
| `last_attempt_at`     | Time of the last attempt                                                                                                                                                                                                                                                                                                      |

Processing sequence (TD-15), inside one transaction:

1. `INSERT … ON CONFLICT (gateway, gateway_event_id) DO NOTHING`.
2. `SELECT … FOR UPDATE` on the event row. This serialises concurrent deliveries of the same event.
3. If `processed = true` → acknowledge as a duplicate.
4. Otherwise apply the age rule (D-1) and the payment application rules, then set the terminal outcome.

If step 4 throws, the transaction rolls back. A **separate** short transaction then upserts the event with `processed=false`, `outcome='PROCESSING_FAILED'`, attempts + 1 and the sanitised error, and the endpoint answers 5xx so Razorpay retries. The next delivery sees `processed=false` and processes again (FR-021). When attempts reach the limit, that separate transaction sets `outcome='PARKED'`, `processed=true` and the endpoint answers 200 (FR-034).

Today's code differs in two ways (research R-11):

- `findOrPersist` is check-then-insert, not `ON CONFLICT` (`webhook.repository.ts:21-41`), so two concurrent deliveries of one event make the second fail with a unique violation.
- Nothing is persisted on failure, because the whole transaction rolls back.

Event deduplication (this table) and payment-effect deduplication (§3, §8) are **separate layers**. Different events about the same payment (`payment.captured`, `order.paid`) pass event deduplication and are stopped by the intent lock and the anchor indexes.

## 5. Review case (`payment_review_cases`) — new

| Field                                                 | Type                  | Rule                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                  | uuid PK (v7)          |                                                                                                                                                                                                                                                                                                                                    |
| `kind`                                                | text                  | `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `ORDER_MISMATCH` (**reserved**: kept in the `payment_review_cases_kind_check` constraint, but no code path opens it since decision R1; an order mismatch is rejected or routed instead), `PAYMENT_ID_REUSED`, `MULTIPLE_CAPTURES`, `UNMATCHED_CAPTURE`, `UNKNOWN_ORDER`, `EXTERNAL_REFUND` |
| `status`                                              | text                  | `OPEN` → `RESOLVED_CREDIT` / `RESOLVED_REFUND` / `RESOLVED_NO_ACTION`. `RESOLVED_NO_ACTION` is for `EXTERNAL_REFUND` only, and only once UD-7 defines how such a case is resolved. Until then an `EXTERNAL_REFUND` case stays `OPEN` and is escalated                                                                              |
| `intent_id`                                           | uuid FK, **nullable** | null only for `UNKNOWN_ORDER`                                                                                                                                                                                                                                                                                                      |
| `payment_transaction_id`                              | uuid FK, nullable     | the `CAPTURED_REVIEW` row                                                                                                                                                                                                                                                                                                          |
| `gateway`, `provider_payment_id`, `provider_order_id` | text                  | `provider_payment_id` always present                                                                                                                                                                                                                                                                                               |
| `expected_amount`, `observed_amount`                  | numeric(12,2)         | rupees                                                                                                                                                                                                                                                                                                                             |
| `expected_currency`, `observed_currency`              | char(3)               |                                                                                                                                                                                                                                                                                                                                    |
| `evidence`                                            | jsonb                 | sanitised: `id, order_id, amount, currency, status, method, captured, amount_refunded, created_at` — no contact, email, VPA or card data                                                                                                                                                                                           |
| `refund_id`                                           | uuid FK, nullable     | set on REFUND resolution                                                                                                                                                                                                                                                                                                           |
| `resolved_by`, `resolved_at`, `resolution_note`       |                       | required when status ≠ OPEN (CHECK constraints)                                                                                                                                                                                                                                                                                    |
| `created_at`, `updated_at`                            | timestamptz           |                                                                                                                                                                                                                                                                                                                                    |

Constraints: `UNIQUE (kind, provider_payment_id)` (opening the same case twice is a no-op); index `(status, created_at)`. Resolution is a conditional claim, `UPDATE … WHERE id = $1 AND status = 'OPEN'` (§5.2).

## 6. Reconciliation run (`payment_reconciliation_runs`) — new

| Field                        | Rule                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | uuid PK                                                                                                                                                                                                       |
| `job`                        | `INTENT_RECONCILIATION`, `SUBSCRIPTION_RECONCILIATION`, `PROVIDER_SWEEP`, `WALLET_RECONCILIATION`, `REFUND_RECONCILIATION`                                                                                    |
| `window_start`, `window_end` | Provider sweep window; null for the others. `window_start` = the earlier of (now − 48 h) and (the last SUCCEEDED sweep's `window_end` − 30 min); `window_end` = now. An outage therefore never skips payments |
| `started_at`, `finished_at`  |                                                                                                                                                                                                               |
| `status`                     | `RUNNING`, `SUCCEEDED`, `FAILED`                                                                                                                                                                              |
| `counts`                     | jsonb (scanned, applied, held, expired, errors)                                                                                                                                                               |
| `error`                      | sanitised, nullable                                                                                                                                                                                           |

Index `(job, finished_at DESC)`. It is the job heartbeat for FR-033 and the evidence store for SC-006. Rows are append-only in practice: the job updates only its own `RUNNING` row to a terminal status.

## 7. Commission wallet

```sql
ALTER TABLE "driver_commission_wallets"            -- PENDING Finance (D-2)
  ADD CONSTRAINT "driver_commission_wallets_balance_non_negative" CHECK ("balance" >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS "commission_wallet_one_credit_per_intent"
  ON "driver_commission_wallet_transactions" ("reference_id")
  WHERE "txn_type" = 'MANUAL_RECHARGE';
```

EXISTING: `creditInTx` writes `MANUAL_RECHARGE` with `reference_id` = intent id (`intent.service.ts:229-233`). Review CREDIT uses the same reference, so the index also covers it.

## 8. Ledger and exactly-once effects

- Append-only triggers (TD-10) on `payment_ledger_entries` and `driver_commission_wallet_transactions`. They reuse the EXISTING `reject_audit_mutation()` function, add truncate guards with a transaction-local `zaroorat.allow_financial_truncate` escape for the test harness, and use `ENABLE ALWAYS`.
- Privilege layer (TD-10, same guarded block as migration `20261002130100`): `REVOKE UPDATE, DELETE, TRUNCATE ON "payment_ledger_entries", "driver_commission_wallet_transactions" FROM zaroorat_app_runtime`. It is effective only if the API connects through that role (SEC-7, Q10).
- **Transaction scope (INV-4).** A recharge credit commits the payment row, ledger group, wallet balance, wallet transaction and outbox event together. A subscription payment commits the payment row, ledger group and `DRIVER_SUBSCRIPTION_PAYMENT_COMPLETED` outbox event together. Activation (`activateIfPending`, a conditional claim) runs later in the consumer, or in the recovery job if the consumer fails.
- `PAYMENT_SUSPENSE` (UD-2, PENDING): `GATEWAY_CLEARING DR / PAYMENT_SUSPENSE CR` on hold; released by CREDIT (`PAYMENT_SUSPENSE DR / purpose account CR`) or REFUND (refund legs sourced from suspense). Until UD-2 is approved, a hold writes no ledger group and reconciliation reports it. If UD-2 chooses another option, it must also define the refund legs for held money; no held payment can be resolved before that.

**Anchor rows (TD-17)**: every effect commits with a uniquely indexed row, so a duplicate attempt fails as a whole.

| Effect                        | Anchor (unique)                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| Apply a payment (any purpose) | `payment_transactions` SUCCEEDED per provider payment **and** per intent                      |
| Wallet credit                 | `MANUAL_RECHARGE` per intent                                                                  |
| Subscription activation       | Conditional claim `PENDING_PAYMENT → ACTIVE` + `driver_subscriptions_one_active` (EXISTING)   |
| Hold for review               | `payment_transactions` CAPTURED_REVIEW per provider payment + review case per (kind, payment) |
| Ride commission               | `RIDE_COMMISSION` per ride (EXISTING)                                                         |
| Refund                        | `refunds.idempotency_key`, `refunds.gateway_refund_id` (EXISTING) + refund row lock           |
| Webhook event                 | `gateway_events (gateway, gateway_event_id)` (EXISTING)                                       |

**Two workers, one payment.** A webhook and the reconciliation job see the same captured payment at the same moment:

1. Each fetches or parses the provider record **outside** any transaction (§8).
2. Each opens a transaction and runs `SELECT … FOR UPDATE` on the intent. Worker A gets the lock; worker B waits.
3. A validates (rule A4), inserts the SUCCEEDED payment row, credits the wallet, posts the ledger, writes the outbox event, and commits.
4. B now gets the lock, reads status SUCCEEDED with the same `pay_…` id, and exits as a no-op (A11).
5. If a bug skipped the lock, B's insert would violate `payment_transactions_one_success_per_intent` (or the provider-payment index). B's whole transaction, including any wallet and ledger writes, would roll back.

Redis is not involved in this guarantee.

**Database failure between capture and recording.** Nothing is written, so Razorpay's money is not yet reflected. Recovery comes from Razorpay webhook retries (accepted up to 72 h), the intent reconciliation (every 10 min), and the provider sweep (every 30 min). All of them run the same rules. Nothing is marked failed meanwhile (INV-8).

## 9. Provider status mapping

| Razorpay payment `status` | Meaning for us                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `created`                 | Pending (A2)                                                                                                                                                                   |
| `authorized`              | Pending; alert if older than 30 min (auto-capture expected); Razorpay auto-refunds if never captured                                                                           |
| `captured`                | Candidate for A4, or review (A5–A10)                                                                                                                                           |
| `failed`                  | A3                                                                                                                                                                             |
| `refunded`                | If we applied it: must match our refund records, else `EXTERNAL_REFUND`. If we never applied it: no credit; if no captured sibling exists, the intent follows the expiry rules |

| Razorpay refund `status` | Meaning for us (EXISTING lifecycle) |
| ------------------------ | ----------------------------------- |
| `pending`                | PROCESSING (keep reserved)          |
| `processed`              | SUCCEEDED                           |
| `failed`                 | FAILED (reservation restored)       |

## 10. Captured-payment tracking (INV-7)

For every Razorpay payment with `captured = true` seen by the provider sweep, exactly one of the following holds:

| State                  | Evidence                                                     |
| ---------------------- | ------------------------------------------------------------ |
| **Applied**            | `payment_transactions` SUCCEEDED with this `pay_…` id        |
| **Held**               | `payment_transactions` CAPTURED_REVIEW + an OPEN review case |
| **Refund in progress** | `refunds` PROCESSING for this payment                        |
| **Refunded**           | `refunds` SUCCEEDED covering `amount_refunded`               |

Anything else means the sweep opens a case. A pending-but-captured intent is applied through the rules. The sweep's per-run counts are stored in `payment_reconciliation_runs`.

## 11. Outbox dead-letter requeue

`UPDATE outbox_events SET status='PENDING', retries=0, next_attempt_at=now(), claim_token=NULL, claimed_at=NULL WHERE id=$1 AND status='FAILED'`

- Allowed for event types of the payments and subscriptions catalogs only.
- A `recordAdminAction` audit row is written in the same transaction.
- A count of 0 means it was already requeued.
- Consumers are idempotent (§7.3).

## 12. Pre-migration data checks (read-only, D-9)

| Q   | Purpose                                                                                                                                                                                                                                                                                                                                                                 | Blocks                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Duplicate `(gateway, gateway_intent_id)` among non-null                                                                                                                                                                                                                                                                                                                 | Order-id index                                                                                                                   |
| Q2  | SUCCEEDED recharge intents with no `MANUAL_RECHARGE` row (paid but not credited)                                                                                                                                                                                                                                                                                        | Finance remediation                                                                                                              |
| Q3  | Duplicate `MANUAL_RECHARGE` per `reference_id`                                                                                                                                                                                                                                                                                                                          | Recharge index                                                                                                                   |
| Q4  | Duplicate SUCCEEDED PAYMENT `(gateway, gateway_txn_id)`; count of SUCCEEDED rows whose id is not `pay\_%` (UD-8)                                                                                                                                                                                                                                                        | Provider-payment index                                                                                                           |
| Q5  | `driver_commission_wallets.balance < 0`                                                                                                                                                                                                                                                                                                                                 | CHECK                                                                                                                            |
| Q6  | PENDING_PAYMENT subscriptions whose intent SUCCEEDED; SUCCEEDED subscription intents referenced by no subscription                                                                                                                                                                                                                                                      | Finance remediation                                                                                                              |
| Q7  | `outbox_events` FAILED by event type                                                                                                                                                                                                                                                                                                                                    | Ops follow-up                                                                                                                    |
| Q8  | Unbalanced ledger groups                                                                                                                                                                                                                                                                                                                                                | Finance remediation                                                                                                              |
| Q9  | Intents with more than one SUCCEEDED PAYMENT row                                                                                                                                                                                                                                                                                                                        | One-success-per-intent index                                                                                                     |
| Q10 | The role the API connects as (`SELECT current_user, pg_has_role(current_user, 'zaroorat_app_runtime', 'member')`, run through the API's own `DATABASE_URL`)                                                                                                                                                                                                             | SEC-7; the REVOKE layer                                                                                                          |
| Q11 | PENDING/PROCESSING/FAILED intents grouped by gateway, purpose and age (< 1 day, 1–5 days, > 5 days), plus the gateway currently active in each environment. Open `CUSTOMER_WALLET_TOPUP` intents with a Razorpay order trigger UD-11. A non-zero `gateway = 'razorpay'` count means the current app has been creating real Razorpay orders on each Pay tap (R-11 CD-17) | Sizes the first reconciliation and expiry runs against Razorpay rate limits; shows whether the interim T035 deployment is urgent |

Q8 is the only integrity check possible for the append-only tables. Neither has an `updated_at`, so edits made in the past cannot be detected; the triggers prevent future ones.

## 13. Migration order and compatibility

1. Run the pre-checks. Create large indexes `CONCURRENTLY` by hand where needed (§3.4); the migration uses `IF NOT EXISTS`.
2. Migration (T020): nullable columns, two new tables, partial unique indexes, triggers, the guarded REVOKE. The CHECK goes in only if D-2 is confirmed by then; otherwise it is a follow-up migration (T020b). The previous app version keeps working:
   - it never writes a second success for an intent or payment;
   - it never updates the ledger;
   - it never writes negative balances.
3. Deploy the code that uses the new columns, statuses and tables.
4. UD-8 backfill, only if Q4 > 0, as a separate approved task.

## 14. Reconciliation records (what each job compares)

Every run writes one `payment_reconciliation_runs` row (§6). Mismatches are reported and alerted, never auto-corrected, except where the payment application rules apply a payment.

| Job (interval)                                      | Compares                                                                                                                                                                                                                                       | Source of truth | Mismatch →                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------ |
| Intent reconciliation (10 min)                      | Open intents (PENDING, PROCESSING, FAILED ≤ 5 days) ↔ `GET /orders/{id}/payments`                                                                                                                                                              | Razorpay        | Rules A2–A9 (apply, review, expire)                    |
| Provider sweep (30 min, 48 h window)                | Razorpay captured payments ↔ `payment_transactions` / `refunds`                                                                                                                                                                                | Razorpay        | §10 states; otherwise a case (A9, A10) or apply        |
| Subscription recovery (5 min)                       | PENDING_PAYMENT subscriptions ↔ SUCCEEDED subscription intents                                                                                                                                                                                 | Our intents     | Activate (conditional claim)                           |
| Wallet reconciliation (hourly)                      | Each commission, customer and earnings wallet balance ↔ Σ its transactions ↔ ledger position after cut-over; keyset scan over **all** wallets (today: the first 100 customer and 100 earnings wallets only, no commission wallets, R-11 CD-19) | Ledger          | Alert + run counts; Finance investigates               |
| Refund reconciliation (5 min + `refund.*` webhooks) | PROCESSING refunds ↔ `GET /payments/{id}/refunds`                                                                                                                                                                                              | Razorpay        | Settle or restore the reservation (existing lifecycle) |
| Daily INV-7 report (T068)                           | Yesterday's captured payments ↔ the four tracked states                                                                                                                                                                                        | Razorpay        | SC-006 counts; page if non-zero                        |
