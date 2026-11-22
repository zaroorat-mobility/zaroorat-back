# Phase 1 Data Model: Payment & Fare Settlement

**Feature**: `002-payment-fare-settlement` | **Date**: 2026-08-23 | **Corrected**: 2026-08-23

Every table named here **already exists** in `prisma/schema/`. This feature writes rows nothing currently writes and adds constraints the schema lacks. **No new models, and no new enum values** — the state machine below is expressible entirely in the existing `PaymentStatus` enum, which avoids an enum migration.

---

## 1. Entities

### `RidePayment` — declared, never written

`prisma/schema/modules/ride/ride.prisma`. Connects a ride to money that moved.

| Field       | Use                                                           |
| ----------- | ------------------------------------------------------------- |
| `rideId`    | The ride being collected                                      |
| `paymentId` | The server-created `PaymentIntent`; null for cash and wallet  |
| `amount`    | The total fare at completion — copied, never recomputed       |
| `method`    | `CASH` \| `WALLET` \| `CARD` \| `UPI`, copied from the ride   |
| `status`    | `PENDING` → `SUCCEEDED` \| `FAILED` — one row **per attempt** |
| `settledAt` | When money actually moved                                     |

**New invariant**: at most one `SUCCEEDED` row per ride, enforced by a partial unique index (§5.1). The Redis lock is an optimization; **this index is the guarantee**.

### `Ride.paymentStatus` — three of five states used in V1

`PENDING`, `PAID`, `FAILED`. `AUTHORIZED` is unused because pre-trip holds are deferred; `REFUNDED` is unused because ride-linked refunds are deferred. Neither is removed — both stay available for later work.

### `CustomerWallet` — balance never debited

Gains a debit path and two check constraints (§5.2). After this feature the balance moves from exactly two places: provider-confirmed funding, and ride collection.

### `CustomerWalletTransaction` — sign convention is load-bearing

Existing `TOPUP` rows record a **positive** `amount`, and `ReconciliationJob` sums this column. **Every debit MUST record a negative `amount`.** A debit written positive produces a reconciliation mismatch on entirely correct data. This is the most likely subtle bug in the feature.

### `PaymentIntent` — `rideId` accepted from clients, never validated

The column exists; `createIntentSchema` lets a **client** supply both `rideId` and `amount`, and `IntentController.createIntent` validates neither ownership nor amount. Harmless today because nothing reads `intent.rideId`.

**Requirement**: collection MUST create its own intent server-side and MUST NOT resolve a ride to a client-created intent. The client-supplied `rideId` field is rejected at the schema (see contracts).

### `DriverWallet` — the driver balance

Already credited on settlement by `SettlementWalletRepository.credit`. Gains a debit for commission owed on cash rides. **The balance may go negative, and that negative is the driver's outstanding balance** — no new table.

### `DriverSettlement` — `adjustments` never supplied

`calculateSettlement` already accepts and threads `adjustments`; no caller has ever passed a value. It becomes the carry-forward channel.

### `RideReceipt` — already idempotent, issued too late

Only the trigger point moves: from first `GET` to the payment outcome.

### `PaymentLedgerEntry` — the authority

Shape unchanged. Two corrections to how it is _used_:

- Entries asserting customer payment move from **completion** to **collection** (FR-038).
- Card and UPI rides post `GATEWAY_CLEARING`, not `CUSTOMER_WALLET` (FR-037).

---

## 2. Final payment state machine

All seven business decisions are **approved** — see [decisions.md](./decisions.md). Nothing below is conditional.

### 2.1 Three vocabularies, never interchangeable

| Level          | Stored where                                         | Values                                                                                                |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Attempt**    | `RidePayment.status` (String)                        | `PENDING` · `SUCCEEDED` · `FAILED` · `WRITTEN_OFF`                                                    |
| **Obligation** | `Ride.paymentStatus` (existing `PaymentStatus` enum) | `PENDING` · `PAID` · `FAILED`                                                                         |
| **Public**     | derived, never stored — field `collectionState`      | `AWAITING_COLLECTION` · `AWAITING_CASH_CONFIRMATION` · `RETRYING` · `PAID` · `UNPAID` · `WRITTEN_OFF` |

**Attempt-level `FAILED`** = this one attempt did not collect; the obligation may still be open.
**Obligation-level `FAILED`** = the receivable state — attempts exhausted, customer still owes.
**The public API never emits `FAILED`.** An open receivable reads `UNPAID`; a written-off one reads `WRITTEN_OFF`.

`AUTHORIZED` and `REFUNDED` remain in the enum, unused in V1 (pre-trip holds and ride-linked refunds are deferred). **No enum migration is required** — `RidePayment.status` is a String column, so `WRITTEN_OFF` needs no schema change either.

### 2.2 Public state mapping

`collectionState` is computed per request, never stored, so it cannot drift:

| `Ride.paymentStatus` | Method   | Attempt rows                | → `collectionState`          |
| -------------------- | -------- | --------------------------- | ---------------------------- |
| `PENDING`            | `CASH`   | no `SUCCEEDED`              | `AWAITING_CASH_CONFIRMATION` |
| `PENDING`            | non-cash | no attempt rows             | `AWAITING_COLLECTION`        |
| `PENDING`            | non-cash | ≥1 `FAILED`, budget remains | `RETRYING`                   |
| `PAID`               | any      | one `SUCCEEDED`             | `PAID`                       |
| `FAILED`             | any      | no `WRITTEN_OFF` row        | `UNPAID` — open receivable   |
| `FAILED`             | any      | has a `WRITTEN_OFF` row     | `WRITTEN_OFF` — closed       |

`amountOwed` is `RideFare.totalFare` when `collectionState` is `UNPAID`, and `0` in every other state — including `WRITTEN_OFF`, which is no longer outstanding (BD-1c).

`AWAITING_CASH_CONFIRMATION` is reachable only while `PAYMENT_CASH_CONFIRMATION_REQUIRED` is enabled (BD-5). With the flag off, a cash ride is `PAID` at completion and never enters this state.

### 2.3 Obligation transitions

```text
                        ┌──── collection succeeds (2,3,4a,4b,7a) ────────► PAID
                        │                                                   ▲
   (completion)         │                                                   │ 7b: rider settles
  ──────────────► PENDING ──── attempt fails, budget remains (5) ──┐        │    the receivable
        │               ▲                                          │        │
        │               └──────────────────────────────────────────┘        │
        │               │                                                   │
        │               └──── attempts exhausted (6) ──────────► FAILED ─────┘
        │                                            (open customer receivable)
        │                                                          │
        │  4c: cash, flag OFF ──────────────────► PAID             │ 8: ageing write-off
        │                                                          ▼
        └──────────────────────────────────────────────► FAILED + WRITTEN_OFF row
                                                              (closed, terminal)
```

| #   | Transition                                             | Actor / system                                            | Authorization                                                                                             | Transaction boundary                                                                            | Idempotency / claim protection                                                                       | Duplicate behaviour                                             | Ledger group                                                                                                         | Outbox event                                          |
| --- | ------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | _(none)_ → `PENDING`                                   | `completeRide`                                            | Assigned driver — `lockAndValidate` rejects a caller who is not `ride.driverId`                           | The existing completion transaction, **unchanged**                                              | Conditional `updateStatusIf` on prior status                                                         | Second completion fails the claim, invalid-transition error     | **none** — payment entries no longer post at completion (FR-038)                                                     | `ride.completed` _(existing)_                         |
| 2   | `PENDING` → `PAID` (wallet)                            | `RideCollectionService` via outbox consumer               | System; no client input                                                                                   | One transaction: wallet debit + `RidePayment` + status claim + ledger + event                   | Partial unique index on `SUCCEEDED`; conditional status claim; Redis lock `payment:collect:{rideId}` | Finds `SUCCEEDED` row, returns without charging                 | `CUSTOMER_WALLET` DR fare · `DRIVER_PAYABLE` CR earning · `PLATFORM_COMMISSION` CR commission                        | `payment.ride.collected`, `payment.wallet.debited`    |
| 3   | `PENDING` → `PAID` (card/UPI)                          | `RideCollectionService`                                   | System; amount is the server-computed fare                                                                | Provider call **outside**; then one transaction                                                 | Provider idempotency key derived from ride id, **plus** both DB guards                               | Provider returns original charge; DB guards reject second write | `GATEWAY_CLEARING` DR fare · `DRIVER_PAYABLE` CR earning · `PLATFORM_COMMISSION` CR commission                       | `payment.ride.collected`                              |
| 4a  | `PENDING` → `PAID` (cash, manual)                      | Assigned driver                                           | `requireOperableDriver` **and** `ride.driverId === callerDriverId`; route exists only when the flag is on | One transaction: `RidePayment` + status claim + driver-balance debit + ledger + event           | Mandatory `Idempotency-Key`; conditional claim; partial unique index                                 | Replays original response; commission booked once               | `DRIVER_PAYABLE` DR commission · `PLATFORM_COMMISSION` CR commission                                                 | `payment.ride.collected` (`method: CASH`)             |
| 4b  | `PENDING` → `PAID` (cash, automatic)                   | Collection sweep, after the BD-6 grace period             | System                                                                                                    | Identical transaction to 4a                                                                     | Identical guards to 4a — a sweep racing a driver confirmation loses the claim harmlessly             | Sweep finds claim taken, does nothing                           | Identical to 4a, description marks it automatic                                                                      | `payment.ride.collected` (`method: CASH`)             |
| 4c  | _(none)_ → `PAID` (cash, flag OFF)                     | `completeRide`                                            | Assigned driver                                                                                           | The existing completion transaction                                                             | Conditional `updateStatusIf`                                                                         | As transition 1                                                 | Identical to 4a, posted at completion                                                                                | `ride.completed` _(existing)_                         |
| 5   | `PENDING` → `PENDING` (attempt failed, budget remains) | `RideCollectionService` or sweep                          | System                                                                                                    | One transaction writing the `FAILED` attempt row only                                           | Attempt rows are append-only; status **not** claimed                                                 | May write an extra attempt row; cannot charge                   | **none**                                                                                                             | `payment.ride.collection_failed` (`willRetry: true`)  |
| 6   | `PENDING` → `FAILED` — **receivable created**          | Collection sweep                                          | System                                                                                                    | **One transaction: terminal attempt row + conditional claim + receivable ledger group + event** | Conditional claim `PENDING → FAILED`; attempt count re-read inside the transaction                   | Second sweep finds `FAILED`, no-op                              | **`CUSTOMER_RECEIVABLE` DR fare · `DRIVER_PAYABLE` CR earning · `PLATFORM_COMMISSION` CR commission** (BD-1)         | `payment.ride.collection_failed` (`willRetry: false`) |
| 7a  | `PENDING` → `PAID` (rider retries before exhaustion)   | Rider                                                     | `ride.customerId === callerId`                                                                            | Provider call outside; then one transaction                                                     | Mandatory `Idempotency-Key`; partial unique index; same Redis lock as the sweep                      | Replays original response                                       | Same as transition 3 — **full recognition**                                                                          | `payment.ride.collected`                              |
| 7b  | `FAILED` → `PAID` (rider settles the receivable)       | Rider                                                     | `ride.customerId === callerId`                                                                            | Provider call outside; then one transaction                                                     | As 7a                                                                                                | As 7a                                                           | **`GATEWAY_CLEARING`/`CUSTOMER_WALLET` DR fare · `CUSTOMER_RECEIVABLE` CR fare — clears the receivable ONLY** (BD-4) | `payment.ride.collected`                              |
| 8   | `FAILED` → `FAILED` + `WRITTEN_OFF` row                | Write-off sweep, after `PAYMENT_RECEIVABLE_WRITEOFF_DAYS` | System                                                                                                    | One transaction: `WRITTEN_OFF` attempt row + ledger + event                                     | **Partial unique index on `("ride_id") WHERE status = 'WRITTEN_OFF'`**                               | Second sweep violates the index and is a no-op                  | `BAD_DEBT_EXPENSE` DR fare · `CUSTOMER_RECEIVABLE` CR fare (BD-1c)                                                   | `payment.receivable.written_off`                      |

**Transitions 7a and 7b are the answer to BD-4's "settles the existing obligation without creating another obligation".** Posting the full group in case 7b would credit `DRIVER_PAYABLE` and `PLATFORM_COMMISSION` a second time, double-counting earnings and revenue for one ride. The split is asserted by a dedicated test, not left to reviewer vigilance.

---

## 2A. Customer receivable lifecycle

**The receivable is not a row.** It is the obligation state `Ride.paymentStatus = 'FAILED'` with no `WRITTEN_OFF` attempt row, and its amount is that ride's `RideFare.totalFare`.

| Question                                           | Answer                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Which transaction creates it?**                  | Transition 6's single transaction, and only that one. Terminal attempt row + conditional claim + `CUSTOMER_RECEIVABLE` debit group + event, atomically. |
| **What happens to `RidePayment`?**                 | The final attempt row stays `FAILED`. No new row until settlement (a new attempt) or write-off (a `WRITTEN_OFF` row).                                   |
| **How is a duplicate receivable prevented?**       | Structurally. A ride has exactly one `paymentStatus`, guaranteed by its primary key. Repeated events, sweeps and retries have nothing to duplicate.     |
| **What is the unique relationship?**               | **1 ride ↔ at most 1 receivable**, amount `= RideFare.totalFare`, itself unique per ride.                                                               |
| **When can the rider settle it?**                  | While `collectionState` is `RETRYING` or `UNPAID`, via `POST /rides/:rideId/payment/retry`. **Not** when `WRITTEN_OFF` — BD-1c closes the obligation.   |
| **How does settlement avoid a second obligation?** | Transition 7b clears the receivable only; earnings and commission were already recognised at transition 6 and are not posted again.                     |
| **How is it written off?**                         | Transition 8, after `PAYMENT_RECEIVABLE_WRITEOFF_DAYS`, guarded by a partial unique index so duplicate write-offs are impossible.                       |
| **Is it ever deleted or mutated?**                 | Never. Every step appends — an attempt row, a ledger group, an outbox event.                                                                            |
| **Does it block new rides?**                       | Yes, while outstanding and once the rider's total reaches the BD-2 threshold. A written-off receivable is no longer outstanding and no longer counts.   |

### Rider outstanding-debt aggregate (BD-2)

```text
outstanding = SUM(RideFare.totalFare)
              over rides WHERE customerId = :rider
                AND paymentStatus = 'FAILED'
                AND no RidePayment row with status = 'WRITTEN_OFF'
```

Computed server-side on every check, never from client input and never cached. Blocked when `outstanding >= PAYMENT_RIDER_DEBT_LIMIT` — _reaches or exceeds_. Requires migration §5.4.

## 3. Validation rules

| Rule                                    | Source             | Enforced at                                                                               |
| --------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| Wallet balance ≥ 0                      | FR-003             | Database check constraint                                                                 |
| `lockedBalance` ≤ `balance`             | FR-003             | Database check constraint                                                                 |
| One `SUCCEEDED` payment per ride        | FR-007, FR-017     | Partial unique index                                                                      |
| Charged amount = fare at completion     | FR-006             | `RidePayment.amount` copied from `RideFare.totalFare`                                     |
| Amount never client-supplied            | FR-012             | Collection ignores request bodies entirely; `rideId` rejected on the public intent schema |
| Ledger group sums to zero               | FR-030             | Existing `LedgerService` invariant (already tested)                                       |
| Debits recorded negative                | §1 sign convention | Repository level, with a dedicated test                                                   |
| Balance equals ledger position          | FR-036             | Reconciliation job **and** a direct integration assertion                                 |
| One `WRITTEN_OFF` row per ride          | FR-042 (BD-1c)     | Partial unique index §5.5                                                                 |
| Outstanding debt computed server-side   | FR-016 (BD-2)      | Aggregate query; never client input, never cached                                         |
| Debt block uses `>=`, not `>`           | FR-016 (BD-2)      | "Reaches or exceeds" — asserted at the boundary value                                     |
| Cash-confirm route absent when flag off | FR-019 (BD-5)      | Route not registered; a request returns `404`                                             |
| Auto-resolution preconditions           | FR-043 (BD-6)      | All six conditions re-checked inside the claiming transaction                             |
| No historical ledger row mutated        | FR-044 (BD-7)      | No migration or job issues `UPDATE`/`DELETE` on `payment_ledger_entries`                  |

---

## 4. Money-path invariants

Assert these directly, not as side effects:

1. **Conservation** — `totalFare = driverEarning + platformCommission`; each collection's ledger group sums to zero.
2. **No phantom balance** — total `CustomerWallet.balance` equals the ledger's `CUSTOMER_WALLET` position, to the paise.
3. **No free money** — every balance increase has a `SUCCEEDED` `PaymentIntent`, a refund, or a recorded staff adjustment behind it.
4. **At most one charge** — one debit per ride under any sequence of retries, duplicate events, or concurrent completions.
5. **No asserted-but-uncollected payment** — no ledger entry claims customer payment for a ride without a `SUCCEEDED` `RidePayment`.
6. **Correct account** — wallet rides touch `CUSTOMER_WALLET`; card and UPI rides touch `GATEWAY_CLEARING`.
7. **Payout bounded by settlement** — already true; must remain true after the settlement figure changes.
8. **Balance conserved** — a driver balance recovered from a settlement equals the balance carried into it.
9. **Receivable matches its rides** — the `CUSTOMER_RECEIVABLE` position equals the summed fare of rides in `UNPAID`, exactly (BD-1).
10. **Earnings recognised once** — `DRIVER_PAYABLE` and `PLATFORM_COMMISSION` are each credited exactly once per ride, whatever path the ride takes. Settling a receivable (transition 7b) posts neither (BD-4).
11. **Bad debt only at write-off** — `BAD_DEBT_EXPENSE` is non-zero only for rides in `WRITTEN_OFF`, never at transition 6 (BD-1).
12. **History immutable** — no ledger row created before `PAYMENT_LEDGER_CUTOVER_AT` is ever updated or deleted (BD-7).

---

## 5. Migrations

**Five migrations**, every one traceable to an approved decision. All additive; **none rewrites, deletes or mutates an existing row** — required by BD-7.

### 5.1 `ride_payments` — one success per ride **[REQUIRED]**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "ride_payments_ride_id_succeeded_key"
  ON "ride_payments" ("ride_id")
  WHERE "status" = 'SUCCEEDED';
```

Justification: FR-007 and FR-017; the exactly-once backstop for transitions 2, 3, 4 and 7. Partial unique indexes cannot be expressed in the Prisma schema — same approach as the existing "one active request per customer" backstop.

### 5.2 `customer_wallets` — balance floor **[REQUIRED]**

```sql
ALTER TABLE "customer_wallets"
  ADD CONSTRAINT "customer_wallets_balance_non_negative" CHECK ("balance" >= 0);

ALTER TABLE "customer_wallets"
  ADD CONSTRAINT "customer_wallets_locked_within_balance"
  CHECK ("locked_balance" >= 0 AND "locked_balance" <= "balance");
```

Justification: FR-003. Negative balance becomes _reachable for the first time_ when the debit path lands, so this must ship with it, not after.

**Pre-flight required**: verify no existing row violates either constraint against the target database before deploy. Do not assume — the constitution's principle VIII requires the check.

### 5.3 `ride_payments` — sweep support **[REQUIRED]**

```sql
CREATE INDEX IF NOT EXISTS "ride_payments_status_created_at_idx"
  ON "ride_payments" ("status", "created_at");
```

Justification: BD-4 is approved as option A, so the bounded retry sweep queries failed attempts by age; the write-off sweep (BD-1c) queries the same shape. Both jobs depend on it.

### 5.4 `rides` — rider outstanding-debt aggregate **[REQUIRED]**

```sql
CREATE INDEX IF NOT EXISTS "rides_customer_id_payment_status_idx"
  ON "rides" ("customer_id", "payment_status");
```

Justification: rider debt is derived by aggregating `RideFare.totalFare` over a rider's rides where `payment_status = 'FAILED'` (§2A). Both `GET /me/debt` and the BD-2 ride-request guard read it, and `rides` is the largest table in the system — without this index the aggregate is a sequential scan on every ride request.

BD-1 is approved as option C and BD-2 as option A, so this aggregate is read on **every ride request** as well as by `GET /me/debt`. It is not optional.

### 5.5 `ride_payments` — one write-off per ride **[REQUIRED]**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "ride_payments_ride_id_written_off_key"
  ON "ride_payments" ("ride_id")
  WHERE "status" = 'WRITTEN_OFF';
```

Justification: BD-1c requires that the write-off be idempotent and that duplicate write-offs be impossible. This is the same structural guarantee as §5.1, applied to the write-off transition — a repeated sweep violates the index rather than posting a second `BAD_DEBT_EXPENSE` entry.

### ~~`payment_intents` ride_id index~~ — **REMOVED**

Removed in the correction pass as speculative. It supported a lookup from ride to intent that no V1 workflow performs — `RidePayment` already carries `rideId` and is already indexed on it, and `RidePayment.paymentId` gives the intent directly. Reinstate only if a query is later shown to need it.

### Large-table note

`CREATE INDEX CONCURRENTLY` cannot run inside Prisma's migration transaction. On a production table of meaningful size, create 5.1, 5.3, 5.4 and 5.5 manually with `CONCURRENTLY` **before** `migrate deploy`; the `IF NOT EXISTS` guards make the migration a no-op.

---

## 6. Deliberately not modelled

- **Pre-trip holds** — `WalletHold` exists and `/wallet/hold` works, but no ride flow creates one. Capture is deferred (FR-013).
- **Ride-linked refunds** — deferred (FR-029). Existing standalone refunds are unchanged.
- **Surge, promotions, coupons, tolls, cancellation fees** — tables exist, remain unwritten; `discountAmount` stays zero.
- **Disputes and chargebacks** — `RideDispute` and the chargeback repository remain unused.
- **Multi-currency** — `INR` throughout.

---

## 7. Earnings and settlement — one authoritative, reconcilable chain

There is exactly one relationship from fare to payout, and **no value in it is mutated independently of the others**. Today three representations of a driver's earnings exist that nothing reconciles: `ride_fares.driver_earning`, the ledger's `DRIVER_PAYABLE` position, and `driver_wallets.balance`. This section fixes which is authoritative at each step. **No second earnings system is introduced.**

### 7.1 The chain

```text
RideFare.totalFare                        ← computed once at completion, immutable
   ├─ RideFare.platformCommission         ← from the rate card, at completion
   └─ RideFare.driverEarning              ← totalFare − platformCommission
          │
          ▼
   Collection result                       ← RidePayment.status: SUCCEEDED | FAILED | WRITTEN_OFF
          │
          ▼
   Payment obligation / receivable state    ← Ride.paymentStatus: PENDING | PAID | FAILED
          │
          ▼
   Revenue & commission treatment           ← PLATFORM_COMMISSION credited ONCE per ride,
          │                                   at whichever transition first recognises it
          ▼
   Driver gross earnings                    ← DRIVER_PAYABLE credited ONCE per ride
          │
          ▼
   Driver net earnings                      ← gross − cash commission owed + carried adjustments
          │
          ▼
   Payout eligibility                       ← DriverSettlement.netPayable — the payout ceiling
```

### 7.2 When each value is recognised — settled by BD-1

**Approved: option C.** The customer remains responsible; the unpaid amount becomes a receivable; **driver earnings are never reduced by a customer's failure**; bad debt is booked only at write-off.

| Ride outcome                     | Driver earning recognised     | Commission recognised         | Balancing debit                                 |
| -------------------------------- | ----------------------------- | ----------------------------- | ----------------------------------------------- |
| Collected (wallet)               | at collection                 | at collection                 | `CUSTOMER_WALLET`                               |
| Collected (card/UPI)             | at collection                 | at collection                 | `GATEWAY_CLEARING`                              |
| Cash, confirmed or auto-resolved | driver already holds the fare | at confirmation               | `DRIVER_PAYABLE` (commission owed by driver)    |
| **Permanently uncollected**      | **at transition 6 — in full** | **at transition 6 — in full** | **`CUSTOMER_RECEIVABLE`**                       |
| Receivable later settled         | _(already recognised)_        | _(already recognised)_        | `CUSTOMER_RECEIVABLE` credited, clearing it     |
| Receivable written off           | _(already recognised)_        | _(already recognised)_        | `BAD_DEBT_EXPENSE` debited, receivable credited |

**Each of `DRIVER_PAYABLE` and `PLATFORM_COMMISSION` is credited exactly once per ride**, at the first transition that recognises it. Every later transition moves only the balancing side. This is what makes the chain reconcilable rather than a set of independently-mutated numbers.

### 7.3 Consequence for the settlement query

Because BD-1 forbids deducting a customer's unpaid amount from driver earnings, **`aggregateEarnings` must NOT filter on collection success**. It keeps deriving from `ride_fares`, and the `ride_payments` join contemplated under the rejected option B is **not** added.

What does change:

| Current behaviour                                           | Problem                                                                                  | Change                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `recordTripPayment` posts payment entries at **completion** | Asserts a payment that has not occurred                                                  | Move to the collection path (FR-038)                                                                                                     |
| `recordTripPayment` debits `CUSTOMER_WALLET` for card/UPI   | Wrong account — the rider never funded a wallet                                          | Select the account by method (FR-037)                                                                                                    |
| `aggregateEarnings` filters `payment_method <> 'CASH'`      | Uses method as a proxy for _collected_, which was never true, and excludes cash entirely | Filter on cash **explicitly** — a cash driver's earning is the cash they hold, so only the commission they owe belongs in the settlement |
| `calculateSettlement` never receives `adjustments`          | Prior-period shortfall silently vanishes                                                 | Supply the carried balance (FR-021)                                                                                                      |
| `ReconciliationJob` ignores `driver_wallets`                | Driver balances never verified                                                           | Extend to cover them (FR-032)                                                                                                            |

### 7.4 Reconciliation identities

These must hold continuously and are asserted directly by test:

1. `SUM(CUSTOMER_WALLET ledger position) == SUM(customer_wallets.balance)`
2. `SUM(CUSTOMER_RECEIVABLE ledger position) == SUM(RideFare.totalFare)` over rides with `collectionState = UNPAID`
3. `SUM(DRIVER_PAYABLE ledger position) == SUM(driver_wallets.balance) + unsettled earnings`
4. `SUM(BAD_DEBT_EXPENSE) == SUM(RideFare.totalFare)` over rides with `collectionState = WRITTEN_OFF`
5. For every ride: `totalFare == driverEarning + platformCommission`
6. Every ledger group sums to zero

Identities 2 and 4 are new and are the reason a receivable cannot silently diverge from the rides that produced it.

### 7.5 Duplicate prevention across the whole chain

| Risk                           | Prevented by                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Duplicate collection           | Partial unique index on `RidePayment` `SUCCEEDED`                                                         |
| Duplicate write-off            | Partial unique index on `RidePayment` `WRITTEN_OFF`                                                       |
| Duplicate earnings recognition | `DRIVER_PAYABLE` credited only at the first recognising transition; 7b posts no earnings                  |
| Duplicate commission           | Same rule, same transition                                                                                |
| Duplicate receivable           | Receivable is a projection of `Ride.paymentStatus`, unique by primary key                                 |
| Duplicate settlement           | `calculateSettlement` returns the existing row for a `(driverId, periodStart, periodEnd)` already settled |
| Duplicate payout               | Existing idempotency key plus the ceiling against `sumCommittedForSettlement` — unchanged                 |

### 7.6 Refunds

**Out of V1 (FR-029).** `RefundService` posts only `CUSTOMER_WALLET` / `GATEWAY_CLEARING` entries and never touches `DRIVER_PAYABLE`, so a refund leaves driver earnings intact. That is a pre-existing gap this feature neither creates nor closes. Making refunds ride-aware requires deciding whether a refunded ride's earnings are clawed back from an already-paid driver — a separate business decision, deliberately not bundled here.
