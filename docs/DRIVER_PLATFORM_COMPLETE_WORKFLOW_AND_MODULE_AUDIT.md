# Driver Platform — Complete Workflow and Module Audit

**Repository:** `backend_zaroorat` · **Branch:** `feature/auth` · **HEAD:** `269e927`
**Date:** 2026-08-20
**Type:** Investigation only. No code modified, no file created except this report, no spec/plan/tasks/migration, no module moved, no folder restructured.

**Evidence labels:** `CODEBASE VERIFIED` · `TEST VERIFIED` · `SCHEMA VERIFIED` · `BUILD VERIFIED` · `INFERENCE`

> **Relationship to prior work.** This consolidates and **extends** `docs/FULL_PLATFORM_DRIVER_WORKFLOW_INVESTIGATION.md`. Genuinely new in this pass: the **complete unique-index enumeration across all migrations** (§2), the **exact DI string-token map for jobs** (§17), the **zero-caller classification table** (§19), and the **30-row truth table** (§20). All prior claims were re-verified against the current tree, not copied.

---

## 1. Executive Summary

**The platform is a well-built modular monolith whose modules are individually strong and mutually disconnected at five specific seams.** This is a wiring problem, not a build problem.

**Health is good and improved today.** Typecheck `PASS`, lint `PASS`, build completes end-to-end, 714/714 unit tests, working tree clean. Only `format:check` fails — 34 files, **all outside `src/`**. `BUILD VERIFIED`

**Seven findings define the state:**

1. **Where the lifecycle stops: document `PENDING → VERIFIED`.** No route, service, job, or subscriber writes `VERIFIED` to `DriverDocument.verificationStatus`. Since `setOnline` requires a verified driving licence, **no driver can ever go online.** `CODEBASE VERIFIED`

2. **Ride completion already posts a correct double-entry ledger transaction** — `completeRide` calls `ledgerService.recordTripPayment(...)` inside the same transaction, branching correctly on cash vs prepaid. **Driver earnings are recorded.** `CODEBASE VERIFIED`

3. **But the money never surfaces.** `SettlementJob` is DI-registered as `settlementJob` and absent from **both** `JOB_SCHEDULES` (9 entries) and `MAINTENANCE_HANDLERS` (9 entries). And `DriverWallet` is **only ever created, never updated** — the sole write in the codebase is `driverWallet.create`. The wallet reads **zero, forever**. `CODEBASE VERIFIED`

4. **The complete unique-index enumeration proves two race conditions.** Across every migration there is **no unique index on `rides(driver_id)` for active statuses** (only a plain `rides_driver_id_idx`), and **no unique index on `driver_documents(driver_id, document_type)`**. One driver can hold unlimited concurrent rides, and concurrent document submissions duplicate. `SCHEMA VERIFIED`

5. **Four zero-caller symbols summarise the platform.** `grantRole`, `offerToDriver`, `findActiveByDriver` each have **exactly 1 reference in `src/`** — their own definition. `findNearbyDrivers` has 3, all inside geo's own delegation chain. `CODEBASE VERIFIED`

6. **One event subscriber exists platform-wide** — `epoch-invalidation.consumer.ts`. Every other event is durably outboxed and triggers nothing. `CODEBASE VERIFIED`

7. **`Drivers → Auth` would NOT create a cycle.** `DriverAccessRepository` imports only `@core/database` and reads `this.client.driver` via the shared Prisma client — there is **no `auth → drivers` import edge**. Both role-assignment mechanisms are structurally safe. `CODEBASE VERIFIED`

**Zero files need to move to another top-level module.** §21.

---

## 2. Database and Prisma Lifecycle Audit

`SCHEMA VERIFIED` — read from `prisma/schema/**` and all migrations.

### 2.1 Entity constraint map

| Entity                          | PK         | External FK                                                              | Unique constraints                                                                                    | Lifecycle field                                    |
| ------------------------------- | ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `User`                          | `id` uuid7 | —                                                                        | `users_email_key`, **`uq_users_phone_active` (partial: `WHERE deleted_at IS NULL`)**                  | `status`, `deletedAt`                              |
| `Role`                          | `id`       | —                                                                        | `roles_slug_key`                                                                                      | —                                                  |
| `UserRoleAssignment`            | `id`       | userId, roleId                                                           | **`uq_user_role_active` (partial: `WHERE revoked_at IS NULL`)**                                       | `revokedAt`, `expiresAt`                           |
| `Permission` / `RolePermission` | `id`       | —                                                                        | `permissions_code_key`, `role_permissions_role_id_permission_id_key`                                  | —                                                  |
| `Driver`                        | `id`       | **`userId → User.id`**                                                   | `drivers_user_id_key`, `drivers_driver_code_key`                                                      | `verificationStatus`, `isSuspended`, `isAvailable` |
| `DriverProfile`                 | `id`       | `driverId → Driver.id`                                                   | `driver_profiles_driver_id_key`                                                                       | —                                                  |
| `DriverDocument`                | `id`       | `driverId → Driver.id`                                                   | **NONE** ⚠️                                                                                           | `verificationStatus`, `expiresAt`                  |
| `DriverOnlineStatus`            | `driverId` | `driverId → Driver.id`                                                   | PK                                                                                                    | `status`, `heartbeatAt`                            |
| `DriverLocation`                | `driverId` | `driverId → Driver.id`                                                   | PK + GiST on `location`                                                                               | `recordedAt`                                       |
| `DriverShiftLog`                | `id`       | `driverId → Driver.id`                                                   | —                                                                                                     | `shiftStart`, `shiftEnd`                           |
| `DriverWallet`                  | `id`       | `driverId → Driver.id`                                                   | `driver_wallets_driver_id_key`                                                                        | `balance` — **never updated**                      |
| `DriverBankAccount`             | `id`       | `driverId → Driver.id`                                                   | —                                                                                                     | `verificationStatus`                               |
| `Vehicle`                       | `id`       | —                                                                        | `vehicles_registration_number_key`, `vehicles_vin_key`                                                | `isActive`                                         |
| `VehicleType`                   | `id`       | —                                                                        | `vehicle_types_code_key`                                                                              | `isActive`                                         |
| `VehicleAssignment`             | `id`       | driverId, vehicleId                                                      | **NONE**                                                                                              | `releasedAt`, `status`                             |
| `RideRequest`                   | `id`       | customerId, vehicleTypeId                                                | —                                                                                                     | `status`                                           |
| `Ride`                          | `id`       | customerId, driverId, **`vehicleId` NOT NULL**, vehicleTypeId, requestId | `rides_ride_code_key`, **`rides_request_id_key`**                                                     | `status`, `paymentStatus`                          |
| `RideDispatch`                  | `id`       | requestId, driverId, `vehicleId?` **nullable**                           | `ride_dispatches_request_id_driver_id_key`                                                            | `response`, `expiresAt`                            |
| `PaymentLedgerEntry`            | `id`       | —                                                                        | —                                                                                                     | `account`, `direction`                             |
| `DriverSettlement`              | `id`       | driverId                                                                 | `driver_settlements_driver_id_period_start_period_end_key`                                            | `status`                                           |
| `UserDevice`                    | `id`       | userId                                                                   | `user_devices_user_id_device_id_key`                                                                  | `fcmToken` — **never read**                        |
| `File`                          | `id`       | ownerUserId                                                              | `uq_files_storage_key`, `files_superseded_by_id_key`, **`uq_files_one_live_profile_image` (partial)** | `status`, scan state                               |

### 2.2 The two missing database backstops

`SCHEMA VERIFIED` — enumerated **every** `CREATE UNIQUE INDEX` across all migrations:

| Gap                                                           | Evidence                                                                                                                                                                                       | Consequence                                                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No unique on `rides(driver_id)` for active statuses**       | `rides` has `rides_ride_code_key`, `rides_request_id_key`, and plain indexes `rides_customer_id_idx`, **`rides_driver_id_idx`**, `rides_status_idx`, `rides_created_at_idx`. No partial unique | **One driver, unlimited concurrent rides.** `rides_request_id_key` protects one ride per _request_ — accepting two _different_ requests succeeds both times |
| **No unique on `driver_documents(driver_id, document_type)`** | Only plain indexes on `driver_id`, `document_type`, `expires_at`                                                                                                                               | Concurrent submissions of the same type both insert; `docs.some(...)` passes if _either_ copy is approved                                                   |

**The codebase demonstrably knows how to do this** — `uq_users_phone_active`, `uq_user_role_active`, and `uq_files_one_live_profile_image` are all **partial unique indexes**. The pattern exists; it was simply not applied to these two.

### 2.3 Answers to the Phase 2 questions

| #   | Question                                                     | Answer                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8   | Are active rides constrained per driver?                     | **NO** — §2.2                                                                                                                                                                                                                                          |
| 9   | Is vehicle assignment validated?                             | **NO** — `VehicleAssignment` has zero hand-written references                                                                                                                                                                                          |
| 10  | Is wallet a projection or source of truth?                   | **Intended projection; currently neither** — the ledger is the source of truth, and the wallet is never projected into                                                                                                                                 |
| 11  | Are document and driver verification intentionally separate? | **YES, correctly** — `VerificationStatus` (3 values) for documents vs `DriverVerificationStatus` (5 values) for the driver. Two distinct state machines                                                                                                |
| 12  | Where does the schema say vehicle validation belongs?        | **At ride acceptance.** `rides.vehicle_id` is **NOT NULL**; `RideDispatch.vehicleId` is **nullable**; `DriverOnlineStatus` has **no vehicle column**. An offer may exist without a vehicle, a ride may not, and availability is modelled independently |

### 2.4 Six UUID columns with no foreign key

`Driver.currentVehicleId` · `Driver.approvedBy` · `DriverDocument.verifiedBy` · `DriverBankAccount.verifiedBy` · `DriverOnlineStatus.currentShiftId` · `DriverLocation.rideId`.

**Also:** `driver_location_history` appears in **no migration**, despite `driver.prisma:221` claiming it is RANGE-partitioned and managed via raw SQL. **No location history is retained.** `AuditLog` does not exist — `audit.prisma` is a single comment line.

---

## 3. Auth + OTP + User Workflow

`CODEBASE VERIFIED` — **PRODUCTION IMPLEMENTED and fully reusable.**

```
POST /api/v1/auth/otp/send  → OtpService.send
   Redis challenge claim (cooldown + per-phone window) + per-device/per-IP axes
   → hashed OTP in Redis → audit row → BullMQ auth-otp → OtpDeliveryJob → MSG91

POST /api/v1/auth/otp/verify → AuthService.verifyOtp  [Idempotency-Key → runOnce]
   ONE TRANSACTION: otpService.verify (challenge binding) → resolveAccount
   (find-or-create, P2002 re-read) → ensureDefaultRole('customer') →
   assertAuthenticatable → userProfile.ensureExists → deviceService.register
   (fcmToken lands here) → roleRepository.findActiveRoleSlugs →
   sessionService.createInTransaction → tokenService.issuePair({userId, sid, roles})
   → 4 events published
   after commit: sessionService.enforceCap
```

| #   | Question                                              | Answer                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does Driver need separate authentication?             | **NO**                                                                                                                                                                                                                                                                       |
| 2   | Is the existing OTP flow sufficient?                  | **YES** — single `AUTH_OTP_PURPOSE = 'LOGIN'`, no driver branch anywhere                                                                                                                                                                                                     |
| 3   | How does a user become a driver?                      | `POST /api/v1/drivers/me/onboard` — explicit, `P2002`-safe                                                                                                                                                                                                                   |
| 4   | Does driver onboarding affect customer functionality? | **NO** — the Customer flow imports nothing from `drivers/`                                                                                                                                                                                                                   |
| 5   | How is the DRIVER role assigned?                      | **It is not**                                                                                                                                                                                                                                                                |
| 6   | Is `grantRole` called in production?                  | **NO** — 1 ref in `src/` = its definition                                                                                                                                                                                                                                    |
| 7   | Can a revoked role silently return?                   | **YES, for the default role.** `ensureDefaultRole` runs on **every** login and re-grants when no live assignment exists. Revoking `customer` is not durable                                                                                                                  |
| 8   | Are default roles safe?                               | ⚠️ `DEFAULT_ROLE_SLUG = process.env.DEFAULT_USER_ROLE ?? 'customer'`                                                                                                                                                                                                         |
| 9   | Can `DEFAULT_USER_ROLE` escalate privilege?           | **YES.** It is **not in `EnvironmentSchema`** — unvalidated at boot. `DEFAULT_USER_ROLE=admin` grants admin to every account at login. Only mitigation: `ensureDefaultRole` throws on an unseeded slug, so a typo fails loudly but a valid privileged slug succeeds silently |
| 10  | Does Auth depend on Drivers?                          | **NO import edge.** `DriverAccessRepository` imports only `@core/database`; the coupling is schema-level. **A `drivers → auth` import would not cycle**                                                                                                                      |

**Roles are un-injectable by construction:** no `role`/`roles`/`userType`/`appType` field exists in `sendOtpSchema`, `verifyOtpSchema`, `deviceSchema`, or `refreshSchema`, and Zod strips unknown keys.

---

## 4. Driver Module Ownership Audit

`CODEBASE VERIFIED` — 54 files, 19 directories, **none empty**.

| Responsibility                  | Location                                                                         | Class                              | Connected?          |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- | ------------------- |
| Onboarding                      | `services/onboarding/` (2 of 4 methods)                                          | **A** `KEEP_IN_DRIVERS`            | ✅                  |
| Profile                         | same + `driver.repository.ts`                                                    | **A**                              | ✅                  |
| Documents (submit)              | `submitDocument` **inside onboarding service** + `driver-document.repository.ts` | **B** `DRIVER_SUBMODULE`           | ✅                  |
| Document verification           | **NOWHERE**                                                                      | **—** missing                      | ❌                  |
| Driver verification/approval    | `reviewDriverVerification` **inside onboarding service**                         | **B** `DRIVER_SUBMODULE`           | ✅                  |
| Status (online/offline/suspend) | `services/status/`                                                               | **A**                              | ✅ (suspend broken) |
| Eligibility                     | inside `StatusService.setOnline`                                                 | **C** `CROSS_MODULE_ORCHESTRATION` | ✅                  |
| Shifts                          | `driver-shift.repository.ts`; `ShiftService`                                     | **A** / **E** `DEAD_CODE`          | ✅ / ❌             |
| Location                        | `services/location/`                                                             | **A**                              | ✅                  |
| Geo integration                 | `LocationService` → `geoService`                                                 | **C**                              | ✅                  |
| Wallet read model               | `services/wallet/`                                                               | **A**                              | ✅ (no data)        |
| Events                          | `events/catalog.ts` — 8 types, 4 unpublished                                     | **A**                              | ⚠️                  |
| Jobs                            | `heartbeat-timeout` ✅, `doc-expiration` (inert)                                 | **A**                              | ✅                  |
| Bank accounts                   | `driver-bank.repository.ts`                                                      | **G** `DECISION_REQUIRED`          | ❌                  |

**`SHOULD_BELONG_TO_ANOTHER_MODULE`: zero files.** `CODEBASE VERIFIED`

**`DEAD_CODE`:** `plugins/driver.plugin.ts`, `schemas/driver.responses.ts`, `services/shift/shift.service.ts`, `DriverWalletRepository.lockForUpdate`, `InvalidDriverStatusTransitionError`, `DocumentValidationError`, `DriverMetrics.heartbeatTimeout`, `DriverVerificationStatus.SUSPENDED`, `driverConfig.requireApprovedDocuments`, `driverConfig.maxContinuousShiftHours`, 4 unpublished events.

**`DUPLICATE`:** `actingDriverId` re-implemented privately in `rides/controllers/ride-state.controller.ts`; two write paths to `users.email`.

---

## 5. Driver Onboarding Workflow

`CODEBASE VERIFIED`

| Check                                        | Result                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Is `GET /drivers/me` read-only?              | ✅ **YES** — pure `findByUserId`. **Fixed today** (`b7f7da7`); the prior HEAD called `createOrGetDriver`                    |
| Is creation explicit?                        | ✅ `POST /drivers/me/onboard`                                                                                               |
| Idempotent?                                  | ✅ Read-then-create; returns the existing row                                                                               |
| Concurrency-safe?                            | ✅ `P2002` caught, winner re-read; `drivers_user_id_key` is the backstop                                                    |
| Can a Customer accidentally create a Driver? | ✅ **No longer.** No role gate on `/me/onboard`, so a customer may _deliberately_ apply — self-service signup, not a defect |
| BOLA/IDOR protected?                         | ✅ `callerId(req)` from JWT `sub`; `:driverId` parsed and **ignored**                                                       |
| Profile hits correct records?                | ⚠️ `DriverProfile` upsert ✅; `users.email` via **raw `client.user.update`**, bypassing `UserRepository.updateEmail`        |
| Email in shared User model?                  | ✅ `users.email`. `DriverProfile` has **no** email column                                                                   |
| Boundary before documents?                   | ❌ **None** — `submitDocument` never reads the profile                                                                      |
| Can documents precede profile completion?    | ❌ **YES** — all profile fields are `.optional()`; no completeness rule exists                                              |

**On an `onboardingStep` field:** not required. `findByUserId` returns `profile` + `documents` + `onlineStatus` in one read, and `Driver.verificationStatus` is the explicit state. What is missing is a **declared required-document set**, not a new column. `INFERENCE`

---

## 6. Files → Driver Document Integration

`CODEBASE VERIFIED`

| #   | Question                                        | Answer                                                                                                                                                                                        |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does Files support a `DRIVER_DOCUMENT` purpose? | **YES** — jpeg/png/webp/pdf, 10 MB, 5000×5000 px, `rejectExifLocation: true`, 300 s read TTL, **2920-day ARCHIVE on `DRIVER_RELATIONSHIP_ENDED`**                                             |
| 2   | Does Files validate ownership?                  | **YES** — `decideRead` owner-or-operator; `DRIVER_DOCUMENT` requires the `drivers:verify` scope, held by `admin`, deliberately **not** `support`; operator reads audited                      |
| 3   | Can a driver submit another person's file?      | **The question does not apply** — no file record is referenced at all                                                                                                                         |
| 4   | Can arbitrary URLs be stored?                   | **YES** — `fileUrl: z.string().url()`                                                                                                                                                         |
| 5   | Does Driver bypass Files?                       | **YES, entirely.** `drivers/` does not import `@modules/files`                                                                                                                                |
| 6   | Malware/scan support?                           | **YES in Files** — a scan state machine (migration `20260812150000`) plus magic-byte/size/dimension/checksum verification. **Driver documents get none of it**                                |
| 7   | Private URLs protected?                         | **YES in Files** (300 s TTL presigned reads). N/A for driver documents                                                                                                                        |
| 8   | Correct integration point?                      | Store `fileId` on `DriverDocument`; call the Files ownership+purpose check on submission; call `registerFileReference('DRIVER_DOCUMENT', …)` so `DELETE /files/:id` returns `409 FILE_IN_USE` |

**Five purposes exist:** `PROFILE_IMAGE`, `DRIVER_DOCUMENT`, `VEHICLE_DOCUMENT`, `VEHICLE_IMAGE`, `SOS_EVIDENCE`. Only `PROFILE_IMAGE` has a consumer.

---

## 7. Driver Document Lifecycle

`CODEBASE VERIFIED` — exhaustive search of every writer of `DriverDocument.verificationStatus`.

**Document types (`SCHEMA VERIFIED`):** `DRIVING_LICENSE`, `RC`, `INSURANCE`, `AADHAAR`, `PAN`, `PUC`, `POLICE_VERIFICATION`, `PROFILE_PHOTO`. **No mandatory subset is declared anywhere in `src/`.**

| Transition                       | Production writer                                                                 | Status              |
| -------------------------------- | --------------------------------------------------------------------------------- | ------------------- |
| NOT_SUBMITTED → `PENDING`        | `DriverDocumentRepository.upsertDocument` (create branch)                         | ✅                  |
| `PENDING` → **`VERIFIED`**       | **NONE**                                                                          | ❌ **DISCONNECTED** |
| `PENDING` → `REJECTED` (review)  | **NONE**                                                                          | ❌                  |
| `VERIFIED` → `REJECTED` (expiry) | `DocExpirationJob:23` — **the only caller of `updateVerificationStatus`**         | ✅ but inert        |
| RESUBMITTED → `PENDING`          | `upsertDocument` (update branch)                                                  | ✅                  |
| → `EXPIRED`                      | **Status does not exist** — `VerificationStatus` is `PENDING\|VERIFIED\|REJECTED` | ❌                  |

| Field                                              | Written in production?                                |
| -------------------------------------------------- | ----------------------------------------------------- |
| `verifiedBy`                                       | **NEVER** — the sole caller passes `undefined`        |
| `verifiedAt`                                       | **NEVER** — only on the unreachable `VERIFIED` branch |
| `rejectionReason`                                  | Only by the expiry job, always `'Document expired'`   |
| `verificationNotes`, `ocrData`, `documentChecksum` | **NEVER**                                             |

**Answers:** an admin **cannot** mark a document `VERIFIED`; **cannot** reject with a reason; a driver **can** resubmit (status resets to `PENDING` ✅, but `verifiedBy`/`verifiedAt`/`rejectionReason` **survive untouched** ⚠️); expiry is correctly wired and **has no verified documents to process**.

> **`DriverDocumentRepository.updateVerificationStatus` is DISCONNECTED, not implemented.** It supports `VERIFIED` with `verifiedBy`/`verifiedAt` and has exactly one caller that never passes it.

**Two further defects:** a `REJECTED` driver who re-uploads stays `REJECTED` — `submitDocument` promotes only from exactly `PENDING`, so the resubmission never re-enters the queue. And the upsert is `findFirst`-then-`create` with no unique index (§2.2).

---

## 8. Admin Driver Review Workflow

`CODEBASE VERIFIED` — `src/modules/admin/` and `src/modules/support/` are `export {};`. No `/api/v1/admin` prefix registered.

| #     | Can Admin…                                       | Answer                                                                 |
| ----- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| 1     | See pending drivers                              | ❌ **No list/queue endpoint anywhere**                                 |
| 2     | See a driver profile                             | ⚠️ Only via `GET /drivers/me` as that driver — no admin read           |
| 3     | See all documents                                | ⚠️ Only embedded in the driver row; no document endpoint               |
| 4–7   | Review / verify / reject a document, with reason | ❌ **No route, no service**                                            |
| 8–9   | Approve / reject a driver                        | ✅ `POST /api/v1/drivers/:id/verify` `roles:['admin']`                 |
| 10–11 | Suspend / unsuspend                              | ⚠️ `POST /:id/suspend` exists — **suspend deadlocks**; unsuspend works |

**Are driver approval and document approval conflated?** **No — correctly separate.** Two enums, two tables, two state machines. `SCHEMA VERIFIED`

**Does driver approval check required documents?** **NO.** `reviewDriverVerification` never queries `driver_documents`. A driver with zero, `PENDING`, or `REJECTED` documents can be set `VERIFIED`. The config flag for exactly this gate — `driverConfig.requireApprovedDocuments`, **default `true`** — has **zero consumers**.

---

## 9. Driver Role Assignment

`CODEBASE VERIFIED`

```
$ grep -rn "grantRole" src --exclude-dir=generated
src/modules/auth/services/auth.service.ts:256:  async grantRole(     ← definition only
```

| Classification        | Count                |
| --------------------- | -------------------- |
| Definition            | 1                    |
| **Production caller** | **0**                |
| Test caller           | 28 (all in `tests/`) |
| Event subscriber      | 0                    |

**`grantRole` itself is complete and correct:** resolves the slug (throws if unseeded), checks for an existing active assignment in a transaction and returns `false` if present, inserts, publishes `account.role.granted` to the outbox in the same transaction, and **bumps the epoch after commit**. Idempotent twice over — service-level plus the `uq_user_role_active` partial unique index.

**Token propagation, verified not assumed:** `grantRole` → `epochService.bump` → `authPlugin` compares `claims.epoch` to the live epoch on every request → `401 TOKEN_STALE` → client calls `/auth/token/refresh` → `resolveActiveRoles` **re-reads the database** → new claims. **Existing tokens do NOT immediately receive the role; a refresh is required.** The machinery is complete and never fires.

**Event architecture available for reuse:** `EventPublisher.publish(input, tx?)` → `event_outbox` (in-transaction) → `OutboxRelay` (claim token, retry/backoff) → `EventBus.emit`. **One subscriber exists platform-wide:** `bootstrapEvents()` registers only `epochInvalidationConsumer`.

**Circular dependency: NONE.** Both mechanisms are safe:

|           | A — in the approval transaction              | B — `driver.verified` subscriber                                |
| --------- | -------------------------------------------- | --------------------------------------------------------------- |
| Cycle     | none                                         | none                                                            |
| Atomicity | strong                                       | eventual window                                                 |
| Precedent | none                                         | **matches `EpochInvalidationConsumer`**                         |
| Failure   | rolls back visibly                           | outbox retry ⇒ at-least-once; `grantRole` idempotent ⇒ harmless |
| Caution   | epoch bump fires **before** the outer commit | app must tolerate the window                                    |

**The architecture does not establish one. This audit does not choose.** `INFERENCE`

---

## 10. Eligibility + Online

`CODEBASE VERIFIED` — `StatusService.setOnline`, one transaction after `lockForUpdate`:

| Requirement                                                    | Present?                               | Satisfiable today?     |
| -------------------------------------------------------------- | -------------------------------------- | ---------------------- |
| Driver exists                                                  | ✅                                     | ✅                     |
| `verificationStatus === 'VERIFIED'`                            | ✅ (guard **and** service)             | ✅ via admin approval  |
| `!isSuspended`                                                 | ✅ (both)                              | ✅                     |
| **`DRIVING_LICENSE` with `verificationStatus === 'VERIFIED'`** | ✅                                     | ❌ **IMPOSSIBLE** — §7 |
| Existing active shift                                          | ✅ `startShift` idempotent             | ✅                     |
| `driver` role                                                  | ❌ **not checked on any driver route** | —                      |
| Vehicle                                                        | ❌ not checked                         | —                      |
| Active-ride conflict                                           | ❌ `findActiveByDriver` 0 callers      | —                      |
| Licence expiry                                                 | ❌ `expiresAt` ignored at go-online    | —                      |

**Config designed for eligibility with zero consumers:** `requireApprovedDocuments` (default `true`) and `maxContinuousShiftHours` (12). Both declared in `src/config/driver/driver.config.ts`, both referenced only by their own interface and initialiser. `CODEBASE VERIFIED`

**Vehicle validation belongs at ACCEPT** — per the schema, not opinion (§2.3 row 12).

---

## 11. Location + Geo Workflow

`CODEBASE VERIFIED`

```
POST /drivers/location  [rateLimit only — NO eligibility guard]
  → reject isMockLocation (rejectMockLocation defaults true)
  → driver exists → assessPlausibility (age ≤120s, speed ≤200km/h, noise ≥50m)
  → driverLocationRepository.updateLocation (raw INSERT … ON CONFLICT; decimal + PostGIS geography)
  → geoService.recordDriverPosition (H3 cell → Redis)
  → driverStatusRepository.updateHeartbeat
```

| Driver state         | Enters geo index?              | Correct? |
| -------------------- | ------------------------------ | -------- |
| `PENDING`            | **YES**                        | ❌       |
| `DOCUMENT_REVIEW`    | **YES**                        | ❌       |
| Suspended            | **YES**                        | ❌       |
| `VERIFIED` + OFFLINE | **YES**                        | ❌       |
| `VERIFIED` + ONLINE  | YES                            | ✅       |
| `BUSY` / `ON_TRIP`   | n/a — **states never written** | —        |

**Callers:** `recordDriverPosition` ✅ `LocationService`; `forgetDriverPosition` ✅ `StatusService.setOffline` (correctly **post-commit**); **`findNearbyDrivers` ❌ 3 refs, all inside geo's own chain.**

**Removal:** explicit `forgetDriverPosition`; Redis TTL 300 s; PostGIS freshness bound 120 s. **None is state-aware** — suspension does not remove (its `setOffline` is on the deadlocking path), and `heartbeatAt = null` drivers are never swept.

> **DISCOVERY SYSTEM IS DISCONNECTED.** The geo write path is wired; the read path has no production caller.

---

## 12. Matching + Dispatch Workflow

`CODEBASE VERIFIED` — `matching/` and `dispatch/` are both `export {};`.

```
POST /rides/requests → RideRequest(CREATED) → publish ride.requested → ZERO SUBSCRIBERS → ✗ END
```

| Symbol                                      | Production callers                          |
| ------------------------------------------- | ------------------------------------------- |
| `findNearbyDrivers`                         | 0 outside geo                               |
| `offerToDriver`                             | **0** (1 ref = definition)                  |
| `RideDispatchRepository.createOffer`        | 0 (only via unreachable `offerToDriver`)    |
| `findByRequestAndDriver` / `updateResponse` | **0**                                       |
| `findActiveByDriver`                        | **0**                                       |
| `claimForMatch`                             | ✅ 1 — `LifecycleService.acceptRideRequest` |

**Answers:** a ride request does **not** trigger matching · matching does **not** call Geo · **no offers are created** · none delivered · `DispatchTimeoutJob` runs on a **permanently empty table** and **does not re-offer** (timeout is terminal) · **dispatch is primitives with no orchestrator**.

---

## 13. Notifications + FCM

`CODEBASE VERIFIED`

`NotificationService` has exactly two methods: `sendSms(to, body, options?)` and `sendOtp(to, code)`, behind an `SmsProvider` interface (MSG91 + mock). Callers: `OtpService.notifyLocked`, `OtpDeliveryJob.run`.

**`fcmToken` references, complete:** `auth.controller.ts:22` (write), `device.repository.ts:11,54,76` (write/clear), `auth.responses.ts:62` + `auth.schemas.ts:15` (schema), `auth.service.ts:53` + `auth.types.ts:8` (types). **Zero reads for delivery.**

| #   | Question                           | Answer                                                                                                                                                                                                                                          |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Only stored?                       | **YES**                                                                                                                                                                                                                                         |
| 2   | Any production push sent?          | **NO** — no push method exists                                                                                                                                                                                                                  |
| 3   | Can a driver receive a ride offer? | **NO**                                                                                                                                                                                                                                          |
| 4   | Abstraction ready to extend?       | **Partially** — the `SmsProvider` interface + `NotificationService` shape is a reasonable seam, but there is **no FCM SDK, no APNs, no Firebase dependency, no WebSocket** (`plugins/socket/socket.plugin.ts` is `export {};` and unregistered) |

**This is a hard blocker for dispatch** — an offer with no delivery channel cannot reach a driver, which is plausibly _why_ dispatch was never wired. `INFERENCE`

---

## 14. Vehicle Workflow

`CODEBASE VERIFIED` / `SCHEMA VERIFIED` — `src/modules/vehicles/index.ts` is `export {};`.

| Step                      | Schema                                                  | Code               |
| ------------------------- | ------------------------------------------------------- | ------------------ |
| Registration              | ✅ `Vehicle` (`registration_number`, `vin` unique)      | ❌                 |
| Owner/driver relationship | ✅ `currentDriverId` + `VehicleAssignment`              | ❌ zero references |
| Vehicle documents         | ✅ `VehicleDocument` (`documentType String`, free text) | ❌                 |
| Admin verification        | ⚠️ per-document only; no vehicle-level column           | ❌                 |
| Assignment                | ✅ `VehicleAssignment`                                  | ❌                 |
| Availability for ride     | ✅ `VehicleType` read by fare quoting                   | ⚠️ read-only       |
| Validation at acceptance  | ❌                                                      | ❌                 |

**`vehicleId` on Ride is required (`NOT NULL`); on `RideDispatch` it is nullable.** At acceptance, the client-supplied `vehicleId` is validated for **nothing** — not existence (arbitrary UUID ⇒ FK violation ⇒ **500**), not assignment (**a driver can accept in another driver's vehicle**), not `isActive`, not `vehicle.vehicleTypeId === request.vehicleTypeId` (**accept a premium request in a hatchback, be paid the premium quote**), not document validity.

---

## 15. Ride Authorization + Driver State

`CODEBASE VERIFIED`

| State         | Writers                                             | Status                                                    |
| ------------- | --------------------------------------------------- | --------------------------------------------------------- |
| `ONLINE`      | `StatusService.setOnline`                           | ✅ (unreachable)                                          |
| `OFFLINE`     | `setOffline`, `HeartbeatTimeoutJob`, `setSuspended` | ✅                                                        |
| **`BUSY`**    | **NONE**                                            | ❌ enum only                                              |
| **`ON_TRIP`** | **NONE**                                            | ❌ enum only — read once, in `setOffline`'s refusal guard |
| `BREAK`       | **NONE**                                            | ❌ read only by `findStaleDrivers`                        |
| `isAvailable` | `updateAvailability`, `setSuspended`                | ✅                                                        |

**Consistency:** Geo does **not** consult any of these (`findNearbyDrivers` queries `driver_locations` alone). Matching does not exist. The ride lifecycle never writes them. **The states are not consistently used by anything.**

**Concurrent ride protection — both levels:**

| Level               | Present?                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Application/service | ❌ `findActiveByDriver` has 0 callers, while the customer-side `findActiveByCustomer` **is** called by `createRequest` |
| **Database**        | ❌ **No unique index on `rides(driver_id)` for active statuses** — only plain `rides_driver_id_idx` (§2.2)             |

**A driver can accept two rides from two different requests.** `rides_request_id_key` does not help (different `request_id`s); `claimForMatch` does not help (scoped to one request).

**Well built and worth preserving:** `ALLOWED_TRANSITIONS`, `lockAndValidate` (row lock + ownership + transition check), `updateStatusIf` compare-and-set, start-OTP verification.

---

## 16. Ride → Payment → Driver Earnings

`CODEBASE VERIFIED` — **the strongest positive finding.**

`LifecycleService.completeRide` (`lifecycle.service.ts:284`) calls `ledgerService.recordTripPayment(...)` **inside the same transaction** as the status write and fare record:

| Payment method | Ledger entries                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| **CASH**       | `DRIVER_PAYABLE` **DEBIT** commission + `PLATFORM_COMMISSION` **CREDIT** — driver _owes_ the platform      |
| **Prepaid**    | `CUSTOMER_WALLET` **DEBIT** fare + `DRIVER_PAYABLE` **CREDIT** earnings + `PLATFORM_COMMISSION` **CREDIT** |

`postTransactionGroup` rejects non-positive amounts. Double-entry is sound.

**Where the lifecycle disconnects — exactly two links:**

| Link                        | Status         | Evidence                                                                                                                                     |
| --------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Ride completed → ledger     | ✅ **WORKS**   | `recordTripPayment` in-transaction                                                                                                           |
| Ledger → `DriverSettlement` | ❌             | **`SettlementJob` absent from `JOB_SCHEDULES` and `MAINTENANCE_HANDLERS`** — it never runs. `calculateSettlement` is called only by that job |
| Settlement → `DriverWallet` | ❌             | **`DriverWallet` is only ever created** — the sole write in the codebase is `driverWallet.create` inside `getOrCreateWallet`                 |
| Driver reads wallet         | ✅ route works | Returns **zero balance, forever**                                                                                                            |

> **The ledger is correct and is the source of truth. The wallet the driver sees is never projected from it.** This is a presentation gap, not data loss.

---

## 17. Jobs and Background Processing

`CODEBASE VERIFIED` — **exact DI string tokens**, because `runMaintenanceJob` resolves by string and a rename fails **at cron time, not compile time**.

| Job                      | Impl | DI token              | In `JOB_SCHEDULES` | In `MAINTENANCE_HANDLERS` | Schedule       | Effective         |
| ------------------------ | ---- | --------------------- | ------------------ | ------------------------- | -------------- | ----------------- |
| File sweep               | ✅   | `fileSweeperJob`      | ✅                 | ✅                        | `*/15 * * * *` | ✅                |
| File retention           | ✅   | `fileRetentionJob`    | ✅                 | ✅                        | `0 3 * * *`    | ✅                |
| Account erasure          | ✅   | `accountErasureJob`   | ✅                 | ✅                        | config         | ✅                |
| Auth retention           | ✅   | `authRetentionJob`    | ✅                 | ✅                        | `30 4 * * *`   | ✅                |
| Dispatch timeout         | ✅   | `dispatchTimeoutJob`  | ✅                 | ✅                        | `* * * * *`    | ❌ empty table    |
| Request expiry           | ✅   | `requestExpiryJob`    | ✅                 | ✅                        | `* * * * *`    | ✅                |
| Driver heartbeat timeout | ✅   | `heartbeatTimeoutJob` | ✅                 | ✅                        | `* * * * *`    | ✅                |
| Driver doc expiration    | ✅   | `docExpirationJob`    | ✅                 | ✅                        | `0 2 * * *`    | ❌ **inert**      |
| Payment reconciliation   | ✅   | `reconciliationJob`   | ✅                 | ✅                        | `15 * * * *`   | ✅                |
| **Settlement**           | ✅   | **`settlementJob`**   | ❌ **ABSENT**      | ❌ **ABSENT**             | —              | ❌ **never runs** |
| OTP delivery (queue)     | ✅   | `otpDeliveryJob`      | n/a                | n/a                       | on demand      | ✅                |

**Rename/move risk:** the 9 tokens above are string literals in `src/jobs/workers/index.ts`. Renaming any DI registration without updating that map produces `Error: No handler registered for job "..."` **only when the cron fires**.

---

## 18. Cross-Module Import Graph

`CODEBASE VERIFIED`

**Outbound from `drivers/`:** `@core/database` ×11 · `@core/database/TransactionManager` ×7 · `@shared/logger` ×4 · **`@modules/geo` ×4 — the only domain-module dependency** · `@config` ×4 · `@core/auth` ×3 · `@core/events` ×2 · `@core/cache/RedisService` ×2 · `@core/{metrics,errors,di}` ×3.

**Inbound to `drivers/`:** `core/di.ts` (barrel ✅) · `routes/register.ts` (barrel ✅) · **`rides/controllers/ride-state.controller.ts` (2 deep imports ⚠️)** · 4 test files (deep).

| Pair                                 | Exists?                           | Classification                                       |
| ------------------------------------ | --------------------------------- | ---------------------------------------------------- |
| Drivers → Auth                       | **NO**                            | ⚠️ _missing edge_ — why `grantRole` is uncalled      |
| Auth → Drivers                       | **NO import** (schema-level only) | allowed                                              |
| Drivers → Files                      | **NO**                            | ⚠️ _missing edge_ — why `fileUrl` is unvalidated     |
| Files → Drivers                      | NO                                | allowed                                              |
| Drivers → Users                      | **NO**                            | ⚠️ _missing edge_ — why the raw `user.update` exists |
| Users → Drivers                      | NO                                | allowed                                              |
| Drivers ↔ Payments                   | NO                                | allowed                                              |
| **Drivers → Geo**                    | **YES ×4, public barrel**         | **allowed**                                          |
| Drivers → Matching/Dispatch/Vehicles | NO                                | allowed (stubs)                                      |
| Drivers → Rides                      | **NO**                            | **correct — would cycle**                            |
| **Rides → Drivers**                  | **YES — 1 file, deep**            | **questionable** — internal leak                     |

**Also:** `rides` deep-imports `@modules/payments/services/ledger/ledger.service.js`.

> **Actual cycles: ZERO.** Two edges must never be added: `drivers → rides`, and `geo → drivers` (pass a predicate _into_ Geo instead).

---

## 19. Zero-Caller and Dead-Code Analysis

`CODEBASE VERIFIED` — `src/` searched, `src/generated/**` excluded.

| Symbol                                                           | Module   | Definition | Production caller                     | Test caller | Status                  |
| ---------------------------------------------------------------- | -------- | ---------- | ------------------------------------- | ----------- | ----------------------- |
| `AuthService.grantRole`                                          | auth     | ✅         | ❌ **0**                              | ✅ 28       | **DISCONNECTED**        |
| `AuthService.revokeRole`                                         | auth     | ✅         | ❌ 0                                  | ✅          | **DISCONNECTED**        |
| `DriverDocumentRepository.updateVerificationStatus`              | drivers  | ✅         | ⚠️ 1 (`REJECTED` only)                | ❌          | **PARTIALLY_CONNECTED** |
| `GeoService.findNearbyDrivers`                                   | geo      | ✅         | ❌ 0 outside geo                      | ✅ 23       | **DISCONNECTED**        |
| `DispatchService.offerToDriver`                                  | rides    | ✅         | ❌ **0**                              | ❌          | **DISCONNECTED**        |
| `RideDispatchRepository.findByRequestAndDriver`                  | rides    | ✅         | ❌ 0                                  | ❌          | **DISCONNECTED**        |
| `RideDispatchRepository.updateResponse`                          | rides    | ✅         | ❌ 0                                  | ❌          | **DISCONNECTED**        |
| `RideRepository.findActiveByDriver`                              | rides    | ✅         | ❌ **0**                              | ❌          | **DISCONNECTED**        |
| `SettlementService.calculateSettlement`                          | payments | ✅         | ⚠️ only `SettlementJob` (unscheduled) | ✅          | **DISCONNECTED**        |
| `SettlementJob`                                                  | payments | ✅         | ❌ not scheduled                      | ✅          | **DISCONNECTED**        |
| `driverConfig.requireApprovedDocuments`                          | config   | ✅         | ❌ **0**                              | ❌          | **DEAD**                |
| `driverConfig.maxContinuousShiftHours`                           | config   | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `UserDevice.fcmToken` (read for delivery)                        | auth     | ✅ stored  | ❌ **0 reads**                        | ❌          | **DISCONNECTED**        |
| `BUSY` / `ON_TRIP` writers                                       | drivers  | enum only  | ❌ **0**                              | ❌          | **STUB**                |
| `PermissionRepository.findAllowedCodesForUser`                   | auth     | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `ShiftService.getActiveShift`                                    | drivers  | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `DriverBankRepository` (class)                                   | drivers  | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `DriverWalletRepository.lockForUpdate`                           | drivers  | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `driverExtension.findActiveDrivers`                              | core     | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `DriverMetrics.heartbeatTimeout`                                 | drivers  | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `GeoService.liveDriverPosition` / `calculateExactDistanceMeters` | geo      | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `driverPlugin` + 4 sibling plugins                               | various  | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `schemas/driver.responses.ts`                                    | drivers  | ✅         | ❌ 0                                  | ❌          | **DEAD**                |
| `claimForMatch`                                                  | rides    | ✅         | ✅ 1                                  | ✅          | **CONNECTED**           |
| `recordTripPayment`                                              | payments | ✅         | ✅ 1                                  | ✅          | **CONNECTED**           |
| `recordDriverPosition` / `forgetDriverPosition`                  | geo      | ✅         | ✅                                    | ✅          | **CONNECTED**           |

---

## 20. Complete End-to-End Truth Table

| #   | Workflow step             | Module owner  |  Code exists  | Prod caller | Actually works |  Tests  | Blocker                   |
| --- | ------------------------- | ------------- | :-----------: | :---------: | :------------: | :-----: | ------------------------- |
| 1   | Phone login               | auth          |      ✅       |     ✅      |       ✅       | ✅ E2E  | —                         |
| 2   | OTP                       | auth          |      ✅       |     ✅      |       ✅       | ✅ E2E  | —                         |
| 3   | User                      | auth/users    |      ✅       |     ✅      |       ✅       | ✅ E2E  | —                         |
| 4   | Driver onboarding         | drivers       |      ✅       |     ✅      |       ✅       |   ❌    | —                         |
| 5   | Driver profile            | drivers       |      ✅       |     ✅      |       ⚠️       |   ❌    | raw `users.email` write   |
| 6   | Files upload              | files         |      ✅       | ✅ (users)  |       ✅       |   ✅    | **not used by drivers**   |
| 7   | Document submission       | drivers       |      ✅       |     ✅      |       ⚠️       |   ❌    | arbitrary `fileUrl`       |
| 8   | **Document verification** | drivers       | ⚠️ repo only  |     ❌      |       ❌       | fixture | **P0-1 no writer**        |
| 9   | Driver approval           | drivers       |      ✅       |     ✅      |       ⚠️       |   ❌    | no document gate          |
| 10  | **DRIVER role**           | auth          |      ✅       |     ❌      |       ❌       | fixture | **P0-2 no caller**        |
| 11  | Eligibility               | drivers       |      ✅       |     ✅      |       ❌       |  mock   | blocked by #8             |
| 12  | Online                    | drivers       |      ✅       |     ✅      |       ❌       |   ❌    | blocked by #8             |
| 13  | Location                  | drivers       |      ✅       |     ✅      |       ⚠️       |  unit   | no eligibility gate       |
| 14  | Geo indexing              | geo           |      ✅       |     ✅      |       ✅       |   ✅    | —                         |
| 15  | **Nearby discovery**      | geo           |      ✅       |     ❌      |       ❌       | ✅ svc  | **P0-8 no caller**        |
| 16  | **Matching**              | matching      |      ❌       |     ❌      |       ❌       |   ❌    | **stub**                  |
| 17  | **Dispatch**              | dispatch      | ⚠️ primitives |     ❌      |       ❌       |   ❌    | **no orchestrator**       |
| 18  | Offer                     | rides         |      ✅       |     ❌      |       ❌       |   ❌    | `offerToDriver` 0 callers |
| 19  | **Push notification**     | notifications |      ❌       |     ❌      |       ❌       |   ❌    | **not built**             |
| 20  | Accept                    | rides         |      ✅       |     ✅      |       ⚠️       | ✅ unit | no offer validation       |
| 21  | **Vehicle validation**    | vehicles      |      ❌       |     ❌      |       ❌       |   ❌    | **stub**                  |
| 22  | **BUSY**                  | drivers       |     enum      |     ❌      |       ❌       |   ❌    | **no writer**             |
| 23  | Ride start                | rides         |      ✅       |     ✅      |       ✅       | ✅ unit | —                         |
| 24  | **ON_TRIP**               | drivers       |     enum      |     ❌      |       ❌       |   ❌    | **no writer**             |
| 25  | Ride complete             | rides         |      ✅       |     ✅      |       ✅       | ✅ unit | —                         |
| 26  | **Ledger**                | payments      |      ✅       |     ✅      |       ✅       |   ✅    | —                         |
| 27  | Driver payable            | payments      |      ✅       |     ✅      |       ✅       |   ✅    | —                         |
| 28  | **Settlement**            | payments      |      ✅       |     ❌      |       ❌       | ✅ svc  | **P0-9 unscheduled**      |
| 29  | **Wallet update**         | payments      |      ❌       |     ❌      |       ❌       |   ❌    | **P0-10 never written**   |
| 30  | Available again           | drivers       |      ❌       |     ❌      |       ❌       |   ❌    | nothing to restore        |

**Tally:** fully working **10** · partial/unsafe **6** · disconnected **7** · missing **7**

---

## 21. Module Ownership Recommendation

**Zero files should move to another top-level module.** `CODEBASE VERIFIED`

| Group                        | Placement                                                                                                                                | Verdict                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **A. Driver domain**         | onboarding, profile, documents, verification, status, shifts, location, eligibility, wallet read model, events, jobs — all in `drivers/` | ✅ **CORRECT — keep**                                                                  |
| **B. Shared identity**       | OTP, JWT, sessions, roles, epoch in `auth/`; `User` + `users.email` in `users/`                                                          | ✅ **CORRECT — keep**                                                                  |
| **C. File storage/access**   | `files/` incl. `DRIVER_DOCUMENT` purpose                                                                                                 | ✅ **CORRECT — keep**                                                                  |
| **D. Spatial**               | `geo/` incl. `nearby-driver.service.ts` (named "driver", but a spatial query)                                                            | ✅ **CORRECT — keep**                                                                  |
| **E. Matching/dispatch**     | primitives in `rides/`; `matching/` + `dispatch/` are stubs                                                                              | ⚠️ orchestrator belongs in `dispatch/` when built                                      |
| **F. Vehicle lifecycle**     | `vehicles/` — schema only                                                                                                                | ⚠️ **build there, not in Drivers**                                                     |
| **G. Ride lifecycle**        | `rides/`                                                                                                                                 | ✅ **CORRECT — keep**                                                                  |
| **H. Payment/settlement**    | `payments/`                                                                                                                              | ✅ **CORRECT — keep**                                                                  |
| **I. Notification delivery** | `notifications/`                                                                                                                         | ⚠️ **build there**                                                                     |
| **J. Admin review**          | 2 routes in `drivers/`                                                                                                                   | ⚠️ **business rules stay in Drivers**; Admin adds queue/list and calls Driver services |

**Three genuine placement problems — none requiring a cross-module move:**

| Current                                                                     | Correct                          | Why                                                                                       | Deps affected                       | Cycle risk | Risk   |
| --------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- | ---------- | ------ |
| `submitDocument` in `services/onboarding/onboarding.service.ts`             | `drivers/documents/services/`    | Document concern inside the onboarding service; it is also where the missing review lands | +1 DI reg, `driverService.inject()` | none       | MEDIUM |
| `reviewDriverVerification` in the same file                                 | `drivers/verification/services/` | Approval state machine, not onboarding; will host the `grantRole` hook                    | +1 DI reg                           | none       | MEDIUM |
| `actingDriverId` duplicated in `rides/controllers/ride-state.controller.ts` | import from `drivers`            | Two copies of an authorization mapping can drift                                          | 1 import                            | none       | LOW    |

**Do not move for cosmetics.** The full vertical split (~35 files) is optional and lower value.

---

## 22. Production Blockers

### P0 — blocks the workflow, security, or data integrity

| ID        | Blocker                                                     | Workflow | Evidence                                                                               | Reuse                                | Stage |
| --------- | ----------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- | ------------------------------------ | ----- |
| **P0-1**  | No writer of `DriverDocument.verificationStatus = VERIFIED` | #8       | Only `upsertDocument` (`PENDING`) + `DocExpirationJob` (`REJECTED`)                    | ✅ repo method exists                | 1     |
| **P0-2**  | `grantRole` has zero production callers                     | #10      | 1 ref = definition; `driver.verified` has no subscriber                                | ✅ complete + idempotent             | 1     |
| **P0-3**  | Driver approvable with zero/`PENDING`/`REJECTED` documents  | #9       | `reviewDriverVerification` never queries documents                                     | ✅ `requireApprovedDocuments` exists | 1     |
| **P0-4**  | Documents accept arbitrary client URLs                      | #7       | `fileUrl: z.string().url()`; drivers never imports files                               | ✅ Files complete                    | 3     |
| **P0-5**  | `POST /drivers/:id/suspend` self-deadlocks                  | —        | `setSuspended` holds `FOR UPDATE`, calls `setOffline` which opens a second transaction | —                                    | 4     |
| **P0-6**  | One driver, unlimited concurrent rides                      | #20      | No service check **and no unique index on `rides(driver_id)`**                         | ✅ `findActiveByDriver` exists       | 5     |
| **P0-7**  | `vehicleId` unvalidated at acceptance                       | #21      | Passed straight to `rideRepo.create`                                                   | —                                    | 5/6   |
| **P0-8**  | Dispatch has no orchestrator                                | #15–18   | `ride.requested` zero subscribers; `offerToDriver` zero callers                        | ✅ primitives exist                  | 8     |
| **P0-9**  | **`SettlementJob` never scheduled**                         | #28      | Absent from `JOB_SCHEDULES` **and** `MAINTENANCE_HANDLERS`                             | ✅ job + service exist               | **2** |
| **P0-10** | **`DriverWallet` never updated**                            | #29      | Sole write is `driverWallet.create`                                                    | ✅ ledger is correct                 | 2     |

### P1 — high production risk

`GET /rides/active` + `/history` serve customer data to drivers (fixed by P0-2) · unverified/suspended/offline drivers enter the geo index · `findNearbyDrivers` has no driver-state filter · licence expiry unchecked at go-online · racy document upsert (no unique index) · stale `verifiedBy`/`verifiedAt` survive re-upload · `REJECTED` driver cannot re-enter review · driver email via raw Prisma (500 not 409) · `POST /:id/suspend` body unvalidated · no admin review queue · **no push channel** · **revoked default role silently re-granted on next login** · `DEFAULT_USER_ROLE` unvalidated at boot · `heartbeatAt = null` drivers never swept · `BUSY`/`ON_TRIP` never written · driver aggregates + shift stats never written · `cancel` has no operability guard · no Fastify schemas on driver routes · no location history.

### P2 — maintainability / architecture

`format:check` fails on 34 non-`src/` files (**blocks CI**) · `submitDocument` + `reviewDriverVerification` inside the onboarding service · 13 routes and 5 schemas in single files · `actingDriverId` duplicated in Rides · `rides` deep-imports Drivers and Payments internals · six UUID columns with no FK · no `EXPIRED` document status · three authorization vocabularies · `super_admin` not seeded.

### P3 — cleanup

Dead code set (§19) · 4 unpublished events · `DriverVerificationStatus.SUSPENDED` · stale `drivers/README.md` ("0 errors / 550 tests"; actual 1 error fixed today / 714 tests) · ~20 `export {};` placeholder files.

---

## Final Answers

**1. What modules are fully working end-to-end?**
**Auth** (OTP, JWT, sessions, refresh rotation, epoch), **Users**, **Files**, **Geo** (write path), and the **Payments ledger**. `Rides` works from accept through complete-and-ledger.

**2. What modules are implemented but disconnected?**
**Geo discovery** (`findNearbyDrivers`), **dispatch primitives** (`offerToDriver`, `RideDispatchRepository`), **role management** (`grantRole`/`revokeRole`), **document verification** (`updateVerificationStatus`'s `VERIFIED` path), **`SettlementJob`**, **Files' `DRIVER_DOCUMENT` purpose**, and **FCM token storage**.

**3. What parts of Driver are correctly implemented?**
Onboarding (explicit, idempotent, `P2002`-safe, transactional) · profile capture · document submission mechanics · the `setOnline` gate structure (row lock + four checks) · offline/heartbeat · location with plausibility and mock-GPS rejection · shift start/end idempotency · the wallet read projection · both jobs correctly plumbed · BOLA handling via `actingDriverId`/`authorizedDriverId`.

**4. Where exactly does the real Driver lifecycle stop?**
At **document `PENDING → VERIFIED`** — step 8 of 30. No route, service, job, or subscriber writes `VERIFIED`.

**5. Can a real driver complete Phone → OTP → Documents → Approval → Role → Online?**
**NO.** Phone → OTP → User → Onboard → Profile → Documents all work. Document verification is impossible, the role is never granted, and `setOnline` requires a verified licence.

**6. Can an ONLINE driver enter Geo correctly?**
**Technically yes, but incorrectly scoped** — location ingestion has no eligibility gate, so `PENDING`, `DOCUMENT_REVIEW`, suspended, and offline drivers all enter the index too.

**7. Can a customer request a ride and automatically trigger matching?**
**NO.** `createRequest` publishes `ride.requested` and returns. That event has **zero subscribers**.

**8. Can Geo discover the driver?**
**The capability exists and is never invoked.** `findNearbyDrivers` has 3 references, all inside geo's own delegation chain.

**9. Can the driver receive a real ride offer?**
**NO.** No `RideDispatch` row is ever created, and no delivery channel exists.

**10. Can the driver accept only one active ride?**
**NO** — at **both** levels. No service check (`findActiveByDriver` 0 callers) and **no unique index on `rides(driver_id)`** for active statuses.

**11. Is vehicle validation happening at the correct lifecycle point?**
**It is not happening at all.** The schema says it belongs at **accept** — `rides.vehicle_id` NOT NULL, `RideDispatch.vehicleId` nullable, `DriverOnlineStatus` has no vehicle column.

**12. Does ride completion correctly create driver earnings?**
**YES.** `completeRide` calls `recordTripPayment` in the same transaction, with correct cash/prepaid double-entry postings to `DRIVER_PAYABLE`.

**13. Does settlement actually run?**
**NO.** `SettlementJob` is DI-registered as `settlementJob` and absent from **both** `JOB_SCHEDULES` and `MAINTENANCE_HANDLERS`.

**14. Does DriverWallet actually receive/update earnings?**
**NO.** The only write in the entire codebase is `driverWallet.create`. Balance is **permanently zero**.

**15. Are FCM tokens actually used to send push notifications?**
**NO.** Stored on `UserDevice` during OTP verify and **never read for delivery**. `NotificationService` has only `sendSms` and `sendOtp`.

**16. Which zero-caller functions are critical production gaps?**
`grantRole` · `updateVerificationStatus` (`VERIFIED` path) · `requireApprovedDocuments` · `findNearbyDrivers` · `offerToDriver` · `findActiveByDriver` · `SettlementJob` · `fcmToken` reads. Eight symbols; each unblocks a specific workflow step.

**17. Are there circular dependency risks in the current module design?**
**No actual cycles today.** `drivers → geo` and `rides → drivers` are both one-directional. **A `drivers → auth` import would NOT cycle** — `auth` reads the `drivers` _table_, not the module. Two edges must never be added: `drivers → rides` and `geo → drivers`.

**18. Which code belongs in Drivers and which belongs elsewhere?**
Everything currently in `drivers/` belongs there. Auth owns identity/roles; Users owns `users.email`; Files owns bytes; Geo owns spatial queries; Payments owns money; Vehicles owns vehicles; Rides owns the ride aggregate; Dispatch owns orchestration; Notifications owns delivery.

**19. What code placement/refactoring should happen before new features?**
**Only two, and both are internal to Drivers:** extract `documents/` and `verification/` as Driver submodules. Doing this _before_ writing document review means writing that feature once, in the right place, instead of moving it twice. Everything else is cosmetic and can wait.

**20. What exact workflow must be fixed first?**
**Document review** — `PENDING → VERIFIED`. It is step 8 of 30, and steps 9–30 are all downstream of it.

**21. What should be Stage 0?**
Resolve `format:check` (34 files, all outside `src/`) so CI's `quality` job can pass — it runs **first**, before lint and typecheck. Then add HTTP smoke tests for the 13 driver routes, which currently have **zero** coverage.

**22. What should be Stage 1?**
P0-1 → P0-3 → P0-2: document review service + admin route; document-completeness gate via the existing `requireApprovedDocuments` flag; `grantRole` on approval. **The smallest change set that lets a real driver go ONLINE**, and it fixes the `/rides/active` bug for free. Decide the role mechanism (§9) before starting.
**Run P0-9 alongside it** — scheduling `SettlementJob` is two lines and independently valuable.

**23. What should NOT be rebuilt because it already exists?**
OTP · Auth (sessions, tokens, refresh rotation, epoch) · `grantRole`/`revokeRole` · `User` identity and `users.email` · the entire Files module including `DRIVER_DOCUMENT` · the Geo stack · outbox/relay/EventBus · job scheduler + `LockStore` · `TransactionManager` and `lockForUpdate` · the Rides state machine · **the Payments ledger and `recordTripPayment`** · `claimForMatch` + `rides_request_id_key` · backend-controlled roles · `route-graph.test.ts` · `di-wiring.test.ts` · the Prisma schema.

**24. Is the platform ready for `/speckit.specify` after this investigation?**
**YES — with one caveat and one decision.** The baseline is healthy (typecheck, lint, build, 714 tests all pass; tree clean and committed), ownership is settled, and gaps are enumerated with evidence.
**Caveat:** `format:check` fails, so CI cannot go green.
**Decision:** the role-assignment mechanism (§9) determines whether a `consumers/` folder exists and what the Driver App must tolerate — the spec cannot leave it open.
Resolve both and specify.

---

COMPLETE PLATFORM WORKFLOW INVESTIGATION FINISHED — NO CODE CHANGED
