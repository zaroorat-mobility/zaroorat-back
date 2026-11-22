# Provider Contract: Razorpay (outbound calls and inbound webhooks)

**Feature**: `005-razorpay-driver-payments` | **Date**: 2026-10-19 | **Sources**: [research.md](../research.md) R-2, R-4, R-5, R-9

This file is the only place that states what the backend sends to Razorpay and how Razorpay's answers are interpreted. The adapter (`src/integrations/razorpay/razorpay.client.ts`) implements it. Everything above the adapter works with the normalised shapes at the end of this file.

## Connection

| Item                 | Value                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base URL             | `https://api.razorpay.com/v1` (test and live share the host; the key pair selects the mode)                                                                  |
| Auth                 | HTTP Basic `key_id:key_secret`, from the encrypted admin setting or env (existing resolver)                                                                  |
| Timeout              | 15 s per request (existing). A timeout is an **unknown outcome**, never a failure                                                                            |
| Retries              | GETs: retried by the calling job on its next run. `POST /orders`: retried only with the same deterministic receipt. Refunds: same `X-Refund-Idempotency` key |
| Keys per environment | dev → test keys or the mock gateway; staging → **test** keys; production → **live** keys only (FR-070)                                                       |

## Outbound calls

### 1. Create order — `POST /orders`

| Field             | Value                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amount`          | integer paise = `intent.amount × 100` (intent amount has at most 2 decimals)                                                                                                                                                          |
| `currency`        | `INR`                                                                                                                                                                                                                                 |
| `receipt`         | `zr1_` + first 32 hex chars of SHA-256(scoped idempotency key). 36 ASCII chars. The documented limit is 40; **test mode enforces 56** (S2a, 2026-10-20). 36 fits both                                                                 |
| `notes`           | `{ "purpose": "<intent purpose>", "driver_ref": "<driver uuid>" }`. No names, phone numbers or emails. (Implemented by T016, 2026-10-21; previously `{ userId, rideId }`. `driver_ref` is omitted if the payer has no driver profile) |
| `partial_payment` | `false`, sent explicitly. Razorpay allows multiple payments on one order only when it is `true`                                                                                                                                       |

Response used: `id` (order id), `status`, `amount`, `currency`.

**Duplicate receipt — corrected by sandbox evidence (T003, 2026-10-20).**

- Razorpay documents a reused receipt as `400 "Duplicate request. This request has already been processed."`. In test mode the **same receipt was accepted twice, creating two orders, with no error** (S2c).
- `GET /orders?receipt=` found them only about 2 minutes later (S2d).
- So a receipt does not make order creation idempotent, and a "400 → look up by receipt" recovery can never trigger. **That recovery is withdrawn**; its replacement is pending Owner review (decisions.md TD-3).
- Until then, a 400 from this call is a plain gateway error: the intent is not created, and the caller retries with the same key.
- A crash between Razorpay creating the order and our database recording it leaves an **unpaid, orphan order**. No payment is possible on it, because the app only ever receives the order id our response returns.

### 2. Payments of an order — `GET /orders/{orderId}/payments` (provider truth, TD-2)

Used by reconciliation and the staff `confirm` route. Razorpay documents that it returns "all the authorised or failed payments for that order" (captured ones included) and documents no pagination. **Verified in test mode (S1, S3)**: a failed attempt followed by a captured one returns both, in creation order, each with `order_id`, `amount` (paise), `currency`, `status` and `captured`. Selection rules, applied in order:

1. Discard items whose `order_id` ≠ `orderId`. This is defensive and should never happen.
2. Captured items = `status == "captured"`. Exactly one → it is the candidate, and the validation gate checks `amount` and `currency`. More than one → the first goes to the gate, the rest go to review as `MULTIPLE_CAPTURES`.
3. No captured items but some `authorized` → **pending** (auto-capture will follow; never credit).
4. All items `failed` → **failed** (the intent may still succeed later via another attempt).
5. No items → **no payment** (counts toward expiry after 5 days, D-3).

The normalised result returned upward:
`{ kind: "captured" | "pending" | "failed" | "none", payment?: { id, orderId, amountPaise, currency, status, method, createdAt } }`

### 3. One payment — `GET /payments/{paymentId}`

Used by `verify`. The response passes through the same gate (order id, captured, amount, currency). `authorized` → pending.

### 4. Find order by receipt — `GET /orders?receipt=<receipt>`

Documented filter; works in test mode, but lags creation by about 2 minutes (S2d). **No code path uses it**, so T015 did not add it to the provider interface (2026-10-21): its only caller was the TD-3 recovery that S2c/S2d withdrew. Add it with the first investigation tool or TD-3 replacement that needs it.

### 5. Refund — `POST /payments/{paymentId}/refund`

| Item      | Value                                                               |
| --------- | ------------------------------------------------------------------- |
| Header    | `X-Refund-Idempotency: <refund.id>` (UUID, ≥ 10 chars per Razorpay) |
| `amount`  | paise                                                               |
| `receipt` | `refund.id` (36 chars)                                              |
| `notes`   | `{ "refund_reference": "<refund.id>" }` (existing)                  |

`paymentId` must be a `pay_…` id. A 409 while a prior request is processing counts as unknown → retry later with the same header.

Razorpay rejects a retry whose body differs from the first request under the same key. **Observed in test mode (S11c): HTTP 409**, `BAD_REQUEST_ERROR`, "Different request with the same idempotency key has already been processed." The docs say 400. An identical retry returned the **same** refund (S11b). A retry must therefore resend the identical `amount`, `receipt` and `notes`, which is why the amount is immutable once reserved (D-7). The **minimum refund is ₹1.00**: a smaller amount gets `400` "The amount must be atleast INR 1.00" (S11a), which is a genuine rejection. The key's validity period is not documented (U7): a retry later than the refund reconciliation horizon first runs call 6 (find-before-create).

**Classifying errors**:

- A 400 returned under an `X-Refund-Idempotency` key is **unknown**, not a rejection. The refund stays PROCESSING, and nothing is restored until Razorpay's refund list or status says otherwise. The exact error body is recorded at S11 and mapped in T085.
- Other 4xx responses (except 408, 409, 425 and 429) remain definitive rejections, as today (`refund.service.ts:521-528`).

### 6. Refunds of a payment — `GET /payments/{paymentId}/refunds`

Existing find-before-create, kept as a second safety net.

### 7. Provider sweep listing — `GET /payments?from=<unix s>&to=<unix s>&count=100&skip=<n>` (TD-16)

- Only these four parameters are documented; `order_id` is **not** a filter.
- Pages with `skip` until a page returns fewer than `count` items.
- `from` = the earlier of (now − 48 h) and (the last successful sweep's `window_end` − 30 min); `to` = now. A sweep outage never skips payments.
- Each item passes through the INV-7 classification (data-model §10).
- Items with `captured = false` are ignored, including authorised payments Razorpay auto-refunded after the capture timeout.
- The sweep reads `notes` only to help Finance identify an `UNKNOWN_ORDER`, never to decide whom to credit.

### Not used

`GET /payments?order_id=…` (undocumented; removed), Payment Links, Subscriptions API, S2S UPI, settlements recon (separate accounting feature).

## Inbound webhooks

| Item             | Rule                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL              | `POST /api/v1/payments/webhooks/razorpay`                                                                                                                                                                                                                                                              |
| Signature        | `X-Razorpay-Signature` = hex HMAC-SHA256 of the **raw body** with the webhook secret. Accept the current secret, or the previous one inside the rotation window (24–72 h, default 48 h). Razorpay documents that retries of events created before a secret change are still signed with the old secret |
| Event id         | `X-Razorpay-Event-Id`. Not covered by the signature, so it is used for deduplication only, never as a security control                                                                                                                                                                                 |
| Age              | Body `created_at` (event creation, constant across retries). Max accepted age 72 h (D-1)                                                                                                                                                                                                               |
| Response time    | Must answer within 5 s. The handler does database work only (no provider call)                                                                                                                                                                                                                         |
| Failure handling | Any non-2xx is a failed delivery. Razorpay retries for 24 h and **disables the webhook** if failures continue for 24 h, emailing the alert address. Hence 200 for every terminal outcome, including `TOO_OLD` and `PARKED`, and 5xx only for a failure that should be retried (FR-032, FR-034)         |

### Events and mapping (TD-7)

| Event                               | Fields read                                                                                                                                                                                          | Action                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `payment.captured`                  | `payload.payment.entity.{id, order_id, amount, currency, status}`                                                                                                                                    | Gate → apply / review                                         |
| `order.paid`                        | `payload.payment.entity.*` and `payload.order.entity.{amount, amount_paid, currency, status}` (both entities verified in Razorpay's order payload docs, 2026-10-19)                                  | Gate → apply / review (`amount_paid` must equal expected)     |
| `payment.failed`                    | `payload.payment.entity.{id, order_id, error_code, error_reason}`                                                                                                                                    | FAILED unless already SUCCEEDED (then `STALE_IGNORED`)        |
| `payment.authorized`                | entity                                                                                                                                                                                               | Record only (`NO_ACTION`)                                     |
| `refund.processed`, `refund.failed` | `payload.refund.entity.{id, payment_id, amount, status, receipt, notes}` (verified in Razorpay's refund payload docs; `refund.created` and `refund.speed_changed` also exist and are not subscribed) | Record; trigger refund reconciliation for the matching refund |

## Dashboard configuration (owner checklist, FR-070…FR-072)

1. Create test and live key pairs. Put the live key secret only in production config.
2. Payment capture: **automatic**, with the default **3-day** auto-capture timeout (record both in the `research.md` verification log). A shorter timeout makes Razorpay auto-refund late UPI authorisations.
3. Webhooks:
   - staging URL with **test** mode;
   - production URL with **live** mode;
   - subscribe to the six events above;
   - set a strong secret, and copy it to the backend only;
   - set the alert email to an on-call address (Razorpay emails it when it disables a failing webhook).
4. Optional: allow Razorpay's webhook source IPs at the load balancer.
   - Verified 2026-10-19: Razorpay publishes a "Webhook IPs" list (nine addresses and two /26 ranges) on its whitelists page, and calls signature validation necessary "even if you have whitelisted our Webhook IPs" (research R-10).
   - The page does not say how often the list changes. So an allowlist is a DevOps choice recorded in T102. If one is used, the runbook re-checks the page (K-17).
   - Signature checks remain mandatory either way.
5. Checkout branding (name, logo, colour). These are display settings only.
