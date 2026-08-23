---
description: 'Task list for Payment & Fare Settlement — SUPERSEDED, regenerate with /speckit-tasks'
---

> # ⚠️ SUPERSEDED — REGENERATE BEFORE USE
>
> **Not blocked any more** — all seven business decisions were approved on 2026-08-23 (see [decisions.md](./decisions.md)). But this list predates them and no longer matches the specification.
>
> Regenerate with `/speckit-tasks`. What changed since it was written:
>
> **Removed**: `payment.debt.recorded` and `payment.cash.confirmed` events (T013, T046) · `PAYMENT_DRIVER_DEBT_LIMIT` (T002, T042) · hold capture (T018, T019) · `GET /drivers/me/settlements` (T062) · the `payment_intents(ride_id)` migration (T008) · the driver go-online debt guard (T049, closed by BD-3).
>
> **Added by approved decisions**: `CUSTOMER_RECEIVABLE` posting at collection exhaustion (BD-1) · the ageing write-off service, job, migration and event (BD-1c) · the rider debt threshold guard with a boundary-value test (BD-2) · automatic cash resolution after a grace period (BD-6) · the prospective-only ledger cut-over (BD-7) · three more config knobs.
>
> **Added by the correction passes**: FR-037/FR-038 (the ledger asserts payments that never happened, and debits the wrong account for card rides) · FR-012 (a client can name its own amount and `rideId` on an intent) · FR-040 (`POST /intents/:intentId/confirm` bypasses `withIdempotency`) · FR-041 (derived public `collectionState`) · RT-1 … RT-4.
>
> **Changed**: 5 migrations, 7 config knobs, 3 events, 6 ledger accounts, 2 sweep jobs. Standing debt is a projection of `Ride.paymentStatus`, not a stored row. Transition 7 is split into 7a/7b so settling a receivable does not re-recognise earnings.
>
> Everything below is retained for reference only.

---

# Tasks: Payment & Fare Settlement

**Input**: Design documents from `/specs/002-payment-fare-settlement/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Test tasks ARE included. This feature moves money; the spec's success criteria are all assertions about correctness under retry and concurrency, and the repository's own convention is that money paths carry tests. Test tasks precede implementation tasks in every phase.

**Organization**: Tasks are grouped by user story so each can be implemented, tested and shipped independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5)
- Every task names an exact file path

## Path Conventions

Modular monolith, single project. `src/` and `tests/` at repository root. All financial mutation lives in `src/modules/payments/` even where the table is declared under `prisma/schema/modules/ride/` — see plan.md §Structure Decision.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Environment and configuration groundwork. No behaviour changes.

- [ ] T001 Confirm Node 22.x is active and the test database is migrated: run `node -v`, then `npx prisma migrate deploy` against `DATABASE_URL` pointing at `zaroorat_test` per [quickstart.md](./quickstart.md) prerequisites
- [ ] T002 [P] Add the five payment knobs to `src/config/payment/payment.config.ts` using the existing `numericEnv` helper from `src/config/env/numeric.ts`: `PAYMENT_COLLECTION_MAX_ATTEMPTS`, `PAYMENT_COLLECTION_RETRY_BASE_SEC`, `PAYMENT_RIDER_DEBT_LIMIT`, `PAYMENT_DRIVER_DEBT_LIMIT`, and a boolean `PAYMENT_CASH_CONFIRMATION_REQUIRED` — bounds per [research.md](./research.md) §10
- [ ] T003 [P] Convert the two existing bare-`Number()` reads in `src/config/payment/payment.config.ts` (`idempotencyTtlSeconds`, `webhookToleranceSeconds`) to `numericEnv` so a typo cannot yield `NaN`
- [ ] T004 [P] Document all seven knobs with defaults and bounds in `.env.example` under a `# --- Payments: collection & debt ---` section
- [ ] T005 [P] Add unit tests for the new knobs in `tests/unit/payments/payment-config.test.ts` asserting each rejects `NaN`, non-numeric, and out-of-range values

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema constraints, the repository nothing currently has, and the test-fixture gap. Every user story depends on this phase.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T006 Create migration `prisma/migrations/<ts>_ride_payment_unique_success/migration.sql` with the partial unique index `ride_payments_ride_id_succeeded_key` on `("ride_id") WHERE "status" = 'SUCCEEDED'`, including the `CREATE INDEX CONCURRENTLY` note for large-table rollout per [data-model.md](./data-model.md) §6.1
- [ ] T007 Create migration `prisma/migrations/<ts>_customer_wallet_balance_floor/migration.sql` adding the `balance >= 0` and `locked_balance <= balance` check constraints, per [data-model.md](./data-model.md) §6.2
- [ ] T008 [P] Create migration `prisma/migrations/<ts>_payment_intent_ride_index/migration.sql` adding the partial index on `payment_intents("ride_id")`
- [ ] T009 [P] Create migration `prisma/migrations/<ts>_ride_payment_sweep_index/migration.sql` adding the `("status", "created_at")` index used by the retry sweep
- [ ] T010 Verify the check constraints in T007 apply cleanly against the target database before deploy — query for any `balance < 0` or `locked_balance > balance` row and record the result; do not assume the table is clean
- [ ] T011 Create `src/modules/payments/repositories/ride-payment.repository.ts` with `create`, `findByRideId`, `findSucceededForRide`, `countAttempts`, `findFailedForCustomer`, and `findRetryable(now, limit)`; register it in `src/modules/payments/index.ts` as `ridePaymentRepository` with a `ridePaymentRepo` alias, following the existing registration and alias convention
- [ ] T012 **Fix the test-fixture gap that causes the 15 pre-existing failures**: set a profile name on riders created by `tests/integration/helpers/fixtures.ts` so ride booking no longer returns `422 INCOMPLETE_PROFILE`. This unblocks the 14 `earnings-pipeline` and 1 `authorization-bola` assertions that have never actually run — see [quickstart.md](./quickstart.md) baseline note. Do not weaken any assertion
- [ ] T013 Add the four new event types to `src/modules/payments/events/catalog.ts` (`payment.ride.collected`, `payment.ride.collection_failed`, `payment.cash.confirmed`, `payment.debt.recorded`) and extend the `classification` keyword rule so the audit-classified ones are actually classified `audit` — per [contracts/events.md](./contracts/events.md)

**Checkpoint**: Schema constraints in place, `RidePayment` writable, fixtures able to book a ride, events declared. User stories can begin.

---

## Phase 3: User Story 1 — Wallet money is real money (Priority: P1) 🎯 MVP

**Goal**: A wallet balance can only rise against a confirmed external payment, and can never be conjured, double-credited, or driven negative.

**Independent Test**: Request a top-up with no payment behind it and observe the balance stay at zero; confirm a real payment and observe it rise exactly once.

### Tests for User Story 1 ⚠️

> Write these first. They must fail against current code — an unbacked top-up currently succeeds.

- [ ] T014 [P] [US1] Integration test `tests/integration/wallet-funding.test.ts`: an unbacked `POST /wallet/topup` does not move the balance; a gateway-confirmed intent credits exactly once; a duplicate webhook credits zero more times
- [ ] T015 [P] [US1] Integration test in the same file: concurrent spends against one wallet never overdraw, and the balance never goes negative
- [ ] T016 [P] [US1] Unit test `tests/unit/payments/wallet-debit.test.ts`: `debit` records a **negative** `CustomerWalletTransaction.amount` — the sign convention `ReconciliationJob` depends on, per [research.md](./research.md) §4
- [ ] T017 [P] [US1] Unit test in the same file: a debit exceeding available balance throws `InsufficientBalanceError` and mutates nothing

### Implementation for User Story 1

- [ ] T018 [US1] Add `debit` and `captureHold` to `src/modules/payments/repositories/wallet.repository.ts`, both row-locking via the existing `lockForUpdate` and recording a negative-amount transaction
- [ ] T019 [US1] Add `debit(userId, amount, reference)` and `captureHold(userId, holdId)` to `src/modules/payments/services/wallet/wallet.service.ts`, each posting a balanced ledger group via `LedgerService` and publishing `payment.wallet.debited` in the same transaction (depends on T018)
- [ ] T020 [US1] Wire the wallet credit into `IntentService.applyConfirmation` in `src/modules/payments/services/intent/intent.service.ts` so a confirmed funding intent moves the balance in the same transaction that already posts its ledger credit — this is the edit that closes both the free-money hole and the ledger/balance divergence
- [ ] T021 [US1] Change `POST /wallet/topup` to create a funding intent instead of crediting directly: update `src/modules/payments/controllers/wallet.controller.ts`, `src/modules/payments/schemas/payment.schemas.ts` (add `methodType`, `paymentMethodId`), and the response shape per [contracts/http-api.md](./contracts/http-api.md)
- [ ] T022 [US1] Make `WalletService.topup` unreachable from HTTP — it becomes internal, callable only from the confirmation path (depends on T020, T021)
- [ ] T023 [US1] Update `tests/integration/route-graph.test.ts` and any contract snapshot for the changed `/wallet/topup` response shape

**Checkpoint**: The money-minting hole is closed and the wallet balance provably tracks the ledger. Shippable alone.

---

## Phase 4: User Story 2 — A completed ride is actually paid for (Priority: P2)

**Goal**: Every completed ride reaches a terminal payment outcome, charging the rider exactly once.

**Independent Test**: Complete a wallet ride and a card ride; each ends with a `RidePayment` row, a moved balance, and books that balance.

### Tests for User Story 2 ⚠️

- [ ] T024 [P] [US2] Integration test `tests/integration/ride-collection.test.ts`: a completed wallet ride debits exactly the fare, writes one `SUCCEEDED` `RidePayment`, and sets `paymentStatus = PAID` after `drainOutbox()`
- [ ] T025 [P] [US2] Integration test in the same file: replaying the same `ride.completed` envelope charges the rider zero additional times
- [ ] T026 [P] [US2] Integration test in the same file: a declined card leaves the ride `COMPLETED`, the driver `ONLINE`, `paymentStatus = FAILED`, and the amount visible as rider debt
- [ ] T027 [P] [US2] Integration test in the same file: two concurrent collections of one ride produce exactly one charge — the partial unique index is the backstop being proven, not the Redis lock
- [ ] T028 [P] [US2] Unit test `tests/unit/payments/collection-service.test.ts`: method routing (cash/wallet/card/UPI), attempt capping, and that the amount charged is copied from the fare and never recomputed
- [ ] T029 [P] [US2] Unit test `tests/unit/payments/ride-collection-consumer.test.ts`: the consumer reads `rideId` from `envelope.data`, not from the dropped `aggregateId` — per [contracts/events.md](./contracts/events.md)

### Implementation for User Story 2

- [ ] T030 [US2] Create `src/modules/payments/services/collection/collection.service.ts` with `collect(rideId)`: claim via `LockStore` key `payment:collect:{rideId}`, branch on method, perform any gateway call **outside** the transaction, then write `RidePayment` + `Ride.paymentStatus` + ledger group + outcome event inside one `txManager.execute` (depends on T011, T013, T019)
- [ ] T031 [US2] Create `src/modules/payments/consumers/ride-collection.consumer.ts` subscribing to `ride.completed`, following the shape of `src/modules/rides/consumers/ride-notification.consumer.ts`; keep `register()` pure — no timers, no sockets
- [ ] T032 [US2] Register the consumer: add `'rideCollectionConsumer'` to `CONSUMER_KEYS` in `src/bootstrap/events.bootstrap.ts` and to the `Consumer` union type, and register the class in `src/modules/payments/index.ts`
- [ ] T033 [US2] Populate `PaymentIntent.rideId` for every ride-linked collection and derive the gateway idempotency key deterministically from the ride id, in `src/modules/payments/services/collection/collection.service.ts`
- [ ] T034 [US2] Capture an existing hold rather than releasing and re-charging, in the collection service's wallet branch (depends on T019)
- [ ] T035 [US2] Create `src/modules/payments/jobs/collection-retry.job.ts` as a `MaintenanceRunner` with `run(now)`, sweeping retryable rides up to `PAYMENT_COLLECTION_MAX_ATTEMPTS` on a decaying schedule and stopping at the cap
- [ ] T036 [US2] Register the retry job: add `PAYMENT_COLLECTION_RETRY` to `JOB_NAMES` in `src/jobs/queues/index.ts`, map it in `MAINTENANCE_HANDLERS` in `src/jobs/workers/index.ts`, and add its schedule in `src/jobs/scheduler/`
- [ ] T037 [US2] Add `GET /rides/:rideId/payment` and `POST /rides/:rideId/payment/retry` to `src/modules/payments/routes/payment.routes.ts` with UUID-pattern param schemas, plus handlers in `src/modules/payments/controllers/payment.controller.ts`
- [ ] T038 [US2] Map the two collection-outcome events to socket events in `src/modules/rides/consumers/ride-realtime.consumer.ts` — two map entries only, no structural change to the bridge
- [ ] T039 [US2] Record the owed amount on a permanently failed collection so it is queryable per rider, in `src/modules/payments/services/collection/collection.service.ts`. _(The guard that blocks an over-limit rider from requesting lands in Phase 5 as T049b, because it needs `DebtService`, which US3 introduces.)_

**Checkpoint**: Rides collect. The headline defect is fixed.

---

## Phase 5: User Story 3 — Cash confirmed, commission recoverable (Priority: P3)

**Goal**: A cash ride is paid only when the driver says so, and the commission owed is recovered from later earnings.

**Independent Test**: Complete a cash ride, confirm it, then settle two consecutive periods and watch the debt carry and clear.

### Tests for User Story 3 ⚠️

- [ ] T040 [P] [US3] Integration test `tests/integration/cash-settlement.test.ts`: a completed cash ride is `PENDING`, not `PAID`; confirming flips it to `PAID` and drives the driver wallet negative by the commission
- [ ] T041 [P] [US3] Integration test in the same file: a negative period carries forward as `adjustments` into the next settlement and is deducted before payout — debt recovered equals debt carried
- [ ] T042 [P] [US3] Integration test in the same file: a driver over `PAYMENT_DRIVER_DEBT_LIMIT` is refused when going online
- [ ] T043 [P] [US3] Unit test `tests/unit/payments/debt-service.test.ts`: rider and driver debt aggregation, limit crossing, and the `blocked` flag

### Implementation for User Story 3

- [ ] T044 [US3] Create `src/modules/payments/services/debt/debt.service.ts` computing rider debt from failed `RidePayment` rows and driver debt from a negative `DriverWallet.balance`, publishing `payment.debt.recorded` on limit crossing
- [ ] T045 [US3] Stop marking cash rides `PAID` at completion — change only the `paymentStatus` literal in `LifecycleService.completeRide` (`src/modules/rides/services/lifecycle/lifecycle.service.ts`) from the cash special-case to `PENDING`. No other logic in that method changes
- [ ] T046 [US3] Add the cash branch to the collection service: on driver confirmation, write the `RidePayment`, debit the driver wallet by the commission via `SettlementWalletRepository`, and publish `payment.cash.confirmed`
- [ ] T047 [US3] Add a `debit` method to `src/modules/payments/repositories/settlement-wallet.repository.ts` mirroring the existing `credit`, recording a negative `DriverWalletTransaction`
- [ ] T048 [US3] Add `POST /rides/:rideId/payment/confirm-cash` to `src/modules/payments/routes/payment.routes.ts`, guarded by `fastify.authorize({ requireOperableDriver: true })` and ownership of the ride
- [ ] T049 [US3] Add the driver-debt guard to `StatusService.setOnline` in `src/modules/drivers/services/status/status.service.ts` — one guard, consistent with the existing verification and suspension guards (depends on T044)
- [ ] T049b [US3] Add the rider-debt guard to ride request in `src/modules/rides/services/request/` so a rider over `PAYMENT_RIDER_DEBT_LIMIT` is refused, completing FR-016 (depends on T039, T044)

**Checkpoint**: Cash is honest and its commission is recoverable.

---

## Phase 6: User Story 4 — Every completed ride has a receipt (Priority: P4)

**Goal**: A receipt exists for every ride without anyone asking, and never changes afterwards.

**Independent Test**: Complete a ride, request nothing, then look the receipt up and find it already there.

### Tests for User Story 4 ⚠️

- [ ] T050 [P] [US4] Integration test `tests/integration/ride-receipt.test.ts`: a receipt exists after completion with no prior `GET`; two retrievals return identical content and the same receipt number
- [ ] T051 [P] [US4] Integration test in the same file: a later refund does not alter the original receipt, and another rider requesting it gets refused

### Implementation for User Story 4

- [ ] T052 [US4] Call the already-idempotent `ReceiptService.generateReceipt` from the collection path once the payment outcome is known, in `src/modules/payments/services/collection/collection.service.ts` (depends on T030)
- [ ] T053 [US4] Extend the receipt snapshot in `src/modules/rides/services/receipt/receipt.service.ts` with the `payment` block from [contracts/http-api.md](./contracts/http-api.md), leaving the existing fare snapshot untouched
- [ ] T054 [US4] Confirm the receipt route enforces rider/driver/staff access only, in `src/modules/rides/routes/ride.routes.ts`

**Checkpoint**: Receipts are issued, not improvised.

---

## Phase 7: User Story 5 — Drivers paid from collected money (Priority: P5)

**Goal**: Settlement counts only fares actually collected, less commission and debt.

**Independent Test**: One period with a collected, a failed, and a cash ride — the payable reflects only the first, less the third's commission.

### Tests for User Story 5 ⚠️

- [ ] T055 [P] [US5] Integration test in `tests/integration/earnings-pipeline.test.ts`: an uncollected ride's earnings are excluded from the payable, and appear in the period in which they are later collected
- [ ] T056 [P] [US5] Integration test in the same file: a refund reduces the payable, and a refund after payout records driver debt
- [ ] T057 [P] [US5] Integration test in the same file: the settlement figure agrees with a direct ledger sum to the paise

### Implementation for User Story 5

- [ ] T058 [US5] Change `aggregateEarnings` in `src/modules/payments/repositories/settlement.repository.ts` to join `ride_payments` and count only fares with a `SUCCEEDED` payment, replacing the current `payment_method <> 'CASH'` proxy which assumes collection that never happened
- [ ] T059 [US5] Attribute a late-collected fare to the period in which it was collected, using `RidePayment.settledAt` rather than `Ride.completedAt`, in the same query (depends on T058)
- [ ] T060 [US5] Supply `adjustments` in `SettlementService.calculateSettlement` from the prior period's unrecovered shortfall — the parameter already exists and has never been passed a value (`src/modules/payments/services/settlement/settlement.service.ts`)
- [ ] T061 [US5] Reverse driver earnings on refund in `src/modules/payments/services/refund/refund.service.ts`, recording driver debt where the earnings were already paid out
- [ ] T062 [US5] Add `GET /drivers/me/settlements` to `src/modules/payments/routes/payment.routes.ts`, own-records-only
- [ ] T063 [US5] Confirm `PayoutService` is unmodified and its existing ceiling and concurrency tests in `tests/integration/payout-authorization.test.ts` still pass unchanged — the figure changes, the guard must not

**Checkpoint**: Drivers are paid from money the platform actually holds.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T064 Extend `src/modules/payments/jobs/reconciliation.job.ts` to compare stored balances against the **ledger** position, keeping the existing transaction-sum check as a second, different signal
- [ ] T065 Extend the same job to cover `driver_wallets`, which it currently ignores entirely
- [ ] T066 [P] Integration test `tests/integration/payment-reconciliation.test.ts`: a manually corrupted balance is detected against the ledger, for both a customer and a driver wallet
- [ ] T067 [P] Add `GET /me/debt` to `src/modules/payments/routes/payment.routes.ts` per [contracts/http-api.md](./contracts/http-api.md)
- [ ] T068 [P] Add notification handling for the two collection-outcome events in `src/modules/rides/consumers/ride-notification.consumer.ts`, reusing the existing `dedupeData` push-dedupe path
- [ ] T069 Verify every money-path invariant in [data-model.md](./data-model.md) §5 has a test asserting it **directly**, not as a side effect of another assertion
- [ ] T070 Run `npm run lint`, `npm run format:check`, `npm run typecheck` — all must be clean
- [ ] T071 Run the full suite in the background and compare against the recorded baseline; investigate every delta, and do not classify any failure as pre-existing without reading its actual assertion output
- [ ] T072 Walk all six scenarios in [quickstart.md](./quickstart.md) against a running server with both `npm run dev` and `npm run worker:dev` up

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: needs Setup — **blocks every user story**
- **US1 (Phase 3)**: needs Foundational
- **US2 (Phase 4)**: needs Foundational **and US1** — collection debits a wallet, so the debit primitive and the funding integrity it depends on must exist first
- **US3 (Phase 5)**: needs US2 — cash confirmation writes through the collection service
- **US4 (Phase 6)**: needs US2 — the receipt records how the ride was paid
- **US5 (Phase 7)**: needs US2 — settlement counts collected payments, which do not exist until US2
- **Polish (Phase 8)**: needs all desired stories

### Story independence — an honest note

The template's ideal is that stories are independently implementable. **These are not, and pretending otherwise would produce a broken build order.** They form a chain: collection needs a wallet that can be debited, and settlement needs collections to count. What each story _does_ preserve is independent **testability and shippability** — US1 closes a live security hole and can ship alone; each subsequent story is a coherent, demonstrable increment on top of the last.

### Within Each Story

- Tests are written first and must fail before implementation
- Repositories before services, services before routes
- Event catalog entries before the consumers that publish them

### Parallel Opportunities

- T002–T005 (Setup) run together
- T008, T009 (independent migrations) run together
- All `[P]` test tasks within a phase run together
- T064/T065 and T067/T068 are independent files and run together

---

## Parallel Example: User Story 2

```bash
# All US2 tests, written before any implementation:
Task: "Integration test wallet ride collection in tests/integration/ride-collection.test.ts"
Task: "Unit test collection routing in tests/unit/payments/collection-service.test.ts"
Task: "Unit test consumer envelope handling in tests/unit/payments/ride-collection-consumer.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup
2. Phase 2: Foundational — **critical**, blocks everything
3. Phase 3: User Story 1
4. **STOP and VALIDATE** — Scenario 1 in [quickstart.md](./quickstart.md)
5. Ship it. This alone closes a hole that lets any authenticated rider create money, and it is worth shipping before the rest is built.

### Incremental Delivery

1. Setup + Foundational → schema and fixtures ready
2. US1 → funding integrity → **ship (MVP)**
3. US2 → rides collect → ship
4. US3 → cash honest → ship
5. US4 → receipts issued → ship
6. US5 → settlement accurate → ship

### Team Strategy

The chain in §Story independence limits parallelism across stories. Within a story, tests and independent files parallelize well. The highest-value split is one engineer on the story chain and a second on Phase 8's reconciliation work (T064–T066), which touches no file the chain touches.

---

## Notes

- `[P]` = different files, no dependencies
- Every task names a real path in this repository
- **Do not weaken a test to make the suite green.** The one legitimate "make it pass" is T012, where the assertions were never reached because booking 422'd
- Commit per task or logical group; `payment` is an allowed commitlint scope, `realtime` is not
- Stop at any checkpoint to validate the story independently
