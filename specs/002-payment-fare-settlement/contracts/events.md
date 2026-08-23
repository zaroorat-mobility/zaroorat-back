# Event Contract: Payment & Fare Settlement

**Feature**: `002-payment-fare-settlement` | **Date**: 2026-08-23 | **Decisions applied**: 2026-08-23

All events publish through the existing transactional outbox — `EventPublisher.publish(input, tx)` writes to `outbox_events` in the same transaction as the state change it describes. `OutboxRelay` drains them onto the in-process `EventBus`. **The outbox architecture is unchanged: no new transport, no new relay, no direct emission.**

**New event count: 3** — two collection-outcome events plus the write-off event required by the approved BD-1c. (Was 4 in the first draft; two were cut for duplicate meaning, one added by an approved decision.)

---

## Consumed

### `ride.completed` — existing, one new subscriber

|                             |                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Producer**                | `LifecycleService.completeRide`                                                                                                                            |
| **Publishing transaction**  | The existing ride-completion transaction — unchanged by this feature                                                                                       |
| **Payload source of truth** | `Ride` and the `RideFare` written in that same transaction                                                                                                 |
| **New consumer**            | `RideCollectionConsumer` → `RideCollectionService.collect(rideId)`                                                                                         |
| **Idempotency expectation** | At-least-once delivery. The consumer must be safe to run repeatedly; safety comes from the partial unique index on `ride_payments`, **not** from the relay |

**Payload (unchanged)**: `{ "rideId", "driverId", "totalFare" }`

**Envelope caveat**: `buildEnvelope` drops `aggregateId` and `subject.userId` is null for ride events, so the consumer must read `rideId` from `envelope.data`. The existing ride consumers already work under this constraint; getting it wrong yields a consumer that silently does nothing.

---

## Published — three new types

All three use the existing `paymentEvent(...)` helper (producer `payments`, aggregate type `payment`). The helper's `classification` keyword rule must be extended so these classify as `audit`.

### `payment.ride.collected`

|                             |                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Producer**                | `RideCollectionService`                                                                                                                                                                    |
| **Publishing transaction**  | The single collection transaction — state-machine transitions 2, 3, 4a, 4b, 7a and 7b                                                                                                      |
| **Payload source of truth** | `RidePayment` (amount, method, settledAt) and `RideFare` (commission). Never a request body                                                                                                |
| **Consumers**               | Realtime bridge (rider completion screen), notification consumer (payment confirmation)                                                                                                    |
| **Idempotency expectation** | Published exactly once per ride, because the transaction that publishes it is guarded by the partial unique index. A consumer that receives it twice (relay redelivery) must be idempotent |

```json
{
  "rideId": "<uuid>",
  "customerId": "<uuid>",
  "driverId": "<uuid>",
  "amount": 247.50,
  "method": "WALLET" | "CARD" | "UPI" | "CASH",
  "intentId": "<uuid|null>",
  "commissionOwed": 37.13,
  "settledAt": "2026-08-23T10:14:02.000Z"
}
```

`commissionOwed` is non-zero only for `CASH`, where the driver holds the fare and owes the platform its commission. **Driver-balance consumers derive cash commission from this field** — which is why no separate cash event is needed.

### `payment.ride.collection_failed`

|                             |                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Producer**                | `RideCollectionService` (transition 5) or the retry sweep job (transitions 5 and 6)                                                                                                  |
| **Publishing transaction**  | The attempt-recording transaction. With `willRetry: false` it is transition 6's transaction — **the one that establishes the customer receivable**                                   |
| **Payload source of truth** | The `RidePayment` attempt row and the configured attempt cap                                                                                                                         |
| **Consumers**               | Realtime bridge, notification consumer                                                                                                                                               |
| **Idempotency expectation** | `willRetry: true` may legitimately publish more than once per ride (one per attempt). `willRetry: false` publishes exactly once, because the `PENDING → FAILED` claim is conditional |

```json
{
  "rideId": "<uuid>",
  "customerId": "<uuid>",
  "amount": 247.5,
  "method": "CARD",
  "reason": "<provider decline code or internal reason>",
  "attempt": 3,
  "willRetry": true
}
```

**`willRetry: false` is the receivable-establishing signal.** Consumers needing "this rider now owes money" key off exactly that. It is published in the same transaction that posts the `CUSTOMER_RECEIVABLE` debit (BD-1).

---

### `payment.receivable.written_off`

Required by **BD-1c**, which mandates that the write-off be auditable.

|                             |                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Producer**                | Write-off sweep job                                                                                                                             |
| **Publishing transaction**  | Transition 8 single transaction — `WRITTEN_OFF` attempt row + `BAD_DEBT_EXPENSE`/`CUSTOMER_RECEIVABLE` ledger group + event                     |
| **Payload source of truth** | `RideFare.totalFare` and the `RidePayment` write-off row                                                                                        |
| **Consumers**               | None in V1. Published for finance and audit consumers; **no rider notification** — telling a customer their debt was written off invites gaming |
| **Idempotency expectation** | Exactly once per ride, guaranteed by the partial unique index on `WRITTEN_OFF`. A repeated sweep violates the index and publishes nothing       |

```json
{
  "rideId": "<uuid>",
  "customerId": "<uuid>",
  "amount": 247.5,
  "outstandingSince": "2026-07-15T10:14:02.000Z",
  "writtenOffAt": "2026-08-23T00:00:00.000Z"
}
```

---

## Removed — duplicate meaning

### ~~`payment.debt.recorded`~~ — **REMOVED this pass**

It was published in the **same transaction** as `payment.ride.collection_failed(willRetry: false)`, describing the **same state transition**. Two events for one transition is duplicate meaning, and a consumer subscribing to both would notify the rider twice about one unpaid ride.

Debt is fully derivable from the retained events: obligation debt from `collection_failed` with `willRetry: false`, cash commission from `collected` with `commissionOwed > 0`.

### ~~`payment.cash.confirmed`~~ — **REMOVED in the previous pass**

Cash confirmation _is_ a collection. `payment.ride.collected` with `method: "CASH"` carries identical meaning.

---

## Boundary — events that look overlapping but are not

Three existing events fire alongside the new ones. Each pair is genuinely different, and the boundary is stated here so nobody treats them as interchangeable.

| Pair                                                           | Why they are different                                                                                                                                                                                                                                                                     | Rule that prevents double-acting                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment.succeeded` **vs** `payment.ride.collected`            | `payment.succeeded` is an **instrument-level** fact: a `PaymentIntent` settled at the provider. `payment.ride.collected` is an **obligation-level** fact: a ride's debt is discharged. For a card ride both fire; for wallet and cash rides there is no intent, so only `collected` fires. | **Ride-facing consumers (realtime, notification) subscribe to `payment.ride.collected` only, never to `payment.succeeded`.** Otherwise a card ride notifies twice.                                                      |
| `payment.wallet.debited` **vs** `payment.ride.collected`       | `debited` is a **wallet** fact (a balance moved, for any reason). `collected` is a **ride** fact. A wallet top-up reversal would emit `debited` with no ride at all.                                                                                                                       | Wallet-ledger consumers use `debited`; ride consumers use `collected`. Both fire in transition 2's single transaction, which is correct — two true statements about one transaction, not two versions of one statement. |
| `payment.settlement.completed` **vs** `payment.ride.collected` | `collected` is per-ride and immediate. `settlement.completed` is per-driver-period and derived.                                                                                                                                                                                            | No overlap; different aggregates, different cadence.                                                                                                                                                                    |

`payment.wallet.debited` is already defined in the catalog and has **never been published**, because nothing debits a wallet. The new debit path publishes it — **no new event required**.

---

## Realtime bridge

Two entries added to the existing ride-event map in `src/modules/rides/consumers/ride-realtime.consumer.ts`:

| Domain event                     | Socket event           | Room            |
| -------------------------------- | ---------------------- | --------------- |
| `payment.ride.collected`         | `ride:payment_settled` | `ride:{rideId}` |
| `payment.ride.collection_failed` | `ride:payment_failed`  | `ride:{rideId}` |

**The socket is updated from the outbox, never from the collection service directly.** Emitting faster by skipping the outbox would let a rider see a payment the database does not record.

---

## Registration

One entry appended to `CONSUMER_KEYS` in `src/bootstrap/events.bootstrap.ts`:

```ts
'rideCollectionConsumer',
```

That list is the single place consumers are wired. `registerEventConsumers()` is pure — no timers, no sockets — so integration tests subscribe and drive the relay by hand with `processBatch()`. The new consumer must stay equally pure.
