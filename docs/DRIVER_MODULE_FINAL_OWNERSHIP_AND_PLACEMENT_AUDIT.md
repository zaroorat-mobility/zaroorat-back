# Driver Module — Final Ownership and Placement Audit

**Repository:** `backend_zaroorat` · **Branch:** `feature/auth` · **HEAD:** `273aadb`
**Date:** 2026-08-20
**Type:** Read-only investigation. No source modified, no file moved or renamed, no folder created, no file deleted, no migration, no import changed, no automatic fix, no functionality implemented.

**Evidence labels:** `CODE VERIFIED` · `TEST VERIFIED` · `BUILD VERIFIED` · `SCHEMA VERIFIED` · `INFERENCE` · `REQUIRES DECISION`

**Classifications:** `KEEP_IN_DRIVERS` · `MOVE_TO_ANOTHER_EXISTING_MODULE` · `CROSS_MODULE_ORCHESTRATION` · `DEAD_OR_UNUSED` · `DUPLICATED_RESPONSIBILITY` · `UNCLEAR_REQUIRES_DECISION`

> ### ⚠️ Correction to the previous audit
>
> `docs/DRIVER_MODULE_FULL_OWNERSHIP_AND_PLACEMENT_AUDIT.md` (2026-08-19) stated that a direct `drivers → auth` call for `grantRole` **would create the codebase's first circular dependency**, on the grounds that `auth` already depends on `drivers` via `driver-access.repository.ts`.
>
> **That is wrong.** `DriverAccessRepository` imports **only `@core/database`** and reads `this.client.driver` — the shared Prisma client. There is **no `auth → drivers` import edge**. The coupling is at the _database schema_ level, not the _module_ level. `CODE VERIFIED`
>
> **Consequence:** a direct `drivers → auth` import would **not** create an import cycle. Both role-assignment options are structurally safe, and the choice rests on transactional-versus-eventual semantics alone (§7.4). The corrected analysis is used throughout this report.

---

## 1. Executive Summary

**The Driver module is far better bounded than its folder layout suggests, and almost nothing in it belongs to another top-level module.**

Of 54 files under `src/modules/drivers/`: **43 `KEEP_IN_DRIVERS` · 0 `MOVE_TO_ANOTHER_EXISTING_MODULE` · 3 `CROSS_MODULE_ORCHESTRATION` · 6 `DEAD_OR_UNUSED` · 3 `DUPLICATED_RESPONSIBILITY` (overlapping) · 2 `UNCLEAR_REQUIRES_DECISION`.** `CODE VERIFIED`

**Seven findings define the current state:**

**1. The sibling module names carry no ownership claim.** All nine stub READMEs (`documents`, `onboarding`, `vehicles`, `dispatch`, `matching`, `admin`, `support`, `riders`, `pricing`) are byte-identical scaffold boilerplate — _"This module owns the core business logic for X."_ Zero code, zero schema, zero declared intent. `onboarding/index.ts` and `documents/index.ts` are `export {};`. **Nothing supports the theory that they were meant to own driver onboarding or driver documents.** `CODE VERIFIED`

**2. `drivers/` has exactly one outbound domain dependency: `geo`.** A complete import scan yields `@modules/geo` ×4; everything else is `@core/*`, `@config`, `@shared`. No auth, users, files, payments, vehicles, rides, matching, or dispatch. `CODE VERIFIED`

**3. Exactly one module imports `drivers`: `rides`,** in a single file, via two **deep imports** into private internals. `CODE VERIFIED`

**4. There are zero import cycles, and none of the 15 checked pairs is at risk.** §11. `CODE VERIFIED`

**5. The driver schema is a clean aggregate.** Nine models, every one FK'd to `Driver`; `Driver` has exactly one external FK — `userId → User.id`. **But six UUID columns carry no foreign key at all**, including `Driver.currentVehicleId`. §13. `SCHEMA VERIFIED`

**6. The missing outbound edges _are_ the P0 diagnosis.** Because `drivers/` imports neither `auth`, `users`, nor `files`, it cannot call `grantRole`, does not use `UserRepository.updateEmail` (raw Prisma write instead), and accepts client-supplied `fileUrl` strings instead of Files-owned `fileId`s. Three missing edges, three P0 gaps. `CODE VERIFIED`

**7. The only genuine internal placement defect is that documents have no owner** — the write path lives inside the _onboarding_ service, persistence in a flat repository, expiry in a flat jobs folder, with review missing entirely.

**Blocking state:** the tree does not compile or lint, and the two errors sit inside an **uncommitted 13-file changeset mid-rewrite of the onboarding flow**. `BUILD VERIFIED`

**Verdict: NO-GO to begin moving files. GO to plan.** Four Stage 0 preconditions, realistically under a day. §25.

---

## 2. Scope and Safety Rules

**Honoured in full:** no source modified · no file moved or renamed · no production folder created · no file deleted · no migration · no import changed · no automatic fix (`format:check` only, read-only) · no missing functionality implemented.

**Method.** Ownership was derived from business responsibility, Prisma models and migrations, routes and API contracts, service and repository responsibilities, the import graph, events and consumers, background jobs, authorization boundaries, current production callers, cross-module dependencies, and domain invariants — **never from folder names**. A _production caller_ is reachable from a registered route, a registered subscriber, or a scheduled job; test files never count. `src/generated/**` is excluded from every search.

**HEAD vs working tree are reported separately throughout** (§21).

---

## 3. Full Drivers File Inventory

`CODE VERIFIED` — 19 directories, 54 files, **none empty** (`find src/modules/drivers -type d -empty` → no output).

| #     | File                                          | LOC | Responsibility                         | Prod?         | Classification                  | Risk     |
| ----- | --------------------------------------------- | --: | -------------------------------------- | ------------- | ------------------------------- | -------- |
| 1     | `index.ts`                                    |  86 | DI (20 tokens) + barrels               | ✅            | `KEEP_IN_DRIVERS`               | —        |
| 2     | `constants/driver.constants.ts`               |  29 | Status/type enums                      | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 3     | `controllers/driver.controller.ts`            |  12 | Facade over 4 controllers              | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 4     | `controllers/driver-identity.ts`              |  24 | `actingDriverId`, `authorizedDriverId` | ✅ 4+rides    | `KEEP_IN_DRIVERS`               | **HIGH** |
| 5     | `controllers/driver-location.controller.ts`   |  37 | Location HTTP                          | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 6     | `controllers/driver-onboarding.controller.ts` |  82 | onboard+profile+**doc**+**review**     | ⚠️ **BROKEN** | `DUPLICATED_RESPONSIBILITY`     | MEDIUM   |
| 7     | `controllers/driver-status.controller.ts`     |  52 | Status HTTP                            | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 8     | `controllers/driver-wallet.controller.ts`     |  36 | Wallet read HTTP                       | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 9     | `errors/driver.errors.ts`                     |  66 | 8 domain errors                        | ✅ 6/8        | `KEEP_IN_DRIVERS`               | MEDIUM   |
| 10    | `events/catalog.ts`                           |  29 | 8 event types                          | ✅ 4/8        | `KEEP_IN_DRIVERS`               | LOW      |
| 11    | `jobs/doc-expiration.job.ts`                  |  45 | Expire verified docs                   | ✅ **inert**  | `KEEP_IN_DRIVERS`               | MEDIUM   |
| 12    | `jobs/heartbeat-timeout.job.ts`               |  40 | Sweep stale ONLINE                     | ✅            | `KEEP_IN_DRIVERS`               | MEDIUM   |
| 13    | `metrics/driver.metrics.ts`                   |  42 | Counters                               | ✅ 10/11      | `KEEP_IN_DRIVERS`               | LOW      |
| 14    | `plugins/driver.plugin.ts` (+barrel)          |   9 | Fastify prefix wrapper                 | ❌            | **`DEAD_OR_UNUSED`**            | LOW      |
| 15    | `repositories/driver.repository.ts`           | 133 | Aggregate root + **raw `user.update`** | ✅ +rides     | `DUPLICATED_RESPONSIBILITY`     | **HIGH** |
| 16    | `repositories/driver-bank.repository.ts`      |  46 | Bank accounts                          | ❌            | **`UNCLEAR_REQUIRES_DECISION`** | LOW      |
| 17    | `repositories/driver-document.repository.ts`  |  85 | `driver_documents` CRUD                | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 18    | `repositories/driver-location.repository.ts`  |  58 | PostGIS upsert                         | ✅            | `KEEP_IN_DRIVERS`               | MEDIUM   |
| 19    | `repositories/driver-shift.repository.ts`     |  44 | `driver_shift_logs`                    | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 20    | `repositories/driver-status.repository.ts`    |  78 | `driver_online_status`                 | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 21    | `repositories/driver-wallet.repository.ts`    |  44 | Wallet read                            | ⚠️ 2/3        | **`UNCLEAR_REQUIRES_DECISION`** | LOW      |
| 22    | `routes/driver.routes.ts`                     |  44 | 13 routes, 5 domains                   | ✅            | `KEEP_IN_DRIVERS`               | MEDIUM   |
| 23    | `schemas/driver.schemas.ts`                   |  54 | 5 Zod schemas, 4 domains               | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 24    | `schemas/driver.responses.ts`                 |  20 | View types                             | ❌            | **`DEAD_OR_UNUSED`**            | LOW      |
| 25    | `schemas/error-response.ts`                   |  22 | `handleDriverError`                    | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 26    | `services/driver.service.ts`                  |  14 | Facade over 5 services                 | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 27    | `services/location/location.service.ts`       |  69 | Ingest + geo write                     | ✅            | `CROSS_MODULE_ORCHESTRATION`    | MEDIUM   |
| 28    | `services/location/location-plausibility.ts`  |  62 | Speed/age/noise policy                 | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 29    | `services/onboarding/onboarding.service.ts`   | 113 | onboard+profile+**doc**+**review**     | ✅            | `DUPLICATED_RESPONSIBILITY`     | MEDIUM   |
| 30    | `services/shift/shift.service.ts` (+barrel)   |   9 | `getActiveShift`                       | ❌            | **`DEAD_OR_UNUSED`**            | LOW      |
| 31    | `services/status/status.service.ts`           | 136 | online/offline/heartbeat/suspend       | ✅            | `CROSS_MODULE_ORCHESTRATION`    | MEDIUM   |
| 32    | `services/wallet/wallet.service.ts`           |  11 | Read projection                        | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 33    | `types/driver.types.ts`                       |  33 | Prisma re-exports                      | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 34    | `utils/driver-code.util.ts`                   |   6 | `generateDriverCode()`                 | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| 35–54 | 20 barrel `index.ts` files                    | 1–7 | Re-exports                             | ✅            | `KEEP_IN_DRIVERS`               | LOW      |
| —     | `README.md`                                   |   — | Module doc                             | ⚠️ stale      | `KEEP_IN_DRIVERS`               | —        |

**`MOVE_TO_ANOTHER_EXISTING_MODULE`: zero files.** `CODE VERIFIED`

---

## 4. Driver Domain Ownership Matrix

The 18 responsibilities in the brief, decided on code evidence.

| #   | Responsibility                    | Verdict                       | Evidence                                                                                                                                                                                                      |
| --- | --------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Driver onboarding                 | **YES — Drivers**             | `onboardDriver` creates a `Driver` row with a driver code and driver-specific verification status. `src/modules/onboarding/` is `export {};`. Driver creation, not a generic workflow engine. `CODE VERIFIED` |
| B   | Driver profile                    | **YES — Drivers**             | `DriverProfile` is a distinct model FK'd to `Driver`, holding licence-adjacent data (`drivingExperienceYears`, `bloodGroup`, `preferredLanguage`). `SCHEMA VERIFIED`                                          |
| C   | Driver name / gender              | **YES — Drivers**             | `DriverProfile.fullLegalName` is _legal_ name for KYC — distinct from `UserProfile` display identity. `SCHEMA VERIFIED`                                                                                       |
| D   | Onboarding progress/state         | **YES — Drivers**             | `Driver.verificationStatus` (5 values) is the explicit backend state; `findByUserId` returns profile + documents + onlineStatus in one read. No separate progress store exists or is needed. `CODE VERIFIED`  |
| E   | Document submission               | **YES — Drivers**             | `submitDocument` writes `driver_documents`; document types are driver KYC. `CODE VERIFIED`                                                                                                                    |
| F   | Document business records         | **YES — Drivers**             | `DriverDocument` FK'd to `Driver`; `VehicleDocument` is a **separate model** — the schema author chose per-domain document tables. `SCHEMA VERIFIED`                                                          |
| G   | Document verification state       | **YES — Drivers**             | `verificationStatus` on `DriverDocument` gates `setOnline`. §6                                                                                                                                                |
| H   | Application verification/approval | **YES — Drivers**             | `reviewDriverVerification` drives `DriverVerificationStatus` under a row lock. Auth owns _role storage_; Drivers owns the _approval decision_. §7                                                             |
| I   | Rejection / suspension            | **YES — Drivers**             | `Driver.isSuspended`, `rejectionReason`, `setSuspended`. `CODE VERIFIED`                                                                                                                                      |
| J   | Eligibility                       | **YES — Drivers**             | `setOnline` is the decision point (verified + not suspended + verified licence). Geo owns the _spatial query_, Drivers owns _who may participate_. `CODE VERIFIED`                                            |
| K   | Online/offline status             | **YES — Drivers**             | `DriverOnlineStatus` FK'd to `Driver`. `SCHEMA VERIFIED`                                                                                                                                                      |
| L   | Shifts                            | **YES — Drivers**             | `DriverShiftLog` FK'd to `Driver`; managed by `StatusService`. `SCHEMA VERIFIED`                                                                                                                              |
| M   | Heartbeat                         | **YES — Drivers**             | `DriverOnlineStatus.heartbeatAt` + `HeartbeatTimeoutJob`. `CODE VERIFIED`                                                                                                                                     |
| N   | Location business validation      | **YES — Drivers**             | `location-plausibility.ts` (speed/age/noise) + mock-GPS rejection are **driver policy**, not spatial maths. `CODE VERIFIED`                                                                                   |
| O   | Availability                      | **SHARED**                    | Drivers decides _availability_; Geo owns the _index_; `PostgisProvider` currently applies **no driver-state filter**. Split is correct in principle, incomplete in practice. `CODE VERIFIED`                  |
| P   | Wallet read model                 | **YES — Drivers (read only)** | Two read methods; Payments owns every write. §9                                                                                                                                                               |
| Q   | Driver events                     | **YES — Drivers**             | `DRIVER_EVENT_CATALOG`, 8 types. `CODE VERIFIED`                                                                                                                                                              |
| R   | Driver jobs                       | **YES — Drivers**             | Both cron jobs operate solely on driver tables. `CODE VERIFIED`                                                                                                                                               |

---

## 5. Drivers vs Onboarding Module

| #   | Question                                        | Answer                                                                                |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Production code in `src/modules/onboarding/`?   | **NO** — `index.ts` is `export {};`; README is scaffold boilerplate                   |
| 2   | Does it own Driver onboarding today?            | **NO** — owns nothing                                                                 |
| 3   | Does Drivers contain onboarding code?           | **YES** — `services/onboarding/`, controller, repository, schema, route               |
| 4   | Duplicated onboarding logic?                    | **NO** — zero code exists in the top-level module                                     |
| 5   | Is top-level `onboarding/` generic or scaffold? | **Scaffold.** Not imported, not DI-registered, no routes                              |
| 6   | Should Driver onboarding stay in Drivers?       | **YES** — §4A                                                                         |
| 7   | Which Driver submodule should own it?           | `drivers/onboarding/` — `onboardDriver`, `updateProfile`, `getMe`, `driver-code.util` |
| 8   | Files to move between Drivers and onboarding?   | **NONE in either direction**                                                          |

`CODE VERIFIED`

---

## 6. Drivers vs Documents vs Files

### 6.1 Split-responsibility map

| Responsibility               | Owner today                                             | Correct owner                      | Status                  |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------- | ----------------------- |
| File bytes                   | **nobody** — client sends a URL                         | `files`                            | ❌ **BROKEN**           |
| Upload lifecycle             | `files` (unused by Drivers)                             | `files`                            | ⚠️ unwired              |
| Object storage / signed URLs | `files` (unused)                                        | `files`                            | ⚠️ unwired              |
| `fileId`                     | **does not exist** on `DriverDocument`                  | `files` issues, Drivers references | ❌ missing              |
| `fileUrl`                    | `drivers` — raw client string                           | should not exist                   | ❌ **BROKEN**           |
| File access control          | `files` (`decideRead`, `drivers:verify` scope) — unused | `files`                            | ⚠️ unwired              |
| File metadata                | `files` (unused)                                        | `files`                            | ⚠️ unwired              |
| `DriverDocument` record      | `drivers`                                               | `drivers`                          | ✅                      |
| `documentType`               | `drivers` — 8 driver KYC types                          | `drivers`                          | ✅                      |
| Required-document rules      | **nobody** — none declared                              | `drivers`                          | ❌ missing              |
| Verification status          | `drivers`                                               | `drivers`                          | ⚠️ no `VERIFIED` writer |
| Rejection reason             | `drivers` — only expiry job writes it                   | `drivers`                          | ⚠️ partial              |
| Expiry                       | `drivers` — `doc-expiration.job.ts`                     | `drivers`                          | ⚠️ inert                |
| Admin review                 | **DOES NOT EXIST**                                      | `drivers`                          | ❌ **MISSING**          |
| Eligibility check            | `drivers` — `setOnline`                                 | `drivers`                          | ✅                      |

### 6.2 Does the top-level `documents/` module own any reusable capability?

**No.** `export {};` + boilerplate README. No code, no schema, no route, no import, no DI registration. `CODE VERIFIED`

### 6.3 Verdict

> **Driver documents remain a Driver subdomain; Files owns storage.**
>
> Three pieces of evidence: `DriverDocumentType` is `DRIVING_LICENSE, RC, INSURANCE, AADHAAR, PAN, PUC, POLICE_VERIFICATION, PROFILE_PHOTO` — entirely driver/vehicle KYC, nothing generic. `VehicleDocument` **already exists as a separate model**, proving the schema author chose per-domain document tables over one shared table. And `DriverDocument.verificationStatus` is read by `setOnline` as the licence gate — moving it would make a core eligibility check a cross-module call for no gain. `SCHEMA VERIFIED` + `INFERENCE`
>
> What genuinely belongs to Files is the **bytes**: upload, storage, ownership, purpose policy, scanning, retention. Files already defines a `DRIVER_DOCUMENT` purpose with a `drivers:verify` operator scope and a `DRIVER_RELATIONSHIP_ENDED` retention rule — **built for this, with zero consumers.**

---

## 7. Driver Verification and Approval

### 7.1 Actual statuses

`SCHEMA VERIFIED` — `DriverVerificationStatus`: `PENDING | DOCUMENT_REVIEW | VERIFIED | REJECTED | SUSPENDED`. Only three are ever written; `SUSPENDED` is dead (suspension uses the `isSuspended` boolean).

### 7.2 Ownership

| Concern                    | Owner                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Driver verification status | **Drivers** — `Driver.verificationStatus`, written only by `reviewDriverVerification`                 |
| Admin approval             | **Drivers** — `POST /api/v1/drivers/:id/verify`, `roles:['admin']`                                    |
| Document approval          | **nobody** — no writer of `VERIFIED` exists                                                           |
| Event emitted              | `driver.verified` → `event_outbox` → `EventBus`                                                       |
| Consumer                   | **NONE.** `grep -rn "eventBus.on(" src` → one hit, `auth/consumers/epoch-invalidation.consumer.ts:17` |
| Role storage               | **Auth** — `user_roles`, `grantRole`, `uq_user_role_active` partial unique index                      |

### 7.3 Should Auth own role storage while Drivers owns the approval decision?

**Yes — and that split already exists correctly.** Auth owns `user_roles`, `grantRole`, epoch invalidation. Drivers owns `DriverVerificationStatus` and the approval route. **The only thing missing is the call between them.** `CODE VERIFIED`

### 7.4 Does `drivers → auth` create a cycle? — **NO** (corrected)

`DriverAccessRepository` imports **only `@core/database`** and reads `this.client.driver` via the shared Prisma client. **There is no `auth → drivers` import edge.** A `drivers → auth` import would therefore **not** create a cycle. `CODE VERIFIED`

|                   | **Option A — in the approval transaction**                                                                                        | **Option B — `driver.verified` subscriber**                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cycle risk        | **None** (corrected)                                                                                                              | None                                                                                                                               |
| Atomicity         | Strong — role and status commit together                                                                                          | Eventual — a window between `VERIFIED` and the role landing                                                                        |
| Precedent in repo | None                                                                                                                              | **Matches the only consumer pattern** (`EpochInvalidationConsumer`)                                                                |
| Failure mode      | Approval rolls back if the grant fails — visible                                                                                  | Outbox retry makes it at-least-once; `grantRole` is idempotent (returns `false` + partial unique index), so redelivery is harmless |
| Caution           | `grantRole` bumps the epoch **after** commit; calling it inside an outer transaction means the bump fires before the outer commit | Driver App must tolerate a brief `VERIFIED`-without-role window                                                                    |

> **The current architecture does not clearly establish one mechanism, so this audit does not choose.** Both are structurally safe. `REQUIRES DECISION`

---

## 8. Driver Status vs Geo vs Matching vs Dispatch

| Responsibility          | Correct owner | Actual today                                           | Verdict                                      |
| ----------------------- | ------------- | ------------------------------------------------------ | -------------------------------------------- |
| Eligibility decision    | Drivers       | `StatusService.setOnline`                              | ✅ correct                                   |
| Status / availability   | Drivers       | `DriverOnlineStatus` + `Driver.isAvailable`            | ✅ correct                                   |
| Business restrictions   | Drivers       | verified + not suspended + verified licence            | ⚠️ licence expiry unchecked                  |
| Coordinate validation   | Geo           | `latitudeSchema`/`longitudeSchema` from `@modules/geo` | ✅ correct                                   |
| Spatial indexing        | Geo           | H3 + Redis + PostGIS/GiST                              | ✅ correct                                   |
| Nearby queries          | Geo           | `findNearbyDrivers`, `nearby-driver.service.ts`        | ✅ correct — **but zero production callers** |
| Ranking / selection     | Matching      | `src/modules/matching/` = `export {};`                 | ❌ **absent**                                |
| Offer orchestration     | Dispatch      | primitives in `rides/`; `dispatch/` = `export {};`     | ❌ **absent, misplaced**                     |
| Ride state / acceptance | Rides         | `LifecycleService`                                     | ✅ correct                                   |

**Driver code implementing another module's responsibility:** **none found.** `LocationService` writes `driver_locations` (Driver-owned) and calls `geoService.recordDriverPosition` (Geo-owned) — the boundary is drawn correctly. `CODE VERIFIED`

**External code reaching into Driver internals:** **one** — `rides/controllers/ride-state.controller.ts` deep-imports `DriverRepository` and `driver.errors`, and separately **re-implements `actingDriverId` privately**. `CODE VERIFIED`

**Boundary defect, not a placement defect:** `PostgisProvider.findNearbyDrivers` queries `driver_locations` alone — no join to `drivers`, no filter on `verificationStatus`/`isSuspended`/`isAvailable`/online status. Combined with an ungated location route, unverified drivers would be dispatch candidates. **Geo cannot fix this alone** — it needs Drivers to supply the eligibility predicate. `CODE VERIFIED`

---

## 9. Driver Wallet vs Payments

| #   | Question                                  | Answer                                                                                                                                                  |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does Drivers have wallet code?            | **YES** — `services/wallet/wallet.service.ts` (11 LOC), `repositories/driver-wallet.repository.ts`, `controllers/driver-wallet.controller.ts`, 2 routes |
| 2   | Is it read-only?                          | **YES** — `getWallet`, `listTransactions`. `lockForUpdate` exists with **zero callers**                                                                 |
| 3   | Does Payments own mutations?              | **YES** — `SettlementService`, `LedgerService`, `PayoutService`, `DriverSettlement`                                                                     |
| 4   | Duplicate financial logic?                | **NO.** `grep -rln "earnings" src` → 3 Payments files, **zero Drivers files**                                                                           |
| 5   | Should `drivers/wallet` remain?           | **YES** — a driver-facing read projection with driver-scoped BOLA checks is legitimate                                                                  |
| 6   | Is a top-level earnings module necessary? | **NO.** Zero code would move into it; it would either sit empty or duplicate the ledger                                                                 |

`CODE VERIFIED`

---

## 10. Drivers vs Vehicles

| Responsibility                | Owner                | State                                                                           |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| Vehicle registration          | `vehicles`           | Schema complete, **zero code** (`export {};`)                                   |
| Vehicle verification          | `vehicles`           | `VehicleDocument.verificationStatus`; no vehicle-level approval column; no code |
| Vehicle documents             | `vehicles`           | `VehicleDocument` model; no code                                                |
| Vehicle assignment to driver  | `vehicles`           | `VehicleAssignment` model; **zero hand-written references**                     |
| Selecting vehicle for a ride  | `rides`              | `vehicleId` in the accept body, **unvalidated**                                 |
| Vehicle eligibility at accept | `rides` + `vehicles` | **No check at all**                                                             |

**Cross-module dependencies today: none.** `drivers` does not import `vehicles`; `vehicles` has no code to import anything. `Driver.currentVehicleId` exists as a UUID column with **no `@relation` and therefore no FK**, and has zero hand-written references. `CODE VERIFIED` + `SCHEMA VERIFIED`

**Where the vehicle gate belongs, from schema evidence:** `rides.vehicle_id` is **NOT NULL**; `RideDispatch.vehicleId` is **nullable**; `DriverOnlineStatus` has **no vehicle column**. The schema states that an offer may exist without a vehicle, a ride may not, and availability is modelled independently of vehicles. **The hard gate belongs at ride acceptance, not at online.** `SCHEMA VERIFIED`

**Do not merge Vehicles into Drivers.** Nothing in the architecture requires it.

---

## 11. Full Dependency Graph

### 11.1 Outbound from `drivers/`

`CODE VERIFIED` — complete scan:

```
drivers → @core/database              11
drivers → @core/database/Transaction   7
drivers → @shared/logger               4
drivers → @modules/geo                 4   ← ONLY domain-module dependency
drivers → @config                      4
drivers → @core/auth                   3   (callerId, callerHasRole, ForbiddenResourceError)
drivers → @core/events                 2
drivers → @core/cache/RedisService     2
drivers → @core/{metrics,errors,di}    3
```

### 11.2 Inbound to `drivers/`

| Importer                                     | What                                | Public API?   |
| -------------------------------------------- | ----------------------------------- | ------------- |
| `src/core/di.ts`                             | `registerDriversModule`             | ✅ barrel     |
| `src/routes/register.ts`                     | `driverRoutes`                      | ✅ sub-barrel |
| `rides/controllers/ride-state.controller.ts` | `DriverRepository`, `driver.errors` | ❌ **deep**   |
| 4 test files                                 | various                             | ❌ deep       |

**`src/jobs/workers/index.ts` resolves `'heartbeatTimeoutJob'` / `'docExpirationJob'` by DI _string token_** — a rename fails silently at cron time. `CODE VERIFIED`

### 11.3 The 15 required pair checks

| Pair               | Exists?                                                                                | Classification                                       |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Drivers → Auth     | **NO**                                                                                 | ⚠️ _Missing edge_ — why `grantRole` is never called  |
| Auth → Drivers     | **NO import.** Schema-level only (`driver-access.repository.ts` reads `client.driver`) | Allowed — guard-adjacent                             |
| Drivers → Files    | **NO**                                                                                 | ⚠️ _Missing edge_ — why `fileUrl` is unvalidated     |
| Files → Drivers    | **NO**                                                                                 | Allowed                                              |
| Drivers → Users    | **NO**                                                                                 | ⚠️ _Missing edge_ — why the raw `user.update` exists |
| Users → Drivers    | **NO**                                                                                 | Allowed                                              |
| Drivers → Payments | **NO**                                                                                 | Allowed — wallet reads go through the Prisma client  |
| Payments → Drivers | **NO**                                                                                 | Allowed                                              |
| Drivers → Geo      | **YES** ×4, via public barrel                                                          | **Allowed**                                          |
| Drivers → Matching | **NO**                                                                                 | Allowed (stub)                                       |
| Drivers → Dispatch | **NO**                                                                                 | Allowed (stub)                                       |
| Drivers → Rides    | **NO**                                                                                 | **Correct** — would cycle                            |
| Rides → Drivers    | **YES** — 1 file, 2 deep imports                                                       | **Questionable** — reaches private internals         |
| Drivers → Vehicles | **NO**                                                                                 | Allowed (stub)                                       |
| Vehicles → Drivers | **NO**                                                                                 | Allowed (stub)                                       |

> **Actual cycles: ZERO.** The only questionable edge is `rides → drivers` via deep imports — a **discipline** problem, not a cycle. `CODE VERIFIED`

---

## 12. API and Route Ownership Matrix

`CODE VERIFIED` — 13 routes, all in `routes/driver.routes.ts`, mounted at `/api/v1/drivers`.

| Method | Path                             | Guard                   | Controller | Service                   | Model                                  | Owner correct?                    | Belongs under          |
| ------ | -------------------------------- | ----------------------- | ---------- | ------------------------- | -------------------------------------- | --------------------------------- | ---------------------- |
| GET    | `/me`                            | auth                    | onboarding | — (repo direct)           | `Driver`                               | ✅                                | `drivers/onboarding`   |
| POST   | `/me/onboard`                    | auth                    | onboarding | `OnboardingService`       | `Driver`                               | ✅                                | `drivers/onboarding`   |
| PATCH  | `/:driverId/profile`             | auth                    | onboarding | `OnboardingService`       | `DriverProfile` + **`User`**           | ⚠️ email write bypasses Users     | `drivers/onboarding`   |
| POST   | `/:driverId/documents`           | auth                    | onboarding | `OnboardingService`       | `DriverDocument`                       | ⚠️ **in onboarding**              | `drivers/documents`    |
| POST   | `/:id/verify`                    | `admin`                 | onboarding | `OnboardingService`       | `Driver`                               | ⚠️ **in onboarding**              | `drivers/verification` |
| POST   | `/status/online`                 | `requireOperableDriver` | status     | `StatusService`           | `DriverOnlineStatus`, `DriverShiftLog` | ✅                                | `drivers/status`       |
| POST   | `/status/offline`                | **none**                | status     | `StatusService`           | same                                   | ⚠️ **ungated**                    | `drivers/status`       |
| POST   | `/heartbeat`                     | **none**                | status     | `StatusService`           | `DriverOnlineStatus`                   | ⚠️ ungated (safe — early-returns) | `drivers/status`       |
| POST   | `/:id/suspend`                   | `admin`                 | status     | `StatusService`           | `Driver`                               | ✅ owner; ⛔ **deadlocks**        | `drivers/status`       |
| POST   | `/location`                      | rateLimit               | location   | `LocationService`         | `DriverLocation`                       | ⚠️ **no eligibility gate**        | `drivers/location`     |
| GET    | `/:id/location`                  | auth + staff            | location   | `LocationService`         | `DriverLocation`                       | ✅                                | `drivers/location`     |
| GET    | `/:driverId/wallet`              | auth + staff            | wallet     | `DriverWalletViewService` | `DriverWallet`                         | ✅                                | `drivers/wallet`       |
| GET    | `/:driverId/wallet/transactions` | auth + staff            | wallet     | same                      | `DriverWalletTransaction`              | ✅                                | `drivers/wallet`       |

**All 13 belong under Drivers.** None should move to another top-level module. The two admin-initiated routes stay: business rules belong in the Driver subdomain regardless of initiator; a future Admin module should call Driver services, not copy them. `INFERENCE`

**Constraint:** `tests/integration/route-graph.test.ts` asserts the exact public route set — **paths must not change**, only source files. `TEST VERIFIED`

---

## 13. Database Ownership Matrix

`SCHEMA VERIFIED` — `prisma/schema/modules/driver/driver.prisma` + `20260724173304_init`.

| Model                     | PK         | Outbound FK                     | Uniques                 | Indexes                                 | Owner                             | Boundary                                                     |
| ------------------------- | ---------- | ------------------------------- | ----------------------- | --------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `Driver`                  | `id` uuid7 | **`userId → User.id`**          | `userId`, `driverCode`  | `verificationStatus`, `isAvailable`     | **Drivers**                       | ✅ aggregate root; sole external FK                          |
| `DriverProfile`           | `id`       | `driverId → Driver.id`          | `driverId`              | —                                       | **Drivers**                       | ✅ 1:1                                                       |
| `DriverDocument`          | `id`       | `driverId → Driver.id`          | **none**                | `driverId`, `documentType`, `expiresAt` | **Drivers**                       | ⚠️ **no `@@unique([driverId, documentType])`** → racy upsert |
| `DriverBankAccount`       | `id`       | `driverId → Driver.id`          | —                       | `driverId`                              | **Drivers** _(or Payments)_       | `REQUIRES DECISION` — zero callers                           |
| `DriverWallet`            | `id`       | `driverId → Driver.id`          | `driverId`              | —                                       | **Drivers read / Payments write** | ✅                                                           |
| `DriverWalletTransaction` | `id`       | `walletId → DriverWallet.id`    | —                       | `walletId`, `(driverId, createdAt)`     | **Payments write / Drivers read** | ⚠️ `driverId` denormalised, **no FK**                        |
| `DriverOnlineStatus`      | `driverId` | `driverId → Driver.id`          | PK                      | —                                       | **Drivers**                       | ✅ 1:1                                                       |
| `DriverLocation`          | `driverId` | `driverId → Driver.id`          | PK                      | GiST on `location`                      | **Drivers**                       | ✅ 1:1; no history table                                     |
| `DriverShiftLog`          | `id`       | `driverId → Driver.id`          | —                       | `(driverId, shiftStart)`                | **Drivers**                       | ✅                                                           |
| `VehicleAssignment`       | `id`       | driverId, vehicleId             | —                       | —                                       | **Vehicles**                      | ✅ outside Drivers; zero code                                |
| `RideDispatch`            | `id`       | requestId, driverId, vehicleId? | `(requestId, driverId)` | `driverId`                              | **Rides/Dispatch**                | ✅ outside Drivers                                           |

### 13.1 Six UUID columns with no foreign key

`SCHEMA VERIFIED` — a genuine integrity finding:

| Column                              | Should reference    | Consequence                                           |
| ----------------------------------- | ------------------- | ----------------------------------------------------- |
| `Driver.currentVehicleId`           | `Vehicle.id`        | Can hold a nonexistent or another driver's vehicle id |
| `Driver.approvedBy`                 | `User.id`           | Reviewer id unverifiable                              |
| `DriverDocument.verifiedBy`         | `User.id`           | Reviewer id unverifiable                              |
| `DriverBankAccount.verifiedBy`      | `User.id`           | Same                                                  |
| `DriverOnlineStatus.currentShiftId` | `DriverShiftLog.id` | Can point at a closed/absent shift                    |
| `DriverLocation.rideId`             | `Ride.id`           | Can point at a nonexistent ride                       |

**Reported only — no migration created.** Adding FKs is a Stage 6 concern, and `currentVehicleId` in particular is a cross-module FK requiring the Vehicles module to exist first.

**Also confirmed:** `driver_location_history` appears in **no migration**, despite `driver.prisma:221` claiming it is RANGE-partitioned and managed via raw SQL. **No location history is retained.**

---

## 14. Empty / Stub Module Analysis

`CODE VERIFIED` — all 15 stubs are `index.ts` = `export {};` + a boilerplate README. None imported, none DI-registered, none routed.

| Module                                                          | State | Recommendation                                                                                                                                                         |
| --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboarding`                                                    | Stub  | **Out of scope for the Driver cleanup.** Driver onboarding stays in Drivers. Keep only if a genuine multi-persona onboarding engine is planned; otherwise remove later |
| `documents`                                                     | Stub  | **Out of scope.** Driver documents stay in Drivers; `VehicleDocument` is already separate. Remove later unless a shared document capability is planned                 |
| `dispatch`                                                      | Stub  | **Keep** — real primitives exist in `rides/services/dispatch/` with zero callers; this is their eventual home                                                          |
| `matching`                                                      | Stub  | **Keep** — genuinely unbuilt; `geo.findNearbyDrivers` awaits an orchestrator                                                                                           |
| `vehicles`                                                      | Stub  | **Keep** — complete schema, no code; a real planned module                                                                                                             |
| `admin`, `support`                                              | Stub  | **Keep** — operator surface (queues, lists, audit) is genuinely missing                                                                                                |
| `riders`                                                        | Stub  | Out of scope — customer flows live in `users` + `rides`                                                                                                                |
| `pricing`                                                       | Stub  | Out of scope — fare logic lives in `rides/services/fare/`                                                                                                              |
| `analytics`, `chat`, `settings`, `sos`, `reviews`, `promotions` | Stub  | Out of scope                                                                                                                                                           |

**No stub should be auto-filled.** `INFERENCE`

---

## 15. Current Structure Problems

**Classification: Mixed.** Horizontal technical layers at the module root, with a partial vertical split **inside `services/` only**.

| #   | Problem                                                                                     | Evidence                                             |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| S1  | Split is one layer deep — 5 service folders, other 5 layers flat                            | `services/{location,onboarding,shift,status,wallet}` |
| S2  | **Documents have no owner** — 5 files, 3 layers, write path inside _onboarding_             | §6                                                   |
| S3  | `OnboardingService` holds 4 concerns                                                        | §3 #29                                               |
| S4  | 13 routes / 5 schemas in single files spanning 5 domains                                    | §12                                                  |
| S5  | Layer inversion — `StatusService` bypasses the dead `ShiftService` to reach the repository  | §3 #30                                               |
| S6  | `rides` deep-imports Driver internals                                                       | §11.2                                                |
| S7  | No `shared/` — `driver-identity.ts` sits in `controllers/` but serves 4 controllers + Rides | §3 #4                                                |
| S8  | **No empty scaffolding exists** — nothing to move _into_                                    | `find … -type d -empty` → none                       |

---

## 16. Recommended Target Driver Structure

Every folder below is filled by existing files. **No invented scaffolding.**

```
src/modules/drivers/
├── onboarding/     controllers/ services/ schemas/ routes/ utils/
├── documents/      controllers/ services/ repositories/ schemas/ routes/ jobs/
├── verification/   controllers/ services/ schemas/ routes/
├── status/         controllers/ services/ repositories/ schemas/ routes/ jobs/
├── shifts/         services/ repositories/
├── location/       controllers/ services/ repositories/ schemas/ routes/
├── wallet/         controllers/ services/ repositories/ routes/
├── shared/         authorization/ repositories/ events/ metrics/ schemas/
│                   + driver.types.ts · driver.errors.ts · driver.constants.ts
├── routes/index.ts composes submodule routes under /api/v1/drivers
└── index.ts        DI registration + stable public barrel
```

| Folder          | Why inside Drivers                              | Existing files                                                                                                                                 | May access                              |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `onboarding/`   | Driver creation + driver-domain profile (§4A–D) | `onboarding.service` (2 methods), onboarding controller (3 methods), `updateDriverProfileSchema`, 3 routes, `driver-code.util`                 | `shared/`, Users (email)                |
| `documents/`    | Driver KYC records (§6)                         | `driver-document.repository`, `submitDocument`, `doc-expiration.job`, `submitDriverDocumentSchema`, 1 route                                    | `shared/`, Files                        |
| `verification/` | Approval state machine (§7)                     | `reviewDriverVerification`, `reviewVerificationSchema`, 1 route                                                                                | `shared/`, Auth, `documents/`           |
| `status/`       | Operational state + eligibility (§4J–M)         | `StatusService`, `driver-status.repository`, `heartbeat-timeout.job`, `heartbeatSchema`, 4 routes                                              | `shared/`, `documents/`, `shifts/`, Geo |
| `shifts/`       | `DriverShiftLog` lifecycle                      | `driver-shift.repository` (+ `ShiftService` if revived)                                                                                        | `shared/`                               |
| `location/`     | Driver position + plausibility policy (§4N)     | `LocationService`, `location-plausibility`, `driver-location.repository`, `updateLocationSchema`, 2 routes                                     | `shared/`, Geo                          |
| `wallet/`       | Driver-facing read projection (§9)              | `DriverWalletViewService`, `driver-wallet.repository`, 2 routes                                                                                | `shared/`                               |
| `shared/`       | Used by ≥2 submodules                           | `driver-identity.ts` (4+rides), `driver.repository.ts` (4+rides), `events/catalog.ts`, `metrics/`, `error-response.ts`, types/errors/constants | —                                       |

**Deliberately NOT created:** `profile/` (two methods — scaffolding without substance), `eligibility/` (lives inside `setOnline`; extracting it is a logic change), `earnings/` (§9), `consumers/` (none exist yet — §7.4 decides this).

---

## 17. Exact File Move Table

⭐ = minimal high-confidence pass. `A` = full vertical split.

| Current File                                                                                      | Class     | Responsibility          | Target File                                                                                                                                              | Module  | Reason                  | Risk     | Deps to update                                                            |
| ------------------------------------------------------------------------------------------------- | --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------- | -------- | ------------------------------------------------------------------------- |
| `repositories/driver-document.repository.ts` ⭐                                                   | KEEP      | `driver_documents` CRUD | `documents/repositories/…`                                                                                                                               | drivers | Sole owner of the table | LOW      | 3 imports + `index.ts`                                                    |
| `jobs/doc-expiration.job.ts` ⭐                                                                   | KEEP      | Expiry sweep            | `documents/jobs/…`                                                                                                                                       | drivers | Documents concern       | MEDIUM   | `index.ts`, jobs barrel · **DI token `docExpirationJob` MUST NOT change** |
| `services/onboarding/onboarding.service.ts` ⭐                                                    | **SPLIT** | 4 concerns              | `onboarding/services/` (onboard, profile) + `documents/services/document-submission.service.ts` + `verification/services/driver-verification.service.ts` | drivers | §3 #29                  | MEDIUM   | +2 DI regs, `driverService.inject()`                                      |
| `controllers/driver-onboarding.controller.ts` ⭐                                                  | **SPLIT** | 5 methods, 3 domains    | `onboarding/controllers/` + `documents/controllers/` + `verification/controllers/`                                                                       | drivers | Mirrors the service     | MEDIUM   | +2 DI regs, `driverController.inject()` · **fix the import first**        |
| `schemas/driver.schemas.ts` ⭐/A                                                                  | **SPLIT** | 5 schemas, 4 domains    | per-submodule `schemas/`                                                                                                                                 | drivers | One consumer each       | LOW      | 4 imports                                                                 |
| `routes/driver.routes.ts` ⭐/A                                                                    | **SPLIT** | 13 routes, 5 domains    | per-submodule `routes/` + composing `routes/index.ts`                                                                                                    | drivers | §12                     | MEDIUM   | `routes/register.ts` · **paths must not change**                          |
| `repositories/driver-status.repository.ts` A                                                      | KEEP      | `driver_online_status`  | `status/repositories/`                                                                                                                                   | drivers | Status concern          | LOW      | 3 imports                                                                 |
| `repositories/driver-location.repository.ts` A                                                    | KEEP      | PostGIS upsert          | `location/repositories/`                                                                                                                                 | drivers | Location concern        | MEDIUM   | 1 import + **`geo-nearby.test.ts` deep import**                           |
| `repositories/driver-shift.repository.ts` A                                                       | KEEP      | Shift logs              | `shifts/repositories/`                                                                                                                                   | drivers | Shift concern           | LOW      | 2 imports                                                                 |
| `repositories/driver-wallet.repository.ts` A                                                      | UNCLEAR   | Wallet read             | `wallet/repositories/`                                                                                                                                   | drivers | Wallet concern          | LOW      | 1 import                                                                  |
| `controllers/driver-{status,location,wallet}.controller.ts` A                                     | KEEP      | HTTP                    | `<domain>/controllers/`                                                                                                                                  | drivers | Domain concern          | LOW      | `index.ts`                                                                |
| `jobs/heartbeat-timeout.job.ts` A                                                                 | KEEP      | Stale sweep             | `status/jobs/`                                                                                                                                           | drivers | Status concern          | MEDIUM   | **DI token `heartbeatTimeoutJob` MUST NOT change**                        |
| `services/{location,shift,status,wallet}/*` A                                                     | KEEP      | Services                | `<domain>/services/`                                                                                                                                     | drivers | Vertical split          | LOW      | `services/index.ts`                                                       |
| `utils/driver-code.util.ts` A                                                                     | KEEP      | Code generator          | `onboarding/utils/`                                                                                                                                      | drivers | Onboarding-only         | LOW      | 1 import                                                                  |
| `controllers/driver-identity.ts` A                                                                | KEEP      | Driver authz helpers    | `shared/authorization/`                                                                                                                                  | drivers | 4 submodules + rides    | **HIGH** | 5 callers · **security-critical, own commit**                             |
| `repositories/driver.repository.ts` A                                                             | KEEP      | Aggregate root          | `shared/repositories/`                                                                                                                                   | drivers | 4 submodules + rides    | **HIGH** | **rides deep-import — convert to barrel FIRST**                           |
| `events/catalog.ts`, `metrics/`, `types/`, `errors/`, `constants/`, `schemas/error-response.ts` A | KEEP      | Cross-cutting           | `shared/…`                                                                                                                                               | drivers | Shared within Drivers   | LOW      | barrels                                                                   |

**No file moves to another top-level module.**

---

## 18. Files That Must Not Move

| File / area                                     | Why                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `auth/services/otp/**`                          | Driver App calls the **same two OTP endpoints** as Customer. Duplicating splits the audit trail and rate-limit budget |
| `auth/services/auth.service.ts`                 | `grantRole`/`revokeRole`/`ensureDefaultRole` — role storage is platform-wide                                          |
| `auth/plugins/auth.plugin.ts`                   | `authorize()`, `requireOperableDriver` — one guard surface across 5 routes in 2 modules                               |
| `auth/repositories/driver-access.repository.ts` | Guard-adjacent; imports only `@core/database`. Moving it fragments the guard for cosmetic gain. **Security-critical** |
| `users/**`                                      | `User` is canonical identity; `users.email` stays. **Do not add email to `DriverProfile`**                            |
| `files/**`                                      | Bytes, upload, storage, purpose, scanning, retention. `DRIVER_DOCUMENT` purpose already defined                       |
| `geo/**` incl. `nearby-driver.service.ts`       | Named "driver" but a **spatial query**. Geo owns the index                                                            |
| `payments/**`                                   | Ledger, settlement, payouts, earnings                                                                                 |
| `rides/**` incl. dispatch primitives            | Rides depends on Drivers — never the reverse                                                                          |
| `vehicles/**`                                   | Separate module over a complete schema                                                                                |
| `src/config/driver/driver.config.ts`            | `src/config/` holds every module's config — platform convention                                                       |
| `core/**`                                       | `TransactionManager`, outbox, DI, cache, metrics                                                                      |

---

## 19. Circular Dependency Risks

**Actual cycles today: ZERO** (§11.3). `CODE VERIFIED`

| Prospective edge                        | Cycle?                    | Note                                                               |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `drivers → auth` (`grantRole`)          | **NO** — corrected (§7.4) | No `auth → drivers` import exists                                  |
| `drivers → users` (`updateEmail`)       | **NO**                    | Users does not import Drivers                                      |
| `drivers → files` (`fileId` validation) | **NO**                    | Files does not import Drivers                                      |
| `drivers → rides`                       | **YES — would cycle**     | Rides already imports Drivers. **Never add**                       |
| `drivers → vehicles` (accept-time gate) | **NO** today              | But the gate belongs in `rides`, not `drivers` (§10)               |
| `geo → drivers` (eligibility filter)    | **YES — would cycle**     | Drivers imports Geo. Pass a predicate/id-list **into** Geo instead |

**Two rules for the eventual implementation:** never import `rides` from `drivers`; never import `drivers` from `geo`. `INFERENCE`

---

## 20. Dead / Duplicate Code Findings

**Dead — `DEAD_OR_UNUSED`:** `plugins/driver.plugin.ts` + barrel (zero callers; same for the other 4 module plugins) · `schemas/driver.responses.ts` (zero references) · `services/shift/shift.service.ts` + barrel (zero callers) · `DriverWalletRepository.lockForUpdate` · `InvalidDriverStatusTransitionError`, `DocumentValidationError` (zero throw sites) · `DriverMetrics.heartbeatTimeout()` · 4 of 8 declared events never published · `DriverVerificationStatus.SUSPENDED` · `driverConfig.requireApprovedDocuments` (**default `true`, zero consumers — the flag for the missing document gate**) · `driverConfig.maxContinuousShiftHours`.

**Inert but wired:** `DocExpirationJob` — scheduled, DI-resolved, Redis-locked; its query needs `verificationStatus: 'VERIFIED'`, which no production code writes.

**Duplicates — `DUPLICATED_RESPONSIBILITY`:**

| #   | Duplication                                                                                                                             | Severity                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| D1  | `actingDriverId` in `drivers/controllers/driver-identity.ts` **and** privately in `rides/controllers/ride-state.controller.ts`          | **Security-relevant** — authorization mapping can drift          |
| D2  | Two write paths to `users.email` — `UserRepository.updateEmail` (correct, **unused**) vs raw `client.user.update` in `DriverRepository` | **HIGH** — 500 not 409 on collision; `isEmailVerified` unmanaged |
| D3  | Two `updateVerificationStatus` state machines co-located in one service                                                                 | MEDIUM                                                           |
| D4  | Three authorization vocabularies — role slugs (enforced), `PERMISSION_SEED` (unenforced, zero callers), Files' `SCOPES_FOR_ROLE`        | MEDIUM                                                           |
| D5  | Five unused module `plugins/`                                                                                                           | LOW                                                              |

---

## 21. Refactor Prerequisites

`BUILD VERIFIED` — re-executed against the current tree.

| Check                               | Result                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc -p tsconfig.json --noEmit` | **FAIL** — `driver-onboarding.controller.ts(18,28): TS2304 Cannot find name 'DriverNotFoundError'`                        |
| `npm run lint`                      | **FAIL** — `onboarding.service.ts:39:19 Unexpected any` (`--max-warnings=0`)                                              |
| `npm run build`                     | **FAIL** — `clean` runs, `tsc` fails, `tsc-alias` never runs → `dist/` keeps `require("@core/auth")` → `MODULE_NOT_FOUND` |
| `npm run prisma:validate`           | **PASS**                                                                                                                  |
| `npm run test:unit`                 | **PASS — 714/714**, reproducible                                                                                          |
| `npm run test:integration`          | **NOT VERIFIABLE** — no Postgres/Redis; Docker unavailable                                                                |
| `npm run format:check`              | **FAIL** — 29 files                                                                                                       |
| Working tree                        | **DIRTY — 13 files**, 5 in `drivers/`                                                                                     |

### 21.1 HEAD vs working tree

| Behaviour                    | HEAD `273aadb`                                                | Working tree                                           |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| `GET /drivers/me`            | **`createOrGetDriver`** — a GET that **created a Driver row** | Pure read + `DriverNotFoundError` — **import missing** |
| `POST /me/onboard`           | **Does not exist**                                            | Exists                                                 |
| Service method               | `createOrGetDriver`                                           | `onboardDriver`                                        |
| `P2002` handling             | **None**                                                      | Present                                                |
| Email on driver profile      | **Not accepted**                                              | Accepted via **raw `user.update`**                     |
| `UserRepository.updateEmail` | **Does not exist**                                            | Added — **and unused**                                 |
| Typecheck / lint / build     | _(not checked out — instruction not to touch the tree)_       | **All FAIL**                                           |

### 21.2 Prerequisites before any move

1. **Fix the two build errors.** 2. **Land or isolate the 13-file changeset** — it is mid-rewrite of the exact files to be moved. 3. **Add `typecheck` + `lint` to CI** — `tsx` strips types, so 714 tests pass over a non-compiling tree. 4. **Add HTTP smoke tests for all 13 driver routes** — currently **zero** exist, so a refactor could break onboarding, profile, documents, verification, online, or location with no test failing. 5. **Convert deep imports to barrel imports** — `rides/controllers/ride-state.controller.ts` + 4 tests.

**Guards that already work:** `tests/unit/di-wiring.test.ts` statically parses `src/` for `asClass`/constructor params and **follows moved files automatically**. `tests/integration/route-graph.test.ts` pins the public route set. `TEST VERIFIED`

---

## 22. Customer Flow Safety Verification

**Shared infrastructure between Customer and Driver:** Auth (OTP, JWT, sessions, roles, epoch) · Users (`User`, `UserProfile`, `users.email`) · Files · Rides · Payments · Core.

**Critical fact:** the Customer flow **imports nothing from `src/modules/drivers/`**. `CODE VERIFIED`

| Guarantee                                    | Safe?                          | Why                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OTP behaviour unchanged                      | ✅                             | `auth` module untouched; Drivers does not import it                                                                                                                                                                           |
| Customer role assignment unchanged           | ✅                             | `ensureDefaultRole` in `auth`                                                                                                                                                                                                 |
| JWT contract unchanged                       | ✅                             | `TokenService` untouched                                                                                                                                                                                                      |
| No frontend role selection                   | ✅                             | **No `role`/`roles`/`userType`/`appType` field in any request schema**; Zod strips unknown keys; roles read from `user_roles` at issuance and re-read on refresh                                                              |
| Customer login unchanged                     | ✅                             | Shared path untouched                                                                                                                                                                                                         |
| No accidental Driver creation for a customer | ⚠️ **Working tree fixes this** | At **HEAD**, `GET /drivers/me` called `createOrGetDriver` — a **read endpoint that created a Driver row**. The uncommitted diff makes it a pure read. **Landing that changeset improves customer safety**                     |
| User ownership rules intact                  | ⚠️ **One defect**              | `DriverRepository.updateProfile` writes `users.email` via raw Prisma, bypassing `UserRepository.updateEmail`. A collision returns **500 not 409**; `isEmailVerified` unmanaged. **Pre-existing, not caused by restructuring** |

**Only inbound production edges to Drivers:** `core/di.ts` (barrel), `routes/register.ts` (barrel), `rides/controllers/ride-state.controller.ts` (**deep — the single hazard**, fixed in prerequisite 5).

> **Verdict: the Customer flow is safe.** Route paths do not change, so `route-graph.test.ts` stays green. The one caveat is that the shared `users.email` path is touched by the uncommitted changeset — prerequisites must land first.

---

## 23. Recommended Refactor Order

Derived from the audit, not assumed.

**Stage 0 — Stabilize (blocking).** The five prerequisites in §21.2. _Exit:_ typecheck ✅ lint ✅ 714 unit ✅ 13 smoke tests ✅ committed.
_Why first:_ nothing is verifiable while the tree fails to compile and a rewrite is in flight.

**Stage 1 — Extract `documents/` + `verification/`.** The two highest-confidence subdomains: 2 file moves + 2 splits (service, controller) + 2 schemas + 2 routes. DI token names unchanged.
_Why first among moves:_ §6 identifies documents as the **only** genuine placement defect, and §7 shows verification is a distinct state machine currently disguised as onboarding. This is also where the missing review capability will land — doing the move first means writing that feature once, in the right place.

**Stage 2 — Extract `onboarding/`.** What remains of `OnboardingService` after Stage 1, plus its controller, schema, routes, and `driver-code.util`.
_Why second:_ it is defined by subtraction from Stage 1 and is trivially safe once documents and verification are gone.

**Stage 3 — `status/`, `shifts/`, `location/`, `wallet/`** (Option A only). Controllers, repositories, schemas, jobs.
_Why third:_ larger, lower value, and gated on the smoke tests from Stage 0. `heartbeatTimeoutJob` string token must not change; `geo-nearby.test.ts` deep-imports the location repository.

**Stage 4 — `shared/`.** `driver-identity.ts` and `driver.repository.ts` last, each in its own commit.
_Why last:_ the two **HIGH**-risk moves — one security-critical with 5 callers, one deep-imported by Rides.

**Stage 5 — Registration verification.** All 13 route paths unchanged; all 20 DI tokens resolve; both cron string tokens resolve; event type strings unchanged.

**Stage 6 — Missing production transitions (first stage with logic changes).** Document review service + route; completeness gate via the existing `requireApprovedDocuments` flag; `grantRole` on approval (mechanism per §7.4); suspend deadlock; Files `fileId` integration; then the full-lifecycle integration test with zero direct database writes.

**Stage 7 — Cleanup.** Delete the dead set in one commit; refresh the stale `README.md`; decide on `driver-bank.repository.ts` and `shift.service.ts`.

---

## 24. Risk Matrix

| #   | Risk                                                                                            | Likelihood                 | Impact       | Mitigation                                                                 |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------- | ------------ | -------------------------------------------------------------------------- |
| R1  | Moving files while the tree does not compile                                                    | **Certain** if skipped     | **HIGH**     | Stage 0.1                                                                  |
| R2  | Conflicts with the in-flight 13-file changeset                                                  | **HIGH**                   | **HIGH**     | Stage 0.2 — land or isolate first                                          |
| R3  | Silent breakage with zero route tests                                                           | **HIGH**                   | **HIGH**     | Stage 0.4 — 13 smoke tests                                                 |
| R4  | `rides` deep-import breaks on move                                                              | **Certain** without action | MEDIUM       | Stage 0.5 — barrel imports                                                 |
| R5  | **DI job token renamed** → cron throws `No handler registered` **at runtime, not compile time** | MEDIUM                     | **HIGH**     | Never rename `docExpirationJob` / `heartbeatTimeoutJob`; verify in Stage 5 |
| R6  | Route path accidentally changed                                                                 | LOW                        | **HIGH**     | `route-graph.test.ts`                                                      |
| R7  | DI constructor/registration mismatch after a split                                              | MEDIUM                     | MEDIUM       | `di-wiring.test.ts` (self-following)                                       |
| R8  | `driver-identity.ts` move alters authorization                                                  | LOW                        | **CRITICAL** | Stage 4, own commit, 5 callers documented                                  |
| R9  | Test deep imports break                                                                         | **HIGH**                   | LOW          | Compile-time failure; update in the same commit                            |
| R10 | Customer flow regression                                                                        | **LOW**                    | **CRITICAL** | Customer imports nothing from Drivers (§22)                                |
| R11 | Reorganizing before implementing → new code in the wrong folder                                 | MEDIUM                     | MEDIUM       | Stage 1–2 before Stage 6                                                   |
| R12 | Event/outbox breakage                                                                           | **NONE**                   | —            | Type strings, not paths                                                    |
| R13 | Scope creep into a 35-file split                                                                | MEDIUM                     | MEDIUM       | Stop after Stage 2; re-evaluate                                            |

---

## 25. Final GO / NO-GO Decision

> ### 🚫 **NO-GO to begin moving files — ✅ GO to plan the move**
>
> **Why NO-GO now.** Four blocking prerequisites, all Stage 0: the tree does not compile or lint; an uncommitted 13-file changeset is mid-rewrite of the exact files to be moved; **zero HTTP tests exist for any of the 13 driver routes**, making a refactor unverifiable; and Rides deep-imports Driver internals and breaks on the first move. Realistically under a day.
>
> **Why GO to plan.** The ownership question is settled with evidence, and the answer is reassuring: **zero files need to move to another top-level module.** The `documents/`, `onboarding/`, and `vehicles/` stubs are auto-generated scaffolding with identical boilerplate READMEs — they carry no ownership claim. Driver documents and driver onboarding correctly belong to the Driver domain; Files owns bytes, Payments owns money, Geo owns spatial queries, Auth owns role storage, and every one of those boundaries is already drawn correctly in the code.
>
> **The restructuring is internal and smaller than expected:** extract `documents/` and `verification/` (~8 moves, ~15 import updates) captures the single genuine placement defect. The full vertical split (~35 moves) is a consistency improvement to decide on afterwards.
>
> **Two corrections carried by this audit.** First, a `drivers → auth` call for `grantRole` **does not** create a cycle — `auth` reads the `drivers` _table_, not the Drivers _module_. Both role-assignment mechanisms are structurally safe, and the choice is about transactional versus eventual semantics alone. Second, the create-on-GET defect on `GET /drivers/me` was real **at HEAD** and is already fixed in the working tree — landing that changeset _improves_ customer safety rather than risking it.
>
> **One decision remains open and should be made before Stage 6, not during it:** the role-assignment mechanism (§7.4). The current architecture does not establish one, so this audit deliberately does not choose. `REQUIRES DECISION`
>
> **Sequence:** Stage 0 → Stage 1 (documents + verification) → Stage 2 (onboarding) → re-evaluate whether Stages 3–4 are worth it → only then Stage 6 logic work. Implementing document review before extracting `documents/` would place new code in the wrong folder and require moving it twice.

---

DRIVER MODULE OWNERSHIP AND PLACEMENT AUDIT COMPLETE
