# Driver Module — Code Placement Audit

**Repository:** `backend_zaroorat`
**Branch:** `feature/auth` · **HEAD:** `273aadb`
**Date:** 2026-08-18
**Scope:** Investigation only. No production code modified, no schema change, no migration, no refactor, no Speckit artifact.

**Evidence labels:** `ZAROORAT CODEBASE` (proven from code) · `TEST EVIDENCE` · `BUILD EVIDENCE` · `INFERENCE` (architectural recommendation)

**Placement classifications:**
`A` Correctly placed and used · `B` Correctly placed but unused · `C` Implemented but in wrong submodule · `D` Duplicate responsibility · `E` Empty/planned submodule · `F` Missing implementation · `G` Dead code · `H` Shared-module responsibility — must not move into Drivers

---

## 1. Executive Summary

> ### ⚠️ Three premises in the brief do not match the filesystem
>
> The brief states that submodule folders such as `drivers/onboarding/`, `drivers/documents/`, `drivers/status/`, `drivers/location/`, `drivers/wallet/`, `drivers/earnings/` were already created, and that "some of these folders may currently be empty." **Verified against disk, including untracked empty directories:**
>
> **(1) There are ZERO empty directories under `src/modules/drivers/`.**
>
> ```
> $ find src/modules/drivers -type d -empty
> (no output)
> ```
>
> Every directory that exists contains files. **There is no empty-folder scaffolding to move code into.** `ZAROORAT CODEBASE`
>
> **(2) No top-level Driver submodules exist.** The only subdivision is **inside the services layer**: `drivers/services/{location, onboarding, shift, status, wallet}`. There is no `drivers/onboarding/`, `drivers/documents/`, `drivers/status/`, `drivers/location/`, `drivers/wallet/`, `drivers/earnings/`, or `drivers/shifts/` at the module root. `ZAROORAT CODEBASE`
>
> **(3) `documents/` and `earnings/` do not exist inside Drivers at all.** What _does_ exist is `src/modules/documents/` and `src/modules/onboarding/` — **top-level sibling modules**, both `export {};` stubs. These are the most likely source of the confusion: they sit next to `drivers/`, not inside it. `ZAROORAT CODEBASE`

**What the architecture actually is.** A **horizontally layered** module (`controllers/`, `services/`, `repositories/`, `routes/`, `schemas/`, `events/`, `jobs/`, `metrics/`, `errors/`, `constants/`, `types/`, `utils/`, `plugins/`) with a **partial vertical split inside `services/` only**. Each `services/<domain>/` folder contains a service file and a barrel — nothing else. It is a hybrid, and it is internally consistent.

**Consequence for the brief's plan.** The task is _not_ "move code into empty folders." Converting to the target vertical-slice structure means **relocating five additional layers** (controllers, repositories, schemas, routes, events) for every submodule — a substantially larger change than the premise implies. §14 recommends a smaller alternative that gets most of the benefit.

**The one genuine placement defect.** Document handling has **no owner** and is split across three layers in three different folders, with its write path living inside the _onboarding_ service:

| Piece                     | Current path                                                     |
| ------------------------- | ---------------------------------------------------------------- |
| Document submission logic | `services/onboarding/onboarding.service.ts` → `submitDocument()` |
| Document persistence      | `repositories/driver-document.repository.ts`                     |
| Document expiry           | `jobs/doc-expiration.job.ts`                                     |
| Document schema           | `schemas/driver.schemas.ts` → `submitDriverDocumentSchema`       |
| Document route            | `routes/driver.routes.ts` → `POST /:driverId/documents`          |
| Document review           | **does not exist**                                               |

**Class `C` — implemented but in the wrong submodule.** This is the highest-value move in the audit, and it is also where the missing review capability will land, so doing the move first pays twice.

**The boundary that is already correct and must be defended.** Earnings/settlement lives in **Payments**; Drivers holds a read-only wallet projection. `grep -rln "earnings" src` returns **only three Payments files and zero Drivers files**. Do **not** create `drivers/earnings/`. `ZAROORAT CODEBASE`

**Build state (carried forward, re-verified):** the tree does not compile or lint — one unimported symbol in `driver-onboarding.controller.ts:18` and one `catch (err: any)` in `onboarding.service.ts:39`, both in **uncommitted** work that is mid-rewrite of the onboarding flow. **No file may be moved until this is green and committed** (§16 Phase 0). `BUILD EVIDENCE`

---

## 2. Current Driver Folder Tree

`ZAROORAT CODEBASE` — `find src/modules/drivers -type d | sort`, plus file listing. **All 19 directories, no omissions, none empty.**

```
src/modules/drivers/                        (54 files)
├── constants/
│   ├── driver.constants.ts                 DRIVER_VERIFICATION_STATUS, DRIVER_STATUS, DRIVER_DOCUMENT_TYPE
│   └── index.ts
├── controllers/
│   ├── driver.controller.ts                aggregate facade (4 sub-controllers)
│   ├── driver-identity.ts                  actingDriverId, authorizedDriverId
│   ├── driver-location.controller.ts
│   ├── driver-onboarding.controller.ts     getMe, onboard, updateProfile, submitDocument, reviewVerification
│   ├── driver-status.controller.ts
│   ├── driver-wallet.controller.ts
│   └── index.ts
├── errors/
│   ├── driver.errors.ts                    8 error classes (2 with zero throw sites)
│   └── index.ts
├── events/
│   ├── catalog.ts                          DRIVER_EVENT_CATALOG (8 types, 4 never published)
│   └── index.ts
├── jobs/
│   ├── doc-expiration.job.ts               ← DOCUMENT concern
│   ├── heartbeat-timeout.job.ts            ← STATUS concern
│   └── index.ts
├── metrics/
│   ├── driver.metrics.ts                   11 methods (1 never called)
│   └── index.ts
├── plugins/
│   ├── driver.plugin.ts                    DEAD — superseded by routes/register.ts
│   └── index.ts
├── repositories/
│   ├── driver.repository.ts                driver row + profile + verification status
│   ├── driver-bank.repository.ts           DEAD — zero callers
│   ├── driver-document.repository.ts       ← DOCUMENT concern
│   ├── driver-location.repository.ts       ← LOCATION concern
│   ├── driver-shift.repository.ts          ← SHIFT concern
│   ├── driver-status.repository.ts         ← STATUS concern
│   ├── driver-wallet.repository.ts         ← WALLET concern
│   └── index.ts
├── routes/
│   ├── driver.routes.ts                    all 13 routes, one flat file
│   └── index.ts
├── schemas/
│   ├── driver.schemas.ts                   5 Zod schemas spanning 4 submodules
│   ├── driver.responses.ts                 DEAD — types never referenced
│   ├── error-response.ts                   handleDriverError
│   └── index.ts
├── services/
│   ├── driver.service.ts                   aggregate facade (5 sub-services)
│   ├── index.ts
│   ├── location/                            ← the only vertical split, services-layer only
│   │   ├── index.ts
│   │   ├── location-plausibility.ts
│   │   └── location.service.ts
│   ├── onboarding/
│   │   ├── index.ts
│   │   └── onboarding.service.ts            onboard + profile + submitDocument + reviewDriverVerification
│   ├── shift/
│   │   ├── index.ts
│   │   └── shift.service.ts                 DEAD — getActiveShift has zero callers
│   ├── status/
│   │   ├── index.ts
│   │   └── status.service.ts
│   └── wallet/
│       ├── index.ts
│       └── wallet.service.ts                read-only projection
├── types/
│   ├── driver.types.ts                     Prisma re-exports
│   └── index.ts
├── utils/
│   ├── driver-code.util.ts
│   └── index.ts
├── index.ts                                DI registration (20 tokens) + barrel re-exports
└── README.md                               STALE — claims "0 errors / 550 tests"
```

**Absent, contrary to the premise:** `drivers/onboarding/`, `drivers/documents/`, `drivers/status/`, `drivers/location/`, `drivers/shifts/`, `drivers/wallet/`, `drivers/earnings/`, `drivers/shared/`, `drivers/consumers/`, `drivers/guards/`, `drivers/helpers/`, `driver.module.ts`.

---

## 3. Actual Production Execution Tree

`ZAROORAT CODEBASE` — only code reachable from a registered HTTP route. Registration is `src/routes/register.ts` → `app.register(driverRoutes, { prefix: '/api/v1/drivers' })`.

```
src/routes/register.ts
└── driverRoutes  (routes/driver.routes.ts)
    │   container.resolve('driverController')  ← DI, not import
    │   setErrorHandler(handleDriverError)     ← schemas/error-response.ts
    │
    ├── GET   /me                    → onboarding.getMe        → driverRepository.findByUserId
    │                                                            ⛔ DOES NOT COMPILE
    ├── POST  /me/onboard            → onboarding.onboard      → OnboardingService.onboardDriver
    │                                    → driverRepository.createDriver + utils/driver-code.util
    │                                    → eventPublisher(driver.onboarded) + driverMetrics
    ├── PATCH /:driverId/profile     → onboarding.updateProfile
    │                                    → controllers/driver-identity.actingDriverId
    │                                    → schemas.updateDriverProfileSchema
    │                                    → OnboardingService.updateProfile
    │                                    → driverRepository.updateProfile  ── raw client.user.update
    ├── POST  /:driverId/documents   → onboarding.submitDocument
    │                                    → schemas.submitDriverDocumentSchema
    │                                    → OnboardingService.submitDocument      ← DOCUMENT logic in ONBOARDING
    │                                    → driverDocumentRepository.upsertDocument
    ├── POST  /:id/verify            [authorize roles:['admin']]
    │                                → onboarding.reviewVerification
    │                                    → OnboardingService.reviewDriverVerification
    │                                    → driverRepository.lockForUpdate + updateVerificationStatus
    │                                    → eventPublisher(driver.verified)  ← ZERO SUBSCRIBERS
    ├── POST  /status/online         [authorize requireOperableDriver]
    │                                → status.setOnline → StatusService.setOnline
    │                                    → driverRepository.lockForUpdate
    │                                    → driverDocumentRepository.findByDriverId   ← DOCUMENT read in STATUS
    │                                    → driverShiftRepository.startShift          ← SHIFT write in STATUS
    │                                    → driverStatusRepository.updateStatus
    ├── POST  /status/offline        → status.setOffline
    │                                    → driverShiftRepository.endShift
    │                                    → geoService.forgetDriverPosition   ← GEO (shared)
    ├── POST  /heartbeat             → status.heartbeat → statusRepository.updateHeartbeat
    ├── POST  /:id/suspend           [authorize roles:['admin']]
    │                                → status.suspend → StatusService.setSuspended  ⛔ DEADLOCKS
    ├── POST  /location              [rateLimit]
    │                                → location.updateLocation → LocationService.updateLocation
    │                                    → services/location/location-plausibility
    │                                    → driverLocationRepository.updateLocation (raw PostGIS)
    │                                    → geoService.recordDriverPosition   ← GEO (shared)
    │                                    → driverStatusRepository.updateHeartbeat  ← STATUS write in LOCATION
    ├── GET   /:id/location          → location.getLocation → authorizedDriverId
    ├── GET   /:driverId/wallet      → wallet.getWallet → DriverWalletViewService
    └── GET   /:driverId/wallet/transactions → wallet.listTransactions

  Scheduled (src/jobs/scheduler → workers → DI), not HTTP:
    ├── driver-heartbeat-timeout  * * * * *  → heartbeatTimeoutJob → StatusService.setOffline
    └── driver-doc-expiration     0 2 * * *  → docExpirationJob    → driverDocumentRepository
                                                                      (inert — §8)

  Reachable from OUTSIDE drivers:
    └── rides/controllers/ride-state.controller.ts
          imports drivers/repositories/driver.repository.ts
          imports drivers/errors/driver.errors.ts        ← cross-module coupling
```

**Never reached from any route, job, or subscriber:** `plugins/driver.plugin.ts`, `repositories/driver-bank.repository.ts`, `services/shift/shift.service.ts`, `schemas/driver.responses.ts`.

**Three cross-submodule reaches inside the execution tree**, all in `StatusService` and `LocationService`, all legitimate coordination rather than misplacement (§6).

---

## 4. Complete File Inventory

All 54 files. `ZAROORAT CODEBASE`

| #   | File                                           | LOC | Domain                              | Used?               | Class     |
| --- | ---------------------------------------------- | --: | ----------------------------------- | ------------------- | --------- |
| 1   | `index.ts`                                     |  86 | module                              | ✅ DI + barrels     | A         |
| 2   | `README.md`                                    |   — | docs                                | ⚠️ stale            | A         |
| 3   | `constants/driver.constants.ts`                |  29 | shared                              | ✅                  | A         |
| 4   | `constants/index.ts`                           |   1 | shared                              | ✅                  | A         |
| 5   | `controllers/driver.controller.ts`             |  12 | module                              | ✅ routes           | A         |
| 6   | `controllers/driver-identity.ts`               |  24 | authz                               | ✅ 3 ctrls + rides  | A         |
| 7   | `controllers/driver-location.controller.ts`    |  37 | location                            | ✅                  | C         |
| 8   | `controllers/driver-onboarding.controller.ts`  |  82 | onboarding **+ documents + review** | ⚠️ **broken**       | C + D     |
| 9   | `controllers/driver-status.controller.ts`      |  52 | status                              | ✅                  | C         |
| 10  | `controllers/driver-wallet.controller.ts`      |  36 | wallet                              | ✅                  | C         |
| 11  | `controllers/index.ts`                         |   5 | module                              | ✅                  | A         |
| 12  | `errors/driver.errors.ts`                      |  66 | shared                              | ✅ 6/8 thrown       | A         |
| 13  | `errors/index.ts`                              |   1 | shared                              | ✅                  | A         |
| 14  | `events/catalog.ts`                            |  29 | shared                              | ✅ 4/8 published    | A         |
| 15  | `events/index.ts`                              |   1 | shared                              | ✅                  | A         |
| 16  | `jobs/doc-expiration.job.ts`                   |  45 | **documents**                       | ✅ cron (inert)     | C         |
| 17  | `jobs/heartbeat-timeout.job.ts`                |  40 | **status**                          | ✅ cron             | C         |
| 18  | `jobs/index.ts`                                |   2 | module                              | ✅                  | A         |
| 19  | `metrics/driver.metrics.ts`                    |  42 | shared                              | ✅ 10/11            | A         |
| 20  | `metrics/index.ts`                             |   1 | shared                              | ✅                  | A         |
| 21  | `plugins/driver.plugin.ts`                     |   8 | module                              | ❌ **zero callers** | G         |
| 22  | `plugins/index.ts`                             |   1 | module                              | ❌                  | G         |
| 23  | `repositories/driver.repository.ts`            | 133 | onboarding **+ verification**       | ✅                  | C + D     |
| 24  | `repositories/driver-bank.repository.ts`       |  46 | payouts                             | ❌ **zero callers** | B         |
| 25  | `repositories/driver-document.repository.ts`   |  85 | **documents**                       | ✅                  | C         |
| 26  | `repositories/driver-location.repository.ts`   |  58 | **location**                        | ✅                  | C         |
| 27  | `repositories/driver-shift.repository.ts`      |  44 | **shifts**                          | ✅                  | C         |
| 28  | `repositories/driver-status.repository.ts`     |  78 | **status**                          | ✅                  | C         |
| 29  | `repositories/driver-wallet.repository.ts`     |  44 | **wallet**                          | ⚠️ 2/3 methods      | C         |
| 30  | `repositories/index.ts`                        |   7 | module                              | ✅                  | A         |
| 31  | `routes/driver.routes.ts`                      |  44 | **all 5 domains**                   | ✅                  | C         |
| 32  | `routes/index.ts`                              |   1 | module                              | ✅                  | A         |
| 33  | `schemas/driver.schemas.ts`                    |  54 | **4 domains**                       | ✅                  | C         |
| 34  | `schemas/driver.responses.ts`                  |  20 | module                              | ❌ **zero refs**    | G         |
| 35  | `schemas/error-response.ts`                    |  22 | shared                              | ✅                  | A         |
| 36  | `schemas/index.ts`                             |   3 | module                              | ✅                  | A         |
| 37  | `services/driver.service.ts`                   |  14 | module                              | ✅                  | A         |
| 38  | `services/index.ts`                            |   6 | module                              | ✅                  | A         |
| 39  | `services/location/location.service.ts`        |  69 | location                            | ✅                  | A         |
| 40  | `services/location/location-plausibility.ts`   |  62 | location                            | ✅                  | A         |
| 41  | `services/location/index.ts`                   |   2 | location                            | ✅                  | A         |
| 42  | `services/onboarding/onboarding.service.ts`    | 113 | onboarding **+ documents + review** | ✅                  | A + **D** |
| 43  | `services/onboarding/index.ts`                 |   1 | onboarding                          | ✅                  | A         |
| 44  | `services/shift/shift.service.ts`              |   8 | shifts                              | ❌ **zero callers** | B         |
| 45  | `services/shift/index.ts`                      |   1 | shifts                              | ❌                  | B         |
| 46  | `services/status/status.service.ts`            | 136 | status                              | ✅                  | A         |
| 47  | `services/status/index.ts`                     |   1 | status                              | ✅                  | A         |
| 48  | `services/wallet/wallet.service.ts`            |  11 | wallet                              | ✅                  | A         |
| 49  | `services/wallet/index.ts`                     |   1 | wallet                              | ✅                  | A         |
| 50  | `types/driver.types.ts`                        |  33 | shared                              | ✅                  | A         |
| 51  | `types/index.ts`                               |   1 | shared                              | ✅                  | A         |
| 52  | `utils/driver-code.util.ts`                    |   6 | onboarding                          | ✅                  | C         |
| 53  | `utils/index.ts`                               |   1 | module                              | ✅                  | A         |
| 54  | `schemas/…`/`services/…` barrels counted above |   — | —                                   | —                   | —         |

**Totals:** `A` 26 · `B` 3 · `C` 13 · `D` 3 (overlapping) · `G` 3 · unused 6.

---

## 5. Responsibility Map

The files where placement actually matters. `ZAROORAT CODEBASE`

### 5.1 `services/onboarding/onboarding.service.ts` — the central placement defect

| Field                              | Value                                                                                                                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current path**                   | `src/modules/drivers/services/onboarding/onboarding.service.ts`                                                                                                                                                                                                            |
| **Current responsibility**         | **Four distinct concerns in one class:** `onboardDriver` (onboarding) · `updateProfile` (onboarding) · `submitDocument` (**documents**) · `reviewDriverVerification` (**verification/approval**)                                                                           |
| **Actually used?**                 | ✅ All four, via `DriverOnboardingController`                                                                                                                                                                                                                              |
| **Routes**                         | `POST /me/onboard`, `PATCH /:driverId/profile`, `POST /:driverId/documents`, `POST /:id/verify`                                                                                                                                                                            |
| **Callers**                        | `DriverOnboardingController` only                                                                                                                                                                                                                                          |
| **Tests**                          | ❌ No test calls any of these routes. `TEST EVIDENCE`                                                                                                                                                                                                                      |
| **Correct location?**              | **NO — it is three services wearing one name**                                                                                                                                                                                                                             |
| **Target**                         | `onboarding/services/onboarding.service.ts` (`onboardDriver`, `updateProfile`) · `documents/services/document-submission.service.ts` (`submitDocument`) · `verification/services/driver-verification.service.ts` (`reviewDriverVerification`)                              |
| **Reason**                         | `submitDocument` writes `driver_documents` and is the natural home of the missing review capability. `reviewDriverVerification` is the approval state machine and will host the `grantRole` call. Neither is onboarding. Class **D — duplicate/overloaded responsibility** |
| **Moveable without logic change?** | **Splitting: yes, mechanically.** Requires 3 DI registrations instead of 1, a `DriverService` facade update, and a controller split                                                                                                                                        |

### 5.2 `repositories/driver.repository.ts` — two concerns

| Field                      | Value                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current responsibility** | Driver row CRUD + `DriverProfile` upsert + **`User.email` write** + `updateVerificationStatus` + `setSuspended` + `updateAvailability` + `lockForUpdate`                                               |
| **Used?**                  | ✅ services, controllers, jobs, **and `rides/controllers/ride-state.controller.ts`**                                                                                                                   |
| **Correct location?**      | **Partly.** `updateVerificationStatus` belongs with verification; `updateAvailability` is read/written by status; the raw `client.user.update({ data: { email } })` **belongs to the Users module**    |
| **Target**                 | Keep the core at `shared/repositories/driver.repository.ts`; the email write should delegate to `UserRepository.updateEmail` (added in the same uncommitted changeset and **not used**)                |
| **Reason**                 | It is the shared aggregate root — genuinely used by four submodules and one external module. Splitting it would create circular reads. **The email write is the real defect, not the file's location** |
| **Moveable?**              | Do **not** split. Fix the email path only                                                                                                                                                              |

### 5.3 `repositories/driver-document.repository.ts`

| Field                      | Value                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Current responsibility** | `upsertDocument`, `findByDriverId`, `updateVerificationStatus`, `findExpiredDocuments`                              |
| **Used?**                  | ✅ by `OnboardingService.submitDocument`, `StatusService.setOnline` (read), `DocExpirationJob`                      |
| **Correct location?**      | **NO — pure documents concern in a flat repositories folder**                                                       |
| **Target**                 | `documents/repositories/driver-document.repository.ts`                                                              |
| **Reason**                 | Sole owner of `driver_documents`. Co-locating it with the (missing) review service is what makes that feature small |
| **Moveable?**              | ✅ Yes — 3 import updates + 1 DI path. **Zero logic change**                                                        |

### 5.4 `jobs/doc-expiration.job.ts` and `jobs/heartbeat-timeout.job.ts`

| Field                 | `doc-expiration`                                                                                                                                                                                                                                       | `heartbeat-timeout`                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **Responsibility**    | Expire `VERIFIED` docs → `REJECTED`                                                                                                                                                                                                                    | Sweep stale `ONLINE` → `OFFLINE`           |
| **Used?**             | ✅ cron `0 2 * * *` — **but inert** (§8)                                                                                                                                                                                                               | ✅ cron `* * * * *`                        |
| **Correct location?** | **NO** — documents concern                                                                                                                                                                                                                             | **NO** — status concern                    |
| **Target**            | `documents/jobs/doc-expiration.job.ts`                                                                                                                                                                                                                 | `status/jobs/heartbeat-timeout.job.ts`     |
| **Moveable?**         | ✅ — **but the DI token name `docExpirationJob` must not change**: `MAINTENANCE_HANDLERS` in `src/jobs/workers/index.ts` resolves jobs **by string token**. Rename the token and the cron silently throws `No handler registered`. `ZAROORAT CODEBASE` | ✅ same constraint (`heartbeatTimeoutJob`) |

### 5.5 `routes/driver.routes.ts` — one file, five domains

13 routes spanning onboarding (4), documents (1), verification (1), status (4), location (2), wallet (2). `setErrorHandler` is registered once for the whole prefix.

**Target:** per-submodule route files composed by a `drivers/routes/index.ts` that preserves the `/api/v1/drivers` prefix and the single error handler.
**Constraint:** `tests/integration/route-graph.test.ts` enumerates the live route table and asserts the exact public set. **Route paths must not change** — only their source file. `TEST EVIDENCE`

### 5.6 `schemas/driver.schemas.ts` — four domains

`updateDriverProfileSchema` (onboarding) · `submitDriverDocumentSchema` (documents) · `updateLocationSchema` (location) · `heartbeatSchema` (status) · `reviewVerificationSchema` (verification).

Imports `latitudeSchema`/`longitudeSchema` from `@modules/geo` — **correct**; geo owns coordinate validation. Class `H` for that dependency.
**Target:** split per submodule. **Moveable:** ✅ trivially; each schema has exactly one consumer.

### 5.7 `controllers/driver-identity.ts` — authorization helpers

| Field                   | Value                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Responsibility**      | `actingDriverId(req, repo)` — JWT → Driver id; `authorizedDriverId(req, repo, requested?, staffRoles)` — own-or-staff                                                                                                                                                   |
| **Used?**               | ✅ `DriverOnboardingController`, `DriverStatusController`, `DriverLocationController`, `DriverWalletController`, **and `rides/controllers/ride-state.controller.ts` re-implements it privately**                                                                        |
| **Correct location?**   | **YES for the driver-specific part.** It resolves _Driver identity from User identity_ — a Driver-domain concern that depends on `DriverRepository`. It is **not** generic auth                                                                                         |
| **Target**              | `drivers/shared/authorization/driver-identity.ts`                                                                                                                                                                                                                       |
| **Reason**              | Used by ≥4 submodules → genuinely shared _within_ Drivers. Must **not** move into `core/auth`, which has no business depending on `DriverRepository`. `INFERENCE`                                                                                                       |
| **⚠️ Security caution** | The brief rightly says not to move security-critical authorization without documenting callers. **All five callers are listed above.** `RideStateController` has a **private duplicate** (`ride-state.controller.ts:17-22`) that should import this instead — Class `D` |

### 5.8 `controllers/driver-onboarding.controller.ts` — mirrors the service defect

Five methods: `getMe`, `onboard`, `updateProfile` (onboarding) · `submitDocument` (documents) · `reviewVerification` (verification/admin).
**Currently `BROKEN`** — `DriverNotFoundError` used at line 18 without an import. `BUILD EVIDENCE`
**Target:** split three ways, mirroring §5.1. **Fix the import before moving anything.**

### 5.9 `utils/driver-code.util.ts`

`generateDriverCode()` — one caller, `DriverRepository.createDriver`. Onboarding-only.
**Target:** `onboarding/utils/driver-code.util.ts`. **Moveable:** ✅ single import.

### 5.10 Dead files

| File                                     | Evidence of death                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/driver.plugin.ts`               | Wraps `driverRoutes` with a prefix; `routes/register.ts` registers `driverRoutes` **directly**. `grep driverPlugin src` → definition only. Same for `ridePlugin`, `filePlugin`, `paymentPlugin`, `userPlugin` |
| `schemas/driver.responses.ts`            | `DriverView`, `DriverShiftView` — exported via barrel, **zero references**                                                                                                                                    |
| `repositories/driver-bank.repository.ts` | DI-registered, **zero callers**. No route or service touches bank accounts                                                                                                                                    |
| `services/shift/shift.service.ts`        | `getActiveShift` — exposed as `driverService.shift`, **nothing reads it**. Shifts are managed directly via `DriverShiftRepository` from `StatusService`                                                       |
| `DriverWalletRepository.lockForUpdate`   | **Zero callers** (verified)                                                                                                                                                                                   |

---

## 6. Submodule Audit

### 6.1 Onboarding

|                        |                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Folder exists?**     | Only `services/onboarding/` (service layer). No top-level submodule                                                                                                                                                                                    |
| **Existing code**      | `OnboardingService.onboardDriver` + `updateProfile`; `DriverOnboardingController.getMe`/`onboard`/`updateProfile`; `DriverRepository.createDriver`/`updateProfile`; `updateDriverProfileSchema`; `utils/driver-code.util.ts`; `driver.onboarded` event |
| **Empty folders**      | **None**                                                                                                                                                                                                                                               |
| **Misplaced code**     | `submitDocument` and `reviewDriverVerification` **do not belong here** (§5.1). Controller and repository pieces sit in flat folders                                                                                                                    |
| **Missing code**       | Profile-completeness rule; `GET /me` returning 200-with-null; a required-document set                                                                                                                                                                  |
| **Production callers** | 3 routes ✅                                                                                                                                                                                                                                            |
| **Tests**              | ❌ **None** — no test calls `/me`, `/me/onboard`, or `/:driverId/profile`. `TEST EVIDENCE`                                                                                                                                                             |
| **Verdict**            | **Q1 answer: NO** — the folder is used only as a service-layer bucket, and it holds two foreign concerns                                                                                                                                               |

### 6.2 Documents

|                        |                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Folder exists?**     | **NO — not anywhere under `drivers/`.** (`src/modules/documents/` is a top-level `export {};` stub, unrelated)                                                                                                                          |
| **Existing code**      | Scattered across **five** locations: `services/onboarding/onboarding.service.ts` (`submitDocument`), `repositories/driver-document.repository.ts`, `jobs/doc-expiration.job.ts`, `schemas/driver.schemas.ts`, `routes/driver.routes.ts` |
| **Empty folders**      | None (the folder does not exist)                                                                                                                                                                                                        |
| **Misplaced code**     | **All of it.** Class `C` throughout                                                                                                                                                                                                     |
| **Missing code**       | **Document review** — no service, no route, no writer of `VERIFIED`. Also: no `EXPIRED` status; stale review metadata survives re-upload; Files integration absent (raw `fileUrl`)                                                      |
| **Production callers** | `POST /:driverId/documents` ✅; `StatusService.setOnline` reads documents; `DocExpirationJob` (inert)                                                                                                                                   |
| **Tests**              | ❌ None over HTTP. Fixtures insert `VERIFIED` documents directly. `TEST EVIDENCE`                                                                                                                                                       |
| **Verdict**            | **Q2 answer: NO — the folder does not exist and document code has no owner.** Highest-value reorganization target                                                                                                                       |

### 6.3 Status

|                           |                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Folder exists?**        | Only `services/status/`                                                                                                                                                                                                  |
| **Existing code**         | `StatusService` (setOnline/setOffline/recordHeartbeat/setSuspended); `DriverStatusController`; `DriverStatusRepository`; `heartbeatSchema`; `jobs/heartbeat-timeout.job.ts`; `driver.status_changed`, `driver.suspended` |
| **Misplaced code**        | Controller, repository, schema, job, routes all in flat folders                                                                                                                                                          |
| **Cross-submodule reads** | `setOnline` reads `DriverDocumentRepository` (licence gate) and writes `DriverShiftRepository`. **Legitimate coordination** — the status service is the eligibility decision point. `INFERENCE`                          |
| **Missing code**          | `BUSY`/`ON_TRIP`/`BREAK` writers; licence-expiry check; a single eligibility function                                                                                                                                    |
| **Broken code**           | `setSuspended` nested-transaction self-deadlock                                                                                                                                                                          |
| **Tests**                 | ⚠️ `tests/unit/drivers/verification-gate.test.ts` — mock-only, 7 `{} as never` deps; never reaches the licence check                                                                                                     |
| **Verdict**               | Service correctly placed; five supporting layers misplaced                                                                                                                                                               |

### 6.4 Shifts

|                    |                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Folder exists?** | `services/shift/` (**singular**; target names it `shifts/`)                                                                                                                                               |
| **Existing code**  | `ShiftService.getActiveShift` (**zero callers**); `DriverShiftRepository` (`findActiveShift`, `startShift`, `endShift`) — called from `StatusService`, **not** from `ShiftService`                        |
| **Misplaced code** | The repository is in the flat folder; the service is bypassed entirely                                                                                                                                    |
| **Missing code**   | `maxContinuousShiftHours` enforcement (config exists, **zero consumers**); every `DriverShiftLog` stat beyond `totalOnlineMinutes`; `driver.shift_started`/`shift_ended` are declared and never published |
| **Verdict**        | **Class `B`** — correctly placed, unused. The layer is inverted: the service should own shift logic and `StatusService` should call it, rather than reaching past it to the repository. `INFERENCE`       |

### 6.5 Location

|                           |                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Folder exists?**        | `services/location/` — **the best-organized submodule**: service + `location-plausibility.ts` helper + barrel                                |
| **Existing code**         | `LocationService`; `assessPlausibility`; `DriverLocationController`; `DriverLocationRepository` (raw PostGIS upsert); `updateLocationSchema` |
| **Misplaced code**        | Controller, repository, schema only                                                                                                          |
| **Cross-submodule write** | Writes `DriverStatusRepository.updateHeartbeat` — a location fix doubles as a heartbeat. **Reasonable**, worth documenting                   |
| **Shared dependency**     | `geoService.recordDriverPosition` — Class `H`, must stay in Geo                                                                              |
| **Missing code**          | Eligibility gate on ingestion; location history (`driver_location_history` in no migration); `driver.location_updated` never published       |
| **Tests**                 | ✅ `location-plausibility.test.ts`, `mock-location.test.ts` — genuine unit tests. Route never exercised                                      |
| **Verdict**               | **Closest to the target already.** Use it as the template for the others                                                                     |

### 6.6 Wallet

|                    |                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Folder exists?** | `services/wallet/`                                                                                                                         |
| **Existing code**  | `DriverWalletViewService` (`getWallet`, `listTransactions`) — **read-only projection**; `DriverWalletController`; `DriverWalletRepository` |
| **Dead**           | `DriverWalletRepository.lockForUpdate` — zero callers                                                                                      |
| **Ownership**      | **Payments owns all writes.** Drivers only reads. `ZAROORAT CODEBASE`                                                                      |
| **Missing code**   | Nothing in Drivers. Withdrawals/payouts are Payments'                                                                                      |
| **Tests**          | Indirect via `earnings-pipeline.test.ts`                                                                                                   |
| **Verdict**        | Correctly scoped. Do not expand it into money movement                                                                                     |

### 6.7 Earnings

|                              |                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Folder exists?**           | **NO — and it should not.**                                                                                                                                                                                                                                                |
| **Existing code in Drivers** | **None.** `grep -rln "earnings\|Earnings" src --exclude-dir=generated` → `payments/repositories/settlement.repository.ts`, `payments/services/ledger/ledger.service.ts`, `payments/services/settlement/settlement.service.ts`. **Zero Drivers files.** `ZAROORAT CODEBASE` |
| **Tests**                    | `tests/integration/earnings-pipeline.test.ts` resolves `SettlementService` from **Payments** and asserts double-entry ledger groups. `TEST EVIDENCE`                                                                                                                       |
| **Verdict**                  | **Class `H`.** Earnings is a Payments responsibility with a driver-scoped read projection in `services/wallet/`. **Do not create `drivers/earnings/`** — it would either be empty or duplicate the ledger. `INFERENCE`                                                     |

---

## 7. Shared Responsibility Audit — Class `H`, must NOT move into Drivers

`ZAROORAT CODEBASE`

| Module                             | What Drivers uses                                                                                                   | Why it must stay                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth — OTP**                     | `POST /auth/otp/{send,verify}`                                                                                      | Challenge binding, multi-axis rate limits, lockout, hashed storage, BullMQ delivery, audit rows, redaction. Driver App calls the **same two endpoints**. Duplicating would split the audit trail and the rate-limit budget                                                                                                                               |
| **Auth — sessions/tokens/epoch**   | `authPlugin`, `authorize()`, `TokenService`, `EpochService`                                                         | Deny-by-default, fail-closed, refresh rotation with reuse detection                                                                                                                                                                                                                                                                                      |
| **Auth — roles**                   | `AuthService.grantRole`, `RoleRepository`                                                                           | Role infrastructure is platform-wide. Drivers must **call** `grantRole`, never write `user_roles`                                                                                                                                                                                                                                                        |
| **Auth — `requireOperableDriver`** | `authPlugin` option → `DriverAccessRepository.isOperableDriver`                                                     | ⚠️ **Nuance:** this lives in **auth** and queries the `drivers` table. Arguably inverted coupling — but it is a route-guard option alongside `roles` and `requireUntamperedDevice`, applied to 5 routes across 2 modules. **Do not move it.** Moving it would fragment the guard surface and touch security-critical code for cosmetic gain. `INFERENCE` |
| **Users**                          | `User` as canonical identity; `UserRepository.updateEmail`; `UserProfileRepository`                                 | `Driver` is a 1:1 optional extension of `User`. `User.email` is canonical — **do not add email to `DriverProfile`**                                                                                                                                                                                                                                      |
| **Files**                          | `DRIVER_DOCUMENT` purpose, presigned upload, validation, `decideRead`, `registerFileReference`, retention jobs      | Already designed for driver documents (`DRIVER_RELATIONSHIP_ENDED` retention trigger, `drivers:verify` operator scope). Drivers must store a `fileId`, not a URL                                                                                                                                                                                         |
| **Geo**                            | `recordDriverPosition`, `forgetDriverPosition`, `latitudeSchema`/`longitudeSchema`                                  | H3 + Redis + PostGIS/GiST with graceful degradation                                                                                                                                                                                                                                                                                                      |
| **Rides**                          | Ride lifecycle, state machine, dispatch primitives                                                                  | ⚠️ Rides imports **into** Drivers (`DriverRepository`, `driver.errors`). Correct direction — Rides depends on Drivers, not the reverse                                                                                                                                                                                                                   |
| **Dispatch**                       | `DispatchService.offerToDriver`, `RideDispatchRepository` (both zero-caller)                                        | Live in `rides/`; `modules/dispatch/` is a stub. **Do not pull offers into Drivers**                                                                                                                                                                                                                                                                     |
| **Vehicles**                       | `Vehicle`, `VehicleAssignment`, `currentVehicleId`                                                                  | Separate module (stub) over a complete schema. **Do not absorb**                                                                                                                                                                                                                                                                                         |
| **Payments**                       | Settlement, ledger, payouts, `DriverSettlement`                                                                     | Owns all money movement (§6.7)                                                                                                                                                                                                                                                                                                                           |
| **Notifications**                  | `NotificationService.sendSms`                                                                                       | SMS only; consumed by OTP. No push exists                                                                                                                                                                                                                                                                                                                |
| **Core**                           | `TransactionManager`, `lockForUpdate` pattern, `EventPublisher`/outbox, `LockStore`, DI container, metrics registry | Platform infrastructure                                                                                                                                                                                                                                                                                                                                  |

---

## 8. Duplicate / Dead-Code Audit

### 8.1 Duplicates — Class `D`

| #   | Duplication                                         | Evidence                                                                                                                                                                  | Recommendation                                                                                                                                |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **`actingDriverId` implemented twice**              | `drivers/controllers/driver-identity.ts:7-13` and a private copy at `rides/controllers/ride-state.controller.ts:17-22` — same logic, same error                           | Rides should import the Drivers helper. **Security-relevant** — two copies can drift                                                          |
| D2  | **Two email write paths to `User.email`**           | `UserService.updateProfile` → `UserRepository.updateEmail` (correct) vs `DriverRepository.updateProfile` → raw `client.user.update`                                       | Drivers must use `UserRepository.updateEmail` — **already added in the same uncommitted changeset and not used**                              |
| D3  | **Two verification-status concepts in one service** | `OnboardingService` holds both `submitDocument` (document status) and `reviewDriverVerification` (driver status), and both repositories expose `updateVerificationStatus` | Not a true duplicate — **two different state machines with confusingly identical names**. Splitting the service makes the distinction visible |
| D4  | **Three authorization vocabularies**                | role slugs (enforced by `authorize()`); `PERMISSION_SEED`/`ROLE_PERMISSIONS` (seeded, `findAllowedCodesForUser` zero callers); Files' hardcoded `SCOPES_FOR_ROLE`         | Out of scope for placement; flagged                                                                                                           |
| D5  | **Five unused module `plugins/`**                   | `driverPlugin`, `ridePlugin`, `filePlugin`, `paymentPlugin`, `userPlugin` — all superseded by `routes/register.ts`                                                        | Delete as a set, in one commit, or keep as a set — not piecemeal                                                                              |

### 8.2 Dead code — Class `G`/`B`

| Item                                                                          | Class | Note                                                        |
| ----------------------------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| `plugins/driver.plugin.ts` + barrel                                           | `G`   | Zero callers                                                |
| `schemas/driver.responses.ts`                                                 | `G`   | Zero references                                             |
| `repositories/driver-bank.repository.ts`                                      | `B`   | DI-registered, zero callers — payouts never built           |
| `services/shift/shift.service.ts`                                             | `B`   | Zero callers; layer inverted                                |
| `DriverWalletRepository.lockForUpdate`                                        | `G`   | Zero callers                                                |
| `InvalidDriverStatusTransitionError`, `DocumentValidationError`               | `G`   | Zero throw sites                                            |
| `DriverMetrics.heartbeatTimeout()`                                            | `G`   | Not called even by `HeartbeatTimeoutJob`                    |
| `driver.document_expired`, `shift_started`, `shift_ended`, `location_updated` | `G`   | Declared, never published                                   |
| `DriverVerificationStatus.SUSPENDED`                                          | `G`   | Enum value never written                                    |
| `driverConfig.requireApprovedDocuments` (default `true`)                      | `B`   | **Zero consumers — the flag for the missing document gate** |
| `driverConfig.maxContinuousShiftHours` (12)                                   | `B`   | Zero consumers                                              |

### 8.3 Inert-but-wired

`DocExpirationJob` is fully scheduled, DI-resolved, and Redis-locked — and its query requires `verificationStatus: 'VERIFIED'`, which **no production code writes**. Correct, reachable, permanently a no-op. `ZAROORAT CODEBASE`

---

## 9. Import and Dependency Map — what breaks on a move

`ZAROORAT CODEBASE`

### 9.1 Inbound edges from outside Drivers — **the fragile ones**

| Importer                                       | Imports                                                              | Risk                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/routes/register.ts`                       | `driverRoutes` from `@modules/drivers/routes`                        | **HIGH** — the only route mount                                                                            |
| `src/core/di.ts`                               | `registerDriversModule` from `@modules/drivers`                      | **HIGH** — all 20 DI tokens                                                                                |
| `src/jobs/workers/index.ts`                    | resolves `'heartbeatTimeoutJob'`, `'docExpirationJob'` **by string** | **HIGHEST** — a **string token**, not an import. A rename fails silently at cron time, not at compile time |
| `rides/controllers/ride-state.controller.ts`   | `DriverRepository`, `DriverNotFoundError` — **deep paths**           | **HIGH** — deep imports break on any file move                                                             |
| `tests/integration/geo-nearby.test.ts`         | `DriverLocationRepository` — deep path                               | MEDIUM                                                                                                     |
| `tests/unit/drivers/verification-gate.test.ts` | `StatusService`, `driver.errors` — deep paths                        | MEDIUM                                                                                                     |

> **Mitigation:** keep `drivers/index.ts` as a stable public barrel and convert the external deep imports to barrel imports **before** moving files. That reduces the blast radius of every subsequent phase to one file. `INFERENCE`

### 9.2 Internal edges

Barrels: `index.ts` re-exports 13 sub-barrels; `services/index.ts` re-exports 5 sub-barrels + facade. **Moving a folder means updating its barrel and the parent barrel** — 2 edits per move.

Relative depth changes: files in `services/<domain>/` use `../../repositories/…`. Moving to `<domain>/services/` keeps the depth at `../../` for a sibling `<domain>/repositories/`, but changes it for anything still in the flat folders. **Mid-migration, depths differ per file** — the main source of churn.

### 9.3 What does _not_ break

Route paths (registration is by function, not file); DI token **names** (Awilix keys, decoupled from paths); event type strings; Prisma model names; the `@modules/*`/`@core/*` path aliases in `tsconfig.json`.

---

## 10. Route Ownership Map

`ZAROORAT CODEBASE` — all 13 routes, one file today.

| Route                                | Guard                   | Handler                         | Owning submodule         | Target route file     |
| ------------------------------------ | ----------------------- | ------------------------------- | ------------------------ | --------------------- |
| `GET /me`                            | auth                    | `onboarding.getMe`              | onboarding               | `onboarding/routes`   |
| `POST /me/onboard`                   | auth                    | `onboarding.onboard`            | onboarding               | `onboarding/routes`   |
| `PATCH /:driverId/profile`           | auth                    | `onboarding.updateProfile`      | onboarding               | `onboarding/routes`   |
| `POST /:driverId/documents`          | auth                    | `onboarding.submitDocument`     | **documents**            | `documents/routes`    |
| `POST /:id/verify`                   | `roles:['admin']`       | `onboarding.reviewVerification` | **verification**         | `verification/routes` |
| `POST /status/online`                | `requireOperableDriver` | `status.setOnline`              | status                   | `status/routes`       |
| `POST /status/offline`               | **none**                | `status.setOffline`             | status                   | `status/routes`       |
| `POST /heartbeat`                    | **none**                | `status.heartbeat`              | status                   | `status/routes`       |
| `POST /:id/suspend`                  | `roles:['admin']`       | `status.suspend`                | status (admin-initiated) | `status/routes`       |
| `POST /location`                     | rateLimit               | `location.updateLocation`       | location                 | `location/routes`     |
| `GET /:id/location`                  | auth + staff bypass     | `location.getLocation`          | location                 | `location/routes`     |
| `GET /:driverId/wallet`              | auth + staff bypass     | `wallet.getWallet`              | wallet                   | `wallet/routes`       |
| `GET /:driverId/wallet/transactions` | auth + staff bypass     | `wallet.listTransactions`       | wallet                   | `wallet/routes`       |

### 10.1 Admin / review boundary — the brief's explicit question

**Two admin-initiated routes live in the Drivers module today** (`/:id/verify`, `/:id/suspend`), and `src/modules/admin/` is an `export {};` stub with **no route prefix registered**.

> **Recommendation: keep the business rules in the Driver subdomain. `INFERENCE`**
>
> The brief's own guidance is right and the codebase supports it. `reviewDriverVerification` performs a `SELECT … FOR UPDATE` on the driver row, drives the `DriverVerificationStatus` state machine, and is where the document-completeness check and the `grantRole` call must go. That is Driver domain logic regardless of who initiates it.
>
> **Two viable placements, both acceptable:**
>
> - **(a) Keep the routes in Drivers** under `verification/routes`, guarded by `roles:['admin']` — zero new wiring, matches the current pattern.
> - **(b) Mount them under `/api/v1/admin`** in a future Admin module, with thin controllers that call the same Driver services — better if an admin review _queue_ is added, since that needs list/filter/pagination endpoints that are genuinely Admin surface.
>
> Either way: **the service stays in Drivers.** Do not copy the rule into Admin. Given Admin is an empty stub, **(a) now, (b) when Admin is actually built** is the lower-risk path.

**Constraint:** `tests/integration/route-graph.test.ts` asserts the exact set of publicly reachable routes. Any change to route _paths_ fails it. Changing only the source file is invisible to it. `TEST EVIDENCE`

---

## 11. Dependency Injection / Container Impact

`ZAROORAT CODEBASE` — `drivers/index.ts` registers **20 tokens** in one `container.register({…})`.

```
driverMetrics · driverRepository · driverDocumentRepository · driverBankRepository
driverWalletRepository · driverStatusRepository · driverLocationRepository
driverShiftRepository · onboardingService · statusService · locationService
driverWalletViewService · shiftService · driverService(.inject) ·
driverOnboardingController · driverStatusController · driverLocationController
driverWalletController · driverController(.inject) · heartbeatTimeoutJob · docExpirationJob
+ aliases: driverRepo, docRepo, locationRepo, shiftRepo, statusRepo, txManager
```

**Impact of moving files:**

1. **Import paths in `drivers/index.ts` change** — one file, mechanical.
2. **Token names must NOT change.** Awilix resolves by name. Three consumers depend on exact strings:
   - `src/jobs/workers/index.ts` — `MAINTENANCE_HANDLERS` maps job names to `'heartbeatTimeoatJob'`/`'docExpirationJob'` **as strings**
   - `drivers/routes/driver.routes.ts` — `container.resolve<DriverController>('driverController')`
   - `tests/unit/di-wiring.test.ts` — **statically parses source files** with regexes for `asClass(X)` and constructor params to prove every dependency resolves. `TEST EVIDENCE`
3. **`di-wiring.test.ts` is a genuine safety net** — it walks `src/`, so it follows moved files automatically and will catch a constructor/registration mismatch introduced by a bad move. **Run it after every phase.**
4. **Splitting `OnboardingService` three ways** adds 2 registrations and changes the `driverService.inject()` map and the `driverController.inject()` map. The largest DI change in the plan.
5. **Aliases (`driverRepo`, `docRepo`, …) are `aliasTo` pointers** — they survive path changes untouched.

---

## 12. Event / Outbox Impact

`ZAROORAT CODEBASE`

**Zero impact from file moves.** Events are identified by **type strings** in `DRIVER_EVENT_CATALOG` (`driver.onboarded`, `driver.verified`, `driver.status_changed`, `driver.suspended`), published via `EventPublisher.publish(input, tx?)` into `event_outbox`, and relayed by `OutboxRelay` → `EventBus.emit(type)`. No consumer resolves by file path.

**Placement observation:** `events/catalog.ts` holds all 8 types for all submodules. It is genuinely shared → **`drivers/shared/events/catalog.ts`**. Do not fragment it; a single catalog is what makes `tests/unit/auth/event-catalog.test.ts`-style contract tests possible.

**Subscriber census:** `grep -rn "eventBus.on(" src --exclude-dir=generated` → **one hit**, `auth/consumers/epoch-invalidation.consumer.ts:17`. **No Drivers consumer exists**, so there is no consumer registration to relocate.

**Forward-looking:** if the role grant is implemented as a `driver.verified` subscriber, the new file belongs at **`drivers/verification/consumers/`** or in `auth/consumers/` — an open design question, **not** a placement question for existing code. `INFERENCE`

---

## 13. Test Impact

`TEST EVIDENCE` — 109 test files; `npm run test:unit` → 714 pass, reproducible.

| Test                                               | Depends on                                            | Impact of moves                                                        |
| -------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `tests/unit/di-wiring.test.ts`                     | Parses all of `src/` for `asClass`/constructor params | **Self-following** — no update needed; **the primary guard**           |
| `tests/unit/drivers/verification-gate.test.ts`     | Deep imports `StatusService`, `driver.errors`         | **Update imports**                                                     |
| `tests/unit/drivers/location-plausibility.test.ts` | Deep import `location-plausibility`                   | **Update imports**                                                     |
| `tests/unit/drivers/mock-location.test.ts`         | Deep imports                                          | **Update imports**                                                     |
| `tests/integration/geo-nearby.test.ts`             | Deep import `DriverLocationRepository`                | **Update imports**                                                     |
| `tests/integration/route-graph.test.ts`            | Live route table via `app.inject`                     | **No update if paths unchanged** — the acceptance gate for every phase |
| `tests/integration/auth-driver-gate.test.ts`       | `db().client.driver` + ad-hoc route                   | No update (no Drivers imports)                                         |
| `tests/integration/authorization-bola.test.ts`     | HTTP + fixtures                                       | No update                                                              |
| `tests/integration/earnings-pipeline.test.ts`      | Payments `SettlementService`                          | No update                                                              |
| `tests/integration/helpers/fixtures.ts`            | Prisma client directly                                | No update                                                              |

**Test gap relevant to reorganization:** **zero tests exercise any route in `driver.routes.ts`** except two auth/BOLA probes. So a refactor could break onboarding, profile, documents, verification, online, or location **without a single test failing**. `TEST EVIDENCE`

> **This is the strongest argument for Phase 0 in §16:** add HTTP smoke tests for the 13 driver routes **before** moving anything. Without them the reorganization is unverifiable — and `route-graph.test.ts` only proves a route is _authenticated_, not that it _works_.

---

## 14. Target Production Folder Structure

Two options. **The brief asks not to force the target structure blindly.**

### 14.1 Option A — full vertical slices (the brief's target, adjusted)

```
src/modules/drivers/
├── onboarding/          controllers/ services/ repositories/ schemas/ routes/ utils/
├── documents/           controllers/ services/ repositories/ schemas/ routes/ jobs/
├── verification/        controllers/ services/ schemas/ routes/          ← ADJUSTMENT
├── status/              controllers/ services/ repositories/ schemas/ routes/ jobs/
├── shifts/              services/ repositories/
├── location/            controllers/ services/ repositories/ schemas/ routes/
├── wallet/              controllers/ services/ repositories/ routes/
├── shared/
│   ├── authorization/driver-identity.ts
│   ├── repositories/driver.repository.ts
│   ├── events/catalog.ts
│   ├── driver.types.ts · driver.errors.ts · driver.constants.ts
│   ├── metrics/driver.metrics.ts
│   └── schemas/error-response.ts
├── routes/index.ts      composes submodule routes under /api/v1/drivers
├── driver.module.ts     DI registration (renamed from index.ts internals)
└── index.ts             stable public barrel
```

**Four adjustments to the brief's structure, each evidence-based:**

| Adjustment                                             | Reason                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add `verification/`**                                | `reviewDriverVerification` is neither onboarding nor documents. It is the driver-approval state machine, it will host the `grantRole` call, and it is admin-initiated. Folding it into `documents/` would conflate _document_ status with _driver_ status — the exact confusion that exists today (§8.1 D3) |
| **No `earnings/`**                                     | Zero Drivers code; Payments owns it (§6.7). Creating it invites duplication of the ledger                                                                                                                                                                                                                   |
| **`shared/` gets 4 more entries** than the brief lists | `driver-identity.ts` (5 callers), `driver.repository.ts` (4 submodules + Rides), `events/catalog.ts`, `metrics/`, `error-response.ts` all meet the "genuinely shared by multiple submodules" bar                                                                                                            |
| **`shifts/` has no routes**                            | No shift endpoint exists and none is needed — shifts are a side effect of online/offline                                                                                                                                                                                                                    |

**Cost:** ~35 file moves, ~60 import updates, 20 DI import-path changes, 5 route-file splits, 3 service splits, 6 test-import updates. **Benefit:** each submodule becomes independently readable; the missing document-review capability has an obvious home.

### 14.2 Option B — documents/verification extraction only ⭐ **recommended first**

Leave the horizontal layout intact. Extract **only** the two concerns that have no owner:

```
src/modules/drivers/
├── documents/       services/ repositories/ schemas/ routes/ jobs/ controllers/
├── verification/    services/ schemas/ routes/ controllers/
├── controllers/ services/ repositories/ routes/ schemas/ …   (unchanged)
└── index.ts
```

**Cost:** ~8 file moves, ~15 import updates. **Benefit:** captures the single genuine placement defect and unblocks the missing review feature.

> **Recommendation: do Option B first, then decide whether Option A is worth it. `INFERENCE`**
>
> Option B fixes the real problem (§1) at ~20 % of the cost and risk. Option A is a consistency improvement whose value is real but lower — and with **zero HTTP tests on driver routes** (§13), a 35-file move is currently unverifiable. If Option A is still wanted after Option B lands and the smoke tests exist, it becomes routine.

---

## 15. Exact Migration Map

Per-file action. **Recommendation column marks Option B (⭐) vs Option A-only (A).**

### MOVE — documents ⭐

```
MOVE  drivers/repositories/driver-document.repository.ts
   →  drivers/documents/repositories/driver-document.repository.ts     ⭐
      3 importers; DI token `driverDocumentRepository` UNCHANGED

MOVE  drivers/jobs/doc-expiration.job.ts
   →  drivers/documents/jobs/doc-expiration.job.ts                     ⭐
      ⚠️ DI token `docExpirationJob` MUST stay — resolved by string in jobs/workers

SPLIT drivers/services/onboarding/onboarding.service.ts
   →  KEEP  onboardDriver + updateProfile        (onboarding)           ⭐
   →  MOVE  submitDocument
            → drivers/documents/services/document-submission.service.ts ⭐
   →  MOVE  reviewDriverVerification
            → drivers/verification/services/driver-verification.service.ts ⭐

SPLIT drivers/controllers/driver-onboarding.controller.ts
   →  KEEP  getMe + onboard + updateProfile                            ⭐
   →  MOVE  submitDocument   → drivers/documents/controllers/           ⭐
   →  MOVE  reviewVerification → drivers/verification/controllers/      ⭐
      ⚠️ FIX THE MISSING IMPORT FIRST (Phase 0)

SPLIT drivers/schemas/driver.schemas.ts
   →  submitDriverDocumentSchema → drivers/documents/schemas/           ⭐
   →  reviewVerificationSchema   → drivers/verification/schemas/        ⭐
   →  updateDriverProfileSchema  → drivers/onboarding/schemas/          A
   →  updateLocationSchema       → drivers/location/schemas/            A
   →  heartbeatSchema            → drivers/status/schemas/              A

SPLIT drivers/routes/driver.routes.ts
   →  POST /:driverId/documents → drivers/documents/routes/             ⭐
   →  POST /:id/verify          → drivers/verification/routes/          ⭐
   →  remaining 11 routes       → per-submodule route files             A
      ⚠️ ROUTE PATHS MUST NOT CHANGE — route-graph.test.ts
```

### MOVE — Option A only

```
MOVE  drivers/repositories/driver-status.repository.ts   → drivers/status/repositories/        A
MOVE  drivers/repositories/driver-location.repository.ts → drivers/location/repositories/      A
MOVE  drivers/repositories/driver-shift.repository.ts    → drivers/shifts/repositories/        A
MOVE  drivers/repositories/driver-wallet.repository.ts   → drivers/wallet/repositories/        A
MOVE  drivers/controllers/driver-status.controller.ts    → drivers/status/controllers/         A
MOVE  drivers/controllers/driver-location.controller.ts  → drivers/location/controllers/       A
MOVE  drivers/controllers/driver-wallet.controller.ts    → drivers/wallet/controllers/         A
MOVE  drivers/jobs/heartbeat-timeout.job.ts              → drivers/status/jobs/                A
       ⚠️ DI token `heartbeatTimeoutJob` MUST stay
MOVE  drivers/services/{location,onboarding,shift,status,wallet}/*
       → drivers/<domain>/services/*                                                           A
MOVE  drivers/utils/driver-code.util.ts                  → drivers/onboarding/utils/           A
MOVE  drivers/controllers/driver-identity.ts             → drivers/shared/authorization/       A
       ⚠️ SECURITY-CRITICAL — 5 callers documented in §5.7
MOVE  drivers/repositories/driver.repository.ts          → drivers/shared/repositories/        A
       ⚠️ Rides deep-imports this — convert to barrel import FIRST
MOVE  drivers/events/catalog.ts                          → drivers/shared/events/              A
MOVE  drivers/metrics/driver.metrics.ts                  → drivers/shared/metrics/             A
MOVE  drivers/types/·errors/·constants/·schemas/error-response.ts → drivers/shared/            A
```

### KEEP — Class `H`, shared modules

```
KEEP  auth/services/otp/otp.service.ts            → Auth. Driver reuses OTP; do not duplicate
KEEP  auth/services/auth.service.ts               → Auth. grantRole/revokeRole/ensureDefaultRole
KEEP  auth/plugins/auth.plugin.ts                 → Auth. authorize(), requireOperableDriver
KEEP  auth/repositories/driver-access.repository.ts → Auth. Guard-adjacent; moving fragments the guard (§7)
KEEP  auth/services/token/·session/               → Auth
KEEP  users/**                                    → Users. User is canonical identity; email lives here
KEEP  files/**                                    → Files. DRIVER_DOCUMENT purpose already defined
KEEP  geo/**                                      → Geo. Position recording + coordinate schemas
KEEP  rides/**                                    → Rides. Incl. dispatch primitives
KEEP  vehicles/**                                 → Vehicles (separate module)
KEEP  payments/**                                 → Payments. Owns settlement/earnings/payouts
KEEP  notifications/**                            → Notifications
KEEP  core/**                                     → Platform infrastructure
```

### DELETE — dead code, only after Phase 8

```
DELETE  drivers/plugins/driver.plugin.ts + index.ts        Zero callers (with the other 4 plugins)
DELETE  drivers/schemas/driver.responses.ts                Zero references
DELETE  InvalidDriverStatusTransitionError                 Zero throw sites — or start throwing it
DELETE  DriverWalletRepository.lockForUpdate               Zero callers
DECIDE  drivers/repositories/driver-bank.repository.ts     Keep for payouts, or delete
DECIDE  drivers/services/shift/shift.service.ts            Wire it (invert the layer) or delete
```

### CREATE — **not in the reorganization phases**

```
CREATE  documents/services  → verifyDocument()             P0 — missing review
CREATE  documents/routes    → admin document review route  P0
CREATE  verification/       → document-completeness check  P0
CREATE  drivers/verification/consumers/ or auth/consumers/ → grantRole on driver.verified  P0
CREATE  tests/integration/driver-*.test.ts                 HTTP smoke tests — Phase 0
```

---

## 16. Safe Implementation Order

**Rule: no phase mixes file movement with business-logic change.**

### PHASE 0 — Stabilize (blocking; nothing else may start)

1. **Fix the build.** Add the `DriverNotFoundError` import (`driver-onboarding.controller.ts:18`); change `catch (err: any)` → `unknown` + narrowing (`onboarding.service.ts:39`). `BUILD EVIDENCE`
2. **Land or stash the in-flight onboarding changeset.** Sixteen modified files, five in `drivers/`, actively rewriting the exact code being moved. **Moving files under an uncommitted rewrite will produce conflicts that are very hard to reason about.**
3. **Add `typecheck` + `lint` to CI** — `tsx` strips types, so 714 tests pass over a non-compiling tree.
4. **Add HTTP smoke tests for all 13 driver routes.** Currently **zero** exist (§13). Without them no later phase is verifiable.
5. **Convert external deep imports to barrel imports** — `rides/controllers/ride-state.controller.ts`, `geo-nearby.test.ts`, `verification-gate.test.ts`. Shrinks every later phase's blast radius.
6. Baseline: `npm run typecheck && npm run lint && npm run test:unit`.

**Exit criteria:** typecheck ✅ lint ✅ 714 unit ✅ 13 route smoke tests ✅ tree committed.

### PHASE 1 — Documents extraction ⭐ (highest value)

Move `driver-document.repository.ts`, `doc-expiration.job.ts`; split `submitDocument` out of `OnboardingService` and its controller/schema/route counterparts. **DI token names unchanged.**
**Verify:** `di-wiring.test.ts`, `route-graph.test.ts`, smoke tests, typecheck, lint.

### PHASE 2 — Verification extraction ⭐

Move `reviewDriverVerification` + controller + schema + route into `verification/`. Still no logic change — the document-completeness check and `grantRole` come in Phase 6.

### PHASE 3 — Status + shifts (Option A)

Move status controller/repository/schema/job; move shift repository. **⚠️ `heartbeatTimeoutJob` token must not change.**

### PHASE 4 — Location (Option A)

Move location controller/repository/schema. Lowest risk — the submodule is already well-formed.

### PHASE 5 — Wallet, onboarding, shared (Option A)

Move wallet trio; onboarding controller/schema/utils; then `shared/` (`driver-identity.ts`, `driver.repository.ts`, `catalog.ts`, `metrics/`, types/errors/constants). **`driver-identity.ts` is security-critical — move alone, in its own commit, with all 5 callers verified.**

### PHASE 6 — Wire the missing production transitions (**first phase with logic changes**)

Document review service + admin route (P0); document-completeness gate using the existing `requireApprovedDocuments` flag (P0); `grantRole` on approval (P0); suspend deadlock (P0); Files `fileId` integration (P0, needs a schema change); the P1 set.

### PHASE 7 — Integration tests

The full-lifecycle test: OTP → onboard → profile → document upload via Files → submit → review → approve → role in refreshed claims → online, **with zero direct database writes.** This is the definition of done.

### PHASE 8 — Final verification and dead-code removal

Full command sweep; delete the dead set (§15) in one commit; refresh `drivers/README.md` (currently claims "0 errors / 550 tests"; actual 1 error / 714 tests).

---

## 17. Production Gaps Discovered

### MISPLACED CODE

| Item                                                | Current                                     | Target                    |
| --------------------------------------------------- | ------------------------------------------- | ------------------------- |
| `submitDocument`                                    | `services/onboarding/onboarding.service.ts` | `documents/services/`     |
| `reviewDriverVerification`                          | same file                                   | `verification/services/`  |
| `driver-document.repository.ts`                     | `repositories/`                             | `documents/repositories/` |
| `doc-expiration.job.ts`                             | `jobs/`                                     | `documents/jobs/`         |
| `heartbeat-timeout.job.ts`                          | `jobs/`                                     | `status/jobs/`            |
| 5 controllers, 5 repositories, 5 schemas, 13 routes | flat folders                                | per-submodule             |
| `driver-identity.ts`                                | `controllers/`                              | `shared/authorization/`   |
| `driver-code.util.ts`                               | `utils/`                                    | `onboarding/utils/`       |

### UNUSED EXISTING CODE

`plugins/driver.plugin.ts` · `schemas/driver.responses.ts` · `driver-bank.repository.ts` · `shift.service.ts` · `DriverWalletRepository.lockForUpdate` · `InvalidDriverStatusTransitionError` · `DocumentValidationError` · `DriverMetrics.heartbeatTimeout` · 4 unpublished events · `DriverVerificationStatus.SUSPENDED` · **`driverConfig.requireApprovedDocuments`** · **`driverConfig.maxContinuousShiftHours`**

### TRUE MISSING CODE

Document review (service + route + writer of `VERIFIED`) · document-completeness gate before approval · `grantRole` call on approval · `BUSY`/`ON_TRIP` writers · licence-expiry check at go-online · one-driver-one-active-ride guard · admin review queue · Files `fileId` integration · location history · driver aggregates + shift stats · push/realtime · `EXPIRED` document status · unique index on `(driver_id, document_type)`

### SECURITY ISSUE

`fileUrl: z.string().url()` — arbitrary client URL accepted as a document (bypasses Files entirely) · driver approvable with zero/`PENDING`/`REJECTED` documents · unverified/suspended/offline drivers enter the live geo index · `POST /:id/suspend` body read via raw cast · `DEFAULT_USER_ROLE` unvalidated at boot · revoked default role silently re-granted on next login · staff bypass in `authorizedDriverId` unaudited · `actingDriverId` duplicated in Rides (drift risk)

### BUILD ISSUE

Typecheck **FAIL** (1 error) · lint **FAIL** (1 error) · build **FAIL**; `dist/` emitted with unresolved `require("@core/auth")` — unrunnable · `format:check` fails on 29 files · integration tests `NOT_VERIFIABLE` (no Postgres/Redis/Docker) · `tsx` hides type errors from CI

### TEST GAP

**Zero HTTP tests for any of the 13 driver routes** except two auth/BOLA probes · document verification and role assignment exist **only** as fixture inserts · no test for suspend, online success, or the driver branch of `GET /rides/active` · `verification-gate.test.ts` is mock-only with 7 `{} as never` deps

---

## 18. Final Answers

**1. Are the existing onboarding folders being used correctly?**
**NO.** `drivers/services/onboarding/` exists as a **service-layer bucket only** — there is no top-level `drivers/onboarding/` with its own controllers/repositories/routes/schemas. And the folder holds **two foreign concerns**: `submitDocument` (documents) and `reviewDriverVerification` (verification). `ZAROORAT CODEBASE`

**2. Are the documents folders being used correctly?**
**NO — they do not exist.** There is no `drivers/documents/` anywhere. Document code is scattered across five locations in three layers with no owner (§6.2). `src/modules/documents/` is a top-level `export {};` stub, unrelated to Drivers. `ZAROORAT CODEBASE`

**3. Which code is implemented but sitting in the wrong place?**
`submitDocument` and `reviewDriverVerification` (inside the onboarding service) · `driver-document.repository.ts` · `doc-expiration.job.ts` · `heartbeat-timeout.job.ts` · all 5 controllers · all 5 domain repositories · all 5 schemas in one file · all 13 routes in one file · `driver-identity.ts` · `driver-code.util.ts`. **13 files classified `C`** (§4).

**4. Which folders are empty but already intended for production architecture?**
**None.** `find src/modules/drivers -type d -empty` returns nothing. **The premise that empty scaffolding exists is incorrect** — all 19 directories contain files. The intended architecture exists only as intent, not as folders. `ZAROORAT CODEBASE`

**5. Which existing code can be moved without changing logic?**
All 13 misplaced files. Pure relocations (imports + barrels only): `driver-document.repository.ts`, both jobs, all 5 repositories, all 5 controllers, `driver-code.util.ts`, `driver-identity.ts`, the 5 schemas, the 13 route registrations. **Requires code restructuring, not just moving:** splitting `OnboardingService` and `DriverOnboardingController` three ways — mechanical, but it is a code edit.

**6. Which moves require DI/import/event changes?**

- **DI import paths:** every move (all in `drivers/index.ts` — one file).
- **DI registrations added:** the `OnboardingService` split (+2 tokens, and both `.inject()` maps).
- **⚠️ DI token names must NOT change:** `docExpirationJob`, `heartbeatTimeoutJob` (resolved **by string** in `jobs/workers/index.ts`), `driverController` (resolved in `driver.routes.ts`).
- **External imports:** `rides/controllers/ride-state.controller.ts` (deep imports `DriverRepository` + `driver.errors`) and 4 test files.
- **Events:** **no impact** — type strings, not paths (§12).

**7. What code must remain outside the Driver module?**
OTP, JWT/session/token, `grantRole`/role infrastructure, `authorize()`/`requireOperableDriver`/`DriverAccessRepository` (Auth) · `User` identity and `User.email` (Users) · file storage/validation/purposes (Files) · position recording and coordinate schemas (Geo) · ride lifecycle and dispatch primitives (Rides) · Vehicle domain (Vehicles) · **settlement/earnings/payouts (Payments)** · SMS (Notifications) · `TransactionManager`/outbox/DI/metrics (Core). **13 entries, Class `H`** (§7).

**8. What Driver functionality is genuinely missing?**
Document review (the writer of `VERIFIED`) · document-completeness gate before approval · the `grantRole` call on approval · `BUSY`/`ON_TRIP` writers · licence-expiry check at go-online · one-driver-one-active-ride guard · admin review queue · Files `fileId` integration · location history · driver aggregates and shift statistics · push/realtime. **Verified missing by searching all of `src/`, not by folder absence.**

**9. Is there duplicate logic?**
**Yes, five instances** (§8.1): `actingDriverId` duplicated in Rides (security-relevant) · two write paths to `User.email` · two `updateVerificationStatus` state machines confusingly co-located in one service · three authorization vocabularies · five unused module `plugins/`.

**10. What is the safest first reorganization step?**
**Not a move at all — Phase 0.** Fix the two build errors, land or stash the in-flight changeset, add `typecheck`+`lint` to CI, **add HTTP smoke tests for the 13 driver routes**, and convert external deep imports to barrel imports. With zero route tests today, any move is currently unverifiable. Then the first actual move is **Phase 1: documents extraction** — 2 file moves + 1 service split, guarded by `di-wiring.test.ts` and `route-graph.test.ts`.

**11. Can we reorganize first without breaking the Customer flow?**
**Yes — the risk is genuinely low.** The Customer flow is Auth/OTP → Users → Rides (quote/request), and it **imports nothing from `src/modules/drivers/`**. The only inbound edges to Drivers are `routes/register.ts`, `core/di.ts`, `jobs/workers` (string tokens), and `rides/controllers/ride-state.controller.ts`. Route paths do not change, so `route-graph.test.ts` stays green. **One caveat:** the shared `User.email` write path is touched by the uncommitted changeset — Phase 0 must land before anything moves. `ZAROORAT CODEBASE`

**12. What should be implemented only AFTER reorganization?**
Everything in §17 "TRUE MISSING CODE" — document review, the completeness gate, `grantRole` on approval, the suspend deadlock fix, Files `fileId` integration, `BUSY`/`ON_TRIP`, the concurrent-ride guard, dispatch. **Phase 6 onward.** Implementing document review before extracting `documents/` would place new code in the wrong folder and require moving it twice.

**13. Is the Driver module ready for `/speckit.specify` after this audit?**
**Not yet — three prerequisites, all in Phase 0.** (a) The tree does not compile or lint. (b) An uncommitted changeset is mid-rewrite of the onboarding files, so several answers here would change the moment it lands. (c) The role-assignment mechanism — in-transaction vs `driver.verified` subscriber — is an open architectural fork that determines whether a `consumers/` folder exists at all, and the spec cannot leave it open.
**A placement-only spec** covering Phases 1–5 could be written today, since §15 is a complete and self-contained migration map. **A production spec covering Phase 6 onward should wait for Phase 0.**

---

**DRIVER MODULE CODE PLACEMENT INVESTIGATION COMPLETE — NO CODE CHANGES MADE.**
