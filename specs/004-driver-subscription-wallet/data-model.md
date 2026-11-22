# Phase 1 Data Model: Driver Subscription & Commission Wallet (Dual Model)

**Feature**: `004-driver-subscription-wallet` | **Date**: 2026-09-08 | **Revised**: 2026-09-08 (dual payment-model — see [revision-002-dual-model.md](./revision-002-dual-model.md) §6 for the change rationale)

Per constitution §3.2 (migrations are additive and forward-only) and §3.1 (schema split under `prisma/schema/modules/<domain>/*.prisma`), this document lists only new tables and additive columns. No existing table is renamed, dropped, or has a column removed. No existing row is rewritten. Nothing in this feature has been deployed yet, so this revision corrects the design in place rather than layering a second migration on top of a mistaken first one.

---

## 1. Reused as-is (no schema change)

| Table                                                         | Reused for                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `payment_ledger_entries` (`PaymentLedgerEntry`)               | All new ledger postings (recharge, subscription payment, commission deduction) — two new `account` string values are introduced (below), no schema change.                                                                                                                                                   |
| `payment_intents` / `payment_transactions` / `gateway_events` | Subscription payment and Commission Wallet recharge both flow through the existing intent → gateway → webhook → `applyConfirmation` pipeline. One additive column on `PaymentIntent` — see §3.                                                                                                               |
| `wallet_adjustments`, `wallet_reconciliations`                | Staff-initiated Commission Wallet corrections (FR-030) and the hourly reconciliation job extend to the new wallet type using `walletType = 'DRIVER_COMMISSION'`, exactly as they already key by `walletType` for `CUSTOMER`/`DRIVER`.                                                                        |
| `idempotency` (Redis, via `IdempotencyRepository`)            | Subscription-purchase and wallet-recharge mutating routes.                                                                                                                                                                                                                                                   |
| `outbox_events`                                               | All new domain events.                                                                                                                                                                                                                                                                                       |
| `wallet_holds`                                                | **Not used by this feature at all.** The original single-model draft proposed reusing this for commission reservation; the dual-model revision removes reservation entirely (see §10 of `revision-002-dual-model.md`). `wallet_holds` is untouched, exactly as this feature found it — customer-wallet-only. |

**Why not reuse `DriverWallet` itself for commission**: unchanged reasoning from the original design — `DriverWallet` is the earnings/payout wallet (money the company owes the driver); the Commission Wallet is the opposite economic direction (money the driver has pre-funded that the company draws down). A new table is the correct, minimal design.

---

## 2. New tables

Conventions unchanged from the original design: `id String @id @default(uuid(7)) @db.Uuid`, `@db.Decimal(12,2)` for money, `@default(now())`/`@updatedAt` pairs, `@map`/`@@map` snake_case.

### 2.1 `subscription_plans` (new file: `prisma/schema/modules/subscription/subscription.prisma`)

```prisma
model SubscriptionPlan {
  id             String    @id @default(uuid(7)) @db.Uuid
  name           String
  billingPeriod  String    @map("billing_period")   // 'DAILY' | 'WEEKLY' | 'MONTHLY'
  price          Decimal   @db.Decimal(10, 2)
  currency       String    @default("INR") @db.Char(3)
  status         String    @default("ACTIVE")        // 'ACTIVE' | 'INACTIVE'
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  subscriptions  DriverSubscription[]

  @@index([status])
  @@map("subscription_plans")
}
```

**Change from original design**: `billingPeriod` gains the accepted value `'DAILY'` (the "1-Day" plan) — no schema change, only a new application-layer-validated value on the existing String column.

### 2.2 `driver_subscriptions` (same file)

```prisma
model DriverSubscription {
  id              String    @id @default(uuid(7)) @db.Uuid
  driverId        String    @map("driver_id") @db.Uuid
  planId          String    @map("plan_id") @db.Uuid
  pendingPlanId   String?   @map("pending_plan_id") @db.Uuid   // BD-3: staged change, applied at next renewal
  status          String    @default("PENDING_PAYMENT")         // PENDING_PAYMENT | ACTIVE | EXPIRED | CANCELLED
  paymentStatus   String    @default("PENDING") @map("payment_status") // PENDING | PAID | FAILED
  autoRenew       Boolean   @default(true) @map("auto_renew")
  startDate       DateTime  @map("start_date")
  expiryDate      DateTime  @map("expiry_date")
  cancelRequested Boolean   @default(false) @map("cancel_requested") // BD-3: takes effect at expiryDate, not immediately
  paymentIntentId String?   @map("payment_intent_id") @db.Uuid
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  driver        Driver           @relation(fields: [driverId], references: [id])
  plan          SubscriptionPlan @relation(fields: [planId], references: [id])

  @@index([driverId, status])
  @@index([status, expiryDate])
  @@map("driver_subscriptions")
}
```

**Unchanged from the original design** — see the original rationale (per-period rows preserved, partial unique index for "at most one `ACTIVE`" in §4).

### 2.3 `driver_commission_wallets` and `driver_commission_wallet_transactions` (new models in `prisma/schema/modules/wallet/wallet.prisma`)

```prisma
model DriverCommissionWallet {
  id                String    @id @default(uuid(7)) @db.Uuid
  driverId          String    @unique @map("driver_id") @db.Uuid
  balance           Decimal   @default(0) @db.Decimal(12, 2)
  currency          String    @default("INR") @db.Char(3)
  lastTransactionAt DateTime? @map("last_transaction_at")
  createdAt         DateTime  @default(now()) @map("created_at")
  updatedAt         DateTime  @updatedAt @map("updated_at")

  driver       Driver                              @relation(fields: [driverId], references: [id])
  transactions DriverCommissionWalletTransaction[]

  @@map("driver_commission_wallets")
}

model DriverCommissionWalletTransaction {
  id             String    @id @default(uuid(7)) @db.Uuid
  walletId       String    @map("wallet_id") @db.Uuid
  driverId       String    @map("driver_id") @db.Uuid
  rideId         String?   @map("ride_id") @db.Uuid
  txnType        String    @map("txn_type")   // see §2.4
  amount         Decimal   @db.Decimal(12, 2) // signed: credit positive, debit negative
  balanceAfter   Decimal   @map("balance_after") @db.Decimal(12, 2)
  referenceType  String?   @map("reference_type") // 'RECHARGE' | 'RIDE' | 'ADMIN_ADJUSTMENT'
  referenceId    String?   @map("reference_id") @db.Uuid
  description    String?
  createdAt      DateTime  @default(now()) @map("created_at")

  wallet DriverCommissionWallet @relation(fields: [walletId], references: [id])
  ride   Ride?                  @relation(fields: [rideId], references: [id])

  @@index([walletId, createdAt])
  @@index([driverId, createdAt])
  @@map("driver_commission_wallet_transactions")
}
```

**Change from original design**: `DriverCommissionWallet.lockedBalance` is **removed** — no reservation exists to lock. This was never deployed, so this is a pre-implementation correction, not a live schema migration dropping real data.

**Second change, this revision**: `expectedAmount` is **removed** (per `decisions.md` BD-1, reversed). It existed solely to record the shortfall when a deduction was capped below `ride.commissionAmount` — that mechanism no longer exists (no capping, no partial deduction). A `RIDE_COMMISSION` row is now written only when the full stored amount is deducted; when the wallet balance can't cover it, **no row is written at all** (BD-1) — there is no partial/shortfall state for any field to record. This is a field removed because the concept it existed for was withdrawn, not renamed or repurposed — never deployed, so no migration drops real data.

### 2.4 Transaction types (`txnType` values on `DriverCommissionWalletTransaction`)

| `txnType`         | When                                                                                                                                                                                                                                                                                                                                                                             | Amount sign       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `MANUAL_RECHARGE` | Provider-confirmed wallet recharge (FR-009), custom or predefined-option amount                                                                                                                                                                                                                                                                                                  | positive (credit) |
| `RIDE_COMMISSION` | The ride's stored commission amount (determined once, at acceptance — `Ride.commissionAmount`) deducted **in full** at ride completion, never recalculated, never partial (FR-020/FR-022/FR-023/FR-024; `decisions.md` BD-1/BD-7). Written **only** when the wallet balance at completion covers the full amount — see §5 for the alternative (no row written) when it does not. | negative (debit)  |
| `REFUND`          | A recharge is refunded (edge case in spec)                                                                                                                                                                                                                                                                                                                                       | negative (debit)  |
| `ADMIN_CREDIT`    | Staff adjustment, increases balance (FR-030)                                                                                                                                                                                                                                                                                                                                     | positive (credit) |
| `ADMIN_DEBIT`     | Staff adjustment, decreases balance (FR-030)                                                                                                                                                                                                                                                                                                                                     | negative (debit)  |

**Change from original design**: `COMMISSION_RESERVATION` and `RESERVATION_RELEASE` are **removed** — no reservation/release events occur under the dual-model design (see `revision-002-dual-model.md` §10).

### 2.5 Commission Plan — **withdrawn as a new table; reuses the existing `PricingRule`**

**Correction** (see `decisions.md` BD-6 for the full evidence trail): an earlier revision of this document proposed a standalone `CommissionPlan` table. Having traced the actual commission calculation (`src/modules/pricing/services/pricing.service.ts`, `PricingRuleRepository`), that proposal is **withdrawn** — it would have been exactly the "new calculation system" this feature must not invent. **No new table is added for Commission Plan.**

The existing `PricingRule` model (`prisma/schema/modules/pricing/pricing.prisma:6-39`) already **is** the Commission Plan:

- `commissionRatePct` — the rate.
- `version`, `isActive`, `effectiveFrom`, `effectiveTo` — the versioning/effective-dating this feature needs, already fully implemented (`decisions.md` BD-6, item 12).
- Resolved per ride by `PricingRuleRepository.findBestActiveRule` (vehicle type, city, service type, service zone) — the same resolution that governs the rest of the ride's fare.
- **Already pinned per ride** via the existing `RideRequest.pricingRuleId` column (`ride.prisma:18`). **Per `decisions.md` BD-7, this feature consults it for exactly one commission determination, at ride acceptance** — the result is written to `Ride.commissionAmount` (§3.3) and never recomputed. This is narrower than the existing `PricingService.rateCardForRuleId` re-read at completion, which continues to run, unmodified, for its own existing purpose (finalizing the _customer's_ fare, `RideFare`/`platformCommission`) — that completion-time re-read is no longer also a source for the driver's Commission Wallet deduction. `Ride.driverPaymentModel` (§3.3) answers a different question ("which payment _model_," not "which commission _rate_ or _amount_").

**Consequence for this feature's services**: wherever an earlier revision of this document referenced a `CommissionPlanRepository`/`commission-plan.controller.ts`/a `CommissionPlanService.estimateCommission` backed by a new table, those now read `PricingRule` through the **existing** `PricingService`, called **once**, at ride acceptance — see `plan.md`'s "Commission Plan" section for the exact call site. No new admin CRUD route for commission plans is needed either — `PricingRule` administration is already an existing, separate capability outside this feature's scope, unmodified by it.

### 2.6 `wallet_recharge_options` (new, `prisma/schema/modules/wallet/wallet.prisma`)

```prisma
model WalletRechargeOption {
  id        String   @id @default(uuid(7)) @db.Uuid
  amount    Decimal  @db.Decimal(12, 2)
  label     String?
  status    String   @default("ACTIVE")  // 'ACTIVE' | 'INACTIVE'
  sortOrder Int      @default(0) @map("sort_order")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([status, sortOrder])
  @@map("wallet_recharge_options")
}
```

**New**: company-configurable predefined recharge amounts ("boxes"). Deactivating an option (`status: 'INACTIVE'`) never rewrites a past `DriverCommissionWalletTransaction` that used it — those transactions reference the amount directly (`amount` field), not the option row, so history is unaffected by later configuration changes.

---

## 3. Additive columns

### 3.1 `PaymentIntent.purpose`

**Unchanged from the original design**:

```prisma
purpose String @default("CUSTOMER_WALLET_TOPUP") @map("purpose")
```

Values: `CUSTOMER_WALLET_TOPUP` (existing behavior, default-preserved), `DRIVER_COMMISSION_RECHARGE`, `DRIVER_SUBSCRIPTION_PAYMENT`. `IntentService.applyConfirmation` dispatches on this field, exactly as originally designed.

### 3.2 `Driver.paymentModel` and `Driver.pendingPaymentModel` (new — `prisma/schema/modules/driver/driver.prisma`)

```prisma
// additive columns on the existing Driver model
paymentModel        String? @map("payment_model")           // 'SUBSCRIPTION' | 'COMMISSION' | null (not yet selected)
pendingPaymentModel String? @map("pending_payment_model")    // staged change, applied per the rules in revision-002-dual-model.md §9
```

**Why on `Driver`, not a new table**: this is a driver-classification attribute, read the same way `verificationStatus`/`isSuspended` already are by the ride-eligibility flow — placing it on the row every eligibility check already reads avoids adding a join to the hot path. It is nullable so a driver who has never chosen is unambiguously distinguishable from one who has (never silently defaulted to either model — spec.md Assumptions).

### 3.3 `Ride.driverPaymentModel` and `Ride.commissionAmount` (new — `prisma/schema/modules/ride/ride.prisma`)

```prisma
// additive columns on the existing Ride model
driverPaymentModel String   @map("driver_payment_model")            // 'SUBSCRIPTION' | 'COMMISSION' — snapshot at acceptance, never updated
commissionAmount   Decimal? @map("commission_amount") @db.Decimal(12, 2)  // COMMISSION-model rides only; determined once at acceptance, never recalculated; null for SUBSCRIPTION-model rides
```

**Why `driverPaymentModel` exists**: this is the mechanism that guarantees a ride is never processed under two different models. It is written once, as part of the existing `rideRepo.create(...)` call in `acceptRideRequest` (an additional column value on an insert that already happens, not a new write), and is the value ride completion reads — never the driver's live, possibly-since-changed `paymentModel`. Required (not nullable) because every `Ride` row, once created, has a definite payment model that governed its acceptance.

**Why `commissionAmount` exists, and why it changes the design** (per `decisions.md` BD-7, a correction to the prior revision of this document): commission for a `COMMISSION`-model ride is **determined exactly once, at acceptance**, not "estimated" at acceptance and "finally calculated" at completion. The previous revision of this feature described an accept-time "expected commission" and a completion-time "final commission" as two separate values, with completion re-deriving its own figure from `PricingService.calculateFinalFare`'s output. **That two-calculation design is withdrawn.** There is exactly one commission-determination moment per commission-model ride — acceptance — and its result is persisted here, immutably, for the ride's entire lifetime. Completion reads this column; it does not call any commission-calculation function a second time.

**Nullable, not required**: `null` for every `SUBSCRIPTION`-model ride (FR-024c: no commission is ever determined or stored for one) and populated exactly once, at creation, for every `COMMISSION`-model ride — so a `NULL` value is never ambiguous between "not yet determined" and "not applicable to this model"; only the latter case exists, because determination happens in the same `rideRepo.create(...)` call that sets `driverPaymentModel`, before the row exists at all.

**Relationship to the existing, unrelated `RideFare.platformCommission`**: `RideFare.platformCommission` (computed at completion, from the ride's actual measured fare, via the existing, unmodified `PricingService.calculateFinalFare`) continues to exist exactly as it does today, for its existing purpose — feeding the _customer_-side ledger posting (`recordTripPayment`'s `PLATFORM_COMMISSION` credit) and the existing settlement/cash-recovery machinery for drivers not enrolled in this feature's Commission Wallet. **`Ride.commissionAmount` is a different, new value, used for a different purpose** (the `COMMISSION`-model driver's wallet deduction) and is never read from or written to by the existing `RideFare`/`recordTripPayment` code path, and vice versa. The two can legitimately differ (see `decisions.md` BD-7) — this is expected, not a bug, and is exactly what "customer final fare and driver ride commission are two separate values" (spec.md, User Story 5 scenario 6) means concretely at the schema level.

---

## 4. New constraints

Per constitution §3.3/§5.4:

1. **At most one `ACTIVE` subscription per driver** — unchanged from the original design: `CREATE UNIQUE INDEX driver_subscriptions_one_active ON driver_subscriptions (driver_id) WHERE status = 'ACTIVE';`
2. **At most one `RIDE_COMMISSION` deduction per ride** — unchanged from the original design, the idempotency guarantee behind FR-021: `CREATE UNIQUE INDEX commission_wallet_one_deduction_per_ride ON driver_commission_wallet_transactions (ride_id) WHERE txn_type = 'RIDE_COMMISSION';`
3. ~~At most one active `WalletHold` reservation per ride~~ — **removed**. Nothing to constrain; `wallet_holds` is not used by this feature.
4. **`SubscriptionPlan.price >= 0`, `WalletRechargeOption.amount > 0`** — application-layer validation (Zod schemas), consistent with how the rest of this schema handles simple positivity checks without a DB `CHECK` unless a crash-survivable guarantee is specifically needed (unlike the two unique indexes above, which must survive a crash and are therefore DB-level). No new constraint is needed for a commission rate — `PricingRule.commissionRatePct` already exists and is validated by whatever existing mechanism governs `PricingRule` today, unmodified by this feature.
5. **`DriverCommissionWallet.balance` has no floor constraint at the DB level** — unchanged reasoning from the original design: the ride-driven path never allows it below zero (FR-024), but a `CHECK (balance >= 0)` would reject a legitimate authorized negative admin adjustment or a post-refund negative (spec.md Edge Cases), so it is left unconstrained at the DB level and enforced at the application layer for every non-admin, non-refund path.

---

## 5. Ledger accounts introduced

**Unchanged from the original design**:

| Account                    | Direction convention                                              | Purpose                                               |
| -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `DRIVER_COMMISSION_WALLET` | Liability — credited on recharge, debited on commission deduction | Mirrors `CUSTOMER_WALLET`'s existing treatment.       |
| `SUBSCRIPTION_REVENUE`     | Revenue — credited when a subscription payment is confirmed       | Recognized immediately at payment time, not per ride. |

Existing accounts reused unchanged: `GATEWAY_CLEARING`, `PLATFORM_COMMISSION`.

**Change in how the commission-deduction amount is computed** (mechanism only, not the accounts):

- Recharge: `GATEWAY_CLEARING` DEBIT `amount` / `DRIVER_COMMISSION_WALLET` CREDIT `amount` — unchanged.
- Subscription payment: `GATEWAY_CLEARING` DEBIT `plan.price` / `SUBSCRIPTION_REVENUE` CREDIT `plan.price` — unchanged.
- Commission deduction — **reversed this revision, per `decisions.md` BD-1**: this group is posted **only** when `wallet.balance (locked read) >= ride.commissionAmount`, and when posted it is always for the **exact, full** amount: `DRIVER_COMMISSION_WALLET` DEBIT `ride.commissionAmount` / `PLATFORM_COMMISSION` CREDIT `ride.commissionAmount`. **There is no `min()`, no cap, and no partial posting.** If the locked balance is insufficient, **no ledger group is posted at all** for that ride's commission — the invariant-violation handling in `decisions.md` BD-1 applies instead (a log entry, a metric, and a durable event — none of which are ledger postings, because nothing was actually collected). This supersedes every earlier phrasing in this document's history — the reservation-era `min(finalCommission, reservedAmount)`, and the two successive `min(finalCommission-or-commissionAmount, wallet.balance)` capping formulas — all of which are withdrawn, not merely superseded in wording. Every ledger group this feature ever posts for a `RIDE_COMMISSION` still balances (debits = credits, constitution §4.3); the change is that a group is now posted or not posted as a whole, never partially.

---

## 6. Subscription state machine

**Unchanged from the original design** (`ACTIVE ↔ PENDING_PAYMENT ↔ FAILED`, `ACTIVE → EXPIRED`/`CANCELLED` via the scheduled sweep) — see the original diagram, still accurate. One addition: entering `ACTIVE` for the first time also sets `Driver.paymentModel = 'SUBSCRIPTION'` if it was previously unset or staged from `COMMISSION` with no other pending change conflict.

## 7. Payment-model state (new)

```text
Driver.paymentModel = null
        │  first selection (SUBSCRIPTION or COMMISSION)
        ▼
Driver.paymentModel = X ─────────────────────────────────────────┐
        │                                                        │
        │ request switch to Y                                    │
        ▼                                                        │
  X = COMMISSION → Driver.paymentModel = SUBSCRIPTION             │
     (immediate, upon the new subscription's PENDING_PAYMENT→ACTIVE)
                                                                   │
  X = SUBSCRIPTION, no ACTIVE subscription → Driver.paymentModel  │
     = COMMISSION (immediate)                                     │
                                                                   │
  X = SUBSCRIPTION, ACTIVE subscription exists → staged:           │
     Driver.pendingPaymentModel = COMMISSION,                      │
     applied by the subscription-expiry sweep at expiryDate ───────┘
```

`Ride.driverPaymentModel` is written once, at ride acceptance, from `Driver.paymentModel`'s value **at that moment** — it never reads or is affected by `pendingPaymentModel` or any later change.
