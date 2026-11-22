# Zaroorat Mobility

# Driver Supply Production Audit — Phase 1

**Date:** 2026-08-16 · **Branch:** `feature/auth` · **Committed base:** `290b3c6` · Working tree dirty (Files module under active refactor; the Driver domain is stable)

**Gate status at audit time:** `npm run typecheck` PASS · `npm run lint` PASS · `npm run prisma:validate` PASS

**Evidence classes.** Every claim is tagged:

- **[ZAROORAT]** — proven from this repository, with file and line.
- **[INDUSTRY]** — publicly documented behaviour of other platforms, cited.
- **[INFERENCE]** — my reasoning from the two above.

**Nothing was modified.** No code, migrations, schema, or tests were changed.

---

## 1. Executive Summary

The question this phase asks is whether a driver can travel the chain:

```
REGISTRATION → PROFILE → DOCUMENTS → DOCUMENT VERIFICATION → VEHICLE
→ VEHICLE APPROVAL → ELIGIBILITY → ONLINE → LOCATION → AVAILABLE FOR DISPATCH
```

**They cannot. The chain breaks at step 4 and never recovers.**

**[ZAROORAT]** Three findings, each independently fatal:

1. **No code can mark a driver document `VERIFIED`.** `DriverDocumentRepository.updateVerificationStatus` exists and is capable of it, but has exactly one caller — `DocExpirationJob`, which writes `REJECTED`. `upsertDocument` hard-writes `'PENDING'` on both create and update. `StatusService.setOnline` requires a `DRIVING_LICENSE` with `verificationStatus === 'VERIFIED'`. That predicate can never be true. **Driver supply is structurally zero.**

2. **Vehicle functionality does not exist.** `src/modules/vehicles/index.ts` is `export {};` (11 bytes). The Prisma schema defines nine vehicle models — `Vehicle`, `VehicleType`, `VehicleDocument`, `VehicleImage`, `VehicleInspection`, `VehicleAssignment`, `MaintenanceLog`, `FuelLog`, `InsuranceClaim` — and **no production code reads or writes any of them**. The only writers in the entire repository are two test fixtures.

3. **`ON_TRIP` and `BUSY` are never written.** Grep across `src/` returns exactly one reference: a _read_ in `setOffline` (`status.service.ts:92`) guarding against a state nothing can produce. Three of the five `DriverStatus` values are unreachable.

**The Geo integration is half-wired**, which is a material correction to the previous audit. The **write** side is live — `LocationService` calls `geoService.recordDriverPosition` (`location.service.ts:67`) and `StatusService.setOffline` calls `forgetDriverPosition` (`status.service.ts:126`). The **read** side is not: `findNearbyDrivers` has **zero production callers**; every reference outside `src/modules/geo/` is in `tests/integration/geo-nearby.test.ts`.

**A driver who cannot go online can still be indexed for discovery.** `POST /drivers/location` carries no `requireOperableDriver` guard and `LocationService` performs no status check, so a `PENDING`, `REJECTED` or `SUSPENDED` driver can push GPS and land in the Redis geo index.

**Verdict:** Registration, profile, document _submission_, online/offline mechanics, heartbeat, location ingestion and geo indexing are real and mostly well built. Document _approval_, vehicle, and availability state are absent. The driver supply chain is **not production-viable**.

---

## 2. Driver Registration

**[ZAROORAT]** `GET /api/v1/drivers/me` → `DriverOnboardingController.getMe` → `OnboardingService.createOrGetDriver(callerId(req))`.

| Concern                    | Finding                                                                                                                | Evidence                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Driver creation            | **VERIFIED** — auto-creates on first `GET /drivers/me`                                                                 | `onboarding.service.ts:26-43`        |
| User → Driver relationship | **VERIFIED** — `Driver.userId` is `@unique`, FK to `User`                                                              | `driver.prisma:5`                    |
| Duplicate prevention       | **VERIFIED** — `findByUserId` short-circuits; `@unique` is the backstop                                                | `onboarding.service.ts:27`           |
| Account ownership          | **VERIFIED** — `userId` from JWT via `callerId`; never from the body                                                   | `driver-onboarding.controller.ts:19` |
| Initial status             | **VERIFIED** — `verificationStatus: 'PENDING'`, `isAvailable: false`, `isSuspended: false`                             | `driver.repository.ts:22-27`         |
| Driver code                | **VERIFIED** — server-generated, `@unique`                                                                             | `driver-code.util.ts`                |
| Authorization              | **PARTIAL** — any authenticated user becomes a driver by calling `GET /drivers/me`. No role check, no application step | `driver.routes.ts:12`                |
| Onboarding status          | **PARTIAL** — no dedicated field; inferred from `verificationStatus`                                                   | —                                    |
| Soft delete                | **VERIFIED** — `deletedAt` present and honoured by `isOperableDriver`                                                  | `driver.prisma:24`                   |

**[INFERENCE]** Auto-provisioning a driver record on a GET is unusual but harmless here: the record starts `PENDING` and unlocks nothing. The real gate is verification. It does mean `drivers` accumulates a row for every curious customer.

---

## 3. Documents / KYC

**[ZAROORAT]** `POST /api/v1/drivers/:driverId/documents` → `submitDocument`.

### Schema supports the full Indian KYC set

`DriverDocumentType` = `DRIVING_LICENSE`, `RC`, `INSURANCE`, `AADHAAR`, `PAN`, `PUC`, `POLICE_VERIFICATION`, `PROFILE_PHOTO` (`enums.prisma:37-46`). `DriverDocument` carries `documentNumber`, `issuedAt`, `expiresAt`, `verificationStatus`, `verifiedAt`, `verifiedBy`, `rejectionReason`.

### Every writer of a document status — the complete set

| Value          | Writer                                                                                                                   | Evidence                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `PENDING`      | `upsertDocument` — hard-coded on **both** create and update                                                              | `driver-document.repository.ts:36,49`                                                                 |
| `REJECTED`     | `DocExpirationJob` only                                                                                                  | `doc-expiration.job.ts:28`                                                                            |
| **`VERIFIED`** | **NOBODY**                                                                                                               | `grep` for callers of `updateVerificationStatus` on the document repo returns one hit: the expiry job |
| `EXPIRED`      | **Not a value** — `VerificationStatus` is `PENDING\|VERIFIED\|REJECTED` (`enums.prisma:15-19`); expiry writes `REJECTED` |

**Who can verify a document? [ZAROORAT] No one.** There is no route, controller, service method, or admin path that sets a document to `VERIFIED`.

### Consequences that compound

- **`DocExpirationJob` is dead code.** `findExpiredDocuments` filters `verificationStatus: 'VERIFIED'` (`driver-document.repository.ts:87`). Since nothing is ever `VERIFIED`, the query can never return a row.
- **Resubmission silently resets.** `upsertDocument` overwrites the existing row and forces `PENDING` — correct behaviour, but with no approval path it is a no-op loop.
- **No rejection workflow.** `rejectionReason` is writable only by the expiry job, with the fixed string `'Document expired'`.
- **Documents bypass the Files module.** `fileUrl: z.string().url()` accepts any URL (`driver.schemas.ts`). No `FileReference`, no ownership check, no MIME validation, no malware scan, no storage-key validation. The test fixture uses `https://example.invalid/licence.jpg`.

**[INDUSTRY]** Ola requires a commercial DL (yellow badge), PAN, Aadhaar, address proof, references, bank details, plus vehicle RC, permit and insurance. Uber additionally requires an RTO fitness certificate and PUC. Onboarding typically runs 3–8 weeks, which is an approval-workflow duration, not an upload duration. ([Ola driver registration](https://blogs.workindia.in/ola-driver-registration/), [Uber India vehicle requirements](https://uber.com/in/en/drive/bangalore/vehicle-requirements), [Cab driver onboarding in India](https://vahanbazaar.in/tips/cab-driver-platform-onboarding-uber-ola-india-vahanbazaar))

**[INFERENCE]** The schema anticipated this workflow precisely — `verifiedBy`, `verifiedAt`, `rejectionReason` all exist. Only the operator-facing half was never built. The gap is one endpoint plus an authorization rule, not a redesign.

---

## 4. Vehicle

**[ZAROORAT] Vehicle functionality does not exist.**

`src/modules/vehicles/` contains `README.md` and `index.ts` (`export {};`, 11 bytes). No repository, service, controller, route, or schema file.

### Schema present and entirely unused

`Vehicle` (registration number `@unique`, VIN `@unique`, make, model, year, colour, fuel type, seating capacity, `vehicleTypeId`, owner name/phone, `currentDriverId`, `isActive`), plus `VehicleType`, `VehicleDocument`, `VehicleImage`, `VehicleInspection`, `VehicleAssignment` (driver↔vehicle with `assignedAt`/`releasedAt`/`status`), `MaintenanceLog`, `FuelLog`, `InsuranceClaim`.

`Driver.currentVehicleId` exists (`driver.prisma:8`) and **is never written**.

### The only writers in the repository

```
tests/integration/helpers/fixtures.ts:45   db().client.vehicleType.create(...)
tests/integration/helpers/fixtures.ts:52   db().client.vehicle.create(...)
tests/integration/user-departure.test.ts:63,66
```

| Capability                | Status                                                         |
| ------------------------- | -------------------------------------------------------------- |
| Vehicle creation          | **ABSENT**                                                     |
| Owner/driver relationship | Schema only (`VehicleAssignment`, `currentDriverId`) — no code |
| Registration number       | Schema only; `@unique` present                                 |
| Vehicle type              | Model exists; **not seeded**, no listing API                   |
| Verification              | `VehicleDocument` + `VehicleInspection` exist; no code         |
| Active vehicle            | `isActive` column; never written                               |
| Multiple vehicles         | `VehicleAssignment` supports it; no code                       |
| Removal/deactivation      | **ABSENT**                                                     |

### The concrete danger this creates

**[ZAROORAT]** `POST /api/v1/rides/accept` takes `vehicleId` from the request body (`ride.schemas.ts`, `acceptRideRequestSchema`) and `LifecycleService.acceptRideRequest` writes it onto the ride with **no validation** — no check that the vehicle exists, belongs to the accepting driver, is active, or matches `request.vehicleTypeId` (`lifecycle.service.ts:106-135`).

**[INFERENCE]** Until a Vehicle module exists, service type (Cab/Auto/Bike) is unenforceable end to end: a customer requests a `vehicleTypeId`, and the driver attaches an arbitrary `vehicleId` at accept. Nothing reconciles the two.

---

## 5. Verification

Two independent verification tracks exist. Only one is reachable.

| Track              | Route                                                      | Reachable                | Evidence                                                 |
| ------------------ | ---------------------------------------------------------- | ------------------------ | -------------------------------------------------------- |
| **Driver-level**   | `POST /drivers/:id/verify`, `authorize({roles:['admin']})` | **YES**                  | `driver.routes.ts:20-24`, `onboarding.service.ts:79-115` |
| **Document-level** | —                                                          | **NO — no route exists** | §3                                                       |
| **Vehicle-level**  | —                                                          | **NO — no code exists**  | §4                                                       |

**[ZAROORAT]** `reviewDriverVerification` locks the driver row, sets `VERIFIED` or `REJECTED`, records `approvedBy`/`approvedAt`, emits `driver.verified` to the outbox in the same transaction. Mechanically sound.

**Its flaw:** it checks **no documents at all**. An admin can mark a driver `VERIFIED` with zero documents submitted. The driver-level status is an unbacked assertion.

**[INFERENCE]** This produces a contradiction the system cannot resolve: `isOperableDriver` (used by the ride routes) trusts driver-level `VERIFIED` and ignores documents, while `setOnline` demands a verified licence. So a driver can be authorized to **accept, arrive, start and complete rides** while being unable to **go online** — the operational gate and the ride gate disagree.

---

## 6. Driver Eligibility

### What the code actually requires

**[ZAROORAT]** Two different, inconsistent gates:

**Gate A — `requireOperableDriver`** (`driver-access.repository.ts:8-14`), applied to `/drivers/status/online` and all four ride-state routes:

```sql
driver WHERE userId = ? AND verificationStatus = 'VERIFIED'
              AND isSuspended = false AND deletedAt IS NULL
```

**Gate B — `StatusService.setOnline`** (`status.service.ts:31-55`), inside a transaction with `SELECT … FOR UPDATE`:

1. driver exists
2. `verificationStatus === 'VERIFIED'`
3. `isSuspended === false`
4. **a `DRIVING_LICENSE` document with `verificationStatus === 'VERIFIED'`** ← unsatisfiable

### Eligibility matrix — required vs implemented

| Condition                     | Required for production | Implemented                                      | Reachable         |
| ----------------------------- | ----------------------- | ------------------------------------------------ | ----------------- |
| Driver record exists          | ✔                       | ✔                                                | ✔                 |
| Account ACTIVE (User)         | ✔                       | ✖ — user status never checked in the driver gate | —                 |
| Driver `VERIFIED`             | ✔                       | ✔                                                | ✔ (admin)         |
| Not suspended                 | ✔                       | ✔                                                | ✔                 |
| Not soft-deleted              | ✔                       | ✔ (Gate A only)                                  | ✔                 |
| Licence document verified     | ✔                       | ✔ (Gate B only)                                  | **✖ unreachable** |
| RC / insurance / PUC verified | ✔                       | ✖                                                | ✖                 |
| Licence not expired           | ✔                       | ✖ — `expiresAt` never checked at `setOnline`     | ✖                 |
| Vehicle assigned              | ✔                       | ✖                                                | ✖                 |
| Vehicle verified              | ✔                       | ✖                                                | ✖                 |
| Vehicle type matches service  | ✔                       | ✖                                                | ✖                 |
| No conflicting active ride    | ✔                       | ✖ — `findActiveByDriver` exists, never called    | ✖                 |

**[ZAROORAT] Net result: no driver can satisfy the eligibility gate.** Condition 4 of Gate B is unsatisfiable by any code path, so `POST /drivers/status/online` always throws `DriverNotVerifiedError('Driver does not have a verified Driving License')`.

---

## 7. Online / Offline

### `POST /api/v1/drivers/status/online`

**[ZAROORAT]** Route: `authorize({ requireOperableDriver: true })` → `DriverStatusController.setOnline` → `actingDriverId` (JWT-derived) → `StatusService.setOnline`.

| Concern                     | Finding                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Authorization               | **VERIFIED** — Gate A at the route, driver id from JWT, path/body ids ignored                                  |
| Eligibility check           | **VERIFIED but unsatisfiable** (§6)                                                                            |
| Transaction                 | **VERIFIED** — whole operation in `txManager.execute`                                                          |
| Row lock                    | **VERIFIED** — `driverRepo.lockForUpdate` (`SELECT … FOR UPDATE`)                                              |
| Shift creation              | **VERIFIED** — `startShift` returns the existing open shift if present, so no duplicate shift                  |
| Duplicate online            | **VERIFIED (idempotent)** — `updateStatus` is an upsert; a second call re-writes `ONLINE` and reuses the shift |
| Idempotency-Key             | **ABSENT** — not read; the upsert makes it unnecessary for correctness                                         |
| **Active-trip restriction** | **ABSENT** — no check for an in-flight ride                                                                    |
| Outbox event                | **VERIFIED** — `driver.status_changed` in the same transaction                                                 |
| PostgreSQL state            | **VERIFIED** — `drivers.isAvailable = true` + `driver_online_status.status = 'ONLINE'`                         |
| Redis state                 | **NOT WRITTEN HERE** — the geo index is written by the _location_ path, not by going online                    |
| Recovery after restart      | **VERIFIED** — status is in Postgres, survives restart                                                         |

### `POST /api/v1/drivers/status/offline`

**[ZAROORAT]** **No route guard at all** beyond global authentication (`driver.routes.ts:31`). Any authenticated user with a driver row may call it. Low impact — going offline is not a privilege — but inconsistent with `/status/online`.

Transactional, locks the driver row, closes the active shift, sets `isAvailable = false`, writes `OFFLINE`, emits the event, then calls `geoService.forgetDriverPosition` **after commit** (`status.service.ts:126`) — correct ordering.

**Its guard is dead code:** `if (currentStatus?.status === 'ON_TRIP') throw new DriverOnTripError()` (`status.service.ts:92`). Nothing ever writes `ON_TRIP` (§10), so this can never fire.

### Why a driver cannot currently become ONLINE

**[ZAROORAT]** Exactly one reason, provable by grep: `setOnline` demands a `DRIVING_LICENSE` document at `verificationStatus === 'VERIFIED'`; the only two writers of that column write `'PENDING'` and `'REJECTED'`. The integration suite hides this because `makeDriver()` inserts the verified document straight into the database (`tests/integration/helpers/fixtures.ts:31-38`).

---

## 8. Driver Location

**[ZAROORAT]** `POST /api/v1/drivers/location` → `DriverLocationController.updateLocation` → `LocationService.updateLocation`.

| Concern                 | Finding                                                                                     | Evidence                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Driver identity         | **VERIFIED** — `actingDriverId` from JWT; `body.driverId` impossible                        | `driver-location.controller.ts:15`          |
| Coordinate validation   | **VERIFIED** — Geo's `latitudeSchema`/`longitudeSchema`                                     | `driver.schemas.ts`                         |
| Mock-location screening | **VERIFIED** — rejected when `driverConfig.rejectMockLocation`                              | `location.service.ts:27-30`                 |
| Plausibility            | **VERIFIED** — out-of-range, stale, and impossible-speed rejected against the previous fix  | `location-plausibility.ts`                  |
| Timestamp / freshness   | **VERIFIED** — `recorded_at` set server-side by the repository (`now()`), not by the client | `driver-location.repository.ts`             |
| PostGIS persistence     | **VERIFIED** — `geography(Point,4326)` upsert, one row per driver                           | `driver-location.repository.ts:33`          |
| GiST index              | **VERIFIED** — `ix_driver_locations_location`, migration `20260815000000`                   | migration + `geo-nearby.test.ts` asserts it |
| Redis geo index         | **VERIFIED** — `geoService.recordDriverPosition` mirrors it                                 | `location.service.ts:67`                    |
| Stale handling          | **VERIFIED** — Redis TTL + `recorded_at >= freshAfter` in the PostGIS query                 | `postgis.provider.ts`                       |
| Rate limiting           | **VERIFIED** — `rateLimits.driverLocation`                                                  | `driver.routes.ts:42`                       |
| **Route authorization** | **MISSING** — no `requireOperableDriver`; only a rate limit                                 | `driver.routes.ts:40-44`                    |
| **ONLINE requirement**  | **MISSING** — no status check anywhere in the path                                          | `location.service.ts:28-77`                 |
| Heartbeat side-effect   | `updateHeartbeat` upserts with `status: 'OFFLINE'` on create                                | `driver-status.repository.ts:66`            |

### Does an ONLINE driver become geographically discoverable?

**[ZAROORAT] Partially — and so does an offline, unverified, or suspended one.**

The driver is written into both PostGIS and the Redis H3 index. But discovery requires `GeoService.findNearbyDrivers`, which **no production code calls** (§9). So the index is populated and never queried.

**[INFERENCE]** The missing status gate is the more serious half. Because indexing happens on the location path rather than the online path, membership of the geo index reflects "recently sent GPS", not "online and available". `forgetDriverPosition` fires only on explicit `setOffline` — a driver who simply stops (app killed, heartbeat timeout) is removed by the timeout job calling `setOffline`, but a `PENDING` or `SUSPENDED` driver who never went online is never removed because they were never online. Once dispatch exists, filtering must therefore live in Matching and cannot rely on geo membership implying availability.

---

## 9. Geo Integration

**[ZAROORAT] Half-integrated.** This is a correction to the previous audit, which recorded Geo as having no callers at all.

| Direction                                             | Caller                                                                                                       | Status             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------ |
| **Write** — index a position                          | `LocationService.updateLocation` → `recordDriverPosition` (`location.service.ts:67`)                         | **INTEGRATED**     |
| **Write** — remove a position                         | `StatusService.setOffline` → `forgetDriverPosition` (`status.service.ts:126`)                                | **INTEGRATED**     |
| **Read** — `findNearbyDrivers`                        | **none in `src/`** — every hit is `tests/integration/geo-nearby.test.ts`                                     | **NOT INTEGRATED** |
| **Read** — `calculateDistance` / `validateCoordinate` | schemas import `latitudeSchema`/`longitudeSchema`; `rides/utils/distance.util.ts` delegates to `haversineKm` | **INTEGRATED**     |

### The pipeline the phase brief asks about

```
driver online   → writes Postgres + driver_online_status      ✔
driver location → PostGIS + Redis H3 index                    ✔
geo index       → populated                                    ✔
nearby query    → findNearbyDrivers                            ✖ NO CALLER
```

**[ZAROORAT]** What `findNearbyDrivers` does provide, verified by 33 passing integration tests: `ST_DWithin` on the requested radius against the GiST index, `ST_Distance` ordering, freshness cutoff, H3 candidate narrowing, a bounded PostGIS fallback on Redis error, and a typed three-outcome result (`ok` / `degraded` / `no-live-candidates`).

**What it deliberately does not provide** — by design, since Geo must not depend on Drivers or Rides: service type, vehicle type, online status, suspension, or active-ride filtering. All of that belongs to Matching, **which does not exist** (`src/modules/matching/index.ts` = `export {};`).

**[INFERENCE]** Per the brief's own rule — _"a built Geo module with zero callers is NOT considered integrated"_ — Geo is **integrated for ingestion and not integrated for discovery**. The remaining work is not inside Geo; it is the eligibility filter that has to sit between Geo's geographic answer and a dispatch offer.

---

## 10. Availability State Machine

### Definitions as the code actually uses them

**[ZAROORAT]** Availability is represented **twice**, in two tables:

| Concept                       | Representation         | Written by                                                                                     |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `drivers.isAvailable`         | boolean                | `setOnline` (true), `setOffline` (false), `setSuspended` (false)                               |
| `driver_online_status.status` | `DriverStatus` enum    | `setOnline` (`ONLINE`), `setOffline` (`OFFLINE`), `updateHeartbeat` (`OFFLINE` on create only) |
| `drivers.isSuspended`         | boolean                | `setSuspended`                                                                                 |
| `drivers.verificationStatus`  | enum incl. `SUSPENDED` | never written as `SUSPENDED`                                                                   |

`DriverStatus` = `ONLINE`, `OFFLINE`, `BUSY`, `ON_TRIP`, `BREAK`.

**[ZAROORAT] Only `ONLINE` and `OFFLINE` are ever written.** `grep -rn "'ON_TRIP'\|'BUSY'" src/` returns exactly one line — a _read_ at `status.service.ts:92`. `BREAK` appears only in `findStaleDrivers`' filter. **`BUSY`, `ON_TRIP` and `BREAK` are unreachable states.**

There is no `BLOCKED` state; `isSuspended` plus `verificationStatus = REJECTED` are the closest equivalents.

### Transition table

| Current                     | Action                      | Next                                         | Actor  | Validation                                  | Reachable                  |
| --------------------------- | --------------------------- | -------------------------------------------- | ------ | ------------------------------------------- | -------------------------- |
| —                           | `GET /drivers/me`           | driver `PENDING`                             | Self   | JWT                                         | ✔                          |
| `PENDING`                   | `POST /:driverId/documents` | `DOCUMENT_REVIEW`                            | Self   | driver exists                               | ✔                          |
| `PENDING`/`DOCUMENT_REVIEW` | `POST /:id/verify`          | `VERIFIED` / `REJECTED`                      | Admin  | role only — **documents not checked**       | ✔                          |
| any                         | `POST /:id/suspend`         | `isSuspended = true`, forced offline         | Admin  | role                                        | ✔ (deadlocks — §12)        |
| `OFFLINE`                   | `POST /status/online`       | `ONLINE`, `isAvailable = true`, shift opened | Self   | Gate A + Gate B                             | **✖ Gate B unsatisfiable** |
| `ONLINE`                    | `POST /status/online`       | `ONLINE` (idempotent upsert, same shift)     | Self   | same                                        | ✖                          |
| `ONLINE`                    | `POST /status/offline`      | `OFFLINE`, shift closed, geo entry cleared   | Self   | **no route guard**; `ON_TRIP` check is dead | ✔                          |
| `ONLINE`                    | heartbeat timeout           | `OFFLINE`                                    | System | stale threshold; **no re-check under lock** | ✔                          |
| `ONLINE`                    | accept a ride               | _should be_ `ON_TRIP`                        | Driver | **never written**                           | ✖                          |
| `ON_TRIP`                   | complete a ride             | _should be_ `ONLINE`                         | Driver | **never written**                           | ✖                          |

### Bypasses found

1. **Availability is never updated by the ride lifecycle.** `acceptRideRequest` writes neither `isAvailable` nor `driver_online_status` (`lifecycle.service.ts:106-160`). A driver on a trip still reads as `ONLINE` and `isAvailable = true`.
2. **`isAvailable` and `status` can disagree.** They are written together inside `setOnline`/`setOffline`, so they cannot drift today — but they encode the same fact twice, and any future writer of one without the other silently desynchronises availability.
3. **Location updates require no status.** An `OFFLINE` driver refreshes their geo index entry indefinitely (§8).
4. **Suspension does not revoke an in-flight session cleanly** — see §12.

---

## 11. Dispatch Compatibility

Dispatch is out of scope to build. This is only what the Driver module can hand it today.

| Dispatch needs     | Available   | Source                                                                         |
| ------------------ | ----------- | ------------------------------------------------------------------------------ |
| Driver ID          | **YES**     | `drivers.id`                                                                   |
| Online status      | **YES**     | `driver_online_status.status` — but only `ONLINE`/`OFFLINE` exist              |
| Availability       | **PARTIAL** | `drivers.isAvailable` — never reflects an active ride                          |
| Location           | **YES**     | PostGIS + Redis/H3, fresh, indexed                                             |
| **Service type**   | **NO**      | requires Vehicle → `vehicleTypeId`; no code                                    |
| **Vehicle type**   | **NO**      | `Driver.currentVehicleId` never written                                        |
| Eligibility        | **PARTIAL** | verification + suspension yes; documents/vehicle no                            |
| **Current ride**   | **NO**      | `rideRepo.findActiveByDriver` exists and is never called; no driver-side field |
| **Capacity**       | **NO**      | `Vehicle.seatingCapacity` in schema, unused                                    |
| Suspension / block | **YES**     | `isSuspended`, `deletedAt`                                                     |
| Nearby query       | **PARTIAL** | `findNearbyDrivers` works; no caller; returns geography only                   |

**[INFERENCE]** Dispatch cannot be built on this without first adding: (a) an active-ride/busy signal on the driver, (b) vehicle assignment so service type is knowable, and (c) an eligibility filter between Geo's geographic answer and an offer. Geo itself is ready.

---

## 12. Security

### Verified controls **[ZAROORAT]**

| Control                                             | Result                                                                                                                                              | Evidence                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Driver cannot modify another driver                 | **PASS** — `actingDriverId` derives from JWT and the `:driverId` path parameter is **ignored entirely** on profile and document routes              | `driver-identity.ts:6-14`; `authorization-bola.test.ts` |
| Driver cannot read another driver's wallet/location | **PASS** — `authorizedDriverId` allows self, or `admin`/`support`                                                                                   | `driver-identity.ts:16-28`                              |
| Driver cannot approve their own verification        | **PASS** — `authorize({roles:['admin']})`; tested explicitly                                                                                        | `driver.routes.ts:20-24`; BOLA test line 453            |
| Driver cannot spoof another driver's location       | **PASS** — driver id from JWT, `body.driverId` unused; tested                                                                                       | BOLA test line 301                                      |
| Driver cannot go online while suspended             | **PASS** — Gate A and Gate B both check `isSuspended`; tested                                                                                       | `auth-driver-gate.test.ts:103`                          |
| Driver cannot go online unverified                  | **PASS** (over-strict — nobody can)                                                                                                                 | `auth-driver-gate.test.ts:94`                           |
| GPS spoofing                                        | **PARTIAL, correctly scoped** — `isMockLocation` treated as a signal, backed by a real server-side plausibility check; not mistaken for attestation | `location-plausibility.ts`                              |
| Driver cannot become available twice                | **PASS** — upsert + shift reuse make it idempotent                                                                                                  | `driver-shift.repository.ts:22`                         |

### Weaknesses

| Finding                                                                           | Severity | Evidence                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Driver cannot fake verification, but an admin can approve with zero documents** | **P1**   | `reviewDriverVerification` checks no documents                                                                                                                                                                                                                                                                                                                        |
| **Driver can hold unlimited active rides**                                        | **P0**   | `acceptRideRequest` never calls `findActiveByDriver`; no busy write                                                                                                                                                                                                                                                                                                   |
| **`POST /drivers/location` has no operability guard**                             | **P1**   | `driver.routes.ts:40-44` — unverified/suspended drivers can populate the geo index                                                                                                                                                                                                                                                                                    |
| **`POST /drivers/status/offline` and `/heartbeat` have no guard**                 | **P2**   | `driver.routes.ts:31-32`                                                                                                                                                                                                                                                                                                                                              |
| **Documents accept an arbitrary `fileUrl`**                                       | **P1**   | Cross-driver reference, unscanned object, or attacker-controlled URL an admin reviewer then opens (SSRF/phishing)                                                                                                                                                                                                                                                     |
| **`setSuspended` self-deadlocks**                                                 | **P1**   | `status.service.ts:134-148` opens a transaction, locks the driver row, then calls `setOffline`, which opens a **second** transaction (`TransactionManager.execute` never joins an ambient one — `TransactionManager.ts:34`) and locks the same row. Blocks until the Prisma transaction timeout, then rolls back — **the emergency suspension control does not work** |
| **`vehicleId` unvalidated at ride accept**                                        | **P1**   | §4                                                                                                                                                                                                                                                                                                                                                                    |

---

## 13. Failure Recovery

| Scenario                     | Behaviour                                                                                                                      | Assessment                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rejected document            | Status set only by the expiry job; no resubmission signal                                                                      | **PARTIAL**                                                                                                                                                              |
| Expired document             | `DocExpirationJob` scans `VERIFIED` + past `expiresAt` → **can never match**                                                   | **DEAD CODE**                                                                                                                                                            |
| Missing document             | `setOnline` refuses (licence only)                                                                                             | **PARTIAL** — RC/insurance/PUC unchecked                                                                                                                                 |
| Expired licence              | `expiresAt` **not checked** at `setOnline`                                                                                     | **GAP**                                                                                                                                                                  |
| Suspended driver             | Both gates refuse                                                                                                              | **PASS**                                                                                                                                                                 |
| Blocked driver               | No `BLOCKED` concept; `deletedAt` + `isSuspended` cover it                                                                     | **PARTIAL**                                                                                                                                                              |
| Missing / unverified vehicle | Not checked anywhere                                                                                                           | **GAP**                                                                                                                                                                  |
| Stale GPS                    | Redis TTL + `recorded_at >= freshAfter`                                                                                        | **PASS**                                                                                                                                                                 |
| Redis unavailable            | Location write still commits to PostGIS; Geo logs and continues; nearby search returns `degraded` with a bounded PostGIS query | **PASS**                                                                                                                                                                 |
| Database unavailable         | Transaction rolls back; API reports failure; no false success                                                                  | **PASS**                                                                                                                                                                 |
| Duplicate online request     | Idempotent upsert; shift reused                                                                                                | **PASS**                                                                                                                                                                 |
| Driver app killed            | Heartbeat stops → `HeartbeatTimeoutJob` → `setOffline` after threshold                                                         | **PARTIAL** — worker does not re-read `heartbeatAt` under the lock, so a driver who just returned can be forced offline on stale data (`heartbeat-timeout.job.ts:26-38`) |
| Driver app reconnect         | State in Postgres; `GET /drivers/me` resyncs                                                                                   | **PASS**                                                                                                                                                                 |
| Driver returns online        | Works — subject to the eligibility block                                                                                       | **PASS (blocked)**                                                                                                                                                       |

---

## 14. Tests

### Existing

| Layer       | File                                                        | Count                                                         |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Unit        | `tests/unit/drivers/location-plausibility.test.ts`          | 8                                                             |
| Unit        | `tests/unit/drivers/mock-location.test.ts`                  | 1                                                             |
| Unit        | `tests/unit/drivers/verification-gate.test.ts`              | 2                                                             |
| Integration | `auth-driver-gate.test.ts`                                  | 5 (verification/suspension gate)                              |
| Integration | `authorization-bola.test.ts`                                | 15 driver-related (ownership, self-service, admin separation) |
| Integration | `geo-nearby.test.ts`                                        | 33 (geo, including driver-position indexing)                  |
| Integration | `earnings-pipeline.test.ts`, `payout-authorization.test.ts` | driver money paths                                            |

**Total driver-specific unit tests: 11.**

### Missing

- **Document approval** — no test, because no code (the fixture writes `VERIFIED` directly, which is precisely what conceals the gap).
- **Vehicle** — nothing.
- **Online/offline lifecycle over HTTP** — the full `setOnline` path is exercised only through the BOLA suite's single "lets a verified, unsuspended driver go online".
- **Concurrency** — no test for: two simultaneous `setOnline`, online-vs-suspend, heartbeat-vs-timeout, or duplicate shift creation.
- **`setSuspended`** — no test at all, which is why the self-deadlock (§12) is undetected.
- **Location-without-online** — no test asserting an offline driver should not be indexed.
- **Expired licence at `setOnline`** — no test.
- **Geo discovery from the driver side** — no test that an online driver is returned by `findNearbyDrivers` through the real ingestion path.

---

## 15. Production Gap Matrix

| Capability                | Exists  | Working | Tested  | Production-ready | Gap                                                           |
| ------------------------- | ------- | ------- | ------- | ---------------- | ------------------------------------------------------------- |
| Driver registration       | ✔       | ✔       | ✔       | **Yes**          | Auto-provision on GET is loose                                |
| Driver profile            | ✔       | ✔       | Partial | **Yes**          | —                                                             |
| Document submission       | ✔       | ✔       | Partial | **No**           | Bypasses Files; arbitrary URL                                 |
| **Document verification** | ✖       | ✖       | ✖       | **No**           | **No approval path exists**                                   |
| Document expiry           | ✔       | ✖       | ✖       | **No**           | Unreachable — filters on a status never written               |
| KYC completeness          | Schema  | ✖       | ✖       | **No**           | Only licence checked; RC/insurance/PUC ignored                |
| **Vehicle**               | Schema  | ✖       | ✖       | **No**           | **No code whatsoever**                                        |
| Vehicle verification      | Schema  | ✖       | ✖       | **No**           | —                                                             |
| Driver eligibility        | ✔       | ✖       | Partial | **No**           | Unsatisfiable; two inconsistent gates                         |
| Online / offline          | ✔       | ✖       | Partial | **No**           | Blocked by eligibility; offline unguarded                     |
| Heartbeat                 | ✔       | ✔       | ✖       | **Partial**      | Timeout race                                                  |
| Location ingestion        | ✔       | ✔       | ✔       | **Partial**      | No operability guard, no online requirement                   |
| Geo indexing (write)      | ✔       | ✔       | ✔       | **Yes**          | Indexes ineligible drivers                                    |
| Geo discovery (read)      | ✔       | ✔       | ✔       | **No**           | **Zero production callers**                                   |
| Availability state        | ✔       | ✖       | ✖       | **No**           | `BUSY`/`ON_TRIP` unreachable; ride lifecycle never updates it |
| Suspension                | ✔       | ✖       | ✖       | **No**           | Self-deadlocks                                                |
| Security / BOLA           | ✔       | ✔       | ✔       | **Yes**          | Strongest area                                                |
| Dispatch compatibility    | Partial | ✖       | ✖       | **No**           | No service type, no busy signal                               |

---

## 16. P0 Findings — driver supply is impossible

| #        | Finding                                                                                                                                                            | Evidence                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **P0-1** | **No code path can mark a driver document `VERIFIED`.** `setOnline` requires one; the only writers write `PENDING` and `REJECTED`. **Zero drivers can go online.** | `driver-document.repository.ts:36,49,87`; `doc-expiration.job.ts:28`; `status.service.ts:46-52` |
| **P0-2** | **Vehicle functionality does not exist.** No service type, no vehicle assignment, no capacity — dispatch cannot select a driver for a ride class.                  | `src/modules/vehicles/index.ts` = `export {};`; grep shows only test fixtures touch the tables  |
| **P0-3** | **Geo discovery has no caller.** Positions are indexed and never queried; no driver is ever discoverable.                                                          | `findNearbyDrivers` referenced only under `src/modules/geo/` and `tests/`                       |
| **P0-4** | **A driver can hold unlimited concurrent rides.** No busy check at accept; availability never written.                                                             | `lifecycle.service.ts:106-160`; `ON_TRIP`/`BUSY` never written                                  |

## 17. P1 Findings

| #     | Finding                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| P1-1  | `setSuspended` self-deadlocks on the row it already locked — the emergency control does not work                          |
| P1-2  | Admin can mark a driver `VERIFIED` with zero documents submitted                                                          |
| P1-3  | `POST /drivers/location` has no operability guard — `PENDING`/`REJECTED`/`SUSPENDED` drivers populate the geo index       |
| P1-4  | Location ingestion has no ONLINE requirement, so geo membership does not imply availability                               |
| P1-5  | Driver documents accept an arbitrary `fileUrl`, bypassing the Files module entirely (SSRF/phishing surface for reviewers) |
| P1-6  | `vehicleId` is unvalidated at ride accept — any vehicle, including another driver's                                       |
| P1-7  | Licence `expiresAt` is never checked at `setOnline`                                                                       |
| P1-8  | `DocExpirationJob` is unreachable — it filters on a status nothing writes                                                 |
| P1-9  | Heartbeat-timeout worker does not re-read `heartbeatAt` under the lock; a live driver can be forced offline               |
| P1-10 | Gate A (ride routes) and Gate B (`setOnline`) disagree — a driver can operate rides while unable to go online             |
| P1-11 | RC, insurance and PUC are never required for eligibility, contrary to Indian regulatory practice                          |

## 18. P2 Findings

| #     | Finding                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------- |
| P2-1  | `POST /status/offline` and `POST /heartbeat` carry no route guard                                        |
| P2-2  | `BUSY`, `ON_TRIP`, `BREAK` are unreachable enum values; the `ON_TRIP` guard in `setOffline` is dead code |
| P2-3  | Availability duplicated across `drivers.isAvailable` and `driver_online_status.status`                   |
| P2-4  | `Driver.currentVehicleId` exists and is never written                                                    |
| P2-5  | `DriverVerificationStatus.SUSPENDED` is never written (suspension uses the boolean)                      |
| P2-6  | Vehicle types are not seeded; no service-type listing API                                                |
| P2-7  | Driver auto-provisions on `GET /drivers/me` with no application step                                     |
| P2-8  | Document status has no `EXPIRED` value — expiry overloads `REJECTED`                                     |
| P2-9  | No test coverage for suspension, concurrency, or the online lifecycle over HTTP                          |
| P2-10 | `drivers.rating` / `totalRides` / `totalEarnings` never written                                          |

---

## 19. Recommended Implementation Order

Dependency-ordered. Do not start a step before the ones above it.

**STEP 1 — Document approval** _(unblocks everything)_
Admin endpoint writing `DriverDocument.verificationStatus` via the existing `updateVerificationStatus`, with `verifiedBy`/`rejectionReason`. Gate driver-level `VERIFIED` on the required document set rather than on an admin's word. Fix `DocExpirationJob` so expiry is reachable, and check `expiresAt` at `setOnline`.
_Without this, no driver exists to dispatch to and no downstream step is testable._

**STEP 2 — Documents through the Files module**
Replace `fileUrl: string` with a `fileId` resolved against Files, asserting ownership, `DRIVER_DOCUMENT` purpose and `ACTIVE` status. Closes the reviewer-facing SSRF surface before operators start opening these links.

**STEP 3 — Vehicle module**
Registration, driver↔vehicle assignment (`VehicleAssignment` already models it), vehicle documents and approval, `Driver.currentVehicleId`, and validation of `vehicleId` at ride accept. Seed `VehicleType`. _Service type is unknowable until this exists._

**STEP 4 — Eligibility unification**
One gate used by both the route guard and `setOnline`: verified + not suspended + not deleted + required documents valid and unexpired + assigned, approved vehicle + no active ride. Retire the Gate A/Gate B split.

**STEP 5 — Availability state**
Write `ON_TRIP` on accept and back to `ONLINE` on complete/cancel; add the busy check using the existing `findActiveByDriver`; add a partial unique index for one active ride per driver. Collapse the `isAvailable`/`status` duplication.

**STEP 6 — Location gating**
Require operability on `POST /drivers/location`; index into Geo only for drivers who are `ONLINE`; remove from the index on suspension as well as offline. Fix the heartbeat-timeout re-check under lock. Fix `setSuspended`'s nested transaction.

**STEP 7 — Tests**
Document approval end-to-end without fixture shortcuts; vehicle assignment; online/offline over HTTP; concurrency (double-online, online-vs-suspend, heartbeat-vs-timeout); an online driver actually returned by `findNearbyDrivers` through the real ingestion path.

**Not in this phase:** dispatch, matching, offers, Socket.IO, FCM — all correctly deferred, and all blocked on Steps 1–5.

---

## 20. Final Decision

**The driver supply chain is NOT production-viable.** It fails at the fourth step of nine and cannot reach the ninth.

**What genuinely works and should not be rebuilt:** registration and profile; document submission mechanics (upsert, resubmission reset); the transactional online/offline core with row locking, shift management and outbox events; heartbeat; location ingestion with server-side plausibility screening and mock-location handling; PostGIS persistence with a GiST index; the Redis/H3 live index with its Lua compare-and-set ordering guarantee; and BOLA protection, which is the strongest area in the module — path parameters are ignored in favour of JWT identity, and it is tested.

**What is missing is narrow and deep:** one approval endpoint, one module (Vehicle), one caller (`findNearbyDrivers`), and one state write (`ON_TRIP`). None of it requires redesigning what exists.

**The most important structural point:** the schema already anticipated all of this — `verifiedBy`, `verifiedAt`, `rejectionReason`, `VehicleAssignment`, `currentVehicleId`, `BUSY`, `ON_TRIP` are all present and unused. The gap is not architectural. It is unwritten operator-facing code and unwired state transitions.

**Answer to the phase question:** a driver can register, complete a profile, and upload documents. They cannot be verified, cannot register a vehicle, cannot satisfy eligibility, cannot go online, and cannot become available for dispatch. **4 P0 findings, 11 P1, 10 P2.**
