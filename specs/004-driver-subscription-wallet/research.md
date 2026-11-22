# Phase 0 Research: Driver Subscription & Commission Wallet

**Feature**: `004-driver-subscription-wallet` | **Date**: 2026-09-08

This is a **read-only audit** of the current codebase, produced by tracing actual source (not prior documentation, though the ratified constitution at `.specify/memory/constitution.md` and the `002-payment-fare-settlement` feature docs were cross-checked against the code and found accurate). Every claim below carries a file:line citation. Anything not found is marked **NOT IMPLEMENTED / NOT FOUND** explicitly, per instruction — nothing here is guessed.

> **Note (revision 2, 2026-09-08)**: this audit of the _existing_ codebase is unchanged by the business-model revision in [revision-002-dual-model.md](./revision-002-dual-model.md) — the code it describes hasn't changed. One sentence below (§3, "reuse the `WalletHold` model... as the direct template for commission reservation") reflects the _original_ design and is **superseded**: the revised business model removes commission reservation entirely (see `decisions.md` BD-1-revised and `revision-002-dual-model.md` §10). `WalletHold` is therefore **not** used by this feature after the revision; it remains exactly as-is, customer-wallet-only, as this audit originally found it.

---

## 1. Current Architecture — Module by Module

### 1.1 Module boundaries (governing rule)

**File**: `.specify/memory/constitution.md §1.4`. A module owns the _mutation_ of its domain regardless of which schema file declares the table. Confirmed in code: `SettlementWalletRepository` (`src/modules/payments/repositories/settlement-wallet.repository.ts:4-8`) carries a doc comment stating it "owns the one write path onto `driver_wallets.balance`," while the drivers module's own `DriverWalletRepository` / `DriverWalletViewService` (`src/modules/drivers/services/wallet/wallet.service.ts`) is read-only — confirmed by full read: it exposes only `getWallet` and `listTransactions`, no balance mutation exists anywhere under `src/modules/drivers`. **This split is a deliberate, enforced convention this feature must follow**: any new wallet write path belongs in `payments`; `drivers` gets a read view.

### 1.2 Customer payment & wallet (`src/modules/payments`)

- **`CustomerWallet`** (`prisma/schema/modules/wallet/wallet.prisma:23-38`) — `balance`, `lockedBalance`, `currency`, per-user unique.
- **`WalletService`** (`src/modules/payments/services/wallet/wallet.service.ts`):
  - `creditInTx(userId, amount, tx, reference)` (32-81) and `debitInTx(...)` (92-141) **require a caller-supplied transaction** — there is no standalone credit/debit; a doc comment explains a prior standalone `topup()` that "minted balance with no payment behind it" was removed (this is FR-036 of feature 002, now closed).
  - `hold(userId, amount, reason?, referenceId?)` (142-187) and `releaseHold(userId, holdId)` (188-215) open their **own** transaction, lock the wallet row (`walletRepository.lockForUpdate`), check `available = balance - lockedBalance`, throw `InsufficientBalanceError` if short, and create/release a **`WalletHold`** row.
- **`WalletHold`** (`prisma/schema/modules/wallet/wallet.prisma:44-59`) is a **generic, wallet-type-agnostic hold/reservation model**: `walletType`, `walletId`, `ownerId`, `amount`, `reason`, `status`, `referenceType`, `referenceId`. **This is the exact reservation primitive the new commission-reservation requirement needs — it already exists and is unused for anything except the customer wallet today.**
- **`WalletRepository.lockForUpdate`** (`src/modules/payments/repositories/wallet.repository.ts:13-23`) — raw `SELECT ... FOR UPDATE` on `customer_wallets`.
- **`IntentService`** (`src/modules/payments/services/intent/intent.service.ts`) — `createIntent`/`confirmIntent` call the gateway **outside** `TransactionManager.execute`, then open a DB-only transaction (`applyConfirmation`) to post the ledger group and call `walletService.creditInTx` — the _only_ place a customer wallet balance is credited (24-183). This is the reference pattern for "external I/O outside DB transactions" (constitution §8).
- **Webhooks** — `WebhookService.handleGatewayWebhook` (`src/modules/payments/services/webhook/webhook.service.ts:45-100`): verifies an HMAC signature against one shared `paymentConfig.webhookSecret` (52-55), extracts a provider event id, deduplicates via `WebhookRepository.findOrPersist` on the **composite unique `(gateway, gatewayEventId)`** (DB-level guarantee, not merely a cache check), then calls `IntentService.applyConfirmation` inside the same transaction as the dedup insert.
- **Idempotency** — `IdempotencyRepository.runIdempotent` (`src/modules/payments/repositories/idempotency.repository.ts:31-65`): Redis-backed, key scoped `${userId}:${route}:${key}`, payload identity via SHA-256 of a stable-stringified body; same key + different payload → `DuplicateIdempotencyKeyError`; concurrent same-key calls collapse to one execution via `RedisService.runOnce`. Every mutating payment route requires this (`PaymentService.withIdempotency`, `payment.service.ts:20-40`).
- **Gateways** — `PaymentGatewayProvider` interface (`services/gateway/gateway.provider.ts:21-36`), three implementations: `MockGatewayProvider`, `RazorpayGatewayProvider` (`src/integrations/razorpay/razorpay.client.ts`), `StripeGatewayProvider` (`src/integrations/stripe/stripe.client.ts`). **All three are functionally mocks** — Razorpay/Stripe clients fabricate IDs with `randomUUID()` and always return success; no real SDK/HTTP call exists in either. Gateway choice is a single global config value, `paymentConfig.defaultGateway` (`src/modules/payments/index.ts:81-93`) — no per-tenant or per-flow gateway selection exists anywhere.

### 1.3 Ledger / double-entry accounting

- **`PaymentLedgerEntry`** (`prisma/schema/modules/payment/payment.prisma:164-180`): `entryGroup` (uuid tying a balanced set of legs together), `account`, `accountRefId`, `direction` (`DEBIT`/`CREDIT`), `amount`, `referenceType`/`referenceId`.
- **`LedgerService.postTransactionGroup(items, tx, customGroupUuid?)`** (`src/modules/payments/services/ledger/ledger.service.ts:99-110`) rejects any leg with `amount.lte(0)` — **all amounts must be strictly positive; direction alone carries the sign.** Balancing (debits = credits) is achieved structurally: every caller constructs matched debit/credit legs (e.g. `recordTripPayment`), not by a runtime sum-check inside `postTransactionGroup` itself.
- **Known ledger accounts** (`constants/payment.constants.ts:18-31`, `LEDGER_ACCOUNTS`): `CUSTOMER_WALLET`, `DRIVER_PAYABLE`, `PLATFORM_COMMISSION`, `GATEWAY_CLEARING`, `TAX_PAYABLE`, `CUSTOMER_RECEIVABLE`, `BAD_DEBT_EXPENSE`. A `PLATFORM_FEE` literal is also posted (`ledger.service.ts:74`) but is **not** declared in the constants file — a pre-existing minor inconsistency, not something this feature should imitate.
- **`recordTripPayment`** (`ledger.service.ts:111-176`) is the canonical "ride fare settles" posting: for cash, debits `DRIVER_PAYABLE` for `owedByDriver = totalFare - driverEarning` (i.e. the platform's share the driver now owes back) and credits `fareDestinationLegs` (`DRIVER_PAYABLE`, `TAX_PAYABLE`, `PLATFORM_FEE`, `PLATFORM_COMMISSION`) minus the driver-payable leg; for wallet/non-cash it debits the funding account and credits the same destination legs.
- **Reused, not duplicated**: this feature's commission-deduction ledger postings should go through this same `LedgerService.postTransactionGroup`, adding new legs/account(s) as needed rather than a parallel ledger mechanism — per constitution §1.5/§6.4/§7.1's "no second mechanism for a solved problem."

### 1.4 Driver wallet (earnings) & the existing commission-recovery mechanism (cash rides)

This is the most important prior art for this feature, because it is the **closest existing analog to "collect commission from a driver."**

- **`DriverWallet`** (`prisma/schema/modules/driver/driver.prisma:126-141`) — `balance`, `lockedBalance` (declared but **never used** — no code sets `lockedBalance` on `DriverWallet` anywhere; only `CustomerWallet`'s locked balance is exercised via `WalletHold`), `currency`.
- **`SettlementWalletRepository`** (`src/modules/payments/repositories/settlement-wallet.repository.ts`) is the sole write path: `credit(data, tx)` (30-62, defaults `txnType: 'RIDE_EARNING'`) and `debit(data, tx)` (72-109, **no floor — explicitly allowed to go negative**). Doc comment (64-71): _"That negative is not an error state — it is the outstanding commission on a cash ride ... It clears when the next settlement credits their earnings."_ `debit`'s `txnType` is hard-coded `'PENALTY'` (line 97) because the `DriverWalletTxnType` enum has no `COMMISSION` member — comment: "an amount the platform takes back off the driver is exactly what PENALTY already means here."
- **How the negative balance is created** — `RideCollectionService.confirmCash` (`src/modules/payments/services/collection/collection.service.ts:107-206`): on cash-ride settlement, computes `owedByDriver = fare.totalFare - fare.driverEarning` (152) and calls `settlementWalletRepository.debit(...)` (156-165) with it — i.e. **the platform's commission (and tax/fee) share of a cash fare is collected by debiting the driver's earnings wallet, potentially into negative territory, at cash-confirmation time** (which itself is feature-flagged: `paymentConfig.cashConfirmationRequired`, off by default, in which case a cash ride is simply marked `PAID` at completion with no wallet debit at all — `lifecycle.service.ts:681-682`, `736-754`).
- **How the negative is cleared** — `SettlementService.calculateSettlement` (`src/modules/payments/services/settlement/settlement.service.ts:18-112`): reads `alreadyRecoveredCommission` (`SettlementRepository.alreadyRecoveredCommission`, `settlement.repository.ts:192-217`, an `EXISTS`-guarded raw-SQL sum of `total_fare - driver_earning` for cash rides with a `SUCCEEDED` `ride_payments` row) so it does **not** re-net commission already taken via the cash-confirmation debit. `commission = commissionOnCollected + stillOwedOnCash` (68); `netPayable = earnedOnCollected − stillOwedOnCash + adjustments` (69); only if `netPayable.gt(0)` does it call `settlementWalletRepo.credit(...)` (89-100) — **the only place `DriverWallet.balance` is credited for ride earnings, and it happens per settlement period (batch, daily), not per ride, not in real time.** A negative `netPayable` carries forward into next period's `adjustments` (66-67) rather than being collected immediately.

**Conclusion — this is fundamentally a different model from what is being requested.** The current system is **reactive and batched**: commission is _recognized_ per ride (on `RideFare.platformCommission`, at completion) but only _collected/reconciled_ at the next settlement run, and only actually enforced as a wallet debit for cash rides. There is **no proactive, real-time, pre-ride-acceptance balance check anywhere in the codebase.** A driver today can accept and complete an unlimited number of rides while carrying an arbitrarily large negative wallet balance — confirmed by `DebtService.driverOutstanding` (`services/debt/debt.service.ts:58-63`) and its own doc comment (52-57): _"deliberately returns no limit/blocked flag ... BD-3 approved no driver blocking."_ **BD-3 (`specs/002-payment-fare-settlement/decisions.md` lines 113-127) is an explicit, previously-approved business decision that a customer's/driver's outstanding debt must NOT block a driver from receiving new rides.** This feature's requirement — block ride acceptance when the Commission Wallet cannot cover expected commission — is a **new and different policy for a new and different wallet**, not a reversal of BD-3, but the spec and plan must be explicit that BD-3 is being _narrowed_, not violated: BD-3 concerned the driver's **earnings wallet** (`DriverWallet`) and settlement debt; this feature introduces a **separate, purpose-built Commission Wallet** with its own, new, proactive blocking rule. See `decisions.md` for how this is reconciled with settlement's commission accounting so commission is never collected twice for the same ride.

### 1.5 Settlement & payout

- **`SettlementRepository.aggregateEarnings`** (`settlement.repository.ts:62-127`) sums `ride_fares.platform_commission` for **every** `COMPLETED` ride in the period, regardless of payment method or how/whether commission was already collected. This means: **if this feature adds a new real-time wallet deduction at ride completion, `aggregateEarnings`/`alreadyRecoveredCommission` MUST be extended to also exclude commission already collected via the new Driver Commission Wallet, or commission will be double-counted** (once by the new wallet debit, again by settlement's `commission` figure, which currently only nets driver _payable_ against `stillOwedOnCash`, not against a wallet-collected amount). This is a required design change captured in `decisions.md` and `plan.md`, not a new business policy — it follows directly from "money must reconcile" (constitution §4.3).
- **`PayoutService.executePayout`** (`services/payout/payout.service.ts:26-137`) reads `Settlement.netPayable`, never touches `DriverWallet` directly — payout is orthogonal to the wallet balance itself. Only reachable via `POST /api/v1/admin/payments/payouts` (admin/finance-only, `src/modules/admin/payment-management/payment-management.routes.ts:54`), not a driver-facing route.
- **Gateway call inside the DB transaction**: `PayoutService.executePayout` (line 70) and `RefundService.processRefund`/`processPendingRefund` (`refund.service.ts:68,143`) call the gateway **inside** `txManager.execute`, unlike `IntentService` and `RideCollectionService.charge`, which keep gateway I/O outside. This is a **pre-existing inconsistency against constitution §8**, noted here so this feature does not copy the anti-pattern; the new subscription-payment and wallet-recharge flows must follow `IntentService`'s pattern (gateway call outside the transaction), not `PayoutService`'s.

### 1.6 Refunds

`RefundService.processRefund` (`services/refund/refund.service.ts:20-111`) validates against over-refund, posts a ledger group debiting `CUSTOMER_WALLET`/crediting `GATEWAY_CLEARING`. Refunds are scoped to `PaymentTransaction` (ride/topup money), and nothing in the refund path touches `DriverWallet` or driver commission — confirmed by full read. **This confirms refunds are already isolated from driver-side wallets today; the new Commission Wallet must preserve that isolation (FR-027).**

### 1.7 Outbox, events, jobs, locks, transactions

- **Outbox** — `EventPublisher.publish(input, tx?)` (`src/core/events/EventPublisher.ts:16-61`) writes to `outbox_events` in the same transaction as the state change (durable events only); `OutboxRelay` (`src/core/events/OutboxRelay.ts`) polls every 1s, claims via `SELECT ... FOR UPDATE SKIP LOCKED`, dispatches to the in-process `EventBus`, retries with exponential backoff (max 8 attempts) and dead-letters (`status: 'FAILED'`) beyond that.
- **Consumers** are registered once, in `src/bootstrap/events.bootstrap.ts:17-26` (`CONSUMER_KEYS`). The payments module contributes exactly one: `rideCollectionConsumer` (`src/modules/payments/consumers/ride-collection.consumer.ts`), which reacts to the ride-completed event and calls `RideCollectionService.collect(rideId)`, explicitly documented as safe to replay because the service claims payment status conditionally.
- **Jobs** run on BullMQ (`src/jobs/queues|scheduler|workers/index.ts`), cron-scheduled, each acquiring a Redis "skip if already running" lock (`job:*`, via `LockStore`) — **not a queued/serialized lock**, and every job's own doc comments stress the lock is a scan-efficiency optimization, never the correctness boundary (constitution §5.3). Existing payment jobs: `SettlementJob` (daily 02:30 UTC), `CollectionSweepJob` (every 5 min), `ReceivableWriteOffJob` (daily 03:45 UTC), `ReconciliationJob` (hourly).
- **`LockStore`** (`src/core/cache/stores/LockStore.ts`) — token-based `acquire(resource, ttlMs)` / `release(resource, token)`, `SET ... NX PX` + Lua-guarded delete. Used pervasively but, per constitution §5.3, is always an optimization layered on top of a DB-level guarantee (row lock or conditional claim), never the sole correctness mechanism.
- **`TransactionManager.execute(callback, options?)`** (`src/core/database/TransactionManager.ts`) is a thin wrapper over Prisma's `$transaction(fn, options)`. **No nested-transaction support** (a second `execute()` call inside a callback opens an independent transaction, not a joined one — composition is done by threading the same `tx` parameter through repository/service calls, never by nesting `execute` calls). **No default isolation level** (Postgres default `READ COMMITTED` applies unless a caller passes one). **No retry-on-conflict** built in.

### 1.8 Ride dispatch, acceptance, and completion

- **Dispatch/offer** — `DispatchService.dispatchNextBatch`/`offerToDriver` (`src/modules/rides/services/dispatch/dispatch.service.ts`) creates `RideDispatch` rows (`response: 'PENDING'`) after `MatchingService.findEligibleCandidates` (`src/modules/matching/services/matching.service.ts:69-104`) filters candidates by verification, suspension, online status, no active ride, and vehicle eligibility. **No wallet/balance check exists in candidate filtering.**
- **Accept** — `LifecycleService.acceptRideRequest` (`src/modules/rides/services/lifecycle/lifecycle.service.ts:308-395`), **entirely inside one `txManager.execute` block**:
  1. `requestRepo.lockForUpdate` (317)
  2. `dispatchRepo.lockActionableOffer` — locks the specific offer row, validates `PENDING` + not expired (319, via `assertOfferActionable`)
  3. Self-ride / driver-exists guards (330-332)
  4. `rideRepo.findActiveByDriver` — driver must have no other active ride (333-336)
  5. `driverStatusRepository.getStatus` must be `'ONLINE'` (340-343) — **the only operability re-check inside the accept transaction today**
  6. `assertVehicleEligible` (344)
  7. `requestRepo.claimForMatch` — the conditional-claim guarded update that decides the winner among racing accepts (345-347)
  8. `rideRepo.create` (348-366), OTP generation, `dispatchRepo.resolveOffers` (cancels the loser offers), driver status → `ON_TRIP`, event publish — all inside the same `tx`.

  **This is precisely where a commission-reservation check must be inserted** — between step 6 and step 7, before the conditional claim commits the acceptance, using the same `tx` already threaded through every call in this method. Because everything here is one transaction, a wallet lock-and-reserve inserted at this point is automatically atomic with the accept/claim itself — exactly satisfying "concurrency-safe eligibility check" (FR-015/FR-018/FR-019) without inventing new transaction machinery.

- **Completion** — `LifecycleService.completeRide` (`lifecycle.service.ts:564-796`), also one `txManager.execute` block: computes `itemizedFare` (including `platformCommission`, `driverEarning`) via `PricingService.calculateFinalFare` synchronously (661-670), creates the `RideFare` row (699-717, `platformCommission` at line 714) in the same transaction as the ride status transition, and — **only for cash rides** — posts the trip-payment ledger group synchronously (736-754). **No external gateway call happens anywhere in this method** — it is pure DB work, which is exactly the "decoupled from external payment processing" requirement (FR-024) already satisfied by construction; the new commission deduction simply needs to be added into this same existing transaction, after the `RideFare` row is created, reading `itemizedFare.platformCommission` that is already computed there.

### 1.9 Driver eligibility gates (current state)

Three independent layers, none of which check any wallet:

1. `DriverEligibilityService.checkRequiredDocuments` (`src/modules/drivers/services/eligibility/eligibility.service.ts:7-42`) — document verification/expiry only.
2. `StatusService.setOnline` (`src/modules/drivers/services/status/status.service.ts:31-84`) — verification status, suspension, documents, vehicle operability, in that order, when a driver goes online.
3. `MatchingService.operableDriverIds` (`matching.service.ts:69-104`) — re-derives verification/suspension/online/no-active-ride/vehicle eligibility independently at dispatch-candidate-selection time.

**Confirmed: no subscription concept and no wallet-balance check exist in any of these three layers, or anywhere in `src/modules/drivers`, `src/modules/rides`, or `src/modules/matching`.**

---

## 2. Current Money Flow Traces

### A. Driver subscription payment

**NOT IMPLEMENTED / NOT FOUND.** Exhaustive case-insensitive grep for `"subscription"` across `src/modules/payments`, `src/modules/drivers`, `src/modules/rides`, `src/modules/matching`, `src/core`, `src/jobs`, `src/bootstrap` returns zero hits for a billing/subscription concept (the only two hits, in `events.bootstrap.ts`, are the English word describing event-bus _subscription_ semantics, unrelated). No `SubscriptionPlan`, `DriverSubscription`, or equivalent Prisma model exists in any `.prisma` file.

### B. Driver wallet funding/recharge (Commission Wallet)

**NOT IMPLEMENTED / NOT FOUND** as a distinct concept. The closest analog is **customer** wallet top-up (`POST /api/v1/payments/wallet/topup` → `WalletController.topup` → `IntentService`/webhook-confirmed `applyConfirmation` → `WalletService.creditInTx`), which is architecturally the correct template to reuse (provider-confirmed-only crediting, idempotent, ledger-backed) but currently only exists for `CustomerWallet`, never for any driver-side wallet. No route, controller, or service allows a driver to add money to any wallet.

### C. Customer ride payment

**WHO PAYS**: the customer (`Ride.customerId`), via `paymentMethod` chosen at request time (`RideRequest.paymentMethod`) — `CASH`, `WALLET`, `CARD`, `UPI` (`ride.prisma:19`, `Ride.paymentMethod: PaymentMethod` enum).
**WHO RECEIVES**: the company/platform, either as gateway-cleared funds (`GATEWAY_CLEARING`) or from the customer's own pre-funded wallet (`CUSTOMER_WALLET`).
**WHEN**: for cash, at ride completion (`lifecycle.service.ts:681-754`) or cash-confirmation if that flag is on; for wallet/card/UPI, at collection time via `RideCollectionService.collect`/`charge`, triggered by the `RIDE_EVENT_CATALOG.COMPLETED` outbox event reaching `ride-collection.consumer.ts`, or swept up by `CollectionSweepJob` on retry.
**DB RECORD**: `RidePayment` row per attempt (`ride.prisma:261-275`), `RideFare` row at completion.
**WALLET**: `CustomerWallet.balance` debited (`WalletService.debitInTx`) only for `WALLET` method; card/UPI never touch a wallet (they debit `GATEWAY_CLEARING`, per `collection.service.ts` and the FR-037 fix documented in `ledger.service.ts:146-150`).
**LEDGER**: `LedgerService.recordTripPayment` — balanced group crediting `DRIVER_PAYABLE`/`TAX_PAYABLE`/`PLATFORM_FEE`/`PLATFORM_COMMISSION`, debiting whichever funding account applies.
**PROVIDER**: whichever `paymentConfig.defaultGateway` resolves to (mock in practice — see §1.2).
**ON FAILURE**: `RideCollectionService.recordFailure` writes a `FAILED` `RidePayment` row; retried up to `paymentConfig.collectionMaxAttempts` (exponential backoff via `CollectionSweepJob`); once exhausted, `postReceivable` creates a `CUSTOMER_RECEIVABLE` ledger debit — the driver is still paid and commission still recognized (BD-1, feature 002) — and `DebtService` blocks that customer from creating **new ride requests** once outstanding receivables reach a configurable threshold (BD-2), while never blocking the **driver**.

### D. Driver commission

Traced fully in §1.4 above. **Current mechanism**: recognized per-ride on `RideFare.platformCommission` at completion; collected in real time only for cash rides via `SettlementWalletRepository.debit` (allowed negative) at cash-confirmation time; for every other payment method, "collected" only in the accounting sense (the ledger group's `PLATFORM_COMMISSION` credit) with no wallet debit ever occurring — because the money already flowed to the platform via the gateway/customer wallet, so there is nothing further to take from the driver. **No proactive check or reservation exists anywhere.**

### E. Driver earnings

`RideFare.driverEarning` computed at completion (`lifecycle.service.ts:661-670,713`). Not written to `DriverWallet` at completion time. Aggregated by `SettlementRepository.aggregateEarnings` at the next settlement run.

### F. Driver settlement

`SettlementService.calculateSettlement` / `calculateSettlementsForPeriod` (§1.5) — daily batch job, idempotent per `(driverId, periodStart, periodEnd)` via a unique constraint (`driver_settlements` `@@unique([driverId, periodStart, periodEnd])`, `payment.prisma:226`), nets earnings against already-recovered cash commission and prior-period carry-forward, credits `DriverWallet` only if the net is positive.

### G. Driver payout

`PayoutService.executePayout` — admin/finance-initiated only (no self-service driver payout route found), reads `Settlement.netPayable`, calls the gateway (currently mock), posts `DRIVER_PAYABLE`/`GATEWAY_CLEARING` ledger legs. **On failure**: marks `DriverPayout.status = 'FAILED'` with `failureReason`, rethrows; no compensating wallet action needed since payout never touched `DriverWallet` in the first place.

### H. Refund

`RefundService.processRefund`/`processPendingRefund` — validates against cumulative over-refund on the originating `PaymentTransaction`, posts a ledger group (always `CUSTOMER_WALLET` debit / `GATEWAY_CLEARING` credit — flagged in §1.6 as not branching on the original funding account the way `recordTripPayment` does, a pre-existing gap outside this feature's scope but noted for completeness). Never touches any driver-side wallet.

### I. Failed payment

Covered per-flow above: customer collection failure → retry budget → `CUSTOMER_RECEIVABLE` (never blocks driver); subscription/wallet-recharge failure paths do not exist yet (feature is net-new).

---

## 3. What This Feature Can Reuse vs. Must Add

**Reuse as-is:**

- `TransactionManager.execute` for all new atomic operations.
- `LedgerService.postTransactionGroup` / `recordTripPayment`-style pattern for new commission-deduction and recharge ledger postings — no second ledger mechanism.
- `IdempotencyRepository.runIdempotent` / `PaymentService.withIdempotency` for the subscription-purchase and wallet-recharge HTTP mutations.
- `WebhookService`/`WebhookRepository.findOrPersist` for provider-confirmed crediting of both subscription payments and wallet recharges — same gateway, same dedup mechanism, no new webhook infrastructure.
- The **`WalletHold`** model and `WalletService.hold`/`releaseHold` **pattern** (generic `walletType`/`walletId`, lock-check-reserve) as the direct template for commission reservation — this is close enough to be reused structurally even though a new wallet type is being introduced (see `data-model.md`).
- `EventPublisher`/outbox/`EventBus` for all new domain events — no second event mechanism.
- The existing gateway abstraction (`PaymentGatewayProvider`) — subscription and recharge payments are just new `PaymentIntent`-shaped flows through the same interface; no new gateway integration.
- `LockStore` for scan-efficiency job locks on any new scheduled job (subscription-expiry sweep, etc.), understanding it is never the correctness boundary.

**Must add (net new):**

- `SubscriptionPlan`, `DriverSubscription` models and a subscription module/service (plans, purchase, activation, expiry, renewal).
- `DriverCommissionWallet`, `DriverCommissionWalletTransaction` models, distinct from `DriverWallet` (earnings) — see `data-model.md` for why a new table is warranted rather than overloading `DriverWallet`.
- A commission-reservation check inserted into `LifecycleService.acceptRideRequest`, in the existing transaction, between the vehicle-eligibility check and the conditional claim.
- A commission-deduction step inserted into `LifecycleService.completeRide`, in the existing transaction, after the `RideFare` row is created.
- An extension to `SettlementRepository.aggregateEarnings`/`alreadyRecoveredCommission` so settlement never re-nets commission already collected via the new Commission Wallet (see `decisions.md`).

**NOT IMPLEMENTED / NOT FOUND, confirmed absent, relevant to this feature**: subscription billing, driver commission wallet, commission reservation/hold on any driver wallet, real-time (pre-settlement) commission deduction, any wallet-balance-based ride-eligibility gate, driver self-service payout route, gateway-specific webhook verification, any functioning (non-stub) payment gateway.
