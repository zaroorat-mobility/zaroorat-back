# Production Ride Workflow Audit

**Scope:** Full cross-module audit of the ride lifecycle — Auth → Users → Files → Drivers → Geo → Rides → Payments — plus core, events, workers, database and tests.

**Method:** Source inspection only. No README, prior audit doc, or FLOW.md was treated as evidence. Every claim below cites the file that proves it. Verification commands were run and their real output is reported in §31.

**Date:** 2026-08-15 · **Branch:** `feature/auth` · **Commit base:** `290b3c6`

---

# 1. Executive Summary

The platform has a **strong foundation and a missing middle**.

What is genuinely production-grade: the authentication stack (OTP, rotating single-use refresh tokens with reuse detection, epoch-based revocation, deny-by-default route guard), the transactional outbox relay (claim tokens, stale reclaim, dead-lettering, multi-instance safe), the Files module (quarantine bucket, content inspection, ownership policy), the payment webhook path (signature, replay window, dedup and ledger mutation in one transaction), and BOLA/IDOR protection across ride, driver and payment reads.

What is not there at all: **dispatch**. `src/modules/geo/index.ts` is `export {};`. `DispatchService.offerToDriver` has **zero callers**. `POST /rides/requests` writes a row and returns — it never searches for drivers, never sets `SEARCHING`, never creates a `RideDispatch`, and never notifies anyone. `src/plugins/socket/socket.plugin.ts` is also `export {};`, so there is no channel to deliver an offer on even if one were created. The advertised customer journey stops dead after the request row is inserted.

Because dispatch is absent, `POST /rides/accept` accepts a bare `requestId` from any operable driver with no offer check, no busy check, and no driver-availability write. And because no code path can mark a `DriverDocument` as `VERIFIED` while `StatusService.setOnline` requires a verified driving licence, **no driver can go online in production at all** — the integration fixtures work around this by inserting the verified document directly into the database (`tests/integration/helpers/fixtures.ts:31-38`).

On the money side the double-entry ledger is correct and well tested, but the **customer wallet balance column is never reconciled with it**: ride completion debits `CUSTOMER_WALLET` in the ledger and payment-intent success credits it, while `customer_wallets.balance` is touched by neither. Two independent representations of the same balance drift apart from the first non-cash ride.

**Verdict: NOT PRODUCTION READY.** 12 P0 findings, 13 P1, 8 P2. Details in §32–§34.

---

# 2. Current Architecture

Modular monolith. Fastify 5 + Awilix DI (`src/core/di.ts`), Prisma 7 over PostgreSQL with PostGIS, ioredis, BullMQ, pino. Two processes: `src/server.ts` (API) and `src/worker.ts` (BullMQ maintenance workers).

Cross-module communication is **direct in-process service calls**, not HTTP. `LifecycleService` imports `LedgerService` from `@modules/payments` (`lifecycle.service.ts:22`); `RideOtpService` imports `OtpHasher` from `@modules/auth` (`ride-otp.service.ts:1`). Per §43 of the brief this is the correct pattern for a modular monolith and no HTTP endpoint should be added for it. **VERIFIED as appropriate.**

Every module follows `routes → controllers → services → repositories → DatabaseService`. Transactions come from `TransactionManager.execute()`, which always opens a **new** `$transaction` (`src/core/database/TransactionManager.ts:34`) — it does not detect or join an ambient transaction. This matters; see F-P0-10.

**Stub modules** (contain only `export {};`, 11 bytes): `geo`, `dispatch`, `matching`, `pricing`, `riders`, `vehicles`, `documents`, `onboarding`, `promotions`, `reviews`, `sos`, `support`, `settings`, `chat`, `admin`, `analytics`. Also stubs: `src/middleware/auth.ts`, `src/middleware/idempotency.ts`, `src/middleware/role.ts`, `src/plugins/socket/socket.plugin.ts`, `src/jobs/producers/index.ts`, `src/jobs/consumers/index.ts`.

---

# 3. Module Ownership

Actual ownership as proven by the code, compared against the expected map in the brief.

| Responsibility                                                | Expected        | **Actual**                                                                        | Status                     |
| ------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------- | -------------------------- |
| Authentication, OTP, tokens, sessions, devices                | Auth            | Auth                                                                              | VERIFIED                   |
| Customer profile, contacts, places, lifecycle                 | Users           | Users                                                                             | VERIFIED                   |
| Driver identity, verification, online/offline, heartbeat, GPS | Drivers         | Drivers                                                                           | VERIFIED                   |
| Driver documents                                              | Drivers + Files | **Drivers only** — `submitDocument` takes a raw `fileUrl: string`                 | **NOT VERIFIED** (F-P1-01) |
| Geographic queries                                            | Geo             | **Nobody.** Geo is `export {};`. Only Haversine in `rides/utils/distance.util.ts` | **NOT VERIFIED** (F-P0-02) |
| Ride quote / request / lifecycle / OTP / fare / cancellation  | Rides           | Rides                                                                             | VERIFIED                   |
| Ride dispatch                                                 | Rides           | **Nobody.** `DispatchService` exists, has no caller                               | **NOT VERIFIED** (F-P0-01) |
| Payment intent, wallet, ledger, refund, settlement, payout    | Payments        | Payments                                                                          | VERIFIED                   |
| File storage                                                  | Files           | Files                                                                             | VERIFIED                   |
| Outbox                                                        | Core/Events     | `src/core/events/`                                                                | VERIFIED                   |
| Background jobs                                               | Workers         | `src/jobs/` + per-module `jobs/`                                                  | VERIFIED                   |
| Rate limiting, distributed locks                              | Core/Redis      | `src/core/cache/stores/`                                                          | VERIFIED                   |

**Boundary violations found:** none of the prohibited kind. Rides does not re-implement geo (it has no geo at all), does not re-implement auth, and does not write payment tables directly — it calls `LedgerService`. Drivers does not re-implement file storage (it stores a URL string, which is a different problem — F-P1-01). The one real duplication is `driver_wallets` vs the `DRIVER_PAYABLE` ledger account (§28).

---

# 4. Customer Workflow

| Step                 | Endpoint                 | Status                                                                                             |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| OTP send             | `POST /auth/otp/send`    | VERIFIED                                                                                           |
| OTP verify → tokens  | `POST /auth/otp/verify`  | VERIFIED                                                                                           |
| Profile              | `GET /users/me`          | VERIFIED                                                                                           |
| Quote                | `POST /rides/quote`      | PARTIALLY VERIFIED — straight-line × 1.3, no routing, not persisted, not bound to the request      |
| Ride request         | `POST /rides/requests`   | PARTIALLY VERIFIED — row is created; nothing follows                                               |
| **Driver search**    | —                        | **NOT VERIFIED — does not exist**                                                                  |
| **Dispatch / offer** | —                        | **NOT VERIFIED — does not exist**                                                                  |
| Active ride          | `GET /rides/active`      | VERIFIED                                                                                           |
| Ride tracking        | —                        | **NOT VERIFIED** — no socket layer; `GET /drivers/:id/location` refuses non-self callers (F-P1-11) |
| Receipt              | `GET /rides/:id/receipt` | PARTIALLY VERIFIED — generated lazily on read                                                      |
| History              | `GET /rides/history`     | VERIFIED                                                                                           |

The chain breaks irrecoverably at driver search. A customer can request a ride; no driver will ever be told about it.

---

# 5. Driver Workflow

| Step                                 | Endpoint                                  | Status                                                                              |
| ------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| OTP login                            | `POST /auth/otp/send` + `/verify`         | VERIFIED                                                                            |
| Driver profile                       | `GET /drivers/me` (auto-creates)          | VERIFIED                                                                            |
| Documents                            | `POST /drivers/:driverId/documents`       | PARTIALLY VERIFIED — bypasses Files (F-P1-01)                                       |
| Admin verification of the **driver** | `POST /drivers/:id/verify`                | VERIFIED                                                                            |
| Admin verification of a **document** | —                                         | **NOT VERIFIED — no code path exists** (F-P0-07)                                    |
| Online                               | `POST /drivers/status/online`             | **BLOCKED** by the above                                                            |
| Heartbeat                            | `POST /drivers/heartbeat`                 | VERIFIED                                                                            |
| GPS                                  | `POST /drivers/location`                  | VERIFIED (plausibility + mock-location screening)                                   |
| **Receive offer**                    | —                                         | **NOT VERIFIED — does not exist**                                                   |
| Accept                               | `POST /rides/accept`                      | PARTIALLY VERIFIED — atomic against other drivers, but unguarded (F-P0-03, F-P0-04) |
| Arrive / Start / Complete            | `POST /rides/:id/{arrive,start,complete}` | PARTIALLY VERIFIED                                                                  |
| Earnings                             | `GET /drivers/:driverId/wallet`           | **NOT VERIFIED** — reads a table nothing writes (F-P1-06)                           |
| Settlement                           | `SettlementJob`                           | PARTIALLY VERIFIED — correct logic, never scheduled (F-P1-08)                       |
| Payout                               | `POST /payments/payouts`                  | PARTIALLY VERIFIED — gateway call inside the transaction (F-P0-11)                  |

---

# 6. Complete Ride Lifecycle

Implemented in `LifecycleService` (`src/modules/rides/services/lifecycle/lifecycle.service.ts`).

```
RideRequest(CREATED) ──accept──> Ride(ACCEPTED) ──> DRIVER_ARRIVED ──otp──> IN_PROGRESS ──> COMPLETED
                                       │                  │                     │
                                       └── CANCELLED_BY_{CUSTOMER,DRIVER,SYSTEM}┘   (IN_PROGRESS: SYSTEM only)
```

The `Ride` row is created **already in `ACCEPTED`** (`ride.repository.ts:51`). `REQUESTED`, `SEARCHING` and `NO_DRIVERS_FOUND` exist in the `RideStatus` enum (`prisma/schema/shared/enums.prisma:92-104`) but no ride is ever written in those states — they belong to the missing dispatch phase. `DRIVER_ARRIVING` is reachable in the transition table but no endpoint writes it.

---

# 7. Auth → Users → Drivers → Geo → Rides → Payments Workflow

```
Auth        JWT(sub,sid,epoch,roles) ─ deny-by-default onRequest hook (auth.plugin.ts:128)
  ↓
Users       users.status must be ACTIVE (assertAuthenticatable, auth.service.ts:410)
  ↓
Drivers     authorize({requireOperableDriver}) → DriverAccessRepository.isOperableDriver
              = VERIFIED && !isSuspended && !deletedAt              ✓ separate from authentication
  ↓
Geo         ✗ ABSENT — no module, no spatial query, no GIST index
  ↓
Rides       LifecycleService — transactional, row-locked, state-machine enforced in the service
  ↓
Payments    LedgerService.recordTripPayment(tx) — same transaction as the ride mutation   ✓
              ✗ but no PaymentIntent, no balance check, no wallet-column update
```

Authentication and driver authorization **are** correctly separated: a valid JWT does not imply a driver can operate. `requireOperableDriver` is enforced on `/rides/accept|arrive|start|complete` (`ride.routes.ts:17-22`) and `/drivers/status/online`. **VERIFIED.**

---

# 8. File Workflow

`POST /files/` → presign → `POST /files/:id/complete` → `FileReference` → read via `GET /files/:id/url`.

Ownership, purpose-scoped ops access, MIME sniffing, size caps, quarantine bucket, EXIF-location rejection and soft-delete are all implemented and tested (`src/modules/files/policies/read-policy.ts`, `utils/content-inspector.ts`, 10 integration suites). **VERIFIED.**

The break is at the consumer: driver documents never enter this pipeline (F-P1-01).

---

# 9. Redis Usage

| Name               | Key                      | Purpose                 | TTL                    | Source of truth         | Loss tolerable?    | Failure behavior                                      | Rebuildable?       | Security critical | Multi-instance |
| ------------------ | ------------------------ | ----------------------- | ---------------------- | ----------------------- | ------------------ | ----------------------------------------------------- | ------------------ | ----------------- | -------------- |
| OTP secret         | `otp:{purpose}:{phone}`  | Hashed OTP              | `otpConfig.ttlSeconds` | **Redis (only)**        | Yes — user resends | Verify fails                                          | No (by design)     | Yes               | Yes            |
| OTP attempts       | `otp:att:{phone}`        | Brute-force counter     | lockout                | Redis                   | Degrades security  | Counter resets                                        | No                 | **Yes**           | Yes            |
| OTP lock           | `otp:lock:{phone}`       | Lockout                 | `lockoutSeconds`       | Redis                   | Degrades security  | Lock lifted                                           | No                 | **Yes**           | Yes            |
| OTP challenge      | `otp:challenge:…`        | Resend throttle         | resend interval        | Redis                   | Yes                | Resend allowed                                        | No                 | No                | Yes            |
| Security epoch     | `auth:epoch:{userId}`    | Token invalidation      | —                      | Redis                   | **No**             | **Fails closed → 503** (`auth.plugin.ts:56-64`)       | Partially          | **Yes**           | Yes            |
| Session revocation | `auth:sid:revoked:{sid}` | Revoked sessions        | session TTL            | Redis + `user_sessions` | No                 | **Fails closed → 503**                                | Yes, from Postgres | **Yes**           | Yes            |
| Rate limit         | `ratelimit:{scope}:{id}` | Throttling              | window                 | Redis                   | Yes                | **Fails closed → 503** (`rate-limit.plugin.ts:80-86`) | No                 | Yes               | Yes            |
| Idempotency        | `idem:{key}`             | Replay suppression      | per-call               | **Redis (only)**        | **No — see below** | Duplicate charge possible                             | No                 | **Yes**           | Yes            |
| Distributed locks  | `lock:{resource}`        | Worker mutual exclusion | 15–30s                 | Redis                   | Yes                | Job skipped                                           | N/A                | No                | Yes            |
| BullMQ             | bull:*                   | Job queues              | —                      | Redis                   | Partly             | Jobs lost                                             | No                 | No                | Yes            |

Security-critical Redis paths **fail closed** — verified in `auth.plugin.ts:56-64`, `:95-103`, `:111-119` and `rate-limit.plugin.ts:80-86`. This is correct.

**Concern:** payment idempotency lives only in Redis (`IdempotencyRepository` → `RedisService.idempotency`, `src/modules/payments/repositories/idempotency.repository.ts:27`). A Redis flush during a retry window permits a duplicate charge. Payout and refund each have a **database** unique key on `idempotencyKey` as a second line of defence (`payout.service.ts:39,148-152`), so those are safe. `POST /payments/intents` and `POST /payments/wallet/topup` are not — see F-P1-09.

---

# 10. PostgreSQL Source-of-Truth Map

| Business truth                 | Table                             | Written by                     | Read by                                    |
| ------------------------------ | --------------------------------- | ------------------------------ | ------------------------------------------ |
| Identity                       | `users`                           | Auth                           | all                                        |
| Session / refresh token        | `user_sessions`, `refresh_tokens` | Auth                           | Auth                                       |
| Driver identity + verification | `drivers`                         | Drivers                        | Drivers, Auth gate, Rides                  |
| Driver online state            | `driver_online_status`            | Drivers                        | Drivers                                    |
| Driver GPS                     | `driver_locations`                | Drivers                        | Drivers only — **never queried spatially** |
| Ride request                   | `ride_requests`                   | Rides                          | Rides                                      |
| Dispatch offer                 | `ride_dispatches`                 | **nobody**                     | `DispatchTimeoutJob` (always empty)        |
| Ride                           | `rides`                           | Rides                          | Rides, Payments (settlement)               |
| Fare                           | `ride_fares`                      | Rides                          | Rides, Payments settlement                 |
| **Money**                      | `payment_ledger_entries`          | Payments                       | Payments                                   |
| Customer balance               | `customer_wallets.balance`        | Payments (topup/hold **only**) | Payments — **diverges from ledger**        |
| Driver earnings                | `driver_wallets`                  | **nobody**                     | `GET /drivers/:id/wallet`                  |
| Events                         | `outbox_events`                   | all, in-transaction            | `OutboxRelay`                              |

---

# 11. Database Relationship Map

`User 1─1 Driver 1─1 DriverLocation / DriverOnlineStatus / DriverWallet`, `1─* DriverDocument / DriverShiftLog`.
`User 1─* RideRequest 1─* RideDispatch`, `RideRequest 1─1 Ride` (unique `rides.request_id`, migration `20260810000000`).
`Ride 1─1 RideFare / RideCancellation / RideReceipt`, `1─* RideOtp / RideStatusEvent`.
`Ride 1─* PaymentIntent 1─* PaymentTransaction 1─* Refund`. `PaymentLedgerEntry` grouped by `entryGroup`.
`Driver 1─* DriverSettlement 1─* DriverPayout`.

**Indexes present:** `ride_requests(customerId)`, `(status)`; `rides(customerId)`, `(driverId)`, `(status)`, `(createdAt)`, unique `(requestId)`; `ride_dispatches` unique `(requestId,driverId)`, `(driverId)`, `(response)`; `ride_status_events(rideId,createdAt)`; `ride_otps(rideId)`.

**Indexes missing:** no GIST index on `driver_locations.location`, `rides.pickup_location`, or `ride_requests.pickup_location` — the only GIST in the whole migration set is `ix_saved_places_location` (`20260801000000`). No partial index for active rides. No unique constraint enforcing one active ride per customer or per driver. `ride_requests.expiresAt` and `ride_dispatches.expiresAt` unindexed (acceptable at current volume; the status/response indexes carry the scan).

**Money columns** are all `Decimal(10,2)` — correct at rest. The defect is in-process arithmetic (F-P2-01).

---

# 12. API-to-Service-to-Repository Map

| Endpoint                           | Controller                    | Service                              | Repository                                               | Outbox                  | Notes                        |
| ---------------------------------- | ----------------------------- | ------------------------------------ | -------------------------------------------------------- | ----------------------- | ---------------------------- |
| `POST /rides/quote`                | `RideRequestController.quote` | `FareService.calculateFareQuote`     | —                                                        | —                       | pure, not persisted          |
| `POST /rides/requests`             | `.createRequest`              | `RideRequestService.createRequest`   | `RideRequestRepository.create`                           | `ride.requested`        | **no dispatch follows**      |
| `POST /rides/accept`               | `RideStateController.accept`  | `LifecycleService.acceptRideRequest` | request lock + `claimForMatch` + `RideRepository.create` | `ride.accepted`         | **no offer/busy check**      |
| `POST /rides/:id/arrive`           | `.arrive`                     | `.markDriverArrived`                 | `lockForUpdate` + `updateStatusIf`                       | `ride.driver_arrived`   | ok                           |
| `POST /rides/:id/start`            | `.start`                      | `.startRide`                         | + `RideOtpRepository`                                    | `ride.started`          | **OTP attempts roll back**   |
| `POST /rides/:id/complete`         | `.complete`                   | `.completeRide`                      | + `RideFareRepository` + `LedgerService`                 | `ride.completed`        | **client-supplied distance** |
| `POST /rides/:id/cancel`           | `.cancel`                     | `.cancelRide`                        | + `RideCancellationRepository`                           | `ride.cancelled`        | fee never charged            |
| `GET /rides/:id`, `/receipt`       | `RideQueryController`         | `ReceiptService`                     | `RideRepository.findById`                                | —                       | `assertRideParty` ✓          |
| `POST /drivers/status/online`      | `DriverStatusController`      | `StatusService.setOnline`            | driver lock + shift + status                             | `driver.status_changed` | no active-trip check         |
| `POST /drivers/location`           | `DriverLocationController`    | `LocationService`                    | `DriverLocationRepository`                               | —                       | no lock ✓                    |
| `POST /payments/webhooks/:gateway` | `WebhookController`           | `WebhookService`                     | `WebhookRepository` + `IntentService`                    | `payment.*`             | exemplary                    |
| `POST /payments/payouts`           | `PayoutController`            | `PayoutService`                      | settlement lock + payout + ledger                        | `payout.*`              | gateway inside tx            |

---

# 13. Transaction Boundaries

| Operation                         | Tx  | Locks                                                    | Outbox in tx | Verdict                                     |
| --------------------------------- | --- | -------------------------------------------------------- | ------------ | ------------------------------------------- |
| ride request                      | ✓   | none                                                     | ✓            | PARTIAL — duplicate check is outside the tx |
| driver accept                     | ✓   | `ride_requests FOR UPDATE` + conditional `claimForMatch` | ✓            | VERIFIED for the two-driver race            |
| driver online                     | ✓   | `drivers FOR UPDATE`                                     | ✓            | PARTIAL — no active-trip check              |
| driver offline                    | ✓   | `drivers FOR UPDATE`                                     | ✓            | VERIFIED                                    |
| driver suspend                    | ✓   | `drivers FOR UPDATE`                                     | ✓            | **BROKEN — nested transaction deadlock**    |
| ride arrive/start/complete/cancel | ✓   | `rides FOR UPDATE` + `updateStatusIf` CAS                | ✓            | VERIFIED for state; other defects noted     |
| wallet hold / topup               | ✓   | `customer_wallets FOR UPDATE`                            | ✓            | VERIFIED                                    |
| payment confirm                   | ✓   | `payment_intents FOR UPDATE`                             | ✓            | VERIFIED                                    |
| webhook                           | ✓   | dedup insert + intent lock                               | ✓            | VERIFIED                                    |
| refund                            | ✓   | —                                                        | ✓            | PARTIAL — gateway call inside tx            |
| payout                            | ✓   | `driver_settlements FOR UPDATE`                          | ✓            | PARTIAL — gateway call inside tx            |

Every repository accepts `tx?: TransactionClient` and resolves `const client = tx ?? this.db.client`. I found **no** case of the root Prisma client being used inside a transaction body. **VERIFIED.**

---

# 14. Idempotency Analysis

| Endpoint                                  | Key required | Mechanism                              | Same key + different payload | Verdict          |
| ----------------------------------------- | ------------ | -------------------------------------- | ---------------------------- | ---------------- |
| `POST /auth/otp/verify`                   | optional     | `IdempotencyStore.runOnce`             | not detected                 | PARTIAL          |
| `POST /files/`                            | ✓            | Redis                                  | not detected                 | PARTIAL          |
| `POST /payments/intents`                  | ✓            | `IdempotencyRepository` + payload hash | **409 conflict** ✓           | VERIFIED         |
| `POST /payments/wallet/topup` \| `/hold`  | ✓            | same                                   | ✓                            | VERIFIED         |
| `POST /payments/refunds`                  | ✓            | Redis + DB unique                      | ✓                            | VERIFIED         |
| `POST /payments/payouts`                  | ✓            | Redis + DB unique + P2002 recovery     | ✓                            | VERIFIED         |
| `POST /rides/requests`                    | **none**     | —                                      | —                            | **NOT VERIFIED** |
| `POST /rides/accept`                      | **none**     | request CAS gives natural idempotency  | —                            | PARTIAL          |
| `POST /rides/:id/{start,complete,cancel}` | **none**     | `updateStatusIf` CAS → 2nd call 409s   | —                            | PARTIAL          |

`grep -rn "idempotency-key" src` returns hits in auth, files, users and payments controllers — **and nothing in `src/modules/rides/`**. The CAS guards mean a retry cannot double-mutate state, but a retried `POST /rides/requests` after a network timeout creates a second request row for the same customer, and the caller cannot recover the first response.

---

# 15. Concurrency / Race Condition Analysis

| Race                               | Protection                                                                                         | Verdict                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------- |
| Two drivers accept one request     | request `FOR UPDATE` + `claimForMatch` conditional update + unique `rides.request_id`              | **VERIFIED**               |
| Customer creates two rides at once | `findActiveByCustomer` **outside** the tx, no lock, no constraint                                  | **NOT VERIFIED** (F-P1-12) |
| One driver accepts two rides       | none — `findActiveByDriver` exists but is not called                                               | **NOT VERIFIED** (F-P0-04) |
| Cancel vs accept                   | different rows (request vs ride); accept can win after a cancel attempt on a not-yet-existing ride | PARTIAL                    |
| Cancel vs complete                 | both take `rides FOR UPDATE` + CAS; loser gets `InvalidRideStateTransition`                        | **VERIFIED**               |
| Start vs cancel                    | same CAS                                                                                           | **VERIFIED**               |
| Heartbeat vs timeout worker        | worker does **not** re-check `heartbeatAt` under the lock                                          | **NOT VERIFIED** (F-P1-03) |
| Driver online vs suspension        | `setSuspended` deadlocks against itself                                                            | **NOT VERIFIED** (F-P0-10) |
| Two wallet holds                   | wallet `FOR UPDATE` + available-balance check                                                      | **VERIFIED** (tested)      |
| Two payment confirmations          | intent `FOR UPDATE` + status short-circuit                                                         | **VERIFIED**               |
| Duplicate webhook                  | `findOrPersist` on `gatewayEventId` inside the tx                                                  | **VERIFIED** (tested)      |
| Duplicate payout key               | Redis + DB unique + P2002 recovery                                                                 | **VERIFIED** (tested)      |
| Refresh token replay               | `claimForRotation` single-use + family revoke + epoch bump                                         | **VERIFIED** (tested)      |
| Request expiry vs accept           | expiry job updates by id **unconditionally**                                                       | **NOT VERIFIED** (F-P1-13) |

---

# 16. Security Audit

**Strong:** deny-by-default `onRequest` guard with an explicit `config.public` opt-out; HS256 JWT with issuer/audience/exp/iat/sid/epoch verification; refresh tokens stored HMAC-hashed with a pepper and rotated single-use; OTP hashed in Redis, never logged, consumed atomically, rate-limited per phone/device/IP with lockout; challenge-to-phone binding blocks cross-account OTP submission; webhook HMAC + replay window + dedup; presigned URLs scoped and expiring; log redaction configured (`src/shared/logger/redact.ts`); all SQL parameterised via Prisma tagged templates — no injection found; rate limiter and auth guard both fail closed.

**Weak or absent:**

- OTP brute force on the **ride start** OTP is unbounded (F-P0-05) — the auth OTP is fine, the ride OTP is not.
- Ride fare is derived from client-supplied trip distance (F-P0-06).
- Any operable driver can claim any pending ride request (F-P0-03).
- Driver documents accept an arbitrary URL from the client (F-P1-01).
- `RideOtpService` compares hashes with `!==` (`ride-otp.service.ts:53`) — not constant-time (F-P2-02).
- One global `paymentConfig.webhookSecret` for all gateways (F-P2-03).
- GPS spoofing: `isMockLocation` is self-reported and correctly treated as a signal, backed by a real server-side plausibility check (`location-plausibility.ts`). **VERIFIED as appropriate** — the code does not mistake it for proof.
- Device tamper signals (`isRooted`/`isJailbroken`) are self-reported; `requireUntamperedDevice` exists and is used on sensitive paths. Same caveat, correctly scoped.

---

# 17. BOLA / IDOR Audit

| Route                                                             | Guard                                                            | Verdict                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| `GET /rides/:id`, `/:id/receipt`                                  | `assertRideParty` — customer, driver's **user id**, or staff     | **VERIFIED**               |
| `GET /rides/history`                                              | scoped to `callerId`, path/body ids ignored                      | **VERIFIED**               |
| `POST /rides/:id/{arrive,start,complete}`                         | driver id derived from JWT; `lockAndValidate` rejects a mismatch | **VERIFIED**               |
| `POST /rides/accept`                                              | driver id from JWT ✓ — but `requestId` is unauthorized           | **NOT VERIFIED** (F-P0-03) |
| `PATCH /drivers/:driverId/profile`, `POST /:driverId/documents`   | `actingDriverId` — path param **ignored entirely**               | **VERIFIED**               |
| `GET /drivers/:driverId/wallet`, `/transactions`, `/:id/location` | `authorizedDriverId` — self, or staff role                       | **VERIFIED**               |
| `POST /drivers/:id/verify`, `/:id/suspend`                        | `authorize({roles:['admin']})`                                   | **VERIFIED**               |
| `POST /payments/intents/:intentId/confirm`, `/refunds`            | `assertOwnerOrStaff`                                             | **VERIFIED**               |
| `POST /payments/payouts`                                          | `roles:['admin','finance']`                                      | **VERIFIED**               |
| `GET /files/:id`, `/:id/url`, `DELETE`                            | `decideRead` owner-or-purpose-scope                              | **VERIFIED**               |

`tests/integration/authorization-bola.test.ts` covers all of the above with real HTTP. This is the strongest area of the codebase.

---

# 18. Device Security Audit

Devices are registered per session (`DeviceService.register`), bound to `sid`, and listable/revocable via `/auth/me/devices`. `requireUntamperedDevice` looks the device up by session and refuses rooted/jailbroken devices, **failing closed** on a lookup error. Signals are client-reported and are not treated as attestation. **VERIFIED**, with the standing caveat that real attestation (Play Integrity / DeviceCheck) is not implemented.

---

# 19. Geo / Location Security Audit

Coordinates are schema-validated. `assessPlausibility` (`src/modules/drivers/services/location/location-plausibility.ts`) rejects physically impossible jumps against the previous fix — a genuine server-side control, not a client assertion. `isMockLocation` is rejected when `driverConfig.rejectMockLocation` is on. `GET /drivers/:id/location` is self-or-staff only.

**Gap:** because there is no dispatch and no live channel, a customer on an active ride cannot see their driver — `authorizedDriverId` will refuse them (F-P1-11). **NOT VERIFIED** for the tracking requirement.

**Gap:** no GIST index anywhere on driver or ride geography columns. Any future proximity query is a sequential scan.

---

# 20. Payment Integrity Audit

**Correct:** `LedgerRepository.postGroup` refuses to write unless debits equal credits, and rejects non-positive amounts (`ledger.repository.ts:37`, `ledger.service.ts:16`). All ledger writes require a `TransactionClient` — the signature makes an out-of-transaction posting impossible. Cash rides post only the commission the driver owes; wallet rides post the full three-legged group. Settlement is derived from real completed fares, is idempotent per period, and payout is bounded by `netPayable − alreadyCommitted` under a settlement row lock. `tests/integration/earnings-pipeline.test.ts` proves all of this against a real database.

**Broken:**

1. `customer_wallets.balance` is never debited on ride completion and never credited on intent success, while the ledger's `CUSTOMER_WALLET` account is (F-P0-08). Two balances, one truth, guaranteed divergence.
2. A non-cash ride completes with `paymentStatus = 'PENDING'` and a ledger debit against a wallet that was never checked for funds and never charged. No `PaymentIntent` is created (F-P0-09).
3. `WalletService.hold` locks funds that ride completion never consumes or releases — every hold leaks.
4. Cancellation fees are recorded with `feeCharged = true` and never posted anywhere (F-P1-04).

---

# 21. Webhook Audit

`WebhookService.handleGatewayWebhook`: HMAC verify → event-id extraction → freshness window → **single transaction** containing `findOrPersist` (dedup), `applyConfirmation` (intent status + `PaymentTransaction` + ledger group + outbox), `markProcessed`. A replayed webhook short-circuits at `isDuplicate` before touching money. Raw body is preserved by a scoped parser so the signature is computed over the exact bytes.

**VERIFIED.** This is the reference implementation the rest of the codebase should be measured against. Only defect: the secret is not per-gateway (F-P2-03).

---

# 22. Outbox / Event Audit

Every durable event is enqueued through `EventPublisher.publish(input, tx)` into `outbox_events` **inside the caller's transaction**. `EventPublisher` refuses a durable event with no `aggregateId` and refuses a best-effort event that was handed a `tx` — both throw rather than silently degrade (`EventPublisher.ts:22-27`, `:51-56`). Events emitted: `ride.requested|accepted|driver_arrived|started|completed|cancelled|dispatch_offered`, `driver.status_changed|onboarded|verified|suspended`, `payment.*`, `wallet.*`, `payout.*`, `auth.*`, `user.*`. No duplicate event system exists.

`OutboxRelay` claims batches with a claim token, verifies ownership on every state write, reclaims claims from dead relays after 5 minutes, retries with jittered exponential backoff to 8 attempts, dead-letters after that, releases the undispatched tail on shutdown, and reports backlog metrics. **Multi-instance safe. VERIFIED.**

Only gap: `ride.dispatch_offered` can never fire, because nothing calls `offerToDriver`.

---

# 23. Queue / Worker Audit

| Worker                                | Scheduled                     | Distributed lock | Idempotent            | Transactional          | Verdict                               |
| ------------------------------------- | ----------------------------- | ---------------- | --------------------- | ---------------------- | ------------------------------------- |
| `OutboxRelay`                         | in-process timer              | claim tokens     | ✓                     | per-event              | **VERIFIED**                          |
| `FileSweeperJob` / `FileRetentionJob` | ✓ cron                        | ✓                | ✓                     | ✓                      | VERIFIED                              |
| `AccountErasureJob`                   | ✓ cron                        | ✓                | ✓ (locks + re-checks) | ✓                      | VERIFIED                              |
| `AuthRetentionJob`                    | ✓ cron                        | ✓                | ✓                     | ✓                      | VERIFIED                              |
| `DispatchTimeoutJob`                  | ✓ cron                        | ✓                | ✓                     | ✗ per-row              | operates on a permanently empty table |
| `RequestExpiryJob`                    | ✓ cron                        | ✓                | ✓                     | ✗ unconditional update | **PARTIAL** (F-P1-13)                 |
| `HeartbeatTimeoutJob`                 | ✓ cron                        | ✓                | ✓                     | delegates              | **PARTIAL** — no re-check (F-P1-03)   |
| `DocExpirationJob`                    | ✓ cron                        | ✓                | ✓                     | per-row                | VERIFIED                              |
| `ReconciliationJob`                   | ✓ cron                        | ✓                | ✓                     | ✓                      | VERIFIED                              |
| `SettlementJob`                       | **✗ absent from `JOB_NAMES`** | ✓                | ✓                     | ✓                      | **NOT VERIFIED** (F-P1-08)            |

Every scheduled job takes a Redis lock before doing work, so running two worker replicas is safe.

---

# 24. File / S3 Security Audit

Two-bucket design: uploads land in a quarantine bucket and are promoted only after scan and content inspection (`storage.config.ts:98` refuses to start with `STORAGE_PROVIDER=s3` and no quarantine bucket — a deliberate fail-fast). Storage keys are server-generated and namespaced by owner (`utils/storage-key.ts`). Presigned URLs expire. MIME is verified by magic bytes, not by the declared header. EXIF GPS causes rejection. Soft-deleted and non-`ACTIVE` files are unreadable. **VERIFIED.**

---

# 25. Redis Failure Analysis

| Failure                    | Effect                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis down at request time | All authenticated requests → **503** (epoch + revocation checks fail closed). Correct.                                                                                                                                            |
| Redis down                 | Login impossible (OTP store unavailable). Correct — fail closed.                                                                                                                                                                  |
| Redis flushed              | In-flight OTPs void; lockout counters reset (**window of weakened brute-force protection**); **payment idempotency records lost → a retry can double-charge an intent or topup** (payout/refund are protected by DB unique keys). |
| Redis down                 | BullMQ stops; maintenance jobs pause. Outbox relay is unaffected (Postgres-backed).                                                                                                                                               |
| Redis down                 | Ride/driver/payment **business state is unaffected** — no business truth is Redis-only.                                                                                                                                           |

The one violation of "no permanent business truth in Redis alone" is payment idempotency for intents and topups.

---

# 26. PostgreSQL Failure Analysis

`PrismaErrorMapper` maps Prisma faults to typed `DatabaseError`s; the global error handler returns 5xx with a request id and no leaked internals. `RetryService` retries transient connection faults. `/ready` (`src/core/health/readiness.ts`) probes the database and reports unready. Because all business writes are inside `$transaction`, a mid-write outage rolls back — **no API path reports success on a failed write.** Outbox rows and their business mutation share the transaction, so no event can survive a rolled-back write. **VERIFIED.**

---

# 27. Multi-Instance Scaling Analysis

No module-level mutable state was found outside the DI container (singletons are stateless services). Sessions, tokens, locks, idempotency, and queues are all external. `OutboxRelay` is the only in-process scheduler and is safe under concurrency via claim tokens; all cron jobs take Redis locks.

**One caveat:** `OutboxRelay.start()` runs in every API instance. Correctness holds (claim tokens), but N instances poll every second. Prefer running it in the worker process only.

`GET /drivers/:id/location` reads Postgres, not process memory — safe. **VERIFIED** overall.

---

# 28. Database Duplication Audit

| Truth                | Representations                                                                | Owner    | Consequence                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Customer balance** | `customer_wallets.balance` **and** ledger `CUSTOMER_WALLET`                    | Payments | **Divergent.** Topup writes both; ride completion and intent success write only the ledger. The column under-reports spend and over-reports credit. **P0 — F-P0-08.**                                                                                 |
| **Driver earnings**  | `ride_fares.driver_earning`, ledger `DRIVER_PAYABLE`, `driver_wallets.balance` | split    | `driver_wallets` is **written by nothing** — `GET /drivers/:id/wallet` always returns 0. Settlement derives from `ride_fares`; payout debits `DRIVER_PAYABLE`. Two live sources with no reconciliation, plus one dead one. **P1 — F-P1-06, F-P1-07.** |
| Ride status          | `rides.status` + `ride_status_events`                                          | Rides    | Event log is append-only history, not a second truth. **Fine.**                                                                                                                                                                                       |
| Driver online state  | `drivers.isAvailable` + `driver_online_status.status`                          | Drivers  | Written together in one transaction. Acceptable projection, but two writes to keep in step. **P2.**                                                                                                                                                   |
| Session revocation   | `user_sessions` + Redis `sidRevoked`                                           | Auth     | Redis is a cache over Postgres, rebuildable. **Fine.**                                                                                                                                                                                                |

Nothing has been removed. Each duplication is described with its consequence, per the brief.

---

# 29. API Gap Analysis

Answers to the twenty questions in §42, from the code:

1. **Does `/rides/requests` trigger dispatch?** **No.** `RideRequestService.createRequest` ends at `requestRepo.create` + one outbox event.
2. **Does dispatch query Geo?** **No.** There is no Geo module and no spatial query anywhere.
3. **Does the driver receive the offer?** **No.** No offer is created; no socket layer exists to deliver one.
4. **Does `/rides/accept` atomically claim the ride?** **Yes** — row lock + conditional claim + unique constraint.
5. **Does accepting update driver availability?** **No.** `drivers.isAvailable` and `driver_online_status` are untouched.
6. **Is RideOtp created at the correct point?** **Yes** — inside the accept transaction.
7. **Does `/start` verify the OTP correctly?** Partly. Hash, expiry, single-use and an attempt cap all exist — but the attempt increment rolls back on failure, so the cap never binds.
8. **Does completion call Payments correctly?** Partly. It posts the ledger group in the ride transaction. It creates no intent, checks no balance, and updates no wallet.
9. **Is the payment operation idempotent?** For intents/refunds/payouts/topups, yes. For ride completion, only via the ride status CAS.
10. **Is final fare server-side?** The **formula** is. The **inputs** are not — the driver's client supplies the distance and duration.
11. **Is driver earning posted exactly once?** Yes — guarded by the `updateStatusIf` CAS in the same transaction.
12. **Is the receipt generated exactly once?** Yes, by the `ride_receipts.ride_id` unique constraint — but it is generated lazily on GET, not at completion.
13. **Are outbox events atomic?** **Yes.** Verified across every service.
14. **Can a customer reconnect to an active ride?** Yes — `GET /rides/active`.
15. **Can a driver reconnect?** Yes — `GET /rides/active` branches on the driver role.
16. **Can the customer see driver location during a ride?** **No** — `authorizedDriverId` refuses them and no socket exists.
17. **Can the driver see ride info only when authorized?** Yes — `assertRideParty`.
18. **Can cancellation race acceptance?** Partly — they touch different rows before the ride exists.
19. **Can cancellation race completion?** No — both take the ride lock with a CAS.
20. **Can payment retry duplicate ledger entries?** No for the audited paths (idempotency + intent status short-circuit + webhook dedup).

---

# 30. Missing Workflow Analysis

- **Driver search / candidate ranking** — absent.
- **Dispatch offer delivery and driver response** — absent (`RideDispatch` is write-nothing; no accept/reject-offer endpoint).
- **Real-time channel** — absent (`socket.plugin.ts` is `export {};`).
- **Document verification** — absent; blocks every driver from going online.
- **Ride charge for non-cash rides** — absent (no intent, no capture).
- **Cancellation fee collection** — recorded, never charged.
- **Settlement scheduling** — job exists, never runs.
- **`DRIVER_ARRIVING`** — a legal state with no endpoint.
- **Surge / promo / discount** — plumbed through the fare model, always 1.0 / 0.

---

# 31. Test Coverage Analysis

Actual results, run 2026-08-15:

```
npx tsc --project tsconfig.json --noEmit     → exit 0, no errors
npm run test:unit                            → tests 640   pass 638   fail 2
npm run test:integration                     → tests 492   suites 129   pass 492   fail 0   (181s)
npx eslint . --ignore-pattern "ride-demo-frontend/**"  → clean
npm run lint (unmodified)                    → 3606 errors, ALL from the untracked
                                               ride-demo-frontend/ directory
```

**The two unit failures:**

- `tests/unit/di-wiring.test.ts` — "resolves every constructor parameter of every asClass-registered service". Reports 31 unresolvable parameters, all on `DriverService`, `PaymentService`, `RideService` and their composite controllers. Those classes **do** declare `.inject()` in their module registrations (`rides/index.ts:66-76`), so this is the test's `.inject()` extractor failing, not a runtime DI break — the 492 integration tests boot the full app and resolve every controller. Still a red test that must be fixed rather than ignored.
- `tests/unit/files/s3-provider.test.ts` — "selects s3 from configuration alone" fails on a missing `STORAGE_QUARANTINE_BUCKET` in the test environment. A test-fixture defect, not a product defect.

**Coverage gaps that matter more than the failures:**

- **No integration test for the ride lifecycle end to end.** `tests/integration/` has no ride-request → dispatch → accept → arrive → start → complete suite.
- **No driver-onboarding integration test** — and the fixtures prove why: `fixtures.ts:31-38` inserts a `VERIFIED` `DriverDocument` **directly into the database** because no API can produce one. The test suite is routing around F-P0-07 rather than catching it.
- No test for the two-drivers-accept race at the HTTP level (the unit test `ride-lifecycle-concurrency.test.ts` covers the service).
- No test for heartbeat-vs-timeout, driver-online-vs-suspension, or customer-double-request.

Well covered: auth (14 integration suites), files (10), users (7), BOLA (1 large), earnings/payout pipeline (1 large), outbox, webhooks.

---

# 32. P0 Findings

### F-P0-01 — Dispatch does not exist

```
Finding:              POST /rides/requests never dispatches. No driver search, no
                      offer, no notification. DispatchService.offerToDriver has zero callers.
Severity:             P0 — Blocker
Module:               Rides
File:                 src/modules/rides/services/request/ride-request.service.ts:35-103
                      src/modules/rides/services/dispatch/dispatch.service.ts:15
Current Behavior:     createRequest() inserts a ride_requests row, emits ride.requested,
                      returns. The request sits in CREATED until RequestExpiryJob marks it
                      EXPIRED. No ride_dispatches row is ever written by any code path.
Why It Is Dangerous:  The core product does not function. A customer books and nothing
                      happens. The only way a ride begins is a driver guessing a requestId.
Expected Behavior:    createRequest → status SEARCHING → query eligible drivers near pickup →
                      filter (online, verified, unsuspended, correct vehicle type, not busy,
                      location fresh, within radius) → rank by distance/ETA → create
                      RideDispatch offers → publish ride.dispatch_offered → on timeout,
                      widen the round or mark NO_DRIVERS_FOUND.
Recommended Fix:      Implement src/modules/geo with a findNearbyDrivers(point, radius,
                      vehicleTypeId, maxAgeSeconds) query over driver_locations joined to
                      drivers + driver_online_status. Add a DispatchOrchestrator in Rides
                      that consumes ride.requested and calls Geo then
                      DispatchService.offerToDriver. Add POST /rides/offers/:id/{accept,reject}.
Transaction Required: Yes — the SEARCHING transition, the offer rows and the outbox event
                      must commit together.
Redis Required:       No for correctness; a per-request dispatch lock helps avoid duplicate
                      rounds when the relay retries.
Database Constraint:  ride_dispatches already has UNIQUE(request_id, driver_id). Add a GIST
                      index on driver_locations.location.
Test Required:        Integration: request → offer created for the nearest eligible driver;
                      stale/offline/busy/wrong-vehicle drivers excluded; no eligible driver →
                      NO_DRIVERS_FOUND.
Production Impact:    Total. No ride can be completed without out-of-band coordination.
```

### F-P0-02 — Geo module is an empty stub; no spatial query or index exists

```
Finding:              src/modules/geo/index.ts is `export {};` (11 bytes). No spatial query
                      exists anywhere in the codebase and no GIST index exists on any driver
                      or ride geography column.
Severity:             P0
Module:               Geo
File:                 src/modules/geo/index.ts
                      prisma/migrations/ — only ix_saved_places_location uses GIST
Current Behavior:     PostGIS geography(Point,4326) columns are populated on ride_requests,
                      rides and driver_locations via ST_SetSRID/ST_MakePoint, and are then
                      never read. The only distance maths in the system is Haversine in
                      src/modules/rides/utils/distance.util.ts, used for fare estimation.
Why It Is Dangerous:  The infrastructure needed for dispatch is absent, and any proximity
                      query written against these tables today would be a sequential scan.
Expected Behavior:    Geo owns spatial search and spatial calculation. Rides asks Geo for
                      candidates; Drivers owns ingestion.
Recommended Fix:      Build Geo on the PostGIS columns that already exist — ST_DWithin over
                      geography with an ORDER BY ST_Distance. Do NOT introduce H3, Geohash
                      or Redis GEO: the existing infrastructure is sufficient and adding a
                      second spatial system would create the duplication this audit warns
                      against.
Transaction Required: No — reads.
Redis Required:       No.
Database Constraint:  CREATE INDEX CONCURRENTLY ix_driver_locations_location ON
                      driver_locations USING GIST (location);  plus the same on
                      ride_requests.pickup_location.
Test Required:        Unit for the radius/ordering maths; integration asserting an index scan
                      (EXPLAIN) rather than a seq scan.
Production Impact:    Blocks F-P0-01. Once dispatch exists, the missing index makes it
                      O(all drivers) per request.
```

### F-P0-03 — Any operable driver can claim any pending ride request

```
Finding:              POST /rides/accept trusts a client-supplied requestId and never checks
                      that an offer was made to the accepting driver.
Severity:             P0 — Security / Business logic
Module:               Rides
File:                 src/modules/rides/services/lifecycle/lifecycle.service.ts:106-160
                      src/modules/rides/controllers/ride-state.controller.ts:26-37
Current Behavior:     acceptRideRequest({requestId, driverId, vehicleId}) locks the request,
                      claims it, and creates the ride. ride_dispatches is never consulted.
                      vehicleId is taken from the body with no check that the vehicle belongs
                      to the driver or matches request.vehicleTypeId.
Why It Is Dangerous:  A verified driver enumerating UUIDv7 request ids — which are time-
                      ordered and therefore guessable within a window — can steal every
                      ride on the platform, anywhere geographically, ahead of the intended
                      driver. They can also attach any vehicle id, including another
                      driver's, corrupting the vehicle-to-ride record.
Expected Behavior:    Accept must resolve a PENDING, unexpired RideDispatch for
                      (requestId, driverId), lock it, and reject if it is missing, expired,
                      or already answered. The vehicle must be verified as belonging to the
                      driver and matching the requested vehicle type.
Recommended Fix:      Inside the existing transaction, before claimForMatch:
                        const offer = await dispatchRepo.lockPendingOffer(requestId, driverId, tx);
                        if (!offer) throw new NoActiveOfferError(requestId);
                        if (offer.expiresAt <= now) throw new OfferExpiredError(offer.id);
                      then mark the winning offer ACCEPTED and sibling offers CANCELLED.
                      Validate the vehicle against driverId and request.vehicleTypeId.
Transaction Required: Yes — same transaction as the request claim.
Redis Required:       No.
Database Constraint:  UNIQUE(request_id, driver_id) already present on ride_dispatches.
Test Required:        Driver with no offer → 403. Driver with an expired offer → 409.
                      Offered driver → 200, sibling offers CANCELLED. Foreign vehicleId → 403.
Production Impact:    Ride theft, driver revenue loss, unassignable liability.
```

### F-P0-04 — A driver can hold unlimited simultaneous rides

```
Finding:              Accept does not check whether the driver already has an active ride,
                      and does not mark the driver busy afterwards.
Severity:             P0
Module:               Rides / Drivers
File:                 src/modules/rides/services/lifecycle/lifecycle.service.ts:106-160
Current Behavior:     No call to rideRepo.findActiveByDriver (the method exists,
                      ride.repository.ts:94, and is never used). drivers.isAvailable and
                      driver_online_status.status are not written on accept or on complete.
Why It Is Dangerous:  One driver can be assigned to five concurrent customers. Every one of
                      them sees an accepted ride with an ETA that cannot be met. Downstream,
                      any dispatch filter built on isAvailable will keep offering rides to a
                      driver who is already on a trip.
Expected Behavior:    Accept: lock the driver row, assert no active ride, set status ON_TRIP
                      and isAvailable=false. Complete/cancel: return to ONLINE / available.
Recommended Fix:      Inside acceptRideRequest's transaction, after the offer check:
                        await driverRepo.lockForUpdate(driverId, tx);
                        if (await rideRepo.findActiveByDriver(driverId, tx)) throw new DriverBusyError();
                        await statusRepo.updateStatus(driverId, 'ON_TRIP', {}, tx);
                        await driverRepo.updateAvailability(driverId, false, tx);
                      Mirror the release in completeRide and cancelRide.
Transaction Required: Yes.
Redis Required:       No.
Database Constraint:  CREATE UNIQUE INDEX ux_rides_active_driver ON rides(driver_id)
                        WHERE status IN ('ACCEPTED','DRIVER_ARRIVING','DRIVER_ARRIVED','IN_PROGRESS');
Test Required:        Two concurrent accepts by one driver on two requests → exactly one 2xx.
                      Driver status is ON_TRIP after accept and ONLINE after complete.
Production Impact:    Undeliverable rides, corrupted supply state, unbounded customer harm.
```

### F-P0-05 — Ride-start OTP attempt counter rolls back; brute force is unbounded

```
Finding:              The failed-attempt increment is written inside the same transaction
                      that the failure aborts, so it never persists.
Severity:             P0 — Security
Module:               Rides
File:                 src/modules/rides/services/otp/ride-otp.service.ts:35-62
                      src/modules/rides/services/lifecycle/lifecycle.service.ts:204-242
Current Behavior:     startRide opens a transaction, calls verifyStartOtp(rideId, otp, tx).
                      claimAttempt() increments ride_otps.attempts through tx. When the hash
                      does not match, OtpVerificationError propagates out of
                      txManager.execute → PostgreSQL rolls the transaction back → the
                      increment is undone. Every attempt starts from attempts = 0. There is
                      also no rate limit on the route (ride.routes.ts:21 has only driverOnly).
Why It Is Dangerous:  A 6-digit start OTP has 10^6 values with a 10-minute TTL. With the
                      counter neutralised and no throttle, an assigned driver can exhaust
                      the space and start a ride without the customer ever being present —
                      defeating the control that proves the right passenger boarded, and
                      enabling fabricated trips billed to a real customer.
Expected Behavior:    Every failed attempt is durably counted; the cap binds; the endpoint
                      is rate limited.
Recommended Fix:      Persist the attempt outside the aborting transaction. Either
                      (a) verify the OTP BEFORE opening the ride transaction, recording
                      attempts in its own committed transaction, or
                      (b) count attempts in Redis via RateLimitStore keyed on the ride id —
                      Redis is not transactional and survives the rollback.
                      Option (a) is preferred: the durable counter is the audit record.
                      Additionally add fastify.rateLimit(rateLimits.rideWrite) to the route.
Transaction Required: Yes — a SEPARATE, committed one for the attempt.
Redis Required:       Optional (option b), plus the route rate limit.
Database Constraint:  None.
Test Required:        Integration: RIDE_OTP_MAX_ATTEMPTS wrong codes in a row, then a
                      correct code → still rejected. Assert ride_otps.attempts persisted
                      after each failure.
Production Impact:    Fabricated ride starts, fraudulent billing, loss of the passenger-
                      presence guarantee.
```

### F-P0-06 — Final fare is computed from client-supplied trip distance

```
Finding:              The driver's application supplies actualDistanceKm and
                      actualDurationMin, and the backend prices the ride from them.
Severity:             P0 — Financial
Module:               Rides
File:                 src/modules/rides/controllers/ride-state.controller.ts:56-68
                      src/modules/rides/services/lifecycle/lifecycle.service.ts:244-264
Current Behavior:     completeRideSchema.parse(req.body) yields the two numbers; they are
                      passed straight into fareService.calculateFinalFare. The only checks
                      are finite and non-negative (fare.service.ts:127-137). The result
                      determines totalFare, driverEarning, platformCommission and the ledger
                      postings.
Why It Is Dangerous:  A modified driver client sends actualDistanceKm: 900 and is paid for a
                      900 km trip. The brief names this exactly: "Never trust
                      clientTotalFare / clientDriverEarning / clientCommission." Passing the
                      raw inputs instead of the total is the same defect one layer down.
Expected Behavior:    The backend derives the travelled distance and duration from data it
                      owns — driver_locations / ride_track_points between startedAt and
                      completedAt, or a server-side route match — and treats any client
                      figure as an unauthenticated hint at most.
Recommended Fix:      Short term, bound the claim against server data: duration from
                      completedAt − startedAt (server clocks), and distance capped at
                      quoted estimatedDistanceKm × a tolerance factor, rejecting or flagging
                      anything beyond it. Long term, accumulate distance server-side from
                      the GPS stream the driver already posts to POST /drivers/location.
Transaction Required: Yes — the derivation belongs inside the completion transaction.
Redis Required:       No.
Database Constraint:  None.
Test Required:        Completing with an absurd distance is rejected or clamped; the stored
                      fare matches the server-derived figure, not the submitted one.
Production Impact:    Direct, unbounded revenue leakage; collusion fraud between a driver
                      and a customer account.
```

### F-P0-07 — No code path can verify a driver document, so no driver can ever go online

```
Finding:              StatusService.setOnline requires a DRIVING_LICENSE document with
                      verificationStatus = 'VERIFIED'. Nothing in the codebase can set that
                      value.
Severity:             P0 — Blocker
Module:               Drivers
File:                 src/modules/drivers/services/status/status.service.ts:46-52
                      src/modules/drivers/services/onboarding/onboarding.service.ts:79-115
Current Behavior:     Documents are created with verificationStatus 'PENDING'
                      (driver-document.repository.ts:36,49). The only caller of
                      docRepo.updateVerificationStatus is DocExpirationJob, which sets
                      EXPIRED. POST /drivers/:id/verify updates the DRIVER row only, never
                      the documents. Therefore hasValidLicense is always false and setOnline
                      always throws DriverNotVerifiedError.
Why It Is Dangerous:  Driver supply is zero in production. The defect is masked in CI
                      because tests/integration/helpers/fixtures.ts:31-38 inserts the
                      VERIFIED document directly with Prisma — the test suite routes around
                      the missing endpoint instead of catching it.
Expected Behavior:    An admin reviews each submitted document and approves or rejects it;
                      driver-level verification is granted only once the required document
                      set is approved.
Recommended Fix:      Add POST /drivers/:driverId/documents/:documentId/review, guarded by
                      authorize({roles:['admin']}), calling
                      docRepo.updateVerificationStatus(documentId, status, reviewerId, tx).
                      In reviewDriverVerification, refuse to set the driver VERIFIED unless
                      every required document type is VERIFIED and unexpired.
Transaction Required: Yes — document status, driver status and the outbox event together.
Redis Required:       No.
Database Constraint:  None.
Test Required:        Integration WITHOUT fixture shortcuts: submit → admin approves the
                      licence → admin verifies the driver → driver goes online. Approving
                      the driver with a PENDING licence must fail.
Production Impact:    Total. Zero drivers can operate.
```

### F-P0-08 — Customer wallet balance and the ledger are independent and diverge

```
Finding:              customer_wallets.balance is not updated by ride completion or by
                      payment-intent success, while the ledger's CUSTOMER_WALLET account is.
Severity:             P0 — Financial integrity
Module:               Payments
File:                 src/modules/payments/services/ledger/ledger.service.ts:62-96
                      src/modules/payments/services/intent/intent.service.ts:169-193
                      src/modules/payments/services/wallet/wallet.service.ts:24-98
Current Behavior:     topup() writes both the balance column and the ledger.
                      recordTripPayment() DEBITs CUSTOMER_WALLET in the ledger only.
                      applyConfirmation() CREDITs CUSTOMER_WALLET in the ledger only.
                      Nothing reconciles the two. GET /payments/wallet/balance reads the
                      column.
Why It Is Dangerous:  From the first wallet-paid ride the two disagree. The column
                      over-states funds (spend never deducted) and under-states credit
                      (gateway payments never added). Every downstream decision that reads
                      the column — the available-balance check in hold(), the customer's
                      displayed balance — is wrong. Customers spend money they do not have
                      and cannot spend money they do.
Expected Behavior:    One truth. Either the ledger is authoritative and the column is a
                      projection updated in the same transaction as every posting, or the
                      column is dropped and balance is derived by summing the ledger.
Recommended Fix:      Make the column a strict projection. Give LedgerService a private
                      applyProjection(items, tx) that, for every CUSTOMER_WALLET leg,
                      locks the wallet row and applies the delta — invoked from
                      postTransactionGroup so no posting can bypass it. Add a reconciliation
                      job asserting SUM(ledger CUSTOMER_WALLET) == balance per user and
                      alerting on drift.
Transaction Required: Yes — projection and posting are one write.
Redis Required:       No.
Database Constraint:  CHECK (balance >= 0), CHECK (locked_balance >= 0),
                      CHECK (locked_balance <= balance).
Test Required:        topup 500 → wallet ride of 200 → balance is 300 AND the ledger sums to
                      300. Reconciliation job reports zero drift after a mixed sequence.
Production Impact:    Customers billed incorrectly; unreconcilable books; a finance-grade
                      incident.
```

### F-P0-09 — A non-cash ride completes with no payment ever attempted

```
Finding:              Ride completion posts a ledger debit against the customer without
                      creating a PaymentIntent, checking funds, or calling any gateway.
Severity:             P0 — Financial
Module:               Rides / Payments
File:                 src/modules/rides/services/lifecycle/lifecycle.service.ts:266-317
                      src/modules/payments/services/ledger/ledger.service.ts:62-96
Current Behavior:     paymentStatus is set to 'PAID' for CASH and 'PENDING' for everything
                      else. recordTripPayment DEBITs CUSTOMER_WALLET for the full fare
                      regardless of the customer's balance. No PaymentIntent row is created;
                      no gateway is contacted; nothing ever moves paymentStatus off PENDING.
                      Any WalletHold taken earlier is neither consumed nor released.
Why It Is Dangerous:  Every card, UPI and wallet ride produces an uncollected receivable
                      that the system believes is booked. The driver is credited
                      DRIVER_PAYABLE and will be paid out at settlement against money the
                      platform never collected. Combined with F-P0-08 the customer's balance
                      is never even reduced.
Expected Behavior:    Completion of a non-cash ride creates a PaymentIntent for the final
                      fare with a deterministic idempotency key derived from the ride id,
                      confirms it (wallet debit or gateway charge), and posts the ledger
                      group only on success — moving paymentStatus to PAID or FAILED.
Recommended Fix:      Add a PaymentService.chargeRide({rideId, userId, amount, method,
                      idempotencyKey: `ride:${rideId}:charge`}, tx) contract and call it
                      from completeRide in place of the bare ledger call. Keep the call
                      in-process — per §43 no HTTP endpoint is warranted. For WALLET,
                      consume the existing hold; for CARD/UPI, create and confirm the
                      intent, leaving the ride COMPLETED with paymentStatus FAILED if the
                      gateway declines, for the dunning path to retry.
Transaction Required: Yes for the ledger and the ride status. The gateway call must sit
                      OUTSIDE the transaction (see F-P0-11).
Redis Required:       No — the idempotency key is derived from the ride id.
Database Constraint:  UNIQUE(ride_id) on payment_intents where the intent is a ride charge.
Test Required:        Wallet ride with sufficient funds → PAID, balance reduced, ledger
                      balanced. Insufficient funds → COMPLETED + paymentStatus FAILED, no
                      driver credit. Retried completion → exactly one intent.
Production Impact:    100% of non-cash revenue uncollected while drivers are paid out.
```

### F-P0-10 — Driver suspension self-deadlocks on the row it already locked

```
Finding:              StatusService.setSuspended opens a transaction, locks the driver row,
                      then calls setOffline, which opens a SECOND transaction and tries to
                      lock the same row.
Severity:             P0 — Availability / Data integrity
Module:               Drivers
File:                 src/modules/drivers/services/status/status.service.ts:134-148
                      src/core/database/TransactionManager.ts:34
Current Behavior:     TransactionManager.execute always calls provider.client.$transaction —
                      it never joins an ambient transaction. The inner setOffline therefore
                      runs on a different connection and issues
                      SELECT id FROM drivers WHERE id = $1 FOR UPDATE against a row the
                      outer transaction still holds. The inner call blocks; the outer call
                      is waiting on it; neither can proceed until Prisma's transaction
                      timeout fires and the whole suspension aborts.
Why It Is Dangerous:  Suspending a driver is the emergency control used when a driver is
                      dangerous or fraudulent. It hangs, times out, and rolls back — leaving
                      the driver active. It also holds a database connection for the full
                      timeout on every attempt, so repeated attempts exhaust the pool.
Expected Behavior:    Suspension and the forced offline transition commit atomically in ONE
                      transaction.
Recommended Fix:      Split the transactional core out of setOffline:
                        private async setOfflineInTx(driverId, reason, tx) { ...existing body,
                          minus txManager.execute and minus the second lockForUpdate... }
                        async setOffline(id, reason) { return this.txManager.execute(tx =>
                          this.setOfflineInTx(id, reason, tx)); }
                      and have setSuspended call setOfflineInTx(driverId, 'ADMIN_SUSPENSION', tx)
                      with its own tx. Separately, note that setSuspended currently emits its
                      SUSPENDED outbox event but performs the offline transition outside its
                      own transaction — the refactor fixes both.
Transaction Required: Yes — one transaction, not two.
Redis Required:       No.
Database Constraint:  None.
Test Required:        Unit: setSuspended(true) completes and the driver is both suspended and
                      OFFLINE with the shift closed. Integration with a real database to
                      prove no lock wait.
Production Impact:    The safety control does not work. Connection-pool exhaustion under
                      repeated use.
```

### F-P0-11 — Payout and refund call the gateway inside the database transaction

```
Finding:              An external HTTP call to the payment gateway is made while a database
                      transaction is open and holding row locks; on failure the record of
                      the attempt is rolled back with it.
Severity:             P0 — Financial
Module:               Payments
File:                 src/modules/payments/services/payout/payout.service.ts:80-145
                      src/modules/payments/services/refund/refund.service.ts:70-81
Current Behavior:     Inside txManager.execute, PayoutService creates the payout row, calls
                      gateway.createPayout(...), and on success writes COMPLETED plus the
                      ledger group. On failure it writes status FAILED and then rethrows —
                      which rolls back the FAILED write along with everything else. The
                      settlement row stays locked for the entire duration of the network
                      call. RefundService has the same shape.
Why It Is Dangerous:  Two ways to lose money. (1) The gateway succeeds but the commit fails
                      (connection drop, transaction timeout, node death): money has left the
                      platform and no record of it exists — the idempotency key that would
                      have prevented a re-send is rolled back too, so the retry pays twice.
                      (2) The gateway times out ambiguously: the FAILED marker vanishes, so
                      there is nothing to reconcile against later. Meanwhile a slow gateway
                      holds the settlement lock and a pooled connection for its full timeout.
Expected Behavior:    Persist the intent to pay and COMMIT. Call the gateway outside any
                      transaction. Record the outcome in a second, short transaction.
Recommended Fix:      Three phases:
                        tx1: create payout PENDING with the idempotency key, commit.
                        (no tx): call the gateway, passing that same idempotency key.
                        tx2: lock the payout, write COMPLETED/FAILED with the gateway
                             reference, post the ledger group, publish the outbox event.
                      An ambiguous gateway result leaves the row PENDING for
                      ReconciliationJob to resolve against the gateway's own record. Apply
                      the identical shape to RefundService.
Transaction Required: Yes — two short ones, never spanning the network call.
Redis Required:       No — the DB unique key on idempotency_key is the guard.
Database Constraint:  UNIQUE(idempotency_key) already present on driver_payouts and refunds.
Test Required:        Gateway throws → the payout row survives as FAILED (not vanished).
                      Gateway succeeds then the commit fails → replaying the same key does
                      not send a second payout. Assert no gateway call occurs while a
                      transaction is open.
Production Impact:    Double payouts, unrecorded outbound money, lock contention on
                      settlements.
```

### F-P0-12 — No idempotency on any ride state-changing endpoint

```
Finding:              No route in src/modules/rides reads the Idempotency-Key header.
Severity:             P0
Module:               Rides
File:                 src/modules/rides/routes/ride.routes.ts (whole file)
                      grep -rn "idempotency-key" src → zero hits under modules/rides
Current Behavior:     POST /rides/requests, /accept, /:id/start, /:id/complete, /:id/cancel
                      accept no key. The state machine's updateStatusIf CAS means a retried
                      transition fails with a 409 rather than double-applying — but
                      /rides/requests has no such guard and inserts a second row, and every
                      retried call returns an error instead of the original result.
Why It Is Dangerous:  Mobile clients retry on timeout. A timed-out ride request that
                      actually succeeded produces a duplicate request the customer cannot
                      see or cancel. A timed-out completion returns 409 to a client that
                      cannot tell "already done" from "rejected", so drivers see failures on
                      rides that were in fact completed and billed.
Expected Behavior:    Same key + same payload → the original response replayed.
                      Same key + different payload → 409.
Recommended Fix:      Reuse the existing, tested IdempotencyRepository.runIdempotent from
                      Payments — it already implements payload hashing and conflict
                      detection. Do NOT build a second mechanism, and do not populate the
                      empty src/middleware/idempotency.ts with a competing one. Require the
                      key on /rides/requests, /accept, /:id/complete and /:id/cancel; leave
                      GETs alone.
Transaction Required: No — it wraps the existing transactions.
Redis Required:       Yes (already provisioned). Back /rides/requests additionally with the
                      partial unique index from F-P1-12 so a Redis flush cannot admit a
                      duplicate.
Database Constraint:  See F-P1-12.
Test Required:        Same key twice → one ride request, identical response body. Same key
                      with a changed pickup → 409.
Production Impact:    Duplicate ride requests; drivers unable to confirm completion.
```

---

# 33. P1 Findings

### F-P1-01 — Driver documents bypass the Files module entirely

```
Finding:              POST /drivers/:driverId/documents accepts an arbitrary fileUrl string.
Severity:             P1
Module:               Drivers / Files
File:                 src/modules/drivers/services/onboarding/onboarding.service.ts:52-77
                      src/modules/drivers/controllers/driver-onboarding.controller.ts:48-60
Current Behavior:     submitDocument({driverId, documentType, fileUrl, ...}) persists the
                      string as-is. No FileReference, no ownership check, no MIME or size
                      validation, no scan, no storage-key validation. The test fixture uses
                      'https://example.invalid/licence.jpg'.
Why It Is Dangerous:  A driver can submit another driver's document URL, an unscanned
                      object, or an attacker-controlled external URL that an admin reviewer
                      then loads — turning the verification console into an SSRF and
                      phishing surface. Every control the Files module implements (§24) is
                      skipped.
Expected Behavior:    The driver uploads through POST /files/ with purpose DRIVER_DOCUMENT,
                      completes the upload, and submits the resulting fileId. Drivers
                      resolves it through the Files service, asserting ownership, purpose
                      and ACTIVE status.
Recommended Fix:      Change the schema from fileUrl to fileId. In submitDocument, resolve
                      via the existing FileReferences service and reject a file that is not
                      owned by the driver's user, not purpose DRIVER_DOCUMENT, or not
                      ACTIVE. Do NOT add storage logic to Drivers.
Transaction Required: Yes — reference binding and the document row together.
Redis Required:       No.
Database Constraint:  FK from driver_documents.file_id to files.id.
Test Required:        Submitting another user's fileId → 403. Submitting a
                      PROFILE_IMAGE-purpose file → 400. Happy path binds the reference.
Production Impact:    Document forgery, cross-driver data exposure, SSRF against reviewers.
```

### F-P1-02 — `setOnline` does not check for a conflicting active trip

```
Finding:              The ONLINE transition validates verification, suspension and licence
                      but not whether the driver is mid-ride.
Severity:             P1
Module:               Drivers
File:                 src/modules/drivers/services/status/status.service.ts:28-82
Current Behavior:     A driver whose status is ON_TRIP can call /drivers/status/online and be
                      reset to ONLINE with a fresh shift, while their ride is still active.
Why It Is Dangerous:  Corrupts supply state and shift accounting; once dispatch exists, the
                      driver becomes a dispatch candidate mid-trip.
Expected Behavior:    Refuse ONLINE while an active ride exists, per §9 of the brief.
Recommended Fix:      Inside the existing transaction, after the suspension check:
                        if (await rideRepo.findActiveByDriver(driverId, tx)) throw new DriverOnTripError();
Transaction Required: Yes — the existing one.
Redis Required:       No.
Database Constraint:  Covered by the partial unique index in F-P0-04.
Test Required:        Driver with an IN_PROGRESS ride calling online → 409.
Production Impact:    Incorrect availability, double-booking once dispatch lands.
```

### F-P1-03 — Heartbeat-timeout worker can take a live driver offline

```
Finding:              The worker selects stale drivers, then takes them offline without
                      re-reading heartbeatAt under the lock.
Severity:             P1
Module:               Drivers
File:                 src/modules/drivers/jobs/heartbeat-timeout.job.ts:26-38
                      src/modules/drivers/services/status/status.service.ts:84-121
Current Behavior:     findStaleDrivers(threshold) returns a list; the loop then calls
                      setOffline per driver. setOffline locks the driver row but validates
                      only "not ON_TRIP" — it never re-checks the heartbeat. A heartbeat
                      arriving between the scan and the update is ignored.
Why It Is Dangerous:  With a one-minute cron and a batch of stale rows, an actively
                      heartbeating driver can be forced offline on stale data — exactly the
                      race §11 of the brief calls out. Their shift is closed and they stop
                      receiving work.
Expected Behavior:    Re-read the heartbeat inside the lock and skip if it is now fresh.
Recommended Fix:      Add setOfflineIfStale(driverId, threshold) that, after
                      lockForUpdate, reloads driver_online_status and returns without
                      changes when heartbeatAt > threshold. Have the job call that. Pairs
                      naturally with the setOfflineInTx refactor from F-P0-10.
Transaction Required: Yes — the existing one; the re-check must be inside the lock.
Redis Required:       No (the job lock already exists).
Database Constraint:  None.
Test Required:        Heartbeat lands between the scan and the update → the driver stays
                      ONLINE.
Production Impact:    Active drivers randomly dropped from supply; lost earnings.
```

### F-P1-04 — Cancellation fees are recorded but never charged

```
Finding:              processCancellation writes a ₹50 fee with feeCharged = true and posts
                      nothing to the ledger.
Severity:             P1 — Financial
Module:               Rides
File:                 src/modules/rides/services/cancellation/cancellation.service.ts:19-45
Current Behavior:     The amount is hardcoded (`new Decimal(50)`), the flag claims it was
                      charged, and no ledger entry, wallet debit or intent is created. The
                      driver is not compensated for the trip to the pickup.
Why It Is Dangerous:  The database asserts a charge that never happened. Reconciliation
                      against the ledger will not balance, and support will refund fees that
                      were never taken.
Expected Behavior:    Either post the fee through Payments in the cancellation transaction,
                      or record it with feeCharged = false until collected.
Recommended Fix:      Move the amount into rideConfig (a hardcoded ₹50 also cannot vary by
                      city or vehicle type), and call the same PaymentService.chargeRide
                      contract introduced in F-P0-09. Set feeCharged from the actual
                      outcome. Rides must not write ledger rows directly.
Transaction Required: Yes — the existing cancellation transaction.
Redis Required:       No.
Database Constraint:  None.
Test Required:        Post-arrival customer cancellation → the ledger balances and the
                      driver is credited. Pre-arrival → no fee, feeCharged false.
Production Impact:    Uncollected fees, uncompensated drivers, books that do not reconcile.
```

### F-P1-05 — Receipts are generated lazily on GET, not at completion

```
Finding:              generateReceipt runs on the read path and is not restricted to
                      completed rides.
Severity:             P1
Module:               Rides
File:                 src/modules/rides/services/receipt/receipt.service.ts:13-32
                      src/modules/rides/controllers/ride-query.controller.ts:38-50
Current Behavior:     GET /rides/:id/receipt creates the ride_receipts row if absent, with
                      no transaction and no status check. A receipt can be minted for an
                      IN_PROGRESS or CANCELLED ride. Two simultaneous GETs race on
                      find-then-create; the unique index on ride_id turns the loser into a
                      500 rather than a replay.
Why It Is Dangerous:  A receipt is a financial document. Generating it from a read, at
                      arbitrary times, from whatever the ride looks like at that moment,
                      means the snapshot is not a snapshot of anything meaningful.
Expected Behavior:    The receipt is created once, inside the completion transaction, from
                      the finalised fare. The GET only reads.
Recommended Fix:      Call receiptService.generateReceipt(rideId, tx) inside completeRide
                      after the fare is written. Make the query controller read-only and
                      return 404 when no receipt exists.
Transaction Required: Yes — the completion transaction.
Redis Required:       No.
Database Constraint:  UNIQUE(ride_id) already present.
Test Required:        Receipt exists immediately after completion. GET on an IN_PROGRESS
                      ride → 404, and no row is created. Concurrent GETs → no 500.
Production Impact:    Meaningless or missing receipts; 500s under concurrent reads.
```

### F-P1-06 — `driver_wallets` is a dead duplicate of driver earnings

```
Finding:              GET /drivers/:driverId/wallet reads a table that no code writes.
Severity:             P1
Module:               Drivers / Payments
File:                 src/modules/drivers/repositories/driver-wallet.repository.ts:16-32
                      src/modules/drivers/services/wallet/wallet.service.ts
Current Behavior:     getOrCreateWallet creates a row with balance 0 and returns it. Nothing
                      credits it — earnings live in the ledger's DRIVER_PAYABLE account.
                      driver_wallet_transactions is likewise never written.
Why It Is Dangerous:  Every driver sees zero earnings, permanently. It is also a standing
                      invitation for a future change to start writing this column and create
                      a genuine second source of truth for money.
Expected Behavior:    One representation. Earnings are the ledger; anything else is a
                      projection maintained in the same transaction as the posting.
Recommended Fix:      Preferred: delete driver_wallets/driver_wallet_transactions and have
                      the endpoint serve a ledger-derived balance (SUM of DRIVER_PAYABLE for
                      the driver) plus paged ledger entries. If a materialised column is
                      wanted for read performance, maintain it inside
                      LedgerService.postTransactionGroup exactly as F-P0-08 prescribes for
                      the customer wallet — never from Drivers.
Transaction Required: Only if a projection is kept.
Redis Required:       No.
Database Constraint:  None.
Test Required:        After a completed non-cash ride, the driver's wallet endpoint reports
                      the driver_earning from that ride.
Production Impact:    Drivers cannot see earnings; support load; latent double-truth.
```

### F-P1-07 — Settlement is derived from `ride_fares`, never reconciled with the ledger

```
Finding:              aggregateEarnings sums ride_fares; payout debits DRIVER_PAYABLE. The
                      two are never compared.
Severity:             P1
Module:               Payments
File:                 src/modules/payments/repositories/settlement.repository.ts:54-96
                      src/modules/payments/services/payout/payout.service.ts:101-122
Current Behavior:     netPayable comes from a SQL aggregate over rides joined to ride_fares.
                      The payout then posts a DEBIT to DRIVER_PAYABLE for that amount. If a
                      ledger posting ever failed, was reversed, or was adjusted, the payout
                      would still be authorised from the fare table.
Why It Is Dangerous:  Money leaves on the authority of a table that is not the ledger. The
                      ledger — the actual double-entry record — can go negative without
                      anything noticing.
Expected Behavior:    Settlement is computed from, or at minimum reconciled against, the
                      DRIVER_PAYABLE balance.
Recommended Fix:      Keep the fare aggregate as the human-readable statement, and add an
                      assertion in calculateSettlement that netPayable equals the ledger's
                      DRIVER_PAYABLE balance for the period, refusing the settlement on
                      drift. Extend ReconciliationJob to alert on it.
Transaction Required: Yes — the existing settlement transaction.
Redis Required:       No.
Database Constraint:  None.
Test Required:        A ledger adjustment not reflected in ride_fares blocks the settlement.
Production Impact:    Overpayment; an unauditable driver ledger.
```

### F-P1-08 — `SettlementJob` is never scheduled

```
Finding:              SettlementJob exists but appears in neither JOB_NAMES nor
                      MAINTENANCE_HANDLERS nor JOB_SCHEDULES.
Severity:             P1
Module:               Payments
File:                 src/modules/payments/jobs/settlement.job.ts
                      src/jobs/queues/index.ts:19-30, src/jobs/workers/index.ts:33-42
Current Behavior:     No settlement is ever created. Since POST /payments/payouts requires a
                      settlementId and throws PayoutUnbackedError without one, no driver can
                      be paid.
Why It Is Dangerous:  Drivers earn and are never paid.
Expected Behavior:    A scheduled job settles each active driver per period.
Recommended Fix:      Add DRIVER_SETTLEMENT to JOB_NAMES, map it to 'settlementJob' in
                      MAINTENANCE_HANDLERS, and add a schedule on PAYMENTS_MAINTENANCE. Give
                      SettlementJob a run(now: Date) signature matching MaintenanceRunner
                      (it currently takes driverIds/periodStart/periodEnd) and have it select
                      the drivers with completed rides in the period itself.
Transaction Required: Per driver — already correct.
Redis Required:       Job lock already implemented.
Database Constraint:  UNIQUE(driver_id, period_start, period_end) already present.
Test Required:        Job run creates one settlement per driver with rides; a second run
                      creates none.
Production Impact:    No driver is ever paid.
```

### F-P1-09 — Payment intent and topup idempotency live only in Redis

```
Finding:              POST /payments/intents and /wallet/topup rely on a Redis record with no
                      database backstop.
Severity:             P1
Module:               Payments
File:                 src/modules/payments/repositories/idempotency.repository.ts:27,50-70
                      src/modules/payments/services/intent/intent.service.ts:51-52
Current Behavior:     Refunds and payouts have BOTH a Redis record and a database UNIQUE on
                      idempotency_key. Intent creation checks intentRepo.findByIdempotencyKey
                      first, which helps — but topup has no equivalent, and neither is
                      protected if Redis is flushed mid-retry.
Why It Is Dangerous:  A Redis eviction or restart inside a client's retry window permits a
                      duplicate charge or a duplicate wallet credit. §29 of the brief:
                      permanent business truth must not depend on Redis alone.
Expected Behavior:    Redis is the fast path; a database unique constraint is the guarantee.
Recommended Fix:      Add UNIQUE(idempotency_key) to payment_intents (verify it exists) and
                      introduce a wallet_topups table keyed by idempotency_key, catching
                      P2002 and returning the winner exactly as PayoutService already does
                      (payout.service.ts:147-153).
Transaction Required: Yes.
Redis Required:       Keeps working as the fast path.
Database Constraint:  UNIQUE(idempotency_key) on payment_intents and on the topup record.
Test Required:        Flush Redis between two identical requests → still exactly one charge.
Production Impact:    Duplicate customer charges during a Redis incident.
```

### F-P1-10 — Wallet holds are never consumed or released

```
Finding:              POST /payments/wallet/hold locks funds; no code path ever settles or
                      releases the hold as part of a ride.
Severity:             P1
Module:               Payments / Rides
File:                 src/modules/payments/services/wallet/wallet.service.ts:100-153
Current Behavior:     hold() increments locked_balance and creates an ACTIVE WalletHold.
                      releaseHold() exists but has no caller outside tests. Ride completion
                      and cancellation ignore holds entirely.
Why It Is Dangerous:  Every hold permanently reduces the customer's available balance. A few
                      abandoned bookings and the customer cannot pay for anything.
Expected Behavior:    A hold is consumed at completion or released at cancellation, and any
                      stale hold expires on a timer.
Recommended Fix:      Consume the hold inside the chargeRide contract from F-P0-09; release
                      it in cancelRide. Add an expiry sweeper for holds older than the
                      request TTL.
Transaction Required: Yes.
Redis Required:       No.
Database Constraint:  None.
Test Required:        Hold → complete → locked_balance returns to zero and the fare is taken.
                      Hold → cancel → locked_balance returns to zero and nothing is taken.
Production Impact:    Customer funds progressively frozen.
```

### F-P1-11 — No realtime layer; the customer cannot track their driver

```
Finding:              src/plugins/socket/socket.plugin.ts is `export {};`, and
                      GET /drivers/:id/location refuses anyone but that driver or staff.
Severity:             P1
Module:               Drivers / platform
File:                 src/plugins/socket/socket.plugin.ts
                      src/modules/drivers/controllers/driver-identity.ts:16-28
Current Behavior:     Driver GPS is stored and readable only by the driver themselves or an
                      admin. There is no push channel, so ride offers, status changes and
                      location updates cannot reach either app.
Why It Is Dangerous:  Live tracking is a safety feature, not a convenience. It also means
                      even a correct dispatch implementation could not deliver an offer.
Expected Behavior:    A customer on an active ride can see their assigned driver's position;
                      both apps receive lifecycle events.
Recommended Fix:      Extend authorizedDriverId (or add an assertRideCounterparty helper next
                      to assertRideParty in @core/auth) to permit a customer with an active
                      ride assigned to that driver, exposing position only — not the full
                      telemetry row. Then implement the socket plugin and drive it from the
                      existing outbox events; do not create a parallel event system.
Transaction Required: No.
Redis Required:       Yes for pub/sub fan-out across API instances.
Database Constraint:  None.
Test Required:        Customer on an active ride reads their driver's location; the same
                      customer after completion → 403; an unrelated customer → 403.
Production Impact:    No live tracking; no offer delivery; degraded safety.
```

### F-P1-12 — One-active-ride-per-customer is checked outside the transaction

```
Finding:              The duplicate-ride guard is a non-locking read before the transaction
                      opens, with no database constraint behind it.
Severity:             P1
Module:               Rides
File:                 src/modules/rides/services/request/ride-request.service.ts:47-55
Current Behavior:     findActiveByCustomer and findActiveByCustomer(request) run on
                      this.db.client BEFORE txManager.execute. Two simultaneous requests both
                      read "no active ride" and both insert.
Why It Is Dangerous:  Precisely the §14 anti-pattern: SELECT then INSERT with no lock and no
                      constraint. One customer ends up with two active requests, and with
                      dispatch in place, two drivers.
Expected Behavior:    The invariant is enforced by the database, not only by application
                      logic.
Recommended Fix:      Move both checks inside the transaction and lock the customer's
                      existing rows (SELECT ... FOR UPDATE), and add the partial unique index
                      below as the real guarantee. Combine with the idempotency key from
                      F-P0-12.
Transaction Required: Yes.
Redis Required:       No.
Database Constraint:  CREATE UNIQUE INDEX ux_ride_requests_active_customer ON
                        ride_requests(customer_id) WHERE status IN ('CREATED','SEARCHING');
                      CREATE UNIQUE INDEX ux_rides_active_customer ON rides(customer_id)
                        WHERE status IN ('ACCEPTED','DRIVER_ARRIVING','DRIVER_ARRIVED','IN_PROGRESS');
Test Required:        Two concurrent POST /rides/requests for one customer → exactly one 2xx.
Production Impact:    Duplicate bookings, duplicate driver dispatch, duplicate charges.
```

### F-P1-13 — Request-expiry job can overwrite a matched request

```
Finding:              The job updates by id with no status predicate.
Severity:             P1
Module:               Rides
File:                 src/modules/rides/jobs/request-expiry.job.ts:19-35
Current Behavior:     It selects requests in CREATED/SEARCHING past expiresAt, then loops
                      calling update({where:{id}, data:{status:'EXPIRED'}}). An accept that
                      commits between the scan and the update is silently overwritten:
                      status becomes EXPIRED while a Ride row exists against it.
Why It Is Dangerous:  A live, accepted ride whose parent request reads EXPIRED. Reporting,
                      support tooling and any future dispatch logic will disagree with
                      reality.
Expected Behavior:    Expiry only applies if the request is still unmatched at write time.
Recommended Fix:      Replace the loop with a single conditional statement:
                        UPDATE ride_requests SET status = 'EXPIRED'
                        WHERE status IN ('CREATED','SEARCHING') AND expires_at <= now();
                      One statement, atomic, no read-modify-write, and faster.
Transaction Required: No — a single statement is atomic.
Redis Required:       Job lock already present.
Database Constraint:  None.
Test Required:        Accept committing between scan and update → the request stays MATCHED.
Production Impact:    Corrupted request state on accepted rides.
```

---

# 34. P2 Findings

- **F-P2-01 — Floating-point money arithmetic.** `FareService` computes every component as a JS `number` with `money(v) = Math.round(v*100)/100` (`fare.service.ts:42`). Because each step is rounded the ledger still balances (`driverEarning + platformCommission == totalFare` exactly), so this is not a P0 — but `Math.round` on a binary float mis-rounds exact halves (`money(1.005) → 1.00`), making the result non-deterministic at the paise across inputs. §39 asks for integer minor units. Fix: compute in paise as integers, or use `Decimal` throughout as the repositories already do at rest.
- **F-P2-02 — Non-constant-time OTP hash comparison.** `ride-otp.service.ts:53` uses `!==`. Low practical risk (comparing digests, not secrets), but `crypto.timingSafeEqual` is a one-line change and matches what the auth OTP path deserves too.
- **F-P2-03 — Single webhook secret for all gateways.** `WebhookService` verifies against `paymentConfig.webhookSecret` regardless of the `:gateway` path parameter. Adding a second gateway means either sharing a secret across providers or silent verification failure. Key the secret by gateway.
- **F-P2-04 — Quotes are straight-line × 1.3.** `calculateFareQuote` (`fare.service.ts:120`) estimates road distance as Haversine × 1.3 and duration as distance × 3. Reasonable as a placeholder; it will misprice badly across rivers, one-ways and traffic. Belongs behind the Geo module once it exists.
- **F-P2-05 — Quotes are not persisted or bound to the request.** A quote is recomputed at request time (`ride-request.service.ts:65`), so the customer can be shown one price and charged from another calculation. Persist the quote with an expiry and reference it from the request.
- **F-P2-06 — Two failing unit tests.** `di-wiring.test.ts` (`.inject()` extractor no longer recognises the composite registrations) and `files/s3-provider.test.ts` (missing `STORAGE_QUARANTINE_BUCKET` in the test env). Neither is a product defect; both are red and should not be.
- **F-P2-07 — `OutboxRelay` runs in every API instance.** Correct under concurrency thanks to claim tokens, but it means N processes polling every second. Run it only in the worker.
- **F-P2-08 — Dual driver-availability representation.** `drivers.isAvailable` and `driver_online_status.status` are written together in one transaction so they cannot currently drift, but they encode overlapping facts. Worth collapsing to one.

---

# 35. Recommended Fixes

**Gate 1 — unblock the product (nothing works without these)**

1. F-P0-07 document verification endpoint — without it, zero drivers.
2. F-P0-02 Geo module + GIST indexes.
3. F-P0-01 dispatch orchestration on top of Geo.
4. F-P1-11 realtime channel for offer delivery.

**Gate 2 — security and money (must not ship without these)** 5. F-P0-05 durable OTP attempts + rate limit on `/rides/:id/start`. 6. F-P0-03 offer-backed accept + vehicle ownership check. 7. F-P0-04 driver busy check and availability writes. 8. F-P0-06 server-derived trip distance. 9. F-P0-08 wallet balance as a ledger projection. 10. F-P0-09 real ride charge via a `PaymentService.chargeRide` contract. 11. F-P0-11 gateway calls outside transactions (payout and refund). 12. F-P0-10 `setSuspended` nested-transaction fix.

**Gate 3 — correctness and integrity** 13. F-P0-12 + F-P1-12 ride idempotency and the active-ride partial unique indexes. 14. F-P1-01 driver documents through the Files module. 15. F-P1-03 heartbeat re-check under the lock. 16. F-P1-13 single conditional statement for request expiry. 17. F-P1-08 schedule the settlement job; F-P1-07 reconcile against the ledger. 18. F-P1-04 charge cancellation fees; F-P1-10 consume wallet holds; F-P1-05 receipts at completion. 19. F-P1-06 collapse `driver_wallets`; F-P1-09 database-backed idempotency.

**Gate 4 — can wait** 20. All P2 findings.

**Preserve as-is.** Do not refactor: the auth stack, `OutboxRelay`/`EventPublisher`, `WebhookService`, the Files module, `LedgerRepository.postGroup`, the `@core/auth` authorization helpers, or the `TransactionManager`/repository `tx?:` convention. These are correct and well tested; changing them adds risk with no return.

**Tests to add before calling any of this done:** the full end-to-end ride integration test (§44 of the brief) and the concurrency matrix (§45) — specifically two-drivers-accept over HTTP, customer double-request, heartbeat-vs-timeout, driver-online-vs-suspension, cancel-vs-accept, and complete-vs-cancel. These matter more than raising unit-test count.

---

# 36. Final Production Readiness Score

| Area                              | Score    | Basis                                                     |
| --------------------------------- | -------- | --------------------------------------------------------- |
| Authentication & session security | 9/10     | Rotation, reuse detection, epochs, fail-closed            |
| Authorization / BOLA              | 9/10     | Consistent, JWT-derived, integration-tested               |
| Files & storage security          | 9/10     | Quarantine, inspection, scoped policy                     |
| Outbox & events                   | 9/10     | Atomic, claim-token relay, multi-instance safe            |
| Webhooks                          | 9/10     | Signature, replay window, dedup, one transaction          |
| Transaction discipline            | 8/10     | Consistent `tx?:` plumbing; three real violations         |
| Database schema                   | 7/10     | Sound model; missing spatial and partial indexes          |
| Worker safety                     | 7/10     | Locked and idempotent; two re-check gaps, one unscheduled |
| Payment integrity                 | 4/10     | Ledger correct; wallet projection and ride charge broken  |
| Ride lifecycle                    | 4/10     | State machine solid; guards and inputs unsafe             |
| Idempotency                       | 5/10     | Excellent in Payments, absent in Rides                    |
| Observability                     | 7/10     | Metrics and structured logs throughout; no tracing        |
| **Dispatch & Geo**                | **0/10** | **Does not exist**                                        |
| Realtime                          | 0/10     | Stub                                                      |
| Test coverage                     | 6/10     | 1130 tests, 2 red; no ride E2E; fixtures mask F-P0-07     |

**Overall: 5.4 / 10**

---

## FINAL VERDICT

# NOT PRODUCTION READY

**What already works.** Authentication end to end — OTP with secure generation, hashing, expiry, attempt limits, lockout, enumeration resistance and challenge binding; JWTs with full claim verification and epoch invalidation; single-use rotating refresh tokens with reuse detection that revokes the family and bumps the epoch; deny-by-default routing. The transactional outbox and its relay. The Files module. The payment webhook path. The double-entry ledger's balance invariant, settlement derivation and payout bounding. BOLA/IDOR protection across every audited route. Transaction discipline: every repository takes `tx?: TransactionClient`, and I found no case of the root Prisma client leaking into a transaction. Redis fails closed everywhere security depends on it. 492 integration tests pass against a real database.

**What is missing.** Dispatch, in its entirety — no geo search, no candidate filtering, no offer, no delivery. The Geo module is an empty file. The realtime layer is an empty file. Document verification has no endpoint, which alone means no driver can go online. Non-cash rides are never actually charged. Settlement never runs. There is no end-to-end ride test, and the fixtures paper over the document-verification blocker by writing to the database directly.

**What is duplicated.** The customer balance exists as both a column and a ledger account, and they diverge. Driver earnings exist in three places — `ride_fares`, the `DRIVER_PAYABLE` ledger account, and a `driver_wallets` table nothing writes. None of these is reconciled against another.

**What is unsafe.** Any operable driver can claim any pending ride. A driver can hold unlimited concurrent rides. The ride-start OTP can be brute-forced without limit because its attempt counter rolls back with the failing transaction. The final fare is computed from a number the driver's phone supplies. Suspension deadlocks against itself. Payout and refund call the gateway with a transaction open and lose the record of the attempt when it fails.

**What must be fixed** — every P0 in §32, and F-P1-01, F-P1-03, F-P1-08, F-P1-12, F-P1-13 in §33.

**What can wait** — every P2 in §34, plus F-P1-05, F-P1-06 and F-P2-04/05 once the money paths are correct.

A passing test suite is not evidence of readiness here: the suite is green precisely because it does not test the workflow this audit was asked to prove. Twelve unresolved P0 issues span security, financial integrity and concurrency, and any single one of them is disqualifying on its own.
