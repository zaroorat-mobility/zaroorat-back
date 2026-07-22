# Events

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **Answers:** _What events flow through the system — internal domain events and realtime socket events?_
> **See also:** [Queues](./QUEUE_GUIDE.md), [System Architecture](./SYSTEM_ARCHITECTURE.md)

Zaroorat uses events to **decouple side effects** from the transaction that caused them. A service does its own work and emits an event; other modules and workers react. This keeps the core loop fast and lets us add reactions (a new notification, an analytics metric) without touching the emitter.

Two distinct event planes:

1. **Domain events** — internal, in-process (and/or via the queue) between modules.
2. **Realtime events** — Socket.io messages to/from clients.

---

## 1. Domain events (internal)

Emitted by services in `<module>.events.ts`, consumed by other modules and workers. A domain event is a **fact that already happened** (past tense), never a command.

| Event                | Emitted by     | Consumed by                                   | Carries                         |
| -------------------- | -------------- | --------------------------------------------- | ------------------------------- |
| `trip.state_changed` | rides          | notifications, analytics, payments, chat, sos | tripId, fromState, toState, at  |
| `trip.completed`     | rides          | payments (charge), reviews (enable)           | tripId, finalFare               |
| `payment.captured`   | payments       | rides (→PAID), ledger, analytics              | tripId, paymentId, amount       |
| `payment.failed`     | payments       | notifications, support                        | tripId, reason                  |
| `driver.verified`    | onboarding     | drivers (operable=true), notifications        | driverId                        |
| `document.expiring`  | cleanup.worker | drivers (operable=false), notifications       | driverId, documentId, expiresAt |
| `promo.redeemed`     | promotions     | analytics, ledger                             | promoId, userId, tripId, amount |
| `sos.triggered`      | sos            | support/admin (escalate), notifications       | tripId, triggeredBy, location   |

### Rules for domain events

- **Past-tense names** (`trip.completed`), never imperatives (`chargeTrip`).
- **Emit after the write commits**, not before — subscribers must never see a fact that later rolled back.
- **Idempotent consumers** — an event may be delivered more than once; handlers must be safe to re-run (dedup key per `(consumer, event-id)`).
- **No business rule lives only in a subscriber** that the emitter depends on for correctness — events are for side effects, not for completing the primary transaction.
- **Never fan a money mutation through a fire-and-forget event** — payment work goes through a durable queue (see [Queues](./QUEUE_GUIDE.md)), not an in-memory emitter.

### Event → queue bridge

Side effects that must survive a crash (charge, payout, notification fan-out) are **not** handled inline. The emitter enqueues a durable BullMQ job; the relevant worker consumes it with retry/backoff. See [Queues](./QUEUE_GUIDE.md).

---

## 2. Realtime events (Socket.io)

Client-facing events over the Socket.io gateway, shared across API instances via the Redis adapter (ADR-0006). Rooms: `trip:{id}` joins the rider + driver; zone/presence channels carry geo.

| Direction       | Event                  | Payload                        | Notes                                                          |
| --------------- | ---------------------- | ------------------------------ | -------------------------------------------------------------- |
| driver → server | `location:update`      | `{ lat, lng, heading, at }`    | rate-bounded; idempotent; stale (> TTL) excluded from matching |
| server → room   | `trip:state`           | `{ tripId, status, at }`       | emitted on every trip transition                               |
| server → rider  | `trip:driver_location` | `{ lat, lng }`                 | only during an active trip; privacy-gated                      |
| both ↔ server   | `chat:message`         | `{ tripId, body }`             | active trips only; deduped                                     |
| both → server   | `sos:trigger`          | `{ tripId }`                   | **never** rate-limited or feature-flagged                      |
| server → client | `error`                | `{ code, message, requestId }` | standard error shape                                           |

### Rules for realtime events

- **Server-authoritative:** sockets _push_ state, the DB _decides_ it. On reconnect the client calls `GET /rides/:id` to reconcile.
- **Idempotent handlers:** duplicate messages (reconnects, retries) must be safe.
- **Privacy-gated:** a driver's live location goes only to the paired rider during an active trip (and audited ops).
- **SOS is exempt** from rate limits and flags — safety cannot be throttled.

---

## 3. Event catalog maintenance

- Adding an event: document it here **and** in the emitter's `<module>.events.ts` in the same PR.
- Changing a payload is a breaking change for consumers — version the event (`trip.completed.v2`) rather than mutating it.
