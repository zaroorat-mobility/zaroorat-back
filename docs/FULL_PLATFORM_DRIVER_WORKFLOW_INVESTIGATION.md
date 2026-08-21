# Full Platform Workflow & Driver Lifecycle Investigation

**Repository:** `backend_zaroorat` · **Branch:** `feature/auth` · **HEAD:** `269e927`
**Date:** 2026-08-20
**Type:** Read-only audit. No source modified, no file moved/renamed/deleted, no migration, no schema change, no formatter run, no lint/type auto-fix, no test changed, no commit created.

**Evidence labels:** `CODE VERIFIED` · `TEST VERIFIED` · `BUILD VERIFIED` · `SCHEMA VERIFIED` · `INFERENCE`
**Status vocabulary:** `PASS` · `FAIL` · `NOT RUN` · `NOT VERIFIABLE`

---

## 1. Executive Summary

**The platform is much further along than the driver lifecycle suggests.** Auth, OTP, Users, Files, Geo, Rides, and Payments are production-grade and genuinely wired. What is broken is not the modules — it is **five specific connections between them**.

**The single most important new finding in this audit** (not present in earlier reports): **ride completion already posts a correct double-entry ledger transaction.** `LifecycleService.completeRide` calls `ledgerService.recordTripPayment(...)` inside the same transaction as the status write, handling cash and prepaid differently. Driver earnings _are_ recorded. `CODE VERIFIED`

But the money never reaches the driver's wallet:

- `DriverWallet` is only ever **created**, never **updated** — the sole write in the entire codebase is `driverWallet.create` inside `getOrCreateWallet`. `CODE VERIFIED`
- `SettlementJob` is **DI-registered but never scheduled** — it is absent from both `JOB_SCHEDULES` (9 entries) and `MAINTENANCE_HANDLERS` (9 entries). `CODE VERIFIED`

So a driver's earnings sit correctly in `payment_ledger_entries` as `DRIVER_PAYABLE`, and the wallet API the driver reads shows **zero, forever**.

**Repository health improved materially since the last audit.** Three commits landed today: typecheck `PASS`, lint `PASS`, build completes end-to-end, 714/714 unit tests pass, working tree clean. Only `format:check` fails, on 34 files **all outside `src/`**. `BUILD VERIFIED`

**Where the driver lifecycle stops — unchanged and precise:** document `PENDING → VERIFIED`. No route, service, job, or subscriber writes `VERIFIED` to `DriverDocument.verificationStatus`. Because `setOnline` requires a verified driving licence, **no driver in the system can ever go online.**

**Four zero-caller symbols tell the whole story.** Each has exactly one reference in `src/` — its own definition:

| Symbol               | Refs in `src/`     | Meaning                               |
| -------------------- | ------------------ | ------------------------------------- |
| `grantRole`          | 1 (definition)     | The `driver` role is never granted    |
| `offerToDriver`      | 1 (definition)     | No ride offer is ever created         |
| `findActiveByDriver` | 1 (definition)     | No one-active-ride guard              |
| `findNearbyDrivers`  | 3 (all inside geo) | Discovery never leaves the geo module |

**One subscriber exists in the entire platform** — `epoch-invalidation.consumer.ts`. Every other event is durably written to the outbox and triggers nothing.

**Verdict:** this is overwhelmingly a **connection problem, not a build problem**. §22 lists 14 capabilities that are fully built and merely unwired.

---

## 2. Repository Baseline

`BUILD VERIFIED` — all commands executed this session, read-only.

| Check             | Command                                  | Status             | Detail                                                                                                       |
| ----------------- | ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Branch            | —                                        | —                  | `feature/auth`                                                                                               |
| HEAD              | —                                        | —                  | `269e927 chore(logger): keep otp and phone readable in development logs only`                                |
| Working tree      | `git status --short src/ tests/ prisma/` | **CLEAN**          | No uncommitted changes                                                                                       |
| Typecheck         | `npm run typecheck`                      | **PASS**           | Both `tsconfig.json` and `tsconfig.tools.json`                                                               |
| Lint              | `npm run lint`                           | **PASS**           | `--max-warnings=0`                                                                                           |
| Format            | `npm run format:check`                   | **FAIL**           | 34 files — **all outside `src/`** (`ride-demo-frontend/`, `.specify/`, `docs/`)                              |
| Unit tests        | `npm run test:unit`                      | **PASS**           | 714 / 714, 142 suites                                                                                        |
| Integration tests | `npm run test:integration`               | **NOT VERIFIABLE** | No local Postgres/Redis; Docker daemon unavailable. **CI runs them** with PostGIS + Redis service containers |
| Build             | `npm run build`                          | **PASS**           | Full chain: `clean` → `tsc` → `tsc-alias` → `copy-generated`                                                 |
| Prisma validate   | `npm run prisma:validate`                | **PASS**           | —                                                                                                            |

**Recent commits (today):**

```
269e927  chore(logger): keep otp and phone readable in development logs only
b7f7da7  feat(driver): add explicit onboarding endpoint and driver email capture
eb3e062  feat(auth): allow email updates through the user profile endpoint
273aadb  refactor: remove unnecessary comments from src to improve readability
```

**The only blocker: `format:check`.** CI's `quality` job runs it **first**, before lint and typecheck, so a push fails there. Not caused by today's commits — the offending files are frontend, Spec Kit templates, and audit docs. **Not fixed, per instructions.**

**Infrastructure verified as sound:** DI via Awilix (`src/core/di.ts`), route registration (`src/routes/register.ts`), transactional outbox with claim-token relay and retry/backoff, BullMQ workers with Redis distributed locks, husky pre-push running typecheck+lint, and a CI `build` job that greps `dist/` for unresolved path aliases.

---

## 3. Module Inventory

`CODE VERIFIED` — 23 modules.

| Module                                                                                                          | Status                     | Prisma models                                                                                                      | Routes             | Jobs                                                  | Notes                                           |
| --------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------- | ----------------------------------------------- |
| `auth`                                                                                                          | **PRODUCTION IMPLEMENTED** | `User`, `UserSession`, `UserDevice`, `Role`, `UserRoleAssignment`, `Permission`, `OtpVerification`, `RefreshToken` | `/api/v1/auth`     | `auth-retention`, `otp-delivery`                      | Only module with an event subscriber            |
| `users`                                                                                                         | **PRODUCTION IMPLEMENTED** | `UserProfile`, `SavedPlace`, `EmergencyContact`, `DeletionRequest`                                                 | `/api/v1/users`    | `account-erasure`                                     | —                                               |
| `files`                                                                                                         | **PRODUCTION IMPLEMENTED** | `File`                                                                                                             | `/api/v1/files`    | `sweeper`, `retention`, `reconciliation`              | 5 purposes incl. `DRIVER_DOCUMENT`              |
| `payments`                                                                                                      | **PRODUCTION IMPLEMENTED** | `PaymentLedgerEntry`, `PaymentIntent`, `Refund`, `Payout`, `DriverSettlement`, `Chargeback`, `WebhookEvent`        | `/api/v1/payments` | `reconciliation` ✅ · **`settlement` ❌ unscheduled** | Ledger correct; settlement never runs           |
| `rides`                                                                                                         | **PARTIALLY IMPLEMENTED**  | `Ride`, `RideRequest`, `RideFare`, `RideOtp`, `RideDispatch`, `RideStatusEvent`, `RideCancellation`, `RideReceipt` | `/api/v1/rides`    | `dispatch-timeout`, `request-expiry`                  | Lifecycle solid; dispatch half unreachable      |
| `drivers`                                                                                                       | **PARTIALLY IMPLEMENTED**  | 9 `Driver*` models                                                                                                 | `/api/v1/drivers`  | `heartbeat-timeout` ✅ · `doc-expiration` (inert)     | Stops at document review                        |
| `geo`                                                                                                           | **PRIMITIVES ONLY**        | `DriverLocation` (read)                                                                                            | none               | none                                                  | Write path wired; read path unwired             |
| `notifications`                                                                                                 | **PARTIALLY IMPLEMENTED**  | none                                                                                                               | none               | none                                                  | SMS only; **no push**                           |
| `vehicles`                                                                                                      | **STUB/SCAFFOLD**          | `Vehicle`, `VehicleType`, `VehicleDocument`, `VehicleImage`, `VehicleAssignment`, `VehicleInspection`              | none               | none                                                  | Full schema, `export {};`                       |
| `dispatch`                                                                                                      | **STUB/SCAFFOLD**          | —                                                                                                                  | none               | none                                                  | Primitives live in `rides/`                     |
| `matching`                                                                                                      | **STUB/SCAFFOLD**          | —                                                                                                                  | none               | none                                                  | Nothing anywhere                                |
| `admin`, `support`                                                                                              | **STUB/SCAFFOLD**          | —                                                                                                                  | none               | none                                                  | 2 admin routes live in `drivers/`               |
| `documents`, `onboarding`, `riders`, `pricing`, `promotions`, `reviews`, `chat`, `sos`, `analytics`, `settings` | **STUB/SCAFFOLD**          | —                                                                                                                  | none               | none                                                  | All `export {};` + identical boilerplate README |

### 3.1 Disconnection inventory

| Category                                 | Findings                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`export {};` stubs**                   | 15 modules, plus ~20 files across `common/`, `infrastructure/`, `middleware/`, `shared/`, `plugins/socket`, `plugins/jwt`                                                                                                                                                                                                                                                                                                        |
| **Zero production callers**              | `grantRole`, `revokeRole`, `offerToDriver`, `findActiveByDriver`, `findByRequestAndDriver`, `updateResponse`, `findNearbyDrivers` (outside geo), `liveDriverPosition`, `calculateExactDistanceMeters`, `isWithin`, `findAllowedCodesForUser`, `ShiftService.getActiveShift`, `DriverBankRepository` (whole class), `DriverWalletRepository.lockForUpdate`, `driverExtension.findActiveDrivers`, `DriverMetrics.heartbeatTimeout` |
| **Unregistered jobs**                    | **`SettlementJob`** — DI-registered as `settlementJob`, absent from `JOB_SCHEDULES` and `MAINTENANCE_HANDLERS`                                                                                                                                                                                                                                                                                                                   |
| **Events with no subscriber**            | All except `account.role.granted`/`revoked`/`account.suspended`/`auth.refresh.reuse_detected`                                                                                                                                                                                                                                                                                                                                    |
| **Models with no production write path** | `Vehicle`, `VehicleType`, `VehicleDocument`, `VehicleImage`, `VehicleAssignment`, `VehicleInspection`, `RideDispatch`, `DriverBankAccount`, `AuditLog` (**model does not exist** — `audit.prisma` is one comment line)                                                                                                                                                                                                           |
| **Models never updated after create**    | **`DriverWallet`** — balance permanently zero                                                                                                                                                                                                                                                                                                                                                                                    |
| **Unregistered plugins**                 | `driverPlugin`, `ridePlugin`, `filePlugin`, `paymentPlugin`, `userPlugin`, `socket.plugin`, `jwt.plugin`                                                                                                                                                                                                                                                                                                                         |

---

## 4. Auth and OTP Verification

`CODE VERIFIED` — **PRODUCTION IMPLEMENTED, fully reusable for Driver.**

```
POST /api/v1/auth/otp/send  → AuthController.sendOtp → AuthService.sendOtp → OtpService.send
  Redis challenge claim (cooldown + per-phone window) → per-device + per-IP axes
  → hashed OTP in Redis → audit row in otp_verifications
  → BullMQ auth-otp → OtpDeliveryJob → NotificationService.sendOtp (MSG91)

POST /api/v1/auth/otp/verify → AuthService.verifyOtp  [Idempotency-Key → redis.idempotency.runOnce]
  ONE TRANSACTION:
   1 otpService.verify — assertChallengeBelongsToCaller binds challengeId to
     phoneNumber + purpose + unconsumed; throws before any write
   2 resolveAccount — find-or-create User; P2002 phone collision re-read
   3 ensureDefaultRole → grants 'customer'
   4 assertAuthenticatable — rejects deletedAt / DEACTIVATED / non-ACTIVE
   5 userProfileRepository.ensureExists → publishes user.profile.created
   6 deviceService.register (UserDevice — where fcmToken lands)
   7 roleRepository.findActiveRoleSlugs        ← the role read
   8 sessionService.createInTransaction
   9 tokenService.issuePair({ userId, sessionId, roles })
  10 publishes auth.otp.verified, auth.login.succeeded, auth.session.created
  → after commit: sessionService.enforceCap
```

**The Driver App uses these exact two endpoints. No driver branch exists anywhere in this flow.** A single hardcoded purpose, `AUTH_OTP_PURPOSE = 'LOGIN'`, serves both apps.

**Security properties verified:** deny-by-default `onRequest` hook; fail-closed `503` on Redis/DB failure (observed live); OTP redaction in production (`otp`, `phoneNumber` in `REDACT_PATHS`; `level: 'info'` outside development); **no `role`/`roles`/`userType`/`appType` field in any auth request schema** — roles are un-injectable by construction.

`TEST VERIFIED` — `auth-login.test.ts`, `otp-hardening.test.ts`, `auth-enumeration.test.ts`, `auth-roles.test.ts`, `auth-session-cap.test.ts`, `auth-expiry.test.ts`.

---

## 5. User Verification

`CODE VERIFIED` — **PRODUCTION IMPLEMENTED, correct with Driver onboarding.**

`User` is created only in `AuthService.resolveAccount`. `Driver` is a **1:1 optional extension** — `Driver.userId @unique` FK to `User.id` (`SCHEMA VERIFIED`).

**New since the last audit:** commit `eb3e062` made `email` an updatable profile field — removed from `IMMUTABLE_PROFILE_FIELDS`, added to `updateProfileSchema`, and `UserService.updateProfile` now calls `UserRepository.updateEmail` **inside its transaction**.

**One remaining defect:** `DriverRepository.updateProfile` still writes `users.email` via a **raw `client.user.update`**, bypassing `UserRepository.updateEmail`. Consequences: a `@unique` collision surfaces as **500 not 409**; `isEmailVerified` is never managed; two write paths to one column will drift. `CODE VERIFIED`

---

## 6. Files Verification

`CODE VERIFIED` — **PRODUCTION IMPLEMENTED. Already capable of supporting driver documents securely. Do not rebuild.**

| Capability                            | Detail                                                                                                                                        | Used by Drivers?                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Presigned PUT upload                  | `POST /files` → `POST /files/:id/complete`                                                                                                    | ❌                                          |
| Content verification                  | Magic bytes vs declared type, size, dimensions, checksum, **EXIF-location rejection**; refused objects deleted from storage                   | ❌                                          |
| Scan state machine                    | Unusable until `READY` (migration `20260812150000`)                                                                                           | ❌                                          |
| **`DRIVER_DOCUMENT` purpose**         | jpeg/png/webp/pdf, 10 MB, 5000×5000 px, `rejectExifLocation: true`, 300 s read TTL, **2920-day ARCHIVE on `DRIVER_RELATIONSHIP_ENDED`**       | ❌ **zero consumers**                       |
| Operator read policy                  | `decideRead` grants `DRIVER_DOCUMENT` to the `drivers:verify` scope — held by `admin`, deliberately **not** `support`; operator reads audited | ❌                                          |
| `registerFileReference`               | `DELETE /files/:id` → `409 FILE_IN_USE` while referenced                                                                                      | ❌ only `users` registers (`PROFILE_IMAGE`) |
| Retention/sweeper/reconciliation jobs | Scheduled and running                                                                                                                         | ✅                                          |

**Five purposes exist:** `PROFILE_IMAGE`, `DRIVER_DOCUMENT`, `VEHICLE_DOCUMENT`, `VEHICLE_IMAGE`, `SOS_EVIDENCE`.

> The purpose name, the `DRIVER_RELATIONSHIP_ENDED` retention trigger, and the `drivers:verify` operator scope prove Files was **designed for driver KYC**. The driver module simply never connected to it. `INFERENCE`

---

## 7. Driver Module Verification

`CODE VERIFIED` — 54 files, 19 directories, **none empty**.

| Responsibility                       | Current location                                                                 | Classification                      |
| ------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------- |
| 1. Onboarding                        | `services/onboarding/onboarding.service.ts` (2 of 4 methods)                     | `KEEP_IN_DRIVERS`                   |
| 2. Profile                           | same service + `driver.repository.ts`                                            | `KEEP_IN_DRIVERS`                   |
| 3–4. Documents / submission          | `submitDocument` **inside onboarding service** + `driver-document.repository.ts` | `KEEP_IN_DRIVERS` (wrong submodule) |
| 5. Document verification             | **NOWHERE**                                                                      | `STUB` — missing                    |
| 6–7. Driver verification / approval  | `reviewDriverVerification` **inside onboarding service**                         | `KEEP_IN_DRIVERS` (wrong submodule) |
| 8. Role lifecycle                    | **NOWHERE** — `grantRole` uncalled                                               | `STUB`                              |
| 9. Eligibility                       | inside `StatusService.setOnline`                                                 | `CROSS_MODULE_ORCHESTRATION`        |
| 10–12. Online / offline / suspension | `services/status/status.service.ts`                                              | `KEEP_IN_DRIVERS` (suspend broken)  |
| 13. Shifts                           | `driver-shift.repository.ts`; `ShiftService` **dead**                            | `KEEP_IN_DRIVERS` / `DEAD_CODE`     |
| 14. Heartbeat                        | `StatusService` + `heartbeat-timeout.job.ts`                                     | `KEEP_IN_DRIVERS`                   |
| 15–16. Location / plausibility       | `services/location/`                                                             | `KEEP_IN_DRIVERS`                   |
| 17. Geo integration                  | `LocationService` → `geoService`                                                 | `CROSS_MODULE_ORCHESTRATION`        |
| 18. Wallet read model                | `services/wallet/` (2 read methods)                                              | `KEEP_IN_DRIVERS`                   |
| 19. Earnings                         | **none in Drivers** — Payments owns it                                           | correct                             |
| 20. Events                           | `events/catalog.ts` — 8 types, 4 never published                                 | `KEEP_IN_DRIVERS`                   |
| 21. Jobs                             | 2 jobs, both scheduled                                                           | `KEEP_IN_DRIVERS`                   |

**Dead code:** `plugins/driver.plugin.ts`, `schemas/driver.responses.ts`, `driver-bank.repository.ts`, `services/shift/shift.service.ts`, `DriverWalletRepository.lockForUpdate`, `InvalidDriverStatusTransitionError`, `DocumentValidationError`, `DriverMetrics.heartbeatTimeout`, 4 unpublished events, `DriverVerificationStatus.SUSPENDED`, `driverConfig.requireApprovedDocuments`, `driverConfig.maxContinuousShiftHours`.

**No file needs to move to another top-level module.**

---

## 8. Driver Entry Flow

`CODE VERIFIED` — traced route → controller → service → repository → table.

| Step       | Route                               | Controller                   | Service             | Repository                 | Tables                                              | Tx  | Event              | Authz            | Idempotent           | Concurrency-safe   | Reachable |
| ---------- | ----------------------------------- | ---------------------------- | ------------------- | -------------------------- | --------------------------------------------------- | --- | ------------------ | ---------------- | -------------------- | ------------------ | --------- |
| OTP send   | `POST /auth/otp/send`               | `AuthController`             | `OtpService`        | `OtpRepository`            | `otp_verifications`                                 | —   | `auth.otp.sent`    | public           | ✅                   | ✅ Redis claim     | ✅        |
| OTP verify | `POST /auth/otp/verify`             | `AuthController`             | `AuthService`       | User/Role/Session          | `users`,`user_roles`,`user_sessions`,`user_devices` | ✅  | 4 events           | public           | ✅ `Idempotency-Key` | ✅ `P2002`         | ✅        |
| Onboard    | `POST /drivers/me/onboard`          | `DriverOnboardingController` | `OnboardingService` | `DriverRepository`         | `drivers`                                           | ✅  | `driver.onboarded` | authenticated    | ✅ read-then-create  | ✅ `P2002`         | ✅        |
| Profile    | `PATCH /drivers/:driverId/profile`  | same                         | same                | `DriverRepository`         | `driver_profiles`, **`users`**                      | ✅  | none               | `actingDriverId` | ✅ upsert            | ⚠️ unlocked        | ✅        |
| Get me     | `GET /drivers/me`                   | same                         | —                   | `DriverRepository`         | 4 tables (joined)                                   | —   | none               | authenticated    | ✅                   | ✅                 | ✅        |
| Documents  | `POST /drivers/:driverId/documents` | same                         | same                | `DriverDocumentRepository` | `driver_documents`                                  | ✅  | none               | `actingDriverId` | ⚠️ racy              | ❌ no unique index | ✅        |

### 8.1 Customer-safety checks

| Check                                       | Result                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer login does **not** create a Driver | ✅ **FIXED TODAY** (`b7f7da7`). At the previous HEAD, `GET /drivers/me` called `createOrGetDriver` — a read endpoint that created a Driver row |
| `GET /drivers/me` is read-only              | ✅ Pure `findByUserId`                                                                                                                         |
| Driver creation explicit                    | ✅ `POST /me/onboard`                                                                                                                          |
| Identity from JWT                           | ✅ `callerId(req)` → `request.auth.userId` ← JWT `sub`                                                                                         |
| Client cannot pass arbitrary `userId`       | ✅ No body, no param on onboard; `:driverId` parsed and **ignored** elsewhere                                                                  |
| BOLA/IDOR protection                        | ✅ `actingDriverId` / `authorizedDriverId` with `['admin','support']` staff bypass                                                             |
| Email stored correctly                      | ⚠️ Persists, but via a raw write (§5)                                                                                                          |
| Shared User data not duplicated             | ✅ `DriverProfile` has **no** email column                                                                                                     |
| Onboarding resumable                        | ✅ `findByUserId` returns profile + documents + onlineStatus in one read                                                                       |

---

## 9. Files → Driver Documents Flow

`CODE VERIFIED`

| Question                               | Answer                                                     |
| -------------------------------------- | ---------------------------------------------------------- |
| A. Accepts arbitrary `fileUrl`?        | **YES** — `fileUrl: z.string().url()`. Any URL that parses |
| B. Uses `fileId`?                      | **NO** — no such column on `DriverDocument`                |
| C. Validates ownership?                | **NO** — there is no file record to own                    |
| D. Validates purpose?                  | **NO**                                                     |
| E. Validates existence?                | **NO**                                                     |
| F. Validates the driver owns the file? | **NO**                                                     |

**The integration gap, exactly:** `drivers/` does not import `@modules/files` **at all**. The `DRIVER_DOCUMENT` purpose, the presigned upload, the content verification, the operator read scope, and `registerFileReference` all exist and have **zero consumers**.

**Minimum change:** replace `fileUrl: string` with `fileId` (schema change), call the Files ownership+purpose check on submission, and register a `DRIVER_DOCUMENT` file reference. **No new file infrastructure is needed.**

---

## 10. Document Review Flow

**MISSING — the first lifecycle blocker.** `CODE VERIFIED`

Exhaustive search of every writer of `DriverDocument.verificationStatus`:

| Value          | Production writer                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `PENDING`      | `DriverDocumentRepository.upsertDocument` (both branches) — driver's own submission                                                    |
| `REJECTED`     | `DocExpirationJob:23` → `updateVerificationStatus(id, 'REJECTED', undefined, 'Document expired')` — **the only caller of that method** |
| **`VERIFIED`** | **NONE**                                                                                                                               |
| `verifiedBy`   | **NONE** — the sole caller passes `undefined`                                                                                          |
| `verifiedAt`   | **NONE** — set only on the unreachable `VERIFIED` branch                                                                               |

| #   | Question                                             | Answer                                                                |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Can a document become `VERIFIED` via production API? | **NO**                                                                |
| 2   | Can a document become `REJECTED` via production API? | **NO** — only the expiry job, never a reviewer                        |
| 3   | Can an admin review documents?                       | **NO** — no route, no service method                                  |
| 4   | Can a driver be approved with zero documents?        | **YES** — `reviewDriverVerification` never queries `driver_documents` |
| 5   | Are required documents checked before approval?      | **NO** — no required set is declared anywhere                         |

**Everything else is already in place:** `updateVerificationStatus(id, status, verifiedBy?, rejectionReason?, tx?)` writes `verifiedAt` and accepts `verifiedBy`; the schema columns exist; `drivers:verify` is seeded to `admin`; the Files operator read-scope exists.

**Consequence:** `DocExpirationJob` is scheduled, DI-resolved, Redis-locked — and **permanently a no-op**, because its query requires `verificationStatus: 'VERIFIED'`.

---

## 11. Driver Approval and Role Flow

`CODE VERIFIED`

```
POST /api/v1/drivers/:id/verify   [authorize roles:['admin']]
  └─ OnboardingService.reviewDriverVerification
       ├─ lockForUpdate (SELECT … FOR UPDATE)         ✅
       ├─ updateVerificationStatus → VERIFIED          ✅
       ├─ approvedAt / approvedBy set                  ✅
       ├─ driverMetrics.driverVerified                 ✅
       └─ publish driver.verified → event_outbox       ✅
                    ↓ OutboxRelay → EventBus.emit('driver.verified')
             ┌────────────────────────┐
             │   ZERO SUBSCRIBERS     │
             └────────────────────────┘
       ❌ no document-completeness check
       ❌ AuthService.grantRole NEVER CALLED  (1 ref in src = the definition)
       ❌ security epoch never bumped
```

| #   | Question                                                   | Answer                                                                                                                                                                                        |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Is the `DRIVER` role granted automatically?                | **NO**                                                                                                                                                                                        |
| 7   | What mechanism should connect approval to role assignment? | Both are structurally viable — §11.1                                                                                                                                                          |
| 8   | Does `Drivers → Auth` create a circular dependency?        | **NO.** `DriverAccessRepository` imports **only `@core/database`** and reads `this.client.driver` via the shared Prisma client. **There is no `auth → drivers` import edge.** `CODE VERIFIED` |
| 9   | Is there an existing event/outbox pattern to reuse?        | **YES** — `EventPublisher.publish(input, tx?)` → `event_outbox` → `OutboxRelay` (claim token, retry/backoff) → `EventBus`. One consumer exists as precedent: `EpochInvalidationConsumer`      |

### 11.1 The two mechanisms, on evidence

|                   | **A — in the approval transaction**                                                                              | **B — `driver.verified` subscriber**                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Cycle risk        | **None**                                                                                                         | None                                                                                                                                      |
| Atomicity         | Strong — role and status commit together                                                                         | Eventual — brief `VERIFIED`-without-role window                                                                                           |
| Precedent in repo | none                                                                                                             | **Matches `EpochInvalidationConsumer`, the only consumer**                                                                                |
| Failure mode      | Approval rolls back if the grant fails — visible                                                                 | Outbox retry ⇒ at-least-once; `grantRole` idempotent (returns `false` + `uq_user_role_active` partial unique index) ⇒ redelivery harmless |
| Caution           | `grantRole` bumps the epoch **after** commit; inside an outer transaction the bump fires before the outer commit | Driver App must tolerate the window                                                                                                       |

**The architecture does not clearly establish one, so this audit does not choose.** `INFERENCE`

---

## 12. Eligibility and Online Flow

`CODE VERIFIED` — `StatusService.setOnline`, one transaction after `lockForUpdate`:

| #   | Condition                                                            | Where checked                                        | Can it become true today? |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------- |
| 1   | Driver row exists                                                    | `actingDriverId` + `setOnline`                       | ✅                        |
| 2   | `verificationStatus === 'VERIFIED'`                                  | route guard **and** service                          | ✅ via admin approval     |
| 3   | `!isSuspended`                                                       | both                                                 | ✅                        |
| 4   | **A `DRIVING_LICENSE` doc with `verificationStatus === 'VERIFIED'`** | `setOnline`                                          | ❌ **IMPOSSIBLE** — §10   |
| 5   | Existing active shift                                                | `startShift` (idempotent)                            | ✅                        |
| —   | `driver` role in JWT                                                 | **not checked on any driver route**                  | n/a                       |
| —   | Vehicle                                                              | **not checked**                                      | n/a                       |
| —   | Active ride conflict                                                 | **not checked** — `findActiveByDriver` has 0 callers | n/a                       |
| —   | Licence expiry                                                       | **not checked** at go-online                         | n/a                       |

### 12.1 Requirements per stage — from schema evidence

| Stage                   | Vehicle required? | Evidence                                                                                              |
| ----------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| **A. ONLINE**           | **NO**            | `DriverOnlineStatus` has **no vehicle column**                                                        |
| **B. Receive an offer** | **NO**            | `RideDispatch.vehicleId` is **nullable** (`String?`, `vehicle Vehicle?`)                              |
| **C. Accept a ride**    | **YES**           | **`rides.vehicle_id UUID NOT NULL`** (`migration.sql:1567`), `vehicle Vehicle @relation` non-optional |
| **D. Start a ride**     | inherited from C  | Ride already exists                                                                                   |

> The schema states this explicitly: an offer may exist without a vehicle, a ride may not, and availability is modelled independently of vehicles. **The hard vehicle gate belongs at acceptance, not at online.** `SCHEMA VERIFIED`

---

## 13. Vehicle Flow

`CODE VERIFIED` / `SCHEMA VERIFIED` — **STUB over a complete schema.**

| Step                    | Schema                                                                                    | Code                                |
| ----------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| Vehicle register        | ✅ `Vehicle` (`registrationNumber @unique`, `vin @unique`, `currentDriverId`, `isActive`) | ❌ none                             |
| Vehicle documents       | ✅ `VehicleDocument` (`documentType String` — free text, not enum)                        | ❌ none                             |
| Vehicle verification    | ⚠️ per-document only; no vehicle-level approval column                                    | ❌ none                             |
| Vehicle active          | ✅ `isActive`                                                                             | ❌ never read                       |
| Assignment to driver    | ✅ `VehicleAssignment`                                                                    | ❌ **zero hand-written references** |
| Available for ride      | ✅ `VehicleType` (read by fare quoting)                                                   | ⚠️ read-only                        |
| Validated at acceptance | ❌                                                                                        | ❌ **nothing validated**            |

**At acceptance, `vehicleId` is client-supplied and checked for nothing** — not existence (arbitrary UUID ⇒ FK violation ⇒ **500**), not assignment (`VehicleAssignment` never consulted ⇒ **a driver can accept in another driver's vehicle**), not `isActive`, not `vehicle.vehicleTypeId === request.vehicleTypeId` (⇒ **accept a premium request in a hatchback, be paid the premium quote**), not document validity.

**`Driver.currentVehicleId` has no `@relation` and therefore no FK**, and zero hand-written references.

---

## 14. Location and Geo Flow

`CODE VERIFIED`

```
POST /drivers/location  [rateLimit only — NO eligibility guard]
  → reject isMockLocation (driverConfig.rejectMockLocation defaults true)
  → driver exists
  → assessPlausibility (age ≤120s, speed ≤200km/h, noise floor 50m)
  → driverLocationRepository.updateLocation — raw INSERT … ON CONFLICT,
      writes decimal lat/lng AND PostGIS geography(Point,4326)
  → geoService.recordDriverPosition — H3 cell → Redis live store
  → driverStatusRepository.updateHeartbeat
```

| #   | Question                                       | Answer                                                                                                                                         |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Can unverified drivers enter the Geo index?    | **YES** — no eligibility gate                                                                                                                  |
| 2   | Can offline drivers?                           | **YES** — no online-status filter                                                                                                              |
| 3   | Can suspended drivers?                         | **YES**                                                                                                                                        |
| 4   | Are offline drivers removed?                   | ✅ `setOffline` → `forgetDriverPosition`, correctly **after** commit                                                                           |
| 5   | Does going offline remove availability?        | ✅ Yes                                                                                                                                         |
| 6   | Does heartbeat timeout remove it?              | ✅ Via `setOffline`; ⚠️ drivers with `heartbeatAt = null` are never swept                                                                      |
| 7   | Can `findNearbyDrivers` find eligible drivers? | ⚠️ It queries `driver_locations` **alone** — no join to `drivers`, no filter on `verificationStatus`/`isSuspended`/`isAvailable`/online status |
| 8   | Does Matching/Dispatch call it?                | **NO** — 3 refs in `src/`, all inside the geo module                                                                                           |

**Removal mechanisms:** explicit `forgetDriverPosition`; Redis TTL `liveLocationTtlSeconds = 300`; PostGIS freshness bound `candidateStalenessSeconds = 120`. **None is state-aware.**

---

## 15. Matching and Dispatch Flow

`CODE VERIFIED` — **the chain is severed at the first link.**

```
POST /rides/requests → RideRequest(CREATED)
  └─ publish ride.requested → event_outbox → EventBus
             ↓
      ZERO SUBSCRIBERS  ──►  ✗ END

  [ findNearbyDrivers      — complete, 0 callers outside geo ]
  [ offerToDriver          — complete, 1 ref in src = definition ]
  [ RideDispatchRepository — createOffer / findByRequestAndDriver / updateResponse, 0 callers ]
  [ notification/push      — DOES NOT EXIST ]
  [ DispatchTimeoutJob     — scheduled ✅, table always empty ]

POST /rides/accept ← the ONLY way a Ride is created,
                     and the driver must already know the requestId
```

| Stage                    | Primitives exist | Orchestration exists | Reaches drivers |
| ------------------------ | ---------------- | -------------------- | --------------- |
| `ride.requested` emitted | ✅               | ✅                   | ✅              |
| Nearby discovery         | ✅               | ❌                   | ❌              |
| Eligibility filter       | ❌               | ❌                   | ❌              |
| Offer creation           | ✅               | ❌                   | ❌              |
| Offer delivery           | ❌               | ❌                   | ❌              |
| Timeout                  | ✅               | ✅ (job runs)        | ❌ empty table  |
| Next driver              | ❌               | ❌                   | ❌              |

**Can a real online driver currently receive a ride? NO.** No `RideDispatch` row is ever created, and no delivery channel exists. `DispatchTimeoutJob` marks `PENDING` offers `TIMEOUT` but **does not re-offer** — timeout is terminal.

---

## 16. Notification Flow

`CODE VERIFIED` — **SMS only.**

`NotificationService` has exactly two methods: `sendSms(to, body, options?)` and `sendOtp(to, code)`, behind an `SmsProvider` interface (MSG91 + mock). Callers: `OtpService.notifyLocked` and `OtpDeliveryJob.run`.

| #   | Question                              | Answer                                                                                                                                                    |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Are FCM tokens stored?                | **YES** — `UserDevice.fcmToken`, written by `deviceService.register` during OTP verify                                                                    |
| 2   | Are they ever consumed?               | **NO.** Every reference is the schema, type, controller write path, or repository write. **Nothing reads it to send anything**                            |
| 3   | Can an offer trigger a push?          | **NO** — no push method exists                                                                                                                            |
| 4   | Primitives complete but disconnected? | **No — genuinely absent.** No FCM SDK, no APNs, no Firebase dependency, no WebSocket (`plugins/socket/socket.plugin.ts` is `export {};` and unregistered) |
| 5   | Blocker for production dispatch?      | **YES — hard blocker.** An offer with no delivery channel cannot reach a driver                                                                           |

---

## 17. Driver Ride Lifecycle

`CODE VERIFIED` / `SCHEMA VERIFIED`

| #   | Question                                                    | Answer                                                                                      |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Can a driver accept multiple concurrent rides?              | **YES**                                                                                     |
| 2   | Service-level check?                                        | **NO** — `findActiveByDriver` has 1 ref in `src/` = its definition                          |
| 3   | Database backstop?                                          | **NO** — see §17.1                                                                          |
| 4   | Which statuses are written?                                 | `ONLINE`, `OFFLINE` only                                                                    |
| 5   | Are `BUSY`/`ON_TRIP` real transitions?                      | **NO — enum values with no writer anywhere**                                                |
| 6   | Does completing restore availability?                       | **N/A** — availability is never removed on accept                                           |
| 7   | Vehicle validated at acceptance?                            | **NO** — §13                                                                                |
| 8   | Arbitrary `vehicleId`?                                      | **YES**                                                                                     |
| 9   | Driver ride endpoints authorized?                           | ✅ `requireOperableDriver` on accept/arrive/start/complete; ⚠️ `cancel` has rate-limit only |
| 10  | Do driver/customer history queries return the right branch? | **NO** — §17.2                                                                              |

### 17.1 What the database actually protects

`SCHEMA VERIFIED` — every relevant unique index:

| Index                                                 | Protects                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `rides_request_id_key` on `rides(request_id)`         | **One ride per request** — two drivers cannot double-book the _same_ request |
| `ride_dispatches_request_id_driver_id_key`            | One offer per (request, driver)                                              |
| **Nothing on `rides(driver_id)` for active statuses** | ❌ **one driver, many concurrent rides is unprotected**                      |

`claimForMatch` is a correct conditional claim (`updateMany … status IN ('CREATED','SEARCHING') → 'MATCHED'`, `count === 1`) — but scoped to **one request**. Accepting two _different_ requests succeeds both times.

### 17.2 A live defect caused by the missing role

`ride-query.controller.ts:11-19`:

```ts
if (callerHasRole(req, 'driver')) {
  return reply.send({ data: await this.rideRepo.findActiveByDriverUserId(userId) });
}
return reply.send({ data: await this.rideRepo.findActiveByCustomer(userId) });
```

No user ever holds the `driver` role, so the branch is dead — a driver mid-trip is served their **customer** ride or `null`. `listHistory` is worse: it calls `listCustomerRides` **unconditionally**.

**Well-built and worth preserving:** `ALLOWED_TRANSITIONS`, `lockAndValidate` (row lock + ownership + transition check), `updateStatusIf` compare-and-set, start-OTP verification. `TEST VERIFIED` — `ride-state-machine.test.ts`, `ride-lifecycle-concurrency.test.ts`, `ride-otp.test.ts`.

---

## 18. Payments and Wallet Flow

**The most significant new finding of this audit.** `CODE VERIFIED`

### 18.1 What works — ride completion posts a correct ledger transaction

`LifecycleService.completeRide` (`lifecycle.service.ts:284`) calls `ledgerService.recordTripPayment(...)` **inside the same transaction** as the status write and fare record:

```ts
await this.ledgerService.recordTripPayment(
  {
    totalFare,
    driverPayable: itemizedFare.driverEarning,
    platformCommission,
    customerUserId: ride.customerId,
    driverId: ride.driverId,
    rideId,
    paymentMethod,
  },
  tx,
);
```

`recordTripPayment` correctly branches:

| Payment method | Ledger entries                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| **CASH**       | `DRIVER_PAYABLE` **DEBIT** commission + `PLATFORM_COMMISSION` **CREDIT** — the driver _owes_ the platform  |
| **Prepaid**    | `CUSTOMER_WALLET` **DEBIT** fare + `DRIVER_PAYABLE` **CREDIT** earnings + `PLATFORM_COMMISSION` **CREDIT** |

`postTransactionGroup` rejects non-positive amounts. Double-entry is sound.

### 18.2 What breaks — the money never reaches the driver's wallet

| Link                               | Status                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ride completed → ledger entries    | ✅ **WORKS**                                                                                                                                                       |
| Ledger → `DriverSettlement`        | ❌ **`SettlementJob` is DI-registered as `settlementJob` but absent from both `JOB_SCHEDULES` (9 entries) and `MAINTENANCE_HANDLERS` (9 entries) — it never runs** |
| `calculateSettlement` callers      | Only `SettlementJob.run` — which never runs                                                                                                                        |
| Ledger/settlement → `DriverWallet` | ❌ **`DriverWallet` is only ever CREATED, never UPDATED.** The sole write in the entire codebase is `driverWallet.create` inside `getOrCreateWallet`               |
| Driver reads wallet                | ✅ Route works — and returns **zero balance, forever**                                                                                                             |

> **Net effect:** driver earnings are recorded correctly in `payment_ledger_entries` as `DRIVER_PAYABLE`, and **the wallet API the driver sees never reflects them**. This is a data-presentation gap, not a data-loss gap — the ledger is the source of truth and it is correct.

### 18.3 Boundary

**PAYMENTS owns:** ledger, `recordTripPayment`, settlement calculation, payouts, refunds, intents, webhooks, commission.
**DRIVERS owns:** a read-only wallet projection (`getWallet`, `listTransactions`).
**No duplicate money logic exists.** `grep -rln "earnings" src` → 3 Payments files, **zero Drivers files**.

**Note:** `rides` deep-imports `@modules/payments/services/ledger/ledger.service.js` — a cross-module deep import into private internals, worth a barrel export.

---

## 19. Admin and Support Flow

`CODE VERIFIED` — `src/modules/admin/` and `src/modules/support/` are `export {};`. No `/api/v1/admin` or `/api/v1/support` prefix registered.

**Every admin-capable production endpoint on the platform:**

| Endpoint                                              | Guard               | Capability                           |
| ----------------------------------------------------- | ------------------- | ------------------------------------ |
| `POST /api/v1/drivers/:id/verify`                     | `roles:['admin']`   | Approve/reject a driver              |
| `POST /api/v1/drivers/:id/suspend`                    | `roles:['admin']`   | Suspend/reinstate — ⛔ **deadlocks** |
| `GET /api/v1/drivers/:id/location`                    | staff bypass        | Read a driver's location             |
| `GET /api/v1/drivers/:driverId/wallet[/transactions]` | staff bypass        | Read a driver's wallet               |
| `GET /api/v1/files/:id[/url]`                         | `decideRead` scopes | Read another user's file             |
| Payments payout routes                                | `finance`/`admin`   | Payout execution                     |

**Missing:** pending-driver queue, pending-document queue, document review endpoints, required-document validation, `verifiedBy`/`verifiedAt` population, rejection reason on document review, **and any `AuditLog` model** (`prisma/schema/shared/audit.prisma` is a single comment line).

> **Admin should not own driver business rules.** `reviewDriverVerification` locks the driver row and drives the state machine — that is Driver domain regardless of initiator. A future Admin module should provide the _queue/list_ surface and call Driver services. `INFERENCE`

---

## 20. Full End-to-End Workflow Map

| #   | Arrow                        | Status | Reason / evidence                                                                            |
| --- | ---------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| 1   | PHONE → OTP                  | 🟢     | `OtpService.send` + BullMQ + MSG91                                                           |
| 2   | OTP → USER                   | 🟢     | `resolveAccount`, `P2002`-safe                                                               |
| 3   | USER → DRIVER ONBOARD        | 🟢     | `POST /me/onboard` — **landed today** (`b7f7da7`)                                            |
| 4   | ONBOARD → PROFILE            | 🟢     | Name/gender/email persist                                                                    |
| 5   | PROFILE → FILE UPLOAD        | 🔴     | Drivers never imports `@modules/files`. Files is complete and unused                         |
| 6   | FILE → DOCUMENT SUBMISSION   | ⚠️     | Works, but `fileUrl: z.string().url()` — arbitrary URL, no ownership/purpose/existence check |
| 7   | SUBMISSION → DOCUMENT REVIEW | 🔴     | **No route, no service, no writer of `VERIFIED`** ⛔ **FIRST BLOCKER**                       |
| 8   | REVIEW → REQUIRED-DOC CHECK  | 🔴     | No required set declared; `requireApprovedDocuments` (default `true`) has **zero consumers** |
| 9   | CHECK → DRIVER APPROVAL      | ⚠️     | Route works; **approves with zero documents**                                                |
| 10  | APPROVAL → DRIVER ROLE       | 🟡     | `grantRole` complete, idempotent, epoch-bumping — **1 ref in `src/` = definition** ⛔        |
| 11  | ROLE → ELIGIBILITY           | 🟡     | Epoch → `401 TOKEN_STALE` → refresh re-reads roles. Complete, never fires                    |
| 12  | ELIGIBILITY → ONLINE         | 🔴     | `setOnline` requires a `VERIFIED` licence — unsatisfiable (#7)                               |
| 13  | ONLINE → LOCATION            | ⚠️     | Works — but **no eligibility gate**; any driver in any state can post                        |
| 14  | LOCATION → GEO               | 🟢     | PostGIS + H3 + Redis, with plausibility and mock-GPS rejection                               |
| 15  | GEO → MATCHING               | 🔴     | `findNearbyDrivers`: 3 refs, all inside geo. `matching/` is `export {};`                     |
| 16  | MATCHING → DISPATCH          | 🔴     | `dispatch/` is `export {};`; `ride.requested` has zero subscribers                           |
| 17  | DISPATCH → NOTIFICATION      | 🔴     | **No push exists.** FCM tokens stored, never read                                            |
| 18  | NOTIFICATION → OFFER         | 🟡     | `offerToDriver` complete — 1 ref = definition                                                |
| 19  | OFFER → ACCEPT               | ⚠️     | Accept works, but validates no offer (`findByRequestAndDriver` 0 callers)                    |
| 20  | ACCEPT → VEHICLE VALIDATION  | 🔴     | Nothing validated; another driver's vehicle accepted                                         |
| 21  | ACCEPT → ACTIVE RIDE         | ⚠️     | Ride created; **no one-active-ride guard** (no code, **no index**)                           |
| 22  | ACTIVE → PICKUP              | 🟢     | `lockAndValidate` + CAS                                                                      |
| 23  | PICKUP → START OTP           | 🟢     | `rideOtpService.verifyStartOtp`                                                              |
| 24  | START → TRIP                 | 🟢     | Transition table enforced                                                                    |
| 25  | TRIP → COMPLETE              | 🟢     | Fare finalised, status CAS                                                                   |
| 26  | COMPLETE → PAYMENT           | 🟢     | **`recordTripPayment` in the same transaction** — cash/prepaid branches                      |
| 27  | PAYMENT → EARNINGS           | ⚠️     | Ledger `DRIVER_PAYABLE` correct; **`SettlementJob` never scheduled**                         |
| 28  | EARNINGS → WALLET            | 🔴     | **`DriverWallet` never updated** — balance permanently zero                                  |
| 29  | COMPLETE → AVAILABLE AGAIN   | ⚪     | `BUSY`/`ON_TRIP` never written, so nothing to restore                                        |

**Tally:** 🟢 10 · 🟡 3 · ⚠️ 7 · 🔴 8 · ⚪ 1

---

## 21. Module Ownership Map

| Responsibility                  | Current location                                    | Correct owner     | Action                                     |
| ------------------------------- | --------------------------------------------------- | ----------------- | ------------------------------------------ |
| Driver onboarding               | `drivers/services/onboarding/`                      | **Drivers**       | KEEP                                       |
| Driver profile                  | `drivers/services/onboarding/` + repo               | **Drivers**       | KEEP                                       |
| Driver documents / KYC record   | `drivers/repositories/` + inside onboarding service | **Drivers**       | KEEP (wrong submodule internally)          |
| File storage / bytes / metadata | `files/`                                            | **Files**         | KEEP                                       |
| Driver document review          | **nowhere**                                         | **Drivers**       | CREATE                                     |
| Driver approval                 | `drivers/services/onboarding/`                      | **Drivers**       | KEEP (own submodule)                       |
| Role grant                      | `auth/services/auth.service.ts`                     | **Auth**          | KEEP — Drivers calls or emits              |
| JWT / sessions / epoch          | `auth/`                                             | **Auth**          | KEEP                                       |
| User email                      | `users/` ✅ + **raw write in `drivers/`** ❌        | **Users**         | FIX driver path                            |
| Geo indexing / nearby search    | `geo/`                                              | **Geo**           | KEEP                                       |
| Eligibility decision            | `drivers/services/status/`                          | **Drivers**       | KEEP                                       |
| Dispatch orchestration          | **nowhere** (primitives in `rides/`)                | **Dispatch**      | CREATE                                     |
| Matching                        | **nowhere**                                         | **Matching**      | CREATE                                     |
| Ride lifecycle                  | `rides/`                                            | **Rides**         | KEEP                                       |
| Vehicle lifecycle               | **nowhere** (schema only)                           | **Vehicles**      | CREATE                                     |
| Ledger / settlement / payouts   | `payments/`                                         | **Payments**      | KEEP                                       |
| Wallet mutations                | **nowhere**                                         | **Payments**      | CREATE                                     |
| Wallet read model               | `drivers/services/wallet/`                          | **Drivers**       | KEEP — read-only, no duplicate money logic |
| Push notifications              | **nowhere**                                         | **Notifications** | CREATE                                     |

**No file needs to move to another top-level module.** The only cross-module hygiene items: `rides` deep-imports `DriverRepository`, `driver.errors`, and `payments/.../ledger.service.js`; and `RideStateController` re-implements `actingDriverId` privately.

---

## 22. Reuse vs Build Matrix

| Capability                       | Already built | Production caller | Works E2E | Reuse   | New work needed                      |
| -------------------------------- | ------------- | ----------------- | --------- | ------- | ------------------------------------ |
| OTP                              | ✅            | ✅                | ✅        | **YES** | none                                 |
| JWT / sessions / refresh         | ✅            | ✅                | ✅        | **YES** | none                                 |
| User creation                    | ✅            | ✅                | ✅        | **YES** | none                                 |
| Role management (`grantRole`)    | ✅            | ❌                | ❌        | **YES** | **one caller**                       |
| Epoch invalidation               | ✅            | ✅                | ✅        | **YES** | none                                 |
| File upload                      | ✅            | ✅ (users)        | ✅        | **YES** | none                                 |
| File ownership validation        | ✅            | ✅                | ✅        | **YES** | call it from Drivers                 |
| `DRIVER_DOCUMENT` purpose        | ✅            | ❌                | ❌        | **YES** | consume it                           |
| Driver onboarding                | ✅            | ✅                | ✅        | **YES** | none                                 |
| Driver profile                   | ✅            | ✅                | ⚠️        | **YES** | route email via `UserRepository`     |
| Driver documents (submit)        | ✅            | ✅                | ⚠️        | **YES** | `fileId` + ownership check           |
| Document verification repository | ✅            | ⚠️ expiry only    | ❌        | **YES** | **service + route**                  |
| Driver approval                  | ✅            | ✅                | ⚠️        | **YES** | add document gate                    |
| Role grant on approval           | ❌            | ❌                | ❌        | —       | **one call or one subscriber**       |
| Eligibility                      | ✅            | ✅                | ❌        | **YES** | unblocked by doc review              |
| Online / offline                 | ✅            | ✅                | ❌        | **YES** | unblocked by doc review              |
| Shift logs                       | ✅            | ✅                | ✅        | **YES** | stats beyond `totalOnlineMinutes`    |
| Heartbeat + timeout job          | ✅            | ✅                | ✅        | **YES** | sweep `heartbeatAt = null`           |
| Location + plausibility          | ✅            | ✅                | ✅        | **YES** | add eligibility gate                 |
| Geo indexing                     | ✅            | ✅                | ✅        | **YES** | none                                 |
| Nearby driver search             | ✅            | ❌                | ❌        | **YES** | caller + state filter                |
| Matching                         | ❌            | ❌                | ❌        | —       | **build**                            |
| Dispatch orchestration           | ❌            | ❌                | ❌        | —       | **build**                            |
| Offer creation (`offerToDriver`) | ✅            | ❌                | ❌        | **YES** | orchestrator                         |
| Offer timeout job                | ✅            | ✅                | ❌        | **YES** | re-offer logic                       |
| Push notification                | ❌            | ❌                | ❌        | —       | **build**                            |
| Ride acceptance                  | ✅            | ✅                | ⚠️        | **YES** | offer + vehicle + active-ride checks |
| Concurrent ride prevention       | ❌            | ❌                | ❌        | —       | **call existing query + index**      |
| Vehicle validation               | ❌            | ❌                | ❌        | —       | **build vehicles module**            |
| **Payment settlement (ledger)**  | ✅            | ✅                | ✅        | **YES** | **none — already wired**             |
| Settlement job                   | ✅            | ❌                | ❌        | **YES** | **schedule it (2 lines)**            |
| Driver earnings → wallet         | ❌            | ❌                | ❌        | —       | **projection**                       |
| Wallet read API                  | ✅            | ✅                | ⚠️        | **YES** | needs data                           |

---

## 23. Disconnected Existing Capabilities

**Fourteen complete capabilities with no caller.** This is the highest-leverage list in the report.

| #   | Capability                                                            | Location                            | Unblocks                                 |
| --- | --------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| 1   | `AuthService.grantRole`                                               | `auth/services/auth.service.ts:256` | Driver role, and the `/rides/active` bug |
| 2   | `DriverDocumentRepository.updateVerificationStatus` (`VERIFIED` path) | `drivers/repositories/`             | The entire lifecycle                     |
| 3   | `driverConfig.requireApprovedDocuments` (default `true`)              | `config/driver/`                    | Approval gate                            |
| 4   | Files `DRIVER_DOCUMENT` purpose + `registerFileReference`             | `files/`                            | Secure documents                         |
| 5   | `GeoService.findNearbyDrivers`                                        | `geo/services/`                     | Discovery                                |
| 6   | `DispatchService.offerToDriver`                                       | `rides/services/dispatch/`          | Offers                                   |
| 7   | `RideDispatchRepository.findByRequestAndDriver` / `updateResponse`    | `rides/repositories/`               | Offer validation                         |
| 8   | `RideRepository.findActiveByDriver`                                   | `rides/repositories/`               | One-active-ride guard                    |
| 9   | **`SettlementJob`**                                                   | `payments/jobs/`                    | Driver settlements                       |
| 10  | `UserDevice.fcmToken`                                                 | `auth/`                             | Push delivery                            |
| 11  | `driverConfig.maxContinuousShiftHours`                                | `config/driver/`                    | Shift limits                             |
| 12  | `PermissionRepository.findAllowedCodesForUser`                        | `auth/repositories/`                | Permission-based authz                   |
| 13  | `ShiftService`, `DriverBankRepository`                                | `drivers/`                          | Shifts API, payouts                      |
| 14  | `DriverMetrics.heartbeatTimeout`                                      | `drivers/metrics/`                  | Observability                            |

---

## 24. P0 / P1 / P2 Blockers

### P0 — lifecycle impossible / security / money / data integrity

| ID        | Blocker                                                                   | Owner          | Evidence                                                                               | Workflow step | Minimal fix                                                                | Reuse |
| --------- | ------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------- | ----- |
| **P0-1**  | No production writer of `DriverDocument.verificationStatus = VERIFIED`    | Drivers        | Only `upsertDocument` (`PENDING`) and `DocExpirationJob` (`REJECTED`)                  | #7            | Service method + admin route over the existing repository method           | ✅    |
| **P0-2**  | `grantRole` has zero production callers                                   | Drivers→Auth   | 1 ref in `src/` = definition                                                           | #10           | One call, or a `driver.verified` subscriber                                | ✅    |
| **P0-3**  | Driver approvable with zero / `PENDING` / `REJECTED` documents            | Drivers        | `reviewDriverVerification` never queries documents                                     | #9            | Wire `requireApprovedDocuments` + declare required set                     | ✅    |
| **P0-4**  | Documents accept arbitrary client URLs                                    | Drivers→Files  | `fileUrl: z.string().url()`                                                            | #6            | `fileId` + Files ownership/purpose check (**schema change**)               | ✅    |
| **P0-5**  | `POST /drivers/:id/suspend` self-deadlocks                                | Drivers        | `setSuspended` holds `FOR UPDATE`, calls `setOffline` which opens a second transaction | #—            | Pass `tx` into `setOffline`                                                | —     |
| **P0-6**  | One driver can hold unlimited concurrent rides                            | Rides          | No service check **and no index on `rides(driver_id)`**                                | #21           | Call `findActiveByDriver` in the accept transaction + partial unique index | ✅    |
| **P0-7**  | `vehicleId` unvalidated at acceptance                                     | Rides/Vehicles | Passed straight to `rideRepo.create`                                                   | #20           | Validate existence/assignment/active/type                                  | —     |
| **P0-8**  | Dispatch does not exist                                                   | Dispatch       | `export {};`; `ride.requested` zero subscribers                                        | #15–18        | Orchestrator over existing primitives                                      | ✅    |
| **P0-9**  | **`SettlementJob` never scheduled → driver settlements never calculated** | Payments       | Absent from `JOB_SCHEDULES` and `MAINTENANCE_HANDLERS`                                 | #27           | Two lines: add to both maps                                                | ✅    |
| **P0-10** | **`DriverWallet` never updated → balance permanently zero**               | Payments       | Only write is `driverWallet.create`                                                    | #28           | Project `DRIVER_PAYABLE` into the wallet, or read the ledger               | ✅    |

### P1 — major production defects

`GET /rides/active` + `/history` serve customer data to drivers (fixed by P0-2) · unverified/suspended/offline drivers enter the geo index · `findNearbyDrivers` has no driver-state filter · licence expiry unchecked at go-online · racy document upsert (**no unique index on `(driver_id, document_type)`**) · stale `verifiedBy`/`verifiedAt` survive re-upload · `REJECTED` driver cannot re-enter review · driver email written via raw Prisma (500 not 409) · `POST /:id/suspend` body unvalidated · no admin review queue · **no push channel** · no Fastify schemas on driver routes · no location history · staff bypass unaudited · `BUSY`/`ON_TRIP` never written · driver aggregates + shift stats never written · `DEFAULT_USER_ROLE` unvalidated at boot · **revoked default role silently re-granted on next login** · `heartbeatAt = null` drivers never swept · `cancel` has no operability guard.

### P2 — architecture / maintainability / testing

`format:check` fails on 34 non-`src/` files (**blocks CI**) · `submitDocument` + `reviewDriverVerification` inside the onboarding service · 13 routes and 5 schemas in single files · `actingDriverId` duplicated in Rides · `rides` deep-imports Drivers and Payments internals · six UUID columns with no FK · no `EXPIRED` document status · `DriverVerificationStatus.SUSPENDED` dead · 4 of 8 driver events never published · dead code set (§7) · three authorization vocabularies · `super_admin` not seeded · stale `drivers/README.md`.

---

## 25. Test Coverage Gaps

`TEST VERIFIED` — 109 test files, 714 unit tests passing.

**Fixture shortcuts** — `tests/integration/helpers/fixtures.ts`:

```ts
export async function makeDriver(userId, { verified = true } = {}) {
  const driver = await db().client.driver.create({ data: {
    userId, verificationStatus: verified ? 'VERIFIED' : 'PENDING', … }});
  if (verified) {
    await db().client.driverDocument.create({ data: {        // ← hides P0-1
      documentType: 'DRIVING_LICENSE',
      verificationStatus: 'VERIFIED',                        // ← no production code can write this
      fileUrl: 'https://example.invalid/licence.jpg',        // ← no production code validates this
    }});
  }
}
export async function grantRole(userId, slug) {              // ← bypasses AuthService.grantRole
  await db().client.userRoleAssignment.create({ … });        // ← hides P0-2
}
```

Direct inserts confirmed for: **VERIFIED drivers, VERIFIED documents, DRIVER role, active rides, geo positions, vehicles, vehicle types**.

**Lifecycle coverage:**

| Step                                            | Coverage                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| OTP send / verify / user / customer role        | **REAL END-TO-END**                                                                                                                          |
| Onboard, profile, document submission           | **NO COVERAGE** — no test calls any of these routes                                                                                          |
| Document → VERIFIED                             | **FIXTURE SHORTCUT ONLY**                                                                                                                    |
| Driver approval                                 | **NO COVERAGE**                                                                                                                              |
| Role assignment                                 | **FIXTURE SHORTCUT ONLY**                                                                                                                    |
| Online, location route, dispatch, offer, accept | **NO COVERAGE**                                                                                                                              |
| Ride state machine, ride OTP, concurrency       | **REAL (unit)**                                                                                                                              |
| Earnings pipeline                               | **SERVICE-LEVEL** — `earnings-pipeline.test.ts` resolves `SettlementService` directly, proving ledger grouping **but not that the job runs** |

> **First missing integration boundary: `POST /drivers/me/onboard`.** Everything from onboarding onward has zero HTTP coverage. That is why an unfinished onboarding rewrite sat in the tree without a single failing test.

**Zero tests exercise any route in `driver.routes.ts`** except two auth/BOLA probes.

---

## 26. Exact Current Production Readiness

| Layer                                                  | Readiness                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| Auth / OTP / Users                                     | **PRODUCTION READY**                                          |
| Files                                                  | **PRODUCTION READY** (unused by Drivers)                      |
| Geo                                                    | **PRODUCTION READY** (discovery unwired)                      |
| Payments ledger                                        | **PRODUCTION READY** (settlement + wallet projection missing) |
| Rides lifecycle                                        | **NEAR READY** (offer/vehicle/concurrency gaps)               |
| Drivers                                                | **NOT READY** — stops at document review                      |
| Vehicles / Matching / Dispatch / Notifications / Admin | **NOT BUILT**                                                 |

**A real driver today can:** log in, onboard, complete a profile, and submit documents. **Then it stops permanently.**

---

## 27. Recommended Implementation Order

Derived from the evidence, not assumed.

**Stage 0 — unblock CI (minutes).** Resolve `format:check` (34 files, all outside `src/`) — either `npm run format` or extend `.prettierignore`. It is CI's first gate; nothing else merges until it passes.

**Stage 1 — close the driver funnel** (P0-1 → P0-3 → P0-2). Document review service + admin route; document-completeness gate via the existing `requireApprovedDocuments` flag; `grantRole` on approval. **This is the smallest change set that lets a real driver go ONLINE for the first time**, and it fixes the `/rides/active` bug for free. Decide the role mechanism (§11.1) before starting.

**Stage 2 — two-line money fix** (P0-9). Add `SettlementJob` to `JOB_SCHEDULES` and `MAINTENANCE_HANDLERS`. Then decide P0-10: project the ledger into `DriverWallet`, or make the wallet API read `DRIVER_PAYABLE` directly. **Cheapest high-value fix in the report.**

**Stage 3 — secure documents** (P0-4). `fileId` + Files ownership/purpose check + `registerFileReference` + the missing unique index. Requires a schema change.

**Stage 4 — operational correctness.** P0-5 (suspend deadlock), eligibility gate on location, licence expiry, body validation, `heartbeatAt = null` sweep, the revoked-default-role re-grant.

**Stage 5 — ride integrity** (P0-6, P0-7). One-active-ride guard, vehicle validation, `BUSY`/`ON_TRIP` writes.

**Stage 6 — vehicles.** Registration, documents, assignment, approval. Gate at acceptance per §12.1.

**Stage 7 — notifications.** Push/FCM. **Decide this before Stage 8** — dispatch without a delivery channel is inert, which is likely why it was never wired.

**Stage 8 — matching + dispatch** (P0-8). Largest and last; depends on eligible, online, filterable drivers and a delivery channel.

**Cross-cutting from Stage 1 onward:** add HTTP tests for the driver routes, and one full-lifecycle integration test with **zero direct database writes**. That test is the definition of done.

---

## 28. Final Answers

**1. Is Auth working and reusable for Driver?**
**YES.** Deny-by-default, fail-closed, refresh rotation with reuse detection, session caps, epoch invalidation. Driver uses it unchanged. `CODE VERIFIED`

**2. Is OTP working and reusable for Driver?**
**YES.** One `OtpService`, single `LOGIN` purpose, challenge binding, multi-axis rate limits, lockout, BullMQ delivery, verified redaction. **The Driver App calls the same two endpoints as Customer.** No duplicate service exists or is needed.

**3. Is User working correctly with Driver onboarding?**
**YES, with one defect.** `Driver` is a 1:1 optional extension of `User`. Email is now updatable (`eb3e062`). **But the driver path still writes `users.email` via raw Prisma**, bypassing `UserRepository.updateEmail` — 500 instead of 409 on collision.

**4. Is Files already capable of securely supporting Driver documents?**
**YES — completely, and it is entirely unused.** `DRIVER_DOCUMENT` purpose (10 MB, magic-byte validation, EXIF-location rejection, 300 s read TTL, 8-year ARCHIVE on `DRIVER_RELATIONSHIP_ENDED`), `decideRead` with a `drivers:verify` operator scope, `registerFileReference`. **Drivers does not import `@modules/files` at all.**

**5. Is Driver onboarding currently production reachable?**
**YES.** `POST /drivers/me/onboard` → `onboardDriver` — explicit, idempotent, `P2002`-safe, transactional. Landed today in `b7f7da7`; the previous HEAD created a Driver row from `GET /drivers/me`.

**6. Can documents currently be submitted securely?**
**NO.** Submission works; security does not. `fileUrl: z.string().url()` accepts any URL — no ownership, purpose, existence, or content check.

**7. Can an admin verify individual documents today?**
**NO.** No route, no service method, no job, no subscriber writes `VERIFIED`. The only `VERIFIED` write in the repository is `tests/integration/helpers/fixtures.ts`. **⛔ First blocker.**

**8. Can required documents be validated before driver approval?**
**NO.** No required set is declared anywhere, and `reviewDriverVerification` never queries `driver_documents`. `requireApprovedDocuments` exists, defaults to `true`, and has **zero consumers**.

**9. Is the DRIVER role automatically granted after approval?**
**NO.** `grantRole` has 1 reference in `src/` — its own definition. `driver.verified` is published to a bus whose only subscriber handles four auth events.

**10. Can a fully legitimate new driver currently go ONLINE?**
**NO.** They pass `requireOperableDriver` and are rejected by `setOnline`'s requirement for a `VERIFIED` `DRIVING_LICENSE` — a status no production code can write.

**11. Can an online driver currently enter the Geo index?**
**YES — and so can everyone else.** `POST /drivers/location` has no eligibility gate; `PENDING`, `DOCUMENT_REVIEW`, suspended, and offline drivers all enter.

**12. Can Matching currently discover the driver?**
**NO.** `matching/` is `export {};`. `findNearbyDrivers` has 3 references in `src/`, all inside the geo module's own delegation chain.

**13. Can Dispatch currently send a real offer to the driver?**
**NO.** `dispatch/` is `export {};`. `offerToDriver` has 1 reference = its definition. No `RideDispatch` row is ever created.

**14. Can Notifications deliver the offer?**
**NO.** SMS only. `NotificationService` has exactly `sendSms` and `sendOtp`. FCM tokens are stored on `UserDevice` and **never read**. No FCM SDK, no APNs, no WebSocket.

**15. Can a driver accept only one active ride?**
**NO.** No service check (`findActiveByDriver` = 1 ref, its definition) **and no database constraint** — the only relevant uniques are `rides(request_id)` and `ride_dispatches(request_id, driver_id)`. Two different requests both succeed.

**16. Is the vehicle correctly validated before ride acceptance?**
**NO.** `vehicleId` is client-supplied and validated for nothing — not existence, assignment, active status, type compatibility, or documents. A driver can accept in another driver's vehicle, or a premium request in a hatchback.

**17. Can the driver complete a real ride?**
**Mechanically yes, practically no.** Accept→arrive→start→complete is well built (row locks, CAS, transition table, start-OTP). But no driver can reach it — they cannot go online, and no offer ever arrives.

**18. Does a completed ride currently reach Payments?**
**YES.** `LifecycleService.completeRide` calls `ledgerService.recordTripPayment(...)` **inside the same transaction**, with correct cash/prepaid branches and double-entry postings. **This is the strongest positive finding of the audit.**

**19. Does Payments currently create Driver earnings/wallet data?**
**Earnings YES, wallet NO.** `DRIVER_PAYABLE` ledger entries are written correctly. But `SettlementJob` is **never scheduled** (absent from both job maps), and **`DriverWallet` is only ever created, never updated** — the driver's wallet reads zero forever.

**20. Which parts are ALREADY BUILT and only need CONNECTION?**
Fourteen, listed in §23. The highest-value: `grantRole`, `updateVerificationStatus` (`VERIFIED` path), `requireApprovedDocuments`, Files' `DRIVER_DOCUMENT` purpose, `findNearbyDrivers`, `offerToDriver`, `findActiveByDriver`, **`SettlementJob`**, and `fcmToken`.

**21. Which parts are genuinely MISSING?**
Document review service/route · required-document declaration · matching · dispatch orchestration · push notifications · vehicles module · `BUSY`/`ON_TRIP` writers · wallet balance projection · admin review queue · location history · driver aggregates and shift stats · `AuditLog` model · `EXPIRED` document status.

**22. Which code currently belongs in the wrong module?**
**None at module level** — zero files should move out of `drivers/`. Internally: `submitDocument` and `reviewDriverVerification` sit inside the _onboarding_ service and belong in `documents/` and `verification/` submodules. Cross-module hygiene: `rides` deep-imports Drivers and Payments internals; `RideStateController` duplicates `actingDriverId`.

**23. What is the FIRST implementation step after this investigation?**
**Resolve `format:check`** (34 non-`src/` files) so CI can pass — minutes. Then **the document review service + admin route** (P0-1): one service method over the existing `updateVerificationStatus`, one route guarded by `roles:['admin']`. That is the first blocker in the lifecycle and everything downstream waits on it.

**24. What should NOT be rebuilt?**
OTP · Auth (sessions, tokens, refresh rotation, epoch) · `grantRole`/`revokeRole` · `User` identity and `users.email` · the entire Files module including `DRIVER_DOCUMENT` · the Geo stack · outbox/relay/EventBus · job scheduler + `LockStore` · `TransactionManager` and the `lockForUpdate` pattern · the Rides state machine · **the Payments ledger and `recordTripPayment`** · `claimForMatch` + `rides_request_id_key` · backend-controlled roles · `route-graph.test.ts` · the Prisma schema.

**25. Is the platform ready for `/speckit.specify` after this investigation?**
**YES, with one caveat and one decision.**
The baseline is now healthy — typecheck, lint, build, and 714 unit tests all pass, and the working tree is clean and committed. The ownership question is settled, the gaps are enumerated with evidence, and the reuse boundary is explicit.
**Caveat:** `format:check` fails, so CI cannot go green until it is resolved.
**Decision:** the role-assignment mechanism (§11.1) determines whether a `consumers/` folder exists and what the Driver App must tolerate. The spec cannot leave it open.
Resolve both, and the platform is ready to specify.

---

FULL PLATFORM WORKFLOW INVESTIGATION COMPLETE — NO CODE CHANGES MADE.
