# Quickstart: Validating Payment & Fare Settlement

**Feature**: `002-payment-fare-settlement` | **Date**: 2026-08-23 | **Corrected**: 2026-08-23

> **✅ All seven business decisions approved** — see [decisions.md](./decisions.md), the single source of truth. Every scenario below is now fully specified and executable once implementation begins.

How to prove this feature works end to end. This is a validation guide — see [tasks.md](./tasks.md) (currently blocked) for build order and [data-model.md](./data-model.md) for the invariants being asserted.

---

## Prerequisites

```bash
node -v          # must be v22.x — pinned in .nvmrc; v26 produces spurious teardown failures on Windows
docker ps        # Postgres and Redis containers must be running
```

Migrations must be applied to the **test** database, not the development one:

```bash
export DATABASE_URL=postgresql://<user>:<pass>@localhost:5433/zaroorat_test
export REDIS_URL=redis://localhost:6380/1
npx prisma migrate deploy
```

The payment gateway must be the mock (default outside production and staging):

```bash
echo $PAYMENT_DEFAULT_GATEWAY   # empty or "mock"
```

---

## Run the checks

```bash
npm run test:unit -- tests/unit/payments
npm run test:integration -- tests/integration/wallet-funding.test.ts
npm run test:integration -- tests/integration/ride-collection.test.ts
npm run test:integration -- tests/integration/cash-settlement.test.ts
npm test                                          # full suite before declaring done
```

The full suite takes roughly 11 minutes — run it in the background.

**Baseline**: 1546 tests with 15 pre-existing failures — 14 in `earnings-pipeline`, 1 in `authorization-bola` — all raising `INCOMPLETE_PROFILE`.

**These are not payment defects and this feature will not fix them by accident.** `INCOMPLETE_PROFILE` is raised by ride _booking_ when the rider has no profile name (`src/modules/rides/errors/ride.errors.ts:117`). Those fixtures create a rider and immediately request a ride, so booking returns `422` and every downstream money assertion fails for a reason unrelated to money.

Two consequences:

1. **Fix the fixture, not the assertion.** The fixture must set a profile name. That is the one place in this feature where "make the test pass" is legitimate, because the assertions were never reached.
2. **Do not repeat the gap.** Every new integration fixture must complete the rider profile before booking.

Any failure outside those 15 is a regression.

---

## Mandatory regression tests

These four gate the wallet debit path. **Implementation of User Story 2 must not merge unless all four exist and pass** (spec.md §Critical Finding Classification).

| ID       | Assertion                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RT-1** | An authenticated `POST /wallet/topup` with no confirmed provider payment does not increase the balance                                               |
| **RT-2** | A balance increase occurs only after provider confirmation, exactly once, unchanged by a duplicate confirmation                                      |
| **RT-3** | Ride collection rejects any client-supplied amount and any client-created `PaymentIntent`; the charged amount always equals the server-computed fare |
| **RT-4** | After any collection, total `customer_wallets.balance` equals the ledger's `CUSTOMER_WALLET` position exactly                                        |

---

## Scenario 1 — Wallet balance cannot be fabricated _(US1 · RT-1, RT-2)_

1. Register a rider, log in, read `GET /api/v1/payments/wallet/balance` → expect `0`.
2. `POST /api/v1/payments/wallet/topup` with `{ "amount": 5000 }` and an `Idempotency-Key`.
3. Read the balance again.

**Expected**: still `0`. The response is a pending authorization, not a credited balance.

**This is the regression test for the current defect** — on today's code, step 3 returns `5000`.

4. Deliver a mock gateway webhook confirming that intent, then read the balance.

**Expected**: exactly `5000`, and the ledger's `CUSTOMER_WALLET` position for that rider agrees to the paise.

5. Deliver the identical webhook again.

**Expected**: still `5000`. Not `10000`.

---

## Scenario 2 — A wallet ride is actually collected _(US2 · RT-4)_

1. Fund a rider's wallet to ₹1,000 via Scenario 1's confirmed path.
2. Run a ride to completion with `paymentMethod: "WALLET"`.
3. Drain the outbox — `drainOutbox()` from `tests/integration/helpers/harness.ts`, which loops until quiescent. Do **not** assert immediately after completion; collection is a consumer and has not run yet.

**Expected after the drain**:

| Check                       | Expectation                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `Ride.paymentStatus`        | `PAID`                                                            |
| `RidePayment`               | exactly one `SUCCEEDED` row, amount equal to `RideFare.totalFare` |
| `CustomerWallet.balance`    | reduced by exactly the total fare                                 |
| `CustomerWalletTransaction` | one new row with a **negative** amount                            |
| Ledger group                | sums to zero, and debits `CUSTOMER_WALLET`                        |
| `RideReceipt`               | exists, without anyone having requested it                        |

4. Replay the same `ride.completed` envelope through the bus.

**Expected**: nothing changes. Still one `RidePayment`, balance unmoved. This is the exactly-once proof.

---

## Scenario 3 — Card ride: correct account, no client control _(US2 · RT-3)_

1. Complete a `CARD` ride with the mock gateway succeeding, then drain the outbox.

**Expected**: `paymentStatus = PAID`, and the collection's ledger group debits **`GATEWAY_CLEARING`, not `CUSTOMER_WALLET`** — the correction in FR-037. The rider's wallet position is untouched, because they did not pay from a wallet.

2. Before completing a second card ride, have the client call `POST /intents` attempting to name that ride and an amount of ₹1.

**Expected**: the request is rejected — `rideId` is not an accepted field. Even if such an intent existed, collection creates its own and charges the full fare.

3. Configure the mock gateway to decline and complete a third card ride.

**Expected**: the ride is `COMPLETED`, the driver is back `ONLINE`, and the internal `Ride.paymentStatus` remains `PENDING` with a `FAILED` `RidePayment` **attempt** row. The public `collectionState` reads `RETRYING`, not `UNPAID` — the obligation is still open because retries remain. This is exactly the distinction the two vocabularies exist to preserve.

4. Run the retry job past the configured attempt cap.

**Expected**: attempts stop at the cap. In one transaction the final `payment.ride.collection_failed` is published with `willRetry: false` — **this is the debt-establishing event; there is no separate debt event** — and the internal `Ride.paymentStatus` becomes `FAILED`. `GET /rides/:rideId/payment` then reports `collectionState: "UNPAID"` with a non-zero `amountOwed`, and `GET /api/v1/payments/me/debt` shows it.

**Assert the vocabulary too**: the response must read `UNPAID`, never `FAILED`. `FAILED` is the internal obligation column and the attempt-row value; it must not leak into the public API ([data-model.md](./data-model.md) §2.1).

**Note**: the cap and interval are **BD-4**; this scenario validates the mechanism, not any particular number.

---

## Scenario 4 — Cash confirmation _(US3 · BD-5, BD-6)_

**Both flag states must be tested** — BD-5 requires it explicitly.

**4a — flag OFF (the default).**

1. Confirm `PAYMENT_CASH_CONFIRMATION_REQUIRED` is `false`.
2. Complete a `CASH` ride.

**Expected**: `collectionState` is `PAID` immediately — today's behaviour, unchanged.

3. Call `POST /rides/:rideId/payment/confirm-cash`.

**Expected**: `404`. BD-5 requires that no client can _access or execute_ the flow when disabled, so the route is not registered at all.

**4b — flag ON.** Enable the flag and restart, then:

1. Complete a `CASH` ride.

**Expected**: `Ride.paymentStatus` is `PENDING` — **not** `PAID`. This is the behaviour change; today it is `PAID` immediately.

2. Attempt confirmation as a **different** driver.

**Expected**: refused. Ownership is checked exactly as `lockAndValidate` checks it for every other driver action.

3. Confirm as the assigned driver.

**Expected**: `PAID`; the driver's wallet balance goes **negative** by the commission owed; the ledger posts `DRIVER_PAYABLE` debit + `PLATFORM_COMMISSION` credit.

4. Submit the identical confirmation again with the same `Idempotency-Key`.

**Expected**: the original response replays; the commission is booked once.

---

## Scenario 5 — Driver commission carry-forward _(US3 · BD-1, BD-3)_

1. Settle the period containing the cash ride from Scenario 4.

**Expected**: `netPayable` is negative and no payout is issued.

2. Give the same driver a collected non-cash ride in the next period and settle again.

**Expected**: the prior shortfall arrives as `adjustments` and is deducted before the payable is computed. Debt recovered equals debt carried.

**Now decided (BD-1 = C)**: an uncollected ride's driver earnings **do** appear, in full. The unpaid fare sits as a `CUSTOMER_RECEIVABLE` debit rather than reducing what the driver is owed.

---

## Scenario 6 — Settlement basis _(US5 · BD-1 = C)_

Set up one driver with three completed rides in one period: one collected, one permanently uncollected, one cash-confirmed.

**Expected under the approved option C**:

| Ride                        | Driver earning in `netPayable` | Ledger                                     |
| --------------------------- | ------------------------------ | ------------------------------------------ |
| Collected                   | included                       | `GATEWAY_CLEARING`/`CUSTOMER_WALLET` debit |
| **Permanently uncollected** | **included — in full**         | `CUSTOMER_RECEIVABLE` debit                |
| Cash confirmed              | driver holds the fare          | `DRIVER_PAYABLE` debit of commission only  |

**The critical negative assertion**: the uncollected ride must **not** reduce the driver's payable. BD-1 forbids deducting a customer's failure from driver earnings, so a settlement query that filters on collection success is a defect, not an optimisation.

Then settle the receivable in a later period and settle again: the payable must **not** increase, because those earnings were already recognised at transition 6. Re-recognising them would double-pay the driver.

---

## Scenario 7 — Reconciliation detects divergence

1. Manually adjust one `customer_wallets.balance` row directly in SQL, bypassing the service.
2. Run the reconciliation job.

**Expected**: a `MISMATCH` row in `wallet_reconciliations`, a `payment.reconciliation.mismatch` event, and a warning naming the wallet — detected against the **ledger**, which is the check that does not exist today.

3. Repeat for a `driver_wallets` row.

**Expected**: same outcome. Driver wallets are reconciled too, which they currently are not.

4. Verify the receivable identity: the `CUSTOMER_RECEIVABLE` ledger position equals the summed fare of all rides in `UNPAID`, to the paise.

5. Verify the bad-debt identity: the `BAD_DEBT_EXPENSE` position equals the summed fare of all rides in `WRITTEN_OFF`.

---

## Scenario 8 — Receivable write-off _(BD-1c)_

1. Take the `UNPAID` ride from Scenario 3 and age it past `PAYMENT_RECEIVABLE_WRITEOFF_DAYS`.
2. Run the write-off sweep.

**Expected**: a `RidePayment` row with `status = WRITTEN_OFF`; a ledger group debiting `BAD_DEBT_EXPENSE` and crediting `CUSTOMER_RECEIVABLE`; `collectionState` reads `WRITTEN_OFF`; `amountOwed` is `0`; `payment.receivable.written_off` published.

3. Run the sweep a second time.

**Expected**: nothing changes. The partial unique index makes a duplicate write-off impossible, and no second `BAD_DEBT_EXPENSE` entry is posted. BD-1c requires this to be structural, not best-effort.

4. Attempt `POST /rides/:rideId/payment/retry` on the written-off ride.

**Expected**: refused. BD-1c closes the obligation — outstanding _until collected or written off_.

5. Re-check the rider debt aggregate.

**Expected**: the written-off amount no longer counts toward the BD-2 threshold. **Flag for the product owner**: a rider who waits out the ageing period is thereby unblocked. This follows faithfully from the two approved decisions read together and is a known trade-off, not a defect in either.

---

## Scenario 9 — Debt threshold blocks new rides but never settlement _(BD-2)_

1. Accumulate receivables until the rider is one paisa below `PAYMENT_RIDER_DEBT_LIMIT`.

**Expected**: a new ride request succeeds.

2. Push the outstanding total to **exactly** the limit.

**Expected**: a new ride request is refused. The comparison is `>=` — _reaches or exceeds_ — so the boundary value itself blocks. **Assert at exactly the limit**, not merely above it; an off-by-one here is the difference between the approved policy and a different one.

3. With the rider blocked, call `POST /rides/:rideId/payment/retry`.

**Expected**: **allowed.** BD-2 forbids blocking a customer from settling an existing obligation.

4. Settle enough to drop below the limit.

**Expected**: ride requests succeed again.

5. Confirm the aggregate is computed server-side — a client cannot influence it by any request field.

---

## Scenario 10 — Automatic cash resolution _(BD-6)_

With `PAYMENT_CASH_CONFIRMATION_REQUIRED` enabled:

1. Complete a `CASH` ride and let the driver **not** confirm.
2. Advance past `PAYMENT_CASH_CONFIRM_GRACE_SEC` and run the collection sweep.

**Expected**: the ride resolves automatically to `PAID`; the commission is booked against the driver exactly once; the ledger entry description marks the resolution as automatic, so an auditor can distinguish it from a driver confirmation.

3. Run the sweep again, and concurrently have the driver confirm manually.

**Expected**: exactly one `SUCCEEDED` `RidePayment`, one commission entry, one earnings entry. Whichever path wins the conditional claim, the other is a harmless no-op. **This is the assertion BD-6 explicitly requires**: repeated sweeps and events must not create duplicate collection, commission or earnings entries.

4. Verify every precondition is enforced — the sweep must leave untouched: a cancelled ride, a ride still in progress, a non-cash ride, a ride already `PAID`, a ride with a `SUCCEEDED` payment row, and a ride still inside its grace period.

---

## Scenario 11 — History is never rewritten _(BD-7)_

1. Snapshot `payment_ledger_entries` created before `PAYMENT_LEDGER_CUTOVER_AT`.
2. Run every migration, then every sweep job, then the reconciliation job.
3. Re-read the snapshot.

**Expected**: **byte-identical.** No row updated, no row deleted. BD-7 forbids silent mutation of historical financial records, and this is the assertion that proves it.

4. Check the reconciliation report.

**Expected**: live divergence is reported for entries at or after the cut-over; pre-cut-over divergence is reported **separately**, labelled historical and uncorrected — visible for audit, but not raising a live alarm operators would learn to ignore.

---

## Manual smoke against a running server

```bash
npm run dev          # API
npm run worker:dev   # jobs and outbox relay — collection will not happen without this
```

Both are required. Running only `npm run dev` leaves the outbox undrained, so a completed ride sits at `PENDING` forever and looks exactly like the bug this feature fixes.

---

## Done when

- [ ] Scenarios 1–11 pass against a real database
- [ ] RT-1 … RT-4 exist and pass
- [ ] Both cash-flag states tested, including that the confirm endpoint returns `404` when disabled (BD-5)
- [ ] The boundary-value debt test asserts at **exactly** the threshold (BD-2)
- [ ] Duplicate-sweep tests prove no duplicate collection, commission, earnings or write-off (BD-1c, BD-6)
- [ ] The uncollected-ride settlement test asserts driver earnings are **not** reduced (BD-1)
- [ ] The receivable-settlement test asserts earnings are **not** recognised twice (BD-4)
- [ ] Historical ledger rows verified byte-identical after a full run (BD-7)
- [ ] The 15 pre-existing `INCOMPLETE_PROFILE` failures resolved by completing the rider profile in fixtures — never by weakening an assertion
- [ ] No new failure anywhere in the suite
- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck` clean
- [ ] Every money-path invariant in [data-model.md](./data-model.md) §4 asserted directly
