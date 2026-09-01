# Backend Production Verification — 60,000 Customers / 30,000 Drivers

**Scope:** backend only (`backend_zaroorat`). No frontend, no mobile.
**Method:** source read → execution path traced → real server booted → real HTTP → Postgres/Redis inspected → controlled load → failure injection.
**Environment:** single Node 22 process, `APP_ENV=test`, `127.0.0.1:3001`; PostgreSQL 17 + PostGIS and Redis 7 in Docker; 41/41 migrations applied.
**Date:** 2026-09-01 · **Branch:** `admin-folder` @ `6e95c59`
**Code modified:** none. `git status` shows only the two report files.

**Evidence base:** one complete real ride (58/58 assertions), 154 quote-flow assertions from the prior phase, 1,200 load-test requests, three infrastructure outage injections, and direct `EXPLAIN ANALYZE` against the live database.

> **Rule 38 — prior findings are preserved.** Findings Q-1…Q-7 (ride quote), F1-01…F1-05 (auth), F2-01…F2-03 (profile) and the platform-level blockers carry forward unchanged into §50. This phase adds P-1…P-10.

---

## 1. Executive Summary

The ride lifecycle works. I ran a complete ride against the live backend — registration, OTP, profile, quote, booking, dispatch, a two-driver acceptance race, arrival, start OTP, live location, completion, cash collection, double-entry ledger, receipt and rating — and **all 58 assertions passed**, including every concurrency probe. The state machine, the locking and the money are sound.

**It cannot serve 60,000 customers and 30,000 drivers in its current shape, and the reason is not tuning.** The Socket.IO adapter is `memory` and `@socket.io/redis-adapter` is not installed, so the realtime layer runs on exactly one process. Every driver location broadcast, ride offer and status push lives in that process's memory. You cannot add a second instance without silently splitting the customer and driver population into two worlds that cannot see each other's events.

Measured on this single instance: quotes saturate at **~100 req/s**, `/auth/me` at ~310 req/s, with the event loop nearly idle (p99 lag 15.5 ms) — the ceiling is I/O concurrency against a **10-connection** Postgres pool, not CPU. Against `max_connections = 100` and no PgBouncer, the architecture tops out near 10 instances before the database refuses connections.

Driver location is the volume problem. At the configured 1 Hz accept rate, 30,000 drivers generate **30,000 frames/s**, sampled down to **6,000 persisted writes/s** — an order of magnitude beyond what a 10-connection pool per instance sustains.

**Capacity at the stated target: NOT PROVEN.** I did not load test at 90,000 users and will not claim a number I did not measure.

Also carried forward and still unfixed: the fare is computed from a **hardcoded 12.4 km**, no payment gateway is implemented, and no push provider exists — the last two make the process refuse to boot in `production` at all.

---

## 2. Architecture

| Layer     | Implementation                                                                        | Evidence                                  |
| --------- | ------------------------------------------------------------------------------------- | ----------------------------------------- |
| HTTP      | Fastify 5 on Node 22, TypeScript                                                      | `src/app/app.ts`                          |
| DI        | Awilix, `InjectionMode.CLASSIC` (resolves by constructor parameter name)              | `src/core/di.ts`                          |
| Database  | PostgreSQL 17 + PostGIS via Prisma 7 + `@prisma/adapter-pg` over a `pg.Pool`          | `PrismaClientFactory.ts`                  |
| Pool      | `max=10`, `min=2`, connect timeout 5 s, idle 30 s (`DB_POOL_*`)                       | `PoolConfiguration.ts`                    |
| PG server | `max_connections = 100`; 11 backends observed under load                              | live `SHOW max_connections`               |
| Cache     | Redis 7 via ioredis; `maxclients 10000`; 3 client connections at rest                 | live `INFO clients`                       |
| Queues    | BullMQ — 7 queues, 14 job types, **separate worker process** (`src/worker.ts`)        | `src/jobs/*`                              |
| Realtime  | Socket.IO bound to the same HTTP listener; **adapter = `memory`**                     | `realtime.gateway.ts`, `.env.example:243` |
| Events    | Transactional outbox → `OutboxRelay` → in-process `EventBus`, 8 consumers             | `events.bootstrap.ts`                     |
| Map       | Ola / Google / Mappls, one active, chosen from `system_settings`                      | §6                                        |
| SMS       | MSG91 (real HTTP)                                                                     | `msg91.client.ts`                         |
| Push      | `MockPushProvider` only — **boot refused in production**                              | `notification.config.ts`                  |
| Payments  | mock / razorpay / stripe — **all three are placeholders; boot refused in production** | `payment.config.ts`                       |

**Process topology:** API and worker are separate processes. Socket.IO lives in the API process only.

---

## 3. Customer Flow — PASS

**CODE PATH:** `POST /auth/otp/send` → `AuthController.sendOtp` → `AuthService.sendOtp` → `OtpService.send` → Redis (`otp:*`) + `otp_verifications` + BullMQ `auth-otp`
`POST /auth/otp/verify` → `AuthService.verifyOtp` → `resolveAccount` (user + `customer` role + profile, one transaction) → `SessionService.create` → `TokenService.issuePair`

**RUNTIME TEST:** customer created, role `customer` only, `is_phone_verified=true`, 1 profile row, 1 live session, `otp_verifications.outcome='verified'`.
**CONCURRENCY:** two simultaneous verifies of one code → exactly one 200, one user, one session.
**LATENCY:** otp/send p50 43 ms / p95 115 ms · otp/verify p50 92 ms / p95 145 ms · refresh p50 58 ms.
**RESULT: PASS** — with carried finding **F1-01** (registration token invalidated ~1.5 s later by the async epoch bump).

## 4. Location Flow — PASS

Pickup and drop enter as four plain numbers on `POST /rides/quote` and `POST /rides/requests`. Validated by `latitudeSchema`/`longitudeSchema` (−90..90, −180..180). No address, `placeId` or autocomplete field exists anywhere on the contract, and **no geocoding endpoint exists in the 218-endpoint surface**.

**Coordinate order verified at every boundary:** all 11 `ST_MakePoint` call sites pass `(longitude, latitude)` with SRID 4326; Ola and Google receive `lat,lng`; Mappls receives `lng,lat` — each correct for that vendor. Proven at runtime: a booked request stored `POINT(77.5946 12.9716)`.

## 5. PostGIS — PASS

**EXPLAIN ANALYZE, live, pickup gate:**

```
Index Scan using ix_cities_boundary_geom on cities (cost=0.14..20.66) (actual time=0.147..0.147 rows=1)
  Index Cond: ((boundary)::geometry ~ '...'::geometry)
Execution Time: 0.270 ms
```

Spatial indexes present: `ix_cities_boundary_geom`, `ix_service_zones_boundary_geom`, `ix_surge_zones_boundary`, `ix_driver_locations_location`, `ix_saved_places_location`.

The `driver_locations` proximity query planned as a **Seq Scan** — correctly, at 7 rows. Forcing `enable_seqscan=off` confirms the index is _usable_ by the predicate:

```
Index Scan using ix_driver_locations_location on driver_locations
  Index Cond: (location && _st_expand('...'::geography, '5000'))
```

**Index usage at production row counts is NOT PROVEN** — the table held 7 rows.

## 6. Map Provider — PASS

```
ACTIVE PROVIDER:      ola
CONFIGURATION SOURCE: system_settings (category 'maps') → Redis geo:settings:maps (TTL 3600 s)
```

Resolution: Redis cache → `SystemSettingService` → `MAP_PROVIDER` env → static list. Exactly one provider is active (`buildProviderChain` returns `[provider]`). No map env vars are set, so the database is the sole authority.

## 7. Routing — **FAIL**

**Experiment E1:** Ola pointed at `http://127.0.0.1:9/blackhole`, cache busted → quote returned `200`, `12.4 km`, `distanceSource: "ola"`. **No external HTTP request is made.**

The call path reaches the provider (`distanceSource` can only come from `provider.providerName`), but `getDirections` returns before the network call.

## 8. Distance — **FAIL** (carried finding Q-1)

```
AUTHORITATIVE DISTANCE SOURCE: HARDCODED CONSTANT
```

`ola-maps.provider.ts:143`, `google-maps.provider.ts:121`, `mappls.provider.ts:104` each return `{ distanceMeters: 12400, durationSeconds: 1860 }` as the first statement of `getDirections`. Two of the four trigger conditions are `apiKey.startsWith('test_')` and `'mock_'` — **not environment-gated**, therefore production-reachable.

Every journey quotes 12.4 km / 31 min. Pickup and drop at the identical coordinate is quoted and billable.

**Fallback (PHASE 11) — PASS:** with no usable provider the quote fails closed at `503 ROUTING_PROVIDER_UNAVAILABLE`. The haversine branch in `PricingService.estimateTrip` is unreachable (`mapProviderService` is always registered) — **UNUSED / DEAD CODE**. `"haversine"` never appeared in the server log.

## 9. Vehicle Catalogue — PASS

From `vehicle_types`, served by `GET /vehicle-types` (authenticated). Four active: **BIKE, AUTO, CAB_ECONOMY, CAB_PREMIUM**. Unknown id → `404`; deactivated type explicitly requested → `409 VEHICLE_TYPE_INACTIVE`; deactivated type in a multi-category quote → silently omitted (4 options → 3).

## 10. Admin Pricing — PASS

`PATCH /admin/fare-rules/:id` → `AdminFareService` → `pricing_rules`. Changed `perKmRate` 6.00 → 99.00; the **next customer quote** billed `distanceFare 1227.60` = 99 × 12.4. Updates are **immutable-versioned**: the old row is deactivated and a new active row inserted, with exactly one active row per key at all times.

## 11. Zone Pricing — PASS

Pickup → `resolvePickupContext` → containing `service_zones` → rule preferring `service_zone_id`, then `city_code`, then `GLOBAL`.

| Pickup       | Rule                        | Base | BIKE total |
| ------------ | --------------------------- | ---: | ---------: |
| MG Road      | `BIKE · GLOBAL`             |   20 |    ₹146.67 |
| Airport Zone | `BIKE · BLR · Airport Zone` |  500 |    ₹650.67 |

## 12. Surge — PASS

`surge_windows`: multiplier, zone, optional vehicle type, `starts_at`/`ends_at`, peak-hour and demand/supply columns (the latter have **no runtime demand signal**). Clamped 1.0–2.0 twice.

| Scenario                | Multiplier |        Total |
| ----------------------- | ---------: | -----------: |
| no window               |        1.0 |      ₹650.67 |
| 2.0× active, in range   |    **2.0** | **₹1286.34** |
| same window, AUTO       |        1.0 |    unchanged |
| pickup outside the zone |        1.0 |    unchanged |
| window starting in 5 h  |        1.0 |    unchanged |

Surge does not leak across zone, vehicle type or time.

## 13. Quote — PASS mechanically, wrong numerically

Formula extracted verbatim in the prior report. Arithmetic verified to the paise for all four categories; `driverEarning + platformCommission + tax + platformFee = totalFare` by construction. Stateless (no rows, no events), deterministic, tamper-proof.

**LATENCY:** p50 117 ms (c=10) → 259 ms (c=25) → 446 ms (c=50). Single-category quote is ~40 % cheaper (p50 172 ms at c=25).

## 14. Booking — PASS

**CODE PATH:** `POST /rides/requests` → `RideRequestController.createRequest` → Redis idempotency (`idem:ride-request:*`, TTL 300 s) → `RideRequestService.createRequest` → transaction → `ride_requests` + outbox `ride.requested`

**DATABASE EVIDENCE:** `quoted_fare=146.67`, `estimated_distance_km=12.40`, `pricing_rule_id=01a058f6-…` — **the request records the exact rule it was priced with**. `pickup_location = POINT(77.5946 12.9716)`.
**IDEMPOTENCY:** replay with the same `Idempotency-Key` returned the same request id; exactly one row.
**GUARD:** booking without a profile name is refused with `422 INCOMPLETE_PROFILE`.
**LATENCY:** p50 109 ms.

## 15. Driver Online — PASS

**CODE PATH:** `POST /drivers/status/online` → `StatusService.setOnline` → `driverRepo.lockForUpdate` → verification + suspension check → `checkRequiredDocuments` → `VehicleEligibilityService.assertOperable` → shift start → `driver_online_status`

A driver with documents that do not match `DRIVER_REQUIRED_DOCUMENT_TYPES` (`DRIVING_LICENSE,RC,INSURANCE`) is refused with `403 DRIVER_NOT_VERIFIED` — observed directly during setup, when my fixture supplied the wrong document set. Distinct codes exist for the vehicle half (`VEHICLE_MISSING`, `VEHICLE_INACTIVE`, `VEHICLE_NOT_VERIFIED`, `VEHICLE_DOCUMENTS_INCOMPLETE`).
**LATENCY:** p50 49 ms.

## 16. Driver Location — PASS (design), capacity NOT PROVEN

**CODE PATH (socket):** `driver.location.update` → `LocationStreamService.accept` → rate limit → staleness/out-of-order → **sample** → `LocationService.updateLocation` → Redis GEO + `driver_locations` → broadcast to the ride room

Configured: `locationMinIntervalMs = 1000`, `locationPersistIntervalMs = 5000`, `locationMaxAgeMs = 30000`.

**Every accepted frame is broadcast; only one frame per 5 s per driver is written through.** Frames arriving faster than 1 Hz are dropped, not queued. Out-of-order and future-dated frames are rejected.

**RUNTIME:** Redis key `geo:driver:{id}` = `{"at":…,"lat":12.9716,"h3":"8860145b49fffff","lng":77.5946}`; H3 cell set populated; one `driver_locations` row per driver.
**SECURITY:** an implausible jump (≈24 km in seconds) was rejected with `400 IMPLAUSIBLE_LOCATION`.
**LATENCY:** p50 70 ms.

## 17. Driver Discovery — PASS

**Two-stage, no full-table scan:**

1. `RedisGeoProvider` → H3 cell membership → candidate driver ids
2. `PostgisProvider.findNearbyDrivers` → `ST_DWithin` on `driver_locations`, **restricted to those ids**, `recorded_at >= freshAfter`, `ORDER BY distance LIMIT n`

There is no `SELECT * FROM drivers` with application-side distance filtering. If Redis is unavailable the search degrades to PostGIS-only and reports `outcome: 'degraded'`.

## 18. Dispatch — PASS

**CODE PATH:** outbox `ride.requested` → `RideRequestedConsumer` → `DispatchService` → expanding radii → `MatchingService.findEligibleCandidates` → `ride_dispatches` rows → socket `ride.offer.received`

Eligibility is re-checked **at dispatch time**, not only at go-online: online + not suspended + verified + not on a ride + active assignment + active verified vehicle, then per-candidate document eligibility.

Configuration: `RIDE_DISPATCH_BATCH_SIZE = 3` (parallel offers), `RIDE_DISPATCH_TIMEOUT_SEC = 30`, `RIDE_REQUEST_EXPIRY_MIN = 5`, enforced by the `dispatch-timeout` and `request-expiry` cron workers (every minute).

## 19. Acceptance — PASS (with a specification mismatch)

**CONCURRENCY (the critical test):** two drivers called `POST /rides/accept` for the same request simultaneously.

```
statuses = 200 , 404      codes = OK , RIDE_OFFER_NOT_FOUND
rides created for the request = 1
```

**Exactly one driver wins.** One ride row, correct driver recorded, request marked `MATCHED`, a 6-digit start OTP issued and stored **hashed** (`otp_hash` prefix `eb6ae31e…`, not the plaintext).
**LATENCY:** p50 147 ms.

**PHASE 24 — the 10-second window is `RIDE_DISPATCH_TIMEOUT_SEC`, default 30 s.** It is configuration-driven (good) but the shipped default is **three times** the specified acceptance window. Not a defect; a configuration decision that must be made deliberately.

## 20. Driver Pickup — PASS

`ARRIVING` and `ARRIVED` are **manual driver-triggered transitions**. There is no geofence or GPS proximity check on arrival. A driver not assigned to the ride is refused with `403 RIDE_DRIVER_MISMATCH`.

## 21. Start OTP — PASS

Wrong code → `400 OTP_VERIFICATION_FAILED`, ride stays `DRIVER_ARRIVED`. Two simultaneous starts → **exactly one 200, one 409**. Reuse after success → `409 INVALID_RIDE_STATE_TRANSITION`. Stored hashed.
**LATENCY:** p50 64 ms.

## 22. Trip — PASS

`DRIVER_ARRIVED → IN_PROGRESS` only via a verified OTP. Live location during the trip accepted; the paired customer can read the driver position; **an unrelated customer is refused with `403 FORBIDDEN`**.

## 23. Trip Distance — PASS (server-authoritative)

`billedDistanceKm = max(measuredFromRedisMeter, quotedDistance)`. The driver claimed `actualDistanceKm: 9.8`; the server billed **12.40** — the quoted floor. The client is not the authority. Logged as `[rides] billing a measured distance that differs from the one the app reported`.

## 24. Trip Completion — PASS

Two simultaneous completions → **exactly one 200, one 409**. Ride `COMPLETED`, one `ride_fares` row.

## 25. Final Fare — PASS arithmetic, **P-1 divergence**

```
base 20.00 + distance 74.40 + time 0.00 = subtotal 94.40
tax 4.72 + platform fee 15.00 → total 114.12
driver 75.52 + commission 18.88 + tax 4.72 + fee 15.00 = 114.12 ✓
```

**The customer was quoted ₹146.67 and billed ₹114.12 — 22 % less.** `time_fare` was 31.00 at quote (31 min estimated) and 0.00 at completion (`actual_duration_min = 0`, my trip lasted seconds). Billing measured duration is defensible, but the quote is **not binding and has no cap**. The risk direction is upward: a trip delayed in traffic bills more than quoted, with nothing bounding the difference. See **P-1**.

## 26. Payment — PASS for cash, **BLOCKED for digital**

**CODE PATH:** outbox `ride.completed` → `RideCollectionConsumer` → `RideCollectionService` → `LedgerService.postGroup` (transaction) → `payment_ledger_entries`

```
collectionState = PAID, method = CASH, amount = 114.12, amountOwed = 0
ledger entries = 4, debits − credits = 0.00
accounts: DRIVER_PAYABLE, PLATFORM_COMMISSION, PLATFORM_FEE, TAX_PAYABLE
```

Balanced double entry. On a cash ride the driver holds the money, so `DRIVER_PAYABLE` is debited for the platform's share and there is no customer funding leg — correct.

**Digital payment is BLOCKED, not tested:** `RazorpayGatewayProvider` and `StripeGatewayProvider` make no network call — they mint a random id and return `SUCCEEDED`. `assertGatewayImplemented` refuses to boot in `production`/`staging`. Webhook ordering, duplicate webhooks, provider timeouts and double-charge protection **cannot be verified against a real gateway** and are marked BLOCKED.

## 27. Receipt — PASS

`GET /rides/:id/receipt` returns a numbered receipt (`RCP_MTHMHL18_6CA9`) with an immutable `snapshotJson` fare block. An unrelated customer is refused `403`.

## 28. Rating — PASS

Customer rated 5; duplicate → `409 ALREADY_RATED`; unrelated customer → `403 RIDE_CUSTOMER_MISMATCH`; the driver's stored rating recomputed to `5.00` **in the same transaction** as the rating. Driver→customer ratings are recorded but move nothing (no customer aggregate column exists).

## 29. Redis — PASS with two growth findings

| Key                                          | Purpose                                  | TTL          | Writer             | Reader        | Invalidation         |
| -------------------------------------------- | ---------------------------------------- | ------------ | ------------------ | ------------- | -------------------- |
| `otp:{purpose}:{phone}`                      | hashed OTP secret                        | 300 s        | OtpService         | OtpService    | consume / TTL        |
| `otp:challenge:*`, `otp:att:*`, `otp:lock:*` | challenge, attempts, lockout             | 60 / 900 s   | OtpService         | OtpService    | TTL                  |
| `auth:epoch:{userId}`                        | token generation counter                 | **none**     | epoch bump         | auth plugin   | never                |
| `auth:sid:revoked:{sid}`                     | session revocation                       | token TTL    | logout             | auth plugin   | TTL                  |
| `ratelimit:*`                                | rate limiting                            | window       | limiter            | limiter       | TTL                  |
| `idem:{op}:{key}`                            | idempotency results                      | 300 s – 24 h | controllers        | controllers   | TTL                  |
| `lock:{resource}`                            | distributed lock                         | bounded      | services           | services      | release / TTL        |
| `geo:driver:{id}`                            | live driver position                     | config       | location update    | nearby search | overwrite            |
| `geo:cell:{h3}`                              | H3 cell membership                       | config       | location update    | nearby search | `SREM` on move       |
| `geo:settings:maps`                          | active map provider **+ decrypted keys** | 3600 s       | MapProviderService | same          | admin update / `DEL` |
| `ride:distance:{driverId}`                   | trip meter                               | trip         | lifecycle          | completion    | reset on start       |
| `bull:*`                                     | queues                                   | job policy   | producers          | workers       | job lifecycle        |

**No quote, fare or pricing rule is cached** — verified by key scan, which is why the admin price change took effect on the very next request.

🔴 **Q-4 (carried):** `geo:settings:maps` stores the provider API key **decrypted in clear text** for an hour while the database stores it encrypted.
🟡 **P-5 (new):** `auth:epoch:{userId}` has **no TTL** — one permanent key per user, ~90,000 at the target population, never reclaimed.

## 30. PostgreSQL — PASS

`max_connections = 100`; 11 backends observed under load (pool `max=10` + 1). No slow-query warnings during the ride. Query logging emits a warning above 100 ms.

## 31. PostGIS Indexes — PASS (see §5)

## 32. Database Transactions — PASS

Every critical transition runs inside `TransactionManager.execute` with row locks: `setOnline` (`driverRepo.lockForUpdate`), acceptance, start, completion, saved-place caps (`userRepository.lockForUpdate`), ledger posting. Proven by the four concurrency races, all resolving to exactly one winner.

## 33. Locks — PASS

Redis `lock:{resource}` with bounded TTL, plus Postgres row locks. The acceptance race resolved via a conditional claim on the dispatch offer (`RIDE_OFFER_NOT_FOUND` to the loser) rather than by a race on the ride row.

## 34. Idempotency — PASS

| Operation                 | Mechanism                                                 | Verified                                                      |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| OTP verify                | **required** `Idempotency-Key` → `idem:otp-verify:*`      | replay returns the identical token pair, one session          |
| Token refresh             | **required** `Idempotency-Key`                            | rotation + reuse detection (`TOKEN_REUSE`) revokes the family |
| Ride request              | optional `Idempotency-Key` → `idem:ride-request:*`, 300 s | replay returned the same request id, one row                  |
| Phone change verify       | `idem:phone-change-verify:*`                              | verified in the profile phase                                 |
| Payment                   | `IdempotencyRepository` + gateway key                     | **BLOCKED** — no real gateway                                 |
| Accept / start / complete | state-machine guards, not keys                            | one winner each under concurrency                             |

## 35. BullMQ — PASS (configuration), workers not exercised

7 queues, 14 job types. OTP delivery: 3 attempts, exponential backoff 2 s, `removeOnComplete: true`, `removeOnFail: { age: 3600 }`. Maintenance jobs: `attempts: 1`, keep 100 completed / 500 failed. Schedules include `dispatch-timeout` and `request-expiry` every minute.

**The worker process was not running during this audit** — jobs accumulated in `bull:auth-otp:*` (that is how I read OTP codes). Stalled-job handling, dead-letter behaviour and worker concurrency are **BLOCKED / not exercised**.

## 36. Socket.IO — **FAIL for the target topology**

Bound to the Fastify HTTP listener (one port, one TLS terminator, one CORS policy). Rooms: `user:{id}`, `driver:{id}`, `ride:{id}`. Server→client events are versioned envelopes carrying `eventId` so a client can dedupe a socket message against a push for the same fact.

```
REALTIME_ADAPTER = memory
@socket.io/redis-adapter → NOT INSTALLED
```

`attachAdapter` throws if `REALTIME_ADAPTER=redis` because the package is absent. **Rooms live in one process's memory.** A customer connected to instance A cannot receive an event emitted on instance B.

## 37. Horizontal Scaling — **FAIL**

| Component                     | Multi-instance safe?                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Sessions / auth               | ✅ Redis-backed (epoch, revocation)                                                              |
| Rate limiting                 | ✅ Redis                                                                                         |
| Idempotency                   | ✅ Redis                                                                                         |
| Locks                         | ✅ Redis                                                                                         |
| Queues                        | ✅ BullMQ/Redis, separate worker                                                                 |
| Database                      | ✅ shared, transactional                                                                         |
| Quote/pricing                 | ✅ stateless, no cache                                                                           |
| **Socket.IO rooms**           | ❌ **in-memory, single process**                                                                 |
| `LocationStreamService.state` | ⚠️ per-process Map — a sampling throttle only; costs one extra write on reconnect                |
| Outbox relay                  | ⚠️ each instance polls; claim logic exists but multi-instance relay contention is **NOT TESTED** |

**Verdict: 1 instance today.** Everything except realtime is already horizontally safe; the adapter is the blocker.

## 38. API Latency — measured

Single user, warm (n small):

| Endpoint                       |     p50 |    p95 |
| ------------------------------ | ------: | -----: |
| POST /rides/quote              | 544 ms¹ |      — |
| POST /rides/accept             |  147 ms |      — |
| POST /rides/:id/complete       |  113 ms |      — |
| POST /rides/requests           |  109 ms |      — |
| POST /auth/otp/verify          |   92 ms | 145 ms |
| POST /drivers/location         |   70 ms |  71 ms |
| POST /rides/:id/start          |   64 ms |  67 ms |
| POST /auth/token/refresh       |   58 ms |  64 ms |
| POST /drivers/status/online    |   49 ms |      — |
| POST /auth/otp/send            |   43 ms | 115 ms |
| GET /rides/:id/receipt         |   17 ms |      — |
| GET /rides/:id/driver-location |   16 ms |      — |

¹ first call, cold caches; under load the same endpoint sits at 117 ms p50 (§39).

## 39. Load Testing — measured on one instance

1,200 requests, single Node process, DB pool 10:

| Scenario                    |   n |    p50 |    p95 |    p99 | throughput |
| --------------------------- | --: | -----: | -----: | -----: | ---------: |
| `GET /vehicle-types` c=20   | 200 |  53 ms |  93 ms | 147 ms |  **318/s** |
| `POST /rides/quote` c=10    | 100 | 117 ms | 152 ms | 178 ms |   **80/s** |
| `POST /rides/quote` c=25    | 200 | 259 ms | 313 ms | 317 ms |   **93/s** |
| `POST /rides/quote` c=50    | 200 | 446 ms | 609 ms | 626 ms |  **107/s** |
| quote, single category c=25 | 200 | 172 ms | 225 ms | 231 ms |  **143/s** |
| `GET /auth/me` c=50         | 300 | 161 ms | 180 ms | 191 ms |  **310/s** |

**Zero errors across all 1,200 requests.**

**Event-loop lag during load: p50 5.1 ms, p95 14.4 ms, p99 15.5 ms, max 35.7 ms.** The process is **not CPU-bound** — throughput plateaus at ~100 quotes/s while latency scales linearly with concurrency, the signature of queueing behind a fixed connection pool.

## 40. 60k / 30k Capacity — **NOT PROVEN**

```
CURRENT MEASURED CAPACITY:  ~100 quotes/s, ~310 simple authenticated reads/s, per instance
TESTED CONCURRENCY:         50 concurrent HTTP clients (zero errors)
DATABASE LIMIT:             pool max=10/instance against max_connections=100 → ~10 instances, no PgBouncer
REDIS LIMIT:                maxclients 10000; 3 connections/instance at rest — not a near-term limit
HTTP LIMIT:                 not reached; event loop idle at tested load
QUEUE LIMIT:                not exercised (worker not running)
SOCKET LIMIT:               1 process, in-memory adapter → no horizontal scale
MAP LIMIT:                  see §41
BOTTLENECK:                 (1) Socket.IO in-memory adapter  (2) Postgres connection budget
```

**Driver location arithmetic (PHASE 49), from the configured values — not assumed:**

```
accept rate            = 1 frame/s/driver   (REALTIME_LOCATION_MIN_INTERVAL_MS = 1000)
persist sampling       = 1 write/5 s/driver (REALTIME_LOCATION_PERSIST_INTERVAL_MS = 5000)

30,000 drivers × 1/s         =  30,000 frames/s accepted and broadcast
30,000 drivers ÷ 5 s         =   6,000 writes/s to Postgres + Redis GEO
                             = 360,000 writes/min = 21,600,000 writes/hour
```

Measured `POST /drivers/location` end-to-end p50 is 70 ms. Even attributing only a fraction of that to the database, 6,000 writes/s across pools of 10 requires far more instances than a 100-connection Postgres will admit. **This is the volume ceiling, and it is not tested.**

I did not run a 90,000-user load test. **Capacity at the stated target is NOT PROVEN.**

## 41. Map API Capacity — NOT MEASURABLE

Every quote calls `getDirections` once (already hoisted out of the per-category loop — one call prices all four categories) plus one distance-matrix call for driver ETA. At 100 quotes/s that is **≥ 100 directions + 100 matrix calls/s = 17.3 M/day**, which no standard provider plan absorbs and which nothing in the codebase caches or rate-limits.

**Today this is theoretical**: the stub means zero real calls leave the process. There is **no caching layer for routing** — safe to cache (identical origin/destination pairs within a short window) versus unsafe (traffic-aware duration) is not distinguished anywhere. **Provider limits are undocumented in the repository, so no comparison is possible.**

Also observed: `nearbyDriverEtaStatus` returned `matrix_unavailable` on every quote even with drivers online — see **P-6**.

## 42. Failure Testing — PASS with one inconsistency

| Injected failure              | Expected           | Actual                                                                                                                                              | Recovery                                        | Consistency       |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------- |
| **Redis stopped**             | fail closed        | `/ready` 503; every authenticated route `503 SERVICE_UNAVAILABLE`; OTP send `503` ("Rate limiting is temporarily unavailable"); `/health` stays 200 | automatic on restart, no process restart needed | no partial writes |
| **Postgres stopped**          | fail closed        | `/ready` 503; quote **`500 INTERNAL`**                                                                                                              | automatic, pool reconnects                      | no partial ride   |
| **Map provider unresolvable** | controlled failure | `503 ROUTING_PROVIDER_UNAVAILABLE`                                                                                                                  | immediate                                       | no fare produced  |
| Map provider unreachable URL  | controlled failure | **`200` with the stubbed distance** — the stub pre-empts the network                                                                                | —                                               | wrong fare (Q-1)  |
| Queue unavailable             | —                  | **BLOCKED** (worker not running)                                                                                                                    | —                                               | —                 |
| Payment provider              | —                  | **BLOCKED** (no real gateway)                                                                                                                       | —                                               | —                 |
| SMS provider                  | —                  | **NOT TESTED**                                                                                                                                      | —                                               | —                 |

Redis is a **hard dependency**: its loss makes the whole API unavailable rather than degraded. The failure mode is safe (no silent double-dispatch), but there is no Redis HA in the compose files.

**P-4:** a Postgres outage surfaces as `500 INTERNAL` while a Redis outage correctly returns `503 SERVICE_UNAVAILABLE`. Clients cannot distinguish "retry later" from "your request is malformed".

## 43. Security — PASS

Deny-by-default: a global `onRequest` hook authenticates every route unless it declares `config: { public: true }`.

| Test                                        | Result                       |
| ------------------------------------------- | ---------------------------- |
| 7 admin endpoints with a customer token     | all `403 FORBIDDEN`          |
| customer creates a fare rule / surge window | `403`, **no row written**    |
| unrelated customer reads driver location    | `403 FORBIDDEN`              |
| unrelated customer reads receipt            | `403`                        |
| unrelated customer rates the ride           | `403 RIDE_CUSTOMER_MISMATCH` |
| driver drives another driver's ride         | `403 RIDE_DRIVER_MISMATCH`   |
| cross-account session/device revoke         | `404 NOT_FOUND`              |
| cross-account saved place / contact         | `404 NOT_FOUND`              |
| 8 fare-tampering fields                     | all ignored, price unchanged |
| forged JWT signature / no Bearer scheme     | `401 TOKEN_INVALID`          |
| session after logout                        | `401 SESSION_REVOKED`        |
| deactivated account re-login                | `403 ACCOUNT_DEACTIVATED`    |
| implausible GPS jump                        | `400 IMPLAUSIBLE_LOCATION`   |

Carried: **F1-03** rate limiters key on `X-Forwarded-For` with `trustProxy` defaulting to 1 hop.

## 44. Observability — PASS

Structured JSON (pino) with `requestId` on every line, plus `rideId`, `driverId`, `userId` and named metric events on domain operations.

**Secret scan of the complete server log (582 lines of request logging):**

```
JWTs (eyJhbGciOi…) : 0     refreshToken : 0     6-digit OTP codes : 0
password           : 0     API keys     : 0     authorization hdr : 0
```

Nothing sensitive is logged. Note the OTP plaintext still sits in the **BullMQ payload** (F1-05), not in logs.

## 45. Monitoring — PARTIAL

A `/metrics` endpoint and in-process metric emitters exist (`outbox.backlog`, `payment.*`, `pricing.*`, `session.*`, `otp.*`, geo metrics), and slow queries above 100 ms are logged. **No alerting, dashboards, APM or external metrics sink is configured in the repository** — there is no evidence of production monitoring for API latency, error rate, queue depth, dispatch failure or Socket.IO health.

## 46. Memory — PASS (bounded), long-run NOT PROVEN

`LocationStreamService.state` is a per-driver `Map` cleaned on disconnect via `forget()`. Socket rooms are per-connection. Event consumers return unsubscribe handles. No unbounded array or cache accumulator found on the hot paths.

Growth that is bounded but never reclaimed: `auth:epoch:*` (one key per user, no TTL — **P-5**).

**No long-duration soak test was run**; leak behaviour over hours/days is NOT PROVEN.

## 47. Event Loop — PASS

p99 lag 15.5 ms under the heaviest tested load. Password hashing uses `scryptSync` — CPU-bound and synchronous, but confined to admin password login, not a hot path. No large synchronous JSON, file or crypto work found on the ride paths.

## 48. N+1 Queries — PARTIAL (bounded)

On the dispatch path:

- `matching.service.ts:60` — `vehicleEligibilityService.check(driverId)` **inside** `for (const driver of ranked)`, bounded by `limit` (= `dispatchBatchSize`, default 3). The code carries a `ponytail:` comment acknowledging the trade-off.
- `dispatch.service.ts:168` — `offerToDriver` per candidate, same bound.
- `dispatch.service.ts:148` — an expanding-radius loop, each iteration re-running discovery.

Worst case ≈ `radii × (2 + batchSize)` queries per dispatch round. **Bounded, not unbounded** — but it multiplies under a dispatch spike.

The multi-category quote was already optimised: one directions call, one coverage resolution and one batched rate-card lookup for all four categories.

## 49. Unbounded Queries — PARTIAL

93 `findMany` call sites; **28 carry an explicit `take`**. Files with unbounded calls on or near hot paths: `matching.service.ts`, `permission.repository.ts` (6), `role.repository.ts` (3), `admin-geographic.service.ts` (4), `system-setting.repository.ts` (2), `driver-document.repository.ts` (2), plus the three Prisma extensions.

Most are naturally bounded (one user's devices, one driver's documents, the role catalogue). The admin list endpoints that matter are paginated. **No unbounded query over `rides`, `users` or `drivers` was found on a customer path.**

## 50. Problems

### Carried forward (unchanged, still open)

| #          | Sev   | Finding                                                                                                                                      |
| ---------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q-1**    | 🔴 P0 | `getDirections` returns a hardcoded 12 400 m / 1 860 s in all three providers; two triggers are not environment-gated → production-reachable |
| **Q-2**    | 🔴 P0 | `ZeroDistanceTripError` unreachable — a ride to the same point is quoted and billable                                                        |
| **Q-3**    | 🟠 P1 | Response reports `distanceSource: "ola"` for a value that never came from Ola                                                                |
| **Q-4**    | 🟠 P1 | Map provider API key cached **decrypted in clear text** in Redis for 1 h                                                                     |
| **Q-5**    | 🟡 P2 | Quote silently strips unknown fields (`z.object`, not `strictObject`) — a mistyped `promoCode` is discarded with no error                    |
| **Q-6**    | 🟡 P2 | Seeded rules leave tax / platform-fee / commission NULL → those three values come from code defaults, invisible in the Admin UI              |
| **Q-7**    | 🔵 P3 | Haversine fallback is unreachable dead code                                                                                                  |
| **F1-01**  | 🟠 P1 | Every new customer's first access token dies ~1.5 s after signup (async epoch bump); refresh recovers                                        |
| **F1-02**  | 🟡 P2 | `Idempotency-Key` mandatory on verify/refresh but not declared `required` in the OpenAPI schema                                              |
| **F1-03**  | 🟡 P2 | Rate limiters key on client-supplied `X-Forwarded-For` (`trustProxy` = 1 hop)                                                                |
| **F1-04**  | 🟡 P2 | Backend requires 6-digit OTP; all three clients render 4-digit inputs                                                                        |
| **F1-05**  | 🟡 P2 | Plaintext OTP sits in the BullMQ job payload in Redis (failed jobs retained 1 h)                                                             |
| **F2-01**  | 🔵 P3 | Duplicate emergency-contact phone numbers accepted (no unique index)                                                                         |
| **F2-02**  | 🔵 P3 | `email` is write-only on `PATCH /users/me/profile`                                                                                           |
| **F2-03**  | 🔵 P3 | `isEmailVerified` can never become true for a customer                                                                                       |
| **PLAT-1** | 🔴 P0 | No payment gateway implemented — Razorpay/Stripe clients return `SUCCEEDED` without a network call; boot refused in production               |
| **PLAT-2** | 🔴 P0 | No push provider — dispatch offers cannot reach a backgrounded driver; boot refused in production                                            |
| **PLAT-3** | 🟠 P1 | Circular import through `@core/di` breaks 9 unit test files                                                                                  |

### New in this phase

| #        | Sev       | Finding                                                                                                                                                                                                                                                   | Evidence                                                |
| -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **P-1**  | 🟠 P1     | **Quote is not binding and has no cap.** Quoted ₹146.67, billed ₹114.12 (−22 %) because `time_fare` is recomputed from measured duration (31 min → 0 min). The risk direction is upward: traffic delay bills _more_ than quoted with nothing bounding it. | `ride_fares` vs `ride_requests.quoted_fare`             |
| **P-2**  | 🔴 **P0** | **Socket.IO cannot scale horizontally.** `REALTIME_ADAPTER=memory`; `@socket.io/redis-adapter` not installed; `attachAdapter` throws if redis is selected. Rooms are per-process.                                                                         | `node -e require.resolve` → NOT INSTALLED               |
| **P-3**  | 🟠 P1     | **Connection budget.** Pool `max=10`/instance against `max_connections=100`, no PgBouncer → ~10 instances maximum. 6,000 location writes/s is far beyond that.                                                                                            | live config + arithmetic                                |
| **P-4**  | 🟡 P2     | Postgres outage returns `500 INTERNAL`; Redis outage correctly returns `503 SERVICE_UNAVAILABLE`. Inconsistent retry signalling.                                                                                                                          | outage injection                                        |
| **P-5**  | 🟡 P2     | `auth:epoch:{userId}` has **no TTL** — one permanent Redis key per user (~90,000 at target).                                                                                                                                                              | `TTL` scan                                              |
| **P-6**  | 🟡 P2     | `nearbyDriverEtaStatus` returned `matrix_unavailable` on **every** quote, including with two drivers online — the customer never sees a driver ETA.                                                                                                       | E2E + load runs                                         |
| **P-7**  | 🟡 P2     | Acceptance window default is **30 s** (`RIDE_DISPATCH_TIMEOUT_SEC`), not the specified 10 s. Configurable, but the shipped default differs from the business rule.                                                                                        | `ride.config.ts:20`                                     |
| **P-8**  | 🟡 P2     | Bounded N+1 on dispatch: ≈ `radii × (2 + batchSize)` queries per round.                                                                                                                                                                                   | `matching.service.ts:60`, `dispatch.service.ts:148,168` |
| **P-9**  | 🔵 P3     | 65 of 93 `findMany` call sites have no explicit `take`.                                                                                                                                                                                                   | grep audit                                              |
| **P-10** | 🔵 P3     | No routing cache and no map-provider rate limiting; safe-vs-unsafe-to-cache is not distinguished anywhere.                                                                                                                                                | §41                                                     |

## 51. Recommendations

**Before any production traffic (P0):**

1. Gate the map stub on `APP_ENV === 'test'` alone and make it coordinate-dependent — clears Q-1, Q-2, Q-3 in one change across three files.
2. Install and wire `@socket.io/redis-adapter`, then prove a customer on instance A receives an event emitted on instance B. Without this the platform is a one-process system.
3. Implement one payment gateway and one push provider, then remove them from their respective "unimplemented" guards.

**Before scale (P1):** 4. Raise `DB_POOL_MAX` deliberately and put PgBouncer in front of Postgres; re-measure. Decide the instance count from the connection budget, not from CPU. 5. Fix the registration epoch race (F1-01) — the async `account.role.granted` bump invalidates a token that was just issued. 6. Stop caching the decrypted provider key in Redis (Q-4). 7. Decide the quote-vs-final-fare policy (P-1): either honour the quote, or cap divergence, or show the customer a range.

**Then:** measure again at the target volume. Nothing in this report proves 60k/30k, and no amount of code review will.

## 52. Final Verdict

```
Customer Authentication:   PASS      (F1-01 open)
Customer Profile:          PASS
Pickup:                    PASS
Drop:                      PASS
Serviceability:            PASS
PostGIS:                   PASS      (index usage at scale NOT PROVEN)
Map Provider:              PASS      (ola, from system_settings)
Road Routing:              FAIL      (provider reached; network call never made)
Distance:                  FAIL      (hardcoded 12 400 m)
Vehicle Catalogue:         PASS
Admin Pricing:             PASS
No Hardcoded Pricing:      PASS      (rates DB-driven; caveat Q-6)
Zone Pricing:              PASS
Surge:                     PASS
Quote:                     PASS      (mechanically correct, numerically wrong)
Booking:                   PASS
Driver Online:             PASS
Driver Location:           PASS      (design; volume NOT PROVEN)
Driver Discovery:          PASS      (two-stage, no full-table scan)
Driver Dispatch:           PASS
10 Second Acceptance:      PASS*     (configurable; default is 30 s — P-7)
Concurrency:               PASS      (4 races, one winner each)
Start OTP:                 PASS
Trip Start:                PASS
Live Trip:                 PASS
Trip Completion:           PASS
Final Fare:                PASS*     (arithmetic exact; diverges from quote — P-1)
Payment:                   PASS      cash only · BLOCKED for digital
Receipt:                   PASS
Rating:                    PASS
Redis:                     PASS      (Q-4, P-5 open)
PostgreSQL:                PASS      (P-3 connection budget)
BullMQ:                    BLOCKED   (worker not running during audit)
Socket.IO:                 FAIL      (in-memory adapter, single process)
Horizontal Scaling:        FAIL      (realtime only; everything else is ready)
Security:                  PASS
Observability:             PASS      (monitoring PARTIAL)
Failure Recovery:          PASS      (P-4 inconsistent status code)

60k Customer Capacity:     NOT PROVEN
30k Driver Capacity:       NOT PROVEN

Overall:                   ISSUES FOUND
Production:                NOT READY
```

### Prioritised

**P0 — production blockers:** Q-1, Q-2 (hardcoded distance / unreachable zero-distance guard) · P-2 (Socket.IO cannot scale) · PLAT-1 (no payment gateway) · PLAT-2 (no push provider)

**P1 — serious risks:** Q-3 (false distance provenance) · Q-4 (decrypted key in Redis) · F1-01 (registration token race) · P-1 (unbounded quote/fare divergence) · P-3 (connection budget) · PLAT-3 (DI import cycle)

**P2 — important:** Q-5, Q-6, F1-02, F1-03, F1-04, F1-05, P-4, P-5, P-6, P-7, P-8

**P3 — optimisation:** Q-7, F2-01, F2-02, F2-03, P-9, P-10

---

_Nothing in this report was fixed. Test data was created via SQL and admin APIs and removed afterwards; `git status` shows only the two report documents. Where a test could not be run — digital payment, queue worker behaviour, SMS failure, multi-instance realtime, production-volume load — it is marked BLOCKED or NOT PROVEN rather than estimated._
