---
description: 'Implementation tasks for Payment & Fare Settlement'
---

# Tasks: Payment & Fare Settlement

**Input**: [plan.md](./plan.md) · [spec.md](./spec.md) · [decisions.md](./decisions.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md)

**Constitution**: v1.0.0 **RATIFIED** — every REQUIRED rule is mandatory.

**Decisions**: BD-1 … BD-7 **APPROVED**. No task may alter a financial policy; where a task encodes one it cites the decision.

**Tests**: Included and **ordered first within each phase**. This feature moves money; every success criterion is an assertion about correctness under retry and concurrency.

## Verified codebase state (task baseline)

Tasks are written against the current working tree, verified 2026-08-23:

| Fact                 | Value                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- |
| Payout API           | `POST /api/v1/admin/payments/payouts` — verified serving, 20/20 green                   |
| `PayoutService`      | **Unchanged**; reuse as-is, do not modify                                               |
| Fare calculation     | `src/modules/pricing/services/pricing.service.ts`                                       |
| Unit suite           | **864/864 green**                                                                       |
| Integration baseline | **17 known failures — NOT caused by Payment and NOT to be encoded as Payment failures** |

**Pre-existing integration failures (do not attribute to Payment work):**

- **14 × `earnings-pipeline`** — confirmed `INCOMPLETE_PROFILE` baseline. T019 fixes the fixture that causes them.
- **1 × `authorization-bola`** — same confirmed baseline.
- **2 × `vehicle-catalog`** — regression owned by the incomplete pricing extraction (catalog no longer returns per-type pricing; `pricing_rules` unseeded). **Out of scope for these tasks.**

## Format

```text
TID [P?] [Story?] Objective — `exact/file/path`
  - **Reuse** · **Depends** · **Tx/Concurrency** · **Test** · **Accept**
```

`[P]` = parallelisable (different files, no incomplete dependency).

---

## Phase 1: Setup — Configuration

**Purpose**: Boot-validated configuration. No behaviour change.

- [x] T001 Add the five numeric payment knobs via `numericEnv` — `src/config/payment/payment.config.ts`
  - **Reuse**: `numericEnv` (`src/config/env/numeric.ts`)
  - **Accept**: `PAYMENT_COLLECTION_MAX_ATTEMPTS` (1–20, int), `PAYMENT_COLLECTION_RETRY_BASE_SEC` (30–86400, int), `PAYMENT_RIDER_DEBT_LIMIT` (≥0), `PAYMENT_CASH_CONFIRM_GRACE_SEC` (≥60, int), `PAYMENT_RECEIVABLE_WRITEOFF_DAYS` (≥1, int). Each throws at boot on `NaN`/non-numeric/out-of-range (constitution §12.1)

- [x] T002 Add the cash feature flag, **default OFF** — `src/config/payment/payment.config.ts`
  - **Reuse**: boot-time throw pattern of `readWebhookSecret` in the same file
  - **Depends**: T001
  - **Accept**: `PAYMENT_CASH_CONFIRMATION_REQUIRED` reads logic equivalent to `=== 'true'`, defaulting `false` per **BD-5**. **Deliberate deviation from the house `!== 'false'` idiom** (which defaults ON) — carry a comment saying so; following the idiom would silently invert an approved decision

- [x] T003 Add the ledger cut-over timestamp — `src/config/payment/payment.config.ts`
  - **Reuse**: `readWebhookSecret` throw-at-boot precedent
  - **Depends**: T001
  - **Accept**: `PAYMENT_LEDGER_CUTOVER_AT` parsed as ISO-8601; unparseable value throws at boot (**BD-7**). Not `numericEnv` — it is not numeric

- [x] T004 [P] Convert the two existing bare-`Number()` reads to `numericEnv` — `src/config/payment/payment.config.ts`
  - **Depends**: T001
  - **Accept**: `idempotencyTtlSeconds` and `webhookToleranceSeconds` validated; no bare `Number(process.env…)` remains in the file (constitution §12.2)

- [x] T005 [P] Document all seven knobs — `.env.example`
  - **Depends**: T001–T003
  - **Accept**: each knob has default, bounds and its governing BD id (constitution §12.4)

- [x] T006 [P] Unit-test the configuration — `tests/unit/payments/payment-config.test.ts`
  - **Depends**: T001–T004
  - **Test**: each numeric knob rejects `NaN`, non-numeric and out-of-range; **cash flag defaults to `false`**; cut-over rejects an unparseable date
  - **Accept**: a missing `PAYMENT_CASH_CONFIRMATION_REQUIRED` yields `false`, and `'false'` also yields `false`

**Checkpoint**: configuration validated at boot; no runtime behaviour changed.

---

## Phase 2: Foundational — Schema, Repository, Contracts

**⚠️ BLOCKING — no user story may begin until this phase completes.**

### Migrations (5 — count fixed by plan.md; all additive; BD-7 forbids historical rewrite)

- [x] T007 Migration: one `SUCCEEDED` payment per ride — `prisma/migrations/<ts>_ride_payment_unique_success/migration.sql`
  - **Objective**: partial unique index `ride_payments_ride_id_succeeded_key` on `("ride_id") WHERE "status" = 'SUCCEEDED'`
  - **Reuse**: raw-SQL partial-index precedent `20260821130000_ride_active_uniqueness`
  - **Tx/Concurrency**: **this index is the exactly-once guarantee** (constitution §5.4); the Redis lock is only an optimisation
  - **Accept**: `IF NOT EXISTS`; file documents the `CREATE INDEX CONCURRENTLY` pre-step for large tables (§3.4). Backward-compatible — nothing writes `ride_payments` today

- [x] T008 Migration: wallet balance floor — `prisma/migrations/<ts>_customer_wallet_balance_floor/migration.sql`
  - **Objective**: `CHECK (balance >= 0)` and `CHECK (locked_balance >= 0 AND locked_balance <= balance)`
  - **Accept**: FR-003. Backward-compatible — the previous version has no debit path and `hold` already refuses to over-lock

- [x] T009 **Pre-flight**: verify T008's constraints hold against the target database before deploy — no file
  - **Reuse**: constitution §3.5 (never assume a table is clean)
  - **Depends**: T008
  - **Accept**: recorded query result showing zero rows with `balance < 0` or `locked_balance > balance`

- [x] T010 [P] Migration: sweep support — `prisma/migrations/<ts>_ride_payment_sweep_index/migration.sql`
  - **Objective**: index on `ride_payments ("status", "created_at")` for the retry and write-off sweeps

- [x] T011 [P] Migration: rider outstanding-debt aggregate — `prisma/migrations/<ts>_rides_customer_payment_status_index/migration.sql`
  - **Objective**: index on `rides ("customer_id", "payment_status")`
  - **Accept**: BD-2 aggregate is read on **every ride request**; `rides` is the largest table

- [x] T012 [P] Migration: one write-off per ride — `prisma/migrations/<ts>_ride_payment_unique_writeoff/migration.sql`
  - **Objective**: partial unique index on `("ride_id") WHERE "status" = 'WRITTEN_OFF'`
  - **Accept**: **BD-1c** requires duplicate write-offs be structurally impossible, not merely unlikely

### Repositories and shared contracts

- [x] T013 Create `RidePaymentRepository` — `src/modules/payments/repositories/ride-payment.repository.ts`
  - **Objective**: `create`, `findByRideId`, `findSucceededForRide`, `findWrittenOffForRide`, `countAttempts`, `findRetryable(now, limit)`, `findOutstandingForCustomer(customerId)`
  - **Reuse**: existing repository shape — `tx?: TransactionClient` as the last parameter throughout
  - **Why new**: no repository exists for `ride_payments`; the table is written by nothing today
  - **Accept**: lives in **payments**, not rides — constitution §1.4, the rule `SettlementWalletRepository` documents

- [x] T014 Register the repository in DI — `src/modules/payments/index.ts`
  - **Reuse**: `asClass(...).singleton()` + `aliasTo` convention already in the file
  - **Depends**: T013
  - **Accept**: `ridePaymentRepository` registered with a `ridePaymentRepo` alias. Constructor parameter names match registration keys (constitution §1.3 — **resolution is by parameter name**)

- [x] T015 Add `claimPaymentStatusIf` — `src/modules/rides/repositories/ride.repository.ts`
  - **Objective**: conditional `updateMany` claiming `paymentStatus` from an expected prior value, returning whether the claim won
  - **Reuse**: the existing conditional-claim pattern of `updateStatusIf` and `RideDispatchRepository.respondIfPending`
  - **Why new**: verified — `updateStatusIf` claims on **ride status** and can only _set_ `paymentStatus` as extra data; nothing can claim on `paymentStatus` itself
  - **Tx/Concurrency**: **the single-winner mechanism for every collection transition** (constitution §5.2)
  - **Accept**: no new locking or idempotency mechanism introduced

- [x] T016 [P] Add ledger account constants — `src/modules/payments/constants/payment.constants.ts`
  - **Objective**: `CUSTOMER_WALLET`, `DRIVER_PAYABLE`, `GATEWAY_CLEARING`, `PLATFORM_COMMISSION`, **`CUSTOMER_RECEIVABLE`**, **`BAD_DEBT_EXPENSE`**
  - **Accept**: **verified — `PaymentLedgerEntry.account` is a plain `String` column, so NO migration is required for the two new accounts.** Constants exist to prevent typos in an unconstrained column

- [x] T017 [P] Add the three new event types — `src/modules/payments/events/catalog.ts`
  - **Objective**: `payment.ride.collected`, `payment.ride.collection_failed`, `payment.receivable.written_off`; extend the `classification` keyword rule so all three classify `audit`
  - **Accept**: exactly **3** new events (contracts/events.md). `payment.wallet.debited` already exists — reuse it, do not redefine. No `payment.debt.recorded` (cut for duplicate meaning, constitution §7.6)

- [x] T018 [P] Add coded errors — `src/modules/payments/errors/payment.errors.ts`
  - **Objective**: `RidePaymentNotFoundError` (404), `CollectionNotRetryableError` (409), `ObligationWrittenOffError` (409), `CashConfirmationNotApplicableError` (409), `RiderDebtLimitExceededError` (409)
  - **Reuse**: extend the existing `PaymentError` base carrying `code` + `statusCode`; `handlePaymentError` needs no change (constitution §13.1–13.3)

- [x] T019 **Fix the rider-profile fixture gap** — `tests/integration/helpers/fixtures.ts`
  - **Objective**: set a profile first/last name on riders so ride booking stops returning `422 INCOMPLETE_PROFILE`
  - **Accept**: resolves the **15 pre-existing baseline failures** (14 `earnings-pipeline`, 1 `authorization-bola`) by letting assertions execute for the first time. **This is the only "make it pass" change in the feature** — constitution §15.3 is otherwise absolute. Do not weaken any assertion

- [x] T020 [P] Add the derived `collectionState` projection — `src/modules/payments/services/collection/collection-state.ts`
  - **Objective**: pure function mapping `(Ride.paymentStatus, method, attempt rows, attempt cap)` → `AWAITING_COLLECTION | AWAITING_CASH_CONFIRMATION | RETRYING | PAID | UNPAID | WRITTEN_OFF`, plus `amountOwed`
  - **Accept**: computed per request, **never stored** (data-model §2.2). **`FAILED` must never be emitted publicly** (FR-041)

**Checkpoint**: schema constraints in place, `RidePayment` writable, payment status claimable, fixtures able to book a ride.

---

## Phase 3: User Story 1 — Wallet balance is backed by real payment (P1) 🎯 MVP

**Goal**: a wallet balance rises only against a provider-confirmed payment, and agrees with the ledger.

**Independent test**: request a top-up with no payment behind it and observe no balance change; confirm a real payment and observe it rise exactly once.

**Why first**: not because money is being stolen — the finding is class B, not exploitable today — but because US2 adds the debit path that would make it exploitable. **Shipping US2 before US1 is the one ordering that must not happen.**

### Tests (write first — they must fail against current code)

- [x] T021 [P] [US1] **RT-1 + RT-2** wallet funding integrity — `tests/integration/wallet-funding.test.ts`
  - **Test**: an authenticated `POST /wallet/topup` with no confirmed provider payment does **not** increase the balance; a gateway-confirmed intent credits exactly once; a duplicate webhook credits zero more times
  - **Accept**: fails on current code at step 1 (today it returns a credited balance)

- [x] T022 [P] [US1] **RT-4** balance ≡ ledger — `tests/integration/wallet-funding.test.ts`
  - **Test**: after any funding, `SUM(customer_wallets.balance)` equals the ledger `CUSTOMER_WALLET` position to the paise

- [x] T023 [P] [US1] Concurrent spend safety — `tests/integration/wallet-funding.test.ts`
  - **Tx/Concurrency**: two concurrent spends via `Promise.all` (constitution §14.1)
  - **Accept**: exactly one succeeds; balance never negative; the DB CHECK from T008 is the backstop

- [x] T024 [P] [US1] Debit sign convention — `tests/unit/payments/wallet-debit.test.ts`
  - **Test**: `debit` records a **negative** `CustomerWalletTransaction.amount`
  - **Accept**: guards the single most likely subtle bug — `ReconciliationJob` sums this column, and a positive debit reports a mismatch on correct data

- [x] T025 [P] [US1] Overdraw rejection — `tests/unit/payments/wallet-debit.test.ts`
  - **Accept**: a debit exceeding available balance throws `InsufficientBalanceError` and mutates nothing

### Implementation

- [x] T026 [US1] ~~Add `debit` to the wallet repository~~ — **folded into T027**. The repository already exposes `lockForUpdate` + `updateBalances` + `recordTransaction`, and `hold`/`releaseHold` compose exactly those three in the _service_. A repository `debit` would have been a fourth wrapper over the same three calls with one caller, against the house pattern.
  - **Reuse**: existing `lockForUpdate` + `updateBalances` + `recordTransaction`
  - **Tx/Concurrency**: **row-locks the wallet before read-modify-write** (constitution §5.1)
  - **Depends**: T008
  - **Accept**: records a negative transaction amount; never drives balance below zero

- [x] T027 [US1] Add `debit` to the wallet service — `src/modules/payments/services/wallet/wallet.service.ts`
  - **Reuse**: `TransactionManager.execute`, `LedgerService.postTransactionGroup`, existing `payment.wallet.debited` event
  - **Tx/Concurrency**: balance mutation + ledger group + event in **one transaction** (constitution §4.1)
  - **Depends**: T026, T016
  - **Accept**: publishes `payment.wallet.debited` (already in the catalog — no new event)

- [x] T028 [US1] Credit the wallet on provider confirmation — `src/modules/payments/services/intent/intent.service.ts`
  - **Objective**: move the balance mutation into `applyConfirmation`, where the `CUSTOMER_WALLET` ledger credit is **already** posted
  - **Tx/Concurrency**: same transaction as the ledger entry, so the two can no longer diverge (FR-036 discharged structurally)
  - **Depends**: T027
  - **Accept**: driven by the **webhook** path; a client-initiated confirm must not be the only thing that can credit

- [x] T029 [US1] Reshape `POST /wallet/topup` to create a funding intent — `src/modules/payments/controllers/wallet.controller.ts`, `src/modules/payments/schemas/payment.schemas.ts`
  - **Reuse**: existing `withIdempotency`; existing `createIntent`
  - **Depends**: T028
  - **Accept**: response is **additive — no existing field removed**; `balance` reports the current _uncredited_ balance. Behaviour changes (it no longer increases); shape does not

- [x] T030 [US1] ~~Make `WalletService.topup` unreachable from HTTP~~ — **deleted instead**. Once confirmation credits through `creditInTx`, `topup` had no caller at all; leaving an unreachable balance-minting method in the service is the hazard this story exists to remove.
  - **Depends**: T028, T029
  - **Accept**: callable only from the confirmation path

- [x] T031 [US1] **Remove client-supplied `rideId`** from the public intent schema — `src/modules/payments/schemas/payment.schemas.ts`
  - **Objective**: a client may fund a wallet; it may not declare which ride its payment settles
  - **Accept**: closes the fare-bypass hole (research §12, FR-012). Server-authoritative (constitution §9.1)

- [x] T032 [US1] **Close the idempotency gap on confirm** — `src/modules/payments/controllers/intent.controller.ts`
  - **Objective**: route `confirmIntent` through `PaymentService.withIdempotency`
  - **Reuse**: the existing Redis `IdempotencyRepository` — **do not activate the unused `IdempotencyKey` Prisma model** (constitution §6.4/§6.5)
  - **Accept**: FR-040. Verified: `withIdempotency` has exactly five call sites and this route is not one of them

- [x] T033 [US1] Verify the route inventory is unchanged — `tests/integration/route-graph.test.ts`
  - **Accept**: all new routes authenticated; `SANCTIONED_PUBLIC` allow-list **untouched** (constitution §10.2)

**Checkpoint**: the funding hole is closed and the balance provably tracks the ledger. **Shippable alone.**

---

## Phase 4: User Story 2 — A completed ride is actually paid for (P2)

**Goal**: every completed ride reaches a terminal payment outcome, charging the rider exactly once.

**Independent test**: complete a wallet ride and a card ride; each ends with a payment record, a moved balance, and balanced books.

### Tests

- [x] T034 [P] [US2] Wallet collection happy path — `tests/integration/ride-collection.test.ts`
  - **Reuse**: `drainOutbox()` from `tests/integration/helpers/harness.ts` — collection is a consumer, so do not assert immediately after completion
  - **Accept**: one `SUCCEEDED` `RidePayment`; balance reduced by exactly the fare; negative wallet transaction; ledger group sums to zero and debits `CUSTOMER_WALLET`

- [x] T035 [P] [US2] **Race 12** — duplicate outbox delivery — `tests/integration/ride-collection.test.ts`
  - **Tx/Concurrency**: replay the same `ride.completed` envelope
  - **Accept**: still one `RidePayment`, balance unmoved

- [x] T036 [P] [US2] Card ride posts the **correct account** — `tests/integration/ride-collection.test.ts`
  - **Accept**: debits `GATEWAY_CLEARING`, **not** `CUSTOMER_WALLET` (FR-037); the rider's wallet position is untouched

- [x] T037 [P] [US2] **RT-3** server-authoritative amount — `tests/integration/ride-collection.test.ts`
  - **Accept**: a client-supplied amount and a client-created intent are both ignored; the charge equals the server-computed fare

- [x] T038 [P] [US2] Decline → `RETRYING`, cap → `UNPAID` — `tests/integration/ride-collection.test.ts`
  - **Accept**: ride still `COMPLETED`, driver back `ONLINE` (FR-014). Public state reads `RETRYING` while budget remains, `UNPAID` after exhaustion — **never `FAILED`**

- [x] T039 [P] [US2] **Races 4, 5, 11** — success vs failure, retry vs retry, lifecycle vs collection — `tests/integration/ride-collection.test.ts`
  - **Tx/Concurrency**: genuine `Promise.all`
  - **Accept**: exactly one charge in every interleaving

- [x] T040 [P] [US2] **Race 6** — settling a receivable must not double-count — `tests/integration/payment-receivable.test.ts`
  - **Accept**: settling clears `CUSTOMER_RECEIVABLE` only; `DRIVER_PAYABLE` and `PLATFORM_COMMISSION` are **not** credited a second time. **The highest-value assertion in the feature**

- [x] T041 [P] [US2] ~~Collection service unit behaviour~~ — **folded into the integration suite**. All four acceptance points (method routing, attempt capping, amount copied from fare, 7a vs 7b ledger selection) are asserted against a real database in `ride-collection.test.ts` and `payment-receivable.test.ts`. A mock-based restatement of the same four would duplicate the assertions while proving less.
  - **Accept**: method routing; attempt capping; amount copied from fare, never recomputed; 7a vs 7b ledger selection

- [x] T042 [P] [US2] Consumer envelope handling — `tests/unit/payments/ride-collection-consumer.test.ts`
  - **Accept**: reads `rideId` from `envelope.data` — `buildEnvelope` drops `aggregateId` and `subject.userId` is null for ride events (constitution §7.4)

- [x] T043 [P] [US2] `collectionState` derivation — `tests/unit/payments/collection-state.test.ts` — **written with T020**; covers the full mapping table and pins that `FAILED` is never emitted
  - **Accept**: full mapping table; `FAILED` never emitted publicly

### Implementation

- [x] T044 [US2] Create `RideCollectionService` — `src/modules/payments/services/collection/collection.service.ts`
  - **Objective**: `collect(rideId)` — claim, branch on method, perform any provider call **outside** the transaction, then write `RidePayment` + claim `paymentStatus` + post ledger + publish event in one transaction
  - **Reuse**: `LockStore` (`payment:collect:{rideId}`), `TransactionManager`, `LedgerService`, `RidePaymentRepository`, `claimPaymentStatusIf`
  - **Tx/Concurrency**: **provider I/O never inside a transaction** (constitution §8.1); the partial unique index is the guarantee, the Redis lock only avoids wasted work (§5.3); provider idempotency key derived deterministically from the ride id (§8.3)
  - **Depends**: T013, T015, T016, T027
  - **Accept**: reads `RideFare.totalFare`; accepts no amount from any request body

- [x] T045 [US2] Post the **correct ledger account per method** — `src/modules/payments/services/ledger/ledger.service.ts`
  - **Objective**: wallet → `CUSTOMER_WALLET`; card/UPI → `GATEWAY_CLEARING`; cash → `DRIVER_PAYABLE` debit of commission
  - **Depends**: T016
  - **Accept**: FR-037. Every group balances (constitution §4.3)

- [x] T046 [US2] **Move `recordTripPayment` out of ride completion** — `src/modules/rides/services/lifecycle/lifecycle.service.ts`
  - **Objective**: the ledger must not assert a payment that has not happened (FR-038)
  - **Depends**: T044, T045
  - **Accept**: **this is one of exactly two changes permitted in `LifecycleService`.** Dispatch, status transitions, driver release, OTP, plausibility checks and the published event payload are untouched.
  - **DEVIATION — `ledgerService` stays injected.** The plan expected the dependency to be removable, but data-model §2.3 transition **4c** puts the cash commission group _in the completion transaction_: with BD-5's flag off a cash ride is paid the instant it ends, so there is a real payment to record there. Only the non-cash branch moved. The call is now guarded by `paymentMethod === 'CASH'`.
  - **Test**: `tests/unit/rides/ride-lifecycle-concurrency.test.ts` must remain **31/31 green**

- [x] T047 [US2] Create the outbox consumer — `src/modules/payments/consumers/ride-collection.consumer.ts`
  - **Reuse**: shape of `src/modules/rides/consumers/ride-notification.consumer.ts`
  - **Accept**: `register()` stays **pure** — no timers, no sockets — so integration tests can drive `processBatch()` by hand (constitution §7.2)

- [x] T048 [US2] Register the consumer — `src/bootstrap/events.bootstrap.ts`, `src/modules/payments/index.ts`
  - **Depends**: T047
  - **Accept**: one entry appended to `CONSUMER_KEYS` and to the `Consumer` union type — the single place consumers are wired

- [x] T049 [US2] Create the collection sweep job — `src/modules/payments/jobs/collection-sweep.job.ts`
  - **Objective**: bounded retry per **BD-4**. **BD-6 cash auto-resolution deferred to US3**: nothing can confirm cash until `POST /rides/:rideId/payment/confirm-cash` exists, so auto-resolving now would settle rides no one is able to confirm. The job already scans the right rows and gains the cash branch alongside that route.
  - **Reuse**: `MaintenanceRunner` shape `run(now)`; `LockStore` job lock as `SettlementJob`/`ReconciliationJob` already do
  - **Tx/Concurrency**: **Race 10** — the per-ride conditional claim is the guarantee; the job lock only avoids duplicate scans
  - **Accept**: no configuration value can produce an unbounded loop

- [x] T050 [US2] Wire the sweep job — `src/jobs/queues/index.ts`, `src/jobs/workers/index.ts`, `src/jobs/scheduler/index.ts`
  - **Depends**: T049
  - **Accept**: job name added to `JOB_NAMES`, handler to `MAINTENANCE_HANDLERS`, schedule to `JOB_SCHEDULES` using the existing `process.env.X_CRON ?? '<default>'` convention; `MaintenanceResult` union extended

- [x] T051 [US2] Add the ride payment read + retry endpoints — `src/modules/payments/routes/payment.routes.ts`, `src/modules/payments/controllers/payment.controller.ts`
  - **Objective**: `GET /rides/:rideId/payment`, `POST /rides/:rideId/payment/retry`
  - **Reuse**: `withIdempotency` on the retry route; existing `uuidParams` pattern
  - **Accept**: UUID pattern on every `:rideId` (constitution §11.2); retry carries **no amount field**; a ride the caller is not party to returns `404`, not `403` (§9.3); **never blocked by the debt threshold** (BD-2)

- [x] T052 [US2] Bridge collection outcomes to the socket — `src/modules/rides/consumers/ride-realtime.consumer.ts`
  - **Objective**: two map entries only — `payment.ride.collected` → `ride:payment_settled`, `payment.ride.collection_failed` → `ride:payment_failed`
  - **Accept**: driven **from the outbox**, never emitted directly from the collection service (constitution §7.5)

- [x] T053 [US2] Record the receivable on permanent failure — `src/modules/payments/services/collection/collection.service.ts`
  - **Depends**: T044
  - **Accept**: transition 6 posts `CUSTOMER_RECEIVABLE` DR fare · `DRIVER_PAYABLE` CR earning · `PLATFORM_COMMISSION` CR commission (**BD-1 option C**), and publishes `collection_failed` with `willRetry: false` in the **same transaction** — the receivable-establishing event

**Checkpoint**: rides collect. The headline defect is fixed.

---

## Phase 5: User Story 3 — Cash confirmed, commission recoverable (P3)

**Goal**: a cash ride is paid only when acknowledged, and the commission owed is recovered from later settlements.

### Tests

- [x] T054 [P] [US3] **Flag OFF** — `tests/integration/cash-settlement.test.ts`
  - **Accept**: cash ride is `PAID` at completion (today's behaviour, unchanged) **and `POST /rides/:rideId/payment/confirm-cash` returns `404`**. BD-5 requires that no client can _access or execute_ the flow when disabled

- [x] T055 [P] [US3] **Flag ON** — driver confirmation — `tests/integration/cash-settlement.test.ts`
  - **Accept**: cash ride completes `PENDING`; only the assigned driver may confirm; a different driver is refused; commission debits the driver wallet

- [x] T056 [P] [US3] Idempotent confirmation — `tests/integration/cash-settlement.test.ts`
  - **Accept**: repeat with the same `Idempotency-Key` replays the original response; commission booked **once**

- [x] T057 [P] [US3] **Race 9** — manual vs automatic resolution — `tests/integration/cash-settlement.test.ts`
  - **Tx/Concurrency**: run the sweep and a manual confirmation concurrently via `Promise.all`
  - **Accept**: exactly one `SUCCEEDED` `RidePayment`, one commission entry, one earnings entry. **BD-6 requires this assertion explicitly**

- [x] T058 [P] [US3] Auto-resolution preconditions — `tests/integration/cash-settlement.test.ts`
  - **Accept**: the sweep leaves untouched — a cancelled ride, an in-progress ride, a non-cash ride, an already-`PAID` ride, a ride with a `SUCCEEDED` payment row, and a ride still inside its grace period (all six BD-6 conditions)

- [x] T059 [P] [US3] Commission carry-forward — `tests/integration/cash-settlement.test.ts`
  - **Accept**: a negative period carries into the next settlement as `adjustments` and is deducted before the payable; debt recovered equals debt carried
  - **DEVIATION — two recovery paths, one per flag state, and never both.** With the flag OFF a cash ride has no `SUCCEEDED` payment row, its commission stays in `aggregateEarnings`, the period nets negative, and `adjustments` carries it (this task as written). With the flag ON the commission has already left the driver's wallet at confirmation, so `aggregateEarnings` now excludes it — counting it again would recover the same commission twice. The exclusion predicate is exactly "a confirmed cash ride", so the flag-OFF arithmetic is unchanged.

### Implementation

- [x] T060 [US3] Gate the cash `paymentStatus` on the flag — `src/modules/rides/services/lifecycle/lifecycle.service.ts`
  - **Objective**: with the flag ON a cash ride completes `PENDING`; with it OFF behaviour is **byte-identical to today**
  - **NOTE — the flag is read live, not from the frozen snapshot.** `paymentConfig` is a boot-time freeze, which is right for a fare rate and wrong for a rollout toggle: the route registration, the completion branch, the collection branch and the sweep all call `cashConfirmationRequired()` instead, so the flag can be turned on without a redeploy — and so one test process can cover both states.
  - **Depends**: T002
  - **Accept**: **the second and last permitted change in `LifecycleService`**

- [x] T061 [US3] Add `debit` to the driver wallet repository — `src/modules/payments/repositories/settlement-wallet.repository.ts`
  - **Reuse**: mirror the existing `credit` exactly, including `lockForUpdate`
  - **Accept**: records a negative `DriverWalletTransaction`; the balance **may go negative** — that negative _is_ the driver's outstanding commission

- [x] T062 [US3] Add the cash branch to collection — `src/modules/payments/services/collection/collection.service.ts`
  - **Depends**: T044, T061
  - **Tx/Concurrency**: `RidePayment` + status claim + driver-balance debit + ledger + event in one transaction
  - **Accept**: publishes `payment.ride.collected` with `method: CASH` and `commissionOwed > 0`. **No separate cash event** — it was cut for duplicate meaning

- [x] T063 [US3] Add automatic resolution to the sweep — `src/modules/payments/jobs/collection-sweep.job.ts`
  - **Objective**: **BD-6** — resolve after `PAYMENT_CASH_CONFIRM_GRACE_SEC`
  - **Depends**: T049, T062
  - **Tx/Concurrency**: all six preconditions **re-checked inside the claiming transaction**; identical guards to manual confirmation so a race is a harmless no-op
  - **Accept**: the ledger entry description marks the resolution automatic, so an auditor can distinguish it from a driver acknowledgement

- [x] T064 [US3] Add the confirm-cash endpoint, **flag-gated** — `src/modules/payments/routes/payment.routes.ts`, `src/modules/payments/controllers/payment.controller.ts`
  - **Reuse**: `lockAndValidate` ownership semantics (`RideDriverMismatchError`); `authorize({ requireOperableDriver: true })`; `withIdempotency`
  - **Depends**: T002, T062
  - **Accept**: registration wrapped in `if (paymentConfig.cashConfirmationRequired)` so the route **does not exist** when disabled. Confirmation must **not** gate the driver's next ride

- [x] T065 [US3] Create `DebtService` — `src/modules/payments/services/debt/debt.service.ts`
  - **Objective**: read model — rider outstanding = `SUM(RideFare.totalFare)` over rides `paymentStatus = FAILED` **excluding** those with a `WRITTEN_OFF` row; driver = negative wallet balance
  - **Why new**: no debt table; it aggregates existing columns
  - **Accept**: computed server-side on every check, never cached, never from client input (**BD-2**)

- [x] T066 [US3] Add `GET /me/debt` — `src/modules/payments/routes/payment.routes.ts`
  - **Depends**: T065
  - **Accept**: rider view carries `outstanding`, `limit`, `blocked` (`outstanding >= limit`); **driver view omits `limit`/`blocked` entirely** — **BD-3 approved no driver blocking**

**Checkpoint**: cash is honest and its commission recoverable.

---

## Phase 6: User Story 4 — Every completed ride has a receipt (P4)

- [x] T067 [P] [US4] Receipt exists without being requested — `tests/integration/ride-receipt.test.ts`
  - **Accept**: after a ride's payment outcome, a receipt exists with no prior `GET`

- [x] T068 [P] [US4] Receipt immutability and access — `tests/integration/ride-receipt.test.ts`
  - **Accept**: two retrievals return identical content and the same receipt number; a later refund does not alter it; another rider is refused

- [x] T069 [US4] Issue the receipt at the payment outcome — `src/modules/payments/services/collection/collection.service.ts`
  - **Reuse**: `ReceiptService.generateReceipt` is **already idempotent** — it returns the existing receipt when one exists, so the lazy path survives for historical rides
  - **Depends**: T044
  - **Accept**: FR-023
  - **NOTE**: issued inside the three terminal outcomes (collected, cash confirmed, receivable created). A cash ride with BD-5's flag off never reaches any of them — it is already `PAID` when it completes — so the consumer issues that one, which is the only path outside a collection transaction.

- [x] T070 [US4] Add the `payment` block to the snapshot — `src/modules/rides/services/receipt/receipt.service.ts`
  - **Accept**: method, status, `settledAt` added; the existing itemized fare snapshot untouched

- [x] T071 [US4] Confirm receipt access control — `src/modules/rides/routes/ride.routes.ts`
  - **Accept**: rider on the ride, driver on the ride, staff only (FR-025)
  - **Verification only — no change needed.** `RideQueryController.getReceipt` already calls `assertRideParty`, which admits exactly those three and refuses everyone else with a `403`. Now covered by a test rather than by reading the code.

**Checkpoint**: receipts are issued, not improvised.

---

## Phase 7: User Story 5 — Drivers paid from collected money (P5)

**Goal**: settlement counts earnings on the approved basis, less commission and carried balance.

### Tests

- [x] T072 [P] [US5] **BD-1 negative assertion** — an uncollected ride does **not** reduce driver earnings — `tests/integration/earnings-pipeline.test.ts`
  - **Accept**: the driver's earning is included **in full**; the shortfall sits as `CUSTOMER_RECEIVABLE`. **A settlement query that filters on collection success is a defect, not an optimisation**

- [x] T073 [P] [US5] Later settlement does not re-recognise — `tests/integration/earnings-pipeline.test.ts`
  - **Accept**: settling a receivable in a later period does **not** increase the payable

- [x] T074 [P] [US5] Write-off idempotency and **Race 7** — `tests/integration/payment-receivable.test.ts`
  - **Tx/Concurrency**: run the write-off sweep twice; race it against a late successful collection
  - **Accept**: one `WRITTEN_OFF` row, one `BAD_DEBT_EXPENSE` group. The ride row is locked and the "no `SUCCEEDED` row" precondition re-checked inside the transaction

- [x] T075 [P] [US5] Write-off closes the obligation — `tests/integration/payment-receivable.test.ts`
  - **Accept**: retry on a written-off ride is refused (**BD-1c**); `collectionState` reads `WRITTEN_OFF`; `amountOwed` is `0`; the amount no longer counts toward the BD-2 threshold

- [x] T076 [P] [US5] **Race 8** — debt threshold vs ride creation — `tests/integration/payment-debt-threshold.test.ts`
  - **Tx/Concurrency**: concurrent ride requests via `Promise.all`
  - **Accept**: boundary asserted at **exactly** the limit (`>=`, _reaches or exceeds_); retry never blocked; **reuses the existing `rides_active_customer_key` partial unique index as the correctness boundary — no new lock**

- [x] T077 [P] [US5] Reconciliation against the ledger — `tests/integration/payment-reconciliation.test.ts`
  - **Accept**: divergence detected for **both** customer and driver wallets; receivable and bad-debt identities hold; pre-cut-over divergence reported **separately** as historical

- [x] T078 [P] [US5] **BD-7 historical immutability** — `tests/integration/payment-ledger-immutability.test.ts`
  - **Accept**: snapshot pre-cut-over `payment_ledger_entries`, run every migration and job, assert **byte-identical**. No row updated or deleted

### Implementation

- [x] T079 [US5] Correct the settlement earnings basis — `src/modules/payments/repositories/settlement.repository.ts`
  - **Objective**: stop using `payment_method <> 'CASH'` as a proxy for _collected_
  - **NOTE**: Phase 5 had briefly put the BD-5 cash-commission exclusion inside `aggregateEarnings` as a `ride_payments` filter. It concerned commission recovery rather than collection success, so it was not the join BD-1 forbids — but a `ride_payments` reference in the earnings query invites the next reader to add the one that is. It now lives in a separately named `alreadyRecoveredCommission`, and `aggregateEarnings` is purely fare-derived again.
  - **Accept**: **BD-1 forbids deducting a customer's failure from driver earnings, so `aggregateEarnings` keeps deriving from `ride_fares` and must NOT gain a `ride_payments` join.** Cash is filtered explicitly — a cash driver's earning is the cash they hold, so only the commission owed belongs in the settlement

- [x] T080 [US5] Supply `adjustments` carry-forward — `src/modules/payments/services/settlement/settlement.service.ts` — **already delivered with T059** in Phase 5, via `cumulativeNetPayable`
  - **Reuse**: the `adjustments` parameter **already exists and has never been passed a value**
  - **Accept**: prior-period shortfall carried; FR-021

- [x] T081 [US5] Create `WriteOffService` — `src/modules/payments/services/writeoff/writeoff.service.ts`
  - **Objective**: **BD-1c** ageing write-off posting `BAD_DEBT_EXPENSE` DR / `CUSTOMER_RECEIVABLE` CR
  - **Tx/Concurrency**: `WRITTEN_OFF` row + ledger + event in one transaction; the partial unique index (T012) makes a duplicate structurally impossible
  - **Depends**: T012, T013
  - **Accept**: publishes `payment.receivable.written_off`. **No rider notification** — telling a customer their debt was written off invites gaming

- [x] T082 [US5] Create and wire the write-off job — `src/modules/payments/jobs/receivable-writeoff.job.ts`, `src/jobs/queues/index.ts`, `src/jobs/workers/index.ts`, `src/jobs/scheduler/index.ts`
  - **Depends**: T081
  - **Accept**: separate from the collection sweep because its cadence is **days, not minutes**

- [x] T083 [US5] Extend reconciliation — `src/modules/payments/jobs/reconciliation.job.ts`
  - **Objective**: compare stored balances against the **ledger**; cover `driver_wallets`; honour `PAYMENT_LEDGER_CUTOVER_AT`
  - **Depends**: T003
  - **Accept**: keeps the existing transaction-sum check as a second, different signal (it catches a genuinely different failure). **BD-7** — reports pre-cut-over divergence separately, never suppressing it

- [x] T084 [US5] Add the rider debt guard to ride request — `src/modules/rides/services/request/ride-request.service.ts`
  - **Reuse**: place beside the existing `IncompleteProfileError` guard
  - **Depends**: T065
  - **Accept**: refuses at `outstanding >= PAYMENT_RIDER_DEBT_LIMIT` (**BD-2**). **No new locking** — race 8's boundary is the existing active-ride unique index

- [x] T085 [US5] Confirm `PayoutService` is untouched — `src/modules/payments/services/payout/payout.service.ts` — **verified: `git diff` reports zero changes to the file**
  - **Accept**: **zero source changes.** `POST /api/v1/admin/payments/payouts` stays at 20/20; only the settlement figure it bounds against becomes accurate

**Checkpoint**: drivers are paid from money the platform actually holds.

---

## Phase 8: Polish & Cross-Cutting

- [x] T086 [P] Add collection metrics — `src/modules/payments/metrics/payment.metrics.ts`
  - **Reuse**: existing `incrementCounter` counters
  - **Accept**: collection success/failure, write-off, auto-resolution (constitution §17.1). No secret or PII reaches a log (§17.3)

- [x] T087 [P] Extend push notifications for collection outcomes — `src/modules/rides/consumers/ride-notification.consumer.ts`
  - **Reuse**: existing `dedupeData` push-dedupe path
  - **Accept**: subscribes to `payment.ride.collected` **only, never `payment.succeeded`** — otherwise a card ride notifies twice (contracts/events.md §Boundary)

- [x] T088 Verify every money-path invariant is asserted **directly** — audit found 10 of 12 already covered; invariants **5** (no ledger entry asserts an uncollected payment) and **9** (the `CUSTOMER_RECEIVABLE` position equals the summed UNPAID fares) were only implied by other assertions and now have dedicated tests — tests across `tests/unit/payments/`, `tests/integration/`
  - **Accept**: all 12 invariants in [data-model.md](./data-model.md) §4, not as a side effect of another assertion (constitution §15.4)

- [x] T089 Run the quality gates — no file
  - **Accept**: `npm run lint`, `npm run format:check`, `npm run typecheck` all clean (constitution §18.1)

- [x] T090 Compare against the recorded baseline — no file — **MET.** Unit **904/905** (the one failure is `worker-health`, a Node test-runner IPC error — `ERR_TEST_FAILURE: Unable to deserialize cloned data` — not an assertion, and it reproduces with no Payment file loaded). Integration **760/763**. Both order-dependent failures are diagnosed and fixed; neither was a Payment defect, both were test-harness defects.

  **Failure 1 — `payment-reconciliation` → "detects a driver balance that diverges".** `wallet_reconciliations.wallet_id` is a plain uuid column with no foreign key, so `TRUNCATE "users" … CASCADE` never reached it — the one table in the test database that survived every reset. Its rows accumulated across runs (the database held rows dated the previous day), so `assert.equal(rows.length, 1)` was counting every reconciliation since the table was created, not this test's. It read as order-dependence but was residue across runs. Fixed by adding the table to `resetState`'s TRUNCATE list, next to `payment_ledger_entries`, which is on the list for exactly the same reason. The earlier report that this fix broke `user-collections` in isolation does not reproduce — that was a sighting of failure 2.

  **Failure 2 — `user-collections` → "holds the cap under concurrent creates", and 50 others.** `tests/integration/helpers/load-test-env.ts` deleted `DATABASE_URL` and `REDIS_URL` and relied on `loadEnvironment()` running afterwards to restore them from `.env.test`. That holds only when `harness.js` is the process's first import. Six integration files import something under `src/` first, which evaluates `validated-env` — whose module body calls `loadEnvironment()` — so `.env.test` was already loaded and the delete was permanent. Every test in those files then died on `resetState()` refusing an unset `DATABASE_URL`. Fixed by loading `.env.test` in `load-test-env.ts` itself with `override: true`, which makes import order irrelevant and keeps the original protection against a shell `DATABASE_URL` pointing at development. `geo-nearby` went 0/33 → 33/33 on this fix alone.

  **Remaining 2 integration failures, both out of scope and neither Payment.** The known `vehicle-catalog` pricing-extraction regressions.

  A 3rd, `route-graph` → "exposes exactly the sanctioned set of unauthenticated routes", was fixed on the user's instruction. `POST /api/v1/auth/admin/login`, `/admin/otp/send` and `/admin/otp/verify` — added by `122b526 feat(auth): add admin email/password login` and `94c7c02 feat(admin): add system-admin rbac` — were reachable without a token and absent from `SANCTIONED_PUBLIC`. All three are deliberately `config: { public: true }`, each rate limited, and each documented as never creating an account and never disclosing whether a number is staff, so they are genuine pre-authentication credential endpoints. Added with those reasons as their documented entries rather than by putting them behind auth, which would make staff login impossible.
  - **Accept**: unit **864/864**; integration failures **≤ 2** (the `vehicle-catalog` pricing-extraction regression, which is **out of scope**). The 15 `INCOMPLETE_PROFILE` failures must be **resolved** by T019. Any other delta is a regression and must be diagnosed, never characterised (constitution §15.3)

- [ ] T091 Walk the quickstart scenarios — [quickstart.md](./quickstart.md) — **NOT RUN.** Requires `npm run dev` and `npm run worker:dev` both up against a live server; not executed in this session.
  - **Accept**: all 11 scenarios pass against a running server with **both** `npm run dev` and `npm run worker:dev` up — without the worker the outbox never drains and collection never happens

---

## Dependencies & Execution Order

### Phase order

```text
Setup (T001–T006)
  └─► Foundational (T007–T020)  ⚠️ BLOCKS EVERYTHING
        └─► US1 (T021–T033)  🎯 MVP — must precede US2
              └─► US2 (T034–T053)
                    ├─► US3 (T054–T066)
                    ├─► US4 (T067–T071)
                    └─► US5 (T072–T085)
                          └─► Polish (T086–T091)
```

### Story dependencies — stated honestly

These stories are **not** independently implementable; they form a chain, and pretending otherwise would produce a broken build order:

- **US1 → US2**: collection debits a wallet, so the debit primitive and the funding integrity it depends on must exist first. **Shipping US2 first would put a debit path onto a mintable balance.**
- **US2 → US3**: cash confirmation writes through the collection service.
- **US2 → US4**: the receipt records how the ride was paid.
- **US2 → US5**: settlement counts collections, which do not exist until US2.

What each story _does_ preserve is independent **testability and shippability**. US1 closes a real hole and can ship alone.

### Critical-path dependencies

| Task                          | Blocks                                        |
| ----------------------------- | --------------------------------------------- |
| T007 (unique index)           | T044, T053, T062 — the exactly-once guarantee |
| T015 (`claimPaymentStatusIf`) | every collection transition                   |
| T016 (accounts)               | T045, T053, T081                              |
| T027 (wallet debit)           | T044                                          |
| T044 (collection service)     | T046, T053, T062, T069                        |
| T065 (`DebtService`)          | T066, T084                                    |

### Parallel opportunities

- Setup: T004, T005 together
- Foundational: T010, T011, T012 (independent migrations); T016, T017, T018, T020
- Every `[P]` test task within a phase
- **Cross-story**: US4 (T067–T071) is independent of US3 and US5 once US2 lands

---

## Implementation Strategy

### MVP — User Story 1 only

1. Phase 1 Setup → 2. Phase 2 Foundational (**critical**) → 3. Phase 3 US1 → 4. **STOP and validate** quickstart Scenario 1 → 5. Ship.

US1 alone closes a hole that lets an authenticated rider fabricate wallet balance, and is worth shipping before the rest is built.

### Incremental delivery

Setup + Foundational → US1 **(ship — MVP)** → US2 (rides collect) → US3 (cash honest) → US4 (receipts) → US5 (settlement accurate).

### Team strategy

The chain limits cross-story parallelism. The highest-value split is one engineer on the story chain and a second on Phase 8 reconciliation work (T077, T083, T086), which touches no file the chain touches.

---

## Notes

- `[P]` = different files, no incomplete dependency
- Every task names a real path in this repository, verified 2026-08-23
- **Do not weaken a test to make the suite green.** The one legitimate "make it pass" is T019, where the assertions were never reached
- **Do not attribute the 2 `vehicle-catalog` failures to Payment** — they are owned by the incomplete pricing extraction
- Commit scope is `payment` (allowed by commitlint); there is no `realtime` or `vehicle` scope
- Stop at any checkpoint to validate the increment independently
