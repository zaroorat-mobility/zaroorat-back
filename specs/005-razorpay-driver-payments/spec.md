# Feature Specification: Production-Ready Razorpay Payments for Drivers

**Feature Branch**: `005-razorpay-driver-payments` _(directory created by hand; no git branch was created, because the working trees carry other teams' uncommitted work — the branch is cut when implementation starts)_

**Created**: 2026-10-19 | **Revised**: 2026-10-19 (production-readiness review; second review against code and Razorpay docs — findings register in [research.md R-11](./research.md#r-11-code-verification-register-2026-10-19); third review: INV-2, FR-004, FR-058, FR-059 aligned with the [master blocker register](./plan.md#master-blocker-register); fourth review: FR-005, FR-031, FR-042, FR-052, SEC-4)

**Status**: Draft. Nothing is implemented.

- D-1, D-5, D-10 are approved (Owner).
- D-2, D-3, D-4, D-6, D-7 and D-11 are owner-approved, with Finance confirmation pending.
- UD-1…UD-10 are open. DR-1 is UD-1 and TD-14 is UD-2; both are still open ([decisions.md](./decisions.md#2-unresolved-decisions)).

**Input**: Owner request, 2026-10-19: follow the standard other companies use (e.g. Rapido with Razorpay); define what belongs in the backend and what in the app; produce a production-ready plan. Then the 2026-10-19 production-readiness review. This builds on the Phase 1 audit and [`docs/DRIVER_PAYMENT_ARCHITECTURE_SPECIFICATION.md`](../../docs/DRIVER_PAYMENT_ARCHITECTURE_SPECIFICATION.md); gap IDs G-xx and finding IDs F-xx refer to those.

## Context and fixed business model

- Customers pay drivers directly for rides (cash, UPI, other permitted direct methods). **Zaroorat never collects ride fares.**
- The platform collects only two driver payments through Razorpay: **subscription plans** and **commission-wallet recharges**.
- Ride commission follows the existing approved model (decided once at acceptance, deducted from the commission wallet at completion, BD-1/BD-7 of feature 004) and is not changed here.
- Out of scope unless separately approved: RazorpayX, customer-fare collection, escrow, split settlements, autopay or renewal, accounting-treatment changes (architecture ADR-04/06/16–19).

Responsibilities are split across four places:

- **Razorpay Dashboard**: configuration only.
- **Backend**: the only component that holds secrets, decides whether a payment succeeded, and moves money in our books.
- **Driver App**: opens checkout and shows the backend's answer.
- **Admin Panel**: shows real data and runs authorised exception workflows.

## Financial invariants _(non-negotiable)_

| ID     | Invariant                                                                                                                                                                                                                                                                                                                                                                                        | Enforced by                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| INV-1  | Money moves only for a Razorpay payment whose status is `captured`, whose `order_id` equals the order created for that payment intent, and whose amount (paise) and currency (INR) equal the intent's                                                                                                                                                                                            | Validation gate ([Payment application rules](#payment-application-rules)) |
| INV-2  | A Razorpay payment id is applied **or held** at most once, across all intents (one SUCCEEDED or `CAPTURED_REVIEW` row per `pay_…` id)                                                                                                                                                                                                                                                            | Database unique index                                                     |
| INV-3  | A payment intent has at most one successful payment and produces at most one wallet credit or one subscription activation                                                                                                                                                                                                                                                                        | Database unique indexes                                                   |
| INV-4  | **Recharge**: the payment record, the wallet credit, the wallet transaction, the ledger group and the outbox event commit in one transaction or not at all. **Subscription**: the payment record, the ledger group and the activation outbox event commit in one transaction. Activation then follows through the idempotent consumer (BD-7 of feature 004), backed by the recovery job (FR-027) | Single database transaction; conditional activation claim                 |
| INV-5  | Ledger groups balance; ledger entries and wallet transactions are append-only; a correction is a new entry                                                                                                                                                                                                                                                                                       | Code check + database triggers                                            |
| INV-6  | The commission-wallet balance never goes below ₹0 (D-2, Finance confirmation pending)                                                                                                                                                                                                                                                                                                            | Database `CHECK`                                                          |
| INV-7  | Every payment Razorpay captured for our account is, within 24 hours, in exactly one tracked state: **applied**, **held for review**, **refund in progress**, or **refunded**                                                                                                                                                                                                                     | Provider sweep (FR-031) + review cases                                    |
| INV-8  | Nothing is marked FAILED or EXPIRED while Razorpay reports the money captured or authorized                                                                                                                                                                                                                                                                                                      | Recovery rules (FR-025, FR-026)                                           |
| INV-9  | Client-supplied data (callback ids, signature, redirect, screenshot, amount) never decides success; every recovery path uses the same validation as checkout                                                                                                                                                                                                                                     | Single validation function, used by every path                            |
| INV-10 | A refund's amount is fixed once reserved; provider refund requests are idempotent; an unknown provider outcome stays "in progress" until Razorpay answers                                                                                                                                                                                                                                        | Refund lifecycle (existing + FR-040/041)                                  |

## Payment application rules

Normative. Evaluated by the backend for every path (checkout verify, webhook, reconciliation, provider sweep, staff confirm, review resolution), using Razorpay's own record of the payment, inside a transaction holding a lock on the payment intent.

| #   | Condition                                                                                                                            | Outcome                                                                                                                                                                                                                                                                                                                                        | Money moves?         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| A1  | Caller is not the intent's owner (driver routes), or the checkout signature is invalid, or the callback's order id differs from ours | **Reject** — 404 / 400, no state change, security metric                                                                                                                                                                                                                                                                                       | No                   |
| A2  | Razorpay status `created` or `authorized`                                                                                            | **No change** (pending). Alert if `authorized` persists > 30 min (auto-capture is expected, FR-071)                                                                                                                                                                                                                                            | No                   |
| A3  | Razorpay status `failed`, and no captured payment exists for the order                                                               | Intent → FAILED, unless already SUCCEEDED or in review. The order stays payable                                                                                                                                                                                                                                                                | No                   |
| A4  | `captured`; order, amount and currency match; payment id never applied; intent is PENDING, PROCESSING, FAILED or EXPIRED             | **Apply** — payment recorded with the `pay_…` id; wallet credit or activation; ledger; outbox event. An EXPIRED intent also raises an alert                                                                                                                                                                                                    | Yes, once            |
| A5  | `captured` but order, amount or currency differs                                                                                     | Amount or currency: **Review** (`AMOUNT_MISMATCH` / `CURRENCY_MISMATCH`). Order (decision R1, decisions.md §2b): **rejected before the validation gate**; the claiming intent does not change; the payment is routed to the intent that owns its order, or an `UNKNOWN_ORDER` review case opens. `verify` answers `400 PAYMENT_ORDER_MISMATCH` | No                   |
| A6  | `captured`, payment id already applied to a different intent                                                                         | **Review** (`PAYMENT_ID_REUSED`)                                                                                                                                                                                                                                                                                                               | No                   |
| A7  | `captured`, intent already SUCCEEDED through a different payment                                                                     | **Review** (`MULTIPLE_CAPTURES`), a refund candidate. The intent **stays SUCCEEDED**. Today this payment is silently ignored (R-11 CD-6)                                                                                                                                                                                                       | No                   |
| A8  | `captured`, intent CANCELLED (superseded subscription order)                                                                         | **Review** (`UNMATCHED_CAPTURE`, D-6)                                                                                                                                                                                                                                                                                                          | No                   |
| A9  | `captured` for an order we did not create                                                                                            | **Review** (`UNKNOWN_ORDER`)                                                                                                                                                                                                                                                                                                                   | No                   |
| A10 | Payment refunded at Razorpay without a matching Zaroorat refund                                                                      | **Review** (`EXTERNAL_REFUND`, UD-7)                                                                                                                                                                                                                                                                                                           | No (Finance decides) |
| A11 | Same payment already applied to this intent                                                                                          | **No-op** (duplicate)                                                                                                                                                                                                                                                                                                                          | No                   |
| A12 | Downgrade event (`payment.failed` etc.) for an intent already SUCCEEDED                                                              | **No-op**, recorded as stale                                                                                                                                                                                                                                                                                                                   | No                   |

"Review" always means:

- a durable review case;
- intent status MANUAL_REVIEW where an intent exists and is not already SUCCEEDED (A6 and A7 leave a SUCCEEDED intent unchanged);
- an alert to Finance;
- no wallet, subscription or ledger effect beyond the UD-2 holding entry.

A valid webhook signature only proves the message came from Razorpay. Ownership and amount always come from these rules.

**Evaluation order** (first match wins). This order makes A5 run before A6, so a payment from another order is always caught by the order check, never by A6. Per decision R1 it is rejected before the gate, the claiming intent does not change, and the payment goes to the intent that owns its order or opens `UNKNOWN_ORDER`.

1. A1. Driver `verify` path only: ownership, signature, callback order id.
2. The provider record could not be fetched (timeout, 5xx, 429) → **unknown**. No state change; the caller retries later.
3. A9: the order is not ours.
4. Payment `status`:
   - `created` / `authorized` → A2;
   - `failed` → A3, or A12 if the intent is already SUCCEEDED;
   - `refunded` → A10, unless it matches our refund records.
5. `captured`:
   1. A5: order id, then amount (paise), then currency;
   2. A11: already applied to this intent;
   3. A6: applied to another intent;
   4. A7: the intent succeeded through another payment;
   5. A8: the intent is CANCELLED;
   6. otherwise A4.

## Authoritative payment verification

Normative for every path in the rules above. Endpoints and fields were checked against Razorpay's documentation on 2026-10-19 ([research.md R-10](./research.md#r-10-razorpay-facts-re-verified-2026-10-19)).

| Path                                                         | Razorpay source of truth           | Documented endpoint                                                                                                                                      | Fields the gate reads                                                                                           |
| ------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Driver `verify` (after checkout)                             | The payment the callback names     | `GET /v1/payments/{payment_id}`                                                                                                                          | `id`, `order_id`, `amount` (paise), `currency`, `status`, `captured`, `amount_refunded`, `method`, `created_at` |
| Intent reconciliation, staff `confirm`                       | Every payment on **our** order     | `GET /v1/orders/{order_id}/payments`. It returns all authorised or failed payments of the order; captured ones are included. No pagination is documented | Same, for each item                                                                                             |
| Webhook `payment.captured` / `order.paid` / `payment.failed` | The signed payload                 | `payload.payment.entity` (and `payload.order.entity.amount_paid` for `order.paid`)                                                                       | Same                                                                                                            |
| Provider sweep (INV-7)                                       | All recent payments on the account | `GET /v1/payments?from&to&count&skip` (`from`/`to` in Unix seconds, `count` ≤ 100). `order_id` is **not** a documented filter                            | Same, plus `notes`                                                                                              |

Rules that bind all of them:

- **Removed**: `GET /v1/payments?order_id=` is undocumented. The current code uses it (R-11 CD-1). No new code may call it.
- **Ownership**: the credited driver comes only from the intent row (`payment_intents.user_id` → `drivers.user_id`). Provider `notes`, `email` and `contact`, and client data, never decide whom to credit.
- **Applicable status**: crediting a wallet or activating a plan needs `status = captured`. `authorized` never credits; auto-capture is expected (FR-071). A refund needs a captured `pay_…` payment (existing `isRefundableProviderReference`).
- **Signature scope**: the checkout signature `HMAC_SHA256(stored_order_id + "|" + payment_id, key_secret)` proves the callback came from Razorpay checkout for our order. The webhook signature proves origin only. Neither one alone can apply a payment: the gate always runs on a provider record.
- **Recovery parity**: reconciliation, the sweep, staff `confirm` and review CREDIT call the same gate function as `verify` and webhooks (INV-9, FR-010). Each path has a test proving that a foreign-order payment is not applied (TM-01, TM-02, TM-07, TM-26).

| Failure case                                                                       | Outcome                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider timeout, 5xx or 429                                                       | Unknown. No state change and nothing marked FAILED (INV-8). `payment_reconciliation_error_total`; retried on the next run                                                                               |
| `GET /payments/{id}` returns 404, or a payment whose `order_id` ≠ the stored order | `verify` → `400 PAYMENT_ORDER_MISMATCH`, no state change, security metric. The real payment, if any, is still found by reconciliation                                                                   |
| Signature mismatch on `verify`                                                     | `400 PAYMENT_SIGNATURE_INVALID`, no provider call, security metric                                                                                                                                      |
| `captured` with a mismatched amount or currency                                    | Review (A5)                                                                                                                                                                                             |
| More than one `captured` item on one order                                         | The first is applied through A4; each other one goes to review (A7). Razorpay documents that a paid order accepts no further payments when `partial_payment` is off, so this is defensive (sandbox S3b) |

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Driver recharges the commission wallet (Priority: P1)

A commission-model driver chooses a recharge amount, pays with UPI (Google Pay, PhonePe…) or card inside the app, and sees the new balance only once the platform has confirmed the money arrived. If the payment fails, is cancelled, or the phone loses signal, the driver sees an honest status and is never charged twice for one recharge.

**Why this priority**: commission drivers cannot accept rides without balance; today no driver can pay (G-01).

**Independent Test**: in Razorpay test mode, a commission driver recharges ₹500 and the wallet shows ₹500 more. Repeating verify, re-delivering the webhook and running reconciliation all leave exactly one credit.

**Acceptance Scenarios**:

1. **Given** ₹120 balance, **When** a ₹500 recharge is captured, **Then** the balance is ₹620 within 10 s of capture, with one recharge transaction and one balanced ledger group.
2. **Given** a recharge in progress, **When** the app is closed before the result, **Then** on reopening it shows "Verifying payment" and then the confirmed result, without asking to pay again.
3. **Given** the driver dismisses checkout, **Then** nothing changes, and a retry uses the same payment order.
4. **Given** the bank declines, **Then** the app shows "Payment failed — no money was added" and the balance is unchanged.
5. **Given** a forged success sent from a modified app, **Then** nothing is credited (A1/INV-9).
6. **Given** the driver taps Pay twice quickly, **Then** one order and at most one charge exist (FR-053).

---

### User Story 2 - Driver buys a subscription plan (Priority: P1)

A subscription-model driver picks a plan whose name, price and duration come from the backend, pays through Razorpay, and can take rides once the payment is confirmed. Retrying a failed attempt uses the same order, so a late first payment never creates a second charge without a plan.

**Why this priority**: subscription orders cannot currently be created at Razorpay (N-01: order reference over 40 characters).

**Independent Test**: a weekly plan bought in test mode becomes ACTIVE with the correct expiry; an injected activation failure is recovered within 10 minutes.

**Acceptance Scenarios**:

1. **Given** no active plan, **When** a weekly plan is paid, **Then** it is ACTIVE until now + 7 days and ride acceptance is allowed.
2. **Given** a failed first UPI attempt, **When** the driver retries, **Then** the same order is used. If both attempts are captured, one period is granted and the extra payment becomes a review case (A7).
3. **Given** activation fails repeatedly, **When** the recovery job runs, **Then** the subscription activates exactly once.
4. **Given** no plans are configured, **Then** the app says plans are unavailable and shows no made-up prices.
5. **Given** an active plan reaches its expiry, **Then** the existing expiry sweep marks it EXPIRED and new rides are refused; a ride already in progress completes (existing BD-2).

---

### User Story 3 - Payments are recovered when something goes wrong (Priority: P1)

If the server is down, slow, or misses a notification, or notifications arrive late, twice or out of order, every captured payment is applied exactly once, or held for review, automatically.

**Why this priority**: without it, drivers lose money during any outage (G-02, G-03, G-04, G-18).

**Independent Test**: with the webhook endpoint failing for 30 minutes during a test payment, the payment is applied once after recovery. With webhooks disabled, reconciliation applies it within 20 minutes.

**Acceptance Scenarios**:

1. A payment captured while the API is down for 30 minutes is applied once from Razorpay's retries.
2. The same notification delivered five times produces one effect.
3. A success followed by a late failure notice keeps the payment successful (A12).
4. With no notification at all, reconciliation applies the payment using Razorpay's record for that exact order.
5. A failed UPI payment that the bank authorises hours later, and Razorpay captures within 5 days, is applied once.
6. An abandoned payment older than 5 days with nothing captured or authorized becomes EXPIRED, and the app says "Payment not completed".
7. A captured payment our records do not know about is found by the provider sweep within 24 hours and opened as a review case (INV-7).
8. If a reconciliation job stops running, an alert fires within two of its intervals.

---

### User Story 4 - Mismatched payments never move money (Priority: P2)

A payment that fails any rule A5–A10 credits nothing; Finance reviews it within 24 hours and resolves it under D-4 / UD-1.

**Independent Test**: a signed test notification one paisa short credits nothing and appears in the review queue.

**Acceptance Scenarios**:

1. ₹499.99 captured against a ₹500 order → no credit, review case, Finance alert.
2. A payment belonging to another order is never applied to this intent.
3. A Finance REFUND resolution goes through the refund lifecycle and closes the case, with an audit record naming the actor, reason and time.
4. Two Finance users resolving the same case at once → exactly one resolution.

---

### User Story 5 - Refunds reverse exactly what was paid (Priority: P2)

Finance refunds unused wallet credit or a subscription payment. The amount sent to Razorpay, the amount taken from the wallet and the ledger always agree; retries never refund twice; payments recovered by reconciliation are refundable; an uncertain provider outcome is resolved by asking Razorpay, never by assuming.

**Independent Test**: a reserved refund's amount cannot change; repeating a refund request returns the same refund; a timed-out refund stays "in progress" until Razorpay's status is fetched.

**Acceptance Scenarios**:

1. A refund already sent to Razorpay → an attempt to change its amount is refused (D-7).
2. A refund request that timed out → the retry finds the same Razorpay refund; no second refund.
3. A payment applied through reconciliation → the refund is accepted.
4. Razorpay reports the refund `failed` → the reserved amount is restored exactly, with an audit trail.

---

### User Story 6 - Operators see and act on payment problems (Priority: P3)

Finance and operations can look up any payment, see reconciliation results, work the review queue, and safely re-run failed activation events. Nothing in the admin panel shows invented values or fake success.

**Independent Test**: the admin wallet tab shows the backend balance; the fake top-up is gone; payment lookup by Razorpay payment id finds the intent; a dead-lettered activation re-run twice activates once.

**Acceptance Scenarios**:

1. A driver with ₹0 → admin shows ₹0, never a placeholder.
2. Searching a `pay_…` or `order_…` id → the matching intent, its payments, events and review case.
3. A re-run of a dead-lettered activation, twice → one activation, two audit rows.

### Edge Cases

- **Same order paid twice from two UPI apps** → the second capture is a review case (A7); never a second credit.
- **`authorized` but not `captured`** → wait (A2); Razorpay auto-captures, or auto-refunds after 3 days; we never credit an authorized-only payment.
- **Webhook signed with the previous secret during rotation** → accepted only inside the rotation window (FR-024).
- **Order created at Razorpay but our database write fails** → a retry with the same request finds the existing order (FR-002).
- **Two drivers' apps send the same idempotency value** → two separate payments; neither sees the other's order (FR-004).
- **Driver switches from subscription to commission while a subscription payment is pending** → existing BD-5; a later capture is applied or reviewed, never lost.
- **Refund of recharge credit while a commission ride is in progress** → current behaviour unchanged; policy open as UD-5.
- **No UPI app on the phone** → other methods remain available in checkout.
- **Razorpay unreachable** → payment buttons say "Payments temporarily unavailable"; balances and active plans keep working.
- **Redis unavailable** → new payment requests fail closed (no intent created). Existing confirmations still apply, because confirmation uses database locks and unique rules.
- **Razorpay orders do not expire on their own** (no documented expiry for standard orders) → a payment can arrive after our intent is EXPIRED; rule A4 applies it and alerts.
- **Razorpay disables the webhook** after 24 hours of continuous delivery failures (documented) → reconciliation and the sweep keep applying payments. The Razorpay alert email and the "no webhooks received" alert page on-call, and the runbook re-enables the webhook (T103). One event that keeps failing is parked, not retried forever (FR-034).
- **Late-authorised UPI payment after the auto-capture timeout** → Razorpay auto-refunds it, and it was never `captured`. No credit, and no `EXTERNAL_REFUND` case, because it was never ours to apply (data-model §9).
- **Payment created before a webhook-secret rotation and retried after it** → Razorpay signs it with the **old** secret (documented). It is accepted while the previous secret is still valid (FR-024).

## Requirements _(mandatory)_

Tags: **[Backend]**, **[App]**, **[Admin]**, **[Dashboard]** (Razorpay configuration, owner-operated).

### Payment creation

- **FR-001** [Backend]: Create exactly one Razorpay order per payment intent before checkout opens. The amount is computed by the server in paise; the currency is INR. `partial_payment: false` is sent explicitly instead of relying on a default.
- **FR-002** [Backend]: The order `receipt` MUST be at most 40 ASCII characters, unique, and derived deterministically from the scoped idempotency key, so a crash-retry recovers the original order (TD-3). ~~On any HTTP 400 from order creation, the backend looks the order up by receipt…~~ **Under review (2026-10-20)**: sandbox evidence shows Razorpay test mode accepts duplicate receipts and indexes them with minutes of lag (research.md S2c/S2d). So the receipt cannot provide crash-recovery of the original order. Until the Owner reviews the revision proposed in decisions.md TD-3, a crash after order creation may leave an orphan **unpaid** order (no money can move on it), and a retry creates a new one.
- **FR-003** [Backend]: The payment response MUST include what checkout needs: public key id, order id, amount, currency, display name, description, and prefill only if UD-9 allows. It MUST NOT include any secret.
- **FR-004** [Backend]: Idempotency keys are stored scoped per driver and purpose on the server (`recharge:{driverId}:{key}`, `subscription:{driverId}:{key}`).
  - The same raw key from two drivers yields two separate intents. Neither driver can obtain, or learn the existence of, the other's intent. Today `createIntent` looks the raw key up globally and checks only the purpose (R-11 CD-9).
  - Defence in depth: if a found intent ever belongs to another user, the request fails with a generic `409 DUPLICATE_IDEMPOTENCY_KEY` that carries no intent data, and a security event is logged (TD-6).
  - An interrupted request frees its key within minutes.
  - The database unique key on the intent is the durable backstop behind the Redis replay cache.
- **FR-005** [Backend]: A pending subscription keeps one Razorpay order across failed attempts; a new order only on plan change or expiry (TD-11). Superseding an intent locks it and cancels it from PENDING, FAILED or EXPIRED. A SUCCEEDED intent is never superseded: the subscription activates instead. So a late capture on a superseded order is always a review case (A8), never an applied payment with no subscription.

### Verification and money movement

- **FR-010** [Backend]: Every path MUST apply the [Payment application rules](#payment-application-rules) through one shared function (INV-9).
- **FR-011** [Backend]: Before any financial effect, the checks in rules A1–A12 MUST run inside one transaction holding the intent lock. The credited driver is always derived from the intent's owner, never from provider data or the request.
- **FR-012** [Backend]: Every review outcome creates a durable case with sanitised evidence (expected vs observed), alerts Finance, and moves no money (D-4).
- **FR-013** [Backend]: The Razorpay payment id (`pay_…`) MUST be stored for every applied or held payment, whichever path found it.
- **FR-014** [Backend]: The checkout callback is verified by signature against the **stored** order id and the key secret, then the payment is fetched from Razorpay (`GET /v1/payments/{id}`). The signature alone never credits.
- **FR-015** [Backend]: INV-2 and INV-3 are enforced by database unique indexes. A concurrent duplicate fails at the database and rolls back its whole transaction.
- **FR-016** [Backend]: INV-6 is enforced by the database (D-2, Finance confirmation pending).
- **FR-017** [Backend]: INV-5: ledger entries and commission-wallet transactions are append-only.

### Notifications, retries and recovery

- **FR-020** [Backend]: Verify Razorpay webhooks with HMAC-SHA256 over the exact raw body.
- **FR-021** [Backend]: Deduplicate on the event id **only for events already processed successfully**. An event whose earlier processing failed is processed again.
- **FR-022** [Backend]: Process correctly signed Razorpay events up to 72 h old (D-1, UD-3). An older event is stored with the terminal outcome `TOO_OLD` (`processed = true`), acknowledged with 200, not applied, and alerted. Reconciliation resolves the payment from Razorpay's record.
- **FR-023** [Backend]: Downgrades after success are recorded no-ops (A12). A late success on an EXPIRED intent is applied and alerted (A4).
- **FR-024** [Backend]: During a webhook-secret rotation, accept the previous secret alongside the current one for **at least 24 h and at most 72 h** (default 48 h). Razorpay documents that retries of events created before the change are still signed with the old secret, and it retries for 24 h.
- **FR-025** [Backend]: At least every 10 minutes, reconcile every unresolved intent (pending, processing, or failed within 5 days), oldest-checked first, using Razorpay's record of the exact order.
- **FR-026** [Backend]: An intent becomes EXPIRED only after 5 days and only if Razorpay shows nothing captured or authorized (D-3).
- **FR-027** [Backend]: A recovery job, every 5 minutes, activates any pending subscription whose payment succeeded.
- **FR-028** [Backend]: A captured payment matching no open subscription becomes a review case (A8, D-6), never a repeating failure.
- **FR-029** [Backend + Admin]: Dead-lettered payment events alert, and an operator can re-run them, with audit (D-5).
- **FR-030** [Backend]: Every commission wallet is reconciled at least hourly (balance = sum of transactions = ledger position). Mismatches alert and are never auto-corrected.
- **FR-031** [Backend]: At least every 30 minutes, a provider sweep lists Razorpay payments for the last 48 hours, or since its last successful run if that is earlier, and confirms each captured one is applied, held, being refunded, or refunded (INV-7). Otherwise it opens a case (A9, A10) or applies it through the rules if its intent is open.
- **FR-032** [Backend]: Webhook processing failures are persisted (event, attempt count, sanitised error, time) for investigation, and answered with a 5xx so Razorpay retries.
- **FR-033** [Backend]: Every payment job records each run; an alert fires when a job's last successful run is older than twice its interval.
- **FR-034** [Backend]: After `RAZORPAY_WEBHOOK_MAX_PROCESSING_ATTEMPTS` failed attempts (default 5), an event is **parked**:
  - outcome `PARKED`, `processed = true`;
  - answered 200;
  - paged;
  - its payment is left to reconciliation (FR-025) and the sweep (FR-031), which use the same gate.

  This keeps one failing event from contributing to Razorpay's 24-hour webhook disablement (TD-15a). Parking never applies or rejects a payment.

- **FR-035** [Backend]: Every gate run with a provider record emits one structured audit log line (intent id, `pay_…` id, rule matched, outcome, path). It contains no payload, VPA, card, email or contact data. The line lets investigators reconstruct why money did or did not move without reading raw payloads.

### Refunds

- **FR-040** [Backend + Admin]: A refund's amount is fixed once reserved (D-7).
- **FR-041** [Backend]: Every Razorpay refund request carries the refund's own id as `X-Refund-Idempotency`.
- **FR-042** [Backend]: A refund with an unknown provider outcome (timeout, 5xx, 409) stays in progress and is resolved only by Razorpay's refund status (existing reconciliation every 5 minutes, plus `refund.*` webhooks). It is never marked failed or retried as a new refund because of an internal timeout. A 400 that Razorpay returns for a retry under the same `X-Refund-Idempotency` key also counts as unknown, never as a rejection, so a reservation is never restored while a refund may exist. (The timeout, 5xx and DB-loss behaviour exists today, E-6.)
- **FR-043** [Backend]: Refunds of driver money require Finance (`finance:execute`). Second-approver rules follow UD-6 once decided.

### Driver App

- **FR-050** [App]: Open Razorpay Standard Checkout with the backend's order. On Android, declare UPI app visibility as Razorpay documents for targetSdk ≥ 30. Compatibility is proven by spike T005, not assumed.
- **FR-051** [App]: Never show success, a new balance or an active plan until the backend reports it.
- **FR-052** [App]: Keep a record of the in-progress payment on the device; after a restart or reconnection, resume by asking the backend for its status. Checkout may reopen only while the backend reports the intent `PENDING` or `FAILED`, and only on the same order. Every other status shows the status screen.
- **FR-053** [App]: Prevent duplicate submissions: the Pay button is disabled while a request is in flight; one attempt per purpose at a time; retries of an attempt reuse its idempotency key.
- **FR-054** [App]: Plan names, prices, recharge options, limits and commission rate come only from the backend.
- **FR-055** [App]: Changing payment model needs explicit confirmation; errors are shown.
- **FR-056** [App]: Wallet history shows each transaction's sign and type correctly; the balance shown is the commission wallet's, never another wallet's.
- **FR-057** [App]: A ride-acceptance refusal for insufficient balance or missing plan says so and links to recharge or plans.
- **FR-058** [App + Backend]: Each payment purpose can be switched off remotely and independently: `payments.driver_checkout` for recharges and `payments.subscription_checkout` for subscriptions (TD-12, both default **off**).
  - The backend checks the purpose's flag before any write.
  - Payments are limited to a pilot cohort while `payments.pilot_mode` is on; it defaults to **on**, with an empty allowlist (TD-19, UD-4).
  - When a flag is off, the app hides that payment action and explains that payments are temporarily unavailable.
- **FR-059** [App]: Status screens cover verifying, success, failed, not completed (expired or dismissed), in review, and refunded after review, each with a support reference.

### Admin Panel

- **FR-060** [Admin]: The commission-wallet view shows backend data only; the fabricated values are removed (D-10).
- **FR-061** [Admin]: Finance lists, inspects and resolves review cases. Each resolution records actor, reason and time (D-4, UD-1, UD-6).
- **FR-062** [Admin]: Operators see dead-lettered payment events and re-run one, with audit (D-5).
- **FR-063** [Admin]: Payment lookup by driver, intent id, Razorpay order id or payment id shows the intent, its payment records, its webhook events, its review case and its refunds. Filters apply before pagination.
- **FR-064** [Admin]: Reconciliation results (latest runs per job, open mismatches) are visible to Finance and Ops.
- **FR-065** [Admin]: Every staff payment action appears in the existing finance audit log.

### Razorpay Dashboard (owner-operated)

- **FR-070** [Dashboard]: Separate test and live keys; live keys only in production.
- **FR-071** [Dashboard]: Automatic capture is enabled, with the **default 3-day** auto-capture timeout. Razorpay auto-refunds payments authorised after the timeout. A shorter timeout would refund late UPI authorisations that D-3 expects to apply, so the value is recorded at S9 and any change needs a review of D-3.
- **FR-072** [Dashboard]: One webhook per environment to `/api/v1/payments/webhooks/razorpay`, subscribed to `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`, with a strong secret held only by the backend. The webhook alert email is an on-call address, because Razorpay emails it when it disables a failing webhook.
- **FR-073** [Dashboard]: Dashboard refund permission restricted per UD-7.

### Security requirements

- **SEC-1**: The key secret and webhook secrets exist only in backend configuration or encrypted admin settings. A built app bundle (APK/AAB JS bundle) contains no secret. The public `key_id` is allowed.
- **SEC-2**: Payment-intent routes return 404 for any intent the caller does not own, whether it exists or not (BOLA/IDOR, constitution §9.3), and validate `:intentId` as a UUID. This includes the existing `POST /payments/intents/:id/confirm`, which today answers 403 for another user's intent and 404 for a missing one (R-11 CD-15).
- **SEC-3**: Admin payment routes enforce `finance:read`/`finance:execute` and `operations:read`/`operations:write` on the server. UI guards are an addition, not the control.
- **SEC-4**: The Razorpay webhook stays the only public payment route. The only foreseen exception is the TD-1b hosted checkout page, which may exist only if T005 selects TD-1b and the Owner approves UD-12.
- **SEC-5**: Logs never contain webhook bodies, signatures, secrets, card or VPA data; review-case evidence is sanitised.
- **SEC-6**: Secret rotation follows FR-024 without downtime.
- **SEC-7**: In staging and production, the API connects as a login in the `zaroorat_app_runtime` role (migration `20261002130100`), not as the schema owner. Otherwise the append-only `REVOKE`s in data-model §8 do not apply. This is checked as data check Q10 at G2.
- **SEC-8**: Raw webhook payloads stored in `gateway_events.payload` carry the payer's email, contact, VPA and card metadata (R-11 CD-18). Storage and retention follow UD-10 once it is decided. Until then, nothing new may copy payload PII elsewhere (review evidence and logs stay sanitised).

### Key Entities

- **Payment intent**: one request to collect a fixed amount for one purpose from one driver; holds the Razorpay order id and a status (pending, succeeded, failed, expired, cancelled, manual review).
- **Payment record**: one Razorpay payment (`pay_…`) against an order, applied or held; it belongs to at most one intent.
- **Notification record**: each Razorpay webhook received, with its outcome and processing attempts.
- **Review case**: a captured payment that cannot be applied automatically, with evidence, resolution, actor and time.
- **Reconciliation run**: one execution of a payment job, with its window, counts and result.
- **Commission wallet** and its **transactions**; **Subscription**: unchanged concepts with stronger guarantees.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 0 credits or activations for a payment breaking any of A1, A5–A10, across tests and test mode.
- **SC-002**: Any notification delivered up to 10 times, with reconciliation, verify and the sweep running concurrently, produces exactly one effect per captured payment.
- **SC-003**: A payment captured during a 30-minute API outage is applied within 10 minutes of recovery. With webhooks disabled it is applied within 20 minutes.
- **SC-004**: 95 % of successful payments show as confirmed in the app within 10 s of capture.
- **SC-005**: An injected activation failure is recovered within 10 minutes in 20 of 20 trials.
- **SC-006**: Daily: 0 captured payments older than 24 hours outside the four tracked states (INV-7), and 0 older than 20 minutes unapplied, excluding open review cases.
- **SC-007**: Every refund's reservation and settlement net to zero against Razorpay's refunded amount.
- **SC-008**: A driver reaches the Razorpay sheet in at most two taps after choosing an amount.
- **SC-009**: 100 % of review cases resolved within 24 hours during the pilot.
- **SC-010**: No hardcoded price, rate or rule remains in the app's billing screens or the admin finance screens.
- **SC-011**: An alert fires within two intervals when any payment job stops running (drill).

## Assumptions

- Razorpay is the only live provider; Stripe stays dormant (invite-only in India).
- INR only.
- The driver app ships to Android first through EAS builds; iOS follows the same design when an iOS build exists.
- UPI **intent** cannot be exercised in Razorpay test mode (Razorpay: "Test Mode to test UPI payments, and Live Mode for UPI Intent and QR payments"). It is proven at the staff ₹1 live step of the rollout.
- The checkout approach is decided by spike T005. TD-1b is a fallback that must pass the same checks; it is not assumed equivalent.
- Razorpay test keys and a staging webhook are provided by the owner (D-8).
