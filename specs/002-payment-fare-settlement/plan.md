# Implementation Plan: Payment & Fare Settlement

**Branch**: `002-payment-fare-settlement` | **Date**: 2026-08-23 | **Spec**: [spec.md](./spec.md) | **Decisions**: [decisions.md](./decisions.md)

> ## ✅ READY FOR IMPLEMENTATION
>
> Constitution **v1.0.0 RATIFIED** — every REQUIRED rule is treated as mandatory below.
> All seven business decisions **approved 2026-08-23**. No financial policy remains for the implementation to choose.
>
> `tasks.md` is superseded; regenerate with `/speckit-tasks`.

## Summary

Close the ride→money loop by adding the two things the platform genuinely lacks — a **collection path** and a **wallet debit primitive** — and correcting three ways the ledger misstates reality: it asserts payment at completion that never occurs, it debits the wallet for card rides, and it can be credited by a self-service top-up with no provider payment behind it.

Everything is additive against existing mechanisms. **No new mechanism is introduced for any problem this codebase has already solved.**

## Technical Context

**Language/Version**: TypeScript on Node 22.x (pinned `.nvmrc`), `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`

**Primary Dependencies**: Fastify 5 · Prisma 7 (`@prisma/adapter-pg`) · Awilix `InjectionMode.CLASSIC` (resolves by **constructor parameter name**) · BullMQ · ioredis · Zod

**Storage**: PostgreSQL 17 + PostGIS + pgcrypto; Redis for locks and idempotency

**Testing**: `node:test` via `tsx`, `--test-concurrency=1 --test-force-exit`; integration against real Postgres + Redis

**Project Type**: Modular monolith, single backend service

**Constraints**: exactly-once under retry and concurrency · every balance mutation row-locked and ledger-balanced · **no provider I/O inside a transaction** · **single-instance realtime** — no horizontal API scaling may be assumed

**Scale/Scope**: 5 migrations · 7 config knobs · 3 new events · 2 new ledger accounts (**no migration needed**) · 2 sweep jobs · 3 new services · 1 new repository · 1 new consumer · 1 new repository method

**NEEDS CLARIFICATION**: none. Every question raised during design was resolved by reading committed code — see §Resolved by Code Inspection.

## Constitution Check

_Gate evaluated against ratified constitution v1.0.0._

| §         | REQUIRED rule                                                                         | Compliance in this plan                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2       | Module registers via `register<Domain>Module`; routes mounted in `routes/register.ts` | New services/repos registered in `payments/index.ts`; no new route file                                                                               |
| 1.3       | Awilix CLASSIC — parameter names are the contract                                     | New constructor params named to match registration keys; aliases added as the module already does                                                     |
| 1.4       | Module owns mutation, not table location                                              | `RidePaymentRepository` lives in **payments** though `ride_payments` is declared in the ride schema — the rule `SettlementWalletRepository` documents |
| 2.1       | `exactOptionalPropertyTypes`                                                          | Conditional-spread idiom for every optional field                                                                                                     |
| 3.2       | Migrations additive, forward-only                                                     | All 5 additive; **BD-7 forbids any historical rewrite**                                                                                               |
| 3.3       | Raw SQL for partial indexes / CHECK                                                   | 3 partial indexes + 2 CHECK constraints                                                                                                               |
| 3.4       | `CONCURRENTLY` before deploy on large tables                                          | Documented in each index migration, with `IF NOT EXISTS`                                                                                              |
| 3.5       | Verify constraints against target DB first                                            | Explicit pre-flight step for the wallet CHECKs                                                                                                        |
| 4.1       | Money mutations inside `TransactionManager.execute`                                   | Every transition in §7                                                                                                                                |
| 4.2       | No third-party call inside a transaction                                              | Provider call precedes `txManager.execute` everywhere                                                                                                 |
| 4.3       | Balanced double-entry via `LedgerService`                                             | Every group in §8 sums to zero                                                                                                                        |
| 5.1       | Row-lock contended rows                                                               | `rideRepo.lockForUpdate` before the 7a/7b branch; `walletRepository.lockForUpdate` before debit                                                       |
| 5.2       | Conditional claim for single-winner transitions                                       | New `claimPaymentStatusIf`, same shape as `respondIfPending`                                                                                          |
| 5.3       | **Redis lock is never the correctness boundary**                                      | Every race in §11 names a database boundary                                                                                                           |
| 5.4       | DB index enforces uniqueness surviving a lost lock                                    | Partial unique indexes on `SUCCEEDED` and `WRITTEN_OFF`                                                                                               |
| 6.1–6.3   | Existing Redis idempotency                                                            | New mutating routes use `withIdempotency`; FR-040 brings `confirmIntent` in                                                                           |
| 6.4/6.5   | No second idempotency mechanism                                                       | **`IdempotencyKey` Prisma model stays unused.** No migration activates it                                                                             |
| 7.1       | `publish(input, tx)` in the same transaction                                          | All three new events                                                                                                                                  |
| 7.2       | One `CONSUMER_KEYS` entry; `register()` stays pure                                    | One line added; no timers, no sockets                                                                                                                 |
| 7.5       | Never bypass the outbox for speed                                                     | Socket updates come from the outbox only                                                                                                              |
| 7.6       | No two events for one transition                                                      | `payment.debt.recorded` was cut for exactly this                                                                                                      |
| 8.1–8.3   | Provider I/O outside transactions, deterministic key                                  | Gateway key derived from ride id                                                                                                                      |
| 9.1       | Server-authoritative amount                                                           | Collection reads `RideFare.totalFare`; no request body carries an amount                                                                              |
| 9.2       | Ownership proven against the DB                                                       | `lockAndValidate` reused for cash confirmation                                                                                                        |
| 10.1/10.2 | Deny-by-default; public routes justified                                              | All new routes authenticated; `route-graph.test.ts` allow-list untouched                                                                              |
| 11.2      | UUID pattern on path params                                                           | Every new `:rideId` route                                                                                                                             |
| 12.1/12.2 | `numericEnv`, never bare `Number()`                                                   | 5 numeric knobs; the 2 existing bare `Number()` reads corrected                                                                                       |
| 13.1–13.4 | Coded errors + envelope                                                               | New errors extend `PaymentError`; `handlePaymentError` unchanged                                                                                      |
| 14.1      | Genuinely concurrent tests                                                            | 12 races, each with a `Promise.all` test                                                                                                              |
| 15.3      | **Never weaken a test**                                                               | Only the rider-profile fixture changes, where assertions never executed                                                                               |
| 16.2      | Migrate-then-deploy compatibility                                                     | §4 proves each migration safe against the previous running version                                                                                    |
| 17.1/17.3 | Metrics + mandatory redaction                                                         | Extend `PaymentMetrics`; no new log surface carries a secret                                                                                          |
| 18.x      | CI gates                                                                              | No workflow change required                                                                                                                           |

**Gate result: PASSED.** No violations; Complexity Tracking records simplifications only.

## Resolved by Code Inspection

Questions that would otherwise be open, answered from committed code. **These four findings materially shape the plan and must not be discarded.**

| #   | Question                                         | Resolution                                                                                                                                                                                                                                                | Evidence                                                            |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Do the two new ledger accounts need a migration? | **No.** `PaymentLedgerEntry.account` is a plain `String` column, not an enum. `CUSTOMER_RECEIVABLE` and `BAD_DEBT_EXPENSE` are new _values_, not a new type. **No enum or schema migration is required solely for account values**                        | `payment.prisma:150`; `LedgerItemInput.account: string`             |
| 2   | Is there a boolean-config helper?                | No. The house idiom is `process.env.X !== 'false'` — **default ON**. BD-5 requires **default OFF**, so this knob must use logic equivalent to `=== 'true'`. Following the idiom blindly would silently invert an approved decision                        | `driver.config.ts:16`, `realtime.config.ts:39`, `ride.config.ts:58` |
| 3   | Can the ride payment status be claimed today?    | **No.** `updateStatusIf` claims on **ride status** and can only _set_ `paymentStatus` as extra data. A `claimPaymentStatusIf` method is required, built on the existing conditional-`updateMany` pattern — **not** a new locking or idempotency mechanism | `ride.repository.ts:124-136`                                        |
| 4   | Does the debt-threshold guard need new locking?  | **No.** The existing `rides_active_customer_key` partial unique index already permits one active ride per customer, so two concurrent requests cannot both succeed regardless of the debt read                                                            | migration `20260821130000_ride_active_uniqueness`                   |

**Architecture finding — no circular dependency exists, so no indirection is warranted:**

- `LifecycleService` **already injects `ledgerService`** (`lifecycle.service.ts:488`), so a rides→payments dependency is pre-existing.
- Payments reaches ride tables **through Prisma** (`client.ride`, `client.ridePayment`), never by importing rides services.
- Therefore: **do not introduce an interface, port, or event indirection to solve a circular dependency that does not exist.** After this feature `LifecycleService` needs `ledgerService` _less_, not more.

Additional resolutions: `LockStore.acquire(resource, ttlMs) → token|null` / `release(resource, token)`; `MaintenanceRunner.run(now)` with `MAINTENANCE_HANDLERS` name→container-key mapping and `JOB_SCHEDULES` `{queue,name,pattern}`; `RideFareRepository` has only `create`/`findByRideId`, so fare immutability is structural; `route-graph.test.ts` carries a `SANCTIONED_PUBLIC` allow-list that new authenticated routes do not touch.

## Existing Architecture Reused

| Need                          | Reused mechanism                                                      | Not built                                                 |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| Reaction to a committed fact  | Transactional outbox → `EventBus` → consumer in `CONSUMER_KEYS`       | No queue, no polling trigger, no direct cross-module call |
| Request replay safety         | `PaymentService.withIdempotency` → Redis `IdempotencyRepository`      | No `IdempotencyKey` table activation                      |
| Single-winner transitions     | Conditional `updateMany` claim (`respondIfPending`, `updateStatusIf`) | No advisory locks                                         |
| Contended balance mutation    | `SELECT … FOR UPDATE` via existing `lockForUpdate` methods            | No optimistic versioning                                  |
| Duplicate suppression at rest | Partial unique indexes                                                | No dedupe table                                           |
| Money accounting              | `LedgerService.postTransactionGroup` + its balance invariant          | No second ledger                                          |
| Wasted-work avoidance         | `LockStore` Redis locks                                               | Never used as the correctness boundary                    |
| Background work               | `MaintenanceRunner` + `MAINTENANCE_HANDLERS` + `JOB_SCHEDULES`        | No new scheduler                                          |
| Config validation             | `numericEnv`; boot-time throw as `readWebhookSecret` does             | No new config framework                                   |
| Errors                        | `PaymentError` + `errorEnvelope` + `isCodedError`                     | No new error format                                       |
| Ride ownership                | `lockAndValidate` (`RideDriverMismatchError`)                         | No new authorization path                                 |
| Concurrent ride creation      | `rides_active_customer_key` partial unique index                      | No new lock for race 8                                    |
| Provider trust boundary       | `WebhookService` signature/tolerance/replay                           | Unchanged                                                 |

## Implementation Strategy

Six increments, each independently shippable. **US1 must land before US2** — shipping a wallet debit path onto a mintable balance is the one ordering that must not happen.

| #   | Increment                                   | Delivers                                                                                                     |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 0   | Foundation                                  | Config, 5 migrations, `RidePaymentRepository`, `claimPaymentStatusIf`, ledger-account constants, fixture fix |
| 1   | Wallet funding integrity (US1)              | Credit only on provider confirmation; wallet debit primitive; RT-1…RT-4                                      |
| 2   | Ride collection (US2)                       | Collection service + consumer + sweep; ledger account/timing correction; receivable on exhaustion            |
| 3   | Cash (US3)                                  | Feature-flagged confirmation + automatic resolution; driver commission debit                                 |
| 4   | Receipts (US4)                              | Issued at payment outcome                                                                                    |
| 5   | Settlement, write-off, reconciliation (US5) | `adjustments` carry-forward, write-off sweep, ledger-based reconciliation                                    |

## Database Migration Plan

**Five migrations. All additive. None rewrites, updates or deletes an existing row** — BD-7 and constitution §3.2.

| #   | Migration                                                                                        | Why required                                                                                                               | Type                                                 | Backward-compatibility proof                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ride_payments_ride_id_succeeded_key` — partial unique on `("ride_id") WHERE status='SUCCEEDED'` | Exactly-once backstop for FR-007/FR-017; §5.4 requires uniqueness to survive a lost Redis lock                             | Additive index                                       | **No code writes `ride_payments` today**, so the index cannot conflict with the running version                                                                                                     |
| 2   | `customer_wallets` CHECK `balance >= 0` and `0 <= locked_balance <= balance`                     | FR-003. Negative balance becomes reachable **for the first time** with the debit path, so the constraint must ship with it | Additive constraint (behaviour-changing at DB level) | The previous version has **no debit path**, and its `hold` already refuses to lock more than `balance - lockedBalance`. It cannot violate either constraint. **Pre-flight query required** per §3.5 |
| 3   | `ride_payments_status_created_at_idx`                                                            | Both sweeps scan attempts by status and age                                                                                | Additive index                                       | Index-only; previous version does not read or write the table                                                                                                                                       |
| 4   | `rides_customer_id_payment_status_idx`                                                           | BD-2 aggregate is read on **every ride request**; `rides` is the largest table                                             | Additive index                                       | Index-only; no query-plan regression for existing queries, which key on `customerId` or `status` separately                                                                                         |
| 5   | `ride_payments_ride_id_written_off_key` — partial unique on `WHERE status='WRITTEN_OFF'`         | BD-1c requires duplicate write-offs be **impossible**, not unlikely                                                        | Additive index                                       | Same as #1 — table unwritten today                                                                                                                                                                  |

**Expand/migrate/deploy**: all five are _expand_ steps. `production.yml` migrates before rolling the image (§16.2), and every migration is a no-op for the currently-deployed code. **No contract step is needed in this feature**; none is invented for a future one.

**Explicitly NOT migrating** (no speculative migrations):

- **No ledger account enum migration** — `account` is a `String` (Finding 1).
- **No `PaymentStatus` enum change** — the state machine uses 3 of the 5 existing values.
- **No `RidePayment.status` change** — it is a `String`; `WRITTEN_OFF` needs no schema change.
- **No `IdempotencyKey` table activation** — §6.5; no approved decision requires it.
- **No historical ledger correction** — BD-7 option B.
- **No `payment_intents(ride_id)` index** — cut as speculative; no V1 query goes ride→intent.

## Module and File Change Plan

### New components — with why existing code cannot be reused

| Component                                            | Why it cannot be an existing thing                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments/repositories/ride-payment.repository.ts`   | No repository exists for `ride_payments`; the table is written by nothing today                                                                      |
| `payments/services/collection/collection.service.ts` | Nothing collects a ride fare. `IntentService` handles standalone intents and knows nothing of rides or fares; `WalletService` knows nothing of rides |
| `payments/consumers/ride-collection.consumer.ts`     | Existing consumers map events to side channels (push, socket); none performs a money mutation                                                        |
| `payments/services/debt/debt.service.ts`             | Read model over derived balances. **No debt table** — it aggregates existing columns; no existing service computes it                                |
| `payments/services/writeoff/writeoff.service.ts`     | BD-1c ageing write-off; no existing service ages anything financial                                                                                  |
| `payments/jobs/collection-sweep.job.ts`              | BD-4 retry and BD-6 auto-resolution scan the same shape (`rides` at `paymentStatus=PENDING`), so they are **one** job                                |
| `payments/jobs/receivable-writeoff.job.ts`           | Separate from the sweep because its cadence is **days**, not minutes                                                                                 |
| `RideRepository.claimPaymentStatusIf`                | Finding 3 — `updateStatusIf` claims ride _status_; nothing can claim on `paymentStatus`. Built on the existing conditional-`updateMany` pattern      |
| `CUSTOMER_RECEIVABLE`, `BAD_DEBT_EXPENSE` constants  | New _values_ in `payment.constants.ts`, guarding a `String` column against typos. Not a new type or table                                            |

### Modified files

| File                                                                                       | Change                                                                           |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `config/payment/payment.config.ts`                                                         | 7 knobs; convert 2 bare `Number()` reads to `numericEnv`                         |
| `payments/constants/payment.constants.ts`                                                  | Ledger account constants                                                         |
| `payments/repositories/wallet.repository.ts`                                               | `debit` — row-locked, records a **negative** transaction amount                  |
| `payments/services/wallet/wallet.service.ts`                                               | `debit`; `topup` becomes internal to the confirmation path                       |
| `payments/services/intent/intent.service.ts`                                               | Credit wallet inside `applyConfirmation`; **remove client-supplied `rideId`**    |
| `payments/services/ledger/ledger.service.ts`                                               | Account selected by method; receivable, settlement-clearing and write-off groups |
| `payments/repositories/settlement.repository.ts`                                           | `aggregateEarnings` stops using `payment_method <> 'CASH'` as a collection proxy |
| `payments/services/settlement/settlement.service.ts`                                       | Supply `adjustments` (the parameter exists and has never been passed)            |
| `payments/repositories/settlement-wallet.repository.ts`                                    | `debit`, mirroring the existing `credit`                                         |
| `payments/jobs/reconciliation.job.ts`                                                      | Compare against the **ledger**; cover driver wallets; honour the cut-over        |
| `payments/controllers/`, `routes/`, `schemas/`, `errors/`, `events/catalog.ts`, `metrics/` | New endpoints, schemas, coded errors, 3 events, counters                         |
| `rides/repositories/ride.repository.ts`                                                    | `claimPaymentStatusIf`                                                           |
| `rides/services/lifecycle/lifecycle.service.ts`                                            | **Exactly two changes** (below)                                                  |
| `rides/services/request/ride-request.service.ts`                                           | Debt guard beside the existing `IncompleteProfileError` guard                    |
| `rides/services/receipt/receipt.service.ts`                                                | Add `payment` block to the snapshot                                              |
| `rides/consumers/ride-realtime.consumer.ts`                                                | 2 map entries                                                                    |
| `bootstrap/events.bootstrap.ts`                                                            | 1 `CONSUMER_KEYS` entry + union type                                             |
| `jobs/queues/`, `jobs/workers/`, `jobs/scheduler/`                                         | 2 job names, 2 handlers, 2 schedules, extend `MaintenanceResult`                 |
| `.env.example`                                                                             | 7 knobs with defaults and bounds                                                 |

### The only two changes inside `rides/lifecycle`

1. `recordTripPayment` **moves out** of `completeRide` into collection (FR-038 — the ledger must not assert a payment that has not happened).
2. The cash `paymentStatus` literal becomes conditional on the BD-5 flag. **With the flag OFF, behaviour is byte-identical to today.**

Dispatch, status transitions, driver release, OTP and plausibility checks, and the published event payload are untouched. After change 1, `LifecycleService` no longer needs `ledgerService` — a dependency **removed**.

### Files that must not change

`pricing/services/pricing.service.ts` and `pricing/services/surge.service.ts` (fare calculation, relocated out of rides by the in-flight pricing extraction) · `rides/services/dispatch/**` · `auth/**` · `drivers/**` (BD-3 removes the go-online guard entirely) · `vehicles/**` · `realtime/**` (except 2 map entries) · `core/events/**` · `core/database/TransactionManager.ts` · `payments/services/gateway/**` · `payments/services/payout/payout.service.ts` · `payments/services/webhook/webhook.service.ts`.

## API Plan

> **⚠️ Payout route path is currently unstable and must be settled before task generation.**
> The in-flight admin work moved payouts out of `payment.routes.ts`. `adminRoutes` registers its sub-plugins **without an `/admin` prefix**, so the route actually mounts at `/api/v1/payments/payouts`, while `payout-authorization.test.ts` and the admin route file'''s intent both expect `/api/v1/admin/payments/payouts`. 18 of 20 payout tests are red (14 × 404) as a direct result. **This plan does not choose between the two paths** — that belongs to whoever owns the admin work. Payment tasks must not encode either path until it is resolved.

Full contract: [contracts/http-api.md](./contracts/http-api.md).

| Route                                      | Change                                                                          | Idempotency | Auth                 |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ----------- | -------------------- |
| `POST /wallet/topup`                       | Behavioural — creates a funding intent; response **additive**, no field removed | existing    | rider                |
| `POST /intents`                            | `rideId` **removed** from schema (fare-bypass hole)                             | existing    | rider                |
| `POST /intents/:intentId/confirm`          | **Add `withIdempotency`** — closes the FR-040 gap                               | **new**     | owner/staff          |
| `GET /rides/:rideId/payment`               | new — derived `collectionState`                                                 | n/a (read)  | ride parties + staff |
| `POST /rides/:rideId/payment/retry`        | new — **no amount field**                                                       | required    | ride customer        |
| `POST /rides/:rideId/payment/confirm-cash` | new — **registered only when the flag is ON**                                   | required    | assigned driver      |
| `GET /me/debt`                             | new                                                                             | n/a         | self                 |

**BD-5 route gating**: `paymentRoutes` wraps the confirm-cash registration in `if (paymentConfig.cashConfirmationRequired)`. With the flag OFF the route does not exist and returns `404`. The approved wording is "no client should be able to _access or execute_" — stronger than registering and rejecting. No conditional-registration precedent exists in the repo, so this establishes the minimal one: a two-line `if` inside the existing route function, not a new plugin.

## Payment and Collection State Plan

Authoritative machine: [data-model.md](./data-model.md) §2 — eleven transitions with actor, authorization, transaction boundary, claim protection, duplicate behaviour, ledger group and event.

- **Obligation states**: `PENDING → PAID | FAILED`, plus write-off. Three of five existing enum values; **no enum migration**.
- **Attempt states**: `RidePayment.status` `PENDING | SUCCEEDED | FAILED | WRITTEN_OFF` — a `String` column, **no migration**.
- **Public vocabulary**: `collectionState` ∈ `AWAITING_COLLECTION | AWAITING_CASH_CONFIRMATION | RETRYING | PAID | UNPAID | WRITTEN_OFF`, derived per request, never stored. **`FAILED` never appears in the public API.**
- **Claiming**: `claimPaymentStatusIf` (Finding 3) is the single-winner mechanism for every collection transition.

## Ledger and Receivable Plan

Six accounts; two new, **no migration** (Finding 1).

| Transition                      | Ledger group                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Collected — wallet              | `CUSTOMER_WALLET` DR fare · `DRIVER_PAYABLE` CR earning · `PLATFORM_COMMISSION` CR commission         |
| Collected — card/UPI            | `GATEWAY_CLEARING` DR fare · same two credits                                                         |
| Cash confirmed or auto-resolved | `DRIVER_PAYABLE` DR commission · `PLATFORM_COMMISSION` CR commission                                  |
| **Attempts exhausted**          | **`CUSTOMER_RECEIVABLE` DR fare** · `DRIVER_PAYABLE` CR earning · `PLATFORM_COMMISSION` CR commission |
| **Receivable settled (7b)**     | `GATEWAY_CLEARING`/`CUSTOMER_WALLET` DR fare · **`CUSTOMER_RECEIVABLE` CR fare — clears only**        |
| **Write-off**                   | `BAD_DEBT_EXPENSE` DR fare · `CUSTOMER_RECEIVABLE` CR fare                                            |

**The correctness heart of the feature**: `DRIVER_PAYABLE` and `PLATFORM_COMMISSION` are each credited **exactly once per ride**. Every later transition moves only the balancing side. Posting the full group on 7b would double-count earnings and revenue — this is what BD-4 means by "settles the existing obligation without creating another obligation", and it carries a dedicated test.

**The receivable is not a row** — it is `Ride.paymentStatus = FAILED` with no `WRITTEN_OFF` attempt row, amount `RideFare.totalFare`. Duplicates are impossible by primary key.

## Event and Outbox Plan

Three new events, all published with `publish(input, tx)` inside the state-changing transaction. Full contract: [contracts/events.md](./contracts/events.md).

| Event                            | Published in                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `payment.ride.collected`         | Transitions 2, 3, 4a, 4b, 7a, 7b                                                   |
| `payment.ride.collection_failed` | Transitions 5 and 6 — `willRetry: false` **is** the receivable-establishing signal |
| `payment.receivable.written_off` | Transition 8                                                                       |

- No separate debt event (§7.6) — two events for one transition is duplicate meaning.
- Boundary rule: ride-facing consumers subscribe to `payment.ride.collected` only, **never** `payment.succeeded`, or a card ride notifies twice.
- One `CONSUMER_KEYS` entry; `registerEventConsumers()` stays pure so integration tests can drive `processBatch()` by hand.
- `payment.wallet.debited` already exists in the catalog and has never been published; the debit path publishes it. **No new event needed for it.**

## Configuration Plan

| Knob                                 | Decision | Validation                              |
| ------------------------------------ | -------- | --------------------------------------- |
| `PAYMENT_COLLECTION_MAX_ATTEMPTS`    | BD-4     | `numericEnv`, 1–20, integer             |
| `PAYMENT_COLLECTION_RETRY_BASE_SEC`  | BD-4     | `numericEnv`, 30–86400, integer         |
| `PAYMENT_RIDER_DEBT_LIMIT`           | BD-2     | `numericEnv`, ≥ 0                       |
| `PAYMENT_CASH_CONFIRM_GRACE_SEC`     | BD-6     | `numericEnv`, ≥ 60, integer             |
| `PAYMENT_RECEIVABLE_WRITEOFF_DAYS`   | BD-1c    | `numericEnv`, ≥ 1, integer              |
| `PAYMENT_CASH_CONFIRMATION_REQUIRED` | BD-5     | boolean, **default `false`**            |
| `PAYMENT_LEDGER_CUTOVER_AT`          | BD-7     | ISO-8601; throws at boot if unparseable |

**Intentional, approved-decision exception (Finding 2)**: the project's boolean idiom is `process.env.X !== 'false'` — **default ON**. `PAYMENT_CASH_CONFIRMATION_REQUIRED` uses logic equivalent to `=== 'true'` so it defaults **OFF**, as BD-5 requires. Following the house idiom here would silently invert an approved business decision. This deviation is deliberate, documented, and asserted by a config unit test.

`PAYMENT_LEDGER_CUTOVER_AT` is a timestamp, which `numericEnv` does not cover; it is validated by a boot-time throw following the existing `readWebhookSecret` precedent in the same file — **not** a new helper. Cron patterns for the two jobs follow the existing `process.env.X_CRON ?? '<default>'` convention in `scheduler/index.ts`.

## Concurrency / Race Protection Plan

All twelve races, each with its **database** correctness boundary. Per §5.3, **Redis is never presented as the sole boundary**; where it appears it either _is_ the sanctioned mechanism (idempotency, §6.3) or only avoids wasted work.

| #   | Race                                                 | Correctness boundary                                                                                                                                                                                             | Redis role                                                     |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Duplicate payment confirmation                       | **Transaction** + `intentRepo.lockForUpdate` (`SELECT … FOR UPDATE`) + early-return on same status + `validateTransition`                                                                                        | none                                                           |
| 2   | Concurrent same `Idempotency-Key`                    | **Redis idempotency** — `IdempotencyStore.runOnce` in-flight claim. This is the sanctioned mechanism per §6.3, already tested                                                                                    | _is_ the mechanism                                             |
| 3   | Provider webhook replay                              | **Provider event identity** — unique `gatewayEventId` via `findOrPersist` **inside** the transaction                                                                                                             | none                                                           |
| 4   | Payment success racing failure                       | **Partial unique index** on `SUCCEEDED` + **conditional `updateMany` claim** `PENDING→PAID`. A failure appends an attempt row and **never claims the status**, so success wins deterministically                 | none                                                           |
| 5   | Retry racing another retry                           | **Partial unique index** + deterministic provider idempotency key (prevents a second charge at the provider)                                                                                                     | `payment:collect:{rideId}` — avoids wasted provider calls only |
| 6   | Retry settling a receivable without double-counting  | **`rideRepo.lockForUpdate` inside the transaction**, then branch 7a vs 7b on the _locked_ `paymentStatus`. The read that selects the ledger group must be the locked one                                         | same lock, optimisation only                                   |
| 7   | Write-off racing late collection                     | **Row lock on the ride** + write-off re-checks "still `FAILED` **and** no `SUCCEEDED` row" inside the transaction; **partial unique index** on `WRITTEN_OFF` is the backstop                                     | job-level lock                                                 |
| 8   | Debt-threshold check racing ride creation            | **Existing `rides_active_customer_key` partial unique index** — a customer cannot hold two active rides, so two concurrent requests cannot both succeed regardless of the debt read. **No new lock** (Finding 4) | none                                                           |
| 9   | Manual cash confirmation racing automatic resolution | **Conditional claim** `PENDING→PAID` + **partial unique index**. Whichever wins, the other is a no-op                                                                                                            | job-level lock                                                 |
| 10  | Multiple automatic-resolution job runs               | **Per-ride conditional claim** is the guarantee; `LockStore` job lock as `SettlementJob`/`ReconciliationJob` already use                                                                                         | avoids duplicate scans                                         |
| 11  | Ride lifecycle vs payment completion                 | **Conditional claim** in `completeRide` (`updateStatusIf`); collection runs only after commit via the **outbox**; `COMPLETED` has no outbound transitions                                                        | none                                                           |
| 12  | Duplicate outbox/event delivery                      | **Partial unique index** + conditional claims; **consumer idempotency** by construction — the consumer performs no unguarded write                                                                               | none                                                           |

Race 8 deserves emphasis: **the guard needs no new locking at all**, because a pre-existing invariant already serialises ride creation per customer. Reusing it is both correct and less code.

## Test Plan

Constitution §14.1 — every race carries a genuinely concurrent (`Promise.all`) test.

### Unit — `tests/unit/payments/`

| File                                       | Covers                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `payment-config.test.ts` _(extend)_        | 7 knobs reject `NaN`/non-numeric/out-of-range; **cash flag defaults `false`**; cut-over rejects unparseable dates |
| `wallet-debit.test.ts` _(new)_             | Debit records a **negative** transaction amount; overdraw throws and mutates nothing                              |
| `collection-service.test.ts` _(new)_       | Method routing; attempt capping; amount copied from fare, never recomputed; **7a vs 7b ledger selection**         |
| `ride-collection-consumer.test.ts` _(new)_ | Reads `rideId` from `envelope.data` (the dropped-`aggregateId` trap)                                              |
| `debt-service.test.ts` _(new)_             | Aggregate excludes written-off; `>=` boundary; driver view carries no block                                       |
| `collection-state.test.ts` _(new)_         | Derivation table; **`FAILED` never emitted publicly**                                                             |
| `ledger-invariant.test.ts` _(extend)_      | Receivable, settlement-clearing and write-off groups balance                                                      |

### Integration — `tests/integration/`

| File                                          | Covers                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wallet-funding.test.ts` _(new)_              | **RT-1** unbacked topup moves nothing · **RT-2** credit once on confirmation, unchanged by duplicate · **RT-4** balance ≡ ledger position · concurrent spends never overdraw                                                               |
| `ride-collection.test.ts` _(new)_             | Wallet + card collection · **RT-3** client cannot supply an amount or bind an intent to a ride · decline → `RETRYING` · cap → `UNPAID` · correct account per method · **races 4, 5, 6, 11, 12**                                            |
| `cash-settlement.test.ts` _(new)_             | Flag **OFF**: cash `PAID` at completion, confirm route returns `404`. Flag **ON**: `PENDING`, only assigned driver confirms, idempotent replay, auto-resolution after grace, **races 9 and 10**, commission carry-forward over two periods |
| `payment-receivable.test.ts` _(new)_          | Receivable created at exhaustion · settlement clears it **without re-recognising earnings** · write-off idempotent under repeated sweeps · write-off closes retry · **race 7**                                                             |
| `payment-debt-threshold.test.ts` _(new)_      | Boundary at **exactly** the limit · retry never blocked · written-off excluded · server-computed · **race 8**                                                                                                                              |
| `payment-idempotency.test.ts` _(new)_         | `confirmIntent` gap closed (FR-040) · **race 2** across every mutating payment route                                                                                                                                                       |
| `payment-webhook.test.ts` _(extend)_          | **race 3** replay now also asserts the wallet credits exactly once                                                                                                                                                                         |
| `payment-reconciliation.test.ts` _(new)_      | Divergence detected against the **ledger** for customer _and_ driver wallets · receivable and bad-debt identities · pre-cut-over reported separately                                                                                       |
| `payment-ledger-immutability.test.ts` _(new)_ | **BD-7** — snapshot pre-cut-over rows, run all migrations + jobs, assert byte-identical                                                                                                                                                    |
| `earnings-pipeline.test.ts` _(extend)_        | Uncollected ride's earnings **included in full** (BD-1) · later settlement does not increase the payable                                                                                                                                   |
| `route-graph.test.ts` _(verify)_              | New routes authenticated; `SANCTIONED_PUBLIC` unchanged                                                                                                                                                                                    |
| `helpers/fixtures.ts` _(fix)_                 | Rider profile name so booking stops returning `422 INCOMPLETE_PROFILE`                                                                                                                                                                     |

**The fixture fix is not a weakened test.** The 15 pre-existing failures fail at ride _booking_ (`ride.errors.ts:117`) because the fixture creates a rider with no profile name; **their assertions have never executed**. Fixing the fixture makes them run for the first time. This is the only "make it pass" change, and §15.3 is otherwise absolute.

## Risks and Deployment Plan

| Risk                                                                                    | Mitigation                                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Debit written with a positive amount** silently breaks reconciliation on correct data | Dedicated unit test; flagged in plan and data model. Highest-likelihood subtle bug             |
| Ledger double-counting on 7b                                                            | Locked-read branch + explicit test; the single highest-value assertion                         |
| Wallet CHECK constraint fails on deploy                                                 | Mandatory pre-flight query against the target DB (§3.5)                                        |
| Index creation locks a large table                                                      | `CONCURRENTLY` before `migrate deploy`; `IF NOT EXISTS` makes the migration a no-op            |
| Cash flag enabled before the driver app ships                                           | Default **OFF**; BD-6 auto-resolution bounds exposure even if enabled early                    |
| Single-instance realtime                                                                | Unchanged; no new assumption. Sweeps take a `LockStore` lock so a future second worker is safe |

**Deployment order**: pre-flight constraint check → `CONCURRENTLY` indexes on large tables → `migrate deploy` → deploy image (cash flag OFF) → verify reconciliation clean → enable cash flag when the driver app is ready.

**Rollback**: every migration is additive, so the previous image runs unchanged against the new schema. The cash flag reverts behaviour without a deploy. No data migration means no down-migration is required.

## Complexity Tracking

No constitution violations. Deliberate simplifications, each with a stated ceiling:

| Simplification                                       | Ceiling                                                                              | Upgrade path                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Receivable as a projection of `Ride.paymentStatus`   | Aggregate cost grows with a rider's unpaid count, expected in single digits          | Materialize a balance if it reaches a hot path                        |
| Driver commission as negative `DriverWallet.balance` | Conflates "owes commission" with wallet balance in one number                        | Split into an explicit receivable if driver-facing reporting needs it |
| Retry + cash auto-resolution in one sweep job        | Both scan `rides` at `paymentStatus=PENDING`; diverging cadences would force a split | Split into two jobs                                                   |

## Phase Status

- **Phase 0 (research)**: complete — [research.md](./research.md), 16 sections with rejected alternatives
- **Phase 1 (design)**: complete — [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md) (11 scenarios)
- **Phase 2 (tasks)**: not started. `tasks.md` superseded; regenerate with `/speckit-tasks`
