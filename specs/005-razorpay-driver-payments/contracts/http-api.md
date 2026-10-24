# HTTP API Contract: Razorpay Driver Payments

**Feature**: `005-razorpay-driver-payments` | **Date**: 2026-10-19 | **Revised**: 2026-10-19 (second review; third review: per-purpose kill switch, cross-driver key behaviour, `REFUNDED` status) | **Decisions applied**: D-1…D-11 (Finance confirmations pending where decisions.md says so), TD-1…TD-19 including TD-15a. UD-1…UD-10 open

Legend: **NEW** · **CHANGED** · **UNCHANGED** (context only). All bodies use the existing envelope: `{ "data": … }`, or `{ "error": { "code", "messageKey", "message", "requestId", "details?" } }` (constitution §13.2). Authentication is deny-by-default. The Razorpay webhook stays the only public payment route (§10.2). Every mutating payment route requires `Idempotency-Key` (§6.1). Response changes are additive (§16.3).

## Integrity rules (bind every endpoint)

| Rule                                     | Guarantee                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client never sets the charged amount | Amount comes from the plan, the recharge option, or a server-validated custom amount (≤ 2 decimals, configured min/max)                                                                                                                                                                |
| The client never declares success        | `verify` is a prompt: signature check + Razorpay fetch + validation gate. Only Razorpay `captured` with a matching order, amount and currency moves money                                                                                                                              |
| One payment → at most one effect         | Intent row lock + transition rules + partial unique indexes ([data-model.md](../data-model.md) §3, §7, §8)                                                                                                                                                                             |
| No secrets leave the backend             | Responses carry only Razorpay `key_id` (public); never `key_secret` or webhook secret                                                                                                                                                                                                  |
| Non-enumeration                          | Another user's intent returns `404 PAYMENT_NOT_FOUND`, identical to a missing one (§9.3)                                                                                                                                                                                               |
| Kill switch (per purpose)                | `payments.driver_checkout` gates recharge intents; `payments.subscription_checkout` gates subscription intents (TD-12). Both default OFF. While a purpose's flag is off, its creating endpoint returns `503 PAYMENTS_UNAVAILABLE` **before any write**. Existing intents still confirm |
| Pilot cohort                             | While `payments.pilot_mode` is on (default ON, empty allowlist), a driver who is not on the allowlist gets `503 PAYMENTS_UNAVAILABLE` from both creating endpoints (TD-19, UD-4)                                                                                                       |

## Driver App endpoints

### CHANGED `POST /api/v1/payments/driver-wallet/recharge`

- **Auth**: authenticated driver with `paymentModel=COMMISSION` or `pendingPaymentModel=COMMISSION` (unchanged rule).
- **Headers**: `Idempotency-Key` — the app's attempt key. It is reused for retries of the same attempt (TD-8). The server stores it scoped as `recharge:{driverId}:{key}` (TD-6).
- **Body** (unchanged shape): `{ "rechargeOptionId": "<uuid>" }` **or** `{ "amount": 500 }`. Validation tightened: `amount` must have at most 2 decimals and fall within the configured bounds.
- **200** (existing fields kept, `checkout` added):

```json
{
  "data": {
    "intentId": "uuid",
    "intentStatus": "PENDING",
    "gateway": "razorpay",
    "gatewayIntentId": "order_…",
    "amount": 500,
    "checkout": {
      "provider": "razorpay",
      "keyId": "rzp_test_…",
      "orderId": "order_…",
      "amount": 50000,
      "currency": "INR",
      "name": "Zaroorat",
      "description": "Commission wallet recharge"
    }
  }
}
```

- `checkout.prefill` is `{ "contact": "+91…" }`: the paying driver's own login number (UD-9 (a), 2026-10-23). It is omitted when the intent's owner has no driver record.

- **Errors**:

| Status | Code                              | Meaning                                                                                                                                                                                                     |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `IDEMPOTENCY_KEY_REQUIRED`        | Header missing                                                                                                                                                                                              |
| 403    | `COMMISSION_RECHARGE_NOT_ALLOWED` | Driver is not on the commission model                                                                                                                                                                       |
| 404    | `RECHARGE_OPTION_NOT_FOUND`       | Unknown or inactive option                                                                                                                                                                                  |
| 422    | `INVALID_RECHARGE_AMOUNT`         | Amount outside bounds or too many decimals                                                                                                                                                                  |
| 409    | `DUPLICATE_IDEMPOTENCY_KEY`       | Same driver, same key, different payload. (Another driver sending the same raw key gets their own, separate intent. The defensive owner check returns this code with no intent data if it ever fires, TD-6) |
| 409    | `IDEMPOTENCY_IN_PROGRESS`         | Same request still running                                                                                                                                                                                  |
| 503    | `PAYMENTS_UNAVAILABLE`            | `payments.driver_checkout` off, or the driver is outside the pilot allowlist                                                                                                                                |
| 503    | `PAYMENT_GATEWAY_UNAVAILABLE`     | Razorpay unreachable; retry with the same key is safe                                                                                                                                                       |

- **Transaction boundary**: the Razorpay order is created first (no transaction open). Then one transaction writes the intent and its outbox event.

### CHANGED `POST /api/v1/subscriptions`

- **Body**: `{ "planId": "<uuid>" }` (unchanged).
- **200**: `{ "data": { "subscriptionId", "status", "intentId", "checkout" | null } }`. `checkout` is present whenever `intentId` is.
- **Behaviour** (TD-11):
  - First, `payments.subscription_checkout` and the pilot allowlist are checked. If either refuses, the endpoint answers `503 PAYMENTS_UNAVAILABLE` and writes nothing (no subscription row, no order). Today the subscription row is written before the intent is created (`subscription.service.ts:120-142`).
  - PENDING subscription, same plan, intent not expired → returns the **same** intent and order, even if the last attempt FAILED.
  - Plan changed or intent expired → the old intent is locked and becomes `CANCELLED` (from PENDING, FAILED or EXPIRED), and a new one is created. If the old intent is already SUCCEEDED, no new intent is created: the response returns that intent and the subscription activates (TD-11).
  - ACTIVE subscription → existing staging rules (unchanged). Staging a plan change needs no payment, so it is not flag-gated.
- **Errors**: as today, plus `503 PAYMENTS_UNAVAILABLE` and `503 PAYMENT_GATEWAY_UNAVAILABLE`.

### NEW `GET /api/v1/payments/intents/:intentId`

- **Auth**: owner of the intent, or staff. `:intentId` has a UUID pattern (§11.2).
- **Rate limit**: `rl:payment-status`, 60/min/user (separate from `rl:payment`, TD-5).
- **No provider call.** It reads our database only.
- **200**:

```json
{
  "data": {
    "intentId": "uuid",
    "purpose": "DRIVER_COMMISSION_RECHARGE",
    "status": "PENDING | SUCCEEDED | FAILED | EXPIRED | IN_REVIEW | REFUNDED",
    "amount": 500,
    "currency": "INR",
    "createdAt": "…",
    "effect": { "walletBalance": 620 },
    "supportReference": "PAY-1A2B3C4D"
  }
}
```

- `effect` for a subscription is `{ "subscriptionId", "subscriptionStatus", "startDate", "expiryDate" }`. It is `null` until the effect has committed.
- Status mapping:
  - `PENDING`/`PROCESSING` → `PENDING`;
  - `MANUAL_REVIEW` → `IN_REVIEW`;
  - `CANCELLED` whose review case is `RESOLVED_REFUND` → `REFUNDED`;
  - any other `CANCELLED` → `EXPIRED` (shown as "Not completed").
- **Errors**: `404 PAYMENT_NOT_FOUND`.

### NEW `POST /api/v1/payments/intents/:intentId/verify`

- **Auth**: owner of the intent. Rate limit `rl:payment`. `Idempotency-Key` required (the app's interceptor adds it; the path is added to `IDEMPOTENT_POST_PATHS`).
- **Body**: `{ "razorpayPaymentId": "pay_…", "razorpayOrderId": "order_…", "razorpaySignature": "hex" }`. These are the fields from the Standard Checkout success callback.
- **Processing** (TD-4):
  1. Load the intent and check ownership.
  2. If `razorpayOrderId` ≠ the stored order id → `400 PAYMENT_ORDER_MISMATCH`, with a security log line and metric.
  3. Compute `HMAC_SHA256(storedOrderId + "|" + razorpayPaymentId, key_secret)` and compare in constant time. A mismatch → `400 PAYMENT_SIGNATURE_INVALID`, a security metric, and no state change.
  4. Outside any transaction: `GET /v1/payments/{razorpayPaymentId}`.
  5. Run the validation gate and `applyConfirmation` in one transaction (same path as webhooks).
- **200**: same body as `GET /payments/intents/:intentId`. A non-terminal provider status returns `PENDING`, and the app keeps polling.
- **Errors**: `404 PAYMENT_NOT_FOUND`, `400 PAYMENT_ORDER_MISMATCH`, `400 PAYMENT_SIGNATURE_INVALID`, `503 PAYMENT_GATEWAY_UNAVAILABLE` (retry is safe).

### UNCHANGED path, CHANGED internals: `POST /api/v1/payments/intents/:intentId/confirm`

- It now uses the provider-truth function (`GET /v1/orders/{id}/payments`, TD-2) and the validation gate.
- It is kept for staff and support. The app must use `verify` plus `GET` instead (the response cache and the shared 20/h bucket make it unsuitable for polling).
- **CHANGED**: a caller who is neither owner nor staff gets `404 PAYMENT_NOT_FOUND`, the same as a missing intent. Today it answers 403 (CD-15). `:intentId` is validated as a UUID.

### CONDITIONAL (TD-1b only) hosted checkout page

This exists only if T005 selects TD-1b **and** the Owner approves UD-12. It is a token-authenticated page serving Razorpay's web checkout for one intent:

- the token is single-use, bound to the intent and its driver, and expires within minutes;
- Razorpay's `callback_url` posts to the backend, which runs the same steps as `verify`, then redirects to `zarooratdriver://payments/return?intentId=…`;
- the page itself never moves money.

Its exact path and token format are fixed in T042b and reviewed under TM-34.

### UNCHANGED `GET /api/v1/drivers/:driverId/commission-wallet` and `/transactions`

- No contract change. The app fixes how transaction signs are displayed (FR-056).

### UNCHANGED `GET /api/v1/app-config`

- `featureFlags["payments.driver_checkout"]` drives the app's recharge button; `featureFlags["payments.subscription_checkout"]` drives the subscribe button (TD-12). The backend check is the control; the app hiding a button is only courtesy.

## Admin Panel endpoints

All are under `/api/v1/admin`, staff-authenticated. Every POST requires `Idempotency-Key` and writes `recordAdminAction` in the same transaction (§17.4).

| Method & route                                                              | Permission                          | Purpose                                                                                    | Notes                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NEW** `GET /finance/payment-review-cases?status&kind&cursor&limit`        | `finance:read`                      | Review queue                                                                               | Filters are applied in the query, before pagination                                                                                                                                                                                                             |
| **NEW** `GET /finance/payment-review-cases/:id`                             | `finance:read`                      | Case detail with sanitised evidence                                                        |                                                                                                                                                                                                                                                                 |
| **NEW** `POST /finance/payment-review-cases/:id/resolve`                    | `finance:execute`                   | Body `{ "resolution": "CREDIT" \| "REFUND", "note": "…" }` (note required)                 | Conditional claim on `OPEN`; `409 REVIEW_CASE_ALREADY_RESOLVED`; CREDIT allowed only under UD-1 (never for `MULTIPLE_CAPTURES`), else `422 REVIEW_CREDIT_NOT_ALLOWED`; REFUND creates a refund through `RefundService`; a second approver per UD-6 once decided |
| **NEW** `GET /finance/payments/lookup?q=`                                   | `finance:read`                      | Find by intent id, `order_…`, `pay_…` or driver id                                         | Returns the intent, its payment rows, its `gateway_events` (ids, types, outcomes, attempts; never payloads), its review case and refunds (FR-063). Exact-match only; `q` is validated by pattern                                                                |
| **NEW** `GET /finance/payments/reconciliation-runs?job&status&cursor&limit` | `finance:read` or `operations:read` | Latest runs and counts per job, plus open mismatches (FR-064)                              | Reads `payment_reconciliation_runs`                                                                                                                                                                                                                             |
| **NEW** `GET /finance/drivers/:driverId/commission-wallet?cursor&limit`     | `finance:read`                      | Real balance + transactions                                                                | Replaces fabricated tab data (D-10)                                                                                                                                                                                                                             |
| **NEW** `GET /payments/outbox/dead-letters?cursor&limit`                    | `operations:read`                   | Dead-lettered payment and subscription events                                              | Payload shown sanitised (ids only)                                                                                                                                                                                                                              |
| **NEW** `POST /payments/outbox/:eventId/requeue`                            | `operations:write`                  | Re-run one event (D-5)                                                                     | Conditional `FAILED → PENDING`; `409 OUTBOX_EVENT_NOT_REQUEUEABLE`                                                                                                                                                                                              |
| **CHANGED** `POST /finance/refunds/:id/approve`                             | `finance:execute`                   | —                                                                                          | Row-locked; changing `approvedAmount` when refund `status ≠ PENDING` → `409 REFUND_AMOUNT_LOCKED` (D-7)                                                                                                                                                         |
| **UNCHANGED** `GET/PUT /settings/integrations/payment`                      | `settings:read` / `settings:write`  | Razorpay credentials (encrypted)                                                           | Gains an optional "previous webhook secret" field for rotation (FR-024)                                                                                                                                                                                         |
| **UNCHANGED** `/settings/feature-flags`                                     | existing                            | Toggle `payments.driver_checkout`, `payments.subscription_checkout`, `payments.pilot_mode` | Turning `payments.pilot_mode` off is expansion and needs G8                                                                                                                                                                                                     |

## Razorpay webhook

### CHANGED `POST /api/v1/payments/webhooks/razorpay` (public, `rl:webhook`)

| Case                                                                              | Response                                                                                  | Stored?                                                                                                          | Effect                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Missing `X-Razorpay-Signature` / bad HMAC (current and previous secret both fail) | `401 WEBHOOK_SIGNATURE_INVALID`                                                           | No                                                                                                               | None; metric + log (no body)                            |
| Missing `X-Razorpay-Event-Id` and no fallback id                                  | `400 WEBHOOK_EVENT_ID_MISSING`                                                            | No                                                                                                               | None                                                    |
| Event id already stored with `processed = true` (any age)                         | `200 { received: true, isDuplicate: true }`                                               | —                                                                                                                | None                                                    |
| Event id stored with `processed = false` (an earlier attempt failed)              | Processed again, as below                                                                 | Attempts + 1                                                                                                     | As below                                                |
| `created_at` older than `RAZORPAY_WEBHOOK_MAX_AGE_SEC` (72 h)                     | `200 { received: true, outcome: "TOO_OLD" }`                                              | Yes, `processed=true`                                                                                            | None; alert; reconciliation resolves                    |
| `payment.captured` / `order.paid` passing the gate                                | `200 { outcome: "APPLIED" }`                                                              | Yes                                                                                                              | Credit or activation event, exactly once                |
| Captured but gate mismatch                                                        | `200 { outcome: "MISMATCH" }`                                                             | Yes                                                                                                              | Review case; no credit                                  |
| Failure / downgrade after success                                                 | `200 { outcome: "STALE_IGNORED" }`                                                        | Yes                                                                                                              | None; metric                                            |
| Order not known                                                                   | `200 { outcome: "UNKNOWN_ORDER" }`                                                        | Yes                                                                                                              | None; warning                                           |
| Other event types (`payment.authorized`, `refund.*`)                              | `200 { outcome: "NO_ACTION" }`; `refund.*` triggers refund reconciliation for that refund | Yes                                                                                                              | None directly                                           |
| Processing failure (database error, unexpected exception)                         | `500`                                                                                     | Yes, via a separate transaction: `outcome = PROCESSING_FAILED`, `processed=false`, attempts + 1, sanitised error | None; Razorpay retries (≤ 24 h, accepted up to 72 h)    |
| Processing failure at attempt `RAZORPAY_WEBHOOK_MAX_PROCESSING_ATTEMPTS` (5)      | `200 { outcome: "PARKED" }`                                                               | Yes, `processed=true`                                                                                            | None; page; reconciliation applies the payment (TD-15a) |

**Order of checks**:

1. Signature (current secret, then the previous one inside its window).
2. Event id.
3. `INSERT … ON CONFLICT (gateway, gateway_event_id) DO NOTHING`, then `SELECT … FOR UPDATE` on the event row.
4. **Dedupe**: `processed = true` → duplicate.
5. Age.
6. Parse and gate.

Steps 3–6 run in one transaction. A failure is recorded by a second, separate transaction (data-model §4).

### CHANGED `POST /api/v1/payments/webhooks/stripe` (dormant provider)

Freshness comes from the signed `t=` header tolerance only. The payload `created` check is removed (Stripe re-signs every retry).

## Error code additions

| Code                           | HTTP | Module         |
| ------------------------------ | ---- | -------------- |
| `PAYMENTS_UNAVAILABLE`         | 503  | payments       |
| `PAYMENT_GATEWAY_UNAVAILABLE`  | 503  | payments       |
| `PAYMENT_SIGNATURE_INVALID`    | 400  | payments       |
| `PAYMENT_ORDER_MISMATCH`       | 400  | payments       |
| `REVIEW_CASE_NOT_FOUND`        | 404  | admin finance  |
| `REVIEW_CASE_ALREADY_RESOLVED` | 409  | admin finance  |
| `REVIEW_CREDIT_NOT_ALLOWED`    | 422  | admin finance  |
| `REFUND_AMOUNT_LOCKED`         | 409  | admin finance  |
| `OUTBOX_EVENT_NOT_REQUEUEABLE` | 409  | admin payments |

Every code gets a `messageKey` (`error.<lowercased code>`) and copy in the app's `en`/`hi`/`ur` strings.
