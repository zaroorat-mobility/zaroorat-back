# Implementation Plan: Driver Subscription & Commission Wallet (Dual Model)

**Branch**: `004-driver-subscription-wallet` | **Date**: 2026-09-08 | **Revised**: 2026-09-08 (dual payment-model; commission determined once at acceptance, never recalculated — BD-7) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-driver-subscription-wallet/spec.md`, grounded in the codebase audit in [research.md](./research.md), the resolved decisions in [decisions.md](./decisions.md), the schema design in [data-model.md](./data-model.md), and the business-model revision rationale in [revision-002-dual-model.md](./revision-002-dual-model.md).

**Status**: PLAN — no code has been written or modified. This document, together with its companions, is the artifact requiring approval before implementation begins (see **Approval Checklist** at the end).

---

## Summary

Two mutually exclusive driver payment models, recorded per-driver (`Driver.paymentModel`) and pinned per-ride at acceptance (`Ride.driverPaymentModel`) so a ride is never processed under two models. `SUBSCRIPTION`-model drivers pay a periodic plan fee (1-Day/Weekly/Monthly) that alone governs ride eligibility, with **no** Commission Wallet involvement of any kind for their rides. `COMMISSION`-model drivers maintain a Commission Wallet (custom or predefined-amount recharge, provider-confirmed-only crediting); the applicable commission for each ride is **determined exactly once, at acceptance, and stored on the ride** (`Ride.commissionAmount`, BD-7) — checked against the wallet as a plain, non-locking comparison at that same moment, and, at ride completion, simply **read and deducted in full** — never recalculated, never partial, regardless of what the ride's actual customer fare turns out to be. **There is no cap, no partial deduction, and no shortfall concept** (BD-1, reversed): the full stored amount is deducted whenever the wallet covers it; when it unexpectedly doesn't, nothing is deducted at all and the condition is logged as an exceptional invariant violation for investigation, never silently absorbed as routine business. **No reservation, hold, or locked-balance mechanism exists anywhere in this design** — the platform's pre-existing one-active-ride-per-driver rule makes it unnecessary (BD-4, `decisions.md`); the only concurrency protection needed is an ordinary row lock at the moment of deduction. Both new payment flows reuse the existing intent → gateway → webhook → ledger pipeline, distinguished by `PaymentIntent.purpose`. Settlement's existing commission-netting query is extended (TD-1, unchanged from the original design) so commission is never collected twice. Customer ride payment is untouched.

## Technical Context

**Unchanged from the original design** — TypeScript/Node (`.nvmrc`-pinned), Fastify + Prisma + Awilix + BullMQ/ioredis + Zod, PostgreSQL + Redis, `node:test` via `tsx`, Linux/Docker deployment, modular-monolith `src/modules/<domain>/` shape. No new dependency, language, or infrastructure is introduced by this revision either.

**Performance Goals** (revised): the eligibility check added to `acceptRideRequest` is now **cheaper** than the original design — a plain read (no row lock, no insert) for commission-model drivers, and a plain read of the driver's subscription row for subscription-model drivers. The completion-time deduction still takes one row lock, as before. No new external network call is added anywhere (unchanged).

**Constraints** (revised): the completion-time deduction must execute inside the _same_ transaction as `completeRide`'s status transition — unchanged requirement. The accept-time eligibility check no longer has an atomicity requirement of its own (nothing is written), though it is still convenient to perform inside the existing `acceptRideRequest` transaction for code locality.

## Constitution Check

_GATE: evaluated against `.specify/memory/constitution.md`._

| Rule                                                                    | How this plan satisfies it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1.4 module ownership of mutation                                       | Unchanged from the original design: `DriverCommissionWallet`/`DriverCommissionWalletTransaction` writes live in `payments`; `drivers` gets a read-only view service. `Driver.paymentModel`/`pendingPaymentModel` are owned by `drivers` (they live on the `Driver` row `drivers` already owns). `Ride.driverPaymentModel` is owned by `rides` (written as part of the existing `rideRepo.create` call). `SubscriptionPlan`/`WalletRechargeOption`/`DriverSubscription` mutation lives in the new `subscriptions` module. **Commission Plan mutation is not owned by this feature at all** — it is the existing `PricingRule`, owned and mutated by the existing `pricing` module, unmodified (BD-6). |
| §1.5 cross-module reaction via outbox, documented synchronous exception | Unchanged in shape from the original design: the completion-time deduction is a synchronous, in-transaction call from `rides`' `LifecycleService` into `payments`' `CommissionWalletService` — the same, single documented exception (alongside the existing cash-ledger call) this codebase already has, not a new one. Subscription activation still goes through the outbox (not time-critical the way completion-time deduction is).                                                                                                                                                                                                                                                             |
| §4.1/§4.3 transactional money movement + balanced ledger                | Every money-moving operation runs inside `TransactionManager.execute`; every ledger group is posted via `LedgerService.postTransactionGroup` with matched legs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §5.1 row locking                                                        | The **only** lock in the new commission-wallet code path is on the wallet row, taken at the moment of deduction — an ordinary read-modify-write lock (constitution §5.1), not a race-arbitration mechanism (see Concurrency & Idempotency Design, and BD-4's full reasoning).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| §5.4 uniqueness surviving a crash is a DB index                         | The partial unique index on `(ride_id) WHERE txn_type='RIDE_COMMISSION'` remains the hard backstop for "at most one deduction per ride."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| §6 idempotency                                                          | Unchanged: subscription purchase and wallet recharge routes require `Idempotency-Key`, reuse `PaymentService.withIdempotency`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| §7 transactional outbox                                                 | Unchanged: subscription activation event, no bypass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| §8 external I/O outside DB transactions                                 | Unchanged: subscription/recharge gateway calls stay in `IntentService.createIntent`/`confirmIntent`, outside any transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| §9 server-authoritative decisions                                       | The eligibility check and the deduction both read only the database's own row — `Driver.paymentModel`, `DriverSubscription`, and `DriverCommissionWallet.balance` — never a client-supplied value; `Ride.driverPaymentModel` is written by the backend at acceptance, never accepted from a client.                                                                                                                                                                                                                                                                                                                                                                                                  |
| §17.2 ledger append-only                                                | Unchanged: no historical `payment_ledger_entries` row is touched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**No violation requiring the Complexity Tracking table.** If anything, this revision **reduces** complexity relative to the original design by removing an entire mechanism (reservation/hold/locked-balance) that constitution §1.3/§6.4 would have required justifying as not being "a second mechanism for a solved problem" — it turns out the existing one-active-ride-per-driver rule already solves the problem reservation was for.

## Project Structure

### Documentation (this feature)

```text
specs/004-driver-subscription-wallet/
├── spec.md                       # Business requirements (revised, dual model)
├── research.md                    # Phase 0 — current-system audit (unchanged code, one corrective note)
├── data-model.md                  # Phase 1 — schema design (revised)
├── decisions.md                    # Approved decisions (BD-1 reversed; BD-4–BD-7 new/resolved)
├── revision-002-dual-model.md      # Full review/rationale for this revision
├── plan.md                         # This file (revised)
└── checklists/requirements.md
```

### Source Code (repository root)

```text
src/modules/subscriptions/            # NEW module (subscriptions + recharge options only — NOT commission plans, see below)
├── controllers/subscription.controller.ts
├── controllers/recharge-option.controller.ts         # NEW — admin CRUD
├── routes/subscription.routes.ts     # mounted at /api/v1/subscriptions
├── services/subscription.service.ts
├── repositories/subscription-plan.repository.ts
├── repositories/driver-subscription.repository.ts
├── repositories/recharge-option.repository.ts          # NEW
├── schemas/subscription.schemas.ts
├── errors/subscription.errors.ts
├── events/catalog.ts
├── consumers/subscription-payment.consumer.ts
├── jobs/subscription-expiry.job.ts    # EXTENDED — also applies staged payment-model switches (BD-5)
└── index.ts

src/modules/payments/                 # EXTENDED, existing module
├── repositories/commission-wallet.repository.ts   # NEW — owns driver_commission_wallets writes; NO lockedBalance
├── services/commission-wallet/commission-wallet.service.ts  # NEW — creditInTx, checkBalance, deductInTx (no reserve/release)
├── controllers/commission-wallet.controller.ts     # NEW — POST /payments/driver-wallet/recharge
├── routes/payment.routes.ts           # EXTENDED — new recharge route + recharge-options list route
├── services/intent/intent.service.ts   # EXTENDED — purpose-based dispatch (unchanged from original design)
├── services/settlement/settlement.service.ts        # EXTENDED — TD-1, unchanged from original design
├── repositories/settlement.repository.ts             # EXTENDED — TD-1, unchanged from original design
├── services/collection/collection.service.ts          # EXTENDED — TD-1, unchanged from original design
└── constants/payment.constants.ts     # EXTENDED — two new LEDGER_ACCOUNTS values, unchanged from original design

src/modules/drivers/
├── services/wallet/commission-wallet-view.service.ts   # NEW — read-only, mirrors DriverWalletViewService
├── services/payment-model/payment-model.service.ts      # NEW — select/switch, stages per BD-5
├── controllers/driver-commission-wallet.controller.ts  # NEW
├── controllers/driver-payment-model.controller.ts       # NEW
└── routes/driver.routes.ts             # EXTENDED — GET/POST payment-model, GET commission-wallet[/transactions]

src/modules/rides/
└── services/lifecycle/lifecycle.service.ts   # EXTENDED — model-branch eligibility check in acceptRideRequest
                                                #            (writes Ride.driverPaymentModel), model-branch deduction
                                                #            in completeRide (reads Ride.driverPaymentModel)

prisma/schema/modules/
├── subscription/subscription.prisma    # NEW file — SubscriptionPlan (+DAILY), DriverSubscription (no CommissionPlan — reuses existing pricing.prisma's PricingRule)
├── wallet/wallet.prisma                # EXTENDED — DriverCommissionWallet (no lockedBalance), transactions, WalletRechargeOption
├── payment/payment.prisma              # EXTENDED — PaymentIntent.purpose column
├── driver/driver.prisma                # EXTENDED — Driver.paymentModel, Driver.pendingPaymentModel
└── ride/ride.prisma                    # EXTENDED — Ride.driverPaymentModel, Ride.commissionAmount

tests/unit/subscriptions/, tests/unit/payments/commission-wallet/, tests/integration/
├── payment-model-selection.test.ts               # NEW
├── payment-model-switch.test.ts                   # NEW — staged vs. immediate, pinning
├── subscription-purchase.test.ts
├── commission-wallet-recharge.test.ts             # EXTENDED — custom + predefined-option cases
├── ride-eligibility-dual-model.test.ts             # RENAMED from the original's reservation-focused test
├── ride-completion-commission-deduction.test.ts    # REVISED — deduct full stored Ride.commissionAmount or nothing (BD-1, reversed); no cap, no partial deduction
├── ride-completion-subscription-no-deduction.test.ts  # NEW
└── settlement-commission-exclusion.test.ts         # TD-1 regression guard, unchanged
```

**Structure Decision**: unchanged from the original design — extend `payments`, `drivers`, `rides`; one new `subscriptions` module. This revision removes files/methods rather than adding new architectural surface (no `WalletHold`-reuse code, no reservation-TTL job).

---

## Target Architecture — Money Flows

| Flow                              | SUBSCRIPTION model                                                                                                      | COMMISSION model                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ride eligibility                  | Active, unexpired `DriverSubscription` required                                                                         | Commission determined once; `wallet.balance >= ride.commissionAmount`, plain read, no lock, no side effect                                                                                                                                                                                          |
| Ride acceptance                   | `Ride.driverPaymentModel = 'SUBSCRIPTION'` written                                                                      | `Ride.driverPaymentModel = 'COMMISSION'` **and** `Ride.commissionAmount` written together — the only commission determination that ever happens for this ride (BD-7)                                                                                                                                |
| Ride completion                   | No wallet activity of any kind                                                                                          | Wallet row locked; `ride.commissionAmount` is _read_, never recalculated; if `currentBalance >= ride.commissionAmount`, deduct the **full** amount (one transaction, one ledger group); otherwise deduct **nothing** and log an invariant violation (BD-1, reversed — no cap, no partial deduction) |
| Driver funding                    | Periodic plan payment (`SUBSCRIPTION_REVENUE`, recognized once per period)                                              | Manual recharge, any number of times (`DRIVER_COMMISSION_WALLET`, recognized as revenue only as spent)                                                                                                                                                                                              |
| Customer ride payment             | Unaffected, in either case — `CustomerWallet`/`RideCollectionService`/`recordTripPayment`, entirely separate code paths |
| Driver earnings/settlement/payout | Unaffected, in either case                                                                                              |
| Refund                            | Unaffected for customer-side; a narrow Commission-Wallet-recharge refund exists for `COMMISSION`-model drivers only     |

---

## Driver Payment Model Selection & Switching

New `PaymentModelService` (drivers module):

- `select(driverId, model)` — if `Driver.paymentModel` is currently `null`, sets it immediately. If a model is already set and the request asks for the **same** model, no-op. If it asks for a **different** model, delegates to `requestSwitch`.
- `requestSwitch(driverId, targetModel)`:
  - `targetModel = 'SUBSCRIPTION'` (i.e. switching **from** `COMMISSION`): sets `Driver.paymentModel = 'SUBSCRIPTION'` **only once the driver's subscription actually activates** — in practice, this is not a separate staged-switch mechanism at all: the driver simply goes through the normal subscribe flow (`POST /api/v1/subscriptions`), and `IntentService.applyConfirmation`'s subscription-activation branch sets `Driver.paymentModel = 'SUBSCRIPTION'` as part of activating the subscription (BD-5). No `pendingPaymentModel` staging is needed for this direction.
  - `targetModel = 'COMMISSION'` (i.e. switching **from** `SUBSCRIPTION`): if `subscriptionRepo.findActive(driverId)` returns a row, sets `Driver.pendingPaymentModel = 'COMMISSION'` (staged) and returns `effectiveAt: subscription.expiryDate`. If no active subscription exists, sets `Driver.paymentModel = 'COMMISSION'` immediately and clears any stale `pendingPaymentModel`.
- The **existing** `subscription-expiry.job.ts` sweep (already iterating `ACTIVE` subscriptions past `expiryDate`) is extended: when it expires a subscription, it also checks `Driver.pendingPaymentModel` — if set to `'COMMISSION'`, it applies it (`Driver.paymentModel = 'COMMISSION'`, clear `pendingPaymentModel`) instead of creating a renewal, even if `autoRenew` was true (an explicit model-switch request takes priority over auto-renewal, since the driver explicitly asked to leave the subscription model).

## Driver Subscription Design

**Unchanged in mechanism from the original design** (`PENDING_PAYMENT → ACTIVE` on provider confirmation, outbox-driven activation, expiry/renewal sweep) — see the original plan's "Driver Subscription Design" section, still accurate except:

- `billingPeriod` accepts `DAILY` in addition to `WEEKLY`/`MONTHLY`.
- Activation additionally sets `Driver.paymentModel = 'SUBSCRIPTION'` (first selection or `COMMISSION → SUBSCRIPTION` switch, per BD-5) as part of the same conditional-claim update that flips `DriverSubscription.status` to `ACTIVE` — one additional field on an update that already happens, not a new write.

## Commission Plan — Reused, Not Rebuilt; Consulted Exactly Once Per Ride

**No `CommissionPlanService`/repository/controller is added.** Per `decisions.md` BD-6, "Commission Plan" is the existing `PricingRule` (rate, versioning, and per-ride pinning all already implemented in the `pricing` module) — this feature only _consumes_ it, through the existing `PricingService`.

**Per `decisions.md` BD-7 — a correction to the prior revision of this plan** (which described an accept-time "estimate" and a separate completion-time "final calculation," the two-value design your instruction withdrew): there is exactly **one** commission determination per commission-model ride, made at acceptance, never repeated:

- **At ride acceptance** (`COMMISSION`-model rides only): the backend resolves the ride's pinned `PricingRule` (via `RideRequest.pricingRuleId`, the same existing lookup `PricingService.rateCardForRuleId` already performs) and applies it to the ride's quoted/requested fare inputs — the same inputs the existing quote-time pricing path already uses to populate `RideRequest.quotedFare` — to produce a single commission figure. This figure is written to `Ride.commissionAmount` (`data-model.md` §3.3) in the same insert that creates the `Ride` row, and is the value the eligibility check (below) compares the wallet against. The exact existing function/method this reuses is confirmed at task-breakdown time, not guessed here; the point of principle is that it is an **existing** calculation path, invoked once, not a new one, and not invoked a second time later.
- **At ride completion**: no commission-calculation function of any kind is called. `ride.commissionAmount` is read from the already-created `Ride` row and used directly for the wallet deduction (see "Ride Completion" below).
- **The existing, unrelated, unmodified completion-time calculation continues to run for its own purpose**: `PricingService.calculateFinalFare` inside `LifecycleService.completeRide` still computes `itemizedFare.platformCommission` as part of finalizing the ride's `RideFare` row — this is the existing customer-fare-finalization pipeline (feeds `recordTripPayment`'s ledger posting, settlement's `aggregateEarnings`, etc.) and is completely unaffected by this feature. **It is not the source of the Commission Wallet deduction.** The two figures — `RideFare.platformCommission` (customer-fare-side, completion-time, existing) and `Ride.commissionAmount` (driver-wallet-side, acceptance-time, new) — coexist without interfering, exactly as `data-model.md` §3.3 documents.
- Both the accept-time determination and the existing, separate completion-time fare finalization resolve against the **same pinned `PricingRule`** — this feature adds no second resolution path and no second pinning field for "which rate applied"; `Ride.driverPaymentModel` (new) answers a different question ("which payment _model_," not "which commission _rate_") from `Ride.commissionAmount` (new, "how much commission, determined once").

## Driver Commission Wallet Design

`CommissionWalletService` (payments module) — **simplified from the original design, no reserve/release**:

- `getWallet(driverId)` / `listTransactions(driverId, limit)` — read passthroughs, unchanged shape (response no longer includes a locked-balance figure).
- `creditInTx(driverId, amount, tx, reference)` — unchanged from the original design; called from `IntentService.applyConfirmation`'s `DRIVER_COMMISSION_RECHARGE` branch.
- `hasSufficientBalance(driverId, amount)` — **new, replaces `reserve`**: a plain, non-transactional read (`wallet.balance >= amount`). No lock, no wallet mutation, no `WalletHold` row. Called from `acceptRideRequest` for commission-model drivers.
- `deductInTx(driverId, rideId, commissionAmount, tx)` — **new, replaces `releaseAndDeduct`; reversed this revision (BD-1) to remove all partial-deduction/capping logic**:
  1. Locks the wallet row (`CommissionWalletRepository.lockForUpdate`).
  2. Checks for an existing `RIDE_COMMISSION` transaction for this ride (idempotency — if found, returns `{ outcome: 'ALREADY_PROCESSED' }`, no further action).
  3. If `lockedWallet.balance >= commissionAmount` (or `commissionAmount <= 0`, per FR-024a1 — deduct exactly `max(0, commissionAmount)`): deducts the **full** amount, writes the debit and the `RIDE_COMMISSION` transaction (no `expectedAmount` field — removed, `data-model.md` §2.3), returns `{ outcome: 'DEDUCTED', amount: commissionAmount }` for the caller to post the matching ledger group.
  4. **Else** (`lockedWallet.balance < commissionAmount` and `commissionAmount > 0`): performs **no wallet write and no transaction write of any kind**, returns `{ outcome: 'INSUFFICIENT_BALANCE', commissionAmount, actualBalance: lockedWallet.balance }`. The caller (see "Ride Completion" below) uses this to emit the invariant-violation log/metric/event — `deductInTx` itself does not throw, since an insufficient balance is a defined, handled outcome, not an unexpected error.
     There is **no `min()`, no cap, and no partial-amount branch anywhere in this method** — per your explicit instruction, this is not a formula change but a removal of the entire capping code path.
     **`commissionAmount` is supplied by the caller as `ride.commissionAmount`, read from the ride row — this method performs no calculation of its own** (BD-7); it is a pure locked-read-then-(full-write-or-no-write) against whatever amount it is given.
- ~~`reserve`~~, ~~`releaseAndDeduct`~~, ~~`releaseOnly`~~ — **removed** (prior revision). The prior revision's `deductInTx` capping logic is **also now removed** (this revision).

## Wallet Recharge Flow

**Unchanged in mechanism from the original design**, with one addition before `IntentService.createIntent` is called:

```text
Driver → POST /api/v1/payments/driver-wallet/recharge
         { amount } OR { rechargeOptionId }, Idempotency-Key
       → validate: exactly one of amount/rechargeOptionId provided
         - amount: DRIVER_COMMISSION_WALLET_MIN_RECHARGE <= amount <= DRIVER_COMMISSION_WALLET_MAX_RECHARGE
         - rechargeOptionId: references an ACTIVE WalletRechargeOption; amount = option.amount
       → PaymentService.withIdempotency → IntentService.createIntent
         (purpose = DRIVER_COMMISSION_RECHARGE, userId = driver's userId)
       → gateway.createIntent (OUTSIDE any DB transaction — unchanged)
       ... rest unchanged from the original design (provider confirms → applyConfirmation →
           ledger group + CommissionWalletService.creditInTx, same transaction) ...
```

## Ride Eligibility Flow (dual-model, no reservation)

Inserted into `LifecycleService.acceptRideRequest`, at the same insertion point as the original design (after the vehicle-eligibility check, before the conditional claim), but now branching on model and never locking/reserving:

```text
1-4, 5, 6.  [existing steps, unchanged — request lock, offer lock, guards,
             active-ride check, online-status check, vehicle eligibility]

6a. paymentModel = driver.paymentModel                              [NEW — read, already-loaded driver row]
    if paymentModel is null:
        throw PaymentModelNotSelectedError (409)                    [NEW — FR-000]

6b. if paymentModel === 'SUBSCRIPTION':
        subscription = subscriptionRepo.findActive(driverId, tx)     [NEW — FR-004]
        if not subscription or subscription.expiryDate <= now:
            throw DriverSubscriptionRequiredError (409)
        // no wallet read at all

    if paymentModel === 'COMMISSION':
        commissionAmount = pricingService.determineRideCommission(request)  [NEW — FR-013b/FR-014;
                                                                              the ONE commission determination
                                                                              for this ride, per BD-7 — never
                                                                              repeated at completion]
        sufficient = commissionWalletService.hasSufficientBalance(driverId, commissionAmount)  [NEW — FR-015/016/017]
        if not sufficient:
            throw InsufficientCommissionBalanceError (409)
        // no lock taken, no WalletHold created, no balance mutated — FR-017a
        // commissionAmount carried forward to step 8, NOT recomputed there

7.  requestRepo.claimForMatch(requestId, tx)                         [existing]
8.  rideRepo.create({ ..., driverPaymentModel: paymentModel,          [existing call, TWO additional fields —
                          commissionAmount: paymentModel === 'COMMISSION' ? commissionAmount : null }, tx)
                                                                       FR-031, FR-013b]
    ...
```

**Concurrency** (revised — see `decisions.md` BD-4 and `revision-002-dual-model.md` §10 for the full argument): there is no lock-based race to resolve here anymore, because there is nothing to protect against a stale read of — the check has no side effect. The platform's pre-existing one-active-ride-per-driver rule (unrelated to and unmodified by this feature) is what actually prevents a driver from having two rides simultaneously drawing on the same wallet; this feature relies on that existing invariant rather than re-implementing protection against a scenario that invariant already rules out.

**Pre-filtering at dispatch**: unchanged optional optimization from the original design — `MatchingService.operableDriverIds` MAY read wallet balance/subscription status non-authoritatively to avoid a wasted dispatch round-trip; the authoritative check remains step 6b.

## Ride Completion — Model-Branch Commission Deduction (Reads Stored Amount, Never Recalculates)

Inserted into `LifecycleService.completeRide`, after the `RideFare` row is created, branching on the ride's **pinned** model:

```text
...
[itemizedFare computed, RideFare row created — existing, unchanged. This is the CUSTOMER-fare-finalization
 path (RideFare.platformCommission etc.) — it runs for every ride regardless of driver payment model, exactly
 as it does today, and is NOT read by the block below. See "Commission Plan" section above.]
...
NEW:
  if ride.driverPaymentModel === 'SUBSCRIPTION':
    // nothing further — FR-006b/FR-024c. No wallet read, no wallet write, no ledger entry.
    // ride.commissionAmount is null for this ride and is never consulted.

  if ride.driverPaymentModel === 'COMMISSION':
    // NO commission calculation here. Read only.
    storedCommission = ride.commissionAmount        // set once, at acceptance (BD-7) — never recomputed
    result = commissionWalletService.deductInTx(driverId, rideId, storedCommission, tx)

    if result.outcome === 'DEDUCTED':
      // Full amount only — never partial. See CommissionWalletService.deductInTx above.
      ledgerService.postTransactionGroup([
        { account: 'DRIVER_COMMISSION_WALLET', direction: 'DEBIT',  amount: result.amount, ... },
        { account: 'PLATFORM_COMMISSION',      direction: 'CREDIT', amount: result.amount, ... },
      ], tx)
      publish driver.commission_wallet.debited (durable, same tx)

    if result.outcome === 'INSUFFICIENT_BALANCE':
      // NOT an error for the ride. No wallet write occurred. No ledger entry occurred.
      // The rest of completeRide proceeds unaffected — see note below.
      commissionMetrics.invariantViolation()                                    [NEW]
      logger.error('commission wallet balance insufficient at completion', {
        driverId, rideId, commissionAmount: result.commissionAmount, actualBalance: result.actualBalance
      })                                                                        [NEW — no raw PII/secret, existing redaction rules apply]
      publish driver.commission_wallet.collection_failed (durable, same tx)     [NEW event, see Events table]

    if result.outcome === 'ALREADY_PROCESSED':
      // Retried/duplicate completion trigger — no-op, per FR-021.
...
[cash-only synchronous ledger posting for the CUSTOMER side of the fare — existing, unchanged;
 a different ledger group entirely, for the customer's payment — see Customer Payment Separation]
...
[ride status transition to COMPLETED, RideFare creation, etc. — existing, unchanged, and NOT conditioned
 on the outcome of the commission deduction above. A commission INSUFFICIENT_BALANCE outcome does not
 throw and does not roll back this transaction — see "Why this doesn't fail ride completion" below.]
```

**Why an `INSUFFICIENT_BALANCE` outcome does not fail ride completion**: your instruction requires the commission-deduction _financial operation_ to "safely fail" and "preserve transaction consistency" — it does not ask for the ride itself to fail. Consistency is preserved because the deduction step, on this outcome, writes nothing at all (no wallet row touched, no ledger entry, no `RIDE_COMMISSION` transaction) — the wallet is left in exactly the state it was in before this step ran, which is itself a fully consistent state. Making the _entire_ `completeRide` transaction roll back over this would additionally undo the ride's status transition and the customer-side fare/ledger work that has nothing to do with the driver's wallet — an outcome your instruction does not ask for and this design does not introduce. The `INSUFFICIENT_BALANCE` branch is therefore handled inline (log, metric, durable event) rather than thrown as an exception that would abort the surrounding transaction.

**Idempotency (FR-021)**: `deductInTx` first checks for an existing `RIDE_COMMISSION` transaction for this ride. If found — because a prior invocation already completed it — it returns `{ outcome: 'ALREADY_PROCESSED' }` and does nothing further. The partial unique index (`data-model.md §4.2`) is the hard backstop if two invocations somehow race past that check simultaneously. Note this idempotency guard is about **not deducting twice**, not about recalculation — there was never a calculation step here to guard against repeating. A retried completion after a prior `INSUFFICIENT_BALANCE` outcome (no `RIDE_COMMISSION` row exists yet) will re-attempt the deduction and may re-emit the invariant-violation event if the balance is still insufficient — this is expected and does not create a duplicate financial transaction, only a duplicate observability signal, which existing outbox/event-consumer conventions already tolerate.

**Atomicity (FR-023)**: unchanged reasoning from the original design — when a deduction _does_ occur, the wallet debit and the ledger group execute in the same transaction as the `RideFare` creation and the status transition; ordinary Postgres transaction semantics make partial persistence impossible. When a deduction does _not_ occur (`INSUFFICIENT_BALANCE`), there is nothing financial to be atomic with — only the log/metric/event, which are observability signals, not financial state.

**No reservation to release**: unlike the pre-dual-model design's `releaseAndDeduct`, `deductInTx` has no hold to locate or release — it goes straight from "locked wallet row" to "either write the full deduction, or write nothing." This is strictly simpler than every earlier revision of this design, not merely different.

## Customer Payment Separation

**Unchanged from the original design** — the two flows touch disjoint tables and disjoint code paths, sharing only the `PLATFORM_COMMISSION` credit account (intentionally, since it's the same economic fact regardless of collection mechanism). This revision adds no new interaction surface between customer payment and either driver payment model.

## Ledger / Accounting Design

**Unchanged in structure** from the original design (`data-model.md §5`) — same two new accounts, same reuse of `LedgerService.postTransactionGroup`. **Reversed this revision**: the commission-deduction ledger group is posted only for the **full** `ride.commissionAmount`, never a capped/partial figure, and only when the deduction actually occurs — when it doesn't (`INSUFFICIENT_BALANCE`), **no ledger group is posted at all** for that ride's commission (BD-1). No ledger entry is ever posted representing a partial or estimated collection.

## API Specification

| Method | Path                                                       | Module                         | Auth                                   | Idempotency-Key                                                         | Notes                                                                                                                            |
| ------ | ---------------------------------------------------------- | ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/drivers/payment-model`                            | drivers                        | self (authenticated driver)            | No (state-setting, naturally idempotent for a repeat of the same value) | Select/switch; response includes `effectiveAt` if staged                                                                         |
| GET    | `/api/v1/drivers/payment-model`                            | drivers                        | self / staff                           | —                                                                       | Current model, pending change, `effectiveAt`                                                                                     |
| POST   | `/api/v1/subscriptions/plans`                              | subscriptions                  | admin/finance role                     | No                                                                      | Create a plan; `billingPeriod` accepts `DAILY`/`WEEKLY`/`MONTHLY`                                                                |
| PATCH  | `/api/v1/subscriptions/plans/:planId`                      | subscriptions                  | admin/finance role                     | No                                                                      | Activate/deactivate                                                                                                              |
| GET    | `/api/v1/subscriptions/plans`                              | subscriptions                  | any authenticated driver               | —                                                                       | List `ACTIVE` plans                                                                                                              |
| POST   | `/api/v1/subscriptions`                                    | subscriptions                  | verified driver                        | **Yes**                                                                 | Purchase/select a plan; activation also finalizes `paymentModel = SUBSCRIPTION` per BD-5                                         |
| GET    | `/api/v1/subscriptions`                                    | subscriptions                  | caller-scoped                          | —                                                                       | Current subscription status                                                                                                      |
| POST   | `/api/v1/subscriptions/cancel`                             | subscriptions                  | caller-scoped                          | **Yes**                                                                 | Sets `cancelRequested` (BD-3)                                                                                                    |
| POST   | `/api/v1/payments/driver-wallet/recharge-options`          | payments                       | admin/finance role                     | No                                                                      | Admin CRUD for `WalletRechargeOption`                                                                                            |
| GET    | `/api/v1/payments/driver-wallet/recharge-options`          | payments                       | any authenticated driver               | —                                                                       | List `ACTIVE` predefined amounts                                                                                                 |
| POST   | `/api/v1/payments/driver-wallet/recharge`                  | payments                       | `requireOperableDriver` + rate-limited | **Yes**                                                                 | `{amount}` or `{rechargeOptionId}`; creates `DRIVER_COMMISSION_RECHARGE` intent                                                  |
| GET    | `/api/v1/drivers/:driverId/commission-wallet`              | drivers                        | `authorizedDriverId`                   | —                                                                       | Balance (no locked-balance field), read-only                                                                                     |
| GET    | `/api/v1/drivers/:driverId/commission-wallet/transactions` | drivers                        | `authorizedDriverId`                   | —                                                                       | Paginated history, immutable                                                                                                     |
| POST   | `/api/v1/rides/accept`                                     | rides (existing, extended)     | `requireOperableDriver`                | (unchanged)                                                             | New failure modes: `409 PAYMENT_MODEL_NOT_SELECTED` / `409 DRIVER_SUBSCRIPTION_REQUIRED` / `409 INSUFFICIENT_COMMISSION_BALANCE` |
| POST   | `/api/v1/payments/webhooks/:gateway`                       | payments (existing, unchanged) | public, signature-verified             | dedup via `gatewayEventId`                                              | Unchanged — confirms subscription/recharge intents via `purpose` dispatch                                                        |

## Events / Queues

| Event                                        | Producer                                                                            | Consumer                                               | Payload                                                   | Idempotency                                                                                                                                                              | Retry/DLQ                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `driver.subscription.payment.completed`      | payments (`IntentService.applyConfirmation`)                                        | subscriptions                                          | `paymentIntentId`, `driverId`, `planId`                   | Conditional claim, redelivery is a no-op                                                                                                                                 | Existing `OutboxRelay` semantics                                                                                                             |
| `driver.commission_wallet.credited`          | payments (`CommissionWalletService.creditInTx`)                                     | none (observability)                                   | `driverId`, `amount`, `walletId`                          | N/A                                                                                                                                                                      | Existing relay semantics                                                                                                                     |
| `driver.commission_wallet.collection_failed` | payments (`LifecycleService.completeRide`, `INSUFFICIENT_BALANCE` outcome)          | none required (ops/notification/investigation tooling) | `driverId`, `rideId`, `commissionAmount`, `actualBalance` | Not state-changing — a duplicate delivery (or a genuine re-occurrence on a retried completion) is harmless; this is an observability signal, not a financial transaction | Existing relay semantics — **new event, this revision, replacing the old `expectedAmount`-on-transaction shortfall record** (BD-1, reversed) |
| `driver.commission_wallet.debited`           | payments (via `LifecycleService.completeRide`, commission-model rides only)         | none (observability)                                   | `driverId`, `rideId`, `amount`                            | N/A — payload no longer references a reservation                                                                                                                         | Existing relay semantics                                                                                                                     |
| `driver.subscription.expired`                | subscriptions (expiry job)                                                          | none (notification)                                    | `driverId`, `subscriptionId`                              | Conditional claim                                                                                                                                                        | Existing relay semantics                                                                                                                     |
| `driver.payment_model.switched`              | drivers (`PaymentModelService`, and the expiry job when it applies a staged switch) | none (notification/analytics)                          | `driverId`, `fromModel`, `toModel`                        | Fires once per actual transition (conditional claim on the field)                                                                                                        | Existing relay semantics                                                                                                                     |

No new queue/relay technology; `subscription-expiry.job.ts`'s existing schedule now also drives staged payment-model switches — no new job.

## Concurrency & Idempotency Design

| Concern                                                                         | Guard                                                                                                                                                                                                                                                                                                                                                       | Where                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Duplicate ride-completion double-deducting commission                           | (1) `deductInTx` checks for an existing `RIDE_COMMISSION` row first; (2) partial unique index as the hard backstop                                                                                                                                                                                                                                          | `CommissionWalletService.deductInTx`; `data-model.md §4.2` |
| Duplicate recharge-confirmation webhook                                         | Existing `WebhookRepository.findOrPersist` composite-unique dedup — unchanged, reused                                                                                                                                                                                                                                                                       | `research.md §1.2`                                         |
| Duplicate recharge HTTP request (same idempotency key)                          | Existing `IdempotencyRepository.runIdempotent` — unchanged, reused                                                                                                                                                                                                                                                                                          | `research.md §1.6`                                         |
| Two subscription-purchase requests racing for the same driver                   | Row lock on the driver's subscription row + partial unique index backstop — unchanged from the original design                                                                                                                                                                                                                                              | `data-model.md §4.1`                                       |
| Wallet balance changing between accept-time check and completion-time deduction | Not prevented — **allowed by design**, but no longer silently absorbed: the completion-time lock reads the true current balance; if it's sufficient, the full amount deducts; if not, **nothing deducts** and the condition is logged as an exceptional invariant violation (BD-1, reversed — no cap, no partial deduction)                                 | `decisions.md` BD-1/BD-4                                   |
| Two "simultaneous" ride-accepts for the same driver                             | **Not this feature's concern to solve** — structurally prevented by the platform's pre-existing, unmodified one-active-ride-per-driver rule; see BD-4                                                                                                                                                                                                       | `revision-002-dual-model.md §10`                           |
| Two admin adjustments to the same Commission Wallet concurrently                | Reuses the existing `wallet_adjustments` approval/application flow and row lock — unchanged                                                                                                                                                                                                                                                                 | N/A (existing)                                             |
| Payment-model switch racing with itself (double-submit)                         | `select`/`requestSwitch` is naturally idempotent for a repeat of the same target value; a genuine race between two _different_ target values is resolved by whichever request's row update commits last — no financial consequence either way since nothing has taken effect immediately in the staged case, and the immediate case is a simple field write | `PaymentModelService`                                      |

**Removed from this table relative to the original design**: "two simultaneous ride-accepts, wallet can't cover both" (was resolved by a reservation lock; now moot, see above) and "reservation orphaned by a crash" (nothing to orphan).

## Failure Handling

Unchanged from the original design for scenarios #1–#7, #9, #14–#17 (recharge/subscription payment provider failures, webhook duplication, idempotency-key duplication, subscription expiry/renewal, refund-after-recharge, payout failure) — none of those involve the reservation mechanism this revision removes. Revised/removed rows:

| #                                | Scenario                                                                                                                                                                                                                                               | Revised handling                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8                                | Wallet deduction write **technically fails** at ride completion (e.g. a DB error/constraint violation while writing the `RIDE_COMMISSION` row or ledger group — distinct from an _insufficient balance_, which is not an error, see the new row below) | Whole `completeRide` transaction rolls back — unchanged in effect, simpler in mechanism (no reservation state to also roll back).                                                                                                                                                                                                                                                                                                                            |
| 10                               | Ride completion retried                                                                                                                                                                                                                                | Second call finds the existing `RIDE_COMMISSION` row via `deductInTx`'s check, no-ops. Unchanged in effect.                                                                                                                                                                                                                                                                                                                                                  |
| ~~11~~                           | ~~Two rides attempt to consume the same wallet balance~~                                                                                                                                                                                               | **Removed** — cannot occur under the one-active-ride-per-driver rule (BD-4); if it somehow did, each completion still reads the balance it actually finds under lock and either deducts in full or deducts nothing (never partially), so no incorrect state results.                                                                                                                                                                                         |
| ~~12~~                           | ~~Driver cancels after commission reservation~~                                                                                                                                                                                                        | **Removed** — nothing is reserved at accept time, so a cancelled ride simply never reaches the completion-time deduction step; there is nothing to release.                                                                                                                                                                                                                                                                                                  |
| 13                               | Customer cancels                                                                                                                                                                                                                                       | Unchanged in effect: a cancelled ride never reaches `completeRide`'s deduction step for either model.                                                                                                                                                                                                                                                                                                                                                        |
| **new**                          | Ride accepted under one model, driver switches model, ride completes                                                                                                                                                                                   | `Ride.driverPaymentModel` (pinned at accept) governs completion; the driver's live `paymentModel` at completion time is irrelevant to this ride.                                                                                                                                                                                                                                                                                                             |
| **new (reversed this revision)** | Wallet balance at completion is insufficient to cover `ride.commissionAmount` (e.g. an `ADMIN_DEBIT` occurred after acceptance)                                                                                                                        | **Not a failure to route around by capping.** `deductInTx` writes nothing (no wallet debit, no `RIDE_COMMISSION` transaction, no ledger entry); the completion's _own_ status transition and customer-side processing still succeed unaffected; a log entry, a metric, and a durable `driver.commission_wallet.collection_failed` event record the condition for investigation. No debt/receivable/shortfall record of any kind is created (BD-1, reversed). |
| **new**                          | Customer's final fare is confirmed/changes at completion, or the company's Commission Plan changes after a ride was accepted                                                                                                                           | Neither affects `Ride.commissionAmount` for that ride (BD-7/FR-024d) — not a failure mode, a designed non-interaction.                                                                                                                                                                                                                                                                                                                                       |

## Refund Handling

**Unchanged from the original design** — two independent surfaces: the existing `RefundService` for ride-fare/topup transactions, and a narrow Commission-Wallet-recharge refund for `COMMISSION`-model drivers, posting against `DRIVER_COMMISSION_WALLET` instead of `CUSTOMER_WALLET`. No refund ever touches `PLATFORM_COMMISSION`. `SUBSCRIPTION`-model drivers have no Commission Wallet activity to refund via this surface at all (a subscription payment refund, if ever needed, would be a separate, not-yet-specified capability — out of scope here, since it wasn't requested).

## Security

All findings from the original design carry over (gateway stubs, shared webhook secret, no-client-trust requirements). This revision's dual-model split adds:

| #   | Finding                                                                                                                                                                                                                  | Severity     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| 1   | `Driver.paymentModel` must be read from the database inside the authenticated request context, never accepted as a client-supplied field on any eligibility/accept/complete path.                                        | **CRITICAL** |
| 2   | `Ride.driverPaymentModel` must be set by the backend at acceptance only, never accepted from a client, and must be the sole source of truth ride completion consults — never re-derived from the driver's current model. | **CRITICAL** |
| 3   | Recharge amount must be validated server-side against the configured predefined-option list or min/max range.                                                                                                            | **HIGH**     |
| 4   | A driver must not be able to bypass an in-progress ride's pinned model via a client-side switch request — satisfied structurally by the pinning mechanism, not by an additional runtime guard.                           | **CRITICAL** |
| 5   | `Driver.pendingPaymentModel` must only ever be applied by the backend's own expiry sweep, never settable to "already applied" by a client request.                                                                       | **HIGH**     |

## Reconciliation

**Unchanged in mechanism from the original design** — the existing `ReconciliationJob` extended to also cover `driver_commission_wallets`. The original design's `lockedBalance` reconciliation comparison is **removed** (there is no `lockedBalance` anymore) — one less thing to reconcile, not a gap. **This revision adds a second, separate investigation input**: `driver.commission_wallet.collection_failed` events (BD-1, reversed) are not a balance-reconciliation concern (the balance-vs-transaction-sum check still passes cleanly, because nothing partial or false was ever written) — they are a distinct signal that a specific ride's commission was never collected at all, surfaced via the existing outbox/event and metrics infrastructure for ops/finance follow-up, not folded into the wallet-balance reconciliation report.

## Migration Plan

**Nothing existing is replaced; still purely additive.**

| Layer                        | CURRENT (pre-feature)                                               | NEW (dual model)                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver ride eligibility      | verification + suspension + documents + vehicle, universal          | + payment-model branch: subscription check (SUBSCRIPTION drivers) or wallet check (COMMISSION drivers), never both for the same driver                                                                                                                                                                                                                                             |
| Driver commission collection | recognized per-ride, recovered reactively (cash only) at settlement | SUBSCRIPTION drivers: none, ever (fee recognized once, at subscription payment). COMMISSION drivers: determined once at acceptance, collected in full at completion — or, exceptionally, not at all for that ride if the wallet balance can't cover it (logged, not capped). Legacy path (cash-recovery, unmodified) remains for any driver/ride not enrolled in either new model. |
| `DriverWallet` (earnings)    | credited at settlement only                                         | **unchanged** — this feature never writes to `driver_wallets`                                                                                                                                                                                                                                                                                                                      |
| Customer payment             | unaffected                                                          | unaffected                                                                                                                                                                                                                                                                                                                                                                         |
| `PaymentIntent`              | implicitly customer-topup-only                                      | three purposes, additive column, default-preserved                                                                                                                                                                                                                                                                                                                                 |

**What can remain exactly as-is**: everything the original design already listed, **plus**: `WalletHold`/`WalletService.hold`/`releaseHold` are now **entirely untouched** by this feature (the original design's plan to reuse them for reservation is withdrawn) — one fewer thing this feature modifies or depends on.

**What needs modification**: unchanged list from the original design (`IntentService.applyConfirmation`, `SettlementRepository`, `RideCollectionService.confirmCash`, `LifecycleService`), **minus** anything reservation-related, **plus** the new `Driver.paymentModel`/`pendingPaymentModel` and `Ride.driverPaymentModel` writes.

**What is deprecated**: unchanged — nothing is removed from the live codebase; the original design's reservation-related additions (which were never implemented) simply never get built in the first place, which is the cleanest possible form of "nothing to deprecate."

**Rollout sequencing**: unchanged mechanism from the original design — additive schema first, then application code behind `DRIVER_COMMISSION_WALLET_ENABLED` (default `false`), staged cohort enablement. A driver's `paymentModel` being `null` by default means the flag-off state and the "not yet selected" state look identical from the eligibility flow's perspective (both reject), so no separate migration path is needed for existing drivers — they simply select a model once the feature is enabled for their cohort.

## Testing Strategy

Unchanged foundation (constitution §14/§15: unit + integration against real Postgres/Redis). Test matrix, revised:

**Removed** (no longer applicable): the `Promise.all` two-simultaneous-reservations concurrency test, the "driver cancels after reservation" release test.

**Retained, unchanged in substance**: subscription purchase/failure/expiry/renewal/plan-change/cancellation, wallet recharge success/failure/duplicate-webhook/duplicate-request, ledger balance invariant, unauthorized wallet access, refund-after-recharge, TD-1 settlement-exclusion and cash-no-double-debit regression tests, end-to-end flows.

**New/revised**:

| Test                                                                                                                          | Type             | Asserts                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No payment model selected                                                                                                     | Integration      | Ride offer never made; `409 PAYMENT_MODEL_NOT_SELECTED`                                                                                                                                                                                                                                                                                                                                 |
| First-time model selection                                                                                                    | Integration      | Applies immediately                                                                                                                                                                                                                                                                                                                                                                     |
| SUBSCRIPTION → COMMISSION, active subscription exists                                                                         | Integration      | Staged; applied only at expiry sweep                                                                                                                                                                                                                                                                                                                                                    |
| SUBSCRIPTION → COMMISSION, no active subscription                                                                             | Integration      | Applies immediately                                                                                                                                                                                                                                                                                                                                                                     |
| COMMISSION → SUBSCRIPTION                                                                                                     | Integration      | Applies immediately on subscription activation                                                                                                                                                                                                                                                                                                                                          |
| **Ride accepted under COMMISSION, model switched mid-ride, ride completes**                                                   | Integration      | Still deducts (pinned model honored)                                                                                                                                                                                                                                                                                                                                                    |
| **Ride accepted under SUBSCRIPTION, model switched mid-ride (only reachable if subscription already lapsed), ride completes** | Integration      | Still no deduction (pinned model honored)                                                                                                                                                                                                                                                                                                                                               |
| SUBSCRIPTION-model ride accept                                                                                                | Integration      | No wallet read/write occurs at all                                                                                                                                                                                                                                                                                                                                                      |
| SUBSCRIPTION-model ride completion                                                                                            | Integration      | No wallet transaction, no commission ledger entry                                                                                                                                                                                                                                                                                                                                       |
| COMMISSION-model ride accept, sufficient balance                                                                              | Integration      | Allowed; `Ride.commissionAmount` stored; **no lock/hold row created anywhere**                                                                                                                                                                                                                                                                                                          |
| COMMISSION-model ride accept, insufficient balance                                                                            | Integration      | Rejected, `409`; no `Ride` row created, so no `commissionAmount` exists anywhere                                                                                                                                                                                                                                                                                                        |
| COMMISSION-model driver, no subscription at all                                                                               | Integration      | Still eligible — subscription check entirely skipped                                                                                                                                                                                                                                                                                                                                    |
| **Commission determined once, at acceptance**                                                                                 | Integration      | `Ride.commissionAmount` follows the ride's pinned `PricingRule.commissionRatePct` per the existing residual formula (`decisions.md` BD-6); matches what the acceptance-time eligibility check used                                                                                                                                                                                      |
| **No completion-time commission calculation occurs**                                                                          | Integration/Unit | `PricingService`'s commission-determination path is asserted to be called exactly once per commission-model ride (at acceptance) via a test double/spy; `completeRide` never re-invokes it — a direct assertion against BD-7, not just an outcome check                                                                                                                                 |
| COMMISSION-model ride completion, stored commission <= balance (the normal case)                                              | Integration      | Deduct = **full** stored `Ride.commissionAmount` exactly, unaltered from what was set at acceptance; one wallet transaction, one balanced ledger entry                                                                                                                                                                                                                                  |
| **COMMISSION-model ride completion, stored commission > balance at completion (BD-1, reversed)**                              | Integration      | **No** wallet transaction created; **no** ledger entry posted; `Ride.commissionAmount` itself unchanged; a `commission_deduction_invariant_violation_total` metric increments; a `driver.commission_wallet.collection_failed` event is published; wallet balance is completely untouched (never partially deducted); the ride's own completion (status, `RideFare`) succeeds regardless |
| **No `min()`/capping/partial-deduction code path exists**                                                                     | Unit             | A direct assertion against `CommissionWalletService.deductInTx`'s implementation/outcome contract: its only two money-affecting outcomes are "deduct the full amount" or "deduct nothing" — there is no code path that deducts an amount strictly between `0` and `ride.commissionAmount`                                                                                               |
| COMMISSION-model ride completion, stored commission is zero or negative                                                       | Integration      | Deduction is `0`; wallet unaffected; no ledger entry posted — never a credit to the wallet (FR-024a1; distinct from the `INSUFFICIENT_BALANCE` case above — this is an exact, full deduction of a non-positive stored amount, not a partial one)                                                                                                                                        |
| **Customer's final fare changes/is confirmed at completion**                                                                  | Integration      | `Ride.commissionAmount` is unaffected regardless of what the customer-fare-finalization path computes for `RideFare.platformCommission` (FR-024d)                                                                                                                                                                                                                                       |
| **Commission Plan/rate changes after a ride is already accepted**                                                             | Integration      | The already-accepted ride's stored `Ride.commissionAmount` is unaffected; a ride accepted after the change uses the new rate                                                                                                                                                                                                                                                            |
| Duplicate ride completion (commission model)                                                                                  | Integration      | No-op on retry; no recalculation attempted                                                                                                                                                                                                                                                                                                                                              |
| Custom recharge amount, in range / out of range                                                                               | Integration      | Accepted / rejected before intent creation                                                                                                                                                                                                                                                                                                                                              |
| Predefined recharge option, active / inactive-or-unknown                                                                      | Integration      | Accepted / rejected                                                                                                                                                                                                                                                                                                                                                                     |
| Ledger balance invariant, both new account pairs                                                                              | Unit             | Debits = credits                                                                                                                                                                                                                                                                                                                                                                        |

## Observability

**Unchanged from the original design in mechanism**, metrics revised: `commission_eligibility_check_total{result}`, `commission_deduction_total`, `commission_deduction_invariant_violation_total` (**replaces** the withdrawn `commission_deduction_capped_total` — there is no more "capped," only "deducted in full" or "not deducted, logged" — the operationally important one to watch now, since any non-zero rate signals either the fare-estimation-at-acceptance model needs revisiting or an unexpected wallet-balance-changing process exists), `subscription_activated_total`, `subscription_expired_total`, `commission_wallet_recharge_total`, `payment_model_switch_total{from,to}`. All follow the existing `incrementCounter` pattern.

## Rollout Plan

**Unchanged in shape from the original design** (additive schema → app code behind flag → staged cohort enablement → gradual expansion), simplified in one respect: there is no reservation-related health signal to watch for during rollout, since the mechanism doesn't exist.

## Business Decisions Required

All resolved — see `decisions.md`. Recap: **BD-1** (reversed, not merely revised — no cap, no partial deduction; the full stored `ride.commissionAmount` is deducted or nothing is, with an insufficient balance treated as a logged exceptional condition), **BD-2** (unchanged — expiry never interrupts an in-progress ride), **BD-3** (unchanged — plan change/cancellation at next period, no proration), **BD-4** (reservation removed — one-active-ride-per-driver rule makes it unnecessary), **BD-5** (payment-model switch timing, resolved directly from the driving instructions), **BD-6** (Commission Plan is the existing `PricingRule`, not a new entity), **BD-7** (commission is determined exactly once, at acceptance, and never recalculated), **TD-1** (unchanged — settlement excludes wallet-collected commission).

## Risks

Unchanged from the original design (fare-estimation accuracy, gateway stubs as a real-integration prerequisite, dual-path coexistence with the legacy cash-recovery mechanism, the second cross-module DI exception), **minus** the reservation-specific risk the original design carried (dual-path enrolled-vs-not complexity around a reservation TTL job) — that risk is eliminated along with the mechanism. **New risk**: the payment-model-switch staging logic (BD-5) adds one more conditional branch to the subscription-expiry sweep job; kept as small and additive as the TD-1 branch already added there, but worth the same scrutiny during review. **New risk (BD-1, reversed)**: because an insufficient wallet balance at completion now results in **zero** commission collected for that ride (rather than a partial, capped amount), the operational cost of the invariant-violation case rising above a negligible rate is higher than it was under the capping design — the `commission_deduction_invariant_violation_total` metric is the mitigation (visibility, so ops can investigate whatever is causing balances to drop between acceptance and completion), not a fix; this trade-off is a direct, accepted consequence of the instruction to remove partial collection, not an oversight.

## Final Implementation Checklist

Unchanged core items from the original design (schema, DI registration, transaction-boundary correctness, flag-gating, `.env.example`, no-behavior-change-when-off), with reservation-specific items removed and these added:

- [ ] `Driver.paymentModel`/`pendingPaymentModel` migration and `PaymentModelService` implemented and tested.
- [ ] `Ride.driverPaymentModel` and `Ride.commissionAmount` written together at every `rideRepo.create` call path (confirm there is exactly one, or all of them are covered).
- [ ] Confirmed: no code path calls a commission-calculation function during `completeRide` for the driver-wallet deduction — `ride.commissionAmount` is read-only from that point on (BD-7).
- [ ] `WalletRechargeOption` admin CRUD implemented. (No `CommissionPlan` CRUD — Commission Plan is the existing `PricingRule`, administered by the existing, unmodified `pricing` module.)
- [ ] Pinned-model completion tests (mid-ride switch, both directions) passing before merge.
- [ ] Confirmed: no `WalletHold` row, no `lockedBalance` field, no reservation-TTL job exists anywhere in the merged code.
- [ ] Confirmed: no `expectedAmount` field, no `min()`/capping logic, and no partial-deduction code path exists anywhere in `CommissionWalletService` or the ledger-posting call site (BD-1, reversed).
- [ ] `commission_deduction_invariant_violation_total` metric and `driver.commission_wallet.collection_failed` event implemented and wired into `deductInTx`'s `INSUFFICIENT_BALANCE` outcome; confirmed this outcome never throws (does not abort `completeRide`).

---

## APPROVAL CHECKLIST

1. **BD-1 (reversed, not merely revised) — There is no cap, no partial deduction, and no shortfall record.** The full `ride.commissionAmount` is deducted when the wallet covers it; when it doesn't, nothing is deducted and the condition is logged as an exceptional invariant violation. Confirm this is the final, intended behavior — it replaces every earlier version of this decision, including the "cap and record a shortfall" mechanism approved in the immediately-prior revision.
2. **BD-4 — No reservation/hold/locked-balance mechanism will be built**, relying instead on the platform's pre-existing one-active-ride-per-driver rule plus an ordinary row lock at deduction time. Confirm this reasoning (full detail in `revision-002-dual-model.md` §10) is accepted.
3. **BD-5 — Payment-model switch timing**: `COMMISSION→SUBSCRIPTION` immediate on activation; `SUBSCRIPTION→COMMISSION` staged to current-period expiry (or immediate if no active subscription). Confirm this is the desired behavior.
   3a. **BD-7 — Commission is determined exactly once, at ride acceptance, and stored on the ride (`Ride.commissionAmount`); it is never recalculated at completion, regardless of the ride's actual/final customer fare or any Commission Plan change made after acceptance.** This reverses the "estimate now, finalize later" design from the immediately-prior revision of this plan. Confirm this is the intended, final behavior.
4. **FR-004 reversal**: commission-model drivers require **no subscription at all** — a direct reversal of the original design's universal subscription requirement, implemented exactly as your instruction stated it. Confirm this is intended platform-wide, not just for a pilot cohort.
5. **Commission Plan = the existing `PricingRule`, not a new entity** (`decisions.md` BD-6): this revision withdrew an earlier proposal for a standalone `CommissionPlan` table once the actual commission calculation was traced. Confirm this reuse is acceptable, or specify that a genuinely separate, per-driver-differentiated commission-rate mechanism (distinct from the fare-pricing rule) is wanted as additional, separate scope.
   5a. **Minimum/maximum commission are not defined and are not added** by this feature (`decisions.md` BD-6, items 10–11) — confirm this is acceptable, or request it as separate, additional scope.
6. **New `Ride.driverPaymentModel` column**: an additive schema change to the existing `Ride` table. Confirm this scope of touching the `rides` schema is acceptable.
7. **`Driver.paymentModel` defaults to unset (`null`)** for every driver, existing or new — no driver is silently defaulted into either model. Confirm this is the desired behavior for any already-onboarded driver once this feature ships.
8. Carried forward, unresolved by this revision (same as the original plan): **real payment gateway integration is a prerequisite, not part of this feature** (Security finding, gateway stubs); **feature-flagged rollout** (`DRIVER_COMMISSION_WALLET_ENABLED`, default off) — confirm ownership of turning it on per environment/cohort.

Once these are confirmed, this plan is ready for `/speckit-tasks` to produce an implementation task breakdown — not run as part of this engagement.
