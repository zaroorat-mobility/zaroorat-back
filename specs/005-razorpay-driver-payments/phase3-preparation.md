# Phase 3 Preparation — Decisions, Data Checks, Migration Readiness

**Feature**: `005-razorpay-driver-payments` | **Date**: 2026-10-21 | **Authorized scope**: decision documentation, read-only data verification, preparation | **Production**: NO-GO

This document prepares the next implementation phase. **It approves nothing.**

- Every decision below stays open until its named decision-maker approves it in writing in decisions.md (task T007).
- An Engineering recommendation is not an approval.
- The current risk register is [phase2-risk-review.md](./phase2-risk-review.md) (R1–R10).
- spec.md, data-model.md and decisions.md are **unchanged**. New decision candidates (R1, R4, R6) are proposed here, not added to decisions.md.

Contents:

1. Decision register
2. T004 read-only data checks, by environment
3. Migration readiness (T020 and the deferred T019 columns)
4. Task dependency sequence, validated against tasks.md

---

## 1. Decision register

Status words:

- **Open**: nobody has decided.
- **Owner-approved · Finance pending**: the Owner said yes on 2026-10-19 and Finance has not confirmed.
- **Proposed**: new in this document.

### Summary

| ID   | Question (short)                                                      | Status                                                       | Decision-maker                     | Recommendation                                                                        | Blocks                                               |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| R1   | Order mismatch: hold row vs. "no state change" on verify              | Proposed                                                     | Owner                              | Route to the owning intent; verify rejects before the gate; claiming intent unchanged | R1-T, T043                                           |
| R4   | Outcome for a signed webhook the gate cannot read                     | Proposed                                                     | Owner                              | New terminal outcome `UNUSABLE_PAYLOAD` + alert                                       | T031                                                 |
| R6a  | Purchase while the pending subscription intent is in review           | Proposed                                                     | Owner                              | Refuse with `409 PAYMENT_UNDER_REVIEW`                                                | T052                                                 |
| R6b  | Reuse of a pending subscription intent for another plan               | Proposed (applies TD-11)                                     | Owner                              | Reuse only for the same plan; otherwise locked supersession                           | T051, T052                                           |
| R6c  | Status of an existing intent while the switch is OFF                  | Proposed                                                     | Owner                              | Keep 503 on purchase; the T043 status route shows the intent                          | T043                                                 |
| UD-7 | Dashboard refunds and `EXTERNAL_REFUND` case closure                  | Open                                                         | Owner + Finance                    | (a) prohibit + detect + Finance correction rule                                       | T081 (EXTERNAL_REFUND), T103, R2-T (resolution only) |
| UD-1 | How Finance resolves held payments, incl. additional captures         | Open                                                         | Finance + Owner                    | (a), plus a per-kind resolution table                                                 | T081, T082                                           |
| UD-2 | Ledger treatment of held money and its refund legs                    | Open                                                         | Finance / auditor                  | (a) `PAYMENT_SUSPENSE`                                                                | T024 suspense posting, T081                          |
| TD-3 | Replacement for receipt-based order recovery                          | Open for Owner review                                        | Owner (engineering-owned decision) | (a) accept orphan unpaid orders; idempotency-key lookup before the call               | — (no money risk)                                    |
| D-3  | 5-day recheck, then EXPIRED; plus the dashboard 3-day capture timeout | Owner-approved · Finance pending; dashboard evidence missing | Finance; Owner (evidence)          | Keep as approved; record the dashboard evidence                                       | T062                                                 |
| D-2  | Commission-wallet balance floor (`CHECK balance >= 0`)                | Owner-approved · Finance pending                             | Finance                            | Keep                                                                                  | T020b                                                |
| D-4  | Mismatches to review; Finance resolves within 24 h; CREDIT or REFUND  | Owner-approved · Finance pending                             | Finance                            | Keep, extended by UD-1's table                                                        | T081, T082                                           |
| D-6  | Unmatched subscription capture → case; refund only via Finance        | Owner-approved · Finance pending (refund part)               | Finance                            | Keep                                                                                  | refund part of T081                                  |
| D-7  | Refund amount immutable once reserved                                 | Owner-approved · Finance pending                             | Finance                            | Keep for explicit review                                                              | T084                                                 |
| D-11 | Ledger posting idempotency key deferred; anchor rows instead          | Owner-approved · Finance pending                             | Finance                            | Keep for explicit review                                                              | — (non-blocking)                                     |
| UD-8 | Repair of historical order-id payment rows                            | Open, conditional on Q4                                      | Finance + Engineering              | Decide after staging/production Q4                                                    | R5-T                                                 |

---

### R1 — Order mismatch: hold row, or no state change?

- **Exact question.**
  - data-model.md §3 says every review except A6 writes a `CAPTURED_REVIEW` hold row on the intent.
  - spec.md's verification failure table says a `verify` whose fetched payment belongs to another order is answered `400 PAYMENT_ORDER_MISMATCH` with **no state change**.
  - Which rule governs, and what happens to the claiming intent?
- **Options.**
  - (a) data-model §3 as written: hold row and `MANUAL_REVIEW` on the claiming intent.
  - (b) **Owner-routing**: evaluate the payment only against the intent that owns its `order_id`. If none of ours does, it is A9 `UNKNOWN_ORDER` (case, no intent). The claiming intent never changes. `verify` rejects before the gate.
  - (c) Case only, no hold row, and the claiming intent unchanged.
- **Consequences.**
  - (a) A hold on the wrong intent occupies INV-2's unique index and blocks the owner's real application (unique violation, webhook 5xx loop). The claiming intent's own payment is then held, not applied.
  - (b) No blocking and no lock-out. Needs an intent lookup by `payment.order_id`, and the Razorpay webhook's intent-UUID fallback removed.
  - (c) No blocking, but the money is tracked only by the case. The owner's payment waits for reconciliation instead of being applied now.
- **Recommendation.** (b). The spec's failure table wins for `verify`.
- **Current code.** The case opens without a hold row (as in (c)), but the claiming intent **does** move to `MANUAL_REVIEW`. That is the lock-out (b) removes.
- **Decision-maker.** Owner.
- **Dependencies.** None to decide. R1-T must land before T043.
- **If left open.** Latent: with real Razorpay data the webhook and reconciliation paths cannot produce an order mismatch. It becomes live when `verify` (T043) ships, or if anyone with the webhook secret posts an intent UUID as `order_id`. T043 must not start while R1 is open.

### R4 — Outcome for a signed webhook whose payment fields cannot be read

- **Exact question.** A signed webhook may lack a well-formed `amount`, `currency`, `status`, `id`, `order_id`, or `amount_paid` on `order.paid`. What terminal outcome is recorded, and is it retried? data-model §4 lists `APPLIED, STALE_IGNORED, TOO_OLD, MISMATCH, UNKNOWN_ORDER, NO_ACTION, PARKED, PROCESSING_FAILED`, and none fits.
- **Options.**
  - (a) New terminal outcome `UNUSABLE_PAYLOAD` (`processed = true`), sanitized reason, alert, settled from provider truth.
  - (b) Reuse `MISMATCH`.
  - (c) `PROCESSING_FAILED` (5xx, Razorpay retries).
  - (d) `NO_ACTION`.
- **Consequences.**
  - (a) Queryable and alertable. Money settled by T061/T067.
  - (b) Confuses data errors with amount mismatches. `MISMATCH` implies a gate decision that never ran.
  - (c) The same malformed payload repeats on every retry, parks after N attempts, and risks Razorpay disabling the webhook after 24 h.
  - (d) Hides a provider or integration defect.
- **Recommendation.** (a).
- **Decision-maker.** Owner (data-model text).
- **Dependencies.** The `gateway_events.outcome` column (deferred T019 column → T019c); T031.
- **If left open.** Today such events are stored with `processed = true` and no outcome. Only logs and `payment_webhook_failure_total{reason="unusable_payment"}` show them. PENDING intents are recovered by reconciliation; FAILED intents and unknown orders are **not** recovered until T061/T067.

### R6 — Subscription purchase safeguards

**R6a — Purchase while the pending subscription intent is in review**

- **Exact question.** Today a pending subscription whose intent is `MANUAL_REVIEW` (or FAILED/EXPIRED) takes `ATTACH_NEW_INTENT`: a new intent, and the subscription re-pointed. May a driver start a new payment while an earlier one is held for review?
- **Options.**
  - (a) Refuse with `409 PAYMENT_UNDER_REVIEW` until Finance resolves.
  - (b) Allow (today's behavior).
  - (c) Allow with a warning in the app.
- **Consequences.**
  - (a) No double payment. The driver waits for Finance (D-4: 24 h target).
  - (b) Double payment possible. The held payment's later CREDIT has no subscription to activate once re-pointed.
  - (c) Same as (b), with fewer surprises.
- **Recommendation.** (a).
- **Decision-maker.** Owner.
- **Dependencies.** D-4 (resolution time), UD-1.

**R6b — Reusing a pending intent for another plan**

- **Exact question.** `REUSE` returns the pending intent without comparing plans. Should a plan change while unpaid reuse it?
- **Options.**
  - (a) Reuse only when the plan matches. Otherwise apply TD-11: locked supersession of the old intent to `CANCELLED`, then a new intent. A late capture on the cancelled intent is A8 `UNMATCHED_CAPTURE` (D-6).
  - (b) Always reuse.
  - (c) Refuse plan changes while unpaid.
- **Consequences.**
  - (a) Correct price and plan. Late old-order captures are held, not orphaned.
  - (b) The driver pays the old plan's price for the plan they now want.
  - (c) Simple, but the driver cannot switch.
- **Recommendation.** (a). TD-11 is already an engineering decision; this applies it to `REUSE`.
- **Decision-maker.** Owner.
- **Dependencies.** T051 → T052.

**R6c — An existing intent while the switch is OFF**

- **Exact question.** With `payments.subscription_checkout` OFF, `purchase` answers 503 even when it would only re-read an existing PENDING intent. Captures on already-open orders are still applied (T035 by design). Should the app be able to see that intent?
- **Options.**
  - (a) Keep the 503 on purchase; the read-only `GET /payments/intents/:id` (T043) shows status.
  - (b) Return the existing intent from purchase while OFF.
- **Recommendation.** (a): no payment-starting path opens while OFF.
- **Decision-maker.** Owner.

**R6 together.** The old-order orphan (money captured, revenue booked, no activation, event dead-lettered) is fixed by T052. All of R6 is behind `payments.subscription_checkout` (OFF everywhere), and **that switch must not be turned on before T051–T056**.

### UD-7 — Dashboard refunds and the external-refund review workflow

- **Exact question (decisions.md, unchanged).** May staff refund from the Razorpay Dashboard, bypassing Zaroorat? And when such a refund is detected (`EXTERNAL_REFUND`), how is the case resolved?
- **Options (decisions.md).**
  - (a) Prohibit by policy and detect.
  - (b) Allow and import automatically.
- **Recommendation (decisions.md).** (a), plus a Finance-approved correction rule.

**Proposed workflow for Finance to approve or amend:**

| Stage      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Needs                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1. Prevent | Runbook (T103) forbids Dashboard refunds; Dashboard refund rights restricted to named Finance staff                                                                                                                                                                                                                                                                                                                                                                                                           | UD-7 (a)                                 |
| 2. Detect  | (i) A `refund.processed`/`refund.created` webhook whose refund matches no `refunds` row (by `gateway_refund_id`, receipt or `notes.refund_reference`) opens a case. (ii) The sweep (T067) flags `amount_refunded > 0` that our records do not explain. (iii) **Refund-aware capture**: before applying a capture, if a refund event for the same `pay_…` is already stored, hold the capture as `EXTERNAL_REFUND` instead of applying it. This is a database-only check, so it is allowed in the webhook path | R2-T; T031 (refund-event outcomes); T067 |
| 3. Triage  | Finance looks at what the payment paid for: nothing (never applied), a wallet credit, or a subscription period                                                                                                                                                                                                                                                                                                                                                                                                | T082 (case view)                         |
| 4. Resolve | **Not applied** → `RESOLVED_NO_ACTION` and the intent to `CANCELLED`. **Wallet credited** → one of: debit up to the available balance (D-2 forbids going below ₹0); record the remainder for collection; or write it off with approval. **Subscription active** → end the entitlement now, or let the paid period run. Every choice is Finance's; **no automatic reversal**                                                                                                                                   | UD-7 correction rule; D-2; UD-6          |
| 5. Close   | Conditional claim (`claimResolution`, OPEN → RESOLVED_*), with `resolved_by`, note and time; second approver per UD-6; audit row                                                                                                                                                                                                                                                                                                                                                                              | T081, UD-6                               |
| 6. Report  | Daily INV-7 report counts detected, open and closed external refunds; alert if open > 24 h                                                                                                                                                                                                                                                                                                                                                                                                                    | T068, T083                               |

- **Decision-maker.** Owner + Finance.
- **If left open.** `EXTERNAL_REFUND` cases stay OPEN and are escalated. **Today nothing detects a Dashboard refund made before a late `payment.captured` retry**, so that retry credits a wallet or activates a plan for returned money (R2, high). Detection (stage 2) can be built under either option; the resolution (stage 4) cannot.

### UD-1 — How Finance resolves held payments, including additional captures

- **Exact question (decisions.md).** When Razorpay captured an amount or currency different from the intent, may Finance CREDIT it, and for how much?
- **Options (decisions.md).**
  - (a) CREDIT only when captured ≥ intent amount in INR; credit exactly the intent amount and refund the excess. Otherwise REFUND the full captured amount.
  - (b) REFUND only.
  - (c) Credit the captured amount, whatever it is.
- **Recommendation (decisions.md).** (a).

**Additional facts for Finance (Phase 2):**

- `MULTIPLE_CAPTURES` (A7: a second payment on an intent that already succeeded) can only be **REFUND**. The one-success-per-intent index makes CREDIT to the same intent impossible. Crediting it as a new recharge would need a new intent, which is a new policy and is not assumed.
- Each distinct captured payment has its own hold row and its own case, so every capture is traceable separately (verified, T022).
- **Gap to decide.** Some kinds hold **no extra money**:
  - `PAYMENT_ID_REUSED`: the same `pay_…` claimed by a second intent.
  - `ORDER_MISMATCH` under R1 (b), and `UNKNOWN_ORDER` for a payment later traced to its owner.

  They need a closure that is neither CREDIT nor REFUND. data-model §5 allows `RESOLVED_NO_ACTION` only for `EXTERNAL_REFUND`; the database constraint does not restrict it by kind.

**Proposed per-kind resolution table for Finance:**

| Kind                                       | Proposed allowed resolutions                                          |
| ------------------------------------------ | --------------------------------------------------------------------- |
| AMOUNT_MISMATCH (over)                     | CREDIT intent amount + refund excess (UD-1 a), or REFUND              |
| AMOUNT_MISMATCH (under), CURRENCY_MISMATCH | REFUND                                                                |
| MULTIPLE_CAPTURES                          | REFUND                                                                |
| UNMATCHED_CAPTURE                          | REFUND (D-6); CREDIT only if a matching subscription is still payable |
| PAYMENT_ID_REUSED                          | NO_ACTION (no extra money) after verifying the original application   |
| UNKNOWN_ORDER                              | Trace, then REFUND or NO_ACTION                                       |
| EXTERNAL_REFUND                            | Per UD-7                                                              |

- **Decision-maker.** Finance + Owner.
- **Blocks.** T081, T082.
- **If left open.** Review cases open safely (no money moves) but cannot be resolved. Held money sits at Razorpay; drivers wait. D-4's 24-hour target cannot be met.

### UD-2 — Ledger treatment of captured-but-unapplied money

- **Exact question (decisions.md).** Where does money Razorpay captured, but we did not apply, sit in the books? This includes the ledger legs for refunding held money.
- **Options.**
  - (a) Liability `PAYMENT_SUSPENSE` against `GATEWAY_CLEARING`, released by CREDIT or REFUND.
  - (b) Off-ledger until resolved.
  - (c) Post to the purpose account now.
- **Recommendation (decisions.md).** (a).
- **Current state (Phase 2).** Option-(b)-like by default: a hold writes **no** ledger group. Each case carries `evidence.ledger = "NOT_POSTED_UD2_OPEN"`, and `PAYMENT_SUSPENSE` is not in `LEDGER_ACCOUNTS`. No accounting treatment was invented.
- **Additional capture specifics.** Under (a), each `MULTIPLE_CAPTURES` hold posts its own suspense group, and its REFUND releases exactly that group. Under (b), Finance must name the refund reserve/settle/fail accounts, because the existing refund lifecycle assumes the payment was applied.
- **Decision-maker.** Finance / auditor.
- **Blocks.** The suspense posting in T024 and T081 (both CREDIT and REFUND).
- **If left open.** Ledger and Razorpay disagree by the total held amount. Settlement reconciliation cannot balance. No held payment can be resolved. Required for G0.

### TD-3 — Replacement for receipt-based order recovery

- **Exact question.** Sandbox S2c/S2d showed a reused receipt is accepted (a second order) and is searchable only about 2 minutes later. How is a crash between "Razorpay created the order" and "our row was written" handled?
- **Options.**
  - (a) **Accept orphan unpaid orders.** The app only ever learns an order id from our response, so an orphan can never be paid. The idempotency-key lookup before every provider call (already implemented) stops our own duplicates. The sweep ignores non-captured payments.
  - (b) **Persist before the call.** Write the intent row first (status `CREATED`, no order id), commit, call Razorpay, then attach the order id. A retry finds the row. If the order id is missing, an asynchronous job looks the receipt up after the 2-minute lag before creating another. This reintroduces the `CREATED` status that data-model §2 says is never written.
  - (c) Ask Razorpay for order-creation idempotency (T008). Not documented today.
- **Consequences.**
  - (a) No money risk; orphan `created` orders accumulate at Razorpay; no code change.
  - (b) Fewer orphans; more code and a data-model change; the recovery is asynchronous.
  - (c) Depends on Razorpay.
- **Recommendation.** (a) now; ask (c) through T008; revisit (b) only if orphan counts matter.
- **Decision-maker.** Owner (engineering-owned decision, flagged for Owner review).
- **If left open.** Behavior is already (a). The four T013 recovery tests stay `todo`.

### D-3 — Recheck window and the Dashboard auto-capture timeout

- **Decision (decisions.md, unchanged).** Recheck unpaid or failed payments for **5 days** from creation, then EXPIRED, only when Razorpay shows nothing captured or authorized. A later success is still applied and alerted. Owner-approved · **Finance pending**.
- **Why the dashboard matters.** The 5-day window assumes Razorpay's automatic capture with a **3-day** timeout: authorizations older than that are auto-refunded, never captured. S9 showed automatic capture is on in test mode. The timeout **cannot be read through the API**, so U8 stays open.
- **Evidence needed (Owner).** For **both** test and live mode, a dated record from the Dashboard's payment-capture settings showing:
  1. Automatic capture is enabled.
  2. The auto-capture / auto-refund window value.
  3. Which account and mode it belongs to (key id prefix only; mask the rest).
  4. Who checked and when.

  Record the exact Dashboard path seen, because Razorpay's menu names change, plus a masked screenshot reference, in the research.md Verification log.

- **If left open.** T062 cannot expire anything. Stale PENDING intents are polled indefinitely, with the TD-13 starvation risk until T061. If the live timeout is longer than assumed, a late capture could arrive after expiry; it is still applied (A4 on EXPIRED, with an alert), so no money is lost.

### D-2, D-4, D-6 — Finance-owned, unchanged

| ID  | Decision (as approved by the Owner)                                                                  | Finance status        | Evidence so far                                                                            | If left open                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| D-2 | Commission-wallet balance never below ₹0, by database `CHECK`                                        | Pending               | Dev Q5 = 0; E-14: no code path deducts below zero today                                    | No database floor (application logic only); T020b cannot ship; UD-7 wallet corrections lack a rule for insufficient balance |
| D-4 | Mismatches → MANUAL_REVIEW, no financial effect; Finance resolves within 24 h; CREDIT or REFUND only | Pending               | The gate already enforces "no financial effect" (T022)                                     | Cases accumulate unresolved; the PAYMENT_ID_REUSED / no-extra-money gap (UD-1) stays undefined                              |
| D-6 | Unmatched subscription capture → automatic case; any refund only via Finance                         | Pending (refund part) | Case opening exists as A8 in the gate; reachable only once T052 cancels superseded intents | Refunds of unmatched subscription payments cannot be processed                                                              |

### D-7, D-11 — Preserved for explicit review

| ID   | Decision (as approved by the Owner)                                                                   | Finance status                                    | Why it needs explicit review                                                                                                                                                                | If left open                                                 |
| ---- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| D-7  | Refund amount immutable once reserved                                                                 | Pending (it restricts an existing Finance action) | Sandbox S11c: a refund retry with a changed body is refused with **409**, so a mutable amount would leave a refund stuck in PROCESSING. D-7 is what makes the provider idempotency key safe | T084 cannot ship; T085's idempotency guarantee depends on it |
| D-11 | No ledger posting idempotency key in this feature; append-only ledger plus unique anchor rows (TD-17) | Pending (non-blocking)                            | Phase 2 applied the anchor indexes and append-only triggers (isolated DB only so far)                                                                                                       | Nothing blocked; Finance confirmation is still needed for G0 |

### UD-8 — Historical order-id payment rows (conditional)

- **Question and options.** Unchanged in decisions.md. (a) backfill from provider truth, or (b) leave and refund manually.
- **Evidence.** Dev Q4b shows **0** rows whose payment id is an order id; all 4 SUCCEEDED rows are seed fixtures. **Dev cannot establish whether production needs this.** Staging and production Q4 are not run (section 2).
- **Decision-maker.** Finance + Engineering, only if Q4 > 0 anywhere.
- **If left open.** If production has such rows, a late capture webhook for them opens a false `MULTIPLE_CAPTURES` case, and its hold row would block a later backfill (R5).

---

## 2. T004 read-only data checks, by environment

**Checks.** [`checks/t004-readonly-checks.sql`](./checks/t004-readonly-checks.sql): Q1–Q11 from data-model §12, plus M1–M4 readiness facts.

- It runs in `BEGIN READ ONLY … ROLLBACK`, with a 60 s statement timeout.
- It prints aggregates and categories only: no ids, names, contacts, payloads or secrets.
- Full rows are in the research.md Verification log (2026-10-21).

| Environment                             | Target confirmed                                                                                                                          | Status             | Result                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| **dev**                                 | Local container `zaroorat-dev-postgres-1`, database `zaroorat` (from `.env.development`; the running dev API's database), role `zaroorat` | **Run 2026-10-21** | See below                                                   |
| **staging**                             | No connection configuration on this workstation; no access granted                                                                        | **Blocked**        | Operator runs the same file through staging's read-only URL |
| **production**                          | Same                                                                                                                                      | **Blocked**        | Same; Q10 through the API's own `DATABASE_URL`              |
| `zaroorat_test`, `zaroorat_rzp005_test` | Test databases, not T004 environments                                                                                                     | Not applicable     | —                                                           |

**Dev results**

| Check                                                   | Result                                                                        | Meaning                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Q1, Q3, Q4a, Q9 (index blockers)                        | 0, 0, 0, 0                                                                    | T020's indexes would build on dev                             |
| Q2 paid-not-credited recharges                          | **3**                                                                         | Development-seed fixtures (no ledger, no wallet transactions) |
| Q4b ids by kind                                         | 4 SUCCEEDED rows, all `pay_`; **0 equal their order id**                      | No UD-8 evidence on dev; not representative                   |
| Q5 negative balances                                    | 0                                                                             | —                                                             |
| Q6 subscription mismatch                                | 0 / **3**                                                                     | Seed fixtures (no subscriptions exist on dev)                 |
| Q7 dead-lettered outbox                                 | 0                                                                             | —                                                             |
| Q8 unbalanced ledger groups                             | 0 (ledger is empty)                                                           | —                                                             |
| Q10 role                                                | `zaroorat`, superuser; runtime role exists                                    | REVOKE binds nothing on dev (expected locally)                |
| Q11 open intents / active provider / UD-11              | 0 / no setting (env default `mock`) / 0                                       | No backlog; UD-11 not triggered                               |
| M2 name collisions / M3 prerequisites / M4 new statuses | 0 / present / 0                                                               | Ready, data-wise                                              |
| Migration state                                         | 72 applied; the repository has 2 more from other teams, plus `20261021120000` | See migration readiness item C3                               |

**Does Q4 show that historical payment-id compatibility work is needed?**

- **Not on dev.**
- **Unknown for staging and production.** That is where it matters, and they are not checked.
- UD-8 / R5 stay conditional.

The dev data is tiny (6 intents, all seed fixtures). The zero-row test clone and this dev database **do not** show that staging or production data is safe.

**Finding for the seed's owner.** The development seed writes SUCCEEDED intents without their wallet, ledger or subscription effects. So Q2/Q6 (and, once built, the reconciliation jobs) will always flag a seeded database. That is a fixture issue, not lost money; it is reported, not changed.

---

## 3. Migration readiness

> **Updated 2026-10-21 (Phase 3A).** The current checklist is [migration-readiness-checklist.md](./migration-readiness-checklist.md). It supersedes §3.4–§3.9 below where they overlap. §3.1–§3.3 still apply.

### 3.1 Exact schema differences

**A. T020: `20261021120000_razorpay_payment_safeguards`.** Written; applied only to `zaroorat_rzp005_test`.

| Object                                                                                                                              | Kind                                 | On an existing table?                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `payment_review_cases` (+ 4 CHECKs, unique `(kind, provider_payment_id)`, index `(status, created_at)`, 3 FKs `ON DELETE RESTRICT`) | new table                            | no (FKs reference `payment_intents`, `payment_transactions`, `refunds`)    |
| `payment_reconciliation_runs` (+ index `(job, finished_at DESC)`)                                                                   | new table                            | no                                                                         |
| `payment_intents_gateway_intent_key`                                                                                                | partial unique index                 | **yes**, `payment_intents`                                                 |
| `payment_transactions_provider_payment_key`                                                                                         | partial unique index                 | **yes**, `payment_transactions`                                            |
| `payment_transactions_one_success_per_intent`                                                                                       | partial unique index                 | **yes**, `payment_transactions`                                            |
| `commission_wallet_one_credit_per_intent`                                                                                           | partial unique index                 | **yes**, `driver_commission_wallet_transactions`                           |
| `reject_financial_truncate()`                                                                                                       | function                             | —                                                                          |
| append-only + truncate-guard triggers, `ENABLE ALWAYS`                                                                              | 4 triggers                           | **yes**, `payment_ledger_entries`, `driver_commission_wallet_transactions` |
| `REVOKE UPDATE, DELETE, TRUNCATE … FROM zaroorat_app_runtime` (guarded)                                                             | privileges                           | **yes**                                                                    |
| Not included                                                                                                                        | `CHECK (balance >= 0)` (D-2 → T020b) | —                                                                          |

**B. T019c: the five deferred columns.** Proposed DDL only; **no migration file exists**, to avoid it being picked up by `migrate deploy`.

```sql
ALTER TABLE "payment_intents" ADD COLUMN "last_reconciled_at" TIMESTAMP(3);           -- T061 / TD-13
ALTER TABLE "gateway_events"
  ADD COLUMN "outcome" TEXT,                                                          -- T031, T026, R4
  ADD COLUMN "processing_attempts" INTEGER NOT NULL DEFAULT 0,                         -- T026
  ADD COLUMN "last_error" TEXT,                                                       -- T026 (sanitised)
  ADD COLUMN "last_attempt_at" TIMESTAMP(3);                                          -- T026
-- Optional, for T061 ordering on a large table (build CONCURRENTLY by hand first):
-- CREATE INDEX IF NOT EXISTS "payment_intents_reconcile_order_idx"
--   ON "payment_intents" ("last_reconciled_at" NULLS FIRST, "created_at", "id")
--   WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');
```

No `CHECK` on `outcome` until R4 decides the value list. Matching Prisma fields go into `payment.prisma` in the same change.

### 3.2 Backfill

- **T020: none.** New tables start empty; indexes and triggers act on existing rows as they are. UD-8 (rewriting order-id rows) is a separate, conditional, Finance-approved task, never part of a migration.
- **T019c: none.**
  - `last_reconciled_at` NULL means "never checked"; T061's `NULLS FIRST` picks those rows first. Size the first runs from Q11.
  - `processing_attempts` gets the constant default 0 (a metadata-only change on PostgreSQL ≥ 11).
  - `outcome` stays NULL for historical events, meaning "before outcomes existed". **No fabricated outcomes.**

### 3.3 Rollback

- Migrations are forward-only (constitution §3.2). The rollback is **application rollback**: both migrations are additive, so the previous app version keeps running (3.6).
- A schema reversal, if ever needed, is a **new forward migration**. Each reversal has a cost:
  - Dropping the four indexes removes the exactly-once backstop.
  - Dropping the triggers needs owner DDL and reopens ledger edits.
  - `payment_review_cases` must **never** be dropped once it holds a case (Finance records).
  - The REVOKE is reversed by a GRANT.
- T019c is reversible by `DROP COLUMN` in a forward migration, but only before T026/T031/T061 depend on the columns.
- If an index build fails partway (for example a duplicate appears between the pre-check and the build): the migration transaction rolls back as a whole. A hand-built `CONCURRENTLY` index may be left **INVALID** (`pg_index.indisvalid = false`) and must be dropped and rebuilt before `migrate deploy`.

### 3.4 Pre-migration checks and acceptable results

| Check                                                               | Acceptable result                                                                                                         | If not met                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Target identity (database, role, migration count, latest migration) | Matches the environment named in the authorization                                                                        | Stop                                                            |
| Pending migrations from other teams (C3)                            | Coordinated: either applied first by their owners, or explicitly approved to go together                                  | Stop: `migrate deploy` applies every pending migration in order |
| Q1, Q3, Q4a, Q9                                                     | **0**                                                                                                                     | The matching index build fails; remediate with Finance first    |
| Q2, Q6, Q8                                                          | 0, or a Finance-approved remediation recorded per row group                                                               | Proceed only with a recorded remediation                        |
| Q5                                                                  | 0 (required only for T020b)                                                                                               | T020b waits                                                     |
| Q7                                                                  | Reviewed; payment/subscription types requeued per D-5, or explained                                                       | —                                                               |
| Q10                                                                 | Recorded; runtime-role login in staging and production, or SEC-7 escalated                                                | REVOKE layer ineffective; triggers still apply                  |
| Q11                                                                 | Recorded; sizes T061/T062 batches; UD-11 decided if non-zero                                                              | —                                                               |
| M2                                                                  | 0 collisions                                                                                                              | Investigate partial earlier attempts                            |
| M3                                                                  | `reject_audit_mutation` = 1 (migrations `20261001120000`/`20261002130100` applied)                                        | T020 fails                                                      |
| M4                                                                  | 0                                                                                                                         | Investigate                                                     |
| M1                                                                  | Row counts **and** an exact `count(*)` on the four indexed tables (`pg_stat` estimates read 0 on dev, so they were stale) | Decides 3.5                                                     |

### 3.5 `CONCURRENTLY` requirements (constitution §3.4)

- Prisma runs a migration inside a transaction, and `CREATE INDEX CONCURRENTLY` cannot run inside one.
- **Rule.** If any of `payment_intents`, `payment_transactions` or `driver_commission_wallet_transactions` is large enough that a blocking build is not acceptable, the operator pre-creates the four partial unique indexes before `migrate deploy`. "Large enough" means a build longer than a few seconds on that environment, measured on a representative copy (3.7). The procedure:
  1. Use `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS …`, outside a transaction, with **exactly** the migration's names and definitions.
  2. Run the Q1/Q3/Q4a/Q9 checks immediately before each build.
  3. Verify `pg_index.indisvalid = true` for each.
  4. Then `migrate deploy`; the migration's `IF NOT EXISTS` makes those statements no-ops.
- The new tables' indexes need no `CONCURRENTLY`; they are empty.
- T019c needs none (metadata-only `ADD COLUMN`). The optional T061 index does need it on a large table.

### 3.6 Locking and downtime risks

| Statement                                                    | Lock taken                                    | Effect                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CREATE UNIQUE INDEX` (non-concurrent) on an existing table  | `SHARE`                                       | **Blocks writes** to that table for the whole build. Payment writes, recharges and webhooks wait              |
| `CREATE TRIGGER`, `ALTER TABLE … ENABLE ALWAYS TRIGGER`      | `SHARE ROW EXCLUSIVE`                         | Brief; blocks writes to the ledger and wallet-transaction tables while held                                   |
| `ADD CONSTRAINT … FOREIGN KEY` (new table → existing tables) | `SHARE ROW EXCLUSIVE` on the referenced table | Brief; the new table is empty                                                                                 |
| `ADD COLUMN` (T019c)                                         | `ACCESS EXCLUSIVE`                            | Instant once acquired, but it **queues behind any long transaction** and blocks reads and writes while queued |
| `REVOKE`                                                     | catalog only                                  | Negligible                                                                                                    |

**Mitigations (proposed, not applied).**

- Run in a quiet window.
- Apply a `lock_timeout` (for example `SET LOCAL lock_timeout = '5s'` at the start of the migration, so it fails fast instead of queueing) and retry. This would be an edit to T020's file **before** it reaches any shared database. Editing it now would change the checksum already recorded on `zaroorat_rzp005_test`, which then needs re-creating.
- Pre-build the indexes `CONCURRENTLY` (3.5).
- Check `pg_stat_activity` for long transactions first.
- Expected downtime: none, if the indexes are pre-built and the locks are acquired quickly.

### 3.7 Compatibility with the previous application version

**The previous app version runs safely against the migrated schema:**

- It never writes a second SUCCEEDED payment per intent or per provider payment in normal operation. A concurrent duplicate now fails at the index instead of double-crediting (intended).
- It never UPDATEs or DELETEs ledger or wallet-transaction rows: verified by searching `src/`, `prisma/seed`, `scripts/`.
- It never writes negative balances.
- It does not know the new tables.
- `prisma:reset` drops the schema, which the triggers do not block.

**Known exceptions:**

1. **Test fixtures.** `payment-reconciliation.test.ts` backdates ledger rows; adapted in Phase 2 to lift the trigger inside its own transaction.
2. **Test harness.** It truncates with `zaroorat.allow_financial_truncate` (T021); an older harness without it would fail on a migrated test database.
3. **Development seed.** Compatible: it inserts only; checked against the indexes (≤ 1 PAYMENT row per intent, unique seed ids).

**The new app version needs the migration first.**

- The Phase 2 code writes `CAPTURED_REVIEW` rows and review cases, and relies on the indexes as its backstop. **Order: migrate, then deploy.**
- A regenerated Prisma client with the T019c fields must never run against a database without them. That is why T019c was deferred while the shared dev DB is unmigrated.

**Not yet run** (runnable locally once authorized): the previous version's suite (a HEAD worktree) against a migrated clone.

### 3.8 Verification against representative non-empty data (required before any shared target)

The zero-row clone proves only that the SQL runs. Without copying staging data:

1. **Synthetic dataset on a new disposable clone** (`*_test` name, so the harness guard allows reset). No PII: generated ids, fake users. Production-scale counts from Q11/M1. It must cover:
   - normal paid and credited recharges and subscriptions;
   - FAILED → SUCCEEDED intents;
   - legacy rows storing an order id (UD-8 shapes);
   - one deliberate violation per blocking check, to prove Q1/Q3/Q4a/Q9 catch it and the index build refuses it.
2. **Apply T020 (and T019c when it exists)** with timing; measure each index build and lock wait.
3. **Run** the previous version's suite (HEAD worktree), the current payment suites, and the dev seed, against the migrated clone.
4. **Staging rehearsal by the operator, inside staging** (no data leaves it): run T004, then the migration on a staging snapshot restored in staging's own infrastructure, with timings recorded. This is T020's own done-when, and it stays **blocked** until staging access exists.
5. **Record** results in the research.md Verification log.

### 3.9 Unresolved migration risks

| ID  | Risk                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Staging and production data unverified (T004 blocked); index builds could fail or block writes there                                                                                                                                                           |
| C2  | Q10 unknown outside dev: if the API connects as the owner, the REVOKE layer is ineffective (SEC-7). The triggers still bind it, but an owner can drop them                                                                                                     |
| C3  | Dev is 2 migrations behind from other teams (`20261010120000_ride_requests_created_at_index`, `20261013120000_document_sides_distinct`). `migrate deploy` would apply them together with T020; needs T006 coordination and the authorization to name all three |
| C4  | Migrating the shared dev DB changes the running dev API's behavior (exactly-once indexes, append-only ledger). Any local script or admin action that edits ledger rows would start failing; none were found                                                    |
| C5  | `lock_timeout` not yet in T020 (3.6)                                                                                                                                                                                                                           |
| C6  | Prisma's diff reports pre-existing drift in unrelated tables (FKs and indexes outside this feature); someone running `prisma migrate dev` could generate an unrelated drop. Not this feature's, but it affects anyone creating the next migration              |

---

## 4. Task dependency sequence (validated against tasks.md)

The Owner's proposed order was:

1. refund-aware capture;
2. webhook freshness;
3. subscription safeguards;
4. migration readiness;
5. reconciliation;
6. review/refunds;
7. app, pilot, monitoring and gates.

Checked against the `Needs:` lines in tasks.md, **three corrections are required**:

- **Migration readiness must come first, not fourth.** T026 needs T020 applied, plus the T019c columns `processing_attempts`/`last_error`/`last_attempt_at`. T031 needs `outcome`. T061 needs T020 and `last_reconciled_at`.
- **T026 comes before T031.** tasks.md: T031 needs T001, T006 **and T026**. So the webhook chain is T001 → T030 → T026 → T031, not T001 → T030 → T031 → T026.
- **T006 is still open** (coordinators proposed, not confirmed). It blocks T031, T033, T061, T082, T044, T050, T089, T090, T096 and T097, so it gates most of stages 2–7.

**Proposed sequence (nothing started).** "Decision" means the named person decides; "Approval" means the Owner authorizes a target and operation.

| Stage                                             | Work                                                                                                                                                                                                                                                                                                                                                                                           | Needs (from tasks.md or this document)                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Decisions** (T007)                           | R1, R4, R6a–c (Owner); UD-7 (Owner + Finance); UD-1, UD-2, D-2, D-3, D-4, D-6, D-7, D-11 (Finance); TD-3 (Owner); D-3 dashboard evidence (Owner); UD-4, UD-6, UD-10 (G0 list)                                                                                                                                                                                                                  | —                                                                                                                                              |
| **0. Coordination**                               | T006: confirm coordinators for the overlap files                                                                                                                                                                                                                                                                                                                                               | Owner                                                                                                                                          |
| **1. Migration readiness**                        | (a) Synthetic non-empty verification (3.8, steps 1–3) on a new disposable clone. (b) T004 on staging and production by the operator. (c) Add `lock_timeout` to T020 if approved (3.6). (d) **Approval** to migrate named targets (shared dev, `zaroorat_test`), including C3's two other-team migrations. (e) T019c migration + Prisma fields. (f) T018 (constraint test) and T021's done-when | T004 per target; T006 for C3; Approval per target                                                                                              |
| **2. Refund-aware capture**                       | R2-T: refund-webhook detection, and holding a capture whose payment already has a recorded refund event. Detection only; resolution waits for UD-7                                                                                                                                                                                                                                             | Stage 1 (outcome column for refund events); UD-7 for wording only (detection works under either option)                                        |
| **3. Webhook freshness, deduplication, recovery** | T001 → T030 (tests first) → **T026** → **T031** (incl. the R4 outcome) → T033; then T028 (exactly-once concurrency), T025, T032                                                                                                                                                                                                                                                                | T001: UD-3 ✓ + its own authorization. T026: T020 applied. T031: T001, T006, T026. T033: T006. T028: T024 ✓                                     |
| **4. Subscription safeguards**                    | T051 → T052 (TD-11 supersession, R6a–c) → T053 → T054 (schedule subscription recovery) → T055/T056. `payments.subscription_checkout` stays OFF until done                                                                                                                                                                                                                                      | R6 decisions; D-6 (refund part only)                                                                                                           |
| **5. Reconciliation and recovery**                | T038 (job runs) → T060 → T061 (FAILED scan, rotation) → T062 (EXPIRED) → T066 → T067 (sweep) → T068; T065 (commission-wallet reconciliation); R5-T only if Q4 > 0                                                                                                                                                                                                                              | T061: T006, T020 + `last_reconciled_at`. T062: D-3. T067: T015 ✓, T024 ✓. R5-T: UD-8                                                           |
| **6. Review and refund workflows**                | T080 → T081 → T082 → T083; T084 → T085 → T086 → T087; admin T093, T094                                                                                                                                                                                                                                                                                                                         | T081: UD-1, UD-2, D-4, D-6, UD-7, UD-6. T082: T081, T006. T084: D-7. T085: T003 ✓                                                              |
| **7. App, pilot, monitoring, gates**              | R1-T before T043; T005 → T042/T043 → T044–T050; T037 pilot allowlist; T034, T099 alerting; T102 security; T103 runbooks; T100, T101, T104 → G0–G8 signed → T105                                                                                                                                                                                                                                | T005: T002. T043: T024 ✓, T035 ✓, R1. T044/T050: T005, T006. T037: UD-4, T035 ✓. T099: U15 + metrics + T103. T105: everything pre-live + G0–G7 |

Stages 2 and 3 can overlap once stage 1 is done. Stage 4 is independent of 2, 3 and 5, but must finish before the subscription switch is ever turned on.

Until stage 7's gates are signed:

- **Both switches stay OFF** in every real environment.
- **The pilot allowlist stays unenforced** and no pilot traffic is sent.
- **Production stays NO-GO.**
