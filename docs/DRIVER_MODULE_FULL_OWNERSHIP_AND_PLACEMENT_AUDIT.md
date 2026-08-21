# Driver Module — Full Ownership and Code Placement Audit

**Repository:** `backend_zaroorat` · **Branch:** `feature/auth` · **HEAD:** `273aadb`
**Date:** 2026-08-19
**Scope:** Read-only investigation. No code written or modified, no files moved, no folders created or deleted, no imports changed, no migrations run.

**Evidence labels:** `CODE VERIFIED` · `TEST VERIFIED` · `BUILD VERIFIED` · `INFERENCE` · `REQUIRES DECISION`

**Ownership classifications:** `KEEP_IN_DRIVERS` · `MOVE_TO_EXISTING_MODULE` · `CROSS_MODULE_ORCHESTRATION` · `DUPLICATED_LOGIC` · `DEAD_OR_UNUSED` · `TEST_ONLY` · `UNCLEAR_REQUIRES_DECISION`

A **production caller** is a call site reachable from a registered route, a registered event subscriber, or a scheduled job. Test files never count. `src/generated/**` is excluded from every search.

---

## 1. Executive Summary

This audit asked a different question from previous ones: not _where within `drivers/` should code sit_, but **does the code inside `drivers/` belong to the Driver domain at all**, given that sibling modules named `documents/`, `onboarding/`, `vehicles/`, `payments/`, `geo/`, `matching/`, and `dispatch/` already exist.

**The headline answer is the opposite of what the folder names suggest.**

> ### Almost nothing inside `drivers/` should move out of it.
>
> Of 54 files, **43 are `KEEP_IN_DRIVERS`**, 0 are `MOVE_TO_EXISTING_MODULE`, 3 are `CROSS_MODULE_ORCHESTRATION`, 6 are `DEAD_OR_UNUSED`, and 2 are `UNCLEAR_REQUIRES_DECISION`. `CODE VERIFIED`

**Five findings drive that conclusion:**

**1. The sibling module names carry no ownership intent.** All nine stub READMEs are byte-identical scaffold boilerplate — _"This module owns the core business logic for X."_ There is no design document, no code, no schema, and no declared intent that `src/modules/documents/` was ever meant to own `DriverDocument`, or `src/modules/onboarding/` to own driver onboarding. **The folder name is the only signal, and the brief correctly says not to trust folder names.** `CODE VERIFIED`

**2. `drivers/` has exactly one cross-domain dependency: `geo`.** A complete import scan returns `@modules/geo` ×4 and nothing else — no auth, no users, no files, no documents, no onboarding, no payments, no vehicles, no rides. Every other import is `@core/*`, `@config`, or `@shared`. The module is already extremely well isolated. `CODE VERIFIED`

**3. There are zero circular dependencies.** Inbound is only `core/di.ts`, `routes/register.ts`, and `rides/controllers/ride-state.controller.ts`. `geo` does not import `drivers`; `rides` → `drivers` is one-directional and correct. `CODE VERIFIED`

**4. Driver-domain code outside `drivers/` is limited to four files, and three of them are correctly placed.** Only `auth/repositories/driver-access.repository.ts` is a genuine ownership question. `CODE VERIFIED`

**5. The real defect is not cross-module placement — it is missing outbound calls.** Because `drivers/` imports neither `auth`, `users`, nor `files`, it cannot call `grantRole`, does not use `UserRepository.updateEmail` (it issues a raw Prisma write instead), and stores raw client-supplied `fileUrl` strings rather than Files-owned `fileId`s. **The import graph is the proof of the three P0 gaps.** `CODE VERIFIED`

**Structural verdict:** the module is **C — Mixed**. Horizontal technical layers (`controllers/`, `services/`, `repositories/`, …) with a partial vertical split **inside `services/` only** (`services/{onboarding,status,location,shift,wallet}`). No top-level submodules exist, and **no directory under `drivers/` is empty** — `find src/modules/drivers -type d -empty` returns nothing.

**The one genuine internal placement defect:** document handling has no owner. Its write path lives inside the _onboarding_ service, its persistence in a flat repository, its expiry job in a flat jobs folder. Extracting `documents/` **as a Driver submodule** (not as the top-level `documents/` module) is the highest-value change.

**Blocking state:** the tree does not compile or lint — `DriverNotFoundError` unimported at `driver-onboarding.controller.ts:18`, and `catch (err: any)` at `onboarding.service.ts:39`. Both sit in an **uncommitted 13-file changeset that is mid-rewrite of the onboarding flow**. **No file may be moved until this is green and committed.** `BUILD VERIFIED`

---

## 2. Complete Current Driver Module Tree

`CODE VERIFIED` — `find src/modules/drivers -type d | sort` plus full file listing. **19 directories, 54 files, none empty.**

```
src/modules/drivers/
├── constants/
│   ├── driver.constants.ts          DRIVER_VERIFICATION_STATUS, DRIVER_STATUS, DRIVER_DOCUMENT_TYPE
│   └── index.ts
├── controllers/
│   ├── driver.controller.ts          aggregate facade over 4 sub-controllers
│   ├── driver-identity.ts            actingDriverId, authorizedDriverId
│   ├── driver-location.controller.ts
│   ├── driver-onboarding.controller.ts   getMe, onboard, updateProfile, submitDocument, reviewVerification
│   ├── driver-status.controller.ts
│   ├── driver-wallet.controller.ts
│   └── index.ts
├── errors/
│   ├── driver.errors.ts              8 classes (2 with zero throw sites)
│   └── index.ts
├── events/
│   ├── catalog.ts                    DRIVER_EVENT_CATALOG — 8 types, 4 never published
│   └── index.ts
├── jobs/
│   ├── doc-expiration.job.ts         cron 0 2 * * *   (documents concern)
│   ├── heartbeat-timeout.job.ts      cron * * * * *   (status concern)
│   └── index.ts
├── metrics/
│   ├── driver.metrics.ts             11 methods (1 never called)
│   └── index.ts
├── plugins/
│   ├── driver.plugin.ts              DEAD — zero callers
│   └── index.ts
├── repositories/
│   ├── driver.repository.ts          aggregate root: driver row, profile, verification, availability
│   ├── driver-bank.repository.ts     DEAD — zero callers
│   ├── driver-document.repository.ts
│   ├── driver-location.repository.ts raw PostGIS upsert
│   ├── driver-shift.repository.ts
│   ├── driver-status.repository.ts
│   ├── driver-wallet.repository.ts   read projection (lockForUpdate dead)
│   └── index.ts
├── routes/
│   ├── driver.routes.ts              all 13 routes in one flat file
│   └── index.ts
├── schemas/
│   ├── driver.schemas.ts             5 Zod schemas spanning 4 domains
│   ├── driver.responses.ts           DEAD — zero references
│   ├── error-response.ts             handleDriverError
│   └── index.ts
├── services/
│   ├── driver.service.ts             aggregate facade over 5 sub-services
│   ├── index.ts
│   ├── location/    { index.ts, location.service.ts, location-plausibility.ts }
│   ├── onboarding/  { index.ts, onboarding.service.ts }   ← 4 concerns in one class
│   ├── shift/       { index.ts, shift.service.ts }        ← DEAD, zero callers
│   ├── status/      { index.ts, status.service.ts }
│   └── wallet/      { index.ts, wallet.service.ts }
├── types/
│   ├── driver.types.ts               Prisma type re-exports
│   └── index.ts
├── utils/
│   ├── driver-code.util.ts
│   └── index.ts
├── index.ts                          DI registration (20 tokens) + barrel re-exports
└── README.md                         STALE — claims "0 errors / 550 tests"
```

**Does not exist:** `drivers/documents/`, `drivers/onboarding/`, `drivers/profile/`, `drivers/verification/`, `drivers/eligibility/`, `drivers/shifts/`, `drivers/shared/`, `drivers/consumers/`, `drivers/guards/`, `driver.module.ts`.

---

## 3. Complete File Inventory

`CODE VERIFIED` — all 54 files, with ownership classification.

| #   | File                                                      | LOC | Purpose                                       | Used?               | Ownership                                  |
| --- | --------------------------------------------------------- | --: | --------------------------------------------- | ------------------- | ------------------------------------------ |
| 1   | `index.ts`                                                |  86 | DI registration (20 tokens) + barrels         | ✅ `core/di.ts`     | `KEEP_IN_DRIVERS`                          |
| 2   | `README.md`                                               |   — | Module doc                                    | ⚠️ stale            | `KEEP_IN_DRIVERS`                          |
| 3   | `constants/driver.constants.ts`                           |  29 | Status/type enums mirroring Prisma            | ✅                  | `KEEP_IN_DRIVERS`                          |
| 4   | `constants/index.ts`                                      |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 5   | `controllers/driver.controller.ts`                        |  12 | Facade for 4 controllers                      | ✅ routes           | `KEEP_IN_DRIVERS`                          |
| 6   | `controllers/driver-identity.ts`                          |  24 | `actingDriverId`, `authorizedDriverId`        | ✅ 4 ctrls + rides  | `KEEP_IN_DRIVERS`                          |
| 7   | `controllers/driver-location.controller.ts`               |  37 | Location HTTP                                 | ✅                  | `KEEP_IN_DRIVERS`                          |
| 8   | `controllers/driver-onboarding.controller.ts`             |  82 | onboard + profile + **document** + **review** | ⚠️ **BROKEN**       | `KEEP_IN_DRIVERS` + `DUPLICATED_LOGIC`     |
| 9   | `controllers/driver-status.controller.ts`                 |  52 | Status HTTP                                   | ✅                  | `KEEP_IN_DRIVERS`                          |
| 10  | `controllers/driver-wallet.controller.ts`                 |  36 | Wallet read HTTP                              | ✅                  | `KEEP_IN_DRIVERS`                          |
| 11  | `controllers/index.ts`                                    |   5 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 12  | `errors/driver.errors.ts`                                 |  66 | 8 domain errors                               | ✅ 6/8 thrown       | `KEEP_IN_DRIVERS`                          |
| 13  | `errors/index.ts`                                         |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 14  | `events/catalog.ts`                                       |  29 | 8 event types                                 | ✅ 4/8 published    | `KEEP_IN_DRIVERS`                          |
| 15  | `events/index.ts`                                         |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 16  | `jobs/doc-expiration.job.ts`                              |  45 | Expire verified docs                          | ✅ cron — **inert** | `KEEP_IN_DRIVERS`                          |
| 17  | `jobs/heartbeat-timeout.job.ts`                           |  40 | Sweep stale ONLINE                            | ✅ cron             | `KEEP_IN_DRIVERS`                          |
| 18  | `jobs/index.ts`                                           |   2 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 19  | `metrics/driver.metrics.ts`                               |  42 | Prometheus counters                           | ✅ 10/11            | `KEEP_IN_DRIVERS`                          |
| 20  | `metrics/index.ts`                                        |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 21  | `plugins/driver.plugin.ts`                                |   8 | Fastify prefix wrapper                        | ❌ zero callers     | **`DEAD_OR_UNUSED`**                       |
| 22  | `plugins/index.ts`                                        |   1 | barrel                                        | ❌                  | **`DEAD_OR_UNUSED`**                       |
| 23  | `repositories/driver.repository.ts`                       | 133 | Aggregate root + **raw `user.update`**        | ✅ + rides          | `KEEP_IN_DRIVERS` + `DUPLICATED_LOGIC`     |
| 24  | `repositories/driver-bank.repository.ts`                  |  46 | Bank accounts                                 | ❌ zero callers     | **`DEAD_OR_UNUSED`**                       |
| 25  | `repositories/driver-document.repository.ts`              |  85 | `driver_documents` CRUD                       | ✅                  | `KEEP_IN_DRIVERS`                          |
| 26  | `repositories/driver-location.repository.ts`              |  58 | `driver_locations` PostGIS upsert             | ✅                  | `KEEP_IN_DRIVERS`                          |
| 27  | `repositories/driver-shift.repository.ts`                 |  44 | `driver_shift_logs`                           | ✅                  | `KEEP_IN_DRIVERS`                          |
| 28  | `repositories/driver-status.repository.ts`                |  78 | `driver_online_status`                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 29  | `repositories/driver-wallet.repository.ts`                |  44 | Wallet read                                   | ⚠️ 2/3 methods      | `KEEP_IN_DRIVERS`                          |
| 30  | `repositories/index.ts`                                   |   7 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 31  | `routes/driver.routes.ts`                                 |  44 | 13 routes, 5 domains                          | ✅                  | `KEEP_IN_DRIVERS`                          |
| 32  | `routes/index.ts`                                         |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 33  | `schemas/driver.schemas.ts`                               |  54 | 5 Zod schemas                                 | ✅                  | `KEEP_IN_DRIVERS`                          |
| 34  | `schemas/driver.responses.ts`                             |  20 | View types                                    | ❌ zero refs        | **`DEAD_OR_UNUSED`**                       |
| 35  | `schemas/error-response.ts`                               |  22 | `handleDriverError`                           | ✅                  | `KEEP_IN_DRIVERS`                          |
| 36  | `schemas/index.ts`                                        |   3 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 37  | `services/driver.service.ts`                              |  14 | Facade over 5 services                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 38  | `services/index.ts`                                       |   6 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 39  | `services/location/location.service.ts`                   |  69 | Location ingest + geo write                   | ✅                  | `CROSS_MODULE_ORCHESTRATION`               |
| 40  | `services/location/location-plausibility.ts`              |  62 | Speed/age/noise checks                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 41  | `services/location/index.ts`                              |   2 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 42  | `services/onboarding/onboarding.service.ts`               | 113 | onboard + profile + **doc** + **review**      | ✅                  | `KEEP_IN_DRIVERS` + **`DUPLICATED_LOGIC`** |
| 43  | `services/onboarding/index.ts`                            |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 44  | `services/shift/shift.service.ts`                         |   8 | `getActiveShift`                              | ❌ zero callers     | **`DEAD_OR_UNUSED`**                       |
| 45  | `services/shift/index.ts`                                 |   1 | barrel                                        | ❌                  | **`DEAD_OR_UNUSED`**                       |
| 46  | `services/status/status.service.ts`                       | 136 | online/offline/heartbeat/suspend              | ✅                  | `CROSS_MODULE_ORCHESTRATION`               |
| 47  | `services/status/index.ts`                                |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 48  | `services/wallet/wallet.service.ts`                       |  11 | Read projection                               | ✅                  | `KEEP_IN_DRIVERS`                          |
| 49  | `services/wallet/index.ts`                                |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 50  | `types/driver.types.ts`                                   |  33 | Prisma re-exports                             | ✅                  | `KEEP_IN_DRIVERS`                          |
| 51  | `types/index.ts`                                          |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 52  | `utils/driver-code.util.ts`                               |   6 | `generateDriverCode()`                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 53  | `utils/index.ts`                                          |   1 | barrel                                        | ✅                  | `KEEP_IN_DRIVERS`                          |
| 54  | `repositories/driver-wallet.repository.ts::lockForUpdate` |   — | (method)                                      | ❌ zero callers     | **`DEAD_OR_UNUSED`**                       |

**Tally:** `KEEP_IN_DRIVERS` 43 · `MOVE_TO_EXISTING_MODULE` **0** · `CROSS_MODULE_ORCHESTRATION` 3 · `DUPLICATED_LOGIC` 3 (overlapping) · `DEAD_OR_UNUSED` 6 · `TEST_ONLY` 0 · `UNCLEAR_REQUIRES_DECISION` 2 (§8).

---

## 4. Actual Responsibility of Every Major File

### 4.1 `services/onboarding/onboarding.service.ts` — four concerns, one class

|               |                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exports**   | `OnboardingService`                                                                                                                                         |
| **Methods**   | `onboardDriver` (onboarding) · `updateProfile` (onboarding + **User.email**) · `submitDocument` (**documents**) · `reviewDriverVerification` (**approval**) |
| **Called by** | `DriverOnboardingController` only                                                                                                                           |
| **Imports**   | `@core/database`, `@core/events`, 2 repositories, errors, event catalog, metrics                                                                            |
| **Routes**    | `POST /me/onboard`, `PATCH /:driverId/profile`, `POST /:driverId/documents`, `POST /:id/verify`                                                             |
| **Tables**    | `drivers`, `driver_profiles`, `driver_documents`, **`users`** (raw write)                                                                                   |
| **Events**    | Publishes `driver.onboarded`, `driver.verified` — **neither has a subscriber**                                                                              |
| **Status**    | Production-used; **lint-failing** (`catch (err: any)`, line 39)                                                                                             |
| **Ownership** | `KEEP_IN_DRIVERS`, but **`DUPLICATED_LOGIC`** — three domains in one class                                                                                  |

### 4.2 `repositories/driver.repository.ts` — aggregate root

Exports `DriverRepository`. Called by 3 services, 2 controllers, 2 jobs, **and `rides/controllers/ride-state.controller.ts`**. Tables: `drivers`, `driver_profiles`, **`users`**.

> **The one genuine cross-module violation inside this file:** `updateProfile` performs a raw `client.user.update({ where: { id: userId }, data: { email } })` — a direct write into the **Users** module's table, bypassing `UserRepository.updateEmail`, which **was added in this very changeset and is not used**. `CODE VERIFIED`
>
> This is not a "move the file" problem. It is a **call the right module** problem.

### 4.3 `services/status/status.service.ts` — the eligibility decision point

`setOnline` reads `DriverDocumentRepository` (licence gate) and writes `DriverShiftRepository`; `setOffline` calls `geoService.forgetDriverPosition` **after commit**. Cross-submodule reach is **legitimate orchestration** — this service _is_ where driver eligibility is decided. `CROSS_MODULE_ORCHESTRATION`, stays. `INFERENCE`

### 4.4 `services/location/location.service.ts` — Driver ⇄ Geo boundary

Validates mock GPS + plausibility → writes `driver_locations` (Driver-owned) → calls `geoService.recordDriverPosition` (Geo-owned index) → writes `DriverStatusRepository.updateHeartbeat`.

> **The boundary is drawn correctly:** Drivers owns the _durable driver position row and its plausibility policy_; Geo owns the _spatial index and search_. This is the module's only cross-domain dependency and it is one-directional. `CODE VERIFIED`

### 4.5 `controllers/driver-identity.ts` — driver authorization helpers

`actingDriverId(req, repo)` maps JWT → Driver id; `authorizedDriverId(req, repo, requested?, staffRoles)` enforces own-or-staff.

> **Must NOT move to `auth`.** It depends on `DriverRepository` — `core/auth` has no business depending on a domain repository. It maps _platform identity → driver identity_, which is Driver-domain. **Five callers**, all documented in §10.2. `INFERENCE`

### 4.6 `repositories/driver-document.repository.ts` — and the `documents/` question

Owns `driver_documents`: `upsertDocument`, `findByDriverId`, `updateVerificationStatus`, `findExpiredDocuments`. See §7.1 for the full ownership verdict.

---

## 5. Current Driver Flow Trace

All traced from code, current working tree. `CODE VERIFIED`

### A. Driver App entry — ✅ works, fully shared

```
POST /api/v1/auth/otp/send    → auth module (OtpService)
POST /api/v1/auth/otp/verify  → auth module (AuthService.runVerifyOtp)
    → resolveAccount (find-or-create User) → ensureDefaultRole('customer')
    → session + JWT{sub, sid, roles:['customer'], epoch}
```

**Owned entirely by `auth` + `users`. `drivers/` is not involved and imports neither.** Correct.

### B. Driver profile — ⚠️ partial

```
POST  /api/v1/drivers/me/onboard      → OnboardingService.onboardDriver
                                         → driver row (PENDING), driver.onboarded event
PATCH /api/v1/drivers/:driverId/profile → OnboardingService.updateProfile
                                         → driver_profiles upsert (name, gender)
                                         → RAW users.email write  ⚠️ bypasses Users module
GET   /api/v1/drivers/me               → ⛔ DOES NOT COMPILE
```

Resume data is complete server-side (`findByUserId` includes profile + documents + onlineStatus), but the probe endpoint is broken.

### C. Driver onboarding — where does it live?

| Question                                    | Answer                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| What is inside `drivers/`?                  | **All of it** — `services/onboarding/`, controller, repository, schema, route |
| What is inside `src/modules/onboarding/`?   | **Nothing.** `export {};` + boilerplate README                                |
| Is there duplication?                       | **No.** Zero code exists in the top-level module                              |
| Is the top-level `onboarding/` module used? | **No.** Not imported anywhere, not registered in DI, no routes                |

`CODE VERIFIED`

### D. Driver documents — per-step ownership

| Step                                | Owning module today                             | Correct owner                    |
| ----------------------------------- | ----------------------------------------------- | -------------------------------- |
| File upload / storage               | **Not used at all** — client sends a raw URL    | `files`                          |
| File ownership + purpose validation | **Missing**                                     | `files`                          |
| Document reference                  | `drivers` — `fileUrl String`                    | `drivers` (should hold `fileId`) |
| Submission                          | `drivers` — inside **onboarding** service       | `drivers` (documents submodule)  |
| Persistence                         | `drivers` — `driver-document.repository.ts`     | `drivers`                        |
| Review                              | **DOES NOT EXIST**                              | `drivers`                        |
| Verification/rejection              | Only expiry job writes `REJECTED`               | `drivers`                        |
| Expiration                          | `drivers` — `doc-expiration.job.ts` (**inert**) | `drivers`                        |

> **`src/modules/documents/` owns nothing and is an `export {};` stub.** `CODE VERIFIED`

### E. Driver approval — the broken chain

```
POST /api/v1/drivers/:id/verify  [authorize roles:['admin']]
  → reviewDriverVerification
      ├─ lockForUpdate + updateVerificationStatus → VERIFIED   ✅
      ├─ driverMetrics.driverVerified                          ✅
      └─ publish driver.verified → event_outbox → EventBus     ✅
                          ↓
                 ZERO SUBSCRIBERS                              ⛔
      ❌ no document-completeness check (documents table never queried)
      ❌ AuthService.grantRole NEVER CALLED
      ❌ security epoch never bumped
```

> **The import graph proves it:** `drivers/` does not import `@modules/auth` at all, so it _cannot_ call `grantRole`. `CODE VERIFIED`

### F. Driver operational flow — blocked at the first gate

```
setOnline → lockForUpdate → VERIFIED? → !suspended?
          → requires a DRIVING_LICENSE document with verificationStatus === 'VERIFIED'
            ⛔ NO PRODUCTION CODE WRITES 'VERIFIED' → permanently unsatisfiable
          → startShift → updateAvailability → updateStatus('ONLINE') → event
heartbeat → early-returns when OFFLINE ✅
location  → NO eligibility gate ⚠️ → driver_locations + Redis geo index
BUSY / ON_TRIP → ❌ no writer anywhere
setOffline → endShift → forgetDriverPosition (post-commit ✅)
suspend   → ⛔ nested-transaction self-deadlock
```

### G. Ride integration — severed in two places

```
POST /rides/requests → RideRequest(CREATED) → publish ride.requested → ZERO SUBSCRIBERS ⛔
  [ geo.findNearbyDrivers      — complete, 0 production callers ]
  [ dispatch.offerToDriver     — complete, 0 production callers ]
POST /rides/accept → requireOperableDriver → creates Ride
  ❌ no offer validation, no vehicle validation, no one-active-ride guard, no BUSY/ON_TRIP write
```

---

## 6. Driver-Domain Ownership Definition

Derived from the schema and the actual dependency graph, not from folder names. `INFERENCE` grounded in `CODE VERIFIED` facts.

**The Driver domain owns the lifecycle and operational state of a person authorised to drive on the platform.** Concretely, it owns nine Prisma models — `Driver`, `DriverProfile`, `DriverDocument`, `DriverBankAccount`, `DriverWallet`, `DriverWalletTransaction`, `DriverOnlineStatus`, `DriverLocation`, `DriverShiftLog` — and the rules governing transitions between their states.

| Drivers **owns**                                                    | Drivers **consumes from elsewhere**                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Driver entity, code, lifecycle state                                | Platform identity (`User`) — **users**                     |
| Driver-specific profile (legal name, gender, licence-adjacent data) | Phone proof, sessions, JWT, roles — **auth**               |
| Driver verification/approval/suspension state machine               | File bytes, storage, ownership, purpose policy — **files** |
| Driver document records, types, expiry, review state                | Spatial index and nearby search — **geo**                  |
| Operational status: ONLINE/OFFLINE/BUSY/ON_TRIP/BREAK               | Ride lifecycle and offers — **rides**                      |
| Shifts and heartbeat behaviour                                      | Money movement, settlement, payouts — **payments**         |
| Driver eligibility orchestration                                    | Vehicle registry and assignment — **vehicles**             |
| Durable driver position row + plausibility policy                   | Notification delivery — **notifications**                  |
| Driver-domain events, errors, types, constants                      | Transactions, outbox, DI, metrics — **core**               |
| Driver-specific authorization helpers                               |                                                            |

**The decisive test used throughout:** _if this table/rule disappeared, would the Driver domain still be coherent?_ `driver_documents` fails that test — a driver without documents cannot be verified, so document state **is** driver lifecycle state. `users.email` passes it — email is platform identity that exists with or without a Driver row.

---

## 7. Files That Truly Belong in Drivers

**43 of 54.** The three ownership questions that could plausibly go the other way, decided on evidence:

### 7.1 Driver documents → **`KEEP_IN_DRIVERS`** (not `src/modules/documents/`)

| Argument to move                 | Rebuttal                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `documents/` module exists     | It is `export {};` + a boilerplate README. **Zero code, zero schema, zero declared intent.** `CODE VERIFIED`                                                                           |
| "Documents" sounds generic       | `DriverDocumentType` is `DRIVING_LICENSE, RC, INSURANCE, AADHAAR, PAN, PUC, POLICE_VERIFICATION, PROFILE_PHOTO` — **entirely driver/vehicle KYC**. Nothing generic. `CODE VERIFIED`    |
| Other domains may need documents | `VehicleDocument` **already exists as a separate model** with its own `documentType String`. The schema author chose per-domain document tables, not one shared table. `CODE VERIFIED` |
| Reuse of review workflow         | The review workflow **does not exist yet** in any module. There is nothing to reuse                                                                                                    |

**Decisive:** `DriverDocument.verificationStatus` is read by `StatusService.setOnline` as the licence gate. Moving it would make a **core driver eligibility check** a cross-module call for no gain. `INFERENCE`

> **Verdict:** documents are Driver-domain. Extract as `drivers/documents/` — a **Driver submodule**, not the top-level module. What genuinely belongs to `files` is the **bytes**: upload, storage, ownership, purpose, scanning, retention. Drivers should store a `fileId` and let Files own the object.

### 7.2 Driver onboarding → **`KEEP_IN_DRIVERS`** (not `src/modules/onboarding/`)

`src/modules/onboarding/` contains `export {};` and boilerplate. `onboardDriver` creates a `Driver` row with a driver code and a driver-specific verification status — **it is driver creation, not a generic workflow engine**. A generic onboarding module would own step definitions and progress tracking shared across personas; none exists, and §10 of the prior audit established that driver progress is derived from persisted driver fields. `CODE VERIFIED` + `INFERENCE`

### 7.3 Driver wallet → **`KEEP_IN_DRIVERS`** (read only)

`DriverWalletViewService` has two methods, both reads. **Payments owns every write** — `grep -rln "earnings" src` returns three Payments files and **zero Drivers files**. The boundary is already correct. Do **not** create `drivers/earnings/`. `CODE VERIFIED`

### 7.4 Driver location → **`KEEP_IN_DRIVERS`** (row), **`geo`** (index)

`driver_locations` is a Driver-owned table with driver-specific policy (mock-GPS rejection, speed/age/noise plausibility). The **spatial index and nearby search** are Geo's, and `LocationService` already calls across that line correctly. `CODE VERIFIED`

---

## 8. Files Wrongly Placed in Drivers

> **Zero files need to move OUT of `drivers/` into another top-level module.** `CODE VERIFIED`

Two items are `UNCLEAR_REQUIRES_DECISION`:

| File                                               | Question                                             | Evidence both ways                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositories/driver-bank.repository.ts`           | Drivers or Payments?                                 | **For Payments:** bank accounts exist for payouts; Payments owns `PayoutService` and `DriverSettlement`. **For Drivers:** `DriverBankAccount` is a driver-owned KYC-adjacent record. **Zero callers today**, so no behaviour depends on the answer. `REQUIRES DECISION` — resolve when payouts are built |
| `services/wallet/` + `driver-wallet.repository.ts` | Read projection in Drivers, or a Payments query API? | Currently a clean read-only projection with routes in Drivers. Defensible either way; **no defect today**. `REQUIRES DECISION` — only revisit if Drivers ever needs to write                                                                                                                             |

**Internally misplaced (still inside Drivers, wrong submodule)** — the genuine defect, unchanged from prior audit:

| Item                                                | Current                                     | Correct Driver submodule          |
| --------------------------------------------------- | ------------------------------------------- | --------------------------------- |
| `submitDocument`                                    | `services/onboarding/onboarding.service.ts` | `drivers/documents/services/`     |
| `reviewDriverVerification`                          | same file                                   | `drivers/verification/services/`  |
| `driver-document.repository.ts`                     | `repositories/`                             | `drivers/documents/repositories/` |
| `doc-expiration.job.ts`                             | `jobs/`                                     | `drivers/documents/jobs/`         |
| `heartbeat-timeout.job.ts`                          | `jobs/`                                     | `drivers/status/jobs/`            |
| 5 controllers, 5 repositories, 5 schemas, 13 routes | flat layers                                 | per-submodule                     |

---

## 9. Driver-Related Files Outside Drivers

`CODE VERIFIED` — exhaustive search: filename match, plus every non-`drivers/` file referencing a Driver Prisma model.

| File                                                        | What it does                                                                                                                    | Classification                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/driver/driver.config.ts`                        | `heartbeatTimeoutSeconds`, `maxContinuousShiftHours`, `requireApprovedDocuments`, `rejectMockLocation`, plausibility thresholds | **Correctly outside.** `src/config/` holds every module's config (`file`, `geo`, `ride`, `payment`, `otp`, `user`, …). Moving it would break a platform-wide convention. ⚠️ Two flags have **zero consumers** — `requireApprovedDocuments` (default `true`) and `maxContinuousShiftHours` |
| `src/config/rate-limit/rate-limit.config.ts`                | `driverLocation` bucket                                                                                                         | **Correctly outside.** Same convention                                                                                                                                                                                                                                                    |
| `src/modules/geo/services/nearby-driver.service.ts`         | Nearby-driver spatial search                                                                                                    | **Correctly outside.** Named "driver" but it is a **geospatial query**. Geo owns the index. The brief's warning — don't move on filename — applies exactly here                                                                                                                           |
| `src/modules/auth/repositories/driver-access.repository.ts` | `isOperableDriver(userId)` → queries `drivers` for `VERIFIED + !suspended + !deleted`                                           | **`CROSS_MODULE_ORCHESTRATION` — should remain outside.** §9.1                                                                                                                                                                                                                            |

### 9.1 The one real ownership question: `driver-access.repository.ts` in `auth`

**For moving to Drivers:** it queries the `drivers` table — a Driver-domain read living inside `auth`. Arguably inverted coupling: `auth` now depends on the Driver schema.

**For leaving it in `auth`:** it backs the `requireOperableDriver` **route-guard option** in `authPlugin`, alongside `roles` and `requireUntamperedDevice`. The guard is applied to **5 routes across 2 modules** (`drivers`, `rides`). Moving it would either force `auth` to import `drivers` (creating the first `auth → drivers` edge and a **near-certain cycle**, since `drivers` would then need `auth` for `grantRole`), or fragment the guard surface across modules.

> **Verdict: leave it.** Preserving `auth` as a leaf that no domain module depends on is worth more than perfect table ownership — and moving it would manufacture the circular dependency the codebase currently does not have. `INFERENCE`
>
> ⚠️ **Security-critical.** Do not move without documenting all callers first.

---

## 10. Cross-Module Dependency Graph

### 10.1 Outbound — what `drivers/` imports

`CODE VERIFIED` — complete scan of all `@modules/*`, `@core/*`, `@config`, `@shared` imports:

```
drivers → @core/database            11   TransactionManager, DatabaseService
drivers → @core/database/Transaction 7
drivers → @shared/logger             4
drivers → @modules/geo               4   ← THE ONLY CROSS-DOMAIN DEPENDENCY
drivers → @config                    4   driverConfig, rateLimits
drivers → @core/auth                 3   callerId, callerHasRole, ForbiddenResourceError
drivers → @core/events               2   EventPublisher
drivers → @core/cache/RedisService    2   job locks
drivers → @core/metrics, /errors, /di 3
```

| Dependency | Why                                        | Files                                                                                                     | Direction      | Cycle?                             | Public API?                        |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------- | ---------------------------------- |
| **`geo`**  | Record/forget position; coordinate schemas | `services/location/location.service.ts`, `services/status/status.service.ts`, `schemas/driver.schemas.ts` | drivers → geo  | **No** — geo never imports drivers | ✅ **Yes** — barrel `@modules/geo` |
| `@core/*`  | Platform infra                             | many                                                                                                      | drivers → core | No                                 | ✅                                 |

**Modules `drivers/` does NOT import — and the gaps that proves:**

| Not imported                                                                                           | Consequence `CODE VERIFIED`                                                  |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **`auth`**                                                                                             | Cannot call `grantRole` → the `driver` role is never granted                 |
| **`users`**                                                                                            | Does not use `UserRepository.updateEmail` → raw `client.user.update` instead |
| **`files`**                                                                                            | No upload/ownership/purpose validation → raw client `fileUrl` accepted       |
| `documents`, `onboarding`, `vehicles`, `payments`, `matching`, `dispatch`, `rides`, `admin`, `support` | No coupling — correct                                                        |

> **The import graph is the diagnosis.** Three P0 gaps are visible as three missing edges.

### 10.2 Inbound — who imports `drivers/`

| Importer                                     | Imports                                                                              | Public API?              | Risk on move |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------ | ------------ |
| `src/core/di.ts`                             | `registerDriversModule` from `@modules/drivers`                                      | ✅ barrel                | LOW          |
| `src/routes/register.ts`                     | `driverRoutes` from `@modules/drivers/routes`                                        | ✅ sub-barrel            | LOW          |
| `rides/controllers/ride-state.controller.ts` | `DriverRepository`, `DriverNotFoundError` — **deep paths**                           | ❌ **private internals** | **HIGH**     |
| `tests/integration/geo-nearby.test.ts`       | `DriverLocationRepository` — deep                                                    | ❌                       | MEDIUM       |
| `tests/unit/drivers/*` (3 files)             | `StatusService`, `location.service`, `location-plausibility`, `driver.errors` — deep | ❌                       | MEDIUM       |

**`src/jobs/workers/index.ts` resolves `'heartbeatTimeoutJob'` and `'docExpirationJob'` by DI _string token_, not import** — a rename fails silently at cron time, not at compile time. `CODE VERIFIED`

### 10.3 Circular dependency assessment

> **None today.** `drivers → geo` and `rides → drivers` are both one-directional; `geo` imports nothing from `drivers`. `CODE VERIFIED`
>
> **Two future cycle risks:**
>
> 1. **`drivers → auth` for `grantRole`** would create `auth → drivers` (via `driver-access.repository.ts`) **+ `drivers → auth`** = a **cycle**. This is a concrete argument for implementing the role grant as a **`driver.verified` event subscriber registered in `auth`** rather than a direct call. `INFERENCE`
> 2. **`drivers → rides`** must never be added. Rides depends on Drivers; the reverse would cycle.

---

## 11. Current Structural Problems

**Classification: `C — Mixed`.** `CODE VERIFIED`

Horizontal technical layers at the module root, with a **partial vertical split inside `services/` only**. Each `services/<domain>/` holds a service file and a barrel — no controllers, repositories, schemas, or routes.

| #   | Problem                                                                                                               | Evidence                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P1  | **Split is one layer deep.** 5 service folders exist; the other 5 layers stay flat                                    | `services/{location,onboarding,shift,status,wallet}` vs flat `controllers/`, `repositories/`, `schemas/`, `routes/` |
| P2  | **Documents have no owner.** Spread across 5 files in 3 layers; write path inside the _onboarding_ service            | §5D                                                                                                                 |
| P3  | **`OnboardingService` holds 4 concerns** — onboarding, profile, documents, approval                                   | §4.1                                                                                                                |
| P4  | **13 routes in one flat file** spanning 5 domains                                                                     | `routes/driver.routes.ts`                                                                                           |
| P5  | **5 schemas for 4 domains in one file**                                                                               | `schemas/driver.schemas.ts`                                                                                         |
| P6  | **Layer inversion in shifts.** `StatusService` reaches past `ShiftService` (dead) straight to `DriverShiftRepository` | §12                                                                                                                 |
| P7  | **Rides deep-imports Driver internals** — breaks on any move                                                          | §10.2                                                                                                               |
| P8  | **No `shared/`** — `driver-identity.ts` sits in `controllers/` but is used by 4 controllers + Rides                   |
| P9  | **No empty scaffolding exists.** `find … -type d -empty` → nothing. There is nothing to move _into_                   |

**Not a problem:** the `services/<domain>/` split is a sound direction, and `services/location/` (service + helper + barrel) is the best-formed submodule — a usable template.

---

## 12. Existing Empty / Unused / Dead Code

`CODE VERIFIED` — every item verified by searching imports, DI registrations, route handlers, event consumers, and tests.

| Item                                                                          | Class            | Evidence                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugins/driver.plugin.ts` + barrel                                           | `DEAD_OR_UNUSED` | Wraps `driverRoutes` with a prefix; `routes/register.ts` registers `driverRoutes` **directly**. Same for `ridePlugin`, `filePlugin`, `paymentPlugin`, `userPlugin` |
| `schemas/driver.responses.ts`                                                 | `DEAD_OR_UNUSED` | `DriverView`, `DriverShiftView` — exported via barrel, **zero references**                                                                                         |
| `repositories/driver-bank.repository.ts`                                      | `DEAD_OR_UNUSED` | DI-registered, **zero callers**                                                                                                                                    |
| `services/shift/shift.service.ts` + barrel                                    | `DEAD_OR_UNUSED` | `getActiveShift` exposed as `driverService.shift`; **nothing reads it**                                                                                            |
| `DriverWalletRepository.lockForUpdate`                                        | `DEAD_OR_UNUSED` | Zero callers                                                                                                                                                       |
| `InvalidDriverStatusTransitionError`, `DocumentValidationError`               | `DEAD_OR_UNUSED` | Zero throw sites                                                                                                                                                   |
| `DriverMetrics.heartbeatTimeout()`                                            | `DEAD_OR_UNUSED` | Not called even by `HeartbeatTimeoutJob`                                                                                                                           |
| `driver.document_expired`, `shift_started`, `shift_ended`, `location_updated` | `DEAD_OR_UNUSED` | Declared in the catalog, **never published**                                                                                                                       |
| `DriverVerificationStatus.SUSPENDED`                                          | `DEAD_OR_UNUSED` | Enum value never written; suspension uses the `isSuspended` boolean                                                                                                |
| `driverConfig.requireApprovedDocuments` (default `true`)                      | `DEAD_OR_UNUSED` | **Zero consumers — the flag for the missing document gate**                                                                                                        |
| `driverConfig.maxContinuousShiftHours` (12)                                   | `DEAD_OR_UNUSED` | Zero consumers                                                                                                                                                     |
| **Empty directories**                                                         | —                | **NONE.** `find src/modules/drivers -type d -empty` → no output                                                                                                    |

**Inert but correctly wired:** `DocExpirationJob` is scheduled, DI-resolved, Redis-locked — and its query requires `verificationStatus: 'VERIFIED'`, which no production code writes. Permanently a no-op.

---

## 13. Duplicate Logic

`CODE VERIFIED`

| #   | Duplication                                                      | Locations                                                                                                                                              | Severity                                                                                                                                |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **`actingDriverId` implemented twice**                           | `drivers/controllers/driver-identity.ts:7-13` and a private copy in `rides/controllers/ride-state.controller.ts:17-22`                                 | **Security-relevant** — two copies of an authorization mapping can drift                                                                |
| D2  | **Two write paths to `users.email`**                             | `users`: `UserService.updateProfile` → `UserRepository.updateEmail` ✅ · `drivers`: `DriverRepository.updateProfile` → raw `client.user.update` ❌     | **HIGH** — the correct helper was added in this changeset and is unused; collision returns **500 not 409**; `isEmailVerified` unmanaged |
| D3  | **Two `updateVerificationStatus` state machines in one service** | `OnboardingService` calls both `driverRepo.updateVerificationStatus` (driver status) and owns `submitDocument` (document status)                       | MEDIUM — identical names, different machines                                                                                            |
| D4  | **Three authorization vocabularies**                             | role slugs (enforced) · `PERMISSION_SEED`/`ROLE_PERMISSIONS` (seeded, `findAllowedCodesForUser` **zero callers**) · Files' hardcoded `SCOPES_FOR_ROLE` | MEDIUM                                                                                                                                  |
| D5  | **Five unused module `plugins/`**                                | drivers, rides, files, payments, users                                                                                                                 | LOW — delete as a set                                                                                                                   |

---

## 14. Circular Dependency Risks

Covered in §10.3. **Zero cycles today.** Two future risks: `drivers → auth` (mitigate with an event subscriber in `auth`), and `drivers → rides` (never add).

---

## 15. Recommended Target Driver Structure

Based on actual existing code. **Every folder below has real files to fill it — no invented scaffolding.**

```
src/modules/drivers/
├── onboarding/        controllers/ services/ schemas/ routes/ utils/
│                      ← onboardDriver, updateProfile, getMe, driver-code.util
├── documents/         controllers/ services/ repositories/ schemas/ routes/ jobs/
│                      ← submitDocument, driver-document.repository, doc-expiration.job
│                        (+ the missing review service lands here)
├── verification/      controllers/ services/ schemas/ routes/
│                      ← reviewDriverVerification (+ the missing grantRole hook)
├── status/            controllers/ services/ repositories/ schemas/ routes/ jobs/
│                      ← StatusService, driver-status.repository, heartbeat-timeout.job
├── shifts/            services/ repositories/
│                      ← driver-shift.repository (+ ShiftService, if revived)
├── location/          controllers/ services/ repositories/ schemas/ routes/
│                      ← LocationService, location-plausibility, driver-location.repository
├── wallet/            controllers/ services/ repositories/ routes/
│                      ← DriverWalletViewService, driver-wallet.repository
├── shared/
│   ├── authorization/driver-identity.ts     (4 controllers + rides)
│   ├── repositories/driver.repository.ts    (aggregate root, 4 submodules + rides)
│   ├── events/catalog.ts
│   ├── metrics/driver.metrics.ts
│   ├── schemas/error-response.ts
│   └── driver.types.ts · driver.errors.ts · driver.constants.ts
├── routes/index.ts    composes submodule routes under /api/v1/drivers
└── index.ts           DI registration + stable public barrel
```

**Four evidence-based adjustments to the example structure in the brief:**

| Adjustment                   | Reason                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`verification/` added**    | `reviewDriverVerification` is neither onboarding nor documents. It is the driver-approval state machine and will host the `grantRole` hook. Folding it into `documents/` would repeat the exact confusion in D3 |
| **`profile/` NOT added**     | Profile is two methods on one service and one schema. A separate submodule for `updateProfile` alone would be scaffolding without substance. Keep it in `onboarding/`                                           |
| **`eligibility/` NOT added** | Eligibility is decided _inside_ `StatusService.setOnline`. There is no standalone eligibility code to move. Extracting it is a **Phase 6 logic change**, not a placement move                                   |
| **`earnings/` NOT added**    | Zero Drivers code; Payments owns it. Creating it invites duplicating the ledger                                                                                                                                 |

**Cost:** ~35 file moves, ~60 import updates, 20 DI path changes, 5 route splits, 3 service splits, 6 test-import updates.

> **Lower-risk alternative — recommended first:** extract **only** `documents/` and `verification/` (~8 moves, ~15 import updates). That captures the single genuine placement defect and gives the missing review feature a home, at ~20 % of the cost. Decide on the full split afterwards. `INFERENCE`

---

## 16. What MUST Remain Outside Drivers

`CODE VERIFIED` for every "what Drivers uses"; `INFERENCE` for the boundary rationale.

| Module                      | Must own                                                                                                                                                                 | Why it must not move into Drivers                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`auth`**                  | OTP send/verify · JWT/sessions/refresh · **roles, `grantRole`, `revokeRole`** · security epoch · `authorize()` · `requireOperableDriver` + `driver-access.repository.ts` | Platform-wide. Driver App calls the **same two OTP endpoints** as Customer. Duplicating splits the audit trail and rate-limit budget. Moving the access repo would create a **cycle** (§10.3) |
| **`users`**                 | `User` identity · **`users.email`** · `UserProfile` · account deletion                                                                                                   | `Driver` is a 1:1 optional extension of `User`. **Do not add email to `DriverProfile`** — fix the driver path to call `UserRepository.updateEmail`                                            |
| **`files`**                 | Upload, storage, ownership, purpose policy, scanning, retention, `registerFileReference`                                                                                 | `DRIVER_DOCUMENT` purpose **already defined** with a `drivers:verify` operator scope and a `DRIVER_RELATIONSHIP_ENDED` retention rule. Drivers should hold a `fileId`, not bytes or URLs      |
| **`geo`**                   | Spatial index, H3, PostGIS search, `nearby-driver.service.ts`, coordinate schemas                                                                                        | Drivers already calls this correctly. `nearby-driver.service.ts` is named "driver" but is a **spatial query**                                                                                 |
| **`documents`**             | _(stub — nothing today)_                                                                                                                                                 | Do **not** move driver documents here. Driver KYC types are driver-specific; `VehicleDocument` is already separate (§7.1)                                                                     |
| **`onboarding`**            | _(stub — nothing today)_                                                                                                                                                 | Do **not** move driver onboarding here. It is driver creation, not a generic workflow engine (§7.2)                                                                                           |
| **`vehicles`**              | Vehicle registry, RC/insurance/PUC, `VehicleAssignment`, `currentVehicleId`                                                                                              | Complete schema, no code. Do not absorb                                                                                                                                                       |
| **`payments`**              | Ledger, settlement, payouts, **earnings**                                                                                                                                | Owns all money movement. Drivers keeps a read projection only                                                                                                                                 |
| **`matching` / `dispatch`** | Candidate selection, offer orchestration                                                                                                                                 | Primitives live in `rides/`; both stubs. Do not pull offers into Drivers                                                                                                                      |
| **`rides`**                 | Ride lifecycle and state machine                                                                                                                                         | Rides depends on Drivers — never the reverse                                                                                                                                                  |
| **`admin` / `support`**     | Operator surface (list, filter, queue, audit)                                                                                                                            | Both stubs. **Business rules stay in Drivers**; Admin should call Driver services, not copy them (§17)                                                                                        |
| **`notifications`**         | Delivery channels                                                                                                                                                        | SMS only today                                                                                                                                                                                |
| **`core`**                  | `TransactionManager`, outbox, DI, cache, metrics                                                                                                                         | Platform infrastructure                                                                                                                                                                       |

---

## 17. Current-Path → Target-Path Move Table

⭐ = minimal first pass (documents + verification only). `A` = full vertical split.

```
── DOCUMENTS ────────────────────────────────────────────────────────────────
MOVE  drivers/repositories/driver-document.repository.ts
   →  drivers/documents/repositories/driver-document.repository.ts          ⭐
      REASON: sole owner of driver_documents; co-locate with the missing review service
      IMPORTS: 3 (onboarding.service, status.service, doc-expiration.job) + drivers/index.ts
      DEPENDENTS: none outside drivers            RISK: LOW
      ⚠️ DI token `driverDocumentRepository` MUST NOT change

MOVE  drivers/jobs/doc-expiration.job.ts → drivers/documents/jobs/            ⭐
      IMPORTS: drivers/index.ts, jobs/index.ts barrel   RISK: MEDIUM
      ⚠️ DI token `docExpirationJob` resolved BY STRING in src/jobs/workers/index.ts

SPLIT drivers/services/onboarding/onboarding.service.ts                       ⭐
   →  KEEP onboardDriver + updateProfile        (onboarding/services/)
   →  MOVE submitDocument            → drivers/documents/services/document-submission.service.ts
   →  MOVE reviewDriverVerification  → drivers/verification/services/driver-verification.service.ts
      REASON: 4 concerns in one class (§4.1)
      IMPORTS: +2 DI registrations, driverService.inject() map
      RISK: MEDIUM — code edit, not a pure move

SPLIT drivers/controllers/driver-onboarding.controller.ts                     ⭐
   →  KEEP getMe + onboard + updateProfile
   →  MOVE submitDocument     → drivers/documents/controllers/
   →  MOVE reviewVerification → drivers/verification/controllers/
      ⚠️ FIX THE MISSING IMPORT FIRST (Stage 0)          RISK: MEDIUM

SPLIT drivers/schemas/driver.schemas.ts
   →  submitDriverDocumentSchema → drivers/documents/schemas/                 ⭐
   →  reviewVerificationSchema   → drivers/verification/schemas/              ⭐
   →  updateDriverProfileSchema  → drivers/onboarding/schemas/                A
   →  updateLocationSchema       → drivers/location/schemas/                  A
   →  heartbeatSchema            → drivers/status/schemas/                    A
      RISK: LOW — each schema has exactly one consumer

SPLIT drivers/routes/driver.routes.ts
   →  POST /:driverId/documents → drivers/documents/routes/                   ⭐
   →  POST /:id/verify          → drivers/verification/routes/                ⭐
   →  remaining 11 routes       → per-submodule route files                   A
      ⚠️ ROUTE PATHS MUST NOT CHANGE — tests/integration/route-graph.test.ts

── FULL SPLIT (Option A only) ───────────────────────────────────────────────
MOVE  repositories/driver-status.repository.ts   → status/repositories/       A  LOW
MOVE  repositories/driver-location.repository.ts → location/repositories/     A  MEDIUM (test deep-imports)
MOVE  repositories/driver-shift.repository.ts    → shifts/repositories/       A  LOW
MOVE  repositories/driver-wallet.repository.ts   → wallet/repositories/       A  LOW
MOVE  controllers/driver-{status,location,wallet}.controller.ts → <domain>/controllers/  A  LOW
MOVE  jobs/heartbeat-timeout.job.ts              → status/jobs/               A  MEDIUM
      ⚠️ DI token `heartbeatTimeoutJob` resolved BY STRING
MOVE  services/{location,onboarding,shift,status,wallet}/* → <domain>/services/  A  LOW
MOVE  utils/driver-code.util.ts                  → onboarding/utils/          A  LOW
MOVE  controllers/driver-identity.ts             → shared/authorization/      A  ⚠️ HIGH
      SECURITY-CRITICAL — 5 callers documented (§4.5, §10.2). Move alone, own commit
MOVE  repositories/driver.repository.ts          → shared/repositories/       A  ⚠️ HIGH
      rides/controllers/ride-state.controller.ts DEEP-IMPORTS this — convert to barrel FIRST
MOVE  events/catalog.ts → shared/events/ · metrics/ → shared/metrics/         A  LOW
MOVE  types/ errors/ constants/ schemas/error-response.ts → shared/           A  LOW

── KEEP (must not enter Drivers) ────────────────────────────────────────────
KEEP  auth/services/otp/**                    → auth    Driver reuses OTP; never duplicate
KEEP  auth/services/auth.service.ts           → auth    grantRole/revokeRole/ensureDefaultRole
KEEP  auth/plugins/auth.plugin.ts             → auth    authorize(), requireOperableDriver
KEEP  auth/repositories/driver-access.repository.ts → auth  Moving creates a cycle (§9.1)
KEEP  users/**                                → users   User identity + users.email
KEEP  files/**                                → files   DRIVER_DOCUMENT purpose already defined
KEEP  geo/services/nearby-driver.service.ts   → geo     Spatial search, not driver domain
KEEP  payments/**                             → payments  Earnings/settlement/payouts
KEEP  rides/**, vehicles/**, notifications/**, core/**
KEEP  src/config/driver/driver.config.ts      → config  Platform-wide config convention

── DELETE (only after Stage 5) ──────────────────────────────────────────────
DELETE drivers/plugins/**                     Zero callers (with the other 4 plugins)
DELETE drivers/schemas/driver.responses.ts    Zero references
DELETE DriverWalletRepository.lockForUpdate   Zero callers
DECIDE drivers/repositories/driver-bank.repository.ts   Keep for payouts, or delete
DECIDE drivers/services/shift/shift.service.ts          Revive (invert layer) or delete

── CREATE (Stage 6+, NOT during reorganization) ─────────────────────────────
CREATE documents/services → verifyDocument()            P0 — the missing review writer
CREATE documents/routes   → admin document review route P0
CREATE verification/      → document-completeness gate  P0 (wire requireApprovedDocuments)
CREATE grantRole hook on driver.verified                P0 — subscriber in auth (§10.3)
CREATE tests/integration/driver-*.test.ts               Stage 0 — HTTP smoke tests
```

---

## 18. Safe Staged Refactor Plan

**Rule: no stage mixes file movement with business-logic change.**

### Stage 0 — Preconditions (blocking)

| #   | Action                                                                                                                                                      | Current state                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 0.1 | **Fix the build.** Add `DriverNotFoundError` import (`driver-onboarding.controller.ts:18`); `catch (err: unknown)` + narrowing (`onboarding.service.ts:39`) | ❌ **FAILS** `BUILD VERIFIED` |
| 0.2 | **Land or stash the uncommitted changeset** — 13 files, 5 in `drivers/`, mid-rewrite of the exact code being moved                                          | ❌ **DIRTY**                  |
| 0.3 | Add `typecheck` + `lint` to CI — `tsx` strips types, so 714 tests pass over a non-compiling tree                                                            | ❌ absent                     |
| 0.4 | **Add HTTP smoke tests for all 13 driver routes** — currently **zero** exist                                                                                | ❌ **absent**                 |
| 0.5 | Convert external deep imports to barrel imports (`rides/controllers/ride-state.controller.ts` + 4 tests)                                                    | ❌ deep                       |
| 0.6 | Baseline `npm run typecheck && npm run lint && npm run test:unit`                                                                                           | —                             |

**Exit:** typecheck ✅ · lint ✅ · 714 unit ✅ · 13 smoke tests ✅ · tree committed.

### Stage 1 — Safe moves (obvious ownership, low risk)

`driver-document.repository.ts` → `documents/repositories/`; `doc-expiration.job.ts` → `documents/jobs/`. Pure relocations. **DI token names unchanged.**
**Verify:** `di-wiring.test.ts`, `route-graph.test.ts`, smoke tests, typecheck, lint.

### Stage 2 — Internal Driver structure cleanup

Split `OnboardingService` and `DriverOnboardingController` three ways (onboarding / documents / verification); split the schemas and the two routes. **No behaviour change.**

### Stage 3 — Cross-module dependency cleanup

Rides imports `driver-identity.ts` instead of its private copy (D1). Driver email path calls `UserRepository.updateEmail` (D2). Optionally move `driver-identity.ts` and `driver.repository.ts` into `shared/` — **security-critical, own commits**.

### Stage 4 — Route / DI / job / event registration verification

Confirm all 13 route paths unchanged (`route-graph.test.ts`); all 20 DI tokens resolve (`di-wiring.test.ts`); both cron string tokens resolve; event type strings unchanged (§20).

### Stage 5 — Tests after movement

Update deep imports in 4 test files; re-run unit + smoke; run integration if infrastructure is available; delete the dead set in one commit; refresh the stale `README.md`.

### Stage 6+ — Missing production transitions (**first stage with logic changes**)

Document review service + route; completeness gate via the existing `requireApprovedDocuments` flag; `grantRole` on approval; suspend deadlock; Files `fileId` integration; then the full-lifecycle integration test with zero direct database writes.

---

## 19. Customer-Flow Safety Analysis

**Will restructuring break any of these?** `CODE VERIFIED` unless noted.

| Flow                         | Touched by a Driver-module move?             | Why                                                                                                                     |
| ---------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Customer OTP / login         | **NO**                                       | `auth` module; Customer path imports nothing from `drivers/`                                                            |
| Customer role assignment     | **NO**                                       | `ensureDefaultRole` in `auth`                                                                                           |
| Driver OTP / login           | **NO**                                       | Identical shared `auth` path                                                                                            |
| JWT authentication           | **NO**                                       | `authPlugin` in `auth`                                                                                                  |
| Role loading                 | **NO**                                       | `RoleRepository` in `auth`                                                                                              |
| User creation                | **NO**                                       | `AuthService.resolveAccount`                                                                                            |
| File upload                  | **NO**                                       | `files` module; Drivers does not import it                                                                              |
| Document access              | **NO**                                       | `files` access policy unchanged                                                                                         |
| Driver onboarding            | **YES** — files move                         | Route paths unchanged; guarded by smoke tests + `route-graph.test.ts`                                                   |
| Driver profile               | **YES** — files move                         | ⚠️ Also touched by the uncommitted changeset → Stage 0 must land first                                                  |
| Admin driver review          | **YES** — route file moves                   | Path `/api/v1/drivers/:id/verify` unchanged                                                                             |
| Driver verification          | **YES** — service splits                     | Behaviour unchanged in Stages 1–5                                                                                       |
| Online / offline / heartbeat | **YES (Option A)** — files move              | Guarded by `di-wiring.test.ts`                                                                                          |
| Location                     | **YES (Option A)** — files move              | ⚠️ `geo-nearby.test.ts` deep-imports the repository                                                                     |
| Geo integration              | **NO**                                       | `drivers → geo` via the public barrel; geo unchanged                                                                    |
| Ride authorization           | **⚠️ INDIRECT**                              | `ride-state.controller.ts` **deep-imports** `DriverRepository` + `driver.errors` — **breaks on move**. Fix in Stage 0.5 |
| Payments                     | **NO**                                       | No import edge either direction                                                                                         |
| Events / jobs                | **NO**                                       | Type strings and DI token names, not paths (§20)                                                                        |
| DI registrations             | **YES** — import paths in `drivers/index.ts` | One file; **token names must not change**                                                                               |
| Route registration           | **NO**                                       | `routes/register.ts` imports the sub-barrel                                                                             |

> **Overall: the Customer flow is safe.** The only inbound production edges to `drivers/` are `core/di.ts`, `routes/register.ts`, and `rides/controllers/ride-state.controller.ts`. The first two use barrels; the third is the single real hazard and is fixed in Stage 0.

---

## 20. Build / Lint / Test Status

`BUILD VERIFIED` — re-executed this session against the current tree.

| Check                               | Result                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc -p tsconfig.json --noEmit` | **FAIL** — `driver-onboarding.controller.ts(18,28): error TS2304: Cannot find name 'DriverNotFoundError'`                 |
| `npm run lint`                      | **FAIL** — 1 error (`--max-warnings=0`): `onboarding.service.ts:39:19 Unexpected any`                                     |
| `npm run build`                     | **FAIL** — `clean` runs, `tsc` fails, `tsc-alias` never runs → `dist/` keeps `require("@core/auth")` → `MODULE_NOT_FOUND` |
| `npm run prisma:validate`           | **PASS**                                                                                                                  |
| `npm run test:unit`                 | **PASS — 714/714, 142 suites** (reproducible)                                                                             |
| `npm run test:integration`          | **NOT_VERIFIABLE** — no Postgres/Redis; Docker daemon unavailable                                                         |
| `npm run format:check`              | **FAIL** — 29 files                                                                                                       |
| Working tree                        | **DIRTY** — 13 modified files, 5 in `drivers/`                                                                            |

**Event/job registration integrity (relevant to moves):** event identity is by **type string** in `DRIVER_EVENT_CATALOG`, and `OutboxRelay` → `EventBus.emit(type)`; no consumer resolves by file path → **zero impact from moves**. Jobs resolve by **DI string token** in `src/jobs/workers/index.ts` → **token names must not change**. `tests/unit/di-wiring.test.ts` statically parses `src/` for `asClass`/constructor params and therefore **follows moved files automatically** — the single best guard for this refactor. `TEST VERIFIED`

---

## 21. P0 Blockers

**P0-1 — Tree does not compile, lint, or build; `dist/` is unrunnable.** Two lines, both uncommitted. **Nothing may move until fixed.** `BUILD VERIFIED`

**P0-2 — Uncommitted 13-file changeset is mid-rewrite of the files to be moved.** Moving files under it will produce conflicts that are hard to reason about. `CODE VERIFIED`

**P0-3 — Zero HTTP tests for any of the 13 driver routes.** A refactor could break onboarding, profile, documents, verification, online, or location **without a single test failing**. `TEST VERIFIED`

**P0-4 — `rides/controllers/ride-state.controller.ts` deep-imports Driver internals.** Breaks on any move of `driver.repository.ts` or `driver.errors.ts`. `CODE VERIFIED`

**P0-5 — No production writer for `DriverDocument.verificationStatus = VERIFIED`.** Only `upsertDocument` (`PENDING`) and `DocExpirationJob` (`REJECTED`) exist. Blocks the whole lifecycle. _(Stage 6 — not a placement issue.)_ `CODE VERIFIED`

**P0-6 — `grantRole` never called; `drivers/` does not import `auth`.** The `driver` role is never granted. _(Stage 6.)_ `CODE VERIFIED`

**P0-7 — Driver approvable with zero documents;** `requireApprovedDocuments` exists, defaults to `true`, has zero consumers. _(Stage 6.)_ `CODE VERIFIED`

**P0-8 — Documents bypass Files entirely** — `fileUrl: z.string().url()` accepts any client URL. _(Stage 6; needs a schema change.)_ `CODE VERIFIED`

---

## 22. P1 Issues

| #     | Issue                                                                                        | Class              |
| ----- | -------------------------------------------------------------------------------------------- | ------------------ |
| P1-1  | `submitDocument` + `reviewDriverVerification` inside the onboarding service                  | `DUPLICATED_LOGIC` |
| P1-2  | Raw `client.user.update` for email; `UserRepository.updateEmail` unused; 500 not 409         | `DUPLICATED_LOGIC` |
| P1-3  | `actingDriverId` duplicated in Rides — security-relevant drift risk                          | `DUPLICATED_LOGIC` |
| P1-4  | `POST /drivers/:id/suspend` nested-transaction self-deadlock                                 | Logic              |
| P1-5  | Availability split across 3 stores; suspension may leave them inconsistent                   | Logic              |
| P1-6  | Location ingestion has no eligibility gate; unverified/suspended drivers enter the geo index | Security           |
| P1-7  | 13 routes / 5 schemas in single files spanning 5 domains                                     | Structural         |
| P1-8  | Layer inversion in shifts — `StatusService` bypasses the dead `ShiftService`                 | Structural         |
| P1-9  | No `shared/` — `driver-identity.ts` sits in `controllers/`                                   | Structural         |
| P1-10 | `driverConfig.requireApprovedDocuments` + `maxContinuousShiftHours` dead                     | Dead config        |
| P1-11 | `BUSY`/`ON_TRIP` never written; no one-active-ride guard                                     | Missing            |
| P1-12 | Licence expiry unchecked at go-online                                                        | Missing            |

---

## 23. P2 Cleanup Items

`plugins/driver.plugin.ts` + 4 sibling plugins · `schemas/driver.responses.ts` · `driver-bank.repository.ts` (decision) · `shift.service.ts` (decision) · `DriverWalletRepository.lockForUpdate` · `InvalidDriverStatusTransitionError`, `DocumentValidationError` · `DriverMetrics.heartbeatTimeout()` · 4 unpublished events · `DriverVerificationStatus.SUSPENDED` · stale `drivers/README.md` ("0 errors / 550 tests"; actual 1 error / 714 tests) · `format:check` 29 files · `:driverId` params parsed and ignored · `POST /me/onboard` returns `201` for an existing driver.

---

## 24. Final Production-Readiness Assessment for Restructuring

> ### 🚫 **NOT READY to begin restructuring — four Stage 0 preconditions**
>
> **The good news dominates the report.** The Driver module is far better isolated than the folder layout suggests: **one cross-domain dependency (`geo`), three inbound importers, zero circular dependencies, and zero files that need to move to another top-level module.** The `documents/`, `onboarding/`, and `vehicles/` sibling stubs are auto-generated scaffolding with identical boilerplate READMEs — they carry no ownership claim, and driver documents and driver onboarding correctly belong to the Driver domain.
>
> **The restructuring is therefore internal**, and smaller than feared: extract `documents/` and `verification/` as Driver submodules (~8 moves), optionally followed by a full vertical split (~35 moves).
>
> **Four things block starting:**
>
> 1. The tree does not compile or lint (two lines, uncommitted).
> 2. An uncommitted 13-file changeset is actively rewriting the files to be moved.
> 3. **Zero HTTP tests exist for any of the 13 driver routes** — the refactor would be unverifiable.
> 4. Rides deep-imports Driver internals and will break on the first move.
>
> All four are Stage 0, and realistically well under a day's work.
>
> **One architectural decision should be made before Stage 6, not during it:** the role-assignment mechanism. A direct `drivers → auth` call for `grantRole` would create the codebase's **first circular dependency**, since `auth` already reads the `drivers` table via `driver-access.repository.ts`. Implementing it as a **`driver.verified` subscriber registered inside `auth`** avoids the cycle entirely and matches the only existing consumer pattern (`EpochInvalidationConsumer`). The evidence favours the subscriber; the choice is the owner's. `REQUIRES DECISION`
>
> **Sequence:** Stage 0 → extract `documents/` + `verification/` → verify → decide on the full split → only then Stage 6 logic work. Implementing document review _before_ extracting `documents/` would place new code in the wrong folder and require moving it twice.

---

DRIVER MODULE OWNERSHIP AND CODE PLACEMENT INVESTIGATION COMPLETE — NO CODE CHANGES MADE.
