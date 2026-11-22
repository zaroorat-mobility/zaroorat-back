# Feature Specification: Payment & Fare Settlement

**Feature Branch**: `002-payment-fare-settlement`

**Created**: 2026-08-23 · **Last updated**: 2026-08-23 (decision-application pass — all seven decisions approved)

**Status**: **APPROVED — ready for planning.** All seven business decisions were approved on 2026-08-23; see [decisions.md](./decisions.md), the single source of truth.

**Input**: User description: "Payment & Fare Settlement — close the ride→money loop … Do not redesign completed modules."

---

## Current State _(re-verified against committed code, 2026-08-23)_

This is a brownfield feature. Everything below was traced through the committed source in this pass. Where an earlier draft of this specification overstated a finding, the correction is marked **CORRECTED**.

### What is broken

- **No non-cash ride is ever collected.** Ride completion writes a full itemized fare and sets `Ride.paymentStatus` to `PENDING` for every non-cash method. No code path anywhere moves it off `PENDING`. `RidePayment` is declared in the schema and written by nothing.
- **The ledger records collection that never happened.** At completion, `LedgerService.recordTripPayment` unconditionally posts a `CUSTOMER_WALLET` debit for the full fare, plus the driver and commission credits — for every non-cash ride, whether or not any money moved. The books assert a payment that does not exist.
- **The ledger debits the wallet for card and UPI rides.** `recordTripPayment` treats every non-cash method identically, so a card rider's `CUSTOMER_WALLET` position is debited for a fare they never paid from a wallet. Under the account convention the codebase otherwise follows (`topup` credits `CUSTOMER_WALLET` and debits `GATEWAY_CLEARING`), this is the wrong account.
- **The wallet balance and the ledger disagree on every completed non-cash ride.** The ledger says the customer's wallet was debited; `customer_wallets.balance` is untouched. There is no debit path to `customer_wallets.balance` anywhere in the codebase.
- **Reconciliation cannot see it.** `ReconciliationJob` compares `customer_wallets.balance` against `SUM(customer_wallet_transactions.amount)`. Ride completion writes neither, so the job reports `MATCHED` while the ledger disagrees. It also never examines `driver_wallets`.
- **Wallet balance can be increased without any payment.** `POST /api/v1/payments/wallet/topup` calls `WalletService.topup`, which increments `customer_wallets.balance` by the requested amount with no gateway call, no `PaymentIntent`, and no verification. See the corrected classification below.
- **A client can create a payment intent naming its own amount and an arbitrary `rideId`.** `createIntentSchema` accepts both; `IntentController.createIntent` validates neither the ride's ownership nor the amount against the fare.
- **Cash rides are marked paid at completion** with no confirmation from the driver.
- **A cash-only driver accrues commission debt with no recovery path.** `recordTripPayment`'s cash branch debits `DRIVER_PAYABLE` for the commission; `SettlementService` correctly nets negative and payout correctly refuses — and nothing then recovers it.
- **Receipts are generated on first read**, not issued at completion.

### CORRECTED: the wallet finding is not currently exploitable

An earlier draft of this specification said the top-up hole lets "any authenticated rider create money" and called it "a live loss". **That overstated it, and the correction matters for prioritisation.**

Traced exhaustively: the only writes to `customer_wallets.balance` are three calls to `WalletRepository.updateBalances`, from `topup`, `hold` and `releaseHold`. `hold` and `releaseHold` move `lockedBalance` only. **`topup` is the sole path that increases the balance, and there is no path anywhere that spends it**: no withdrawal endpoint, no transfer endpoint, and no ride debits the wallet. `WalletTopup`, `WalletTransfer`, `WithdrawalRequest` and `CashbackGrant` tables exist and are never written by any code.

So a fabricated balance today can be displayed and locked, and nothing else. It is **not extractable as value**.

It is still a genuine defect, for two reasons that stand on their own:

1. `topup` posts a `GATEWAY_CLEARING` debit to the ledger for funds that never arrived, corrupting the books and the platform's own liability position.
2. It becomes **immediately extractable the moment this feature adds a wallet debit path** — which is exactly what collecting a wallet-funded ride requires.

Classified in full in §Critical Finding Classification. The fix stays in V1; the justification is "do not ship the debit path on top of a mintable balance", not "money is being stolen today".

### What is correct and MUST NOT be redesigned

Fare computation and rate cards · the double-entry ledger and its balance invariant · gateway webhook signature verification, timestamp tolerance, missing-event-id rejection and replay detection · mandatory `Idempotency-Key` and its replay semantics · refund ceiling against remaining refundable amount · the payout ceiling against a settlement and its concurrency guard · deny-by-default authorization · the transactional outbox · the Redis-backed idempotency mechanism and its replay semantics.

**One correction to that list**: idempotency coverage is _nearly_ universal, not universal. `withIdempotency` has exactly five call sites — `createIntent`, `topup`, `hold`, `processRefund`, `executePayout`. **`POST /intents/:intentId/confirm` does not use it.** A duplicate confirm is safe in effect, because `applyConfirmation` returns early when the intent already holds the target status, but it is safe by a different mechanism than the one the contract claims. Recorded as FR-040.

---

## Business Decisions — ALL APPROVED

**➡️ [decisions.md](./decisions.md) is the single source of truth.** Approved terms, ledger treatment, configuration and consequences live there and are deliberately not restated here.

All seven decisions were approved on 2026-08-23. **No open business decision remains, and no financial policy would be chosen silently during implementation.**

| ID    | Decision                                             | Approved outcome                                                                                          |
| ----- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| BD-1  | Accounting policy for a permanently uncollected fare | **C — customer receivable**; driver earnings never reduced by a customer's failure; no immediate bad debt |
| BD-1c | Write-off policy                                     | **Ageing, configurable**; `BAD_DEBT_EXPENSE` at write-off; idempotent, auditable, no duplicates           |
| BD-2  | Rider debt threshold                                 | **A** — configurable; block new ride requests at `>=` threshold; never block settling                     |
| BD-3  | Driver blocking                                      | **A — none.** A customer's failure must not affect driver eligibility                                     |
| BD-4  | Retry policy                                         | **A** — bounded and configurable; later retry settles the existing obligation without creating another    |
| BD-5  | Cash confirmation                                    | **A** — feature-flagged, **default OFF**; unreachable when disabled; both states tested                   |
| BD-6  | Unconfirmed cash                                     | **B** — automatic resolution after a configurable grace period; idempotent                                |
| BD-7  | Historical ledger                                    | **B** — prospective only; no historical row rewritten or mutated                                          |

---

## Critical Finding Classification

**Finding**: an authenticated user can create spendable wallet balance without verified provider payment, and balance can diverge from the ledger.

### Classification: **B — VERIFIED DESIGN GAP, NOT CURRENTLY EXPLOITABLE**

…with one qualifier that keeps it in V1: **it converts to class A the moment this feature adds a wallet debit path.**

### Evidence

| Question                                                          | Finding           | Evidence                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can an authenticated user increase their balance with no payment? | **Yes**           | `POST /wallet/topup` → `WalletController.topup` → `WalletService.topup` → `updateBalances`. No gateway call, no intent, no verification anywhere in that chain.                                                                                                        |
| Is the route authenticated?                                       | **Yes**           | `auth.plugin.ts:120` skips authentication only for `config: { public: true }`; the topup route does not declare it. `payment-webhook.test.ts:57` asserts the webhook is the **only** public payment route. Not exploitable by an anonymous caller.                     |
| Is it idempotency-protected?                                      | **Yes**           | `withIdempotency` with a mandatory `Idempotency-Key`; a replay returns the original result rather than crediting twice.                                                                                                                                                |
| Is it rate-limited?                                               | **Yes**           | `fastify.rateLimit(rateLimits.payment)`. Limits velocity, not the per-request amount.                                                                                                                                                                                  |
| Are there other balance-increase paths?                           | **No**            | Exactly three `updateBalances` callers — `topup`, `hold`, `releaseHold`. The latter two move `lockedBalance` only.                                                                                                                                                     |
| **Can the fabricated balance be spent?**                          | **No**            | No withdrawal, transfer or payout path for customer wallets. No ride debits the wallet. `WalletTopup`, `WalletTransfer`, `WithdrawalRequest`, `CashbackGrant` are never written. This is what makes it B and not A.                                                    |
| Does balance diverge from the ledger?                             | **Yes, today**    | `recordTripPayment` posts a `CUSTOMER_WALLET` debit at every non-cash completion while `customer_wallets.balance` is never touched.                                                                                                                                    |
| Do the books misstate anything today?                             | **Yes**           | `topup` debits `GATEWAY_CLEARING` for funds never received, overstating platform assets.                                                                                                                                                                               |
| Can a client control a ride payment's amount?                     | **Yes, latently** | `createIntentSchema` accepts a client `amount` **and** a client `rideId`; `IntentController.createIntent` validates neither ride ownership nor amount against the fare. Harmless today because nothing reads `intent.rideId` — a live hole the moment collection does. |

### Consequences for V1

Because the classification is **B**, the earlier framing — "the only defect that lets a stranger create money", "a live loss" — is withdrawn from this specification. The severity is _latent_, not _active_.

The fix nonetheless remains **mandatory and sequenced first**, because User Story 2 adds the exact debit path that would activate it.

**Mandatory regression tests. Implementation of the wallet debit path (US2) MUST NOT be merged unless all four exist and pass:**

- **RT-1**: An authenticated `POST /wallet/topup` with no confirmed provider payment does not increase the balance.
- **RT-2**: A balance increase occurs only after provider confirmation, exactly once, and is unchanged by a duplicate confirmation.
- **RT-3**: Ride collection rejects any client-supplied amount and any client-created `PaymentIntent`; the charged amount always equals the server-computed fare.
- **RT-4**: After any collection, the sum of `customer_wallets.balance` equals the ledger's `CUSTOMER_WALLET` position exactly.

---

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Wallet balance is backed by real payment (Priority: P1)

A rider's wallet balance reflects only value the business actually received, and the recorded balance agrees with the books.

**Why this priority**: not because money is being stolen — it is not (see classification B) — but because User Story 2 introduces the spend path that would make this exploitable. Fixing it first is sequencing, not alarm. It is also the smallest independently shippable slice.

**Independent Test**: request a top-up with no payment behind it and observe no balance change; confirm a real payment and observe the balance rise exactly once.

**Acceptance Scenarios**:

1. **Given** a rider with a zero balance, **When** they request a top-up that no confirmed provider payment backs, **Then** the balance stays at zero.
2. **Given** a rider whose provider payment of ₹500 is confirmed, **When** the confirmation is processed, **Then** the balance rises by exactly ₹500.
3. **Given** that confirmation is delivered twice, **When** it is processed again, **Then** the balance rises only once.
4. **Given** any balance change, **When** the ledger is queried, **Then** the `CUSTOMER_WALLET` position equals the stored balance exactly.
5. **Given** a rider with ₹100, **When** two concurrent ₹80 spends are attempted, **Then** exactly one succeeds and the balance never goes below zero.

---

### User Story 2 - A completed ride is actually paid for (Priority: P2)

When a ride ends, the rider is charged the fare calculated at completion, using the method recorded on that ride, and the ride reaches a final payment outcome.

**Why this priority**: the feature's headline value. Second only because it depends on US1's debit primitive.

**Independent Test**: complete a wallet ride and a card ride; each ends with a payment record, a moved balance, a final status, and books that balance.

**Acceptance Scenarios**:

1. **Given** a rider with sufficient balance, **When** their wallet ride completes, **Then** the fare is debited, a payment record links ride to money, and the ride is marked paid.
2. **Given** a rider paying by card, **When** their ride completes, **Then** collection is attempted server-side against the fare amount and the ride reflects the real provider outcome.
3. **Given** a card collection is declined, **When** the ride completes, **Then** the ride still completes normally for the driver, and the shortfall is recorded against the rider.
4. **Given** a completion event is delivered twice, **When** both are processed, **Then** the rider is charged exactly once.
5. **Given** any completed ride, **When** its fare is later recalculated, **Then** the amount charged does not change.
6. **Given** a ride is collected, **When** the outcome is recorded, **Then** the payment record, the ride status and the ledger entries all commit together or not at all.
7. **Given** a client submits its own payment intent naming a ride and an amount, **When** collection runs for that ride, **Then** the client's intent is ignored and the server-computed fare is charged.

---

### User Story 3 - Cash is confirmed and commission is recoverable (Priority: P3)

A driver confirms they collected the cash before the ride is treated as paid, and the commission owed on it is recovered from later settlements.

**Why this priority**: cash is the dominant method, so the accrual is real — but it depends on settlement mechanics being trustworthy first. **Rollout is gated on BD-5.**

**Independent Test**: complete a cash ride, confirm it, then settle two consecutive periods and watch the commission carry and clear.

**Acceptance Scenarios**:

1. **Given** cash confirmation is enabled and a cash ride ends, **When** the driver has not confirmed, **Then** the ride is not yet marked paid.
2. **Given** the assigned driver confirms collection, **When** it is recorded, **Then** the ride is marked paid and the commission owed is booked against that driver.
3. **Given** a driver who is not the ride's driver attempts to confirm, **When** the request is made, **Then** it is refused.
4. **Given** the same confirmation is submitted twice, **When** both are processed, **Then** the commission is booked once.
5. **Given** a driver ends a period owing commission, **When** the next settlement runs, **Then** the shortfall is carried forward and deducted before any payable is computed.

---

### User Story 4 - Every completed ride has a receipt (Priority: P4)

At completion both parties get an itemized receipt that does not change afterwards.

**Independent Test**: complete a ride, request nothing, then look up the receipt and find it already there.

**Acceptance Scenarios**:

1. **Given** a ride completes, **When** no one requests anything, **Then** a receipt already exists.
2. **Given** a receipt exists, **When** retrieved twice, **Then** both return identical content and the same receipt number.
3. **Given** a rider requests another rider's receipt, **When** the request is made, **Then** it is refused.

---

### User Story 5 - Drivers are paid from money actually collected (Priority: P5)

A driver's settlement counts earnings on a defined basis, less commission and less carried debt, and a payout never exceeds it.

**Earnings recognition basis: BD-1 approved as option C.** Driver earnings are recognised in full for every completed ride, whether or not the customer paid; an uncollected fare becomes a customer receivable rather than a deduction from the driver.

**Independent Test**: complete a mix of collected, uncollected and cash rides in one period and verify the payable against an independent ledger sum.

**Acceptance Scenarios**:

1. **Given** a ride completed but not collected, **When** settlement runs, **Then** the driver's earnings are included and the shortfall is booked as a customer receivable.
2. **Given** a settlement of ₹1,000, **When** a payout of ₹1,000.01 is attempted, **Then** it is refused.
3. **Given** a payout request is replayed, **When** processed again, **Then** the driver is paid once.
4. **Given** a driver carried a cash commission shortfall, **When** the next settlement runs, **Then** it is deducted before the payable is computed.

### Edge Cases

- A payment instrument is removed or expires between ride request and completion.
- Collection succeeds at the provider but the confirmation never arrives.
- The same provider confirmation arrives twice, out of order, or after a retry already collected.
- A rider's balance is spent to zero concurrently by two rides ending at once.
- A settlement period boundary falls between completion and collection.
- A rider account is deleted with debt outstanding.
- A driver confirms cash for a ride, then the rider disputes it _(dispute handling is out of V1 — the ride stays paid)_.
- The fare is zero.

---

## Payment status vocabulary

`FAILED` currently means two different things at two different levels, which is exactly the ambiguity this section removes. Three vocabularies exist and are **never** interchangeable. The authoritative definitions and the mapping live in [data-model.md](./data-model.md) §2; this is the summary.

| Level          | Where it lives                                           | Values                                                                                           | Meaning of the failure token                                                                                                |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Attempt**    | `RidePayment.status`                                     | `PENDING`, `SUCCEEDED`, `FAILED`, `WRITTEN_OFF`                                                  | `FAILED` = _this one attempt_ did not collect. Says nothing about the obligation.                                           |
| **Obligation** | `Ride.paymentStatus` (existing enum, 3 of 5 values used) | `PENDING`, `PAID`, `FAILED`                                                                      | `FAILED` = **open customer receivable**. No further automatic attempt will be made.                                         |
| **Public API** | derived, never stored                                    | `AWAITING_COLLECTION`, `AWAITING_CASH_CONFIRMATION`, `RETRYING`, `PAID`, `UNPAID`, `WRITTEN_OFF` | **The token `FAILED` never appears in the public API.** An open receivable is `UNPAID`; a written-off one is `WRITTEN_OFF`. |

The public field is named `collectionState`, **not** `paymentStatus`, so no reader mistakes it for the database column.

---

## Requirements _(mandatory)_

Requirements are tagged **[V1]** (required now), **[V1 — BD-n approved]** (unblocked by an approved decision), **[CLOSED]** (a decision resolved it as will-not-implement), or **[DEFERRED]** (explicitly out of V1, recorded so it is not silently lost). **No requirement remains blocked.**

### Funding integrity

- **FR-001** **[V1]**: A customer wallet balance MUST only increase as the result of a provider-confirmed payment, a processed refund, or a recorded staff adjustment. No self-service path may raise a balance without confirmed value.
- **FR-002** **[V1]**: Every wallet balance change MUST record its cause, amount, resulting balance, and justifying reference.
- **FR-003** **[V1]**: A wallet balance MUST NOT go negative, and held funds MUST NOT exceed the balance.
- **FR-004** **[V1]**: Concurrent spends against one wallet MUST be serialized so successful spends never exceed available balance.
- **FR-005** **[V1]**: A provider confirmation delivered more than once MUST credit the wallet only once.
- **FR-036** **[V1]** _(new this pass)_: The stored wallet balance MUST equal the ledger's customer-wallet position at all times, and this MUST be asserted by test rather than only monitored.

### Fare finalization

- **FR-006** **[V1]**: The fare recorded at completion MUST be the authoritative amount owed; later recalculation MUST NOT change what was charged.
- **FR-007** **[V1]**: A completed ride MUST have exactly one fare record and at most one successful payment record.
- **FR-008** **[V1]**: Post-completion adjustments MUST be separate entries, never edits to the original fare.

### Collection

- **FR-009** **[V1]**: Every completed ride MUST reach a terminal payment outcome — paid, or an explicit outstanding-debt state. None may remain indefinitely pending.
- **FR-010** **[V1]**: Collection MUST use the method recorded on the ride and MUST support cash, wallet, card and UPI.
- **FR-011** **[V1]**: A wallet-funded ride MUST reduce available balance by exactly the total fare.
- **FR-012** **[V1]**: A card or UPI ride MUST be collected against a **server-created** payment authorization linked to the ride. A client-supplied authorization MUST NOT be accepted.
- **FR-013** **[DEFERRED]**: Capture of a pre-trip hold. _No flow creates a hold for a ride today; adding pre-trip holds is new product behaviour, not a gap being closed._
- **FR-014** **[V1]**: A failed collection MUST NOT block ride completion.
- **FR-015** **[V1 — BD-4 approved]**: A failed collection MUST be retried on a bounded schedule and MUST stop at a configured limit. _BD-4 option A: bounded, decaying, configurable; no setting may produce an unbounded loop._
- **FR-016** **[V1 — BD-2 approved]**: A rider whose server-computed outstanding debt **reaches or exceeds** the configured threshold MUST be prevented from creating a new ride request. The rider MUST NOT be prevented from retrying or settling an existing unpaid obligation. _BD-2 option A: threshold configurable; comparison is `>=`; outstanding debt computed authoritatively server-side, never from client input and never cached._
- **FR-017** **[V1]**: A collection attempt replayed for the same ride MUST charge at most once.
- **FR-018** **[V1]**: Ride payment status, money movement and ledger entries MUST commit together or not at all.
- **FR-037** **[V1]** _(new this pass)_: Ledger entries for a ride MUST be posted against the account that actually moved — `CUSTOMER_WALLET` only for wallet-funded rides, `GATEWAY_CLEARING` for card and UPI — correcting the current unconditional wallet debit.
- **FR-038** **[V1]** _(new this pass)_: Ledger entries asserting customer payment MUST be posted at **collection**, not at completion, so the books never claim a payment that has not occurred.

### Cash

- **FR-019** **[V1 — BD-5 approved]**: A cash ride MUST NOT be treated as paid until the assigned driver confirms collection. _BD-5 option A: feature-flagged, default OFF, unreachable when disabled; automatic resolution after a grace period per BD-6._
- **FR-020** **[V1]**: Commission owed on a cash ride MUST be recorded as a recoverable driver balance.
- **FR-021** **[V1]**: Outstanding driver balance MUST be deducted from subsequent settlements before a payable is computed, and any remainder MUST carry forward.
- **FR-022** **[CLOSED: BD-3 — will not implement]**: A driver whose outstanding balance exceeds a configured limit MUST be prevented from going online. _BD-3 option A: no driver blocking. A customer payment failure must not affect driver eligibility. Cash commission tracking and recovery (FR-020, FR-021) are unaffected and remain in V1._

### Receipts

- **FR-023** **[V1]**: A receipt MUST be issued at the ride's payment outcome without anyone requesting it.
- **FR-024** **[V1]**: A receipt MUST carry a unique number and an immutable snapshot of the fare and how it was paid.
- **FR-025** **[V1]**: A receipt MUST be retrievable only by that ride's rider, that ride's driver, and staff.

### Settlement and payout

- **FR-026** **[V1 — BD-1 approved]**: A driver's settlement MUST count the driver earning for every completed ride **regardless of whether the customer's payment was collected**, less commission and less carried balance. A customer's failure to pay MUST NOT reduce driver earnings.
- **FR-027** **[V1 — BD-1 approved]**: Because earnings are recognised at completion, a fare collected in a later period MUST NOT be re-recognised. Settling a receivable moves only the balancing side of the ledger group.
- **FR-028** **[V1]**: A payout MUST NOT exceed its settlement's net payable, and a replayed payout request MUST pay once. _Already correct; must remain so._
- **FR-029** **[DEFERRED]**: Refund reversal of driver earnings. _Refunds exist today and do not touch `DRIVER_PAYABLE`. Making them ride-aware is a distinct feature; deferring is a conscious decision, not an oversight._

### Books, audit and access

- **FR-030** **[V1]**: Every money movement MUST produce a balanced double-entry group.
- **FR-031** **[V1]**: Reconciliation MUST compare stored balances against the ledger, not only against their own transaction history.
- **FR-032** **[V1]**: Reconciliation MUST cover driver wallets as well as customer wallets.
- **FR-033** **[V1]**: Every payment state change MUST publish its event in the same transaction as the change.
- **FR-034** **[V1]**: A rider MUST access only their own wallet, payments and receipts; a driver only their own rides and earnings; payouts and refunds beyond a rider's own MUST require staff authority.
- **FR-035** **[V1]**: Every staff-initiated money movement MUST record who performed it and why.

### Accounting policy

- **FR-039** **[V1 — BD-1 approved]**: A permanently uncollected fare MUST be recorded as a **customer receivable** — `CUSTOMER_RECEIVABLE` debited for the fare, `DRIVER_PAYABLE` and `PLATFORM_COMMISSION` credited — in one balanced group. It MUST NOT be booked as bad-debt expense at that point, and MUST NOT be deducted from driver earnings.
- **FR-042** **[V1 — BD-1c approved]**: An outstanding receivable MUST be written off after a **configurable** ageing period, posting `BAD_DEBT_EXPENSE` debit / `CUSTOMER_RECEIVABLE` credit. The ageing period MUST NOT be hard-coded. The write-off MUST be idempotent, auditable, and MUST NOT be duplicable. A written-off obligation is closed and MUST NOT be settleable.
- **FR-043** **[V1 — BD-6 approved]**: When cash confirmation is enabled and the assigned driver has not confirmed within a **configurable** grace period, the system MUST resolve the cash collection automatically. The transition MUST be idempotent, and repeated sweeps MUST NOT create duplicate collection, commission or earnings entries. All six preconditions in [decisions.md](./decisions.md#bd-6) MUST hold and MUST be re-checked inside the claiming transaction.
- **FR-044** **[V1 — BD-7 approved]**: The corrected ledger posting model MUST apply **prospectively only**. No migration, job or script may rewrite, delete or mutate any existing `payment_ledger_entries` row. Reconciliation MUST scope its live comparison to entries at or after the configured cut-over and MUST report pre-cut-over divergence separately as historical and uncorrected.

### Contract integrity

- **FR-040** **[V1]** _(new this pass)_: Every mutating payment route MUST enforce idempotency through the existing Redis-backed mechanism. `POST /intents/:intentId/confirm` MUST be brought into that mechanism rather than relying on its incidental transition guard.
- **FR-041** **[V1]** _(new this pass)_: The public API MUST expose a collection state distinct from the internal `Ride.paymentStatus` column, so that "failed attempt" and "standing debt" are never represented by the same token. See §Payment status vocabulary.

### Key Entities

- **Ride Fare** — the itemized breakdown computed at completion. One per ride, never edited.
- **Ride Payment** — the record connecting a ride to money that moved: amount, method, outcome, settlement time, and the authorization used. Currently written by nothing.
- **Payment Authorization** — a server-created request to collect a specific amount, linked to its ride.
- **Customer Wallet** — stored balance, held portion, and transaction history; must equal the ledger.
- **Driver Balance** — commission owed from cash rides, carried across periods and recovered from earnings. Held as the driver wallet balance, which may be negative.
- **Ride Receipt** — the numbered, immutable snapshot of cost and payment.
- **Driver Settlement** — the per-period statement and resulting net payable.
- **Ledger Entry** — a debit or credit in a balanced group; the authority all balances reconcile to.

---

## Success Criteria _(mandatory)_

- **SC-001**: No wallet balance can be created without a provider-confirmed payment.
- **SC-002**: 100% of completed rides reach a terminal payment outcome within 24 hours; none remain pending.
- **SC-003**: Stored wallet balances equal the corresponding ledger position exactly, checked daily, divergence reported same-day.
- **SC-004**: Every ledger group balances to zero, with no rounding drift.
- **SC-005**: 100% of completed rides have a retrievable receipt, none generated later than the payment outcome that caused it.
- **SC-006**: A driver's settlement equals the independently computed figure to the paise, every period.
- **SC-007**: No payout exceeds its settlement's net payable and no replay pays twice, verified under concurrent load.
- **SC-008**: A rider is charged at most once per ride under repeated and concurrent completion.
- **SC-009**: 95% of successful collections surface a final amount on the rider's completion screen rather than a pending state.
- **SC-010**: No ledger entry asserts a customer payment that did not occur — verified by reconciling `CUSTOMER_WALLET` and `GATEWAY_CLEARING` positions against successful payment records.

---

## Assumptions

Confirmed defaults only. Everything with financial consequence moved to §Business Decisions Required.

- Existing rate cards, surge model and commission rates are correct and out of scope; this feature collects the fare pricing produces.
- Single currency (INR).
- Existing platform mechanisms are reused as-is: outbox, idempotency, gateway signature verification, transaction management, double-entry ledger. No parallel mechanism is introduced.
- Deployment remains single-instance for realtime; no cross-instance coordination is assumed beyond existing Redis locks.
- Cash remains the dominant method, so cash confirmation must not delay a driver returning to service — confirmation is a books concern, not a dispatch gate.

## Out of Scope

Surge, promotions, coupons, referral credits, tolls, cancellation fees · rider fare disputes and `RideDispute` · chargebacks · pre-trip holds (FR-013) · ride-linked refund reversal (FR-029) · new payment gateways · multi-currency · driver bank account onboarding · statutory invoicing beyond the receipt · redesign of fare computation, commission rates, or the payout guard.
