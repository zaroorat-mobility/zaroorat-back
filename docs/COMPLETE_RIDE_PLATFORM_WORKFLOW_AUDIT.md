# Zaroorat Mobility

# Complete Ride Platform Workflow Audit

**Date:** 2026-08-15 · **Branch:** `feature/auth` · **Committed base:** `290b3c6` · **Working tree:** dirty (see §1.1)

**Method.** The codebase is the sole source of truth for every claim about Zaroorat. Nothing was carried over from the earlier `PRODUCTION_RIDE_WORKFLOW_AUDIT.md` without re-verifying it against current code — and re-verification mattered, because the tree has moved since that audit was written. Industry claims are separated into **[INDUSTRY]** (publicly documented, cited), **[INFERENCE]** (my reasoning), and **[ZAROORAT]** (proven from this repository). No private implementation detail of any competitor is asserted.

**Nothing was modified.** No code, migrations, schema, APIs, or tests were changed while producing this report.

---

## 1. Executive Summary

The platform has **six modules with real depth** — Auth, Users, Files, Drivers, Rides, Payments — plus a Geo module built in a prior phase. Roughly 16,000 lines of module code, 683 unit tests, a real double-entry ledger, an exemplary webhook path, and consistent BOLA protection.

It cannot complete a single ride end to end.

Three load-bearing pieces of the customer journey do not exist in any form:

1. **Dispatch.** `DispatchService.offerToDriver` has zero callers. `POST /rides/requests` writes a row and returns. No driver search, no offer, no `RideDispatch` row is ever created by any code path.
2. **Realtime.** `src/plugins/socket/socket.plugin.ts` is `export {};` and `socket.io` is not a dependency. There is no channel to deliver an offer, a driver position, or a status change on.
3. **Push notifications.** No FCM, no APNs, no push SDK in `package.json`. The notifications module is 239 lines of **SMS only**, used exclusively for auth OTP.

The consequence is structural, not incremental: a customer can request a ride, and no driver can ever learn about it. There is no code path from a ride request to a driver's phone.

Two further blockers sit underneath:

4. **No driver can go online.** `StatusService.setOnline` requires a `DRIVING_LICENSE` document with `verificationStatus = 'VERIFIED'`. The only writer of that field is the expiry job, which sets `EXPIRED`. No endpoint approves a document. Driver supply is structurally zero.
5. **Non-cash rides are never charged.** Ride completion posts a ledger entry and sets `paymentStatus = 'PENDING'` forever. No `PaymentIntent`, no balance check, no gateway call.

**On the specific Part 12 requirement** — a permanent 4-digit customer PIN — nothing exists. Not the column, not the service, not the endpoint. The current mechanism is a per-ride `RideOtp`, hashed and single-use, whose brute-force counter is defeated by a transaction rollback (§12, §19).

**Verdict:** Auth is production-grade. Users and Files are close. Drivers, Rides and Payments are _partially_ built — each has a solid core and a missing edge. Dispatch, Realtime, Push, Rating, Vehicle and Safety do not exist as functionality.

### 1.1 The working tree does not currently build

This must be stated before any other finding, because it changes what "current state" means:

```
npm run typecheck        FAILS  (5 errors, tests/unit/files/s3-provider.test.ts)
npm run test:unit        683 tests, 683 pass, 0 fail
npm run test:integration 525 tests, 395 pass, 130 FAIL
```

The 130 integration failures are **not** distributed defects. They share one cause: `loginAs()` in the test harness fails with `OTP_INVALID`, so every integration test that authenticates dies at setup. That traces to an in-flight refactor moving OTP SMS delivery onto a BullMQ worker (`otp.service.ts:128` now calls `otpProducer.enqueue(...)`, outcome `'queued'`), which the harness has not been adapted to.

A second in-flight refactor sits alongside it: `prisma/schema/modules/file/file.prisma` adds six columns (`storage_bucket`, `storage_version_id`, `detected_content_type`, `uploaded_at`, `verified_at`) with **no corresponding migration**, and `SignUploadInput` dropped `maxBytes` without updating its test.

Both are uncommitted work-in-progress by another hand. Isolated suites still pass — `geo-nearby.test.ts` runs 33/33 standalone. **This audit reports the design as written, and flags that the tree is mid-refactor and red.** Any implementation phase must start by landing or reverting that work.

---

## 2. Current Modules Verified

Verified by reading routes → controllers → services → repositories → schema, not by folder presence.

| Module          | Files | Lines | Real?       | Assessment                       |
| --------------- | ----- | ----- | ----------- | -------------------------------- |
| `auth`          | 53    | 3,684 | **Yes**     | Production-grade                 |
| `payments`      | 65    | 3,297 | **Yes**     | Strong core, unwired to rides    |
| `users`         | 52    | 2,988 | **Yes**     | Complete for its scope           |
| `rides`         | 55    | 2,342 | **Partial** | Lifecycle real, dispatch absent  |
| `drivers`       | 52    | 1,875 | **Partial** | Blocked by document verification |
| `files`         | 46    | 4,005 | **Yes**     | Mid-refactor (§1.1)              |
| `geo`           | 22    | 806   | **Yes**     | Built, correct, **no caller**    |
| `notifications` | 6     | 239   | **Partial** | SMS only, OTP only               |

**Stubs containing exactly `export {};`** — folder exists, functionality does not:

`dispatch`, `matching`, `pricing`, `vehicles`, `documents`, `onboarding`, `promotions`, `reviews`, `riders`, `settings`, `sos`, `support`, `chat`, `admin`, `analytics`; plus `src/plugins/socket/socket.plugin.ts`, `src/middleware/{auth,idempotency,role}.ts`, all seven `src/infrastructure/*`, all eight `src/common/*`, and `src/jobs/{producers,consumers}` (the latter two were stubs at the committed base; `producers` now carries the OTP producer in the working tree).

### Complete mounted route inventory

31 routes. This is everything the API exposes.

```
Auth      POST /auth/otp/send · /otp/verify · /token/refresh · /logout
          GET/DELETE /auth/me/sessions · DELETE /auth/me/sessions/:id
          GET /auth/me/devices · DELETE /auth/me/devices/:id
Users     GET /users/me · PATCH /users/me/profile
          POST /users/me/phone/change · /phone/verify
          GET/POST /users/me/emergency-contacts · PATCH/DELETE /:id
          GET/POST /users/me/saved-places · PATCH/DELETE /:id
          POST /users/me/deactivate · /me/delete-request
Files     POST /files/ · /files/:id/complete · GET /files/:id · /files/:id/url · DELETE /files/:id
Rides     POST /rides/quote · /requests · /accept · /:id/arrive · /:id/start · /:id/complete · /:id/cancel
          GET /rides/active · /history · /:id · /:id/receipt
Drivers   GET /drivers/me · PATCH /drivers/:driverId/profile · POST /drivers/:driverId/documents
          POST /drivers/:id/verify · /status/online · /status/offline · /heartbeat · /:id/suspend
          POST /drivers/location · GET /drivers/:id/location
          GET /drivers/:driverId/wallet · /wallet/transactions
Payments  GET /payments/methods · /wallet/balance · POST /wallet/topup · /wallet/hold
          POST /payments/intents · /intents/:intentId/confirm · /refunds · /payouts
          POST /payments/webhooks/:gateway
System    GET /health · /ready · /metrics
```

**No route exists for:** driver offers, rating, vehicles, document approval, SOS, support, trip sharing, promotions, referrals, admin.

---

## 3. Customer Workflow

Traced against actual code. **Status** is what the code proves, not what the folder names suggest.

| #   | Step                                 | API                            | Module   | DB                                                         | Event                        | Socket | Status                                                                                                 |
| --- | ------------------------------------ | ------------------------------ | -------- | ---------------------------------------------------------- | ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| 1   | Login                                | `POST /auth/otp/{send,verify}` | Auth     | `users`, `user_sessions`, `refresh_tokens`, `user_devices` | `auth.otp.*`, `auth.login.*` | —      | **VERIFIED**                                                                                           |
| 2   | Profile                              | `GET /users/me`                | Users    | `user_profiles`                                            | —                            | —      | **VERIFIED**                                                                                           |
| 3   | Location permission / submission     | —                              | —        | —                                                          | —                            | —      | **ABSENT** — no customer location intake exists                                                        |
| 4   | Pickup                               | body of quote/request          | Rides    | `ride_requests.pickup_location`                            | —                            | —      | **VERIFIED** (as request data)                                                                         |
| 5   | Drop                                 | same                           | Rides    | `drop_location`                                            | —                            | —      | **VERIFIED**                                                                                           |
| 6   | Service type (Cab/Auto/Bike/Carpool) | `vehicleTypeId` UUID in body   | —        | `vehicle_types`                                            | —                            | —      | **NOT VERIFIED** — model exists, unseeded, no listing API, no validation that the id is real or active |
| 7   | Fare estimate                        | `POST /rides/quote`            | Rides    | none (not persisted)                                       | —                            | —      | **PARTIAL** — straight-line × 1.3, no routing, quote not bound to the request                          |
| 8   | Ride request                         | `POST /rides/requests`         | Rides    | `ride_requests`                                            | `ride.requested`             | —      | **PARTIAL** — row created, nothing follows                                                             |
| 9   | Idempotency                          | —                              | —        | —                                                          | —                            | —      | **ABSENT** — no ride route reads `Idempotency-Key`                                                     |
| 10  | Ride creation                        | —                              | Rides    | `rides`                                                    | —                            | —      | Created at **accept**, not at request                                                                  |
| 11  | Driver matching                      | —                              | —        | —                                                          | —                            | —      | **ABSENT**                                                                                             |
| 12  | Driver acceptance                    | `POST /rides/accept`           | Rides    | `rides`, `ride_otps`                                       | `ride.accepted`              | —      | **PARTIAL** — atomic, but unguarded (§5)                                                               |
| 13  | Driver ETA                           | —                              | —        | —                                                          | —                            | —      | **ABSENT** — `RideDispatch.driverEtaSeconds` column, never written                                     |
| 14  | Driver live location                 | `GET /drivers/:id/location`    | Drivers  | `driver_locations`                                         | —                            | —      | **NOT VERIFIED** — customer is refused by `authorizedDriverId`                                         |
| 15  | Driver arrival                       | `POST /rides/:id/arrive`       | Rides    | `rides.arrived_at`                                         | `ride.driver_arrived`        | —      | **VERIFIED** (state only)                                                                              |
| 16  | Customer Ride PIN                    | `POST /rides/:id/start` body   | Rides    | `ride_otps`                                                | —                            | —      | **PARTIAL** — per-ride OTP, not the required permanent PIN; never delivered to the customer            |
| 17  | Ride start                           | `POST /rides/:id/start`        | Rides    | `rides.started_at`                                         | `ride.started`               | —      | **PARTIAL** — OTP cap defeated (§19)                                                                   |
| 18  | Live trip tracking                   | —                              | —        | —                                                          | —                            | —      | **ABSENT**                                                                                             |
| 19  | Destination arrival                  | —                              | —        | —                                                          | —                            | —      | **ABSENT** — no geofence, no arrival detection                                                         |
| 20  | Ride completion                      | `POST /rides/:id/complete`     | Rides    | `rides`, `ride_fares`, ledger                              | `ride.completed`             | —      | **PARTIAL** — fare from client input                                                                   |
| 21  | Final fare                           | in completion                  | Rides    | `ride_fares`                                               | —                            | —      | **NOT VERIFIED** — client supplies distance and duration                                               |
| 22  | Payment                              | —                              | Payments | `payment_ledger_entries`                                   | —                            | —      | **NOT VERIFIED** for non-cash — ledger only, no charge                                                 |
| 23  | Receipt                              | `GET /rides/:id/receipt`       | Rides    | `ride_receipts`                                            | —                            | —      | **PARTIAL** — minted lazily on read, not at completion                                                 |
| 24  | Rating / review                      | —                              | —        | `ride_ratings`                                             | —                            | —      | **ABSENT** — model only, no API, no service                                                            |

**Where the chain breaks:** step 11. Everything from 11 to 19 is either absent or unreachable.

---

## 4. Driver Workflow

| Step                      | API                                 | Status                                                                                             |
| ------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| Login                     | `POST /auth/otp/*`                  | **VERIFIED** — same flow as customer                                                               |
| Driver profile            | `GET /drivers/me` (auto-creates)    | **VERIFIED**                                                                                       |
| KYC document submission   | `POST /drivers/:driverId/documents` | **PARTIAL** — accepts an arbitrary `fileUrl: z.string().url()`; bypasses the Files module entirely |
| **Document approval**     | —                                   | **ABSENT** — no code path sets a document `VERIFIED`                                               |
| Driver-level verification | `POST /drivers/:id/verify` (admin)  | **VERIFIED** — but approves the driver without checking any document                               |
| Vehicle registration      | —                                   | **ABSENT** — `vehicleId` is accepted from the request body at accept, unvalidated                  |
| Online                    | `POST /drivers/status/online`       | **BLOCKED** — requires a verified licence that cannot be produced                                  |
| Offline                   | `POST /drivers/status/offline`      | **VERIFIED** — also clears the Geo live index                                                      |
| Heartbeat                 | `POST /drivers/heartbeat`           | **VERIFIED**                                                                                       |
| GPS update                | `POST /drivers/location`            | **VERIFIED** — validated, plausibility-checked, mirrored to Geo                                    |
| **Receive ride offer**    | —                                   | **ABSENT**                                                                                         |
| Accept                    | `POST /rides/accept`                | **PARTIAL** — no offer check, no busy check, no availability write                                 |
| Navigate to pickup        | —                                   | **ABSENT** — no routing/ETA integration                                                            |
| Arrive                    | `POST /rides/:id/arrive`            | **VERIFIED**                                                                                       |
| Verify customer PIN       | `POST /rides/:id/start`             | **PARTIAL**                                                                                        |
| Start / Complete          | `POST /rides/:id/{start,complete}`  | **PARTIAL**                                                                                        |
| Earnings                  | `GET /drivers/:driverId/wallet`     | **NOT VERIFIED** — reads `driver_wallets`, a table nothing writes; always zero                     |
| Settlement                | `SettlementJob`                     | **NOT VERIFIED** — job exists, absent from `JOB_NAMES`, never scheduled                            |
| Payout                    | `POST /payments/payouts`            | **PARTIAL** — requires a settlement that is never created                                          |
| Rating                    | —                                   | **ABSENT**                                                                                         |

---

## 5. Ride State Machine

`RideStatus` enum (`prisma/schema/shared/enums.prisma`): `REQUESTED`, `SEARCHING`, `ACCEPTED`, `DRIVER_ARRIVING`, `DRIVER_ARRIVED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_DRIVER`, `CANCELLED_BY_SYSTEM`, `NO_DRIVERS_FOUND`.

`RideRequestStatus`: `CREATED`, `SEARCHING`, `MATCHED`, `EXPIRED`, `ABANDONED`.

### Transition table (actual, from `lifecycle.service.ts:25-51`)

| Current                                              | Event / API          | Actor                  | Next                  | Transaction                                      | Idempotent                               |
| ---------------------------------------------------- | -------------------- | ---------------------- | --------------------- | ------------------------------------------------ | ---------------------------------------- |
| _(none)_                                             | `POST /rides/accept` | Driver                 | `ACCEPTED`            | Yes — request `FOR UPDATE` + `claimForMatch` CAS | Yes, via CAS + unique `rides.request_id` |
| `ACCEPTED`                                           | `POST /:id/arrive`   | Driver                 | `DRIVER_ARRIVED`      | Yes — ride `FOR UPDATE` + `updateStatusIf`       | Yes, 2nd call 409s                       |
| `ACCEPTED`                                           | —                    | —                      | `DRIVER_ARRIVING`     | _legal in table, **no endpoint writes it**_      | —                                        |
| `DRIVER_ARRIVING`                                    | `POST /:id/arrive`   | Driver                 | `DRIVER_ARRIVED`      | Yes                                              | Yes                                      |
| `DRIVER_ARRIVED`                                     | `POST /:id/start`    | Driver                 | `IN_PROGRESS`         | Yes + OTP verify                                 | Yes                                      |
| `IN_PROGRESS`                                        | `POST /:id/complete` | Driver                 | `COMPLETED`           | Yes + fare + ledger                              | Yes                                      |
| `ACCEPTED`/`ARRIVING`/`ARRIVED`                      | `POST /:id/cancel`   | Customer/Driver/System | `CANCELLED_BY_*`      | Yes                                              | Yes                                      |
| `IN_PROGRESS`                                        | `POST /:id/cancel`   | **System only**        | `CANCELLED_BY_SYSTEM` | Yes                                              | Yes                                      |
| `COMPLETED` / any `CANCELLED_*` / `NO_DRIVERS_FOUND` | —                    | —                      | _terminal_            | —                                                | —                                        |

### Unreachable states

`REQUESTED`, `SEARCHING`, `NO_DRIVERS_FOUND` and `DRIVER_ARRIVING` are **never written by any code**. A `Ride` row is inserted directly as `ACCEPTED` (`ride.repository.ts:51`). The first three belong to the missing dispatch phase; `DRIVER_ARRIVING` has no endpoint.

### Bypasses found

- **Entry to `ACCEPTED` is unguarded.** `acceptRideRequest` never reads `ride_dispatches`. Any driver passing `requireOperableDriver` can claim any `CREATED`/`SEARCHING` request by id. `RideRequest.id` is UUIDv7 — time-ordered, therefore guessable within a window.
- **`vehicleId` is unvalidated.** Taken from the request body with no check that the vehicle belongs to the driver or matches `request.vehicleTypeId`.
- **No driver-busy guard.** `rideRepo.findActiveByDriver` exists (`ride.repository.ts:94`) and is never called. One driver can hold unlimited concurrent rides.
- **Driver availability is never updated.** Neither `drivers.isAvailable` nor `driver_online_status.status` changes on accept or complete.
- **State enforcement is in the service, not the controller** — correct, and `updateStatusIf` gives a compare-and-swap backstop. This part is sound.

---

## 6. Dispatch / Matching

**[ZAROORAT] The pipeline does not exist.**

| Required stage                      | Status              | Evidence                                                                                           |
| ----------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Ride request → candidates           | **ABSENT**          | `createRequest` ends at `requestRepo.create` + one outbox event                                    |
| Nearby-driver search                | **BUILT, UNCALLED** | `GeoService.findNearbyDrivers` exists and is tested; `grep` shows no caller in `src/modules/rides` |
| Filtering (status, vehicle, radius) | **ABSENT**          | No eligibility code anywhere                                                                       |
| Ranking / scoring                   | **ABSENT**          | —                                                                                                  |
| Offer creation                      | **BUILT, UNCALLED** | `DispatchService.offerToDriver` — zero callers                                                     |
| Offer delivery                      | **ABSENT**          | No socket, no push                                                                                 |
| Driver accept/reject of an _offer_  | **ABSENT**          | `POST /rides/accept` takes a `requestId`, not an offer                                             |
| Dispatch timeout                    | **PARTIAL**         | `DispatchTimeoutJob` runs every minute against `ride_dispatches` — a table nothing writes          |
| Next-driver retry                   | **ABSENT**          | `dispatchRound` column exists, always 1                                                            |
| No-driver case                      | **ABSENT**          | `NO_DRIVERS_FOUND` never written; `RequestExpiryJob` marks `EXPIRED` after 5 min                   |
| Double-acceptance prevention        | **VERIFIED**        | Row lock + conditional claim + unique `rides.request_id` (migration `20260810100000`)              |

The one genuinely strong piece is the two-drivers-accept race: `lockForUpdate` → `claimForMatch` (conditional `updateMany`) → unique index backstop. That is correct and defended in depth.

**[INDUSTRY]** Published descriptions of large-scale dispatch consistently show: a driver-location cache queried for nearby candidates, a weighted score (ETA dominant, then acceptance rate, rating, trip efficiency), a sequential offer with a short acceptance window (~8–10s) held under a distributed lock keyed on driver id, and failover to the next candidate on decline or timeout. Offers are pushed over both a persistent socket and a push notification simultaneously. ([Hello Interview — Design a Ride-Sharing Service](https://www.hellointerview.com/learn/system-design/problem-breakdowns/uber), [System Design School — Uber](https://systemdesignschool.io/problems/uber/solution))

**[INFERENCE]** Zaroorat's existing primitives map onto that shape without new infrastructure: Geo supplies candidates, the Redis `LockStore` supplies the per-driver offer lock, `RideDispatch` supplies the offer row with `expiresAt`, and `DispatchTimeoutJob` supplies the timeout sweep. The missing piece is the orchestrator that connects them plus a delivery channel.

---

## 7. Location / GPS

| Concern                        | Status                   | Evidence                                                                                                                              |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Driver location ingestion      | **VERIFIED**             | `POST /drivers/location`, rate-limited, driver id from JWT — never from the body                                                      |
| Coordinate validation          | **VERIFIED**             | Zod `latitudeSchema`/`longitudeSchema` from Geo                                                                                       |
| Plausibility / spoof screening | **VERIFIED**             | `assessPlausibility` rejects out-of-range, stale, and impossible-speed fixes against the previous fix — a genuine server-side control |
| Mock-location signal           | **VERIFIED as a signal** | `isMockLocation` rejected when configured; correctly not treated as attestation                                                       |
| Durable persistence            | **VERIFIED**             | `driver_locations`, `geography(Point,4326)`, upsert one row per driver                                                                |
| Spatial index                  | **VERIFIED**             | GiST on `driver_locations.location`, migration `20260815000000`, asserted by a test                                                   |
| Redis live state               | **VERIFIED**             | `geo:driver:{id}` + `geo:cell:{h3}`, TTL'd, Lua CAS on timestamp                                                                      |
| H3 bucketing                   | **VERIFIED**             | resolution from config, `cellsCovering` derives rings from radius                                                                     |
| `ST_DWithin` radius query      | **VERIFIED**             | `PostgisProvider.findNearbyDrivers`                                                                                                   |
| Staleness handling             | **VERIFIED**             | `recorded_at >= freshAfter` in SQL, plus Redis TTL                                                                                    |
| **Customer location**          | **ABSENT**               | No intake API, no storage                                                                                                             |
| **GPS update frequency**       | **UNDEFINED**            | Server accepts any rate; no client contract, no documented cadence                                                                    |
| **Live delivery to customer**  | **ABSENT**               | `GET /drivers/:id/location` is self-or-staff only; a customer on an active ride is refused                                            |
| **Trip trail**                 | **ABSENT**               | `ride_track_points` is named in a schema comment as RANGE-partitioned but no code writes it                                           |
| **Reconnect / missed updates** | **ABSENT**               | No socket layer                                                                                                                       |

**Can the customer see the driver moving on a map in real time? No.** Two independent blockers: no realtime transport, and the only read endpoint refuses the customer.

**[INDUSTRY]** Public write-ups put driver ping intervals in the 3–10 second range, often adaptive on speed and status, streamed to riders over WebSockets. ([PubNub — Optimizing GPS Ping Frequency](https://www.pubnub.com/blog/optimize-gps-ping/), [Hello Interview](https://www.hellointerview.com/learn/system-design/problem-breakdowns/uber))

**[INFERENCE]** At 5s pings, Zaroorat's current write path costs three sequential DB round-trips plus two Redis ops per ping per driver (`location.service.ts` reads the driver, reads the previous fix, upserts, mirrors, then updates the heartbeat). That is acceptable at pilot scale and will need batching well before it is not.

---

## 8. Realtime

**[ZAROORAT] There is no realtime layer.** `src/plugins/socket/socket.plugin.ts` contains `export {};`. `socket.io` is not in `package.json`.

| Event                      | Producer    | Consumer | Auth | Room | Implemented |
| -------------------------- | ----------- | -------- | ---- | ---- | ----------- |
| ride requested             | Rides       | Driver   | —    | —    | **No**      |
| driver assigned / accepted | Rides       | Customer | —    | —    | **No**      |
| driver location            | Drivers/Geo | Customer | —    | —    | **No**      |
| driver arrived             | Rides       | Customer | —    | —    | **No**      |
| ride started               | Rides       | Both     | —    | —    | **No**      |
| ride progress              | Rides       | Customer | —    | —    | **No**      |
| ride completed             | Rides       | Both     | —    | —    | **No**      |
| ride cancelled             | Rides       | Both     | —    | —    | **No**      |
| payment status             | Payments    | Customer | —    | —    | **No**      |

The domain events these would carry **do already exist** and are written transactionally to the outbox: `ride.requested|accepted|driver_arrived|started|completed|cancelled`, `driver.status_changed`, `payment.*`. `OutboxRelay` dispatches them to an in-process `EventBus` with claim tokens, retry, dead-lettering and multi-instance safety.

**[INFERENCE]** This is the right substrate. A socket layer should subscribe to the existing `EventBus` and fan out via Redis pub/sub across API instances. Building a second event system would be the mistake.

**Reconnect / missed-event recovery:** `GET /rides/active` exists for both roles and is the correct state-resync primitive. It is sufficient for "app restarted, what ride am I on"; it is not sufficient for replaying missed events.

---

## 9. Notifications

| Capability                             | Status                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| SMS provider                           | **VERIFIED** — MSG91 + mock, template support, timeout                                         |
| SMS retry                              | **VERIFIED (working tree)** — OTP delivery moved onto a BullMQ worker with attempts/backoff    |
| **FCM**                                | **ABSENT** — no SDK, no code. `.env.example` declares `FCM_PROJECT_ID` with nothing reading it |
| **APNs**                               | **ABSENT**                                                                                     |
| **Push token storage**                 | **PARTIAL** — `user_devices.fcm_token` column exists and is written at login; never read       |
| Token refresh / invalid-token handling | **ABSENT**                                                                                     |
| Notification templates / preferences   | **ABSENT** — `prisma/schema/modules/notification/` models exist, no code                       |

**Every ride notification is absent**, both directions: driver-assigned, arriving, arrived, started, completed, cancelled, payment (customer); new-ride, cancelled, earnings (driver).

**[INDUSTRY]** Offers are delivered over push (APNs/FCM) _and_ a socket simultaneously, because either channel alone drops offers. ([Hello Interview](https://www.hellointerview.com/learn/system-design/problem-breakdowns/uber))

**[INFERENCE]** For Zaroorat this is not optional polish — with no socket and no push, a backgrounded driver app cannot be reached at all, so dispatch cannot work even once written. Push and socket are prerequisites of dispatch, not follow-ups.

---

## 10. Pricing

| Component                                   | Status       | Evidence                                                                                                                                                                                                   |
| ------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base / per-km / per-minute / waiting        | **VERIFIED** | `RideRateCard`, `fare.service.ts`                                                                                                                                                                          |
| Minimum fare, platform fee, tax, commission | **VERIFIED** | same                                                                                                                                                                                                       |
| Service-type rates                          | **PARTIAL**  | `rateCardsByVehicleType` keyed by vehicle-type **UUID** from `RIDE_RATE_CARDS_JSON` env                                                                                                                    |
| **Rate-card duplication**                   | **CONFLICT** | `vehicle_types` has `base_fare`, `per_km_rate`, `per_minute_rate`, `waiting_charge`, `minimum_fare`, `cancellation_charge` columns — **nothing reads them**. Pricing lives in env; the DB columns are dead |
| Surge                                       | **ABSENT**   | `surgeMultiplier` plumbed everywhere, always `1.0`. `SurgeWindow` model unused                                                                                                                             |
| Promo / discount                            | **ABSENT**   | `discountAmount` always 0; `promoCode` stored, never applied                                                                                                                                               |
| Toll / extras                               | **ABSENT**   | `toll_amount` column, never written                                                                                                                                                                        |
| Cancellation fee                            | **PARTIAL**  | Hardcoded `new Decimal(50)`, recorded with `feeCharged = true`, **never charged**                                                                                                                          |
| Waiting fee                                 | **PARTIAL**  | `waitTimeMin` always 0; `RideWaitEvent` unused                                                                                                                                                             |
| Rounding                                    | **PARTIAL**  | JS floats with `Math.round(v*100)/100` per step. Ledger balances exactly, but half-values mis-round (`money(1.005) → 1.00`)                                                                                |
| Currency                                    | **PARTIAL**  | `'INR'` hardcoded in the ledger repository                                                                                                                                                                 |
| Quote persistence                           | **ABSENT**   | Quote recomputed at request time; customer can be shown one price and charged from another calculation                                                                                                     |

**Can the client manipulate fare? Yes — decisively.**

`POST /rides/:id/complete` accepts `{ actualDistanceKm, actualDurationMin }` from the **driver's** app (`ride.schemas.ts:42-45`) and feeds them straight into `calculateFinalFare`. The only validation is finite and non-negative. A modified client sends `actualDistanceKm: 900` and is paid for a 900 km trip. The backend owns the GPS stream that could derive this and does not use it.

---

## 11. Payment

| Concern                                        | Status                | Evidence                                                                                                                                                                                                          |
| ---------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double-entry ledger                            | **VERIFIED**          | `postGroup` refuses unbalanced groups and non-positive amounts; requires a `TransactionClient` so an out-of-transaction posting is impossible                                                                     |
| Wallet hold                                    | **VERIFIED**          | Row lock + available-balance check                                                                                                                                                                                |
| Payment intent lifecycle                       | **VERIFIED**          | State machine, row lock, status short-circuit                                                                                                                                                                     |
| Webhook signature                              | **VERIFIED**          | HMAC over the preserved raw body                                                                                                                                                                                  |
| Webhook replay window                          | **VERIFIED**          | `webhookToleranceSeconds`                                                                                                                                                                                         |
| Webhook dedup                                  | **VERIFIED**          | `findOrPersist` on `gatewayEventId`, **inside the same transaction** as the ledger mutation                                                                                                                       |
| Idempotency (intents/topup/hold/refund/payout) | **VERIFIED**          | Payload-hashed, conflict → 409; payout and refund additionally carry a DB unique key                                                                                                                              |
| Refund cap                                     | **VERIFIED**          | Bounded by stored captured amount, not a client figure                                                                                                                                                            |
| Payout bound                                   | **VERIFIED**          | `netPayable − alreadyCommitted` under a settlement row lock                                                                                                                                                       |
| **Gateway integration**                        | **MOCKED BY DEFAULT** | `paymentConfig.defaultGateway` selects Razorpay/Stripe, else `MockGatewayProvider`. Razorpay/Stripe classes are ~55 lines each — thin, unproven against a live gateway                                            |
| **Ride → payment**                             | **BROKEN**            | Completion posts a ledger entry and stops. No `PaymentIntent`, no balance check, no gateway call. `paymentStatus` stays `PENDING` forever for non-cash                                                            |
| **Wallet balance vs ledger**                   | **DIVERGENT**         | `customer_wallets.balance` written by topup/hold only. Ride completion debits `CUSTOMER_WALLET` in the ledger; intent success credits it. Neither touches the column                                              |
| **Wallet holds**                               | **LEAKED**            | `releaseHold` has no production caller; completion neither consumes nor releases                                                                                                                                  |
| **Driver earnings**                            | **THREE SOURCES**     | `ride_fares.driver_earning`, ledger `DRIVER_PAYABLE`, and `driver_wallets` (written by nothing). No reconciliation                                                                                                |
| **Settlement**                                 | **NEVER RUNS**        | `SettlementJob` absent from `JOB_NAMES` / `MAINTENANCE_HANDLERS` / `JOB_SCHEDULES`                                                                                                                                |
| **Gateway call inside transaction**            | **UNSAFE**            | Payout and refund call the gateway with a DB transaction open holding row locks; on failure the `FAILED` marker rolls back with everything else — money can leave with no record and no surviving idempotency key |
| Cash rides                                     | **VERIFIED**          | Posts only the commission the driver owes; `paymentStatus = 'PAID'`                                                                                                                                               |
| Chargebacks                                    | **PARTIAL**           | Repository exists, no flow                                                                                                                                                                                        |

---

## 12. Customer Ride PIN

**Requirement (Part 12):** permanent 4-digit PIN, same every ride, customer-retrievable, driver never told the expected value, driver enters it, backend verifies against `ride.customerId`.

**[ZAROORAT] Not implemented. Nothing exists.** `grep -riE "customerPin|ridePin|permanentPin|staticPin|pinHash"` across `src` and `prisma` returns nothing.

### What exists instead

Per-ride `RideOtp` (`ride_otps`), created inside the accept transaction:

| Property                 | Current                                                         | Required                                  |
| ------------------------ | --------------------------------------------------------------- | ----------------------------------------- |
| Scope                    | Per ride                                                        | **Per customer, permanent**               |
| Length                   | 6 digits (`RIDE_OTP_LENGTH`)                                    | **4 digits**                              |
| Storage                  | Hashed via Auth's `OtpHasher` (HMAC + pepper)                   | Hashed or encrypted                       |
| Expiry                   | `RIDE_OTP_TTL_MINUTES`                                          | None (permanent)                          |
| Attempt cap              | `RIDE_OTP_MAX_ATTEMPTS` — **defeated** (below)                  | Enforced                                  |
| Single-use               | `claimVerification`                                             | N/A for a static PIN                      |
| **Delivery to customer** | **NONE** — plaintext returned in the _driver's_ accept response | Customer retrieves from their own profile |
| Comparison               | `!==` on hashes, not constant-time                              | Constant-time                             |
| Rate limiting            | **None on the route**                                           | Required                                  |

### Two defects in the current mechanism

1. **The attempt cap does not bind.** `startRide` opens a transaction and calls `verifyStartOtp(rideId, otp, tx)`. `claimAttempt` increments `ride_otps.attempts` through that same `tx`. A wrong code throws, the transaction rolls back, **and the increment is undone**. Every attempt starts from zero. With no rate limit on `POST /rides/:id/start` (the route carries only `driverOnly`), a 6-digit code is exhaustible.

2. **The plaintext OTP is returned to the driver.** `acceptRideRequest` returns `{ ride, plaintextOtp }` and `RideStateController.accept` sends `{ data: result }` — so the driver's accept response contains the code they are supposed to obtain from the passenger. This voids the control entirely: the driver can start a ride with no passenger present.

**[INDUSTRY]** Uber issues a fresh 4-digit PIN per trip, shown in the rider's app, spoken to the driver, with **5 entry attempts**. Ola generates a fresh OTP per trip. Rapido uses a **static PIN that is the same on every ride**, and the publicly stated rationale is SMS-delivery unreliability in tier-2/3 cities — the passenger always knows their PIN with no SMS dependency. ([Uber — PIN verification for drivers](https://www.uber.com/en-US/blog/pin-verification-drivers), [Uber Newsroom — PIN](https://www.uber.com/hk/en/newsroom/pinhk), [Medium — Why Rapido gives you the same OTP every trip](https://medium.com/@uditjain_100/why-rapido-gives-you-the-same-otp-every-trip-and-why-uber-doesnt-25a530a8e5a3))

**[INFERENCE]** The requested design is the Rapido model, and the trade-off is explicit: a static PIN is more available and less phishable-by-SMS-interception, but it never rotates, so a compromised PIN is compromised until changed. That makes three things non-negotiable in the eventual implementation, none of which the current OTP path has: a **durable** attempt counter (outside the aborting transaction), **rate limiting** on the verify route, and **removal of the PIN from every driver-facing response**. A customer-initiated PIN change and a migration path off `RideOtp` are also required.

---

## 13. Cancellation

| Path                      | State transition                                                               | Fee                              | Payment effect           | Notification | Socket     | Idempotent |
| ------------------------- | ------------------------------------------------------------------------------ | -------------------------------- | ------------------------ | ------------ | ---------- | ---------- |
| Customer, before matching | **N/A** — no `DELETE /rides/requests/:id`; only `RequestExpiryJob` after 5 min | —                                | —                        | —            | —          | —          |
| Customer, after accept    | `→ CANCELLED_BY_CUSTOMER` **VERIFIED**                                         | ₹0                               | none                     | **absent**   | **absent** | Yes (CAS)  |
| Customer, after arrival   | `→ CANCELLED_BY_CUSTOMER` **VERIFIED**                                         | ₹50 hardcoded, `feeCharged=true` | **none — never charged** | **absent**   | **absent** | Yes        |
| Driver cancels            | `→ CANCELLED_BY_DRIVER` **VERIFIED**                                           | ₹0                               | none                     | **absent**   | **absent** | Yes        |
| Driver no-show            | **ABSENT** — no detection                                                      | —                                | —                        | —            | —          | —          |
| Customer no-show          | **ABSENT** — no wait timer, no `RideWaitEvent` writes                          | —                                | —                        | —            | —          | —          |
| System cancel             | `→ CANCELLED_BY_SYSTEM` **VERIFIED**                                           | ₹0                               | none                     | **absent**   | **absent** | Yes        |

**Critical gap:** a customer with a `CREATED` ride request and no driver yet **cannot cancel it**. There is no endpoint. `POST /rides/:id/cancel` takes a _ride_ id, and no ride exists before acceptance.

`CancellationService` records a fee it never collects and asserts `feeCharged = true`. Reconciliation against the ledger cannot balance, and support would refund fees never taken.

**[INDUSTRY]** Uber charges a rider cancellation fee beyond a ~2-minute window after acceptance (5 for premium tiers), waives it when the driver is ≥5 minutes late or not progressing, and starts wait-time charging after a grace period at pickup. Ola waives the fee when the driver is >5 minutes past the shown ETA. ([Uber — Cancellation fees explained](https://help.uber.com/en/riders/article/cancellation-fees-explained?nodeId=069853a3-f014-40a3-ad58-88ef56b1b27f), [Uber — Wait time fees](https://help.uber.com/en/riders/article/wait-time-fees-and-refunds?nodeId=469f1786-1543-4c83-abbf-ddccb7826fc2), [Ola — Why is cancellation fee charged](https://help.olacabs.com/support/dreport/208298769))

**[INFERENCE]** Zaroorat has `cancellationGraceMinutes` (default 2) in `rideConfig` and does not use it. The fairness rule — waive when the driver is late — requires an ETA the platform does not compute, so a grace-window-only policy is the honest V1.

---

## 14. Ride Completion

Flow as coded (`lifecycle.service.ts:244-349`), all inside one transaction:

```
lock ride FOR UPDATE → assert assigned driver → validate transition
→ calculateFinalFare(CLIENT distance, CLIENT duration)   ← unsafe
→ updateStatusIf(IN_PROGRESS → COMPLETED)                 ← CAS, idempotent
→ ride_fares insert
→ LedgerService.recordTripPayment(tx)                     ← ledger only
→ ride_status_events insert
→ outbox ride.completed
COMMIT
```

**Sound:** single transaction, row lock, CAS (so a retry cannot double-post), ledger written atomically with the fare, outbox in the same transaction.

**Unsound:**

- Fare derives from client-supplied distance and duration (§10).
- No `PaymentIntent`, no capture, no balance check for non-cash (§11).
- No receipt generated at completion — minted lazily on the first `GET`, with no status check, so a receipt can be produced for an `IN_PROGRESS` or `CANCELLED` ride.
- Driver is not returned to available; no `ON_TRIP` → `ONLINE` transition.
- No ratings prompt, no trip summary.

---

## 15. Rating / Review

**[ZAROORAT] Entirely absent as functionality.** `RideRating` exists in the Prisma schema with `@@unique([rideId, ratedBy])` — the duplicate-prevention constraint is in place. `ReviewTagAssignment`, `ReviewFlag`, `ReviewResponse` models also exist.

No route, no controller, no service, no repository. `grep -riE "rating|review"` across `src/modules/rides` and `src/modules/users` returns only two type re-exports.

Driver `rating`/`totalRatings` columns on `drivers` are never written, so any displayed driver rating would be null or a default.

---

## 16. Safety / Emergency

| Capability                           | Status                                                                       | Classification                     |
| ------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------- |
| Emergency contacts                   | **VERIFIED** — full CRUD under `/users/me/emergency-contacts`                | **REQUIRED** — built               |
| SOS trigger                          | **ABSENT** — `src/modules/sos` is `export {};`                               | **REQUIRED FOR CURRENT PRODUCT**   |
| Trip sharing                         | **ABSENT**                                                                   | **REQUIRED**                       |
| Live trip tracking (for the contact) | **ABSENT**                                                                   | **REQUIRED** (depends on realtime) |
| Safety incident record               | **ABSENT**                                                                   | OPTIONAL for V1                    |
| Support / contact                    | **ABSENT** — `support` stub; `SupportTicket` model unused                    | OPTIONAL                           |
| Ride details for a contact           | **ABSENT**                                                                   | **REQUIRED** with trip sharing     |
| Driver/customer identity disclosure  | **PARTIAL** — `GET /rides/:id` returns the ride; no vetted counterparty view | **REQUIRED**                       |
| Emergency escalation                 | **ABSENT**                                                                   | FUTURE                             |
| `SOS_EVIDENCE` file purpose          | **VERIFIED** — declared in the Files read policy with a `safety:read` scope  | Supporting infrastructure exists   |

**[INFERENCE]** SOS and trip sharing are the two I would not defer. This is a bike-taxi/cab platform carrying passengers; emergency contacts already exist and are inert without a trigger and a shareable trip link. The Files module already reserves an `SOS_EVIDENCE` purpose, so the intent was there. Everything else in this section can wait.

---

## 17. Customer Ride History

| Item                       | Status                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Active ride                | **VERIFIED** — `GET /rides/active`, role-aware (driver vs customer)                                          |
| Upcoming / scheduled       | **ABSENT** — `ScheduledRide` model unused                                                                    |
| Completed / cancelled list | **PARTIAL** — `GET /rides/history` returns both, no status filter                                            |
| Fare                       | **VERIFIED** — `include: { fare: true }`                                                                     |
| Payment status             | **PARTIAL** — `paymentStatus` present but wrong for non-cash (always `PENDING`)                              |
| Receipt                    | **PARTIAL** — separate call, lazily minted                                                                   |
| Driver / vehicle detail    | **ABSENT** from history — only `driverId`/`vehicleId`                                                        |
| Pickup / drop              | **PARTIAL** — addresses returned; geography columns are `Unsupported` so coordinates do not serialize        |
| Timestamps                 | **VERIFIED**                                                                                                 |
| **Authorization**          | **VERIFIED** — scoped to `callerId`; any client-supplied id ignored. Covered by `authorization-bola.test.ts` |
| **Pagination**             | **ABSENT** — hardcoded `take: 20`, no cursor, no offset, no total                                            |

---

## 18. Failure / Recovery

| #   | Scenario                     | Behaviour                                                                                                                                          | Assessment                                                                                                                             |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Customer loses network       | State survives in Postgres; `GET /rides/active` resyncs                                                                                            | **OK**                                                                                                                                 |
| 2   | Driver loses network         | Heartbeat stops → `HeartbeatTimeoutJob` sets offline after threshold                                                                               | **PARTIAL** — worker does not re-check `heartbeatAt` under the lock, so a driver who just returned can be forced offline on stale data |
| 3   | Socket disconnects           | N/A                                                                                                                                                | No socket                                                                                                                              |
| 4   | App killed                   | Server state unaffected                                                                                                                            | **OK**                                                                                                                                 |
| 5   | App reopened                 | `GET /rides/active`                                                                                                                                | **OK** for state; no missed-event replay                                                                                               |
| 6   | GPS stops                    | Location goes stale; Geo excludes via `recorded_at >= freshAfter` and Redis TTL                                                                    | **OK**                                                                                                                                 |
| 7   | Driver goes offline          | Transactional; shift closed; Geo live entry cleared                                                                                                | **OK**                                                                                                                                 |
| 8   | Customer cancels             | CAS transition                                                                                                                                     | **OK** post-accept; **impossible** pre-accept                                                                                          |
| 9   | Driver cancels               | CAS transition                                                                                                                                     | **OK**                                                                                                                                 |
| 10  | Gateway unavailable          | Ride state unaffected — because completion never calls the gateway                                                                                 | **Consistent for the wrong reason**                                                                                                    |
| 11  | Duplicate ride request       | **Creates a second request** — no idempotency key, and the active-ride check is a non-locking read _outside_ the transaction with no DB constraint | **UNSAFE**                                                                                                                             |
| 12  | Duplicate webhook            | Deduped in-transaction before touching money                                                                                                       | **VERIFIED**, tested                                                                                                                   |
| 13  | Duplicate ride start         | `updateStatusIf` CAS → second call 409s                                                                                                            | **OK**                                                                                                                                 |
| 14  | Concurrent driver acceptance | Lock + conditional claim + unique index                                                                                                            | **VERIFIED**, tested                                                                                                                   |
| 15  | DB transaction failure       | Everything rolls back including the outbox row; API reports failure                                                                                | **VERIFIED**                                                                                                                           |
| 16  | Redis unavailable            | Auth epoch/revocation and rate limiting **fail closed → 503**; Geo returns `degraded` and falls back to a bounded PostGIS query                    | **VERIFIED**                                                                                                                           |
| 17  | Push failure                 | N/A                                                                                                                                                | No push                                                                                                                                |

**Systemic gap:** recovery is good for _state_ and absent for _delivery_. Everything a client missed while disconnected is unrecoverable because nothing was ever sent.

---

## 19. Security

### Strong (verified)

Deny-by-default `onRequest` guard with an explicit `config.public` allow-list, enforced by `route-graph.test.ts` against the live route table. JWT with issuer/audience/exp/iat/sid/epoch verification. Refresh tokens HMAC-hashed with a pepper, single-use rotation, reuse detection revoking the family and bumping the epoch. OTP hashed in Redis, atomically consumed, rate-limited per phone/device/IP with lockout and challenge-to-phone binding. Webhook HMAC + replay window + dedup. Presigned URLs scoped and expiring; uploads land in a quarantine bucket. All SQL parameterised — no injection found. Log redaction configured. Rate limiter and auth guard both fail closed.

**BOLA/IDOR is the strongest area.** Driver routes derive identity from the JWT and _ignore_ the `:driverId` path parameter (`actingDriverId`); staff access goes through `authorizedDriverId`. Ride reads use `assertRideParty`. All covered by `authorization-bola.test.ts`.

### Weak or absent

| Finding                                                                                                                                                                                                                        | Severity |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| **Start OTP returned to the driver in the accept response** — voids passenger-presence verification                                                                                                                            | **P0**   |
| **Start OTP attempt counter rolls back with the transaction**; no rate limit on the route → unbounded brute force                                                                                                              | **P0**   |
| **Any operable driver can claim any pending ride request** — no offer check, UUIDv7 ids are time-ordered                                                                                                                       | **P0**   |
| **Fare derived from client-supplied distance/duration**                                                                                                                                                                        | **P0**   |
| **Driver documents accept an arbitrary `fileUrl`** — cross-driver reference, unscanned object, or attacker URL an admin reviewer then loads (SSRF/phishing surface)                                                            | **P1**   |
| **`vehicleId` unvalidated** at accept — any vehicle, including another driver's                                                                                                                                                | **P1**   |
| No idempotency on any ride state-changing route                                                                                                                                                                                | **P1**   |
| One-active-ride-per-customer enforced by a non-locking read with no DB constraint                                                                                                                                              | **P1**   |
| Payment intent/topup idempotency is Redis-only (payout/refund have DB unique keys)                                                                                                                                             | **P1**   |
| `setSuspended` opens a transaction, locks the driver row, then calls `setOffline` which opens a **second** transaction and locks the same row — self-deadlock until timeout, so the emergency suspension control does not work | **P1**   |
| Gateway called inside an open DB transaction (payout, refund)                                                                                                                                                                  | **P1**   |
| OTP hash compared with `!==`, not constant-time                                                                                                                                                                                | **P2**   |
| Single `webhookSecret` for all gateways                                                                                                                                                                                        | **P2**   |
| Location privacy: no policy on retention of `driver_locations`                                                                                                                                                                 | **P2**   |
| No admin surface, so no admin authorization model beyond the `admin` role check on 3 routes                                                                                                                                    | **P2**   |

---

## 20. Module Gap Analysis

| Capability        | Existing Module   | Status                | Evidence                                       | Production Gap                               |
| ----------------- | ----------------- | --------------------- | ---------------------------------------------- | -------------------------------------------- |
| Auth              | `auth`            | **COMPLETE**          | 53 files; rotation, epochs, devices, sessions  | None material                                |
| User              | `users`           | **COMPLETE**          | 52 files; profile, contacts, places, lifecycle | Customer location intake                     |
| Driver            | `drivers`         | **INCOMPLETE**        | 52 files                                       | Document approval; availability writes       |
| Vehicle           | _stub_            | **MISSING**           | `vehicles/index.ts` = `export {};`             | Registration, ownership, type validation     |
| Ride              | `rides`           | **INCOMPLETE**        | 55 files; lifecycle real                       | Dispatch, idempotency, server-side distance  |
| Dispatch          | _stub_            | **MISSING**           | `offerToDriver` zero callers                   | Entire pipeline                              |
| Matching          | _stub_            | **MISSING**           | `matching/index.ts` = `export {};`             | Eligibility, ranking                         |
| Geography         | `geo`             | **COMPLETE**          | 22 files, GiST index, tested                   | **No caller**                                |
| Location          | `drivers` + `geo` | **COMPLETE (driver)** | ingestion + plausibility + Redis/H3/PostGIS    | Customer location; trip trail                |
| Realtime / Socket | _stub_            | **MISSING**           | `export {};`, no `socket.io`                   | Entire layer                                 |
| Notifications     | `notifications`   | **INCOMPLETE**        | SMS only, OTP only                             | FCM/APNs, all ride notifications             |
| Push              | —                 | **MISSING**           | no SDK                                         | Token lifecycle, delivery, retry             |
| Pricing           | _stub_ + `rides`  | **INCOMPLETE**        | env rate cards; DB columns dead                | Surge, promo, DB-backed rates                |
| Payment           | `payments`        | **INCOMPLETE**        | 65 files; ledger sound                         | Ride charge, wallet projection, live gateway |
| Ledger            | `payments`        | **COMPLETE**          | balance invariant enforced                     | Reconciliation vs settlement                 |
| File              | `files`           | **COMPLETE**          | quarantine, inspection, policy                 | Mid-refactor (§1.1)                          |
| Rating            | —                 | **MISSING**           | model only                                     | Entire feature                               |
| Cancellation      | `rides`           | **INCOMPLETE**        | transitions work                               | Pre-accept cancel; fee collection            |
| Safety / SOS      | _stub_            | **MISSING**           | contacts exist, inert                          | Trigger, trip sharing                        |
| Support           | _stub_            | **MISSING**           | —                                              | Deferrable                                   |
| Trip History      | `rides`           | **INCOMPLETE**        | authorized, works                              | Pagination, driver/vehicle detail            |
| Promotions        | _stub_            | **MISSING**           | —                                              | Deferrable                                   |
| Wallet            | `payments`        | **INCOMPLETE**        | hold/topup work                                | Balance diverges from ledger                 |
| Referral          | _stub_            | **MISSING**           | schema only                                    | Deferrable                                   |
| Admin             | _stub_            | **MISSING**           | 3 role-gated routes                            | Ops console                                  |
| Analytics         | _stub_            | **MISSING**           | —                                              | Deferrable                                   |
| Audit             | `core/events`     | **COMPLETE**          | outbox + status events                         | None material                                |
| Fraud / Risk      | partial           | **INCOMPLETE**        | GPS plausibility, device signals               | No scoring                                   |

---

## 21. P0 Findings — the ride cannot function

| #     | Finding                                                     | Why P0                                                                                                            |
| ----- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| P0-1  | **Dispatch does not exist**                                 | A request never reaches a driver. No offer row is ever written. This alone makes the product non-functional       |
| P0-2  | **No realtime layer**                                       | Even a correct dispatch could not deliver an offer, and no live tracking is possible                              |
| P0-3  | **No push notifications**                                   | A backgrounded driver app is unreachable; dispatch cannot work without it                                         |
| P0-4  | **No driver can go online**                                 | `setOnline` needs a `VERIFIED` licence document; no code path can produce one. Driver supply is structurally zero |
| P0-5  | **Start OTP is returned to the driver**                     | The driver receives the code they must obtain from the passenger — rides can start with nobody aboard             |
| P0-6  | **Start OTP brute force is unbounded**                      | Attempt counter rolls back with the failing transaction; no rate limit on the route                               |
| P0-7  | **Any operable driver can claim any request**               | No dispatch-offer check; time-ordered UUIDv7 ids make enumeration practical                                       |
| P0-8  | **Final fare from client-supplied distance/duration**       | Direct, unbounded revenue leakage and collusion fraud                                                             |
| P0-9  | **Non-cash rides never charged**                            | 100% of non-cash revenue uncollected while drivers are credited                                                   |
| P0-10 | **Wallet balance and ledger diverge**                       | Two representations of one balance; neither is right after the first non-cash ride                                |
| P0-11 | **A driver can hold unlimited concurrent rides**            | No busy check, no availability write                                                                              |
| P0-12 | **Working tree does not build; 130 integration tests fail** | Nothing can ship from this state (§1.1)                                                                           |

## 22. P1 Findings — critical production functionality/security

| #     | Finding                                                                          |
| ----- | -------------------------------------------------------------------------------- |
| P1-1  | Customer cannot cancel before a driver accepts — no endpoint exists              |
| P1-2  | Driver documents bypass the Files module (arbitrary `fileUrl`)                   |
| P1-3  | `vehicleId` unvalidated at accept                                                |
| P1-4  | No idempotency on any ride state-changing route                                  |
| P1-5  | One-active-ride-per-customer: non-locking read, no DB constraint                 |
| P1-6  | `setSuspended` self-deadlocks — the emergency control does not work              |
| P1-7  | Gateway called inside an open DB transaction (payout, refund)                    |
| P1-8  | `SettlementJob` never scheduled → no driver is ever paid                         |
| P1-9  | Payment gateway is mocked by default; Razorpay/Stripe adapters unproven          |
| P1-10 | Cancellation fee recorded as charged, never collected                            |
| P1-11 | Wallet holds never consumed or released                                          |
| P1-12 | `driver_wallets` is a dead duplicate — drivers see zero earnings                 |
| P1-13 | Settlement derived from `ride_fares`, never reconciled with `DRIVER_PAYABLE`     |
| P1-14 | Heartbeat-timeout worker can take a live driver offline (no re-check under lock) |
| P1-15 | Customer cannot see the assigned driver's location (authz refuses them)          |
| P1-16 | Payment intent/topup idempotency is Redis-only                                   |
| P1-17 | No vehicle registration or ownership model                                       |
| P1-18 | Receipt minted lazily on GET, no status check                                    |
| P1-19 | No rating feature                                                                |
| P1-20 | No SOS trigger or trip sharing (emergency contacts exist but are inert)          |

## 23. P2 Findings — required for a robust V1

| #     | Finding                                                                     |
| ----- | --------------------------------------------------------------------------- |
| P2-1  | No pagination on ride history                                               |
| P2-2  | No customer location intake                                                 |
| P2-3  | `DRIVER_ARRIVING` state unreachable                                         |
| P2-4  | Request-expiry job's unconditional update can overwrite a `MATCHED` request |
| P2-5  | Quote not persisted or bound to the request                                 |
| P2-6  | Float money arithmetic; mis-rounds exact halves                             |
| P2-7  | OTP hash comparison not constant-time                                       |
| P2-8  | Single webhook secret across gateways                                       |
| P2-9  | Pricing duplicated: env rate cards vs dead `vehicle_types` columns          |
| P2-10 | Vehicle types not seeded; no service-type listing API                       |
| P2-11 | No waiting-time tracking (`RideWaitEvent` unused)                           |
| P2-12 | No no-show detection either side                                            |
| P2-13 | `OutboxRelay` runs in every API instance                                    |
| P2-14 | No trip trail (`ride_track_points` unwritten)                               |
| P2-15 | No location-data retention policy                                           |
| P2-16 | `.env.example` declares `FCM_PROJECT_ID` that nothing reads                 |

## 24. P3 Findings — enhancement / future

Surge pricing · promotions and discounts · referrals · scheduled rides · carpool · chat · support ticketing · admin console · analytics · fraud scoring · chargeback workflow · driver heatmaps · multi-currency · toll/extras.

---

## 25. Complete Workflow Matrix

| #   | Customer Action   | Backend             | Driver   | Realtime | Notification | Payment     | State             | Status                        |
| --- | ----------------- | ------------------- | -------- | -------- | ------------ | ----------- | ----------------- | ----------------------------- |
| 1   | Login             | `auth` ✓            | ✓        | —        | SMS OTP ✓    | —           | session           | **WORKS**                     |
| 2   | Location          | —                   | —        | —        | —            | —           | —                 | **MISSING**                   |
| 3   | Pickup/drop       | request body ✓      | —        | —        | —            | —           | —                 | **WORKS**                     |
| 4   | Fare estimate     | `/rides/quote` ✓    | —        | —        | —            | —           | —                 | **PARTIAL**                   |
| 5   | Request ride      | `/rides/requests` ✓ | —        | ✗        | ✗            | —           | `CREATED`         | **PARTIAL**                   |
| 6   | Matching          | ✗                   | ✗        | ✗        | ✗            | —           | —                 | **MISSING**                   |
| 7   | Driver assignment | ✗                   | ✗        | ✗        | ✗            | —           | —                 | **MISSING**                   |
| 8   | Driver acceptance | `/rides/accept` ✓   | ✓        | ✗        | ✗            | —           | `ACCEPTED`        | **UNGUARDED**                 |
| 9   | Driver navigation | ✗                   | ✗        | ✗        | ✗            | —           | —                 | **MISSING**                   |
| 10  | Driver arrival    | `/:id/arrive` ✓     | ✓        | ✗        | ✗            | —           | `DRIVER_ARRIVED`  | **PARTIAL**                   |
| 11  | Customer PIN      | `ride_otps`         | enters   | ✗        | ✗            | —           | —                 | **BROKEN** — leaked to driver |
| 12  | Ride start        | `/:id/start` ✓      | ✓        | ✗        | ✗            | —           | `IN_PROGRESS`     | **UNSAFE**                    |
| 13  | Live tracking     | ✗                   | GPS in ✓ | ✗        | —            | —           | —                 | **MISSING**                   |
| 14  | Destination       | ✗                   | ✗        | ✗        | ✗            | —           | —                 | **MISSING**                   |
| 15  | Ride completion   | `/:id/complete` ✓   | ✓        | ✗        | ✗            | ledger only | `COMPLETED`       | **PARTIAL**                   |
| 16  | Final fare        | client input ✗      | supplies | —        | —            | —           | —                 | **UNSAFE**                    |
| 17  | Payment           | ✗ non-cash          | —        | —        | ✗            | ✗           | `PENDING` forever | **BROKEN**                    |
| 18  | Receipt           | `/:id/receipt`      | —        | —        | ✗            | —           | —                 | **PARTIAL**                   |
| 19  | Rating            | ✗                   | ✗        | —        | ✗            | —           | —                 | **MISSING**                   |
| 20  | Ride history      | `/rides/history` ✓  | —        | —        | —            | —           | —                 | **PARTIAL**                   |

**8 of 20 steps missing outright. 3 unsafe. 7 partial. 2 fully working.**

---

## 26. Industry Comparison

Only publicly verifiable behaviour is attributed.

| Workflow           | Zaroorat                                   | Uber                                                                | Ola                              | Rapido                          | Gap & judgement                                                                                                                                 |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------- | -------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Ride PIN           | 6-digit per-ride OTP, **leaked to driver** | 4-digit per-trip, in rider app, 5 attempts                          | Fresh OTP per trip               | **Static PIN, same every ride** | **Needed.** The requested design matches Rapido's, whose stated rationale (SMS unreliability in tier-2/3) applies directly to Zaroorat's market |
| Dispatch           | none                                       | candidate pool → weighted score → sequential offer → timeout → next | comparable                       | comparable                      | **Needed — P0.** No product without it                                                                                                          |
| Offer delivery     | none                                       | push + socket simultaneously                                        | comparable                       | comparable                      | **Needed — P0.** Either channel alone drops offers                                                                                              |
| Live tracking      | none                                       | WebSocket stream, ~3–10s pings                                      | comparable                       | comparable                      | **Needed — P1.** Safety and support expectation, not a nicety                                                                                   |
| Cancellation fee   | recorded, never charged                    | charged past ~2 min post-accept; waived if driver ≥5 min late       | waived if driver >5 min past ETA | —                               | **Needed — P1.** A fee asserted but not collected is worse than no fee                                                                          |
| Wait-time fee      | none                                       | grace then per-minute                                               | —                                | —                               | **Deferrable.** Requires arrival detection first                                                                                                |
| Rating             | none                                       | both directions, per trip                                           | comparable                       | comparable                      | **Needed — P1.** Drivers have unused rating columns already                                                                                     |
| SOS / trip sharing | contacts only                              | in-app SOS, share trip                                              | comparable                       | comparable                      | **Needed — P1.** Contacts are inert without a trigger                                                                                           |
| Surge              | plumbed, always 1.0                        | dynamic                                                             | dynamic                          | —                               | **Deferrable — P3.** Needs demand data the platform has not collected                                                                           |
| Scheduled rides    | model only                                 | yes                                                                 | yes                              | —                               | **Deferrable — P3**                                                                                                                             |
| Carpool            | none                                       | yes                                                                 | yes                              | —                               | **Deferrable — P3.** Distinct matching problem                                                                                                  |

Sources: [Uber PIN verification](https://www.uber.com/en-US/blog/pin-verification-drivers) · [Uber cancellation fees](https://help.uber.com/en/riders/article/cancellation-fees-explained?nodeId=069853a3-f014-40a3-ad58-88ef56b1b27f) · [Uber wait time fees](https://help.uber.com/en/riders/article/wait-time-fees-and-refunds?nodeId=469f1786-1543-4c83-abbf-ddccb7826fc2) · [Ola cancellation fee](https://help.olacabs.com/support/dreport/208298769) · [Rapido static PIN analysis](https://medium.com/@uditjain_100/why-rapido-gives-you-the-same-otp-every-trip-and-why-uber-doesnt-25a530a8e5a3) · [Hello Interview — Uber design](https://www.hellointerview.com/learn/system-design/problem-breakdowns/uber) · [PubNub — GPS ping frequency](https://www.pubnub.com/blog/optimize-gps-ping/)

---

## 27. Recommended Implementation Order

Ordered by dependency, not by severity. Each phase is unblocked only by the ones above it.

### PHASE 0 — Stabilise the tree _(blocks everything)_

- Land or revert the in-flight files-storage refactor; add the missing migration for the six new `File` columns.
- Repair the OTP-delivery-to-worker refactor so `loginAs()` works; adapt the integration harness.
- Restore `npm run typecheck` and `npm run test:integration` to green.
- _Rationale: 130 failing integration tests means no phase below can be verified._

### PHASE 1 — Unblock driver supply

- Document approval endpoint (admin) writing `DriverDocument.verificationStatus`.
- Gate driver-level `VERIFIED` on the required document set.
- Vehicle registration + ownership, so `vehicleId` can be validated.
- _Rationale: with zero drivers able to go online, dispatch has nothing to dispatch to._

### PHASE 2 — Delivery channels

- Socket layer, subscribing to the **existing** `EventBus`, fanned out via Redis pub/sub. Do not build a second event system.
- FCM (+APNs) push with token lifecycle, reading the `user_devices.fcm_token` column that is already written.
- _Rationale: dispatch cannot deliver an offer without these. They are prerequisites, not follow-ups._

### PHASE 3 — Dispatch

- Orchestrator consuming `ride.requested`: `SEARCHING` → `GeoService.findNearbyDrivers` → Matching filter/rank → `DispatchService.offerToDriver` → deliver via Phase 2.
- Offer accept/reject endpoints; rewire `POST /rides/accept` to require a valid, unexpired offer.
- Driver busy check + availability writes on accept/complete/cancel.
- Timeout → next round; exhaustion → `NO_DRIVERS_FOUND`.
- _Rationale: needs Geo (built), Phase 1 supply, Phase 2 delivery._

### PHASE 4 — Ride integrity

- Server-derived trip distance/duration from the GPS stream; stop trusting client input.
- Permanent 4-digit customer PIN: durable attempt counter outside the transaction, route rate limit, **removal from every driver-facing response**, customer retrieval endpoint, migration off `RideOtp`.
- Idempotency on ride state-changing routes, reusing `IdempotencyRepository`.
- Active-ride partial unique indexes.
- Pre-accept cancellation endpoint.
- _Rationale: these harden a flow that must first exist end to end._

### PHASE 5 — Money correctness

- `PaymentService.chargeRide` contract called from completion; consume wallet holds.
- Wallet balance as a strict ledger projection, maintained inside `postTransactionGroup`.
- Move gateway calls outside DB transactions (payout, refund).
- Schedule `SettlementJob`; reconcile settlement against `DRIVER_PAYABLE`.
- Collapse `driver_wallets`; charge cancellation fees.
- Live gateway integration replacing the mock.
- _Rationale: correct money requires reliable completion (Phase 4) first._

### PHASE 6 — V1 completeness

- Rating (both directions), receipt at completion, history pagination, SOS + trip sharing, customer-visible driver location, heartbeat re-check under lock, no-show detection.

### PHASE 7 — Deferred

- Surge, promotions, referrals, scheduled rides, carpool, chat, support, admin console, analytics.

**Dependency violations to avoid:** dispatch before Geo has a caller and drivers can go online; live tracking before the socket layer; settlement before completion is reliable; PIN work before the tree builds.

---

## 28. Final Conclusion

**1. Are Auth, User, Driver, Ride, File and Payment production-ready?**
Auth: **yes**. Users: **yes** for its scope. Files: **yes** by design, currently mid-refactor and red. Drivers: **no** — cannot go online. Rides: **no** — no dispatch, unsafe fare, leaked PIN. Payments: **no** — sound ledger, but rides never pay it.

**2. What modules are actually missing?** Dispatch, Matching, Realtime/Socket, Push, Vehicle, Rating, Pricing (as a module), SOS/Safety, Support, Admin, Analytics, Promotions, Referral.

**3. What is incomplete inside existing modules?** Drivers: document approval, availability writes. Rides: dispatch wiring, idempotency, server-side distance, PIN, pre-accept cancel, receipt timing. Payments: ride charge, wallet projection, settlement scheduling, live gateway. Notifications: everything except OTP SMS. Geo: complete but unused.

**4. Complete customer workflow requires:** customer location intake, service-type listing, dispatch, offer delivery, live tracking, correct PIN, server-side fare, real payment, receipt at completion, rating, pagination.

**5. Complete driver workflow requires:** document approval, vehicle registration, offer receipt/accept/reject, navigation data, availability state, real earnings, settlement, payout.

**6. Live driver tracking requires:** socket layer + Redis pub/sub, authorization allowing a customer to see their assigned driver, and a defined ping cadence. Ingestion and storage already exist.

**7. Matching/dispatch requires:** an orchestrator over the existing Geo + `RideDispatch` + `LockStore` + `DispatchTimeoutJob` primitives, an eligibility filter, a ranking function, and Phase 2 delivery.

**8. Notifications require:** FCM/APNs SDK, token lifecycle over the existing `fcm_token` column, per-event templates, retry, invalid-token pruning.

**9. Pricing requires:** one source of truth (DB-backed `vehicle_types` rates, retiring the env rate cards), persisted quotes, integer minor units, and eventually surge.

**10. Payment settlement requires:** `chargeRide` at completion, wallet as a ledger projection, scheduled settlement reconciled against `DRIVER_PAYABLE`, gateway calls outside transactions, live gateway credentials.

**11. Ride completion requires:** server-derived distance/duration, payment capture, receipt in-transaction, driver availability release.

**12. Cancellation/recovery requires:** pre-accept cancellation, fee collection through Payments, no-show detection, heartbeat re-check under lock, and — for delivery recovery — the socket layer plus a resync contract.

**13. Safety requires:** SOS trigger and trip sharing. Emergency contacts already exist and are inert without them.

**14. What can be deferred:** surge, promotions, referrals, scheduled rides, carpool, chat, support, admin console, analytics, chargebacks, multi-currency, tolls.

**15. What must be implemented FIRST:** stabilise the working tree (Phase 0), then driver-document approval (Phase 1). Nothing downstream is verifiable or useful before those.

**16. What should NOT be implemented yet:** anything in Phase 7; any second event system alongside the outbox; any second spatial system alongside PostGIS+H3; any new Redis abstraction; surge before demand data exists; carpool before single-rider dispatch works.

### Final assessment

This is a well-built foundation with a missing middle. The engineering quality where code exists is high — transaction discipline, the outbox, the ledger invariant, BOLA coverage and fail-closed Redis are all better than typical. The gap is not quality; it is that the three pieces connecting a customer's request to a driver's phone were never written, and two upstream blockers make even the existing paths unreachable in production.

**A passing test suite has never been evidence of readiness here, and right now the suite is not passing either.** The 683 green unit tests and the 395 green integration tests do not exercise the workflow this audit was asked to prove, because that workflow does not exist to exercise.

**NOT PRODUCTION READY.** 12 P0 findings.
