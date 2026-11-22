# Phase 0 Research: Payment & Fare Settlement

**Feature**: `002-payment-fare-settlement` | **Date**: 2026-08-23 | **Decisions applied**: 2026-08-23

Every decision below was taken against the verified current behaviour of this codebase, not against a generic best-practice checklist. Where a well-known pattern was rejected, the reason is specific to what this platform already has.

> **Correction pass note (pass 1)**: §4 previously classified the wallet top-up hole as an active vulnerability. Exhaustive re-tracing showed the fabricated balance has **no spend path**, so it is a latent design gap, not a live loss. §4 is rewritten below and two findings discovered during that re-trace (§11, §12) are added.
>
> **Correction pass note (pass 2)**: open decisions moved to [decisions.md](./decisions.md), the **single source of truth** — this file no longer restates their options. Two further findings were added: §14 (an idempotency coverage gap) and §15 (event duplicate meaning, resolved by removing an event).
>
> **Decision-application pass (2026-08-23)**: all seven decisions **approved**. §5, §6, §7 and §10 below are updated to the approved terms; §13 records the outcome.

---

## 1. Where collection is triggered

**Decision**: A new outbox consumer on `ride.completed`, registered in the existing `CONSUMER_KEYS` list in `src/bootstrap/events.bootstrap.ts`.

**Rationale**: The platform already has exactly one mechanism for "something committed, now react to it" — the transactional outbox, drained by `OutboxRelay.processBatch()` onto the in-process `EventBus`. Two consumers already ride it (notifications, realtime). Collection is the same shape of problem, and the previous feature deliberately split `registerEventConsumers()` out of `bootstrapEvents()` specifically so consumers are testable without starting a background timer. Adding a third consumer costs one line in one list.

**Alternatives considered**:

- _Inline in `LifecycleService.completeRide`_ — rejected. It would put a payment-gateway network call inside an open Postgres transaction holding row locks on the ride and the driver's online status. Gateway latency would stall the driver's next ride, and a gateway outage would make ride completion itself fail. FR-014 requires the opposite.
- _A polling job over `paymentStatus = 'PENDING'` rides_ — rejected as the **primary** trigger because it adds latency the rider sees and re-derives state the outbox already delivers. Retained as a **secondary** safety net (§5).
- _Direct call from the rides module into the payments module_ — rejected. It couples two modules that currently share no service-level dependency, and it would run inside the ride transaction, inheriting the first problem.

---

## 2. Keeping gateway I/O out of transactions

**Decision**: The gateway call happens in `RideCollectionService` **before** `txManager.execute` is entered. The transaction records the already-known outcome.

**Rationale**: This is the shape `IntentService.confirmIntent` already uses — it calls `gateway.confirmIntent(...)` and only then opens a transaction to run `applyConfirmation`. Following the existing shape means the new code fails the same way the old code already fails, which is a property worth more than novelty.

**Consequence accepted**: A crash between the gateway call and the commit leaves the gateway charged and the platform unaware. This is recovered by the retry job (§5), which re-queries the gateway by the deterministic idempotency key rather than re-charging. The key is derived from the ride id, so a re-attempt returns the original charge instead of creating a second one.

---

## 3. Exactly-once collection

**Decision**: Three independent layers, all of which must agree.

| Layer    | Mechanism                                                    | What it catches                                                    |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Claim    | Redis lock `payment:collect:{rideId}`, TTL 30s               | Two consumers processing the same delivery concurrently            |
| Database | Partial unique index: one `SUCCEEDED` `RidePayment` per ride | Anything that gets past the lock, including a lock lost to a crash |
| Gateway  | Idempotency key derived deterministically from the ride id   | A retry that reaches the gateway a second time                     |

**Rationale**: The dispatch feature established that a Redis lock alone is not a correctness boundary — the row lock and the conditional `updateMany` claim are. The same reasoning applies here, with more at stake. The lock is an optimization that avoids wasted work; the index is the guarantee.

**Alternatives considered**: Relying on the outbox's own at-least-once delivery plus a consumer-side dedupe table — rejected as a fourth mechanism for something the unique index already enforces at zero cost.

---

## 4. Closing the wallet funding hole

**Decision**: `WalletService.topup` stops being reachable from the HTTP layer. `POST /wallet/topup` creates a funding `PaymentIntent` instead, and the wallet is credited from inside `IntentService.applyConfirmation` when — and only when — the gateway confirms.

**Rationale**: This is the smallest edit that fixes two separate defects at once. `applyConfirmation` **already** posts a `CUSTOMER_WALLET` credit to the ledger on success; it simply never touches the balance. Moving the balance mutation to the same place as the ledger entry means the two can no longer diverge — FR-036 discharged structurally rather than by a report that notices the damage afterwards.

**Severity, corrected**: the earlier draft called this "a live loss" and said "any authenticated rider can create money". Re-tracing every path proved that overstated:

- The only writes to `customer_wallets.balance` are three `updateBalances` callers — `topup`, `hold`, `releaseHold`. The latter two move `lockedBalance` only.
- **There is no spend path.** No withdrawal endpoint, no transfer endpoint, and no ride debits the wallet. `WalletTopup`, `WalletTransfer`, `WithdrawalRequest` and `CashbackGrant` are never written by any code.

So the fabricated balance can be displayed and locked, and nothing else. Classified **B — verified design gap, not currently exploitable** (full evidence table in [spec.md](./spec.md) §Critical Finding Classification).

It stays in V1 anyway, for reasons that survive the downgrade:

1. `topup` posts a `GATEWAY_CLEARING` debit for funds never received, overstating platform assets on the books.
2. It becomes **immediately exploitable** the moment US2 adds the wallet debit path — which is the whole point of this feature. Fixing it first is sequencing, not alarm.

**Alternatives considered**:

- _Add an authorization check so only staff can call topup_ — rejected. It narrows who can fabricate balance without making the money real, and leaves the ledger untouched.
- _Leave topup and add a compensating reconciliation_ — rejected. Detecting fabricated balance after the fact is not a control.
- _Defer the fix to a later feature since it is not exploitable today_ — rejected precisely because US2 makes it exploitable. Shipping a debit path onto a mintable balance is the one ordering that must not happen.

**Defence in depth**: the wallet credit must be driven by the **webhook** path rather than by client-initiated `confirmIntent`. `confirmIntent` is caller-authorized (`assertOwnerOrStaff`) and asks the provider for real status, so it is safe against a live gateway — but under the mock gateway it self-confirms, and a credit path that is only safe because of which gateway is configured is not a control either.

**Sign convention warning**: `ReconciliationJob` computes the expected balance as `SUM(customerWalletTransaction.amount)`, and the existing `TOPUP` row records a **positive** amount. Every debit therefore **must** record a negative amount, or reconciliation will report mismatches on correct data. This is the single most likely subtle bug in the feature and is called out as its own task.

---

## 5. Retry policy for failed collection

**Decision (BD-4 approved, option A)**: a bounded BullMQ maintenance job (`payment-collection-sweep`) retries rides left unpaid on a decaying schedule up to `PAYMENT_COLLECTION_MAX_ATTEMPTS`, after which the ride becomes an open **customer receivable** and stops being retried. The same sweep also performs BD-6 automatic cash resolution, since both scan rides at `paymentStatus = PENDING`. Ageing write-off (BD-1c) runs as a **separate daily job**, because its cadence is days rather than minutes.

**Rationale**: The platform's maintenance-job pattern (`MaintenanceRunner` with `run(now)`, dispatched through `MAINTENANCE_HANDLERS`) already exists and already carries a payments queue and two payments jobs. The retry job is a new entry in a table, not new infrastructure.

**Alternatives considered**: BullMQ's own `attempts` + exponential backoff on a per-collection job — rejected because it would mean enqueueing a job per ride completion, giving the queue a workload proportional to ride volume for something that succeeds on the first attempt in the overwhelming majority of cases. A periodic sweep over the small set of failures is cheaper.

---

## 6. Modelling debt without new tables

**Decision (BD-1/BD-2/BD-3 approved)**: driver commission balance is a negative `DriverWallet.balance`, carried between periods through `calculateSettlement`'s existing `adjustments` parameter — and per BD-3 it **never blocks a driver**. Customer receivables are a projection of `Ride.paymentStatus = FAILED` with no `WRITTEN_OFF` row, aggregated per rider for the BD-2 threshold. Neither is a stored balance, so neither can duplicate.

**Rationale**: `SettlementService.calculateSettlement` already accepts `adjustments?: Decimal` and already threads it into `netPayable` — the parameter exists, is correct, and has never been supplied a value. The settlement code comment already anticipates a cash-only driver netting negative. The model was designed for this; it was simply never connected.

**Alternatives considered**: A dedicated `driver_debt` / `rider_debt` table — rejected as a new source of truth that would have to be reconciled against the wallet and the ledger, adding a third number where two already disagree.

---

## 7. Cash confirmation

**Decision**: A cash ride completes with `paymentStatus = PENDING`; a new driver-facing endpoint confirms collection, which flips it to `PAID` and books the commission debt.

**Rationale**: FR-019 requires it, and today's behaviour — marking cash `PAID` at completion with no acknowledgement — means the platform's books assert a fact nobody verified.

**Friction constraint honoured**: the spec assumes cash is the dominant method and confirmation must not delay the driver's next ride. Confirmation is therefore **not** a precondition for the driver returning to `ONLINE`; `completeRide` already sets the driver back online and that behaviour is unchanged. An unconfirmed cash ride is a debt-side concern, not a dispatch-side one.

---

## 8. Reconciliation scope

**Decision**: Extend `ReconciliationJob` to compare stored balances against the **ledger** position, and to cover driver wallets as well as customer wallets.

**Rationale**: The current job compares `customer_wallets.balance` against `SUM(customer_wallet_transactions.amount)`. Both sides are written by the same code path, so the check can only catch a partial write — never a design defect, and never a divergence from the authoritative books. FR-031 requires the ledger to be one of the two sides.

**Alternatives considered**: Replacing the transaction-sum check entirely — rejected. It catches a genuinely different failure (a transaction row written without a balance update). Both checks are kept.

---

## 9. Receipt issuance

**Decision**: `ReceiptService.generateReceipt` is called from the collection path once the payment outcome is known, rather than lazily on first `GET`.

**Rationale**: `generateReceipt` is already idempotent — it returns the existing receipt when one exists — so calling it at completion does not break the existing lazy path, which stays as a fallback for historical rides. FR-023 is satisfied by adding one call, not by rewriting receipts.

**Open consequence**: the receipt must reflect _how the ride was paid_, so it is issued after the collection outcome, not at completion itself. For a card ride that fails, the receipt records the fare as unpaid. This is intentional — a receipt for an uncollected ride is what the rider needs in order to settle it.

---

## 10. Configuration

**Decision**: **Seven knobs**, every one mandated by an approved decision — none discretionary. All read through the existing `numericEnv` helper (or its boolean equivalent), validated at boot.

| Knob                                 | Decision | Bounds             | Value                                                                             |
| ------------------------------------ | -------- | ------------------ | --------------------------------------------------------------------------------- |
| `PAYMENT_COLLECTION_MAX_ATTEMPTS`    | BD-4     | 1–20, integer      | Operator-set; bounded above so no value yields an unbounded loop                  |
| `PAYMENT_COLLECTION_RETRY_BASE_SEC`  | BD-4     | 30–86400, integer  | Operator-set                                                                      |
| `PAYMENT_RIDER_DEBT_LIMIT`           | BD-2     | ≥ 0                | Operator-set; comparison is `>=`                                                  |
| `PAYMENT_CASH_CONFIRMATION_REQUIRED` | BD-5     | boolean            | **Default `false`** — the one value the decision fixes                            |
| `PAYMENT_CASH_CONFIRM_GRACE_SEC`     | BD-6     | ≥ 60, integer      | Operator-set                                                                      |
| `PAYMENT_RECEIVABLE_WRITEOFF_DAYS`   | BD-1c    | ≥ 1, integer       | Operator-set; **must not be hard-coded**                                          |
| `PAYMENT_LEDGER_CUTOVER_AT`          | BD-7     | ISO-8601 timestamp | Operator-set at deploy                                                            |
| ~~`PAYMENT_DRIVER_DEBT_LIMIT`~~      | BD-3     | —                  | **REMOVED** — BD-3 approved _no driver blocking_, so the knob has nothing to gate |

The count grew from four because approved decisions require it — BD-1c, BD-6 and BD-7 each mandate a configurable value — not through scope creep. Only `PAYMENT_CASH_CONFIRMATION_REQUIRED` has a decision-fixed default (`false`, per BD-5); every other value is the operator's to set, and the placeholder defaults from the first draft remain withdrawn.

**Rationale**: `numericEnv` was built in the dispatch feature precisely because `Number('abc')` yields `NaN` and every downstream guard against `NaN` fails open. The blast radius here is larger than it was for dispatch batch size: a `NaN` debt limit means no rider is ever blocked, and a `NaN` retry cap means unbounded gateway retries. Every one of these knobs is bounded and validated at boot.

**Note**: `paymentConfig` currently reads `idempotencyTtlSeconds` and `webhookToleranceSeconds` with bare `Number(...)`, which has the same `NaN` exposure. Converting those two is a small, in-scope cleanup rather than a redesign.

---

## 11. NEW FINDING — the ledger asserts payments that never happened

**Discovered during the correction pass.**

`LifecycleService.completeRide` calls `LedgerService.recordTripPayment` unconditionally at completion. For any non-cash ride that posts:

- `CUSTOMER_WALLET` **debit** for the full fare,
- `DRIVER_PAYABLE` credit for the driver's earning,
- `PLATFORM_COMMISSION` credit.

No money has moved at that point, and under the current code none ever will. **Every non-cash ride ever completed has ledger entries claiming the customer paid.**

Two independent defects:

1. **Timing** — payment entries are posted at completion rather than at collection. The books state a fact that has not occurred.
2. **Account** — every non-cash method is treated as a wallet payment. A card rider's `CUSTOMER_WALLET` position is debited for a fare they never funded a wallet with. Under the convention the codebase otherwise follows (`topup` debits `GATEWAY_CLEARING` and credits `CUSTOMER_WALLET`, i.e. wallet-as-liability, clearing-as-asset), the correct entry for a card ride debits `GATEWAY_CLEARING`.

**Decision**: move the customer-payment entries out of `completeRide` and into the collection path, and select the account by method. Recorded as FR-037 and FR-038.

**Consequence for existing data**: historical ledger entries are wrong and this feature does not rewrite them. Whether to post correcting entries for the existing period is a **finance decision**, noted as an open question rather than assumed.

---

## 12. NEW FINDING — a client can name its own amount and ride on a payment intent

**Discovered during the correction pass.**

`createIntentSchema` accepts both `amount` and `rideId` from the request body, and `IntentController.createIntent` validates neither:

- no check that `rideId` belongs to the caller,
- no check that `amount` matches that ride's fare.

Harmless today, because nothing reads `intent.rideId`. It becomes a **fare-bypass vulnerability** the moment collection resolves a ride to an intent: a rider could pre-create a ₹1 intent naming their ride, confirm it, and have collection consider the ride settled.

**Decision**:

1. Ride collection **creates its own intent server-side** with the fare amount, and never resolves a ride to a client-created intent.
2. `rideId` is removed from the public `createIntentSchema`. A client may fund a wallet; it may not declare which ride its payment settles.

Recorded as FR-012 and acceptance scenario US2-7, with **RT-3** as a mandatory regression test.

---

## 13. Decisions — ALL APPROVED

All seven business decisions were **approved on 2026-08-23**. The first draft had resolved several by writing defaults into an Assumptions section — the wrong disposition, since each set a financial policy and a buried default becomes a silent implementation requirement. They were escalated, and are now decided.

The approved terms live in **[decisions.md](./decisions.md), the single source of truth**. **This file deliberately does not restate them.**

**BD-1 was approved as option C — customer receivable.** The consequence that most shapes the implementation: because a customer's failure must not reduce driver earnings, `aggregateEarnings` **keeps deriving from `ride_fares` and does not gain a `ride_payments` join**. The join contemplated under the rejected option B would have been exactly wrong.

Both new ledger accounts follow from the approved decisions: `CUSTOMER_RECEIVABLE` (BD-1) and `BAD_DEBT_EXPENSE` (BD-1c, at write-off only).

---

## 14. NEW FINDING — the idempotency claim was broader than the code

**Discovered during the second correction pass**, while verifying the contract statement "Idempotency-Key is mandatory on every mutating payment route".

`withIdempotency` has **exactly five call sites**: `createIntent`, `topup`, `hold`, `processRefund`, `executePayout`. **`POST /intents/:intentId/confirm` is not one of them**, and it is a mutating route — it moves an intent to `SUCCEEDED` or `FAILED` and posts ledger entries.

It is safe _in effect_: `applyConfirmation` returns early when the intent already holds the target status, and `validateTransition` rejects illegal moves. But it is safe by an incidental guard rather than by the platform mechanism the contract claimed, and the difference matters once wallet crediting hangs off that path.

**Decision**: bring `confirmIntent` into `withIdempotency` (FR-040), and scope the contract's idempotency statement to a route-by-route audit rather than a blanket assertion. The audit table now lives in [contracts/http-api.md](./contracts/http-api.md) §Idempotency.

**No second mechanism**: the existing Redis-backed `IdempotencyRepository` is used as-is. The `IdempotencyKey` Prisma model in `admin.prisma` is unused today and stays unused — noted so nobody "completes" it later believing it was an oversight.

---

## 15. NEW FINDING — two events described one state transition

**Discovered during the second correction pass**, while auditing event contracts for duplicate meaning.

`payment.debt.recorded` was specified to publish in the **same transaction** as `payment.ride.collection_failed` with `willRetry: false`. Both described the same transition — collection attempts exhausted, obligation now standing. A consumer subscribing to both would notify the rider twice for one unpaid ride.

**Decision**: remove `payment.debt.recorded`. The receivable state is derivable from `collection_failed` with `willRetry: false`, and cash commission from `collected` with `commissionOwed > 0`. That took the new-event count from 3 to 2; the approved BD-1c then added `payment.receivable.written_off` for audit, giving a **final count of 3**.

Three existing pairs _look_ overlapping and were checked but are genuinely distinct — `payment.succeeded` (instrument-level) vs `payment.ride.collected` (obligation-level), `payment.wallet.debited` (wallet-level) vs `collected`, and `payment.settlement.completed` (period-level). The boundary and the rule preventing double-acting are recorded in [contracts/events.md](./contracts/events.md) §Boundary.

---

## 16. Debt is a projection, not a row

**Settled during the second correction pass**, in response to the requirement that repeated retries and repeated event delivery must not create multiple debts for one unpaid obligation.

**Decision**: standing debt is **not stored**. It is the obligation-level state `Ride.paymentStatus = 'FAILED'`, with the amount taken from that ride's `RideFare.totalFare`.

**Rationale**: a debt _row_ would need its own uniqueness guarantee, its own idempotency story, and its own reconciliation against the ride and the ledger — three new failure modes to protect against duplicates. As a projection, duplicates are impossible by construction: a ride has exactly one `paymentStatus`, guaranteed by its primary key. There is nothing for a repeated event to create.

**Consequences**: rider debt is an aggregate (`SUM(RideFare.totalFare)` where `paymentStatus = 'FAILED'`), which needs the `rides(customer_id, payment_status)` index — migration §5.4. Repayment is the retry endpoint writing a **new attempt row** against the same ride; success flips the obligation to `PAID` and the debt ceases to exist because it was only ever a view of that column.

**Alternative considered**: a `rider_debt` table with a running balance — rejected as a third number to reconcile against two that must already agree.
