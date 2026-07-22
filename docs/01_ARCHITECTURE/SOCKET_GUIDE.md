# Socket Guide (Realtime)

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **Decision:** [ADR-0006 — Socket.io + Redis adapter](./ADR/0006-socketio-redis-adapter-realtime.md) · **See also:** [Event Catalog](./EVENT_CATALOG.md)

The realtime layer carries live driver locations, trip-state pushes, in-trip chat, and SOS. It is **Socket.io** over the `socket` plugin, scaled across API instances by the **Redis adapter**.

---

## 1. First principle: the server is authoritative

Sockets **push** state; the **database decides** it. The socket layer is a fast delivery channel, never the source of truth.

- On connect/reconnect, the client **reconciles** by calling `GET /rides/:id` — it never assumes the last socket message was the final word.
- If a socket message and the DB disagree, the DB wins.

## 2. Connection & auth

- A socket authenticates with the **JWT access token** on the handshake; unauthenticated sockets are rejected.
- The connection is bound to a `userId` + roles; every subsequent event is authorized against it ([Security](./SECURITY_GUIDE.md)).
- Tokens expiring mid-connection: the client refreshes and re-authenticates; the server drops unauthenticated sockets.

## 3. Rooms

| Room                       | Members                   | Purpose                                              |
| -------------------------- | ------------------------- | ---------------------------------------------------- |
| `trip:{id}`                | the trip's rider + driver | trip state, driver location, chat, SOS for that trip |
| `zone:{id}` (presence/geo) | drivers in a zone         | supply/geo distribution                              |
| `user:{id}`                | one user's sockets        | account-level pushes                                 |

- A user joins `trip:{id}` only if they are a party to that trip (authorized on join).
- Rooms are shared across instances via the **Redis adapter**, so a rider on instance B receives events from a driver on instance A.

## 4. Event catalog (client ↔ server)

Full list in the [Event Catalog](./EVENT_CATALOG.md). Realtime summary:

| Direction            | Event                  | Payload                        | Rules                                                              |
| -------------------- | ---------------------- | ------------------------------ | ------------------------------------------------------------------ |
| driver → server      | `location:update`      | `{ lat, lng, heading, at }`    | **rate-bounded**, idempotent; stale (> TTL) excluded from matching |
| server → `trip:{id}` | `trip:state`           | `{ tripId, status, at }`       | emitted on every trip transition                                   |
| server → rider       | `trip:driver_location` | `{ lat, lng }`                 | **only** during an active trip; privacy-gated                      |
| both ↔ server        | `chat:message`         | `{ tripId, body }`             | active trips only; **deduped**                                     |
| both → server        | `sos:trigger`          | `{ tripId }`                   | **never** rate-limited or feature-flagged                          |
| server → client      | `error`                | `{ code, message, requestId }` | standard error shape                                               |

**Naming:** `namespace:action`, lowercase (`trip:state`, `location:update`).

## 5. Hard rules

1. **Idempotent handlers.** Reconnects and retries redeliver messages — processing one twice must be safe.
2. **Privacy-gated.** A driver's live location goes only to the paired rider during an active trip (and audited ops). Never broadcast raw positions.
3. **Rate-bound ingress.** `location:update` is throttled/merged server-side; excessive updates are dropped, not queued.
4. **SOS is exempt** from rate limits and flags — safety cannot be throttled.
5. **State changes persist first, then push.** Emit `trip:state` from the `rides` service **after** the DB transition commits — never push a state that might roll back.
6. **Scoped fan-out.** Emit to the smallest room that needs it; never broadcast globally.
7. **Errors don't kill the socket.** Handlers emit an `error` event and keep the connection alive ([Error Handling](../02_ENGINEERING/ERROR_HANDLING.md)).

## 6. Where realtime meets the modules

- Location ingestion → `geo` (writes hot presence to Redis with a TTL; excludes stale from matching).
- Trip-state pushes → emitted by `rides` on each transition ([ER §4](./ER_DIAGRAM.md)).
- Chat → `chat` (persists messages for the trip record; active-trip only).
- SOS → `sos` (records `SosEvent`, escalates; always available).

Sockets carry **no business logic** of their own — a handler validates, authorizes, and calls the owning module's service, exactly like a controller does for HTTP.

## 7. Scaling & resilience

- Horizontal scale via the Redis adapter (ADR-0006); API instances are stateless.
- On instance loss, clients reconnect and reconcile via REST — no trip is lost (state is in Postgres).
- Monitor: connection count, message rates, adapter health, reconnection storms ([Monitoring](../03_OPERATIONS/MONITORING.md)).
