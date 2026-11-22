# Phase 2 Risk Review — Razorpay Driver Payments

**Feature**: `005-razorpay-driver-payments` | **Date**: 2026-10-21 | **Status**: review document, no code changed by it | **Production**: NO-GO

This document reviews how the Phase 2 code behaves today (uncommitted working tree), what can go wrong, and what would make each item acceptable. It is written for the Owner, Finance and the engineering reviewers.

It does **not** change spec.md, data-model.md or decisions.md. Where the implementation differs from the spec, or the spec is silent or contradicts itself, the item names the decision needed. Nothing here is approved.

"Verified" means read in code or observed in a test run on 2026-10-21. Test runs used the disposable database `zaroorat_rzp005_test`.

## Risk register

| #   | Issue                                         | Severity                           | Money can move wrongly today?                                                     | Blocking decision                                    | Next bounded task                                                  |
| --- | --------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| R1  | Order mismatch has no hold row                | Medium (latent)                    | No                                                                                | Owner: data-model §3 / spec failure table            | R1-T: owner-routing for mismatches; verify rejects before the gate |
| R2  | Externally refunded payments                  | **High**                           | **Yes**: a late `payment.captured` after a Dashboard refund still credits         | UD-7 (Owner + Finance)                               | R2-T: external-refund detection from refund webhooks and the sweep |
| R3  | Additional captures                           | Low                                | No                                                                                | UD-1 (resolution)                                    | T028 + an extra-capture integration case                           |
| R4  | Malformed signed webhooks                     | Medium                             | No                                                                                | Owner: a new `gateway_events.outcome` value          | T031 (outcome) + T061 (FAILED scan) + T067                         |
| R5  | Historical order-id payment rows              | Medium                             | No (false reviews, blocked backfill)                                              | UD-8 (needs Q4)                                      | R5-T: legacy-row recognition, after Q4                             |
| R6  | Subscription switch OFF with a pending intent | **High** for the subscription wave | **Yes**: an orphaned capture after re-pointing (existing, made easier by Phase 2) | TD-11 already decided; new: purchase while in review | T051/T052 before the subscription switch is ever ON                |
| R7  | Incomplete T019 schema                        | Medium                             | No                                                                                | Approval to migrate the shared dev DB                | T019c with T026/T031/T061                                          |
| R8  | Migration verification gaps                   | Medium                             | No                                                                                | Staging-data access, operator time                   | T004 + T020 staging-copy run                                       |
| R9  | Webhook reliability (T001/T030/T031)          | **High**                           | Indirectly: retries > 5 min are refused, then Razorpay disables the webhook       | AM-1 text approved (UD-3); T001 authorization        | T001 → T030 → T031 → T026                                          |
| R10 | Operational readiness                         | **High** (blocks live money)       | —                                                                                 | G0–G8 sign-offs                                      | Checklist below                                                    |

---

## R1 — Order mismatch: review case without a hold row

**Behavior (verified).**

- The gate decides A5 `ORDER_MISMATCH` when the provider payment's `order_id` differs from the intent's order.
- `holdForReview` then opens a case **without** a `CAPTURED_REVIEW` row (`HOLD_ROW_KINDS` in `intent.service.ts`).
- It moves the intent to `MANUAL_REVIEW` when the intent is in a reviewable status.
- data-model §3 says every review except A6 writes a hold row.

**Where it can occur.**

- Not on reconciliation: `selectOrderPayments` drops items of other orders.
- Not on a normal webhook: the intent is resolved by the payment's own `order_id`.
- It can occur on a webhook whose `order_id` is one of our **intent UUIDs**: `findByGatewayReference` falls back to the intent id. Real Razorpay never sends that; only a hand-built payload signed with our secret can.
- It will occur on the future `verify` route (T043) if a callback's fetched payment belongs to another order.
- spec.md contradicts itself here:
  - The rules table says A5 → review.
  - The verification failure table says verify → `400 PAYMENT_ORDER_MISMATCH`, **no state change**.

**Risks.**

- **Blocking**: a hold row on the wrong intent would occupy INV-2's unique index (`payment_transactions_provider_payment_key`). The owning intent's real application of that payment would then fail with a unique violation, and its webhook would 5xx in a loop.
- **Driver lock-out (current code)**: the claiming intent moves to `MANUAL_REVIEW`. That intent's own later, legitimate capture is then held as `MULTIPLE_CAPTURES` instead of applied. Through `verify`, a crafted callback could push a driver's intent into review.

**Proposed safe behavior (needs Owner decision; spec unchanged).**

1. Resolve ownership by the payment's own `order_id` before deciding: `findByGatewayIntentId(payment.orderId)`.
2. If one of our intents owns that order, evaluate the payment against **that** intent under **its** lock. The claiming intent is untouched.
3. If no intent owns it, the payment is an `UNKNOWN_ORDER` (A9): case only, no intent.
4. On `verify`, a fetched payment for another order is rejected before the gate (A1 class, no state change, security metric), as the failure table says.
5. Remove the intent-UUID fallback from the Razorpay webhook resolution. Keep it for Stripe only if it is needed there.

**Acceptance criteria.**

- No `CAPTURED_REVIEW` row is ever written on an intent that does not own the payment's order.
- No intent changes status because of another order's payment.
- Every captured payment of ours is applied to its owning intent or tracked in exactly one OPEN case (INV-7).
- If the data-model text changes, INV-7's "held" state accepts an OPEN `UNKNOWN_ORDER` case without a hold row.

**Tests required.**

- A signed webhook with a UUID `order_id` → no state change on that intent; an `UNKNOWN_ORDER` case.
- A `verify` callback whose payment is for order B, made by the owner of order A → 400, A unchanged, B's payment applied to B by reconciliation.
- The owning intent applies the payment once even after a mismatch was seen elsewhere.

**Dependencies.** Owner decision on data-model §3 and the spec failure table; T043 must not ship before this.

**Next bounded task.** R1-T: "Route a mismatched payment to its owning intent; reject on verify; drop the Razorpay UUID fallback". Backend only, 3 files, tests above.

## R2 — Externally refunded payments

**Behavior (verified).**

- Provider status `refunded` → A10.
- If a Zaroorat refund (`refunds.provider_payment_id`, PROCESSING or SUCCEEDED) explains it → no-op. Otherwise an `EXTERNAL_REFUND` case with no hold row and no status change.
- An authorization auto-refunded at capture timeout (`refunded`, `captured: false`) is read as `failed`. Both the adapter and the webhook parser do this.
- Only reconciliation can see `refunded` today, and only for PENDING/PROCESSING intents. `confirmIntent` returns early for SUCCEEDED intents.
- `refund.processed` / `refund.failed` webhooks are stored and marked processed with no effect.

**Risks.**

- **Snapshot credit (high).** Razorpay retries `payment.captured` with the payload as it was at event time. Suppose staff refund the payment in the Dashboard before our webhook succeeds, for example during the R9 rejection window. The retry still says `captured`, and A4 credits the wallet or activates the subscription for money already returned. Nothing detects this today.
- **Noise.** An `EXTERNAL_REFUND` on a PENDING intent is re-evaluated every 10 minutes. The case is deduplicated, but an audit line is written each run until T062 (EXPIRED, needs D-3) stops it.
- **Reversal.** The existing `endForRefund` consumer ends a subscription only for our own refund events. Any automatic reversal of a wallet credit is a Finance decision (UD-7), and it interacts with D-2 (no negative balance).

**Proposed safe path (UD-7 decides the resolution).**

1. **Detect**, do not reverse:
   - Process `refund.processed` / `refund.created`. A refund with no matching `Refund` row (by `gateway_refund_id`, receipt or `notes.refund_reference`) opens an `EXTERNAL_REFUND` case on the payment's intent.
   - The provider sweep (T067) also classifies any payment with `amount_refunded > 0` that our records do not explain.
2. **Never** credit, activate, debit or end a subscription automatically on an external refund. Finance resolves the case under UD-7.
3. Recommend that UD-7 forbids Dashboard refunds operationally (runbook, T103), with detection as the safety net.

**Acceptance criteria.**

- An external refund before or after application never results in a credit or activation that stays unflagged. Every external refund has exactly one OPEN case within one sweep interval.
- No automatic reversal exists without a UD-7 decision.

**Tests required.**

- A refund webhook with an unknown refund id on a SUCCEEDED intent → one case, wallet unchanged.
- The same after redelivery → still one case.
- A capture webhook delivered after a recorded external refund → held for review, not applied. This needs the refund to be known first, so it is a sequencing test.
- Sweep: `amount_refunded > 0` with no Refund row → case.

**Dependencies.** UD-7 (Owner + Finance); T067 for the sweep; T031 for refund-event outcomes.

**Next bounded task.** R2-T: "External-refund detection from refund webhooks" (backend, case only, no reversal). Then T066/T067.

## R3 — Additional captures

**Behavior (verified).**

- Each extra captured payment for an intent that already succeeded is A7 `MULTIPLE_CAPTURES`. It gets its own `CAPTURED_REVIEW` row (unique per provider payment) and its own case (unique per kind and payment).
- A redelivery sees the payment held on this intent → A11 no-op. Covered by T022's redelivery and `order.paid` case and by a unit case.
- Reconciliation applies the first capture and then runs every other capture through the gate in the same transaction.

**Risks.**

- **Detection gap**: reconciliation skips SUCCEEDED intents, so a capture after success is found only by its webhook or by the sweep (T067, not built). Razorpay rejects a second payment on a paid order when `partial_payment` is false (S3b). The late-authorization case could not be tested in sandbox (U5).
- **Concurrency**: two workers on the same payment are serialized by the intent row lock, and the anchor indexes back that up. The T028 concurrency test is **not** written.
- **Event dedupe race**: event deduplication is still check-then-insert (T031). Two simultaneous deliveries of one event make one answer 5xx. Razorpay retries it, so this is availability, not money.

**Acceptance criteria.**

- Each distinct `pay_…` id has exactly one record: applied, or held with one case.
- N repeated or concurrent deliveries give one effect and one case.
- An extra capture after success is tracked within one sweep interval.

**Tests required.**

- T028 (10 concurrent mixed paths; plus a duplicate SUCCEEDED row that rolls back the whole transaction).
- Integration: two extra captures → two hold rows and two cases.
- Reconciliation with `[capture, capture]` on a PENDING intent → one applied, one held.

**Dependencies.** UD-1 for how the cases are resolved (A7 can only be REFUND under the one-success index).

**Next bounded task.** T028, plus a small extra-capture test addition. Tests only, no logic change expected.

## R4 — Malformed signed webhooks

**Behavior (verified).**

- If the payment entity lacks a well-formed `amount` (non-negative integer), `currency` (3 letters), `status`, `id` or `order_id`, or an `order.paid` lacks a well-formed `amount_paid`, the parser returns no payment.
- The service then applies nothing and opens no case. It logs a warning and emits `payment_webhook_failure_total{reason="unusable_payment"}`.
- It still marks the event `processed = true`.
- The raw payload is kept in `gateway_events.payload` (UD-10 governs this later).

**Durability today.**

- The event row and payload are durable.
- The **reason** is not: there is no `outcome` column yet (deferred, R7). In the database, the row looks like a normally processed event; only logs and the metric show the difference.
- Razorpay will not retry it.

**Recovery today.**

- A PENDING/PROCESSING intent is re-checked by `PaymentIntentReconciliationJob` (every 10 min, intents untouched for 15 min, batch 100). It asks Razorpay directly and runs the gate. T022 verifies that the intent stays PENDING, so it is eligible; **no test yet shows the job settling it** (T060).
- Gaps:
  1. FAILED intents are not scanned (T061 adds them).
  2. There is no rotation: with more than 100 stale intents, the same 100 are re-read every run (TD-13, needs `last_reconciled_at`).
  3. An unknown order is never recovered until the sweep exists (T067).
  4. The job runs only in the worker process.

**Proposed behavior (needs Owner decision on the outcome value; spec unchanged).**

- Record a terminal outcome such as `UNUSABLE_PAYLOAD` (data-model §4 has no fitting value) with `processed = true` and a sanitized reason.
- Alert on it.
- Rely on provider truth (T061 including FAILED, plus T067) to settle the money.
- Do **not** answer 5xx: a malformed payload repeats on every retry and would get the webhook disabled.

**Acceptance criteria.**

- Every unusable signed event is queryable by outcome.
- Its payment is applied or held from provider truth within one reconciliation or sweep interval, whatever the intent status.
- No financial effect ever comes from a payload the gate cannot read.

**Tests required.**

- Already: 24 unit cases (missing, malformed, mismatched) and 3 integration cases (missing amount, string amount, missing currency → no effect, no case).
- Still needed:
  - outcome stored;
  - a FAILED intent with an unusable webhook settled by T061;
  - an unknown-order unusable webhook found by T067.

**Dependencies.** R7 columns; T031; T061; T067.

**Next bounded task.** Part of T031 (outcome values), once T001 is authorized.

## R5 — Historical rows that store an order id as the payment id (UD-8)

**Behavior (verified).**

- Before T016, `IntentService.confirmIntent` stored the gateway's `gatewayIntentId` (the order id) as `gatewayTxnId` (F-01). For Razorpay that is `order_…`; for the mock it is `mock_pi_…`.
- The gate compares the stored SUCCEEDED `gatewayTxnId` with the incoming `pay_…` id (A11). For those rows the comparison never matches.
- So a capture webhook for such an intent is treated as a second capture: A7, `CAPTURED_REVIEW` row and case.
- This happens when the webhook arrives after the poll settled the intent, for example a Razorpay retry within 24 hours of deployment.

**Risks.**

- False `MULTIPLE_CAPTURES` cases. No money moves, but they mislead Finance.
- **Backfill blocked**: the hold row now owns the `pay_…` id under INV-2's unique index, so a later UD-8 backfill that writes `pay_…` into the SUCCEEDED row would violate that index.
- Size unknown until Q4 runs (T004).

**Proposed backward-compatible recognition (needs UD-8).**

1. Treat a SUCCEEDED row whose `gatewayTxnId` equals the intent's own order id (or, for Razorpay, does not start with `pay_`) as **legacy: payment id unknown**.
2. **Webhook path** (no provider calls allowed): a capture for a legacy-row intent is a no-op tagged `LEGACY_UNVERIFIED`. Write no hold row, and flag the intent for reconciliation.
3. **Reconciliation/backfill path**: ask `GET /orders/{id}/payments`.
   - Exactly one capture matching amount and currency → it **is** the applied payment. Record its `pay_…` id on the legacy row (UD-8 option a, approved backfill only); A11 from then on.
   - More than one capture → the extras go to review. Finance resolves which one was applied if amounts are equal.
4. Never run the backfill while a `CAPTURED_REVIEW` row exists for the same `pay_…` id: resolve that case first.

**Acceptance criteria.**

- No false review for a legacy row with a single capture.
- Every legacy row ends with a `pay_…` id or an explicit Finance case.
- The backfill never violates INV-2.

**Tests required.**

- Legacy row + one capture webhook → no case.
- Legacy row + reconciliation → `pay_…` recorded.
- Legacy row + two captures → one case.
- Backfill with an existing hold row → refused.

**Dependencies.** T004 Q4 on each environment; UD-8 (Finance + Engineering).

**Next bounded task.** R5-T: legacy-row recognition (gate input plus a reconciliation step), only if Q4 > 0. Otherwise close UD-8 as "not needed".

## R6 — Subscription switch OFF while a driver has a pending subscription intent

**Behavior (verified, `subscription.service.ts`, `intent.service.ts`).**

1. `purchase` checks the switch **before** looking for the pending subscription. With the switch OFF, a retry gets `503 PAYMENTS_UNAVAILABLE`, even to re-read an existing PENDING intent. Staging a plan change while ACTIVE is not gated.
2. Confirmation is never gated (T035 by design). If the driver's checkout was already open, the existing Razorpay order is still payable. Its capture is applied by webhook or reconciliation and the subscription activates. **OFF means "no new orders", not "no money".**
3. While OFF, nothing expires the PENDING_PAYMENT subscription or its intent: T062 needs D-3; `SubscriptionReconciliationJob` is not scheduled (G-04, T054).
4. When ON again, `REUSE` returns the old PENDING intent without comparing plans. A driver who now picks another plan is handed the old plan's intent and price.
5. **Phase 2 interaction.**
   - If the pending intent is FAILED, EXPIRED or now **MANUAL_REVIEW**, `purchase` takes `ATTACH_NEW_INTENT`. It creates a new intent and re-points `driver_subscriptions.payment_intent_id`.
   - The old intent is **not** cancelled: TD-11 supersession (T052) is not built.
   - A late capture on the old order is still applied (FAILED → SUCCEEDED is A4). It posts subscription revenue and emits `driver.subscription.payment.completed`.
   - The consumer looks the subscription up by the **old** intent id, finds none, and throws. The outbox retries the event until it is dead-lettered (`FAILED`; data-model §11, T064 requeue).
   - Result: money captured, revenue booked, **no activation and no review case**. It is visible only as a dead-lettered outbox event (Q7) and through Q6.
   - For a MANUAL_REVIEW intent, the driver can also pay a second time while the first payment is held.

**Impact.** A driver can pay without getting the plan, or pay twice. Revenue is recognized for an unentitled payment. All of this is behind `payments.subscription_checkout` (OFF everywhere).

**Required before the subscription switch is ever ON.**

- **T051/T052** (TD-11): locked supersession to CANCELLED. A late capture on a CANCELLED intent is then A8 `UNMATCHED_CAPTURE` → review, never silent revenue.
- **T053/T054**: schedule subscription recovery.
- **New Owner decision**: refuse `purchase` (for example `409 PAYMENT_UNDER_REVIEW`) while the pending intent is MANUAL_REVIEW, or allow a second payment knowingly.
- Decide whether `REUSE` must compare plans.
- Decide whether a 503 while OFF should still return an existing PENDING intent so the app can show its status. T043's status route may cover this.

**Tests required.**

- T051, including the supersession race.
- A late capture on a superseded intent → A8 case, no revenue.
- Purchase while the intent is in review → refused, or the chosen behavior.
- Switch OFF + open checkout + capture → activation, recorded as intended.

**Next bounded task.** T051 → T052 (the `[SUB]` wave), with the review-blocking decision recorded first.

## R7 — Incomplete schema (T019 deferred columns)

| Deferred column                      | Needed by                                                | Why deferred                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_intents.last_reconciled_at` | T061 (rotation, TD-13), T060 test                        | A Prisma model field breaks every `payment_intents` query on an unmigrated DB (the shared dev DB used by the running :8000 server, and `zaroorat_test`) |
| `gateway_events.outcome`             | T031 (outcomes), T026 (`PROCESSING_FAILED`/`PARKED`), R4 | same, for `gateway_events`                                                                                                                              |
| `gateway_events.processing_attempts` | T026 (atomic counter, parking)                           | same                                                                                                                                                    |
| `gateway_events.last_error`          | T026 (sanitized error)                                   | same                                                                                                                                                    |
| `gateway_events.last_attempt_at`     | T026                                                     | same                                                                                                                                                    |

Also not in T020: `CHECK (balance >= 0)` (D-2 → T020b).

`payment_reconciliation_runs` exists but nothing writes it yet (T038, T061, T067).

**Next bounded task.** T019c: one forward-only migration adding the five nullable columns, plus the Prisma fields. Its prerequisite is approval to migrate the shared dev DB and `zaroorat_test` (both T020 and T019c), so the regenerated client does not break other teams. Bundle T019c with the first task that reads the columns (T026/T031 or T061).

## R8 — Migration verification: run vs blocked

| Check                                                                     | State                | Evidence or reason                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Applies to a clean clone of `zaroorat_test` (74 → 75)                     | **Run**              | `prisma migrate deploy` on `zaroorat_rzp005_test`; `zaroorat_test` still at 74                                                                                                                                                               |
| Schema ↔ database diff for the new objects                                | **Run**              | `prisma migrate diff` shows no drift for `payment_review_cases`/`payment_reconciliation_runs` after setting `onDelete: Restrict`. The partial indexes are outside Prisma's model. Pre-existing drift in other tables is not this migration's |
| Triggers present and `ENABLE ALWAYS`                                      | **Run**              | `pg_trigger.tgenabled = 'A'` for all four                                                                                                                                                                                                    |
| Four partial unique indexes + review-case unique built                    | **Run**              | `pg_indexes`                                                                                                                                                                                                                                 |
| REVOKE effective for `zaroorat_app_runtime`                               | **Run (clone only)** | Role exists on the clone; `has_table_privilege`: ledger UPDATE false, wallet-txn DELETE false, INSERT true, review-case INSERT true. Tests and dev connect as `zaroorat` (owner), so only the triggers bind them                             |
| Harness reset with the escape setting                                     | **Run**              | Integration suites reset cleanly on the migrated clone                                                                                                                                                                                       |
| Pre-checks Q1, Q3, Q4, Q9                                                 | **Run, but vacuous** | All 0 on the clone, which had **0** payment rows. That proves the SQL runs, not that real data is clean                                                                                                                                      |
| Q2, Q5–Q8, Q10, Q11                                                       | **Not run**          | T004 (operator), needs dev/staging/prod access                                                                                                                                                                                               |
| T004 on dev, staging, production                                          | **Blocked**          | Not authorized; the operator task                                                                                                                                                                                                            |
| Applies on a copy of staging data (T020 done-when)                        | **Blocked**          | No staging data available                                                                                                                                                                                                                    |
| Previous app version's suite against the migrated schema (T020 done-when) | **Not run**          | Not blocked by staging: runnable locally with a HEAD worktree against a migrated clone; needs authorization                                                                                                                                  |
| `CONCURRENTLY` build timing on large tables                               | **Blocked**          | Needs production-sized data (T004 Q11 sizing)                                                                                                                                                                                                |
| T018 constraint test (TM-05)                                              | **Not run**          | Not authorized                                                                                                                                                                                                                               |
| Shared dev DB / `zaroorat_test` migrated                                  | **Not done**         | Needs separate approval                                                                                                                                                                                                                      |

## R9 — Webhook reliability (stays open: T001, T030, T031; plus T026, T033)

**Behavior today (verified).**

- The freshness window is `PAYMENT_WEBHOOK_TOLERANCE_SEC`, default **300 s**, capped at 3,600 s. It is checked before deduplication.
- A Razorpay retry more than 5 minutes after the event gets `400 WEBHOOK_REPLAY_REJECTED`. Razorpay retries for 24 hours and then **disables the webhook** (contract).
- On a processing error the event row rolls back (T026 not built).
- Deduplication is check-then-insert (T031).
- The Phase 2 parser change reads only `amount`, `currency`, `status` and `amount_paid`. It does **not** implement the D-1/AM-1 freshness policy.

**Status.** T001 (AM-1 into the constitution, needs its own authorization), T030 (tests), T031, T026 and T033 all remain **open**. UD-3 approved the policy text only.

**Next bounded sequence.** T001 → T030 (tests first) → T031 (+ R4 outcome, R7 columns) → T026 → T033.

## R10 — Operational readiness checklist (unchanged; none of it is met)

- [ ] Pilot allowlist enforced (T037). Today `pilot_mode` is ON with an empty, **unenforced** allowlist. No pilot traffic until T037 is verified.
- [ ] Review operations: resolution service and admin routes (T080–T082, needs UD-1, UD-2 with refund legs, D-4, D-6, UD-7); admin review pages (T093); 24-hour open-case alert (T083).
- [ ] Refund operations: amount lock (T084), `X-Refund-Idempotency` incl. the observed 409 (T085), tests (T086), unknown outcomes (T087).
- [ ] Recovery: T038 job heartbeats, T060/T061, T062 (D-3), T066/T067 sweep, T068 daily INV-7 report, T054 subscription recovery scheduling.
- [ ] Alerting and observability: T034, T099 (rules outside the repository), metrics added in Phase 2 (`payment_amount_mismatch_total{kind}`, `payment_webhook_failure_total{reason="unusable_payment"}`) wired to alerts.
- [ ] Owner configuration: T002 (test webhook to staging), the D-3 dashboard auto-capture timeout confirmed in test **and** live, T008 questions to Razorpay.
- [ ] Data checks: T004 Q1–Q11 on every environment.
- [ ] Security: T102 review; T098 permission regression.
- [ ] Release gates: G0–G8 (plus G3-S/G4-S/G6-S/G8-S for subscriptions) signed in plan.md; T100 quickstart re-run, T101 load test, T104 seven-day staging soak, then T105.
- [ ] Switches: `payments.driver_checkout` and `payments.subscription_checkout` stay OFF in every real environment until the gates above are signed.

## Proposed sequence for the next phase (for approval; nothing started)

1. **Decisions (no code).**
   - Owner: R1 spec text (data-model §3, verify failure table).
   - Owner: R4 outcome value.
   - Owner: R6 purchase-while-in-review rule and REUSE plan check.
   - Owner: TD-3 replacement.
   - Owner: confirm D-3 in the dashboard.
   - Owner + Finance: UD-7 (R2).
   - Finance: UD-1, UD-2 (with refund legs), D-2, D-4, D-6.
   - Operator: T004 (Q4 decides whether UD-8/R5 is needed).
2. **Environment approval.** Migrate the shared dev DB and `zaroorat_test` with `20261021120000`. Only then T019c.
3. **Backend safety, no new money paths.**
   - T018 + T021 done-when;
   - T019c;
   - T001 → T030 → T031 → T026;
   - T028; T025; T032;
   - R1-T; R5-T (if Q4 > 0); R2-T.
4. **Recovery.** T038 → T060/T061 → T062 (after D-3) → T066/T067 → T068.
5. **Review and refunds.** T080–T083 → T084–T087 → T093/T094.
6. **Subscription wave** before its switch: T051–T056 (R6).
7. **Client and operations.**
   - T005 → T042/T043 (verify rejects order mismatch before the gate, R1) → T044–T050;
   - T037; T034/T099; T102; T103;
   - T100/T101/T104 → gates G0–G8 → T105.
