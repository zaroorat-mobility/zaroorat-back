# Redis Key Catalog

**Owner:** Engineering (Data) · **Last reviewed:** 2026-07-06
**Realizes:** ADR-0003, Volume 4 data split, NFR-SCALE-04, NFR-RESIL-02

Redis is the **hot, ephemeral** tier. Everything here is either derivable from Postgres or
acceptable to lose on a flush — **nothing here is a system of record**. This catalog is the contract
for key naming, structure, and TTL. Keys follow the [Volume 1 convention](../00_Project/03_naming-conventions.md):
`domain:entity:qualifier`.

> **Rule:** every key has a documented **purpose, structure, and TTL policy**. A key without a TTL
> policy (even "no TTL, evicted by capacity") is a memory leak waiting to happen.

---

## Catalog

| Key pattern                   | Type             | Purpose                                                       | TTL                                             |
| ----------------------------- | ---------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| `drivers:geo:{vehicle_type}`  | GEO (sorted set) | Live driver positions for `GEOSEARCH` matching                | member refreshed each ping; stale members swept |
| `driver:location:{driver_id}` | HASH             | Last fix (lat,lng,heading,ts) for freshness check (R-AVAIL-2) | ~60 s sliding                                   |
| `driver:status:{driver_id}`   | STRING           | online/offline cache                                          | while online                                    |
| `ride:offer:{trip_id}`        | STRING/HASH      | Current outstanding offer + timeout                           | `OFFER_TTL` (~15 s)                             |
| `ride:excluded:{trip_id}`     | SET              | Drivers who declined (no re-offer, R-AVAIL-5)                 | `REOFFER_COOLDOWN`                              |
| `ride:matchlock:{trip_id}`    | STRING (SETNX)   | One matching loop per request (M-1)                           | loop lifetime + safety                          |
| `surge:{zone_id}`             | STRING           | Current surge multiplier (hot read at estimate)               | recompute interval (~1–2 min)                   |
| `pricing:cfg:{city}:{type}`   | STRING (JSON)    | Cached active pricing config                                  | invalidated on write                            |
| `otp:{phone}`                 | STRING           | Hashed OTP (never plaintext)                                  | `OTP_TTL` (~5 min)                              |
| `otp:att:{phone}`             | STRING (counter) | OTP verify attempts (lockout)                                 | `OTP_TTL`                                       |
| `ratelimit:otp:req:{phone}`   | STRING (counter) | OTP request rate limit                                        | window                                          |
| `ratelimit:{scope}:{id}`      | STRING (counter) | Generic rate limits (per device/IP/endpoint)                  | window                                          |
| `idem:{key}`                  | STRING (JSON)    | Idempotency: stored response for a client key (NFR-RESIL-02)  | ~24 h                                           |
| `notif:dedupe:{event_key}`    | STRING           | Notification idempotency (N-2)                                | event horizon                                   |
| `session:hint:{user_id}`      | STRING           | Optional fast-path session data                               | access-token TTL                                |
| `ws:presence:{trip_id}`       | SET              | Which gateway/socket holds a trip's clients                   | connection lifetime                             |

Channels (pub/sub, not keys):

| Channel             | Publishers → Subscribers                                    |
| ------------------- | ----------------------------------------------------------- |
| `loc:{trip_id}`     | API (driver pings) → realtime gateways → rider              |
| `offer:{driver_id}` | matching worker → gateway → driver app                      |
| `events:{type}`     | outbox relay → module workers (domain events, Volume 5 §08) |

---

## Why each critical key exists

- **`drivers:geo:{vehicle_type}`** — the core of matching. `GEOADD` on each ping, `GEOSEARCH` to
  find candidates. Sharded by vehicle type so a car search never scans bikes. This is _the_ reason
  we don't hammer Postgres for proximity (ADR-0003).
- **`ride:matchlock:{trip_id}`** — `SET key val NX PX ttl` guarantees exactly one matching loop even
  if `ride.requested` is redelivered (Invariant M-1). Auto-expires so a crashed worker's lock frees.
- **`idem:{key}`** — the backbone of connectivity resilience (A6.1). The first request stores its
  response; a retry after a drop returns the stored response instead of re-executing (NFR-RESIL-02).
  Used by booking, accept, start, complete, and wallet debit.
- **`otp:{phone}`** — OTP is Redis-only, hashed, TTL'd (Volume 5 auth). It never belongs in Postgres.

---

## Consistency & durability posture

| Concern                | Posture                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durability             | Redis may be configured with AOF, but we **never assume** a key survives — all critical state is reconstructable from Postgres                                                                              |
| On Redis flush/restart | Live locations repopulate within seconds of the next pings; idempotency keys lost → worst case a rare duplicate, mitigated by DB unique constraints (e.g. `uq_ledger_txn_idem`, `uq_rider_one_active_trip`) |
| Memory pressure        | TTLs bound growth; `maxmemory-policy` set to evict volatile keys; no untracked unbounded keys                                                                                                               |
| Source of truth        | **Always Postgres.** Redis disagreeing with Postgres → Postgres wins                                                                                                                                        |

> **Defense in depth:** idempotency is enforced in _both_ tiers — Redis `idem:{key}` for speed, and
> **database unique constraints** as the ultimate guarantee. A lost Redis key can't cause a double
> settlement because `ledger_transactions.idempotency_key` is `UNIQUE` (Volume 6, §02). Redis is the
> fast path; the DB constraint is the safety net.
