# Business Decisions — APPROVED

**Feature**: `002-payment-fare-settlement` | **Created**: 2026-08-23 | **Approved**: 2026-08-23

> ## ✅ ALL SEVEN DECISIONS APPROVED — NO OPEN BUSINESS DECISIONS REMAIN
>
> This file remains the single source of truth. Other artifacts reference decisions by ID and **must not restate them**.
>
> The approved text below is authoritative and was **not reinterpreted**. Where applying a decision has a consequence the decision did not spell out, that consequence is recorded under _Consequences_ and is a direct reading, never an added policy.

## Index

| ID              | Decision                                             | Approved                                           | Resolves                         |
| --------------- | ---------------------------------------------------- | -------------------------------------------------- | -------------------------------- |
| [BD-1](#bd-1)   | Accounting policy for a permanently uncollected fare | **C — Customer receivable**                        | FR-026, FR-027, FR-039           |
| [BD-1c](#bd-1c) | Write-off policy terminating a receivable            | **Ageing / configurable write-off**                | FR-039, FR-042                   |
| [BD-2](#bd-2)   | Rider debt ceiling and its consequence               | **A — configurable threshold, block new requests** | FR-016                           |
| [BD-3](#bd-3)   | Driver blocking                                      | **A — no driver blocking**                         | FR-022 (closed, not implemented) |
| [BD-4](#bd-4)   | Retry cap and interval                               | **A — bounded and configurable**                   | FR-015                           |
| [BD-5](#bd-5)   | Cash confirmation in V1 and rollout                  | **A — feature-flagged, default OFF**               | FR-019                           |
| [BD-6](#bd-6)   | Driver never confirms cash                           | **B — auto-resolve after grace period**            | FR-019, FR-020, FR-043           |
| [BD-7](#bd-7)   | Historical ledger entries                            | **B — current period only, prospective**           | FR-044                           |

---

<a id="bd-1"></a>

## BD-1 — Accounting policy for a permanently uncollected fare · **APPROVED: Option C — Customer Receivable**

**Approved terms** (verbatim):

- The customer remains responsible for the unpaid final fare.
- The unpaid amount is treated as a customer receivable.
- Do **not** automatically deduct the customer's unpaid amount from driver earnings.
- Do **not** immediately book the unpaid amount as platform bad-debt expense.
- The implementation must keep earnings, revenue, receivable and collection status reconcilable.

**Ledger treatment**

A new account `CUSTOMER_RECEIVABLE` is introduced. When collection attempts are exhausted (state-machine transition 6), one balanced group is posted:

| Account               | Direction | Amount                        |
| --------------------- | --------- | ----------------------------- |
| `CUSTOMER_RECEIVABLE` | DEBIT     | `RideFare.totalFare`          |
| `DRIVER_PAYABLE`      | CREDIT    | `RideFare.driverEarning`      |
| `PLATFORM_COMMISSION` | CREDIT    | `RideFare.platformCommission` |

It balances because `totalFare = driverEarning + platformCommission`, which the fare calculation already guarantees. The driver is made whole and the platform recognises its commission; the unpaid amount sits as an asset, not a loss. **No bad-debt entry is posted here** — that happens only at write-off, per BD-1c.

**Consequences** (direct readings, not added policy):

1. **Driver earnings are recognised regardless of collection outcome.** "Do not deduct from driver earnings" means the settlement query must **not** filter on collection success. `aggregateEarnings` therefore keeps deriving from `ride_fares` and does **not** gain a `ride_payments` join.
2. **A later successful retry must not re-recognise earnings.** Settling a receivable clears the receivable only — see transition 7b in [data-model.md](./data-model.md) §2.3. This is the mechanism BD-4 requires for "settles the existing obligation without creating another obligation".
3. **Reconciliation gains a fourth position.** The receivable balance must reconcile against the set of rides in the unpaid state.

---

<a id="bd-1c"></a>

## BD-1c — Write-off policy · **APPROVED: Ageing / configurable**

**Approved terms** (verbatim):

- The customer receivable remains outstanding until collected or written off.
- The write-off period must be configurable.
- Do **not** hard-code the ageing period.
- When written off, apply the approved accounting treatment as `BAD_DEBT_EXPENSE`.
- The write-off must be idempotent and auditable.
- Do **not** create duplicate write-offs.

**Ledger treatment** — a second new account, `BAD_DEBT_EXPENSE`:

| Account               | Direction | Amount               |
| --------------------- | --------- | -------------------- |
| `BAD_DEBT_EXPENSE`    | DEBIT     | `RideFare.totalFare` |
| `CUSTOMER_RECEIVABLE` | CREDIT    | `RideFare.totalFare` |

**Idempotency and duplicate prevention**: the write-off writes a `RidePayment` row with `status = 'WRITTEN_OFF'`, guarded by a **partial unique index** on `("ride_id") WHERE status = 'WRITTEN_OFF'` — structurally identical to the `SUCCEEDED` guard. A duplicate write-off is impossible at the database level, not merely unlikely.

**Auditability**: the `RidePayment` row records when and for how much; the ledger group records the accounting effect; the outbox event records the transition. Nothing is deleted or mutated.

**Configuration**: `PAYMENT_RECEIVABLE_WRITEOFF_DAYS`, validated through `numericEnv`. No default is compiled in as policy — the operator sets it.

**Consequences** (direct readings):

1. **Write-off closes the obligation.** "Outstanding until collected **or** written off" means a written-off receivable is no longer outstanding. The rider retry endpoint therefore rejects a written-off ride. Recovery of written-off debt is a separate flow and is **not** in V1.
2. **Write-off removes the amount from the BD-2 threshold**, because the threshold measures _outstanding_ debt. **Operational note for the product owner**: a rider who waits out the ageing period is unblocked by the write-off. This is a faithful consequence of the two approved decisions read together, not a defect in either — flagged so it is a known trade-off rather than a surprise.

---

<a id="bd-2"></a>

## BD-2 — Rider debt threshold · **APPROVED: Option A**

**Approved terms** (verbatim):

- Use a configurable maximum outstanding customer debt/receivable threshold.
- When the customer's outstanding debt **reaches or exceeds** the configured threshold, block creation of new ride requests.
- Do **not** block the customer from retrying/settling existing unpaid obligations.
- The server must calculate outstanding debt authoritatively.

**Implementation terms**

- Comparison is `outstanding >= threshold` — _reaches or exceeds_, not "exceeds".
- Outstanding debt = `SUM(RideFare.totalFare)` over that rider's rides in the unpaid receivable state, **excluding written-off rides** (they are no longer outstanding).
- Computed server-side from the database on every check. No client input, no cached figure.
- The guard applies **only** to ride-request creation. `POST /rides/:rideId/payment/retry` and `GET /me/debt` are explicitly exempt — blocking someone from paying you is self-defeating.
- Configuration: `PAYMENT_RIDER_DEBT_LIMIT` via `numericEnv`.
- Requires the `rides(customer_id, payment_status)` index (migration §5.4) so the aggregate is not a sequential scan on the largest table in the system.

---

<a id="bd-3"></a>

## BD-3 — Driver blocking · **APPROVED: Option A — no driver blocking**

**Approved terms** (verbatim):

- A customer's payment failure must **not** block the driver from receiving new rides.
- Do **not** introduce driver blocking based solely on a customer's failed collection.

**Effect**

- **FR-022 is closed as "will not implement".** No guard is added to `StatusService.setOnline`. `PAYMENT_DRIVER_DEBT_LIMIT` stays removed.
- This is consistent with BD-1: since the customer's failure never touches driver earnings, there is no mechanism by which it could reach driver eligibility.
- **Driver commission balance from cash rides is unaffected by this decision.** It arises from the driver holding 100% of a cash fare, not from any customer failure. Tracking and recovery through settlement netting (FR-020, FR-021) remain in V1 exactly as specified.

---

<a id="bd-4"></a>

## BD-4 — Retry policy · **APPROVED: Option A**

**Approved terms** (verbatim):

- Payment retry must be bounded.
- Retry limits/window must be configurable.
- No infinite retry loop.
- After the configured retry window/limit is exhausted, the ride remains an unpaid customer receivable until later collection or ageing write-off.
- Define exactly how a later rider retry settles the existing obligation without creating another obligation.

**How a later retry settles without creating a second obligation**

This is the crux, and it is why transition 7 is split in two:

|                          | Retry **before** exhaustion (7a)                                                                                            | Retry **after** exhaustion (7b)                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Obligation state         | `PENDING`                                                                                                                   | `FAILED` (receivable exists)                                                            |
| Earnings recognised yet? | No                                                                                                                          | Yes — at transition 6                                                                   |
| Ledger group posted      | `GATEWAY_CLEARING`/`CUSTOMER_WALLET` DEBIT fare · `DRIVER_PAYABLE` CREDIT earning · `PLATFORM_COMMISSION` CREDIT commission | `GATEWAY_CLEARING`/`CUSTOMER_WALLET` DEBIT fare · **`CUSTOMER_RECEIVABLE` CREDIT fare** |
| Net effect               | Full recognition                                                                                                            | **Clears the receivable only**                                                          |

**Posting the full group in case 7b would double-count driver earnings and commission.** The split is what prevents a second obligation from being created, and it is asserted by a dedicated test.

**Configuration**: `PAYMENT_COLLECTION_MAX_ATTEMPTS` and `PAYMENT_COLLECTION_RETRY_BASE_SEC`, both via `numericEnv`, both with enforced upper bounds so no configuration can produce an unbounded loop.

---

<a id="bd-5"></a>

## BD-5 — Cash confirmation · **APPROVED: Option A — feature-flagged, default OFF**

**Approved terms** (verbatim):

- Cash collection confirmation is a feature-flagged V1 capability.
- Default the feature flag to **OFF**.
- The rollout must be explicitly controlled by configuration.
- When disabled, **no client should be able to access or execute** the cash-confirmation flow.
- Add configuration validation and tests for **both** enabled and disabled states.

**Implementation terms**

- `PAYMENT_CASH_CONFIRMATION_REQUIRED`, boolean, **default `false`**, validated at boot.
- **Disabled** — behaviour is exactly today's: a cash ride is marked `PAID` at completion. `POST /rides/:rideId/payment/confirm-cash` must be **unreachable**, returning `404`. "No client should be able to access or execute" is stronger than ignoring the call, so the route is not registered when the flag is off rather than registered-and-rejecting.
- **Enabled** — a cash ride completes at `PENDING`; only the assigned driver may confirm; auto-resolution per BD-6 applies.
- **Both states are tested**, including that the endpoint is absent when disabled.

---

<a id="bd-6"></a>

## BD-6 — Automatic cash resolution · **APPROVED: Option B**

**Approved terms** (verbatim):

- Do **not** rely forever on driver manual confirmation.
- Support automatic resolution after a configurable grace period.
- Driver manual confirmation remains available when the feature is enabled.
- If the required confirmation does not occur within the configured grace period, the system applies the defined automatic cash collection resolution.
- The job/transition must be idempotent.
- Repeated sweeps/events must **not** create duplicate collection, commission or earnings entries.
- Document exactly which ride/payment conditions are required before automatic resolution.

**Required conditions — all must hold before automatic resolution**

1. `PAYMENT_CASH_CONFIRMATION_REQUIRED` is enabled (with the flag off the flow does not exist).
2. `ride.status = 'COMPLETED'` — never a cancelled or in-progress ride.
3. `ride.paymentMethod = 'CASH'`.
4. `ride.paymentStatus = 'PENDING'`.
5. No `RidePayment` row for the ride with `status = 'SUCCEEDED'`.
6. `now − ride.completedAt >= PAYMENT_CASH_CONFIRM_GRACE_SEC`.

**Idempotency**: identical to manual confirmation — conditional claim `PENDING → PAID`, plus the partial unique index permitting one `SUCCEEDED` `RidePayment` per ride. A repeated sweep finds the claim taken and does nothing. Collection, commission and earnings entries are therefore posted exactly once, whichever path fires first.

**Auditability**: the ledger entry description and the `RidePayment` row distinguish automatic resolution from driver confirmation, so an auditor can tell which rides a driver actually acknowledged.

**Configuration**: `PAYMENT_CASH_CONFIRM_GRACE_SEC` via `numericEnv`.

---

<a id="bd-7"></a>

## BD-7 — Historical ledger entries · **APPROVED: Option B — current period only**

**Approved terms** (verbatim):

- Do **not** automatically rewrite historical ledger entries.
- Correct the model prospectively from the approved/current period.
- Historical accounting correction is outside this Payment V1 implementation unless explicitly approved separately.
- Preserve auditability.
- Do **not** silently mutate historical financial records.

**Implementation terms**

- No migration, script or job rewrites, deletes or amends any existing `payment_ledger_entries` row. The corrected posting model applies only to entries created on or after the cut-over.
- `PAYMENT_LEDGER_CUTOVER_AT` (ISO-8601 timestamp) marks the boundary. Reconciliation scopes its comparison to entries at or after it, so known-bad historical data does not raise a permanent alarm that operators would learn to ignore.
- Reconciliation reports pre-cut-over divergence separately as _historical, uncorrected_ rather than suppressing it — preserving auditability while keeping the live alarm meaningful.
- Historical restatement, if ever approved, is a separate feature.

---

## Configuration introduced by these decisions

Seven knobs, each mandated by an approved decision — none discretionary. All read through the existing `numericEnv` helper (or its boolean equivalent), which throws on non-finite, non-numeric and out-of-range values at boot.

| Knob                                 | Decision | Notes                                                   |
| ------------------------------------ | -------- | ------------------------------------------------------- |
| `PAYMENT_COLLECTION_MAX_ATTEMPTS`    | BD-4     | Bounded above so no value can produce an unbounded loop |
| `PAYMENT_COLLECTION_RETRY_BASE_SEC`  | BD-4     | Base interval for the decaying schedule                 |
| `PAYMENT_RIDER_DEBT_LIMIT`           | BD-2     | Threshold; comparison is `>=`                           |
| `PAYMENT_CASH_CONFIRMATION_REQUIRED` | BD-5     | Boolean, **default `false`**                            |
| `PAYMENT_CASH_CONFIRM_GRACE_SEC`     | BD-6     | Grace before automatic resolution                       |
| `PAYMENT_RECEIVABLE_WRITEOFF_DAYS`   | BD-1c    | Ageing period; not hard-coded                           |
| `PAYMENT_LEDGER_CUTOVER_AT`          | BD-7     | ISO-8601 timestamp                                      |

## Ledger accounts introduced

| Account               | Decision | Purpose                                               |
| --------------------- | -------- | ----------------------------------------------------- |
| `CUSTOMER_RECEIVABLE` | BD-1     | Unpaid fare owed by a customer — an asset, not a loss |
| `BAD_DEBT_EXPENSE`    | BD-1c    | Recognised only at write-off                          |

Existing accounts (`CUSTOMER_WALLET`, `DRIVER_PAYABLE`, `GATEWAY_CLEARING`, `PLATFORM_COMMISSION`) are unchanged.

## Release coordination (not a business decision)

**`POST /wallet/topup` response shape.** The response is **additive** — every existing field retained, `balance` reporting the current uncredited value — so no client breaks on a missing field. What unavoidably changes is behaviour: `balance` no longer increases in that response, because crediting without a confirmed payment is the defect being fixed. Confirm with the mobile team whether a shipped client asserts an increase.
