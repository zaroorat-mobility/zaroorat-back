# Implementation Audit: Dual Driver Payment Model (Subscription vs. Commission)

**Feature**: `004-driver-subscription-wallet` | **Date**: 2026-09-08

**Status**: AUDIT ONLY — no code has been modified. This document is the pre-implementation gate requested: sections A–J describe the codebase exactly as it exists today (every claim cited to a file/line, cross-checked against [research.md](./research.md) and two files re-verified directly for this audit); sections K–R are the gap analysis and exact change list against the target model already specified in [spec.md](./spec.md) / [data-model.md](./data-model.md) / [decisions.md](./decisions.md) / [plan.md](./plan.md) / [revision-002-dual-model.md](./revision-002-dual-model.md). Nothing here is implemented until you approve it.

> **Note (later revision)**: §O below describes `CommissionWalletService.deductInTx` as "capped at current balance" — that description was accurate when this audit was written but has since been withdrawn. There is no cap and no partial deduction in the current design; see `decisions.md` BD-1 for the current, authoritative rule (full deduction or none, with an insufficient balance treated as a logged exceptional condition). This audit is left otherwise as the historical snapshot it was when written.

---

## A. CURRENT PAYMENT ARCHITECTURE

Fastify + Prisma + Awilix modular monolith. Payment logic is concentrated in `src/modules/payments/` (constitution §1.4: "financial mutation belongs to payments"), with a strict, enforced read/write split against other modules — e.g. `src/modules/drivers/repositories/driver-wallet.repository.ts` has a `lockForUpdate` method that is **never called by anything** (`src/modules/drivers/services/wallet/wallet.service.ts` is a 2-method read-only view, `DriverWalletViewService`), while `src/modules/payments/repositories/settlement-wallet.repository.ts:4-8` carries an explicit doc comment: _"Owns the one write path onto `driver_wallets.balance`... financial mutation belongs to `payments`."_ This exact split is the template this feature must reuse for the new Commission Wallet.

Gateway abstraction: `PaymentGatewayProvider` interface (`src/modules/payments/services/gateway/gateway.provider.ts:21-36`), three implementations — `MockGatewayProvider`, `RazorpayGatewayProvider` (`src/integrations/razorpay/razorpay.client.ts`), `StripeGatewayProvider` (`src/integrations/stripe/stripe.client.ts`). **All three fabricate IDs with `randomUUID()` and always return success — none makes a real SDK/HTTP call.** Gateway choice is one global config value (`paymentConfig.defaultGateway`).

Governing pattern for every money-moving flow: gateway call happens **outside** any DB transaction; a separate, DB-only transaction (`TransactionManager.execute`, a thin wrapper over Prisma's `$transaction`) then persists the effect + posts the ledger + credits/debits the relevant wallet. `IntentService.createIntent`/`confirmIntent` (`src/modules/payments/services/intent/intent.service.ts`) is the reference implementation of this pattern. **Two existing deviations** from this pattern exist and are pre-existing, not something to imitate: `PayoutService.executePayout` (`payout.service.ts:70`) and `RefundService.processRefund`/`processPendingRefund` (`refund.service.ts:68,143`) call the gateway _inside_ the transaction.

## B. CURRENT SUBSCRIPTION FLOW

**NOT IMPLEMENTED.** Exhaustive case-insensitive grep for `"subscription"` across `src/modules/payments`, `src/modules/drivers`, `src/modules/rides`, `src/modules/matching`, `src/core`, `src/jobs`, `src/bootstrap` returns zero hits for a billing/subscription concept. No `SubscriptionPlan`, `DriverSubscription`, or equivalent Prisma model exists anywhere in `prisma/schema/`.

## C. CURRENT WALLET FLOW

Two wallets exist today, **neither of which is the Commission Wallet this feature needs**:

1. **`CustomerWallet`** (`prisma/schema/modules/wallet/wallet.prisma:23-38`) — funded by the customer via `POST /api/v1/payments/wallet/topup`, debited when the customer pays a ride fare by the `WALLET` method. `WalletService` (`src/modules/payments/services/wallet/wallet.service.ts`) has `creditInTx`/`debitInTx` (caller-supplied transaction required) and `hold`/`releaseHold` (opens its own transaction, backed by a generic `WalletHold` model). Fully unrelated to driver commission.
2. **`DriverWallet`** (`prisma/schema/modules/driver/driver.prisma:126-141`) — the driver's **earnings/payout** wallet, credited only by `SettlementService` at the daily settlement batch (`settlement.service.ts:89-100`), never by the driver themselves. It has a `lockedBalance` column that is **declared but never used anywhere in the codebase** (confirmed by full-repo search — no code ever sets it). Its `debit` path (`SettlementWalletRepository.debit`, `settlement-wallet.repository.ts:72-109`) is explicitly allowed to go negative — this is the existing cash-commission-recovery mechanism (see D below), not a driver-funded prepaid balance.

**There is no wallet today that a driver manually recharges to pre-fund ride commission.** No route, controller, or service allows it.

## D. CURRENT COMMISSION FLOW

Commission is computed once, per ride, at completion: `PricingService.calculateFinalFare` (external to the payments module, called from `LifecycleService.completeRide`) produces `itemizedFare.platformCommission`, written onto the `RideFare` row (`lifecycle.service.ts:699-717`, field at line 714). This is the **existing** commission calculation this feature must reuse unmodified, per your instruction not to invent a new formula.

**How it's actually collected today — reactive, not proactive, cash-only in terms of a wallet debit:**

- For a **cash** ride (only if `PAYMENT_CASH_CONFIRMATION_REQUIRED` is on — off by default): `RideCollectionService.confirmCash` (`collection.service.ts:107-206`) computes `owedByDriver = fare.totalFare - fare.driverEarning` and calls `SettlementWalletRepository.debit`, which is allowed to drive `DriverWallet.balance` negative — the doc comment states this negative _is_ the outstanding commission, cleared at the next settlement.
- For every **other** payment method (wallet/card/UPI, or cash with the flag off): commission is recognized only in the accounting sense (`LedgerService.recordTripPayment` credits `PLATFORM_COMMISSION`) — **no wallet is ever debited**, because the money already arrived at the platform via the gateway/customer wallet; there is nothing further to take from the driver.
- **Recovery of the negative `DriverWallet` balance happens only at the next daily settlement run** (`SettlementService.calculateSettlement`, `settlement.service.ts:18-112`), which nets `commissionOnCollected + stillOwedOnCash` against earnings, using `alreadyRecoveredCommission` (`settlement.repository.ts:192-217`) to avoid double-recovering what the cash-confirmation debit already took.

**Confirmed absent: any real-time, pre-ride-acceptance financial eligibility check.** `DebtService.driverOutstanding` (`debt.service.ts:58-63`) computes how negative a driver's earnings wallet is but its own doc comment states it "deliberately returns no limit/blocked flag" — this is BD-3 of feature `002-payment-fare-settlement`: a driver's outstanding debt does **not** block them from receiving new rides today. **Confirmed absent: any reservation/freeze/locked-balance mechanism** — `DriverWallet.lockedBalance` is unused (above), and no code anywhere creates a `WalletHold` against a driver-side wallet.

## E. CURRENT RIDE COMPLETION FLOW

`LifecycleService.completeRide` (`src/modules/rides/services/lifecycle/lifecycle.service.ts:564-796`), entirely inside one `txManager.execute` transaction:

1. Lock + validate the ride, transition status toward `COMPLETED`.
2. Compute billed distance/duration, apply plausibility/fare-ceiling checks.
3. `itemizedFare = pricingService.calculateFinalFare(...)` — includes `driverEarning`, `platformCommission` (lines 661-670).
4. Conditional-claim status update (`rideRepo.updateStatusIf`, guarded by expected prior status).
5. **`RideFare` row created** (699-717) — this is where `platformCommission` first exists as a persisted value, in the same transaction as the status transition.
6. **Only for cash rides settling here** (`cashSettlesHere = paymentMethod === 'CASH' && !cashConfirmationRequired()`): `LedgerService.recordTripPayment` posts the customer-fare ledger group synchronously (736-754). Every other payment method posts nothing at this point — that happens later, out-of-band, when `RideCollectionService.collect` runs (triggered by the ride-completed outbox event).
7. `driverRepository.recordCompletedRide` — increments ride/distance counters **only**, explicitly not `totalEarnings` (a doc comment at 755-761 states settlement owns that).
8. Driver status set back to `ONLINE`.

**No external gateway call occurs anywhere in this method** — confirmed, both before and independent of this feature. This is exactly the "decoupled from external payment processing" property the target model requires, already true by construction.

## F. CURRENT PAYMENT WEBHOOK FLOW

`WebhookService.handleGatewayWebhook` (`src/modules/payments/services/webhook/webhook.service.ts:45-100`):

1. Signature verification against **one shared secret regardless of gateway** (`paymentConfig.webhookSecret`) — not a real per-provider HMAC scheme.
2. Event-id extraction; missing id throws.
3. Freshness/replay check — **soft-fails (logs only, does not reject) if the timestamp field is absent**, a gap worth being aware of but not something this feature needs to fix.
4. **Deduplication**: inside a transaction, `WebhookRepository.findOrPersist` does a DB-level find-or-create keyed on the **composite unique `(gateway, gatewayEventId)`** — a real database constraint, not a cache check. Already-seen events short-circuit before any effect.
5. If not a duplicate and the event type is a recognized settlement event, resolves the `PaymentIntent` and calls `IntentService.applyConfirmation` **in the same transaction** as the dedup insert.

**`IntentService.applyConfirmation` today unconditionally credits `CustomerWallet` on every `SUCCEEDED` intent** (`intent.service.ts:138-183`) — there is currently no field distinguishing "this intent is for a customer wallet top-up" from anything else, because nothing else has ever gone through this pipeline. This is the one place this feature's new flows (subscription payment, wallet recharge) cannot simply plug in unmodified — see M below.

## G. CURRENT DATABASE MODELS

| Table (existing)                                                                   | Holds                                                                                                    | Relevant to this feature?                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_intents` (`PaymentIntent`)                                                | Gateway payment intent lifecycle, `idempotencyKey` unique, `rideId`/`userId`/`amount`/`status`/`gateway` | **Reused** as the pipeline for subscription payment and recharge; needs one additive column (`purpose`)                                                                                         |
| `payment_transactions`, `gateway_events`, `refunds`, `chargebacks`                 | Transaction/webhook/refund/dispute records                                                               | Reused unchanged; `gateway_events` unique `(gateway, gatewayEventId)` is the dedup backstop                                                                                                     |
| `payment_ledger_entries` (`PaymentLedgerEntry`)                                    | Double-entry: `entryGroup`, `account`, `direction`, `amount`, `referenceType/Id`                         | Reused unchanged; two new `account` values needed                                                                                                                                               |
| `settlement_batches`, `driver_settlements`, `driver_payouts`, `payout_items`       | Batch settlement + payout                                                                                | Reused unchanged; `driver_settlements`' commission-recovery query needs one additive clause (TD-1)                                                                                              |
| `customer_wallets`, `customer_wallet_transactions`                                 | Customer prepaid balance                                                                                 | Untouched by this feature                                                                                                                                                                       |
| `driver_wallets`, `driver_wallet_transactions`                                     | Driver **earnings** balance, credited at settlement                                                      | Untouched — this feature never writes here (a different table, `driver_commission_wallets`, is added instead)                                                                                   |
| `wallet_holds`, `wallet_adjustments`, `wallet_reconciliations`, `wallet_transfers` | Generic reservation/adjustment/reconciliation primitives, currently customer-wallet-only in practice     | `wallet_holds` is **not used by this feature** (no reservation, per your instruction); `wallet_adjustments`/`wallet_reconciliations` are extended to a new `walletType` value, no schema change |
| `drivers` (`Driver`)                                                               | Verification/suspension/availability, etc.                                                               | Needs two additive columns: `payment_model`, `pending_payment_model`                                                                                                                            |
| `rides` (`Ride`)                                                                   | Ride lifecycle, `paymentMethod`, `paymentStatus`                                                         | Needs one additive column: `driver_payment_model` (pinned at accept)                                                                                                                            |
| `ride_fares` (`RideFare`)                                                          | `platformCommission`, `driverEarning`, computed at completion                                            | Reused unchanged — this is the existing commission source of truth                                                                                                                              |

**Missing entirely**: any subscription table, any commission-plan table, any driver-recharged commission-wallet table, any predefined-recharge-amount table, any driver-payment-model classification field, any per-ride payment-model field.

## H. CURRENT APIs

**Payments module** (`src/modules/payments/routes/payment.routes.ts`, mounted `/api/v1/payments`):

| Method | Path                         | Idempotency-Key | Auth                                                                      |
| ------ | ---------------------------- | --------------- | ------------------------------------------------------------------------- |
| GET    | `/methods`                   | —               | caller                                                                    |
| GET    | `/me/debt`                   | —               | caller                                                                    |
| GET    | `/wallet/balance`            | —               | caller (customer wallet)                                                  |
| POST   | `/wallet/topup`              | Yes             | caller + rate-limited                                                     |
| POST   | `/wallet/hold`               | Yes             | caller + rate-limited                                                     |
| POST   | `/intents`                   | Yes             | caller + rate-limited                                                     |
| POST   | `/intents/:intentId/confirm` | Yes             | owner-or-staff + rate-limited                                             |
| POST   | `/refunds`                   | Yes             | caller + rate-limited                                                     |
| POST   | `/webhooks/:gateway`         | dedup only      | **public** (the only public payment route — enforced by an existing test) |

`ride-payment.routes.ts` (mounted `/api/v1/rides`): `GET /:rideId/payment`, `POST /:rideId/payment/retry`, `POST /:rideId/payment/confirm-cash` (route registered only when the cash-confirmation flag is on).

**Drivers module** wallet routes (`driver.routes.ts`): `GET /:driverId/wallet`, `GET /:driverId/wallet/transactions` — both read-only, against the **earnings** wallet (`driver_wallets`), not any commission wallet.

**Missing entirely**: any subscription-plan/purchase/status route, any driver-facing recharge route, any driver-payment-model route, any commission-plan route, any predefined-recharge-amount route. `PayoutService` has no `/api/v1/payments` route at all — payout is admin-only (`/api/v1/admin/payments/payouts`).

## I. CURRENT ACCOUNTING/LEDGER FLOW

`LedgerService.postTransactionGroup(items, tx)` (`ledger.service.ts:99-110`) rejects any non-positive leg amount; balancing (debit=credit) is achieved structurally by every caller constructing matched legs, not by a runtime sum check. **Existing accounts**: `CUSTOMER_WALLET`, `DRIVER_PAYABLE`, `PLATFORM_COMMISSION`, `GATEWAY_CLEARING`, `TAX_PAYABLE`, `CUSTOMER_RECEIVABLE`, `BAD_DEBT_EXPENSE` (declared in `constants/payment.constants.ts:18-31`); `PLATFORM_FEE` is also posted as a literal but is **not** in that constants file — a pre-existing, minor inconsistency, not introduced by and not required to be fixed by this feature. `recordTripPayment` (`ledger.service.ts:111-176`) is the canonical "ride fare settles" posting.

**No `SUBSCRIPTION_REVENUE` or `DRIVER_COMMISSION_WALLET` account exists yet** — both are net new, needed for this feature.

## J. CURRENT IDEMPOTENCY/CONCURRENCY HANDLING

- **HTTP-mutation idempotency**: `IdempotencyRepository.runIdempotent` (`idempotency.repository.ts:31-65`) — Redis-backed, key scoped `${userId}:${route}:${key}`, SHA-256 of a stable-stringified payload for duplicate-payload detection, `RedisService.runOnce` collapsing concurrent identical requests to one execution. Wired through `PaymentService.withIdempotency`. **This is the one idempotency mechanism in the codebase — constitution §6.4 forbids a second one.**
- **Webhook idempotency**: a **different, deliberate** mechanism — DB unique constraint `(gateway, gatewayEventId)`, since the provider (not the client) supplies the identity. Also not to be duplicated.
- **Row locking**: `SELECT ... FOR UPDATE` via repository `lockForUpdate` methods (`WalletRepository`, `SettlementWalletRepository`, `RideDispatchRepository`, `RideRepository`, etc.) before any read-modify-write of a contended row.
- **Conditional claims**: an `updateMany` guarded by the expected prior state, whose returned count decides the outcome (`RideDispatchRepository.respondIfPending`, `RideRepository.updateStatusIf`, `RideRequestRepository.claimForMatch`).
- **Redis locks** (`LockStore.acquire`/`release`, `src/core/cache/stores/LockStore.ts`, token-based `SET NX PX` + Lua-guarded delete) — used pervasively (every scheduled job, dispatch, collection) but **always layered on top of a DB-level guarantee, never the sole correctness mechanism** — constitution §5.3, explicitly "settled" policy.
- **Partial unique indexes as the hard backstop**, confirmed by direct file read for this audit: `rides_active_driver_key ON rides(driver_id) WHERE status IN ('ACCEPTED','DRIVER_ARRIVING','DRIVER_ARRIVED','IN_PROGRESS')` (migration `20260821130000_ride_active_uniqueness`) is the **database-level** enforcement of "one active ride per driver" — its own migration comment states the exact reasoning: the application check (`rideRepo.findActiveByDriver`, a plain unlocked `findFirst` at `ride.repository.ts:90-101`) alone cannot prevent two different ride requests racing to be accepted by the same driver in the same instant; the unique index is what actually prevents it, by making the second `INSERT` fail. **This directly confirms the premise section 6 of your instructions asks me to verify: the one-active-ride-per-driver rule is already enforced, and enforced correctly (DB-level, not merely app-level) — no new enforcement is required before proceeding.**
- **`TransactionManager.execute`** — thin wrapper over Prisma's `$transaction`; no nested-transaction support, no default isolation level, no automatic retry-on-conflict.

---

## K. WHAT ALREADY MATCHES THE NEW REQUIREMENT

- **Provider-confirmed-only crediting** (`IntentService.applyConfirmation`) — directly reusable, unmodified in mechanism, for both subscription payment and wallet recharge.
- **Idempotency mechanism** (Redis, per user+route+key) and **webhook dedup** (DB unique constraint) — both directly reusable, no new mechanism needed anywhere in this feature.
- **Double-entry ledger** (`LedgerService.postTransactionGroup`) — directly reusable; only two new account values needed, no new posting mechanism.
- **Gateway-outside-transaction pattern** — already correctly implemented in `IntentService`/`RideCollectionService.charge`, the exact template the new subscription/recharge flows must follow (and must _not_ imitate `PayoutService`/`RefundService`'s in-transaction gateway calls).
- **Row-locking template for wallet mutation** (`WalletRepository.lockForUpdate`, `SettlementWalletRepository.lockForUpdate`) — the exact pattern the new `CommissionWalletRepository.lockForUpdate` reuses.
- **Immutable, balance-after-audited wallet transaction pattern** (`CustomerWalletTransaction`/`DriverWalletTransaction`) — the exact template `DriverCommissionWalletTransaction` reuses.
- **Module read/write boundary** (drivers = read view, payments = write owner, for `DriverWallet`) — the exact template for the new `DriverCommissionWallet` split.
- **One-active-ride-per-driver — confirmed database-enforced** (`rides_active_driver_key`), which is precisely the fact the "no commission reservation/freeze needed" design in `decisions.md` (BD-4) depends on. This already exists; nothing needs to change here.
- **Customer payment isolation from driver-side wallets** — already true today (`RefundService` never references any driver-side table; confirmed by full read). Nothing to build, only something to not break.
- **Final commission calculation** (`PricingService.calculateFinalFare` → `RideFare.platformCommission`) — the existing, correct source this feature reuses without inventing a new formula, per your explicit instruction.

## L. WHAT DOES NOT MATCH

- No subscription concept anywhere (B above).
- No driver-recharged Commission Wallet — `DriverWallet` is an earnings wallet, credited by the company at settlement, the _opposite_ economic direction from what's needed.
- No driver payment-model classification, anywhere.
- No per-ride pinned payment-model field.
- No real-time, pre-ride-acceptance financial eligibility check of any kind — today's eligibility gates (`DriverEligibilityService`, `StatusService.setOnline`, `MatchingService.operableDriverIds`) check verification/suspension/documents/vehicle/online-status only.
- Commission collection today is reactive (settlement, daily batch) and, for anything but cash, never actually debits a driver-held wallet at all — because currently nothing is ever "owed back" by the driver except the cash case.
- Gateway integrations are non-functional stubs — any new payment-collecting flow this feature adds inherits that same limitation; it is not this feature's job to fix it (flagged, not addressed).

## M. WHAT MUST BE CHANGED (existing files)

| File                                                                                | Change                                                                                                                                                                                                                                                              | Why                                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `intent.service.ts` (`applyConfirmation`)                                           | Branch the `SUCCEEDED` effect on a new `PaymentIntent.purpose` field instead of unconditionally crediting `CustomerWallet`                                                                                                                                          | Otherwise a subscription/recharge payment would wrongly credit the customer wallet                       |
| `lifecycle.service.ts` (`acceptRideRequest`)                                        | Insert the payment-model branch (subscription-active check _or_ wallet-sufficiency check, no lock, no reservation) after the existing vehicle-eligibility check, before the conditional claim; add `driverPaymentModel` to the existing `rideRepo.create(...)` call | This is the ride-eligibility gate the new model requires                                                 |
| `lifecycle.service.ts` (`completeRide`)                                             | Insert the payment-model branch after the existing `RideFare` creation — commission-model rides call the new deduction service, subscription-model rides do nothing                                                                                                 | This is where commission is actually collected under the new model                                       |
| `settlement.repository.ts` (`alreadyRecoveredCommission`) / `settlement.service.ts` | Extend the existing "already recovered" exclusion (currently cash-only) to also exclude commission already collected via the new Commission Wallet                                                                                                                  | Prevents double-collecting the same ride's commission once via the wallet and again at settlement (TD-1) |
| `collection.service.ts` (`confirmCash`)                                             | Add a check for an existing wallet-collected commission transaction before computing `owedByDriver`                                                                                                                                                                 | Prevents double-collection for a commission-model driver who happens to take a cash ride                 |
| `payment.routes.ts`, `driver.routes.ts`                                             | Add new routes (see Q)                                                                                                                                                                                                                                              | New endpoints needed                                                                                     |
| `constants/payment.constants.ts`                                                    | Add `DRIVER_COMMISSION_WALLET`, `SUBSCRIPTION_REVENUE` to `LEDGER_ACCOUNTS`                                                                                                                                                                                         | New accounting entries need declared accounts                                                            |

## N. WHAT MUST BE REMOVED

**From the existing, deployed codebase: nothing.** This is a purely additive feature against everything audited in A–J; no existing table, column, route, or behavior is removed or altered beyond the additive changes in M.

**From this feature's own design, per your explicit instruction — must never be built in the first place** (not "removed," since none of it exists yet): a `reserved_balance`/`locked_balance` field on any commission wallet, any commission-reservation/freeze step at ride acceptance, any reuse of `wallet_holds` for commission. `decisions.md` (BD-4) records the reasoning: the confirmed database-enforced one-active-ride-per-driver invariant (J/K above) makes the scenario reservation would protect against structurally impossible, so the wallet deduction only needs an ordinary row lock at the moment of the write, not a whole extra reservation state.

## O. WHAT MUST BE ADDED (net new)

- `Driver.paymentModel`, `Driver.pendingPaymentModel` — the payment-model classification (drivers module owns the write, same as `verificationStatus`/`isSuspended`).
- `Ride.driverPaymentModel` — pinned at acceptance (rides module, additive field on the existing `rideRepo.create` insert).
- `SubscriptionPlan`, `DriverSubscription` (new `subscriptions` module; `billingPeriod` includes `DAILY`).
- `CommissionPlan` — a company-configurable record of the commission rate, in this revision a label over the existing `PricingService` calculation, not a second calculation engine (scope note carried into the Approval Checklist).
- `DriverCommissionWallet`, `DriverCommissionWalletTransaction` (payments module owns writes) + a read-only `DriverCommissionWalletViewService` (drivers module) — mirroring the exact `DriverWallet` split.
- `WalletRechargeOption` — company-configurable predefined recharge amounts.
- `PaymentIntent.purpose` additive column (`CUSTOMER_WALLET_TOPUP` default-preserved / `DRIVER_COMMISSION_RECHARGE` / `DRIVER_SUBSCRIPTION_PAYMENT`).
- `CommissionWalletService.hasSufficientBalance` (plain read, no lock, no side effect) and `.deductInTx` (locked, idempotent-by-existing-transaction-check, capped at current balance) — **no `reserve`/`release` methods**.
- Two new ledger accounts.
- `subscription-expiry.job.ts` — new scheduled job (reusing the existing BullMQ + `LockStore` "skip if already running" pattern every other payments job already uses), which also applies any staged `SUBSCRIPTION → COMMISSION` payment-model switch when the current period ends.
- Two new partial unique indexes: at most one `ACTIVE` subscription per driver; at most one `RIDE_COMMISSION` deduction per ride (the idempotency backstop for use case 9).

## P. DATABASE MIGRATION REQUIREMENTS

Purely additive, consistent with constitution §3.2:

- **New tables**: `subscription_plans`, `driver_subscriptions`, `commission_plans`, `driver_commission_wallets`, `driver_commission_wallet_transactions`, `wallet_recharge_options`.
- **New columns**: `payment_intents.purpose` (default-valued, no backfill needed), `drivers.payment_model` (nullable), `drivers.pending_payment_model` (nullable), `rides.driver_payment_model` (required, written at every ride-creation path).
- **New partial unique indexes**: `driver_subscriptions_one_active`, `commission_wallet_one_deduction_per_ride`.
- **No existing column dropped, renamed, or rewritten. No existing row rewritten.**
- Sequencing: schema migration deploys first (safe against the still-running previous app version, since nothing yet reads/writes the new tables/columns); application code deploys second, gated behind a feature flag defaulting off, exactly the pattern feature `002-payment-fare-settlement` already used for `PAYMENT_CASH_CONFIRMATION_REQUIRED`.

## Q. API CHANGES

| API                                                                      | Current                                           | Required new behavior                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(new)_ `POST /api/v1/drivers/payment-model`                             | Does not exist                                    | Select/switch model; self-auth; body `{paymentModel}`; immediate or staged per BD-5; no idempotency key needed (naturally idempotent for a repeat value)                         |
| _(new)_ `GET /api/v1/drivers/payment-model`                              | Does not exist                                    | Current model + pending change + `effectiveAt`                                                                                                                                   |
| _(new)_ `POST /api/v1/subscriptions/plans` (admin)                       | Does not exist                                    | Create plan; `billingPeriod` ∈ {DAILY, WEEKLY, MONTHLY}                                                                                                                          |
| _(new)_ `GET /api/v1/subscriptions/plans`                                | Does not exist                                    | List active plans; driver-facing                                                                                                                                                 |
| _(new)_ `POST /api/v1/subscriptions`                                     | Does not exist                                    | Select plan + pay; `Idempotency-Key` required; creates `PENDING_PAYMENT` row + `PaymentIntent` (purpose `DRIVER_SUBSCRIPTION_PAYMENT`); activation only on provider confirmation |
| _(new)_ `GET /api/v1/subscriptions`                                      | Does not exist                                    | Current subscription status                                                                                                                                                      |
| _(new)_ `POST /api/v1/subscriptions/cancel`                              | Does not exist                                    | Stages cancellation per BD-3                                                                                                                                                     |
| _(new)_ `GET/POST /api/v1/payments/driver-wallet/recharge-options`       | Does not exist                                    | List (driver) / manage (admin) predefined amounts                                                                                                                                |
| _(new)_ `POST /api/v1/payments/driver-wallet/recharge`                   | Does not exist                                    | `{amount}` xor `{rechargeOptionId}`; validated server-side against configured min/max or active option list; `Idempotency-Key` required; credits only on provider confirmation   |
| _(new)_ `GET /api/v1/drivers/:driverId/commission-wallet[/transactions]` | Does not exist                                    | Read-only, `authorizedDriverId` guard (self-or-staff, same as existing earnings-wallet routes)                                                                                   |
| `POST /api/v1/rides/accept` (existing)                                   | No financial eligibility check                    | Adds `409 PAYMENT_MODEL_NOT_SELECTED` / `409 DRIVER_SUBSCRIPTION_REQUIRED` / `409 INSUFFICIENT_COMMISSION_BALANCE` failure modes; success response unchanged                     |
| `POST /api/v1/payments/webhooks/:gateway` (existing)                     | Confirms customer-topup/ride-payment intents only | Unchanged mechanism; now also confirms subscription/recharge intents via the new `purpose` dispatch                                                                              |

Every new mutating endpoint follows the existing conventions confirmed in A/J: deny-by-default auth, UUID path validation, Zod request schemas, coded errors below 500, `Idempotency-Key` required for anything that moves money (not required for the payment-model selection endpoint itself, since it moves no money).

## R. TEST CASES

Mapped directly to your 14 required use cases, each stating which existing or new mechanism (from K/O) guarantees the outcome:

| #   | Use case                                                                      | Guaranteed by                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Subscription driver, active subscription, ride offered                        | New `subscriptionRepo.findActive` check in `acceptRideRequest`                                                                                                                                                         |
| 2   | Subscription driver, ₹0 wallet, ride offered                                  | The commission-wallet branch is never entered for `paymentModel = 'SUBSCRIPTION'` — structurally, not by a special-case guard                                                                                          |
| 3   | Subscription driver, expired subscription, new ride requested                 | Same check as #1, `expiryDate <= now` branch                                                                                                                                                                           |
| 4   | Subscription expires during an active ride                                    | `Ride.driverPaymentModel` pinned `SUBSCRIPTION` at accept; completion never re-checks subscription status (BD-2, unchanged)                                                                                            |
| 5   | Commission driver, ₹500 wallet, ₹100 expected commission                      | New `CommissionWalletService.hasSufficientBalance` plain read                                                                                                                                                          |
| 6   | Commission driver, ₹50 wallet, ₹100 expected commission                       | Same check, `balance < expected` branch → `409`                                                                                                                                                                        |
| 7   | Commission driver accepts ride — no deduction, no freeze, no reserved balance | `hasSufficientBalance` has no side effect at all; confirmed by design (K/N) — nothing exists to freeze                                                                                                                 |
| 8   | Commission ride completes, ₹100 commission → wallet −₹100                     | New `CommissionWalletService.deductInTx`, locked read-modify-write                                                                                                                                                     |
| 9   | Same ride-completion request twice → deducted once                            | `deductInTx`'s existing-transaction check + the new partial unique index (`commission_wallet_one_deduction_per_ride`) as the hard backstop — same pattern as the existing `RidePayment` one-`SUCCEEDED`-per-ride index |
| 10  | Wallet recharge ₹500 succeeds → +₹500 once                                    | Existing `IntentService.applyConfirmation`, provider-confirmed-only crediting                                                                                                                                          |
| 11  | Same recharge webhook twice → +₹500 once, not twice                           | Existing `WebhookRepository.findOrPersist` DB-unique dedup, unmodified                                                                                                                                                 |
| 12  | Wallet recharge fails → not credited                                          | Existing intent-failure path, unmodified                                                                                                                                                                               |
| 13  | Commission driver, insufficient wallet → ride cannot be accepted              | Same as #6                                                                                                                                                                                                             |
| 14  | Subscription driver completes ride → no commission-wallet deduction           | Same as #4 — the deduction branch is structurally unreachable for `driverPaymentModel = 'SUBSCRIPTION'`                                                                                                                |

Plus the concurrency-specific case your instructions raised in §6/§21: **two "simultaneous" ride-accepts for the same driver** — verified in J/K above as already database-enforced (`rides_active_driver_key`), so this feature adds a regression test asserting that invariant still holds (a `Promise.all` double-accept against different ride requests for one driver, asserting exactly one succeeds) rather than adding new enforcement for it.

Full detail (request/response shapes, error tables, the complete original 26+4 edge cases, and the full test matrix) is already written out in `plan.md` ("API Specification", "Testing Strategy") and `revision-002-dual-model.md` (§12, §14) — this document exists to answer your audit questions directly, not to duplicate that content a second time.

---

## Answering your five database-review questions directly (§18)

1. **What already exists?** Full payment intent/webhook/ledger/idempotency infrastructure; a customer wallet; a driver _earnings_ wallet (settlement-credited); the fare/commission calculation engine; the one-active-ride-per-driver database constraint. See G.
2. **What is missing?** Every subscription table, the commission wallet itself, the payment-model classification (driver-level and ride-level), commission-plan and recharge-option configuration tables. See G, L.
3. **What needs to change?** Six existing files, all additive extensions, listed exhaustively in M. Nothing else.
4. **What old reservation/freeze fields need to be removed?** None — none were ever built. The instruction to not implement them is a constraint on the _new_ design, not a cleanup of existing code.
5. **What fields must be added?** Listed exhaustively in O and P.

**Nothing has been implemented.** This audit, together with the already-existing `spec.md`/`data-model.md`/`decisions.md`/`plan.md`, is ready for your approval before any code is written.
