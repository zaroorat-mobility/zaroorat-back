# HTTP API Contract: Payment & Fare Settlement

**Feature**: `002-payment-fare-settlement` | **Date**: 2026-08-23 | **Decisions applied**: 2026-08-23

All routes under the existing `/api/v1/payments` prefix unless stated. Authentication is deny-by-default (`auth.plugin.ts` authenticates every route without `config: { public: true }`; the gateway webhook is the only public payment route, and a test asserts it). `Idempotency-Key` is required on mutating payment routes — see the route-by-route audit at the end of this document, which records one existing gap (FR-040).

Legend: **NEW** · **CHANGED** · **UNCHANGED** (listed for context) · **REMOVED** (was proposed, cut as speculative).

---

## Online payment integrity rules

These bind every endpoint below and are the contract's most important section.

| Rule                                                                | How it is guaranteed                                                                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The client never controls the authoritative amount**              | Ride collection reads `RideFare.totalFare` from the database. It accepts no amount from any request body. The rider-facing retry endpoint carries no amount field at all.        |
| **The client never declares payment successful**                    | Only a signature-verified provider webhook, or a server-initiated provider status query, moves an intent to `SUCCEEDED`. No request body can assert success.                     |
| **A client cannot bind its own payment to a ride**                  | `rideId` is **removed** from the public `POST /intents` schema. Collection creates its own intent server-side and never resolves a ride to a client-created one.                 |
| **Provider confirmation is authoritative**                          | Existing `WebhookService` verification — signature, timestamp tolerance, missing-event-id rejection — is unchanged and remains the trust boundary.                               |
| **Duplicate webhooks are safe**                                     | Existing `findOrPersist` on `gatewayEventId` returns `isDuplicate` and short-circuits. Already tested (`payment-webhook.test.ts`).                                               |
| **Duplicate confirmation requests are safe**                        | `applyConfirmation` returns early when the intent already holds the target status, and validates the transition otherwise.                                                       |
| **Provider event identifiers are unique**                           | `GatewayEvent.gatewayEventId` is unique; a replay is detected before any effect.                                                                                                 |
| **No provider I/O inside a database transaction**                   | Provider call precedes `txManager.execute` in every path, following `IntentService.confirmIntent`'s existing shape.                                                              |
| **Database state and outbox events stay consistent**                | Every state change publishes its event via `eventPublisher.publish(input, tx)` in the same transaction.                                                                          |
| **Payment success cannot be applied twice**                         | Partial unique index permitting one `SUCCEEDED` `RidePayment` per ride, plus a conditional status claim, plus a deterministic provider idempotency key derived from the ride id. |
| **Completion/collection races cannot double-charge or double-earn** | Completion claims the ride status conditionally; collection claims `RidePayment` through the unique index. A second delivery of either finds the claim taken.                    |

---

## Wallet

### `POST /wallet/topup` — **CHANGED (behavioural; response shape preserved)**

Today this credits the caller's balance directly with no payment behind it. It will instead create a funding authorization; the balance moves only on provider confirmation.

**Request**

```json
{ "amount": 500.0, "methodType": "UPI", "paymentMethodId": "<uuid, optional>" }
```

**Response `201`** — **additive; no field is removed**

```json
{
  "data": {
    "intentId": "<uuid>",
    "amount": 500.0,
    "status": "PENDING",
    "gatewayIntentId": "<string>",
    "walletCredited": false,
    "id": "<wallet uuid>",
    "userId": "<uuid>",
    "balance": 0.0,
    "lockedBalance": 0.0,
    "availableBalance": 0.0,
    "currency": "INR"
  }
}
```

**Contract change, scoped as narrowly as possible.** The original correction proposed dropping the wallet fields; that would have been an avoidable shape break. Every existing field is **retained** — `balance` now reports the current, _uncredited_ balance rather than a credited one. A client parsing the response continues to work.

What unavoidably changes is behaviour: **`balance` no longer increases in this response**, because crediting without a confirmed payment is the defect being fixed. A client that asserts an increase must be updated. Whether a shipped client does so is a release-coordination item, recorded in [decisions.md](../decisions.md) §Release coordination — it is not a financial policy and does not block planning.

The credited balance appears via `GET /wallet/balance` after provider confirmation.

**Errors**: `400` invalid amount · `400` missing `Idempotency-Key` · `402` provider declined · `429` rate limited

### `GET /wallet/balance` — **UNCHANGED**

### `POST /wallet/hold` — **UNCHANGED**

Holds continue to reserve funds. **Capture is not added** — no ride flow creates a hold, so capturing one is deferred with FR-013.

### `POST /intents` — **CHANGED**

`rideId` is **removed from the request schema**. A client may fund its own wallet; it may not declare which ride its payment settles. See [research.md](../research.md) §12 for why this is a fare-bypass hole the moment collection reads `intent.rideId`.

`amount` remains client-supplied **for wallet funding only** — the rider chooses how much to top up, and the amount is charged to them, so there is no incentive to understate it. It is never the amount charged for a ride.

---

## Ride collection

### `GET /rides/:rideId/payment` — **NEW**

Payment state of one ride. Rider on the ride, driver on the ride, or staff.

**Response `200`**

```json
{
  "data": {
    "rideId": "<uuid>",
    "collectionState": "AWAITING_COLLECTION" | "AWAITING_CASH_CONFIRMATION" | "RETRYING" | "PAID" | "UNPAID" | "WRITTEN_OFF",
    "method": "WALLET",
    "amount": 247.50,
    "settledAt": "2026-08-23T10:14:02.000Z",
    "attempts": 1,
    "amountOwed": 0
  }
}
```

**The field is `collectionState`, not `paymentStatus`**, and **the token `FAILED` never appears in this API.** A failed _attempt_ and a standing _debt_ are different facts, and the internal column uses `FAILED` for the second — so the public surface uses a separate vocabulary to make the confusion impossible. `UNPAID` is standing debt; `RETRYING` is a failed attempt with budget remaining.

Full definitions and the derivation table: [data-model.md](../data-model.md) §2.1–2.2. `collectionState` is computed per request and never stored, so it cannot drift.

`amountOwed` is non-zero only when `collectionState` is `UNPAID`. A `WRITTEN_OFF` ride reports `0` — BD-1c closes the obligation, so it is no longer outstanding.

**Errors**: `404` ride not found **or** caller is not a party to it — the same response for both, matching the platform's existing non-enumeration behaviour.

### `POST /rides/:rideId/payment/retry` — **NEW**

Lets a rider settle an open obligation themselves. Rider on the ride only. Allowed while `collectionState` is `RETRYING` or `UNPAID`; serialized against the retry sweep by the same `payment:collect:{rideId}` lock, so the two can never both charge.

**Request**: `{ "paymentMethodId": "<uuid, optional>" }` — **no amount field**; the server charges the fare.

**Response `200`**: same shape as `GET /rides/:rideId/payment`.

**Errors**: `409` obligation already settled, or written off (BD-1c closes it) · `402` declined · `429` rate limited

**Never blocked by the debt threshold.** BD-2 blocks _new ride requests_, never settlement — refusing someone permission to pay you would be self-defeating.

### `POST /rides/:rideId/payment/confirm-cash` — **NEW** _(feature-flagged per [BD-5](../decisions.md#bd-5), default OFF)_

Driver confirms cash was collected. See §Cash collection rules below.

**Flag behaviour (BD-5, approved).** `PAYMENT_CASH_CONFIRMATION_REQUIRED` defaults to `false`. When disabled the route is **not registered**, so a request returns `404` — the approved wording is that no client may _access or execute_ the flow, which is stronger than accepting the call and rejecting it. When enabled, a cash ride completes at `PENDING` and this endpoint is the driver-facing path to `PAID`; automatic resolution per [BD-6](../decisions.md#bd-6) covers the case where the driver never calls it.

**Request**: `{ "collected": true }`

**Response `200`**: same shape as `GET /rides/:rideId/payment`.

**Errors**: `403` caller is not the ride's driver · `409` not a cash ride, or already confirmed _(a repeat with the same `Idempotency-Key` replays the original response instead)_

---

## Cash collection rules

Derived from the existing ride ownership, lifecycle and authorization architecture — not from generic ride-hailing assumptions.

| Question                                                   | Rule                                                                                                                                                                                                                                                                                                                                                      | Basis in existing code                                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When may a driver confirm?**                             | Only when `ride.status = COMPLETED`, `ride.paymentMethod = CASH`, and `ride.paymentStatus = PENDING`.                                                                                                                                                                                                                                                     | Mirrors `validateTransition`'s explicit allowed-transition map; no confirmation before the trip ends.                                                                   |
| **Who may confirm?**                                       | Only the assigned driver — `ride.driverId` must equal the caller's driver id.                                                                                                                                                                                                                                                                             | `lockAndValidate` already raises `RideDriverMismatchError` on exactly this check for every driver action; the endpoint reuses it rather than re-implementing ownership. |
| **What prevents confirming a ride they did not complete?** | Two independent guards: the `ride.driverId` equality check above, and the `status = COMPLETED` requirement. A driver only becomes `ride.driverId` by winning an offer through the offer-gated acceptance path, and only reaches `COMPLETED` by calling `completeRide`, which applies the same ownership check.                                            | `lockAndValidate` + the dispatch offer gate.                                                                                                                            |
| **Is duplicate confirmation idempotent?**                  | Yes, at three layers: mandatory `Idempotency-Key` replays the original response; the ride status is claimed conditionally `PENDING → PAID`; the partial unique index permits one `SUCCEEDED` `RidePayment`. Commission is booked exactly once.                                                                                                            | Existing `withIdempotency`, existing `updateStatusIf` pattern, new index.                                                                                               |
| **May the customer dispute it?**                           | **No dispute path in V1.** `RideDispute` is unwritten and the workflow is out of scope. A confirmed cash ride stays `PAID`. Recorded explicitly so the gap is known rather than discovered in production.                                                                                                                                                 | —                                                                                                                                                                       |
| **What if the driver falsely confirms?**                   | It costs the driver, not the platform: confirming books the commission they owe on cash they did not receive. The incentive runs against false confirmation, so no additional guard is warranted.                                                                                                                                                         | `recordTripPayment` cash branch — `DRIVER_PAYABLE` debit.                                                                                                               |
| **What if the driver never confirms?**                     | **[BD-6](../decisions.md#bd-6) — open.** This is the real abuse vector: never confirming keeps the cash and avoids the commission. Recommended resolution is auto-confirmation after a grace period, marked in the ledger description so it is distinguishable on audit.                                                                                  | —                                                                                                                                                                       |
| **Is the fare immutable before collection?**               | Yes. `RideFare` is written once at completion and never updated; `RidePayment.amount` is copied from `RideFare.totalFare`. `assertPlausibleTripData` already guards the distance and duration inputs that produce it.                                                                                                                                     | Existing `RideFareRepository.create` (no update method) + `assertPlausibleTripData`.                                                                                    |
| **How does it affect earnings and commission?**            | The driver holds 100% of the fare in cash. The platform's commission becomes a driver liability: `DRIVER_PAYABLE` debit + `PLATFORM_COMMISSION` credit — the entries `recordTripPayment`'s cash branch **already** posts. This feature moves them from completion to confirmation, so the books record the obligation only once the cash is acknowledged. | Existing `recordTripPayment` cash branch.                                                                                                                               |
| **Does confirmation gate the driver's next ride?**         | **No.** `completeRide` already returns the driver to `ONLINE` and that is unchanged. An unconfirmed cash ride is a books concern, never a dispatch gate.                                                                                                                                                                                                  | Existing `driverStatusRepository.updateStatus(driverId, 'ONLINE')` in `completeRide`.                                                                                   |

---

## Receipts

### `GET /rides/:rideId/receipt` — **CHANGED**

The route exists. What changes: the receipt is guaranteed to exist for any ride whose payment outcome is known, rather than being generated on first request. The lazy path remains as a fallback for historical rides.

Response adds a `payment` block to the existing snapshot:

```json
{
  "data": {
    "receiptNumber": "ZR-2026-000148213",
    "issuedAt": "2026-08-23T10:14:02.000Z",
    "fare": { "...itemized, unchanged..." },
    "payment": { "method": "WALLET", "status": "PAID", "settledAt": "..." }
  }
}
```

---

## Debt

### `GET /me/debt` — **NEW**

What the caller owes. A rider sees unpaid rides; a driver sees commission accrued from cash rides.

```json
{
  "data": {
    "outstanding": 120.0,
    "currency": "INR",
    "limit": 500.0,
    "blocked": false,
    "items": [{ "rideId": "<uuid>", "amount": 120.0, "since": "2026-08-21T09:00:00.000Z" }]
  }
}
```

**Rider view** — `blocked` is `true` once `outstanding >= limit`, **reaches or exceeds**, per the approved BD-2. It gates **ride-request creation only**; it never gates settling an existing obligation.

`outstanding` is `SUM(RideFare.totalFare)` over that rider's rides in `UNPAID`, **excluding** `WRITTEN_OFF` rides, which are no longer outstanding (BD-1c). It is computed server-side from the database on every request — never from client input, never cached.

**Driver view** — informational only. BD-3 approved **no driver blocking**, so `limit` and `blocked` are omitted for drivers. The figure shown is commission accrued from cash rides, recovered through settlement netting (FR-021), never through a block.

---

## Settlement and payout

### `POST /api/v1/admin/payments/payouts` — **UNCHANGED behaviour · RELOCATED**

Staff-only, ceiling-bounded, idempotent. `PayoutService` is byte-unchanged. **Relocated** to the admin module by the in-flight work and verified serving at `/api/v1/admin/payments/payouts`; `payout-authorization` is 20/20 green. **Behaviour does not change**; only the settlement figure it bounds against becomes accurate. Called out because its ceiling and concurrency tests are correct today and must stay green **unmodified**.

### `POST /refunds` — **UNCHANGED**

Ride-linked reversal of driver earnings is deferred (FR-029). The existing endpoint is untouched.

### ~~`GET /drivers/me/settlements`~~ — **REMOVED**

Cut as speculative in the correction pass: no functional requirement, no acceptance scenario, no test mapped to it.

---

## Webhooks

### `POST /webhooks/:gateway` — **CHANGED (downstream only)**

Public, signature-verified, replay-rejecting — **all unchanged**. What changes is downstream: a confirmation for a funding intent now credits the wallet balance, and one for a ride-linked intent completes that ride's collection.

**Explicitly preserved**: signature verification, missing-event-id rejection, timestamp tolerance, duplicate detection. No change to any of these is in scope.

---

## Cross-cutting

| Concern         | Contract                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization   | Rider: own wallet, own rides, own debt. Driver: own rides, own earnings, own debt. Staff: payouts, adjustments, refunds beyond a rider's own |
| Path parameters | Every `:rideId` carries a UUID pattern in the route schema — malformed returns `400`, never `500`                                            |
| Money in JSON   | Decimal, 2 places, `INR` only                                                                                                                |
| Errors          | Existing coded-error envelope; no new error format                                                                                           |

---

## Idempotency — verified route by route

The existing mechanism is **Redis-backed** (`IdempotencyRepository.runIdempotent`), keyed `{userId}:{route}:{idempotencyKey}`, with the payload hashed via a sorted-key stable stringify. TTL is `paymentConfig.idempotencyTtlSeconds`, default **86400s (24h)**. **No second mechanism is introduced** — the `IdempotencyKey` Prisma model in `admin.prisma` is unused and stays unused.

| Condition                            | Behaviour                                                            |
| ------------------------------------ | -------------------------------------------------------------------- |
| Header missing or blank              | `IdempotencyKeyRequiredError` — rejected before any effect           |
| Same key + same payload              | Original response replayed; the operation does not run again         |
| Same key + **different** payload     | `DuplicateIdempotencyKeyError` — rejected                            |
| Same key, first call still in flight | `runOnce` serializes; the second caller receives the first result    |
| Operation throws                     | The key is released, so a genuine retry can succeed                  |
| Key scope                            | Per user **and** per route — one user cannot replay another's result |

### Coverage audit — the blanket claim was false

`withIdempotency` has **exactly five call sites**: `createIntent`, `topup`, `hold`, `processRefund`, `executePayout`.

| Route                                      | Mutating | Uses `withIdempotency` | Status                                                                                  |
| ------------------------------------------ | -------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `POST /wallet/topup`                       | yes      | ✅                     | correct                                                                                 |
| `POST /wallet/hold`                        | yes      | ✅                     | correct                                                                                 |
| `POST /intents`                            | yes      | ✅                     | correct                                                                                 |
| **`POST /intents/:intentId/confirm`**      | **yes**  | **❌**                 | **gap — FR-040**                                                                        |
| `POST /refunds`                            | yes      | ✅                     | correct                                                                                 |
| `POST /payouts`                            | yes      | ✅                     | correct                                                                                 |
| `POST /webhooks/:gateway`                  | yes      | n/a                    | correct by a different, appropriate mechanism: unique `gatewayEventId` replay detection |
| `POST /rides/:rideId/payment/retry`        | yes      | _(new)_                | **must** use it                                                                         |
| `POST /rides/:rideId/payment/confirm-cash` | yes      | _(new)_                | **must** use it                                                                         |

`POST /intents/:intentId/confirm` is safe _in effect_ — `applyConfirmation` returns early when the intent already holds the target status, and `validateTransition` rejects illegal moves — but it is safe by an incidental guard rather than by the platform mechanism the contract claims. **FR-040 brings it into `withIdempotency`.** Until then, this contract's idempotency statement is scoped to the routes above rather than asserted universally.
