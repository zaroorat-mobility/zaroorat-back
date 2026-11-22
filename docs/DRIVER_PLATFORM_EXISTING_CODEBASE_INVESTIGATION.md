# Driver Platform — Existing Codebase Investigation

**Repository:** `backend_zaroorat`
**Date:** 2026-08-18
**Phase:** Investigation and verification only. No production code was written, modified, or deleted. No migrations were created.

**Evidence labels used throughout:**

| Label               | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `CODEBASE VERIFIED` | Read directly from committed TypeScript source in `src/`                    |
| `TEST VERIFIED`     | Read directly from committed tests in `tests/`, or observed from a test run |
| `SCHEMA VERIFIED`   | Read directly from `prisma/schema/**` or `prisma/migrations/**`             |
| `INFERENCE`         | A conclusion drawn from the above, not a literal reading                    |

**Method.** Every module under `src/modules/` was enumerated and sized. Every file under `src/modules/drivers/**` was read in full. Repository-wide caller searches were run for all symbols listed in §12, with `src/generated/**` (Prisma client output) excluded so that generated type declarations were never mistaken for production callers. `npx tsc --noEmit` and `npm run test:unit` were executed.

---

## 1. Executive Summary

The Driver module is **not production-ready**, but the reason is narrower and more specific than "it is unbuilt". A large amount of the driver surface is genuinely implemented, correctly transactional, and wired to live HTTP routes. What is missing is a small number of **lifecycle transitions in the middle of the funnel** — and their absence severs the chain, so nothing downstream of them can ever be reached by a real client.

**The seven findings that matter:**

1. **The repository does not compile.** `npx tsc --noEmit` reports exactly one error, and it is in the Driver module: `DriverNotFoundError` is used but never imported in `driver-onboarding.controller.ts:18`. `npm run build` therefore fails, and `GET /api/v1/drivers/me` — the onboarding-resume endpoint — cannot ship. `CODEBASE VERIFIED`
2. **No production API can mark a driver document VERIFIED.** The only two writers of `DriverDocument.verificationStatus` in the whole repository are the driver's own submission (writes `PENDING`) and the nightly expiry job (writes `REJECTED`). There is no admin route, no service method with a caller, and no event subscriber that writes `VERIFIED`. `CODEBASE VERIFIED`
3. **`AuthService.grantRole` has zero production callers.** It is fully implemented, transactional, and bumps the security epoch — and nothing in `src/` calls it. Its 28 references are all in `tests/`. The `driver` role is therefore never granted by the backend to anyone. `CODEBASE VERIFIED`
4. **A driver can be approved with zero documents.** `POST /api/v1/drivers/:id/verify` writes `verificationStatus = VERIFIED` without reading the documents table at all. `CODEBASE VERIFIED`
5. **Driver documents bypass the Files module entirely.** `submitDocument` accepts `fileUrl: z.string().url()` — any URL the client types. The Files module already defines a complete `DRIVER_DOCUMENT` purpose policy with an `drivers:verify` operator read scope, and none of it is used. `CODEBASE VERIFIED`
6. **`POST /api/v1/drivers/:id/suspend` self-deadlocks.** `StatusService.setSuspended` takes a `SELECT … FOR UPDATE` on the driver row, then calls `setOffline`, which opens a _second_ transaction on a different pooled connection and locks the same row. `CODEBASE VERIFIED`
7. **Dispatch does not exist as a running system.** `src/modules/dispatch/` and `src/modules/matching/` are `export {};`. `GeoService.findNearbyDrivers` and `DispatchService.offerToDriver` are both fully implemented with zero production callers. `DriverStatus.BUSY` and `ON_TRIP` are never written by any code path. `CODEBASE VERIFIED`

**The first blocking transition** in the desired end-to-end lifecycle is **document review → document VERIFIED**. Everything before it works today through real HTTP calls. Nothing after it can be reached without direct database manipulation.

**What is genuinely good and must not be rebuilt:** Auth, OTP, Users, Files, Geo, and the events/outbox/jobs infrastructure are production-grade, tested, and already shaped to accept the driver flow. The driver module's own status/location/shift services are correctly written — they are simply gated behind a transition that has no writer.

---

## 2. Exact Current End-to-End Driver Flow

This is what a real device can actually do today against the running server, with no database access. `CODEBASE VERIFIED` throughout.

```
Driver App
  │
  ├─ POST /api/v1/auth/otp/send      { phoneNumber, device? }
  │    → OtpService.send: Redis challenge claim, cooldown + per-phone/device/IP
  │      rate limits, hashed OTP stored in Redis, audit row in otp_verifications,
  │      BullMQ job enqueued for SMS delivery.
  │    ✅ WORKS
  │
  ├─ POST /api/v1/auth/otp/verify    { phoneNumber, code, challengeId, device? }
  │    → OtpService.verify (challenge binding + lockout)
  │    → AuthService.resolveAccount: finds or creates User, marks phone verified,
  │      status ACTIVE, ensureDefaultRole → grants 'customer'
  │    → UserProfile ensured, device registered, session created,
  │      JWT pair issued with roles = ['customer'], epoch stamped
  │    ✅ WORKS
  │
  ├─ GET  /api/v1/drivers/me
  │    ❌ DOES NOT COMPILE — DriverNotFoundError unimported.
  │       Also 404s for any user without a Driver row, so it cannot be used
  │       as an "am I onboarded?" probe even once fixed.
  │
  ├─ POST /api/v1/drivers/me/onboard   (no body)
  │    → OnboardingService.onboardDriver(callerId)
  │      idempotent read-then-create, P2002 race re-read, driverCode generated,
  │      driver.onboarded published to outbox inside the transaction
  │    ✅ WORKS — Driver row created, verificationStatus = PENDING
  │
  ├─ PATCH /api/v1/drivers/:driverId/profile
  │      { fullLegalName, gender, email, dateOfBirth, city, … }
  │    → :driverId is IGNORED; actingDriverId(req) is used instead
  │    → DriverProfile upserted; email written to User.email
  │    ✅ WORKS — name / gender / email persist
  │
  ├─ POST /api/v1/drivers/:driverId/documents
  │      { documentType, fileUrl, documentNumber?, expiresAt? }
  │    → :driverId IGNORED, actingDriverId used
  │    → DriverDocument upserted with verificationStatus = PENDING
  │    → Driver PENDING → DOCUMENT_REVIEW
  │    ⚠️  WORKS, but fileUrl is an arbitrary client-supplied URL string.
  │       No Files module involvement. No ownership proof. No scanning.
  │
  ├─ ──────── DOCUMENT REVIEW ────────
  │    ❌ NO PRODUCTION API EXISTS.
  │       DriverDocumentRepository.updateVerificationStatus is only ever
  │       called by DocExpirationJob, which writes REJECTED.
  │       ⛔ FIRST BLOCKING TRANSITION
  │
  ├─ POST /api/v1/drivers/:id/verify   { status: 'VERIFIED' | 'REJECTED', rejectionReason? }
  │      preHandler: authorize({ roles: ['admin'] })
  │    → Driver row locked FOR UPDATE, verificationStatus written,
  │      approvedAt/approvedBy set, driver.verified published
  │    ⚠️  REACHABLE by an admin, but:
  │       • does not read the documents table — approves with zero documents
  │       • does not grant the 'driver' role
  │       • does not bump the security epoch
  │
  ├─ ──────── DRIVER ROLE ASSIGNMENT ────────
  │    ❌ NEVER HAPPENS. grantRole has no production caller.
  │       driver.verified has no event subscriber.
  │       ⛔ SECOND BLOCKING TRANSITION
  │
  ├─ POST /api/v1/drivers/status/online
  │      preHandler: authorize({ requireOperableDriver: true })
  │    → gate passes (it checks the Driver row, not the JWT role)
  │    → StatusService.setOnline requires a DRIVING_LICENSE document with
  │      verificationStatus === 'VERIFIED'
  │    ❌ ALWAYS THROWS DriverNotVerifiedError — no API can set that status
  │       ⛔ THIRD BLOCKING TRANSITION
  │
  ├─ POST /api/v1/drivers/location
  │    ⚠️  WORKS WITHOUT ANY OF THE ABOVE. No operability gate on this route.
  │       A PENDING, unapproved, unverified driver's position is written to
  │       driver_locations AND pushed into the Redis live geo store.
  │
  └─ ──────── DISPATCH DISCOVERY ────────
       ❌ NOT REACHABLE. findNearbyDrivers has no production caller.
          Ride creation publishes ride.requested and stops.
```

**Net result:** the funnel is walkable from OTP through document submission. It is impassable from document review onward.

---

## 3. Module Inventory

Every directory under `src/modules/`. Classification per the A–E scheme in the brief. `CODEBASE VERIFIED`

| Module          | Files | Classification                           | Notes                                                                                                                                                                                         |
| --------------- | ----: | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`          |    54 | **A — Implemented and wired**            | Routes at `/api/v1/auth`. OTP, sessions, devices, refresh rotation, epoch invalidation. `grantRole`/`revokeRole` are implemented but have no production caller (see §12).                     |
| `users`         |    41 | **A — Implemented and wired**            | Routes at `/api/v1/users`. Profile, email, phone change, saved places, emergency contacts, erasure job.                                                                                       |
| `files`         |    47 | **A — Implemented and wired**            | Routes at `/api/v1/files`. Presigned upload, magic-byte + EXIF validation, purpose policies, retention/sweeper/reconciliation jobs. `DRIVER_DOCUMENT` purpose is defined but has no consumer. |
| `payments`      |    55 | **A — Implemented and wired**            | Routes at `/api/v1/payments`. Ledger, intents, refunds, payouts, webhooks, reconciliation job.                                                                                                |
| `rides`         |    56 | **C — Partially implemented**            | Routes at `/api/v1/rides`. Request/accept/arrive/start/complete/cancel all work. The dispatch half is unreachable — see §18.                                                                  |
| `drivers`       |    54 | **C — Partially implemented**            | Routes at `/api/v1/drivers`. Detailed breakdown in §4.                                                                                                                                        |
| `geo`           |    24 | **B — Implemented but partly unwired**   | No routes. Position recording _is_ wired from the driver module. `findNearbyDrivers` is not. See §19.                                                                                         |
| `notifications` |     7 | **A — Implemented and wired (SMS only)** | Consumed by `OtpService` and `OtpDeliveryJob`. SMS via MSG91 or a mock. No push, no realtime.                                                                                                 |
| `admin`         |     2 | **D — Stub**                             | `export {};` + README.                                                                                                                                                                        |
| `support`       |     2 | **D — Stub**                             | `export {};` + README.                                                                                                                                                                        |
| `vehicles`      |     2 | **D — Stub**                             | `export {};` + README. Full schema exists — see §16.                                                                                                                                          |
| `dispatch`      |     2 | **D — Stub**                             | `export {};` + README.                                                                                                                                                                        |
| `matching`      |     2 | **D — Stub**                             | `export {};` + README.                                                                                                                                                                        |
| `onboarding`    |     2 | **D — Stub**                             | `export {};` + README. Driver onboarding lives in `drivers/services/onboarding/`, not here.                                                                                                   |
| `documents`     |     2 | **D — Stub**                             | `export {};` + README. Driver documents live in `drivers/repositories/`, not here.                                                                                                            |
| `analytics`     |     2 | **D — Stub**                             | `export {};` + README.                                                                                                                                                                        |
| `chat`          |     2 | **D — Stub**                             | `export {};` + README.                                                                                                                                                                        |
| `settings`      |     2 | **D — Stub**                             | `export {};` + README.                                                                                                                                                                        |
| `sos`           |     2 | **D — Stub**                             | `export {};` + README. `SOS_EVIDENCE` file purpose exists with no consumer.                                                                                                                   |
| `reviews`       |     2 | **D — Stub**                             | `export {};` + README.                                                                                                                                                                        |
| `promotions`    |     2 | **D — Stub**                             | `export {};` + README.                                                                                                                                                                        |
| `pricing`       |     2 | **D — Stub**                             | `export {};` + README. Fare logic lives in `rides/services/fare/`.                                                                                                                            |
| `riders`        |     2 | **D — Stub**                             | `export {};` + README. Customer flows live in `users` + `rides`.                                                                                                                              |

**Registered route surface** — the complete production HTTP surface, from `src/routes/register.ts`. `CODEBASE VERIFIED`

```
/health, /ready, /metrics  (+ /api/v1 prefixed health & ready)
/api/v1/auth       → registerAuthRoutes
/api/v1/users      → registerUserRoutes
/api/v1/files      → registerFileRoutes
/api/v1/rides      → rideRoutes
/api/v1/drivers    → driverRoutes
/api/v1/payments   → paymentRoutes
```

There is **no** `/api/v1/admin`, `/api/v1/support`, `/api/v1/vehicles`, `/api/v1/geo`, or `/api/v1/notifications`. `CODEBASE VERIFIED`

---

## 4. Empty / Stub / Unwired Folder Inventory

### 4.1 Driver module — per-folder classification

Every folder under `src/modules/drivers/`. `CODEBASE VERIFIED`

| Folder / file                                 | Class                        | Evidence                                                                                                                                                                                                           |
| --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts` (DI registration)                  | **A**                        | Called from `src/core/di.ts`; registers 20 tokens.                                                                                                                                                                 |
| `routes/driver.routes.ts`                     | **A**                        | Registered at `/api/v1/drivers` in `src/routes/register.ts`.                                                                                                                                                       |
| `plugins/driver.plugin.ts`                    | **E — Dead**                 | Wraps `driverRoutes` with a prefix, but `registerRoutes` registers `driverRoutes` directly. Zero callers. (Same is true of `ridePlugin`, `filePlugin`, `paymentPlugin`, `userPlugin`.)                             |
| `controllers/driver.controller.ts`            | **A**                        | Resolved by `driver.routes.ts`.                                                                                                                                                                                    |
| `controllers/driver-onboarding.controller.ts` | **C**                        | 4 of 5 methods reachable. `getMe` **does not compile**.                                                                                                                                                            |
| `controllers/driver-status.controller.ts`     | **A**                        | All 4 methods routed.                                                                                                                                                                                              |
| `controllers/driver-location.controller.ts`   | **A**                        | Both methods routed.                                                                                                                                                                                               |
| `controllers/driver-wallet.controller.ts`     | **A**                        | Both methods routed.                                                                                                                                                                                               |
| `controllers/driver-identity.ts`              | **A**                        | `actingDriverId` used by 3 controllers + `RideStateController`; `authorizedDriverId` used by location + wallet controllers.                                                                                        |
| `services/onboarding/`                        | **C**                        | `onboardDriver`, `updateProfile`, `submitDocument`, `reviewDriverVerification` all reachable. No document-verification method exists at all.                                                                       |
| `services/status/`                            | **C**                        | `setOnline`/`setOffline`/`recordHeartbeat`/`setSuspended` all routed. `setOnline` is permanently unsatisfiable; `setSuspended` deadlocks.                                                                          |
| `services/location/`                          | **A**                        | Routed; wired into `GeoService.recordDriverPosition`.                                                                                                                                                              |
| `services/wallet/`                            | **A**                        | Routed. Read-only projection over `driver_wallets`.                                                                                                                                                                |
| `services/shift/`                             | **E — Dead**                 | `ShiftService.getActiveShift` has zero callers. Registered in DI and exposed as `driverService.shift`, and nothing reads it. Shifts _are_ managed — but directly via `DriverShiftRepository` from `StatusService`. |
| `repositories/driver.repository.ts`           | **A**                        | Used by services, controllers, jobs.                                                                                                                                                                               |
| `repositories/driver-document.repository.ts`  | **C**                        | `upsertDocument` + `findByDriverId` + `findExpiredDocuments` wired. `updateVerificationStatus` reachable **only** from `DocExpirationJob`.                                                                         |
| `repositories/driver-status.repository.ts`    | **A**                        | Used by `StatusService`, `LocationService`, `HeartbeatTimeoutJob`.                                                                                                                                                 |
| `repositories/driver-location.repository.ts`  | **A**                        | Used by `LocationService`. Raw PostGIS upsert.                                                                                                                                                                     |
| `repositories/driver-shift.repository.ts`     | **A**                        | Used by `StatusService` and `ShiftService`.                                                                                                                                                                        |
| `repositories/driver-wallet.repository.ts`    | **A**                        | Used by `DriverWalletViewService`.                                                                                                                                                                                 |
| `repositories/driver-bank.repository.ts`      | **B — Implemented, unwired** | Registered in DI. Zero callers anywhere in `src/`. No route, no service, no job touches bank accounts.                                                                                                             |
| `jobs/heartbeat-timeout.job.ts`               | **A**                        | Scheduled `* * * * *` on `drivers-maintenance`, resolved as `heartbeatTimeoutJob`.                                                                                                                                 |
| `jobs/doc-expiration.job.ts`                  | **A**                        | Scheduled `0 2 * * *`, resolved as `docExpirationJob`.                                                                                                                                                             |
| `schemas/driver.schemas.ts`                   | **A**                        | All five Zod schemas are parsed in controllers.                                                                                                                                                                    |
| `schemas/driver.responses.ts`                 | **E — Dead**                 | `DriverView` / `DriverShiftView` interfaces are exported and never referenced. Unlike auth/users/files, driver routes carry **no** Fastify `schema:` block — no OpenAPI docs, no response serialisation.           |
| `schemas/error-response.ts`                   | **A**                        | `setErrorHandler(handleDriverError)` in `driver.routes.ts`.                                                                                                                                                        |
| `events/catalog.ts`                           | **C**                        | 5 of 8 event types are published. `SHIFT_STARTED`, `SHIFT_ENDED`, `LOCATION_UPDATED` are declared and never published. **No subscriber exists for any driver event** — see §24.                                    |
| `errors/driver.errors.ts`                     | **C**                        | 6 of 8 error classes thrown. `InvalidDriverStatusTransitionError` and `DocumentValidationError` have zero throw sites.                                                                                             |
| `metrics/driver.metrics.ts`                   | **C**                        | 10 of 11 methods called. `heartbeatTimeout()` is never called — including by `HeartbeatTimeoutJob` itself.                                                                                                         |
| `constants/`, `types/`, `utils/`              | **A**                        | All referenced.                                                                                                                                                                                                    |
| `README.md`                                   | ⚠️ **Stale**                 | Claims "`npx tsc --noEmit`: 0 errors" and "550/550 tests passing". Actual: 1 type error, 714 unit tests.                                                                                                           |

### 4.2 Repository-wide empty scaffolding

Directories consisting entirely of one-line `export {};` files, carrying no logic. `CODEBASE VERIFIED`

- `src/common/` — `constants`, `decorators`, `exceptions`, `helpers`, `interfaces`, `types`, `utils`, `validators` (8 files)
- `src/infrastructure/` — `database`, `maps`, `notification`, `payment`, `queue`, `redis`, `storage` (7 files)
- `src/middleware/` — `auth.ts`, `idempotency.ts`, `role.ts` (3 files; the real implementations live in `src/modules/auth/plugins/` and `src/core/cache/stores/`)
- `src/plugins/socket/socket.plugin.ts`, `src/plugins/jwt/jwt.plugin.ts`
- `src/shared/` — `cache`, `events`, `pagination`, `response` index files
- `src/routes/index.ts`

**Do not delete these** (as instructed), but note that none of them is a partially built feature — they are all placeholder scaffolding, and none is imported anywhere.

---

## 5. Auth + OTP Integration

### 5.1 Authenticated identity

`CODEBASE VERIFIED` — `src/modules/auth/plugins/auth.plugin.ts`

The plugin installs an `onRequest` hook that **denies by default**: every route is authenticated unless it declares `config: { public: true }`. Verification does three things, and fails closed if the revocation store is unavailable:

1. `jwtService.verify(bearer)` → claims `{ sub, sid, roles, epoch }`
2. `claims.epoch !== await epochService.current(claims.sub)` → `401 TOKEN_STALE`
3. `redisService.sidBlacklist.isRevoked(claims.sid)` → `401 SESSION_REVOKED`

It then sets `request.auth = { userId, sid, roles }`. Downstream code reads identity only through `src/core/auth/caller.ts`: `callerId(request)`, `callerHasRole(request, …)`, `assertOwnerOrStaff`, `assertRideParty`.

`TEST VERIFIED` — `tests/integration/route-graph.test.ts` asserts the complete set of routes reachable without a token, and pins it to nine sanctioned entries (OTP send/verify, token refresh, payment webhook, health/ready ×2, metrics). Any new public route fails the test.

### 5.2 Role source, and whether the frontend can influence it

`CODEBASE VERIFIED`

Roles originate **only** from the `user_role_assignments` table, read via `RoleRepository.findActiveRoleSlugs(userId)` at two points: token issuance in `runVerifyOtp` (`auth.service.ts:135`) and token rotation in `refresh` → `resolveActiveRoles` (`auth.service.ts:415-420`). They are then embedded in the JWT and read back from claims.

The request schemas are the proof that the client cannot influence this. `verifyOtpSchema` (`auth.schemas.ts:23-28`) accepts exactly `phoneNumber`, `code`, `challengeId?`, `device?` — and `deviceSchema` accepts only `deviceId`, `platform`, `appVersion`, `osVersion`, `fingerprint`, `isRooted`, `isJailbroken`, `fcmToken`. **There is no `role`, `roles`, or `userType` field anywhere in the auth request surface.** `refreshSchema` accepts only `refreshToken`.

**Conclusion: role assignment is already backend-and-database controlled, exactly as the target design requires.** This property is correct today and must not be regressed. `CODEBASE VERIFIED`

### 5.3 Role vocabulary

`SCHEMA VERIFIED` — `prisma/seed/shared/roles.ts`

Seeded roles are `customer`, `driver`, `admin`, `support`, `finance`.

> **`super_admin` does not exist.** It is not seeded, not referenced in any guard, and not present in the schema. Any design that assumes it will need it created. `CODEBASE VERIFIED` / `SCHEMA VERIFIED`

The default role granted on first login is `DEFAULT_ROLE_SLUG = process.env.DEFAULT_USER_ROLE ?? 'customer'` (`auth.constants.ts:3`).

A permission vocabulary is seeded alongside (`drivers:verify`, `drivers:suspend`, `users:read`, `safety:read`, `support:read`, `rides:read_any`, `payouts:execute`, `refunds:process_any`) and mapped to roles — `admin` holds `drivers:verify` and `drivers:suspend`; `support` does **not**. However `app.authorize({ roles: [...] })` checks **role slugs, not permission codes**, and `PermissionRepository.findAllowedCodesForUser` has **zero callers in `src/`**. The permission table is a declared capability map, not a live enforcement path — and the seed file says so explicitly in its own comment. `CODEBASE VERIFIED`

The one place permission codes _are_ enforced is the Files module, which hardcodes its own copy of the role→scope mapping in `file-access.service.ts:36-39`.

### 5.4 `grantRole` — implementation and callers

`CODEBASE VERIFIED` — `auth.service.ts:256-294`

```ts
async grantRole(userId, roleSlug, { grantedBy?, expiresAt? } = {}): Promise<boolean>
```

The implementation is correct and complete: resolves the role by slug (throws if not seeded), checks for an existing active assignment inside a transaction and returns `false` if present (idempotent), inserts the assignment, publishes `account.role.granted` to the outbox in the same transaction, and **bumps the security epoch after commit** (`if (granted) await this.epochService.bump(userId)`).

**Callers:**

| Location                                                                                                      | Kind                        |
| ------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `src/modules/auth/services/auth.service.ts:256`                                                               | Definition                  |
| `tests/integration/auth-roles.test.ts` (×14)                                                                  | Test only                   |
| `tests/integration/auth-expiry.test.ts`, `auth-session-cap.test.ts`, `authorization-bola.test.ts`, and others | Test only                   |
| —                                                                                                             | **Zero production callers** |

`tests/integration/helpers/fixtures.ts:5` defines its own `grantRole` that writes `userRoleAssignment` directly with Prisma, bypassing the service entirely. That is the helper most driver tests use.

### 5.5 Security epoch and stale-token invalidation

`CODEBASE VERIFIED` — two independent paths, both correct:

1. **Direct:** `grantRole`/`revokeRole` call `epochService.bump(userId)` after commit.
2. **Event-driven:** `EpochInvalidationConsumer` (`auth/consumers/epoch-invalidation.consumer.ts`) subscribes to `account.role.granted`, `account.role.revoked`, `account.suspended`, `auth.refresh.reuse_detected` and bumps the epoch.

`authPlugin` compares `claims.epoch` to the live epoch on every request and returns `401 TOKEN_STALE` on mismatch. The client then calls `/auth/token/refresh`, which re-reads roles from the database via `resolveActiveRoles` and mints a token with the new claims.

**This machinery is complete and correct. It is simply never triggered for drivers, because nothing grants the driver role.** `INFERENCE` from the above.

### 5.6 OTP — shared infrastructure, purpose, and binding

`CODEBASE VERIFIED`

**One OTP system, no duplication.** `AuthService.sendOtp`/`verifyOtp` delegate to `OtpService` with a single hardcoded purpose: `AUTH_OTP_PURPOSE = 'LOGIN'` (`auth.constants.ts:1`). The Driver App calls exactly the same two endpoints as the Customer App. **No driver-specific OTP service exists, and none is needed.**

**Challenge binding** — `otp.service.ts:179-208`, `assertChallengeBelongsToCaller`: when a `challengeId` is supplied, the stored row must match on `phoneNumber` **and** `purpose` **and** be unconsumed (`verifiedAt === null`). A mismatch registers a failed attempt (feeding lockout) and throws `OtpInvalidError` — it does not leak which condition failed.

**Rate limiting and lockout:** Redis-backed cooldown and per-phone window at claim time, secondary per-device and per-IP axes, attempt-based lockout with an SMS notification on lock.

**Logging and redaction** — this was checked carefully because `otp.service.ts:106` does contain `logger.debug({ otp: code, phoneNumber, purpose }, '[OTP] generated')`. It is safe in production for **two independent reasons**:

1. `src/shared/logger/logger.ts:7` — `level: config.app.environment === 'development' ? 'debug' : 'info'`. The record is below threshold outside development and is never emitted.
2. `src/shared/logger/redact.ts` — `SENSITIVE_FIELDS` includes `otp`, `otpCode`, `verificationCode`, `phone`, `phoneNumber`, `mobiles`, `to`, `body`, `variables`, `token`, `authorization`, and `REDACT_PATHS` applies each both at the root and as `*.field`. Redaction is **disabled only in development** (`logger.ts:11-15`), by explicit filter.

`TEST VERIFIED` — `tests/unit/core/log-redaction.test.ts` covers this.

> **Verdict: no plaintext OTP reaches production logs.** `CODEBASE VERIFIED`

### 5.7 The exact production flow after a successful OTP verification

`CODEBASE VERIFIED` — `auth.service.ts:115-216`, one transaction:

1. `otpService.verify(...)` — throws before any write on failure
2. `resolveAccount(phoneNumber, tx)` — find active `User` by phone, or create one with `status: ACTIVE, isPhoneVerified: true`; a `P2002` phone collision is caught and re-read (`isPhoneAlreadyTakenError`)
3. `ensureDefaultRole(user.id, tx)` — grants `customer` if not already held
4. `assertAuthenticatable(user)` — rejects soft-deleted / `DEACTIVATED` / non-`ACTIVE`
5. `userProfileRepository.ensureExists` — creates `UserProfile`, publishes `user.profile.created` if newly created
6. `deviceService.register` — upserts `UserDevice` (this is where `fcmToken` lands)
7. `roleRepository.findActiveRoleSlugs(user.id)` — **the role read**
8. `sessionService.createInTransaction` — `UserSession`
9. `tokenService.issuePair({ userId, sessionId, roles })`
10. Publishes `auth.otp.verified`, `auth.login.succeeded`, `auth.session.created`, and `account.role.granted` when the account is new

After commit: `sessionService.enforceCap` (privileged roles get a higher cap). Response is `{ accessToken, refreshToken, …, user: { id, status, roles, isNew } }`.

`Idempotency-Key` on the request routes the whole thing through `redisService.idempotency.runOnce`, so a retried verify returns the original token pair rather than minting a second session.

**There is no driver-specific branch anywhere in this flow.** A driver and a customer are byte-for-byte identical at this point. `CODEBASE VERIFIED`

---

## 6. User Identity Integration

`CODEBASE VERIFIED` / `SCHEMA VERIFIED`

**When a User is created or resolved:** only inside `AuthService.resolveAccount`, during OTP verification. There is no other user-creation path in `src/`.

**Shared identity model:** `SCHEMA VERIFIED` — `prisma/schema/modules/user/user.prisma:24` declares `driver Driver?` on `User`, and `driver.prisma:5` declares `userId String @unique` on `Driver`. This is a **one-to-one optional extension**: a `User` may or may not have a `Driver` row, and the same `User` simultaneously holds the `customer` role and rides as a passenger. The development seed proves the intent — `prisma/seed/development/index.ts:47` seeds a user with `roles: ['customer', 'driver']` and a nested `driver` record.

**`User` remains the canonical identity.** Every authorization decision keys off `request.auth.userId`. `Driver.id` is derived from it on each request via `actingDriverId` → `driverRepository.findByUserId(callerId(req))`. `CODEBASE VERIFIED`

**Email ownership and update flow** — this is where the driver module diverges from the platform, and the divergence is a defect:

- **Canonical location:** `User.email`, declared `String? @unique` (`user.prisma:6`), with a separate `isEmailVerified Boolean @default(false)`. `DriverProfile` has **no** email column. `SCHEMA VERIFIED`
- **Platform path:** `PATCH /api/v1/users/me/profile` → `UserService.updateProfile` → `userRepository.updateEmail(userId, email, tx)`, inside the same transaction as the profile write, followed by a `user.profile.updated` event carrying **field names only**. `CODEBASE VERIFIED`
- **Driver path:** `DriverRepository.updateProfile` (`driver.repository.ts:73-82`) destructures `email` out of the profile payload and issues a **raw `client.user.update({ where: { id: userId }, data: { email } })`**, bypassing `UserRepository` entirely, publishing no event.

Three consequences follow, all `INFERENCE` from the code above:

1. A second user claiming an email already taken hits the `@unique` constraint. `handleDriverError` (`drivers/schemas/error-response.ts`) only special-cases `isCodedError(err) && err.statusCode < 500`; a raw Prisma `P2002` matches neither, so the caller receives **`500 INTERNAL`** rather than a `409`.
2. `isEmailVerified` is never touched. The address is stored unverified, indistinguishable from a verified one, with no verification flow behind it.
3. Two independent write paths to the same unique column mean the driver path will drift from whatever the users module does next.

---

## 7. Driver Onboarding

### 7.1 Is driver creation explicit?

**Yes — it is explicit, and this is already correct.** `CODEBASE VERIFIED`

`POST /api/v1/drivers/me/onboard` → `DriverOnboardingController.onboard` → `OnboardingService.onboardDriver(callerId(req))`, returning `201`. `GET /api/v1/drivers/me` performs a pure read (`driverRepository.findByUserId`) and throws `DriverNotFoundError` if absent — **it does not create**. Whatever historical create-on-GET behaviour this audit was asked to look for, it is not present in the committed code.

### 7.2 Onboarding endpoint behaviour, point by point

`CODEBASE VERIFIED` — `onboarding.service.ts:23-46`

```ts
async onboardDriver(userId: string): Promise<Driver> {
  const existing = await this.driverRepo.findByUserId(userId);
  if (existing) return existing;
  try {
    return await this.txManager.execute(async (tx) => {
      const created = await this.driverRepo.createDriver(userId, tx);
      this.driverMetrics.driverRegistered({ driverId: created.id, userId });
      await this.eventPublisher.publish(
        driverEvent(DRIVER_EVENT_CATALOG.ONBOARDED, created.id, { driverId: created.id, userId }), tx);
      return created;
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const raceConditionDriver = await this.driverRepo.findByUserId(userId);
      if (raceConditionDriver) return raceConditionDriver;
    }
    throw err;
  }
}
```

| Property                            | Finding                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Idempotency**                     | ✅ Read-then-create, plus `P2002` re-read. Repeat calls return the same row. Note it returns `201` every time, not `200` on the second call — cosmetic.            |
| **Concurrency**                     | ✅ Handled correctly. `Driver.userId` is `@unique` (`SCHEMA VERIFIED`), so a lost race raises `P2002` and the loser re-reads the winner's row.                     |
| **P2002 handling**                  | ✅ Explicit and correct. Note the `catch (err: any)` — an untyped catch that would be flagged by the repo's own lint rules elsewhere.                              |
| **BOLA / IDOR**                     | ✅ **Safe.** The user id comes from `callerId(req)` (JWT `sub`). The endpoint takes no body and no path parameter. **A client cannot pass an arbitrary `userId`.** |
| **Transaction boundary**            | ✅ Row creation and the outbox event are in one transaction.                                                                                                       |
| **Event emission**                  | ✅ `driver.onboarded` published — but see §24: **nothing subscribes to it.**                                                                                       |
| **Role gate**                       | ⚠️ **None.** Any authenticated user — i.e. every customer — can create a Driver row for themselves with one call.                                                  |
| **Vehicle / profile prerequisites** | None. A Driver row is created with no profile and no documents.                                                                                                    |

**On "can a customer accidentally create a Driver row":** yes, by design of the current route — there is no gate. This is not an IDOR (they can only create _their own_), and self-service driver signup is a reasonable product decision. But it means `Driver` row existence is not a meaningful signal of intent, and `GET /drivers/me` returning 404-vs-200 is the only thing distinguishing "never applied" from "applied". `INFERENCE`

### 7.3 Profile collection — name, gender, email

`CODEBASE VERIFIED` — `PATCH /api/v1/drivers/:driverId/profile`

**The `:driverId` path parameter is parsed by the router and then completely ignored.** `DriverOnboardingController.updateProfile` calls `actingDriverId(req, this.driverRepository)`, which resolves the driver from the JWT. This is **safe** — there is no IDOR — but the API signature actively lies about its own semantics: a caller passing another driver's id gets a `200` describing an edit to _their own_ profile. The same is true of `POST /:driverId/documents`.

Validation, from `updateDriverProfileSchema` (`driver.schemas.ts:3-16`):

| Field           | Validation                                          | Verdict                                                                                                                                             |
| --------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fullLegalName` | `z.string().min(2).max(100).optional()`             | ⚠️ Present but weak. Length only. No character-class or whitespace-only rejection — `" a"` passes.                                                  |
| `gender`        | `z.enum(['MALE','FEMALE','OTHER']).optional()`      | ✅ Correct at the API boundary. Note the column is a bare `String?` with no DB enum (`SCHEMA VERIFIED`), so the Zod schema is the only enforcement. |
| `email`         | `z.string().email().max(100).nullable().optional()` | ⚠️ Format is validated; **uniqueness collision surfaces as a 500** (§6); `isEmailVerified` never set.                                               |
| everything else | length-bounded optionals                            | ✅                                                                                                                                                  |

**Every field is `.optional()`.** There is no schema-level notion of a "complete" profile, and `updateProfile` does not check completeness before allowing the driver to move on. A driver can submit documents with a completely empty profile. `INFERENCE`

**Transaction boundary:** `updateProfile` opens a transaction that performs the `User.email` write and the `DriverProfile` upsert atomically. ✅ It publishes **no event** — unlike the users module, which publishes `user.profile.updated`.

---

## 8. Profile and Resume Flow

### 8.1 `GET /api/v1/drivers/me`

`CODEBASE VERIFIED` — `driver-onboarding.controller.ts:15-19`

```ts
async getMe(req, reply) {
  const driver = await this.driverRepository.findByUserId(callerId(req));
  if (!driver) throw new DriverNotFoundError(callerId(req));   // ← line 18
  reply.send({ data: driver });
}
```

**This file does not compile.** `DriverNotFoundError` is not among the file's imports (which are `callerId`, `DriverService`, `DriverRepository`, three schemas, and `actingDriverId`).

```
$ npx tsc --noEmit -p tsconfig.json
src/modules/drivers/controllers/driver-onboarding.controller.ts(18,28):
  error TS2304: Cannot find name 'DriverNotFoundError'.
```

That is the **only** type error in the entire repository. `npm run build` runs `tsc --project tsconfig.json` and therefore fails; `npm start` has nothing to start.

The unit and integration suites pass because `npm test` runs `tsx --test`, and `tsx` strips types without checking them. At runtime the identifier resolves to nothing and throws a `ReferenceError` — a `500`, not the intended `404`. `INFERENCE` from the two facts above.

`TEST VERIFIED` — `tests/integration/authorization-bola.test.ts:62` does exercise `/api/v1/drivers/me`, but only to assert that an unauthenticated caller is rejected. The rejection happens in the `onRequest` hook, before the handler body runs, so the broken line is never reached and the suite stays green.

### 8.2 Onboarding state — the four categories requested

The brief asked not to assume a database onboarding-state column is required, and to first check what already exists. Here is what exists.

**Explicit backend state:** `Driver.verificationStatus`, a `DriverVerificationStatus` enum with `PENDING | DOCUMENT_REVIEW | VERIFIED | REJECTED | SUSPENDED` (`SCHEMA VERIFIED`). Only three of the five are ever written by production code:

| Value             | Written by                                                                                                       | Evidence            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------- |
| `PENDING`         | `DriverRepository.createDriver` (default at row creation)                                                        | `CODEBASE VERIFIED` |
| `DOCUMENT_REVIEW` | `OnboardingService.submitDocument` (only when current status is exactly `PENDING`); `DocExpirationJob` on expiry | `CODEBASE VERIFIED` |
| `VERIFIED`        | `OnboardingService.reviewDriverVerification` via the admin route                                                 | `CODEBASE VERIFIED` |
| `REJECTED`        | Same admin route                                                                                                 | `CODEBASE VERIFIED` |
| `SUSPENDED`       | **Never.** Suspension uses the separate boolean `Driver.isSuspended`. The enum value is dead.                    | `CODEBASE VERIFIED` |

**Derived state — and this is the important finding.** `DriverRepository.findByUserId` uses `include: { profile: true, documents: true, onlineStatus: true }`. So a single call to `GET /drivers/me` returns everything needed to compute onboarding progress client-side:

| Question                         | Derivable from                                          |
| -------------------------------- | ------------------------------------------------------- |
| Has the driver applied?          | 404 vs 200                                              |
| Is the profile filled in?        | `profile === null`, or `profile.fullLegalName === null` |
| Which documents are submitted?   | `documents[].documentType`                              |
| Which are approved / rejected?   | `documents[].verificationStatus`, `rejectionReason`     |
| Is the application under review? | `verificationStatus === 'DOCUMENT_REVIEW'`              |
| Is the driver approved?          | `verificationStatus === 'VERIFIED'`, `approvedAt`       |
| Why was it rejected?             | `rejectionReason`                                       |
| Is the driver online?            | `onlineStatus.status`                                   |

> **Assessment: a dedicated onboarding-step column is not required.** The existing data is sufficient and is already returned in one round trip. What is missing is not a column — it is (a) the compile fix that makes the endpoint work at all, (b) a `200`-with-null response instead of a `404` so the app can distinguish "not applied" from "server error", and (c) a documented set of required document types so the client and server agree on what "complete" means. This is the single most important place _not_ to over-build. `INFERENCE`, from `CODEBASE VERIFIED` facts.

**Frontend-only state:** currently unavoidable. Because `GET /drivers/me` 404s before onboarding and does not compile after it, the app has no working server-side progress probe and must track its own step locally today. `INFERENCE`

**No reliable state:** "profile complete" — no server-side definition exists (all fields optional, no completeness check). "Documents complete" — no required-document set is declared anywhere in `src/`; `setOnline` implicitly requires exactly one type (`DRIVING_LICENSE`), and that is the only requirement encoded anywhere. `CODEBASE VERIFIED`

### 8.3 Resume after logout / app restart

`INFERENCE` from the above. The server keeps all the state needed. The refresh-token flow restores the session. The only thing standing between the current code and a working resume is the compile error plus the 404-vs-empty response shape. **No new persistence is needed.**

---

## 9. Documents

### 9.1 Supported and required types

`SCHEMA VERIFIED` — `DriverDocumentType` enum: `DRIVING_LICENSE`, `RC`, `INSURANCE`, `AADHAAR`, `PAN`, `PUC`, `POLICE_VERIFICATION`, `PROFILE_PHOTO`. Mirrored exactly in `driver.constants.ts` and in `submitDriverDocumentSchema`.

**Required set:** not declared anywhere. `CODEBASE VERIFIED`. The only document requirement encoded in production code is in `StatusService.setOnline`:

```ts
const hasValidLicense = docs.some(
  (d) => d.documentType === 'DRIVING_LICENSE' && d.verificationStatus === 'VERIFIED',
);
```

Note what this check does **not** do: it ignores `expiresAt` entirely at the moment of going online. Expiry is handled only by the nightly job, so a licence that expired since 02:00 UTC still passes the gate until the next run. `CODEBASE VERIFIED`

### 9.2 `fileId` vs `fileUrl` — and the Files module gap

`SCHEMA VERIFIED` — `DriverDocument.fileUrl String @map("file_url")`. A plain string. There is no `fileId`, and no foreign key to the `files` table.

`CODEBASE VERIFIED` — `submitDriverDocumentSchema`:

```ts
fileUrl: z.string().url(),
```

**The client sends a URL. Any URL.** There is no upload step, no `fileId`, no ownership check, no existence check, no content inspection, and no host allow-list. The consequences:

- A driver can submit `https://example.com/someone-elses-licence.jpg`, or a URL pointing at internal infrastructure that an admin reviewer's browser will then fetch.
- **The question "can a Driver reference another user's uploaded file?" is moot** — the driver never references a file record at all, so there is nothing to own and no ownership check to pass or fail. `INFERENCE`

**What already exists in Files and is going unused** — this is the reason not to build anything new here. `CODEBASE VERIFIED`:

| Capability                                                                                                                                                                                       | Where                                                   | Status                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `DRIVER_DOCUMENT` purpose policy — jpeg/png/webp/pdf, 10 MB cap, 5000×5000 px cap, `rejectExifLocation: true`, 300 s read TTL, 2920-day ARCHIVE retention on `DRIVER_RELATIONSHIP_ENDED`         | `src/config/file/file.config.ts:39-46`                  | **Defined, zero consumers**                                                                    |
| Presigned-PUT upload → `POST /files/:id/complete` verification (magic bytes vs declared content type, size, dimensions, checksum, EXIF-location rejection; refused objects deleted from storage) | `files/routes/file.routes.ts`, `file-upload.service.ts` | **Live**                                                                                       |
| Owner-or-operator read policy — `DRIVER_DOCUMENT` requires the `drivers:verify` scope, held by `admin` and deliberately **not** by `support`; operator reads are audited                         | `files/services/file-access.service.ts:28-39`           | **Live, and already anticipates driver-document review**                                       |
| `registerFileReference(purpose, check)` — lets a module declare "I still reference this file", making `DELETE /files/:id` return `409 FILE_IN_USE`                                               | `files/services/file-reference.service.ts`              | **Live.** Only `users` registers (`PROFILE_IMAGE`). **No module registers `DRIVER_DOCUMENT`.** |
| Retention, sweeper, reconciliation jobs                                                                                                                                                          | `files/jobs/*`                                          | **Live and scheduled**                                                                         |

> The Files module was clearly designed with driver documents in mind — the purpose, the retention trigger name, and the operator scope all say so. The driver module simply never connected to it. `INFERENCE`

**On "quarantine / trusted lifecycle":** files move through a scan state machine (migration `20260812150000_file_scan_state_machine`) and are not usable until `POST /:id/complete` commits them as `READY`. Because driver documents never enter the Files module, **driver documents get none of this.** `CODEBASE VERIFIED`

### 9.3 Submission, re-submission, and status reset

`CODEBASE VERIFIED` — `DriverDocumentRepository.upsertDocument`:

```ts
const existing = await client.driverDocument.findFirst({ where: { driverId, documentType } });
if (existing) return client.driverDocument.update({ where: { id: existing.id }, data: {
  fileUrl, documentNumber: … ?? null, issuedAt: … ?? null, expiresAt: … ?? null,
  verificationStatus: 'PENDING',           // ← reset on every re-upload
}});
return client.driverDocument.create({ … verificationStatus: 'PENDING' });
```

**Status reset on re-upload: ✅ correct.** Re-uploading a document returns it to `PENDING`, so an approved-then-swapped document cannot retain its approval.

Two defects in the same method:

1. **Stale review metadata survives the reset.** The update clears `verificationStatus` but leaves `verifiedBy`, `verifiedAt`, `verificationNotes`, and `rejectionReason` untouched. A re-uploaded document reads as `PENDING` while still carrying the previous reviewer's id and timestamp — misleading to any future reviewer and to any audit. `CODEBASE VERIFIED`
2. **`findFirst`-then-`create` is racy.** `SCHEMA VERIFIED` — `driver_documents` has plain indexes on `driver_id`, `document_type`, and `expires_at`, and **no unique constraint on `(driver_id, document_type)`** (confirmed in `prisma/migrations/20260724173304_init/migration.sql:2631-2637`). Two concurrent submissions of the same type both miss on `findFirst` and both `create`, leaving duplicate rows. `setOnline`'s `docs.some(...)` would then pass if _either_ copy were approved.

Driver status side effect (`onboarding.service.ts:69-77`): the driver moves `PENDING → DOCUMENT_REVIEW` **only** if currently exactly `PENDING`. A `REJECTED` driver who re-uploads stays `REJECTED` — their resubmission never re-enters the queue. `CODEBASE VERIFIED`

### 9.4 Writers of `DriverDocument.verificationStatus` — the central finding

Exhaustive search of `src/` excluding `src/generated/`. `CODEBASE VERIFIED`

| Status         | Production writer                                                                                          | Where                              |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `PENDING`      | `DriverDocumentRepository.upsertDocument`                                                                  | Driver's own submission            |
| `REJECTED`     | `DocExpirationJob` → `docRepo.updateVerificationStatus(doc.id, 'REJECTED', undefined, 'Document expired')` | `jobs/doc-expiration.job.ts:23-28` |
| **`VERIFIED`** | **NONE**                                                                                                   | —                                  |

`DriverDocumentRepository.updateVerificationStatus` is a complete, correct method — it sets `verifiedAt`, accepts `verifiedBy`, and records `rejectionReason` — with **exactly one caller in the entire repository**, and that caller only ever passes `'REJECTED'`.

Field-by-field:

| Field                         | Written in production?                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `verifiedBy`                  | ❌ Never — the only caller passes `undefined`                      |
| `verifiedAt`                  | ❌ Never — only set on the `VERIFIED` branch, which is unreachable |
| `rejectionReason`             | ⚠️ Only by the expiry job, always the literal `'Document expired'` |
| `verificationNotes`           | ❌ Never written by any code                                       |
| `ocrData`, `documentChecksum` | ❌ Never written by any code                                       |

**There is no `EXPIRED` status.** `SCHEMA VERIFIED` — `VerificationStatus` is `PENDING | VERIFIED | REJECTED`. The expiry job overloads `REJECTED`, which makes "expired" and "rejected for fraud" indistinguishable in the data. `INFERENCE`

### 9.5 The expiration job — is it scheduled and reachable?

**Yes.** `CODEBASE VERIFIED`, and this one is fully wired end to end:

- Scheduled: `JOB_SCHEDULES` → `{ queue: DRIVERS_MAINTENANCE, name: DRIVER_DOC_EXPIRATION, pattern: process.env.DRIVER_DOC_EXPIRATION_CRON ?? '0 2 * * *' }` (`src/jobs/scheduler/index.ts:54-58`)
- Dispatched: `MAINTENANCE_HANDLERS[DRIVER_DOC_EXPIRATION] = 'docExpirationJob'` (`src/jobs/workers/index.ts:32`)
- Registered: `docExpirationJob: asClass(DocExpirationJob).singleton()` (`drivers/index.ts:82`)
- Worker started: `startMaintenanceWorkers()` covers every queue named in `JOB_SCHEDULES`
- Distributed lock: `redis.lock.acquire('job:driver_doc_expiration', 15000)` with `release` in `finally`

The job finds `verificationStatus: 'VERIFIED', expiresAt: { lte: now }`, marks each `REJECTED`, and drops the driver to `DOCUMENT_REVIEW`.

> **It can never fire.** Its query requires `verificationStatus === 'VERIFIED'`, and no production code ever writes that value. The job is correct, scheduled, locked, and permanently a no-op. `INFERENCE`

### 9.6 The required answer

> **CAN ANY REAL PRODUCTION API CURRENTLY MARK A DRIVER DOCUMENT AS VERIFIED?**
>
> **NO.** `CODEBASE VERIFIED`
>
> Not by any route (the only admin driver routes are `/:id/verify` and `/:id/suspend`, and neither touches `driver_documents`). Not by any service (`OnboardingService` has no document-review method). Not by any job (`DocExpirationJob` writes only `REJECTED`). Not by any event subscriber (`EpochInvalidationConsumer` is the only subscriber in the codebase, and it handles four auth event types). The only writes of `VERIFIED` to that column anywhere in the repository are `db().client.driverDocument.create({ … verificationStatus: 'VERIFIED' })` in `tests/integration/helpers/fixtures.ts:31-38` — a test fixture, explicitly excluded by the brief.

---

## 10. Document Review

There is **no document review capability in production code**. `CODEBASE VERIFIED`

| Component                                  | Status                                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route to list documents pending review     | ❌ Does not exist                                                                                                                                                                                                      |
| Route to approve a document                | ❌ Does not exist                                                                                                                                                                                                      |
| Route to reject a document with a reason   | ❌ Does not exist                                                                                                                                                                                                      |
| Service method to verify a document        | ❌ Does not exist (`OnboardingService` has none)                                                                                                                                                                       |
| Repository method                          | ✅ **Exists and is correct** — `DriverDocumentRepository.updateVerificationStatus(id, status, verifiedBy?, rejectionReason?, tx?)`                                                                                     |
| Operator read access to the document image | ✅ **Exists in Files** — `decideRead` grants `admin` the `drivers:verify` scope for `DRIVER_DOCUMENT` — but driver documents are not Files-backed, so the driver's raw `fileUrl` is what a reviewer would have to open |
| Reviewer identity capture                  | ✅ Schema has `verifiedBy`/`verifiedAt`; ❌ never populated                                                                                                                                                            |
| Audit trail                                | ❌ No `AuditLog` model exists — `prisma/schema/shared/audit.prisma` contains a single comment line and no model. `SCHEMA VERIFIED`                                                                                     |

**The gap is one service method and one route.** The repository layer, the schema columns, the Files read-scope, and the role/permission vocabulary (`drivers:verify`) are all already in place.

---

## 11. Driver Approval

### 11.1 The route

`CODEBASE VERIFIED` — `driver.routes.ts:18-22`

```ts
fastify.post('/:id/verify', { preHandler: fastify.authorize({ roles: ['admin'] }) }, (req, reply) =>
  controller.onboarding.reviewVerification(req, reply),
);
```

**Who can approve:** holders of the `admin` role slug only. `support` cannot. This matches `ROLE_PERMISSIONS` in the seed (`admin` holds `drivers:verify`, `support` does not) — although the route enforces the **role**, not the permission code, so the two agree by coincidence rather than by construction. `CODEBASE VERIFIED`

### 11.2 What it does

`CODEBASE VERIFIED` — `OnboardingService.reviewDriverVerification`

```ts
const driver = await this.driverRepo.findById(driverId);
if (!driver) throw new DriverNotFoundError(driverId);
return this.txManager.execute(async (tx) => {
  await this.driverRepo.lockForUpdate(driverId, tx); // SELECT … FOR UPDATE ✅
  const newVerificationStatus = status === 'VERIFIED' ? 'VERIFIED' : 'REJECTED';
  const updated = await this.driverRepo.updateVerificationStatus(
    driverId,
    newVerificationStatus,
    approvedBy,
    rejectionReason,
    tx,
  );
  if (newVerificationStatus === 'VERIFIED') {
    this.driverMetrics.driverVerified({ driverId });
    await this.eventPublisher.publish(
      driverEvent(DRIVER_EVENT_CATALOG.VERIFIED, driverId, { driverId, approvedBy }),
      tx,
    );
  }
  return updated;
});
```

Done well: row lock before the read-modify-write; `approvedAt`/`approvedBy` set on the `VERIFIED` branch; the domain event published inside the transaction via the outbox; `reviewVerification` logs the decision at `warn` with `{ driverId, status, reviewerUserId }`.

### 11.3 What it does not do

| Check                                         | Present?   | Consequence                                                                                                                                                                                          |
| --------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Are all mandatory documents submitted?        | ❌         | —                                                                                                                                                                                                    |
| Are the submitted documents `VERIFIED`?       | ❌         | —                                                                                                                                                                                                    |
| **Can approval happen with zero documents?**  | **✅ YES** | The documents table is never queried. `POST /drivers/:id/verify {"status":"VERIFIED"}` on a driver with no profile, no documents, and no vehicle succeeds and writes `VERIFIED`. `CODEBASE VERIFIED` |
| Is `rejectionReason` required when rejecting? | ❌         | `reviewVerificationSchema` marks it `.optional()`; a rejection can carry no reason, and the driver app has nothing to display.                                                                       |
| Is the previous status a legal predecessor?   | ❌         | A `VERIFIED` driver can be re-`VERIFIED`; a `REJECTED` one flipped straight to `VERIFIED`. `InvalidDriverStatusTransitionError` exists in `driver.errors.ts` with **zero throw sites**.              |
| Is the `driver` role granted?                 | ❌         | See §12.                                                                                                                                                                                             |
| Is the security epoch bumped?                 | ❌         | See §12.                                                                                                                                                                                             |
| Is anything written to an audit log?          | ❌         | No `AuditLog` model exists. Only a `warn`-level log line and the outbox event.                                                                                                                       |

**The single most consequential of these is the missing document check**, because it makes the entire document pipeline optional from the platform's point of view — an admin can put an unvetted person into `VERIFIED` with one call.

---

## 12. DRIVER Role Assignment

### 12.1 The finding

> **The `driver` role is never granted to anyone by production code.** `CODEBASE VERIFIED`

Search result for `grantRole` across `src/`, excluding `src/generated/`:

```
src/modules/auth/services/auth.service.ts:256:  async grantRole(      ← definition only
```

That is the complete list. Twenty-eight further references exist, all under `tests/`.

### 12.2 The exact chain that is broken

`CODEBASE VERIFIED`

```
POST /api/v1/drivers/:id/verify   { status: 'VERIFIED' }
  └─ OnboardingService.reviewDriverVerification
       ├─ driverRepo.updateVerificationStatus → VERIFIED   ✅ happens
       ├─ driverMetrics.driverVerified                     ✅ happens
       └─ publish driver.verified → outbox                 ✅ happens
                    │
                    ▼
            OutboxRelay.emit → EventBus.emit('driver.verified')
                    │
                    ▼
            ┌───────────────────────────────┐
            │  ZERO SUBSCRIBERS             │
            └───────────────────────────────┘

            AuthService.grantRole(userId, 'driver')   ← NEVER CALLED
            EpochService.bump(userId)                 ← NEVER CALLED for this
```

`bootstrapEvents()` (`src/bootstrap/events.bootstrap.ts`) registers exactly one consumer:

```ts
container.resolve<EpochInvalidationConsumer>('epochInvalidationConsumer').register();
```

and that consumer handles only `account.role.granted`, `account.role.revoked`, `account.suspended`, `auth.refresh.reuse_detected`. **`EpochInvalidationConsumer` is the only `eventBus.on(...)` call site in the entire repository.** `CODEBASE VERIFIED`

### 12.3 The questions asked, answered

| Question                                                     | Answer                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the `DRIVER` role automatically granted on approval?      | **No.** `CODEBASE VERIFIED`                                                                                                                                                                                                                                    |
| Exact caller of `AuthService.grantRole`?                     | **None in `src/`.** Definition + 28 test references. `CODEBASE VERIFIED`                                                                                                                                                                                       |
| Is role assignment transactional with approval?              | **N/A — it does not happen.** `INFERENCE`                                                                                                                                                                                                                      |
| Does event-based assignment introduce eventual consistency?  | **N/A — no subscriber exists.** If one is added later, the outbox relay makes it at-least-once and asynchronous, so a window would open between `VERIFIED` and the role landing. `INFERENCE`                                                                   |
| What happens if approval succeeds but role assignment fails? | **Today: approval always "succeeds" and role assignment never runs.** `INFERENCE`                                                                                                                                                                              |
| Is the security epoch bumped on approval?                    | **No.** The approval path never calls `epochService.bump`, and the event that would trigger it has no listener. `CODEBASE VERIFIED`                                                                                                                            |
| Are stale JWTs invalidated?                                  | **No** — but currently harmless, since no claim changes. `INFERENCE`                                                                                                                                                                                           |
| What does the Driver App receive after approval?             | `{ data: <Driver row> }` sent to the **admin** who made the call. **The driver receives nothing** — no push (none exists, §20), no SMS, no event. The app can only discover approval by polling `GET /drivers/me`, which does not compile. `CODEBASE VERIFIED` |

### 12.4 On the "backend-controlled roles" requirement

The requirement in the brief — that the Driver App must never send `role: "driver"`, `roles: [...]`, or `userType` as an authorization decision — **is already satisfied and enforced structurally.** `CODEBASE VERIFIED`

The auth request schemas (`sendOtpSchema`, `verifyOtpSchema`, `refreshSchema`) have no role-shaped field; Zod strips unknown keys; roles are read from `user_role_assignments` at issuance and re-read from the database on every refresh; `authorize()` reads only JWT claims that the server minted.

**Nothing needs to be built to enforce this. It needs to be preserved.** The work is the opposite: give the backend a path to grant the role it currently never grants.

---

## 13. Eligibility

Two independent eligibility mechanisms exist, and they check different things. `CODEBASE VERIFIED`

### 13.1 Route guard — `requireOperableDriver`

`src/modules/auth/plugins/auth.plugin.ts:93-110` → `DriverAccessRepository.isOperableDriver`:

```ts
const driver = await this.client.driver.findFirst({
  where: { userId, verificationStatus: 'VERIFIED', isSuspended: false, deletedAt: null },
  select: { id: true },
});
return driver !== null;
```

Fails closed on database error (`503`). Applied to:

- `POST /api/v1/drivers/status/online`
- `POST /api/v1/rides/accept`, `/:id/arrive`, `/:id/start`, `/:id/complete`

**It checks the `Driver` row, not the JWT role.** A user with no `driver` role but a `VERIFIED` Driver row passes it — which is precisely the state a driver reaches today after admin approval. `INFERENCE`

### 13.2 Service gate — `StatusService.setOnline`

Inside one transaction, after `lockForUpdate`:

1. Driver exists → else `DriverNotFoundError`
2. `verificationStatus === 'VERIFIED'` → else `DriverNotVerifiedError`
3. `!isSuspended` → else `DriverSuspendedError`
4. **A `DRIVING_LICENSE` document with `verificationStatus === 'VERIFIED'`** → else `DriverNotVerifiedError`

### 13.3 The full gate matrix

| Gate                              | Enforced?                                                                                                                                                                                                                                              | Where                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Authenticated user                | ✅                                                                                                                                                                                                                                                     | `authPlugin` deny-by-default `onRequest` hook                                                     |
| `driver` **role** in JWT          | ❌ **Not checked on `/drivers/status/online`** — only `requireOperableDriver`. (`/rides/*` driver routes are the same; the `roles: ['driver']` + `requireOperableDriver` combination appears only in a test-only route in `auth-driver-gate.test.ts`.) | —                                                                                                 |
| Driver record exists              | ✅                                                                                                                                                                                                                                                     | `actingDriverId` + `isOperableDriver`                                                             |
| `verificationStatus === VERIFIED` | ✅ (twice)                                                                                                                                                                                                                                             | guard + service                                                                                   |
| Required verified documents       | ⚠️ **Only `DRIVING_LICENSE`.** RC, INSURANCE, PUC, AADHAAR, PAN, POLICE_VERIFICATION are never required.                                                                                                                                               | `setOnline`                                                                                       |
| Licence expiry at go-online time  | ❌ **Not checked.** `expiresAt` is ignored by `setOnline`; only the nightly job looks at it.                                                                                                                                                           | —                                                                                                 |
| Vehicle requirement               | ❌ Not checked. `Driver.currentVehicleId` is never read by any code.                                                                                                                                                                                   | —                                                                                                 |
| Vehicle assignment                | ❌ `VehicleAssignment` is never touched by any hand-written code.                                                                                                                                                                                      | —                                                                                                 |
| Suspension                        | ✅ (twice)                                                                                                                                                                                                                                             | guard + service                                                                                   |
| Active-ride conflict              | ❌ `RideRepository.findActiveByDriver` exists with **zero callers**.                                                                                                                                                                                   | —                                                                                                 |
| Existing active shift             | ✅                                                                                                                                                                                                                                                     | `DriverShiftRepository.startShift` returns the existing open shift rather than creating a second. |

### 13.4 The required answer

> **Can a REAL driver complete OTP → onboarding → profile → documents submitted → documents verified → admin approval → DRIVER role → eligible → ONLINE?**
>
> **NO.**
>
> **The FIRST blocking transition is: document submitted (`PENDING`) → document `VERIFIED`.**
>
> There is no production API, service method with a caller, job, or event subscriber that writes `VERIFIED` to `DriverDocument.verificationStatus` (§9.4, `CODEBASE VERIFIED`).
>
> Two further independent blockers sit behind it, and each would stop the flow on its own even if the first were fixed:
>
> - **Second blocker:** the `driver` role is never granted — `grantRole` has zero production callers (§12).
> - **Third blocker:** `StatusService.setOnline` requires a `VERIFIED` `DRIVING_LICENSE`, so it throws `DriverNotVerifiedError` for every driver in the system, forever, regardless of admin approval.
>
> Note the ordering subtlety: because `requireOperableDriver` checks the Driver row rather than the JWT role, an admin-approved driver **passes the route guard** and is rejected one layer deeper by the service. The `403` they receive says "Driver is not operable"; the real error is `DRIVER_NOT_VERIFIED` from the licence check. `INFERENCE`

---

## 14. Online / Offline / Shifts

`CODEBASE VERIFIED` — `src/modules/drivers/services/status/status.service.ts`

### 14.1 `POST /api/v1/drivers/status/online`

Guarded by `requireOperableDriver`. Inside one transaction: lock the driver row → four gates (§13.2) → `shiftRepo.startShift` → `driverRepo.updateAvailability(true)` → `statusRepo.updateStatus('ONLINE', { currentShiftId, batteryLevel, networkType })` → metric → publish `driver.status_changed`.

Well-constructed. **Unreachable in practice** (§13.4).

### 14.2 `POST /api/v1/drivers/status/offline`

⚠️ **No `requireOperableDriver` guard on this route.** Any authenticated user with a Driver row can call it, regardless of verification state.

Inside one transaction: lock → refuse if `ON_TRIP` (`DriverOnTripError`) → end the active shift → `updateAvailability(false)` → status `OFFLINE`. After commit, **outside** the transaction: `geoService.forgetDriverPosition(driverId)`, removing the driver from the Redis live geo store.

The post-commit placement of `forgetDriverPosition` is deliberate and right — a Redis failure must not roll back the database write, and the geo service logs and swallows its own errors.

### 14.3 `POST /api/v1/drivers/heartbeat`

No operability guard. `recordHeartbeat` returns early if there is no status row or the driver is `OFFLINE`, so it cannot resurrect an offline driver. Updates `heartbeatAt`, `batteryLevel`, `networkType`.

### 14.4 `POST /api/v1/drivers/:id/suspend` — self-deadlock

Guarded by `authorize({ roles: ['admin'] })`. Two defects:

**(a) The body is not validated.** `driver-status.controller.ts:44`:

```ts
const { isSuspended } = req.body as { isSuspended: boolean };
```

A raw cast, no Zod schema, no Fastify `schema:` block — the only route in the driver module that reads its body without parsing it. A missing or misspelled field yields `undefined`, `setSuspended(id, undefined)` runs, `if (isSuspended)` is falsy, and the admin receives `{ success: true }` for an operation that did nothing.

**(b) It deadlocks against itself.** `StatusService.setSuspended`:

```ts
await this.txManager.execute(async (tx) => {
  await this.driverRepo.lockForUpdate(driverId, tx);   // SELECT … FOR UPDATE — outer tx holds it
  await this.driverRepo.setSuspended(driverId, isSuspended, tx);
  if (isSuspended) {
    await this.setOffline(driverId, 'ADMIN_SUSPENSION');  // ← opens a SECOND transaction
    …
  }
});
```

`TransactionManager.execute` unconditionally calls `this.provider.client.$transaction(callback, …)` — it does not detect or join an in-flight transaction (`src/core/database/TransactionManager.ts:29`, `CODEBASE VERIFIED`). So the nested `setOffline` runs on a **different pooled connection** and immediately issues its own `SELECT … FOR UPDATE` on the same driver row, which the still-open outer transaction holds.

The inner statement blocks. The outer transaction cannot commit because it is awaiting the inner. Prisma's interactive-transaction timeout (5 s by default, not overridden here) eventually aborts it.

> **`POST /api/v1/drivers/:id/suspend` with `{"isSuspended": true}` hangs for the transaction timeout and then fails.** Suspending a driver — a safety operation — does not work. `{"isSuspended": false}` takes the `if` branch's else path and succeeds. `INFERENCE`, from `CODEBASE VERIFIED` reads of both files.

`setOffline` also publishes `driver.status_changed` from _its_ transaction while the outer one is mid-flight, so even on a hypothetical success the outbox ordering would be wrong.

### 14.5 Shifts

`DriverShiftRepository`: `findActiveShift` (newest with `shiftEnd IS NULL`), `startShift` (returns the existing open shift if present — idempotent within a transaction), `endShift` (sets `shiftEnd`, computes `totalOnlineMinutes`).

The single-active-shift guarantee holds because `setOnline` calls `startShift` while holding the driver row lock. `INFERENCE`

Never written by any code: `totalTripMinutes`, `idleMinutes`, `completedRides`, `acceptedTrips`, `rejectedTrips`, `cancelledTrips`, `distanceDrivenKm`, `earnings` — every shift statistic beyond `totalOnlineMinutes` stays at its default. `CODEBASE VERIFIED` / `SCHEMA VERIFIED`

`DRIVER_EVENT_CATALOG.SHIFT_STARTED` and `SHIFT_ENDED` are declared and never published. `ShiftService.getActiveShift` has zero callers. `CODEBASE VERIFIED`

### 14.6 `HeartbeatTimeoutJob`

Fully wired: scheduled `* * * * *` on `drivers-maintenance`, resolved as `heartbeatTimeoutJob`, Redis-locked. Finds statuses in `['ONLINE','BREAK']` with `heartbeatAt <= now - driverConfig.heartbeatTimeoutSeconds` and calls `statusService.setOffline(driverId, 'HEARTBEAT_TIMEOUT')` per driver, catching and logging per-driver failures.

Two notes: it never calls `driverMetrics.heartbeatTimeout()`, which exists for exactly this purpose; and a driver who has been `ONLINE` but never sent a heartbeat has `heartbeatAt = null`, which does not match `{ lte: threshold }` and is therefore never swept. `CODEBASE VERIFIED`

---

## 15. Location

`CODEBASE VERIFIED`

**`POST /api/v1/drivers/location`** — rate-limited via `rateLimits.driverLocation`; **no operability guard**. `LocationService.updateLocation`:

1. Reject `isMockLocation === true` when `driverConfig.rejectMockLocation` → `MockLocationRejectedError`
2. Driver must exist
3. **Plausibility check** — `assessPlausibility` compares against the previous fix; implausible jumps throw `ImplausibleLocationError` and are logged with the reason
4. `locationRepo.updateLocation` — raw `INSERT … ON CONFLICT (driver_id) DO UPDATE` writing both the decimal lat/lng and the PostGIS `geography(Point,4326)` column, `recorded_at = now()`
5. `geoService.recordDriverPosition(...)` — H3 cell computed, position written to the Redis live store
6. `statusRepo.updateHeartbeat(driverId)` — a location fix doubles as a heartbeat

`GET /api/v1/drivers/:id/location` — `authorizedDriverId(req, repo, id, ['admin','support'])`: own driver id always allowed; another driver's id allowed only for `admin`/`support`; otherwise `ForbiddenResourceError`. ✅ Correct BOLA handling.

**Concerns:**

1. **No eligibility gate on ingestion.** A `PENDING`, never-approved driver can post positions, and they are written to `driver_locations` _and_ published into the Redis geo live store. Since `PostgisProvider.findNearbyDrivers` queries `driver_locations` alone — with no join to `drivers` and no filter on `verificationStatus`, `isSuspended`, `isAvailable`, or online status (`postgis.provider.ts:31-44`, `CODEBASE VERIFIED`) — an unverified driver would be a dispatch candidate the moment dispatch is wired. Today this is latent because nothing calls `findNearbyDrivers`.
2. **`DRIVER_EVENT_CATALOG.LOCATION_UPDATED` is declared and never published.**
3. **`driver_location_history` does not exist.** `driver.prisma:221` states _"driver_location_history is RANGE-partitioned — manage via raw SQL, not Prisma"_, but a search of all 14 migrations finds **no reference to that table** (`SCHEMA VERIFIED`). `driver_locations` is a single-row-per-driver upsert, so **no location history is retained at all** — there is nothing to reconstruct a trip path or investigate an incident from.

---

## 16. Vehicle Module

**Classification: D — STUB (code) over a complete schema.** `CODEBASE VERIFIED` / `SCHEMA VERIFIED`

`src/modules/vehicles/` contains exactly two files: `index.ts` (`export {};`, 11 bytes) and `README.md`. No routes, no services, no repositories, no DI registration, no controllers.

### 16.1 Schema vs implementation

| Capability                                          | Schema                                                                                                                                         | Production code                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Vehicle registration                                | ✅ `Vehicle` — `registrationNumber @unique`, `vin @unique`, make/model/year/colour/fuel/seating, `currentDriverId`, `isActive`                 | ❌ None                                                                                                 |
| Vehicle types                                       | ✅ `VehicleType` — code, capacities, and the full fare basis (`baseFare`, `perKmRate`, `perMinuteRate`, `waitingCharge`, `cancellationCharge`) | ⚠️ **Read only.** `rides/services/fare/fare.service.ts` reads `VehicleType` for quoting. No write path. |
| Vehicle documents (RC / INSURANCE / PUC)            | ✅ `VehicleDocument` — `documentType String` (free text, **not** an enum), `fileUrl`, `expiresAt`, `verificationStatus`                        | ❌ None                                                                                                 |
| Vehicle images                                      | ✅ `VehicleImage`                                                                                                                              | ❌ None                                                                                                 |
| Inspections / maintenance / fuel / insurance claims | ✅ `VehicleInspection`, `MaintenanceLog`, `FuelLog`, `InsuranceClaim`                                                                          | ❌ None                                                                                                 |
| Approval                                            | ⚠️ `VehicleDocument.verificationStatus` only — no vehicle-level approval column                                                                | ❌ None                                                                                                 |
| Driver assignment                                   | ✅ `VehicleAssignment` — driverId, vehicleId, assignedAt, releasedAt, reason, assignedBy, status                                               | ❌ **Zero references outside generated Prisma types**                                                   |
| `Driver.currentVehicleId`                           | ✅ Column exists — `String? @db.Uuid`, **and it has no `@relation`**, so it is an unconstrained UUID column with no foreign key                | ❌ **Zero references outside generated Prisma types**                                                   |
| Service type support                                | ✅ `VehicleType.code` + `VehicleType.isActive`; `RideRequest`/`Ride` both carry `vehicleTypeId`                                                | ⚠️ Quoting only                                                                                         |

### 16.2 The consequence for rides

`POST /api/v1/rides/accept` requires `vehicleId: z.string().uuid()` in the body (`ride.schemas.ts:24-27`), and `LifecycleService.acceptRideRequest` passes it straight through to `rideRepo.create` with **no validation** (`CODEBASE VERIFIED`). There is no check that:

- the vehicle exists (an arbitrary UUID produces a foreign-key violation surfacing as `500`)
- the vehicle is assigned to _this_ driver (`VehicleAssignment` is never consulted)
- the vehicle is active, or its documents are valid
- `vehicle.vehicleTypeId` matches `request.vehicleTypeId` — **so a driver can accept a premium-tier request in a hatchback and be paid the premium quote**

`INFERENCE` from `CODEBASE VERIFIED` reads of `ride.schemas.ts` and `lifecycle.service.ts:104-155`.

Nothing creates a `Vehicle` row in production, so `POST /rides/accept` cannot currently be satisfied by any driver anyway. `TEST VERIFIED` — `tests/integration/helpers/fixtures.ts:48-58` (`makeVehicle`) creates vehicles by direct insert for tests.

---

## 17. Rides Integration

`CODEBASE VERIFIED` — `src/modules/rides/`

### 17.1 Driver authorization in rides

`ride.routes.ts:13`:

```ts
const driverOnly = { preHandler: fastify.authorize({ requireOperableDriver: true }) };
```

applied to `/accept`, `/:id/arrive`, `/:id/start`, `/:id/complete`. `RideStateController` then resolves the driver with its own private copy of `actingDriverId` — duplicated logic rather than importing `drivers/controllers/driver-identity.ts`, which exports exactly this function.

**Do the JWT role and the driver operability gate agree?** No, and they are not asked to. `requireOperableDriver` never inspects `auth.roles`; it queries the `drivers` table. The `driver` role slug is checked in exactly one production place — `RideStateController.cancel`, `callerHasRole(req, 'driver')`, to decide whether the canceller is the driver or the customer. `CODEBASE VERIFIED`

That is a coherent design (operability is a state, not a role), but it means the `driver` role currently has **no authorization power** on any driver-facing route. `INFERENCE`

### 17.2 The accept / arrive / start / complete flow

| Step                 | Implementation                                                                                                                                                                     | Verdict           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `POST /accept`       | Locks the request, `claimForMatch` (atomic, throws `RideRequestAlreadyMatchedError`), creates the `Ride`, generates a start OTP, records a status event, publishes `ride.accepted` | ⚠️ See gaps below |
| `POST /:id/arrive`   | `lockAndValidate` (row lock + driver-ownership check + transition table) → `updateStatusIf` compare-and-set                                                                        | ✅ Solid          |
| `POST /:id/start`    | Same, plus `rideOtpService.verifyStartOtp`                                                                                                                                         | ✅ Solid          |
| `POST /:id/complete` | Same, plus fare finalisation and `LedgerService` posting                                                                                                                           | ✅ Solid          |
| `POST /:id/cancel`   | Branches on `callerHasRole(req, 'driver')`                                                                                                                                         | ✅                |

The state machine (`ALLOWED_TRANSITIONS`), the `FOR UPDATE` locking, the compare-and-set updates, and the ownership checks in `lockAndValidate` are all well done. `TEST VERIFIED` — `tests/unit/rides/ride-state-machine.test.ts`, `ride-lifecycle-concurrency.test.ts`, `ride-otp.test.ts`.

**Gaps in `acceptRideRequest`** (`CODEBASE VERIFIED`):

1. **No dispatch-offer check.** The driver is never verified to have been _offered_ this request. `RideDispatchRepository.findByRequestAndDriver` exists with zero callers. Any operable driver who learns a `requestId` can accept it.
2. **No one-driver-one-active-ride enforcement.** `RideRepository.findActiveByDriver(driverId)` exists at `ride.repository.ts:85` with **zero callers**. The equivalent check _is_ performed for the customer side (`findActiveByCustomer`, called from `RideRequestService.createRequest`). The driver-side twin was written and never used. A driver can hold unlimited concurrent rides.
3. **Driver status is not changed.** Accepting a ride does not write `BUSY` or `ON_TRIP`. The driver stays `ONLINE` and `isAvailable = true`.
4. **`vehicleId` unvalidated** — §16.2.
5. **`DriverStatus.BUSY` and `ON_TRIP` are never written anywhere in `src/`.** The only reference to `'ON_TRIP'` outside the constants file is the _read_ in `setOffline` that refuses to take an on-trip driver offline — a guard against a state nothing can produce. `CODEBASE VERIFIED`
6. **Ride completion updates no driver aggregates.** `Driver.totalRides`, `totalDistanceKm`, `totalEarnings`, `lastRideAt`, `acceptanceRate`, `completionRate`, `cancellationRate` are never written by any code.

### 17.3 Customer / rider flow — is it at risk?

**No.** `CODEBASE VERIFIED`

The customer path is `POST /auth/otp/send` → `POST /auth/otp/verify` → `customer` role via `ensureDefaultRole` → `/api/v1/users/*`, `/api/v1/rides/quote`, `/api/v1/rides/requests`. It shares `AuthService`, `OtpService`, `UserRepository`, and `UserProfileRepository` with the driver flow and touches none of `src/modules/drivers/`.

The one shared write surface is `User.email`, which the driver profile endpoint writes through a private path (§6). Any driver-onboarding change that touches email must go through `UserRepository.updateEmail` to avoid diverging from the customer flow. `INFERENCE`

`TEST VERIFIED` — `tests/integration/user-registration.test.ts`, `auth-login.test.ts`, `user-profile.test.ts` cover the customer path end to end over HTTP.

---

## 18. Matching / Dispatch Integration

**Classification: D — STUB (dedicated modules) / B — IMPLEMENTED BUT UNWIRED (the pieces inside `rides`).** `CODEBASE VERIFIED`

### 18.1 The required checklist

| Question                                            | Answer                                                                                                                                                                                                                                                                                                                                                             | Evidence                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Does a dispatch module exist?                       | **No.** `src/modules/dispatch/index.ts` is `export {};`                                                                                                                                                                                                                                                                                                            | `CODEBASE VERIFIED`                     |
| Does a matching module exist?                       | **No.** `src/modules/matching/index.ts` is `export {};`                                                                                                                                                                                                                                                                                                            | `CODEBASE VERIFIED`                     |
| Does `findNearbyDrivers` have a production caller?  | **No.** Defined in `geo.service.ts:19` and `postgis.provider.ts:21`; called only by `nearby-driver.service.ts:44` (internal delegation). 23 references in `tests/`, all resolving the service straight from the DI container.                                                                                                                                      | `CODEBASE VERIFIED` / `TEST VERIFIED`   |
| Does `RideDispatch` exist?                          | **In the schema, yes** — with `@@unique([requestId, driverId])`, `dispatchRound`, `expiresAt`, `response`, `driverDistanceM`, `driverEtaSeconds`. **In code, no hand-written reference outside `RideDispatchRepository` and `DispatchTimeoutJob`.**                                                                                                                | `SCHEMA VERIFIED` / `CODEBASE VERIFIED` |
| Does `LockStore` exist?                             | **Yes, and it is genuinely used** — `src/core/cache/stores/LockStore.ts`, Lua-scripted compare-and-delete release. Live callers: `auth-retention.job`, `session.service`, `doc-expiration.job`, `heartbeat-timeout.job`, `files/{reconciliation,retention,sweeper}.job`, `payments/{reconciliation,settlement}.job`, `dispatch-timeout.job`.                       | `CODEBASE VERIFIED`                     |
| Does `offerToDriver` have callers?                  | **No.** `DispatchService.offerToDriver` (`rides/services/dispatch/dispatch.service.ts:13`) is complete — creates the offer, sets a 30 s expiry, emits the metric, publishes `ride.dispatch_offered` — and **nothing calls it.** `DispatchService` is registered in DI and hung off `rideService.dispatch`, and no controller, service, or job reads that property. | `CODEBASE VERIFIED`                     |
| Are Redis locks actually used?                      | **Yes**, by ten jobs/services (above).                                                                                                                                                                                                                                                                                                                             | `CODEBASE VERIFIED`                     |
| Is there an offer timeout job?                      | **Yes, and it is scheduled** — `DispatchTimeoutJob`, `* * * * *` on `rides-maintenance`, Redis-locked, marks `response: 'PENDING'` + `expiresAt <= now` as `TIMEOUT`. **It operates on a table nothing writes to, and it does not re-offer to the next driver** — timing out is terminal.                                                                          | `CODEBASE VERIFIED`                     |
| Is one-driver-one-active-ride enforced?             | **No.** `findActiveByDriver` has zero callers.                                                                                                                                                                                                                                                                                                                     | `CODEBASE VERIFIED`                     |
| Are `ONLINE` / `BUSY` / `ON_TRIP` actually written? | **`ONLINE` yes** (`setOnline`). **`OFFLINE` yes.** **`BUSY` and `ON_TRIP`: never written by any code.**                                                                                                                                                                                                                                                            | `CODEBASE VERIFIED`                     |

### 18.2 Where the chain breaks

`CODEBASE VERIFIED` — `RideRequestService.createRequest` ends at:

```ts
const request = await this.requestRepo.create(createInput, tx);
this.rideMetrics.requestCreated({ requestId: request.id });
await this.eventPublisher.publish(
  rideEvent(RIDE_EVENT_CATALOG.REQUESTED, input.customerId, { … }), tx);
return request;
```

It publishes `ride.requested` and returns. Nothing subscribes to `ride.requested` (§24). Nothing calls `findNearbyDrivers`. Nothing calls `offerToDriver`. **No `RideDispatch` row is ever created in production.**

```
POST /rides/requests
  └─ RideRequest row (status CREATED)
       └─ publish ride.requested  ──►  ZERO SUBSCRIBERS  ──►  ✗ END

     [ findNearbyDrivers      — implemented, 0 production callers ]
     [ offerToDriver          — implemented, 0 production callers ]
     [ RideDispatchRepository — implemented, 0 production callers except the timeout job ]
     [ DispatchTimeoutJob     — scheduled, operates on an always-empty table ]

POST /rides/accept  ← the ONLY way a ride is ever created,
                       and it requires the driver to already know the requestId
```

`RequestExpiryJob` (scheduled `* * * * *`) presumably expires unmatched requests, which is the only thing that currently happens to a ride request after creation.

**Assessment: the dispatch primitives are individually built and individually correct. What does not exist is the orchestrator that joins them** — a subscriber (or a job) that reacts to `ride.requested`, calls `findNearbyDrivers`, filters candidates by operability and availability, calls `offerToDriver` in rounds, and advances on timeout. `INFERENCE`

---

## 19. Geo Integration

**Classification: B — IMPLEMENTED, PARTIALLY WIRED.** `CODEBASE VERIFIED`

`src/modules/geo/` is 24 files of complete, tested implementation: `CoordinateService` (validation/normalisation), `DistanceService` (haversine + exact PostGIS), `H3Provider` (cell indexing + coverage), `RedisGeoProvider` (live position store), `PostgisProvider` (`ST_DWithin` radius query over the GiST index from migration `20260815000000`), and `NearbyDriverService` orchestrating them with graceful degradation — if Redis fails it logs, emits a `postgisFallback` metric, and falls back to a bounded PostGIS radius query.

**No geo routes exist.** `GeoService` is reached only through other modules' DI.

| Method                         | Production callers                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `recordDriverPosition`         | ✅ `LocationService.updateLocation`                                                              |
| `forgetDriverPosition`         | ✅ `StatusService.setOffline`                                                                    |
| `validateCoordinate`           | ✅ via `latitudeSchema`/`longitudeSchema` re-exported into `drivers/schemas` and `rides/schemas` |
| `calculateDistanceMeters`      | ✅ `rides/services/fare`                                                                         |
| **`findNearbyDrivers`**        | ❌ **Zero**                                                                                      |
| `calculateExactDistanceMeters` | ❌ Zero                                                                                          |
| `liveDriverPosition`           | ❌ Zero                                                                                          |

> **Position ingestion is wired; position _discovery_ is not.** Driver locations are being written to PostGIS and Redis on every location update, and nothing ever reads them back for matching. `INFERENCE`

**A filtering gap to note before dispatch is wired:** `PostgisProvider.findNearbyDrivers` selects from `driver_locations` alone with a freshness bound and an optional Redis candidate-id filter. It does **not** join `drivers` and does **not** filter on `verificationStatus`, `isSuspended`, `isAvailable`, or `DriverOnlineStatus.status`. Combined with §15's unguarded location ingestion, a `PENDING` unverified driver would be returned as a dispatch candidate today. Whoever wires dispatch must add that filter — either in the SQL or as a post-filter in the orchestrator. `CODEBASE VERIFIED`

`TEST VERIFIED` — `tests/integration/geo-nearby.test.ts` is thorough (radius correctness, staleness, Redis-down degradation, metrics) and resolves services directly from the container, never over HTTP — consistent with there being no route.

---

## 20. Notifications / Realtime Integration

**Classification: A — IMPLEMENTED AND WIRED, for SMS only.** `CODEBASE VERIFIED`

`src/modules/notifications/` is seven files: `NotificationService` with exactly two methods — `sendSms(to, body, options?)` and `sendOtp(to, code)` — behind an `SmsProvider` interface with an MSG91 implementation and a mock.

Production callers: `OtpService.notifyLocked` (lockout SMS) and `OtpDeliveryJob.run` (OTP delivery, via the `auth-otp` BullMQ queue with exponential backoff and exhaustion recording).

**What does not exist** — searched repository-wide:

| Capability                | Status                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push notifications (FCM)  | ❌ **None.** `fcmToken` is accepted in the device payload and stored on `UserDevice`, and **nothing ever reads it to send anything.** Callers of `fcmToken` are limited to `auth.controller.ts`, `device.repository.ts`, the schemas, and the type definitions. |
| APNs                      | ❌ No reference anywhere                                                                                                                                                                                                                                        |
| Firebase SDK              | ❌ Not a dependency                                                                                                                                                                                                                                             |
| WebSocket / Socket.IO     | ❌ `src/plugins/socket/socket.plugin.ts` is `export {};` and is not registered in `src/plugins/register.ts`                                                                                                                                                     |
| Server-Sent Events        | ❌ No reference                                                                                                                                                                                                                                                 |
| In-app notification store | ❌ `prisma/schema/modules/notification/notification.prisma` exists, but no code reads or writes it                                                                                                                                                              |
| Email                     | ❌ No provider                                                                                                                                                                                                                                                  |

> **Do not confuse SMS OTP with notification infrastructure** — the brief's warning is well founded. There is exactly one outbound channel (SMS) with exactly two message types (OTP, OTP-lockout). `CODEBASE VERIFIED`

**Consequences for the driver lifecycle**, all `INFERENCE`: a driver cannot be told their document was approved or rejected; cannot be told their application was approved; cannot be offered a ride (dispatch has no delivery channel even if it were wired — which is likely _why_ it was never wired); cannot be told a ride was cancelled. Every state change must be discovered by polling.

---

## 21. Admin / Support Integration

**Classification: D — STUB.** `CODEBASE VERIFIED`

`src/modules/admin/` and `src/modules/support/` are each `export {};` + README. No `/api/v1/admin` or `/api/v1/support` route prefix is registered.

**The complete set of admin-capable production endpoints in the entire application:**

| Endpoint                                              | Guard                                                     | Capability                                                   |
| ----------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `POST /api/v1/drivers/:id/verify`                     | `roles: ['admin']`                                        | Approve/reject a driver                                      |
| `POST /api/v1/drivers/:id/suspend`                    | `roles: ['admin']`                                        | Suspend/reinstate a driver (**deadlocks on suspend**, §14.4) |
| `GET /api/v1/drivers/:id/location`                    | staff bypass in `authorizedDriverId` (`admin`, `support`) | Read a driver's location                                     |
| `GET /api/v1/drivers/:driverId/wallet[/transactions]` | same                                                      | Read a driver's wallet                                       |
| `GET /api/v1/files/:id`, `GET /api/v1/files/:id/url`  | `decideRead` ops scopes                                   | Read another user's file when holding the purpose's scope    |
| Payments payout routes                                | `finance`/`admin` guards                                  | Payout execution                                             |

**Assessed against the brief's four asks:**

| Ask                          | Status                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing review capabilities | ⚠️ Driver-level approve/reject only. No queue, no list, no filter, no pagination — an admin has **no way to discover which drivers are awaiting review**; they must already know the driver id.                                                                                                                                                              |
| Driver approval              | ⚠️ Exists; approves with zero documents; grants no role                                                                                                                                                                                                                                                                                                      |
| Document approval            | ❌ **Does not exist**                                                                                                                                                                                                                                                                                                                                        |
| Role management              | ❌ **No route.** `grantRole`/`revokeRole` are implemented and unreachable over HTTP. Roles can only be assigned by direct database insert or by the development seed.                                                                                                                                                                                        |
| Audit logging                | ❌ **No `AuditLog` model.** `prisma/schema/shared/audit.prisma` is a one-line comment. `SCHEMA VERIFIED`. What exists instead: `warn`-level structured logs on the two admin driver routes; the `event_outbox` table with `classification: 'audit'` on `driver.verified` / `driver.status_changed` / `driver.suspended`; `File` operator-read audit records. |

The outbox with its audit classification is a reasonable foundation for an audit trail and is already populated — building a separate audit table would duplicate it. `INFERENCE`

---

## 22. Authorization Consistency

`CODEBASE VERIFIED`

### 22.1 What is consistent and correct

- **Deny by default.** The `onRequest` hook authenticates every route not explicitly marked `config: { public: true }`. `TEST VERIFIED` by `route-graph.test.ts`, which pins the public set to nine sanctioned entries, and `tests/unit/auth/deny-by-default.test.ts`.
- **Fail closed.** Epoch-store, session-blacklist, device-integrity, and driver-operability checks all return `503` on infrastructure failure rather than allowing the request.
- **Identity is never client-supplied.** Every driver endpoint derives the driver from `callerId(req)`. No endpoint accepts a `userId`.
- **Ownership checks are centralised** in `src/core/auth/caller.ts` and used consistently.
- **Roles are database-sourced**, re-read on every refresh, epoch-invalidated on change.

### 22.2 Inconsistencies found

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                | Severity       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | **`:driverId` path params are decorative.** `PATCH /:driverId/profile` and `POST /:driverId/documents` parse the parameter and ignore it, using `actingDriverId` instead. Not exploitable — but any future reader who assumes the parameter is honoured will introduce a real IDOR.                                                                                                    | Medium         |
| 2   | **Inconsistent operability gating.** `POST /status/online` is guarded by `requireOperableDriver`; `POST /status/offline`, `POST /heartbeat`, and `POST /location` are not. Location ingestion from unverified drivers is the concrete consequence (§15).                                                                                                                               | Medium         |
| 3   | **`authorizedDriverId` staff bypass is not audited.** An `admin` or `support` user reading another driver's wallet or location produces no audit record — unlike the Files module, which explicitly audits operator reads.                                                                                                                                                             | Medium         |
| 4   | **Role checks vs permission checks diverge.** `authorize()` checks role slugs; `PERMISSION_SEED`/`ROLE_PERMISSIONS` define capability codes; `PermissionRepository.findAllowedCodesForUser` has zero callers; the Files module hardcodes its own third copy of the role→scope map. Three sources of truth. The seed file documents this honestly.                                      | Medium         |
| 5   | **The `driver` role grants no authorization.** It is checked in exactly one production line (`RideStateController.cancel`). Every other driver-facing gate keys off the `drivers` table.                                                                                                                                                                                               | Low, by design |
| 6   | **Driver routes carry no Fastify `schema:` blocks.** Unlike auth/users/files, no route in `driver.routes.ts` declares request or response schemas — no OpenAPI documentation, no response serialisation, and internal fields are echoed straight to the client (`GET /drivers/me` returns the raw Prisma row including `documents[]` with `fileUrl`, `approvedBy`, `rejectionReason`). | Medium         |
| 7   | **`POST /:id/suspend` does not validate its body** (§14.4a).                                                                                                                                                                                                                                                                                                                           | Medium         |

`TEST VERIFIED` — `tests/integration/authorization-bola.test.ts` covers cross-driver access on rides, wallets, and payouts, and confirms a customer is refused on `/rides/accept` and `/drivers/status/online`.

---

## 23. Database / Schema Readiness

`SCHEMA VERIFIED` throughout. 14 migrations, the most recent `20260815120000_file_storage_metadata`. Driver tables originate in `20260724173304_init`.

### 23.1 Required models

| Model                                                                            | Present | Notes                                                                                                                             |
| -------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `User`                                                                           | ✅      | `email @unique`, `isEmailVerified`, `status`, soft delete, `driver Driver?`                                                       |
| `Role`                                                                           | ✅      | Seeded: customer, driver, admin, support, finance. **No `super_admin`.**                                                          |
| `UserRoleAssignment`                                                             | ✅      | `grantedBy`, `expiresAt`, `revokedAt`; active-uniqueness is a partial index, not a Prisma `@unique`                               |
| `Permission` / `RolePermission`                                                  | ✅      | Seeded and mapped; **not enforced** by `authorize()`                                                                              |
| `Driver`                                                                         | ✅      | `verificationStatus`, `isAvailable`, `isSuspended`, `approvedAt`, `approvedBy`, `rejectionReason`, aggregates                     |
| `DriverProfile`                                                                  | ✅      | `fullLegalName`, `gender` (bare `String?`), address, `profilePhoto`, languages. **No email — correct**, `User.email` is canonical |
| `DriverDocument`                                                                 | ✅      | `verifiedBy`, `verifiedAt`, `verificationNotes`, `rejectionReason`, `ocrData`, `documentChecksum`, `expiresAt`                    |
| `DriverShiftLog`                                                                 | ✅      | Full stat columns; only `totalOnlineMinutes` ever written                                                                         |
| `DriverOnlineStatus`                                                             | ✅      | `status`, `heartbeatAt`, `currentShiftId`, battery/network                                                                        |
| `DriverLocation`                                                                 | ✅      | PostGIS `geography(Point,4326)` + GiST index (migration `20260815000000`)                                                         |
| Driver location **history**                                                      | ❌      | **`driver_location_history` appears in no migration.** Referenced only by a code comment at `driver.prisma:221`.                  |
| `DriverBankAccount`, `DriverWallet`, `DriverWalletTransaction`                   | ✅      | Wallet is read-only in code; bank accounts entirely untouched                                                                     |
| `Vehicle`, `VehicleType`, `VehicleDocument`, `VehicleImage`, `VehicleInspection` | ✅      | No production code                                                                                                                |
| `VehicleAssignment`                                                              | ✅      | Zero hand-written references                                                                                                      |
| `Driver.currentVehicleId`                                                        | ⚠️      | Column exists, **no `@relation` and therefore no foreign key**; zero hand-written references                                      |
| `RideDispatch`                                                                   | ✅      | `@@unique([requestId, driverId])`, `dispatchRound`, `expiresAt`, distance/ETA. Written only via the unreachable `DispatchService` |
| `AuditLog`                                                                       | ❌      | `prisma/schema/shared/audit.prisma` is a comment with no model                                                                    |

### 23.2 Did the schema anticipate the missing workflows?

**Yes, almost completely.** Every column a document-review and role-assignment flow needs already exists: `DriverDocument.verifiedBy`, `verifiedAt`, `verificationNotes`, `rejectionReason`, `expiresAt`, `documentChecksum`, `ocrData`; `Driver.approvedAt`, `approvedBy`, `rejectionReason`; the full `UserRoleAssignment` grant model; the whole `RideDispatch` offer model; `VehicleAssignment`.

> **The gap is code, not schema.** The database was designed for the complete lifecycle. `INFERENCE`

### 23.3 Schema gaps that will constrain the eventual fix

Reported as findings only — **no migration was created**, per the brief.

1. **`VerificationStatus` has no `EXPIRED`.** `PENDING | VERIFIED | REJECTED` only, so `DocExpirationJob` overloads `REJECTED` and "expired" cannot be distinguished from "rejected for fraud".
2. **No unique constraint on `driver_documents (driver_id, document_type)`.** Confirmed against `migration.sql:2631-2637` — three plain indexes, no unique. The `findFirst`-then-`create` upsert is racy (§9.3).
3. **`DriverDocument.fileUrl` is a `String`, not a `fileId` FK to `files`.** Files integration would need a column change and a backfill.
4. **`Driver.currentVehicleId` has no foreign key.** Nothing prevents it holding a nonexistent or another driver's vehicle id.
5. **No `AuditLog` model.** (The outbox may be sufficient — see §21.)
6. **`DriverProfile.gender` is an unconstrained `String?`.** Only Zod enforces the enum.
7. **No location history table**, despite the code comment claiming one is managed in raw SQL.
8. **No explicit onboarding-step column** — and, per §8.2, **none appears to be needed**.

---

## 24. Event and Job Reachability

### 24.1 Event infrastructure

`CODEBASE VERIFIED`. The mechanism is well built: `EventPublisher.publish(input, tx?)` writes to `event_outbox` inside the caller's transaction; `OutboxRelay` claims batches with a claim token and retry/backoff (migrations `20260805180000`, `20260806090000`) and calls `EventBus.emit`; `bootstrapEvents()` starts the relay.

**Subscriber census — the whole repository:**

```
$ grep -rn "eventBus.on(" src --exclude-dir=generated
src/modules/auth/consumers/epoch-invalidation.consumer.ts:17
```

**One subscriber. Four event types** (`account.role.granted`, `account.role.revoked`, `account.suspended`, `auth.refresh.reuse_detected`).

**Every other event published anywhere in the platform has zero listeners.** They are durably persisted to the outbox — so they are a real audit trail, and a future subscriber could replay them — but they trigger nothing.

### 24.2 Driver event catalog

| Event                     | Published?                                                                   | Subscribed?                                |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `driver.onboarded`        | ✅ `OnboardingService.onboardDriver`                                         | ❌                                         |
| `driver.verified`         | ✅ `OnboardingService.reviewDriverVerification`                              | ❌ **This is the missing role-grant hook** |
| `driver.status_changed`   | ✅ `StatusService.setOnline` / `setOffline`                                  | ❌                                         |
| `driver.suspended`        | ✅ `StatusService.setSuspended` (on the deadlocking path)                    | ❌                                         |
| `driver.document_expired` | ❌ **Declared, never published** — `DocExpirationJob` emits a metric instead | ❌                                         |
| `driver.shift_started`    | ❌ Declared, never published                                                 | ❌                                         |
| `driver.shift_ended`      | ❌ Declared, never published                                                 | ❌                                         |
| `driver.location_updated` | ❌ Declared, never published                                                 | ❌                                         |

`DRIVER_EVENT_CATALOG.VERIFIED` search result: `catalog.ts:4` (definition) and `onboarding.service.ts:103` (publish). **No consumer.** `CODEBASE VERIFIED`

### 24.3 Job reachability

All jobs verified against `JOB_SCHEDULES` → `MAINTENANCE_HANDLERS` → DI registration → `startMaintenanceWorkers()`.

| Job                         | Schedule       | Handler resolvable       | Reachable | Effective?                                                                      |
| --------------------------- | -------------- | ------------------------ | --------- | ------------------------------------------------------------------------------- |
| `file-sweep`                | `*/15 * * * *` | `fileSweeperJob` ✅      | ✅        | ✅                                                                              |
| `file-retention`            | `0 3 * * *`    | `fileRetentionJob` ✅    | ✅        | ✅                                                                              |
| `account-erasure`           | config         | `accountErasureJob` ✅   | ✅        | ✅                                                                              |
| `auth-retention`            | `30 4 * * *`   | `authRetentionJob` ✅    | ✅        | ✅                                                                              |
| `dispatch-timeout`          | `* * * * *`    | `dispatchTimeoutJob` ✅  | ✅        | ❌ **Table is always empty**                                                    |
| `request-expiry`            | `* * * * *`    | `requestExpiryJob` ✅    | ✅        | ✅                                                                              |
| `driver-heartbeat-timeout`  | `* * * * *`    | `heartbeatTimeoutJob` ✅ | ✅        | ⚠️ Only reachable once drivers can go online; never sweeps `heartbeatAt = null` |
| `driver-doc-expiration`     | `0 2 * * *`    | `docExpirationJob` ✅    | ✅        | ❌ **No document is ever `VERIFIED`, so its query never matches**               |
| `payment-reconciliation`    | `15 * * * *`   | `reconciliationJob` ✅   | ✅        | ✅                                                                              |
| `otp-send` (queue consumer) | on demand      | `otpDeliveryJob` ✅      | ✅        | ✅                                                                              |

`TEST VERIFIED` — `tests/unit/jobs/job-runtime.test.ts` and `tests/integration/job-runtime.test.ts` verify that every scheduled job name resolves to a registered handler.

> **Both driver jobs are correctly plumbed and both are currently no-ops** — one because nothing produces its input rows, the other because nothing produces its input state. `INFERENCE`

---

## 25. Test Coverage and Fixture Shortcuts

`TEST VERIFIED`. 109 test files; `npm run test:unit` → **714 passing, 0 failing** (executed during this investigation).

> Note: `npm test` runs through `tsx`, which strips types without checking them. The suite is green **while the repository does not typecheck**. Type errors in the driver module are invisible to CI's test step — only `npm run typecheck` / `npm run build` catches them. `INFERENCE`

### 25.1 Driver-specific tests

| File                                               | What it covers                                       | Verdict                                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/drivers/verification-gate.test.ts`     | `setOnline` rejects unverified and suspended drivers | **Mock-only.** Constructs `StatusService` with seven `{} as never` dependencies and a fake `driverRepo`. Never reaches the licence check, the shift repo, or the database. |
| `tests/unit/drivers/location-plausibility.test.ts` | Pure `assessPlausibility` function                   | ✅ Good unit test                                                                                                                                                          |
| `tests/unit/drivers/mock-location.test.ts`         | Mock-GPS rejection                                   | ✅ Good unit test                                                                                                                                                          |
| `tests/integration/auth-driver-gate.test.ts`       | `requireOperableDriver` behaviour                    | **Fixture shortcut** — see below                                                                                                                                           |
| `tests/integration/authorization-bola.test.ts`     | Cross-driver access on rides/wallet/payout           | **Fixture shortcut** for driver setup; the BOLA assertions themselves are real                                                                                             |
| `tests/integration/earnings-pipeline.test.ts`      | Settlement/earnings                                  | Fixture-created drivers                                                                                                                                                    |
| `tests/integration/geo-nearby.test.ts`             | Nearby search                                        | Container-resolved, no HTTP                                                                                                                                                |

### 25.2 The fixture shortcuts, precisely

**`tests/integration/helpers/fixtures.ts`** — `TEST VERIFIED`:

```ts
export async function grantRole(userId, slug) {              // bypasses AuthService.grantRole
  const role = await db().client.role.findUniqueOrThrow({ where: { slug } });
  …
  await db().client.userRoleAssignment.create({ data: { userId, roleId: role.id } });
}

export async function makeDriver(userId, { verified = true, suspended = false } = {}) {
  const driver = await db().client.driver.create({ data: {
    userId, driverCode: …, verificationStatus: verified ? 'VERIFIED' : 'PENDING', isSuspended: suspended,
  }});
  if (verified) {
    await db().client.driverDocument.create({ data: {          // ← the shortcut that hides the P0
      driverId: driver.id, documentType: 'DRIVING_LICENSE',
      verificationStatus: 'VERIFIED',                          // ← no production code can write this
      fileUrl: 'https://example.invalid/licence.jpg',          // ← no production code validates this
    }});
  }
  return driver.id;
}
```

**`tests/integration/auth-driver-gate.test.ts`** compounds it: `driverLogin` inserts a `userRoleAssignment` row directly, then logs in a second time to pick up the claim; `makeDriver` inserts a `VERIFIED` driver row directly; and the test registers its **own ad-hoc route** (`app.get('/test/ride-accept', { preHandler: [app.authorize({ roles: ['driver'], requireOperableDriver: true })] }, …)`) rather than exercising a production route.

> These fixtures are individually reasonable — a guard test should not have to walk the whole funnel. **Collectively they are why the P0s went unnoticed:** every test that needs a working driver manufactures one in three `INSERT`s, so no test ever asks the question "could a real client have produced this row?" `INFERENCE`

### 25.3 Coverage by lifecycle transition

| #   | Transition                                      | Coverage                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Phone → OTP send                                | **REAL END-TO-END** — `auth-login.test.ts`, `otp-hardening.test.ts`, `auth-enumeration.test.ts`                                                                                                                                           |
| 2   | OTP verify → tokens                             | **REAL END-TO-END** — full HTTP, including idempotency and account-state refusals                                                                                                                                                         |
| 3   | Token → User + `customer` role                  | **REAL END-TO-END** — `user-registration.test.ts`                                                                                                                                                                                         |
| 4   | Explicit driver onboarding (`POST /me/onboard`) | **NO COVERAGE** — no test calls this route                                                                                                                                                                                                |
| 5   | Profile: name / gender / email                  | **NO COVERAGE** — no test calls `PATCH /drivers/:id/profile`                                                                                                                                                                              |
| 6   | Document upload through Files                   | **NO COVERAGE** — the integration does not exist                                                                                                                                                                                          |
| 7   | Document submission (`POST /:id/documents`)     | **NO COVERAGE** — no test calls this route                                                                                                                                                                                                |
| 8   | Document review                                 | **NO COVERAGE** — no production code exists                                                                                                                                                                                               |
| 9   | Document verification                           | **FIXTURE SHORTCUT ONLY** — `fixtures.ts:31`                                                                                                                                                                                              |
| 10  | Driver approval (`POST /:id/verify`)            | **NO COVERAGE** — no test calls this admin route                                                                                                                                                                                          |
| 11  | Backend role assignment                         | **FIXTURE SHORTCUT ONLY** — direct `userRoleAssignment` inserts. `auth-roles.test.ts` tests `AuthService.grantRole` thoroughly (idempotency, epoch bump, concurrency, unseeded-role rejection) — but never in the driver approval context |
| 12  | New token / claims after role change            | **PARTIAL** — `auth-roles.test.ts` and `auth-expiry.test.ts` prove the epoch/refresh mechanism; nothing exercises it for a driver                                                                                                         |
| 13  | Eligibility gate                                | **PARTIAL** — `auth-driver-gate.test.ts` (fixture-backed, ad-hoc route); `verification-gate.test.ts` (mock-only)                                                                                                                          |
| 14  | Going ONLINE                                    | **NO COVERAGE** — no test calls `POST /drivers/status/online` with an expectation of success                                                                                                                                              |
| 15  | Location update                                 | **PARTIAL** — plausibility and mock-GPS unit-tested; the route is never exercised                                                                                                                                                         |
| 16  | Dispatch discovery                              | **NO COVERAGE of the path** — `geo-nearby.test.ts` tests the service in isolation, which is all that can be tested                                                                                                                        |

**Zero tests exist for any route in `driver.routes.ts` except the two authentication/BOLA probes.** `TEST VERIFIED`

`tests/integration/route-graph.test.ts` is the most valuable existing safety net for this work: it enumerates the live route table and fails on any route reachable without a token.

---

## 26. Dead Code / Zero-Caller Analysis

All rows below verified by repository-wide search of `src/` with `src/generated/**` excluded. `CODEBASE VERIFIED`

### 26.1 Implemented, zero production callers

| Symbol                                                                                            | Location                                         | Note                                                                                      |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `AuthService.grantRole`                                                                           | `auth.service.ts:256`                            | 28 test refs. **The keystone gap.**                                                       |
| `AuthService.revokeRole`                                                                          | `auth.service.ts:295`                            | Same                                                                                      |
| `PermissionRepository.findAllowedCodesForUser`                                                    | `auth/repositories/permission.repository.ts:17`  | Whole class registered and unused                                                         |
| `GeoService.findNearbyDrivers` → `NearbyDriverService.find` → `PostgisProvider.findNearbyDrivers` | geo module                                       | Fully implemented, heavily tested, unreachable                                            |
| `GeoService.liveDriverPosition`                                                                   | `geo.service.ts:39`                              | —                                                                                         |
| `GeoService.calculateExactDistanceMeters`                                                         | `geo.service.ts:25`                              | —                                                                                         |
| `PostgisProvider.isWithin`                                                                        | `postgis.provider.ts:64`                         | —                                                                                         |
| `DispatchService.offerToDriver`                                                                   | `rides/services/dispatch/dispatch.service.ts:13` | Registered in DI, hung off `rideService.dispatch`, never invoked                          |
| `RideDispatchRepository.createOffer`                                                              | `ride-dispatch.repository.ts:6`                  | Only via the unreachable `offerToDriver`                                                  |
| `RideDispatchRepository.findByRequestAndDriver`                                                   | `:32`                                            | **Zero callers** — this is the offer-validation check `POST /rides/accept` should perform |
| `RideDispatchRepository.updateResponse`                                                           | `:44`                                            | **Zero callers** — nothing records a driver's accept/reject against an offer              |
| `RideRepository.findActiveByDriver`                                                               | `ride.repository.ts:85`                          | **Zero callers** — the one-driver-one-ride check                                          |
| `DriverBankRepository` (entire class)                                                             | `drivers/repositories/driver-bank.repository.ts` | Registered in DI, no route, no service                                                    |
| `ShiftService.getActiveShift`                                                                     | `drivers/services/shift/shift.service.ts:5`      | Exposed as `driverService.shift`, never read                                              |
| `driverPlugin`, `ridePlugin`, `filePlugin`, `paymentPlugin`, `userPlugin`                         | each module's `plugins/`                         | Superseded by direct registration in `routes/register.ts`                                 |
| `DriverView`, `DriverShiftView`                                                                   | `drivers/schemas/driver.responses.ts`            | Interfaces never referenced                                                               |
| `InvalidDriverStatusTransitionError`                                                              | `drivers/errors/driver.errors.ts:29`             | Zero throw sites                                                                          |
| `DocumentValidationError`                                                                         | `drivers/errors/driver.errors.ts:62`             | Zero throw sites                                                                          |
| `DriverMetrics.heartbeatTimeout`                                                                  | `drivers/metrics/driver.metrics.ts`              | Not called even by `HeartbeatTimeoutJob`                                                  |

### 26.2 Reachable but effectively inert

| Item                                                | Why                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `DriverDocumentRepository.updateVerificationStatus` | One caller (`DocExpirationJob`), which only ever passes `REJECTED`                |
| `DocExpirationJob`                                  | Scheduled and locked; its query requires `VERIFIED` documents, which cannot exist |
| `DispatchTimeoutJob`                                | Scheduled and locked; `ride_dispatches` is never written                          |
| `StatusService.setOnline`                           | Routed and guarded; its licence gate is unsatisfiable                             |
| `setOffline`'s `ON_TRIP` refusal                    | Guards against a state nothing writes                                             |

### 26.3 Declared-but-never-produced values

| Value                                                                                              | Location                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `DriverStatus.BUSY`, `DriverStatus.ON_TRIP`                                                        | Enum + constants; never written                         |
| `DriverVerificationStatus.SUSPENDED`                                                               | Enum; suspension uses the `isSuspended` boolean instead |
| `driver.document_expired`, `driver.shift_started`, `driver.shift_ended`, `driver.location_updated` | `DRIVER_EVENT_CATALOG`; never published                 |
| `Driver.currentVehicleId`                                                                          | Column; never read or written                           |
| `VehicleAssignment` (whole table)                                                                  | Never touched                                           |
| `DriverShiftLog` stats beyond `totalOnlineMinutes`                                                 | Never written                                           |
| `Driver` aggregates (`totalRides`, `totalEarnings`, `rating`, `acceptanceRate`, …)                 | Never written                                           |
| `DriverDocument.verificationNotes`, `ocrData`, `documentChecksum`                                  | Never written                                           |
| `UserDevice.fcmToken`                                                                              | Stored, never read for delivery                         |

---

## 27. P0 Findings

Blocking. Each independently prevents the driver lifecycle from functioning.

**P0-1 — The repository does not compile.** `CODEBASE VERIFIED`
`driver-onboarding.controller.ts:18` uses `DriverNotFoundError` without importing it. `npx tsc --noEmit` reports this as the only error in the codebase; `npm run build` fails. The unit suite passes anyway because `tsx` strips types. `GET /api/v1/drivers/me` — the onboarding-resume endpoint — cannot ship, and at runtime would throw `ReferenceError` (500) instead of the intended 404.

**P0-2 — No production API can mark a driver document VERIFIED.** `CODEBASE VERIFIED`
The only writers of `DriverDocument.verificationStatus` are the driver's own submission (`PENDING`) and `DocExpirationJob` (`REJECTED`). `DriverDocumentRepository.updateVerificationStatus` supports `VERIFIED` with `verifiedBy`/`verifiedAt` and has exactly one caller, which never passes it. **This is the first blocking transition** — it makes `setOnline`'s licence gate permanently unsatisfiable and `DocExpirationJob` permanently inert.

**P0-3 — `AuthService.grantRole` has zero production callers; the `driver` role is never granted.** `CODEBASE VERIFIED`
Approving a driver writes `verificationStatus = VERIFIED` and publishes `driver.verified` — which has no subscriber. No role, no epoch bump, no new claims. The role is obtainable only by direct database insert.

**P0-4 — A driver can be approved with zero documents.** `CODEBASE VERIFIED`
`reviewDriverVerification` never queries `driver_documents`. `POST /drivers/:id/verify {"status":"VERIFIED"}` succeeds on a driver with no profile, no documents, and no vehicle — making the entire document pipeline optional.

**P0-5 — Driver documents accept arbitrary client-supplied URLs.** `CODEBASE VERIFIED`
`submitDriverDocumentSchema.fileUrl = z.string().url()`. No Files integration, no ownership proof, no existence check, no content inspection, no host allow-list. A driver can submit a link to anything, including a URL an admin reviewer's browser will fetch. The Files module already defines a complete `DRIVER_DOCUMENT` purpose (10 MB, magic-byte validation, EXIF-location rejection, `drivers:verify` operator scope, 8-year ARCHIVE retention) that nothing uses.

**P0-6 — `POST /api/v1/drivers/:id/suspend` self-deadlocks.** `CODEBASE VERIFIED` / `INFERENCE`
`setSuspended` holds `SELECT … FOR UPDATE` on the driver row, then calls `setOffline`, which — because `TransactionManager.execute` always opens a fresh `$transaction` — runs on a second connection and locks the same row. The request blocks until the Prisma transaction timeout and fails. Suspending a driver, a safety operation, does not work.

**P0-7 — Dispatch is not a running system.** `CODEBASE VERIFIED`
`src/modules/dispatch/` and `src/modules/matching/` are `export {};`. `findNearbyDrivers` and `offerToDriver` are complete with zero callers. `RideRequestService.createRequest` publishes `ride.requested` into a bus with no subscribers. No `RideDispatch` row is ever created. `BUSY`/`ON_TRIP` are never written. A driver can only accept a ride whose `requestId` they somehow already know.

---

## 28. P1 Findings

Serious. Would cause incorrect behaviour, financial loss, or security exposure once the P0s are fixed.

**P1-1 — No one-driver-one-active-ride enforcement.** `RideRepository.findActiveByDriver` exists with zero callers, while the customer-side equivalent _is_ called. A driver can hold unlimited concurrent rides. `CODEBASE VERIFIED`

**P1-2 — `POST /rides/accept` does not validate `vehicleId`.** No check that the vehicle exists, is assigned to this driver, is active, or matches `request.vehicleTypeId`. A driver can accept a premium-tier request in a hatchback and be paid the premium quote. `CODEBASE VERIFIED`

**P1-3 — `POST /rides/accept` does not verify a dispatch offer.** `RideDispatchRepository.findByRequestAndDriver` exists with zero callers. Any operable driver who learns a `requestId` can claim it. `CODEBASE VERIFIED`

**P1-4 — Location ingestion has no eligibility gate.** A `PENDING` unverified driver's position is written to `driver_locations` and into the Redis live geo store. Combined with P1-5, they become a dispatch candidate. `CODEBASE VERIFIED`

**P1-5 — `findNearbyDrivers` does not filter by driver state.** The PostGIS query selects from `driver_locations` alone with no join to `drivers` — no filter on `verificationStatus`, `isSuspended`, `isAvailable`, or online status. `CODEBASE VERIFIED`

**P1-6 — Licence expiry is not checked at go-online time.** `setOnline` ignores `expiresAt`; only the 02:00 UTC job looks at it. A licence expiring at 03:00 remains usable for 23 hours. `CODEBASE VERIFIED`

**P1-7 — Racy document upsert.** `findFirst`-then-`create` with **no unique constraint on `(driver_id, document_type)`** (`SCHEMA VERIFIED`) permits duplicate rows under concurrent submission, after which `docs.some(...)` passes if either copy is approved.

**P1-8 — Stale review metadata survives re-upload.** `upsertDocument` resets `verificationStatus` to `PENDING` but leaves `verifiedBy`, `verifiedAt`, `verificationNotes`, and `rejectionReason` intact. `CODEBASE VERIFIED`

**P1-9 — A `REJECTED` driver cannot re-enter review.** `submitDocument` promotes to `DOCUMENT_REVIEW` only from exactly `PENDING`. A rejected driver's resubmission never returns to the queue. `CODEBASE VERIFIED`

**P1-10 — Email is written through a private path.** `DriverRepository.updateProfile` issues a raw `client.user.update({ data: { email } })`, bypassing `UserRepository.updateEmail`. A `@unique` collision surfaces as **500**, not 409; `isEmailVerified` is never managed; two write paths to one unique column will drift. `CODEBASE VERIFIED` / `SCHEMA VERIFIED`

**P1-11 — `POST /:id/suspend` does not validate its body.** Raw `req.body as { isSuspended: boolean }`. A malformed body returns `{ success: true }` having done nothing. `CODEBASE VERIFIED`

**P1-12 — No admin review queue.** No route lists drivers or documents awaiting review. An admin must already know the driver id to act. `CODEBASE VERIFIED`

**P1-13 — No notification channel to the driver.** Approval, rejection, and ride offers cannot be delivered. FCM tokens are collected and never read; no push, no realtime, no in-app store. `CODEBASE VERIFIED`

**P1-14 — Driver routes have no Fastify schemas.** No OpenAPI documentation and no response serialisation; `GET /drivers/me` echoes the raw Prisma row including `documents[].fileUrl`, `approvedBy`, and `rejectionReason`. `CODEBASE VERIFIED`

**P1-15 — No location history.** `driver_locations` is one upserted row per driver, and `driver_location_history` exists in no migration despite the schema comment. Trip paths and incident investigation are impossible. `SCHEMA VERIFIED`

**P1-16 — Staff access via `authorizedDriverId` is unaudited.** `admin`/`support` reads of another driver's wallet or location leave no audit record, unlike the Files module's audited operator reads. `CODEBASE VERIFIED`

---

## 29. P2 Findings

Quality, consistency, and maintenance.

**P2-1** — `:driverId` path parameters on `PATCH /:driverId/profile` and `POST /:driverId/documents` are parsed and ignored. Not exploitable; a trap for future readers. `CODEBASE VERIFIED`

**P2-2** — No `EXPIRED` value in `VerificationStatus`; expiry is recorded as `REJECTED` with a magic string reason. `SCHEMA VERIFIED`

**P2-3** — `DriverVerificationStatus.SUSPENDED` is dead; suspension uses the `isSuspended` boolean. `SCHEMA VERIFIED`

**P2-4** — Four of eight declared driver events are never published. `CODEBASE VERIFIED`

**P2-5** — `HeartbeatTimeoutJob` never calls `driverMetrics.heartbeatTimeout()`, and never sweeps drivers with `heartbeatAt = null`. `CODEBASE VERIFIED`

**P2-6** — `ShiftService`, `DriverBankRepository`, `driver.responses.ts`, `InvalidDriverStatusTransitionError`, `DocumentValidationError`, and the five module `plugins/` files are all dead. `CODEBASE VERIFIED`

**P2-7** — `RideStateController` duplicates `actingDriverId` instead of importing `drivers/controllers/driver-identity.ts`. `CODEBASE VERIFIED`

**P2-8** — Three sources of truth for authorization: role slugs (enforced), `PERMISSION_SEED`/`ROLE_PERMISSIONS` (seeded, unenforced), and the Files module's hardcoded `SCOPES_FOR_ROLE`. `CODEBASE VERIFIED`

**P2-9** — `super_admin` does not exist as a seeded role. `SCHEMA VERIFIED`

**P2-10** — `drivers/README.md` claims "0 errors" and "550/550 tests"; actual is 1 type error and 714 unit tests. `CODEBASE VERIFIED` / `TEST VERIFIED`

**P2-11** — `Driver` aggregates and `DriverShiftLog` statistics beyond `totalOnlineMinutes` are never written. `CODEBASE VERIFIED`

**P2-12** — `POST /me/onboard` returns `201` even when returning a pre-existing driver. `CODEBASE VERIFIED`

**P2-13** — `fullLegalName` validates length only; whitespace-only names pass. `gender` has no DB-level enum. `CODEBASE VERIFIED`

**P2-14** — `rejectionReason` is optional when rejecting a driver, so a rejection can carry no explanation. `CODEBASE VERIFIED`

**P2-15** — `onboardDriver` uses `catch (err: any)`. `CODEBASE VERIFIED`

**P2-16** — Twenty-odd `export {};` placeholder files across `src/common/`, `src/infrastructure/`, `src/middleware/`, and `src/shared/`. Left in place per the brief. `CODEBASE VERIFIED`

---

## 30. Existing Code to Reuse

Verified as production-quality and directly usable. **Reusing these is the difference between a small change and a rewrite.**

| Asset                                                                                 | Location                                                    | Why it is ready                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OTP send/verify**                                                                   | `auth/services/otp/` + `/auth/otp/*`                        | Redis challenge claim, hashed storage, challenge binding, multi-axis rate limits, lockout, BullMQ delivery with backoff, full audit rows, verified redaction. **The Driver App needs no new endpoint and no new service.**      |
| **User resolution & session issuance**                                                | `AuthService.runVerifyOtp`                                  | Find-or-create, `P2002` race handling, profile creation, device registration, session, JWT pair, idempotency. Identical for drivers.                                                                                            |
| **`AuthService.grantRole` / `revokeRole`**                                            | `auth.service.ts:256/295`                                   | Idempotent, transactional, publishes `account.role.granted`, bumps the epoch. **Needs a caller, not an implementation.**                                                                                                        |
| **Epoch invalidation**                                                                | `EpochService` + `EpochInvalidationConsumer` + `authPlugin` | Complete stale-token invalidation. Fires automatically once `grantRole` is called.                                                                                                                                              |
| **`authorize()` guard**                                                               | `auth/plugins/auth.plugin.ts`                               | Deny-by-default, roles, `requireOperableDriver`, `requireUntamperedDevice`, fail-closed.                                                                                                                                        |
| **`DriverAccessRepository.isOperableDriver`**                                         | `auth/repositories/`                                        | The eligibility predicate, already applied to five routes.                                                                                                                                                                      |
| **Files upload + validation + read policy**                                           | `files/`                                                    | Presigned PUT, magic-byte/size/dimension/EXIF verification, `DRIVER_DOCUMENT` purpose already defined with `drivers:verify` operator scope and 8-year ARCHIVE retention. **Built for this exact use case.**                     |
| **`registerFileReference`**                                                           | `files/services/file-reference.service.ts`                  | Prevents deletion of a file another module still references. Driver documents need one registration call.                                                                                                                       |
| **Geo stack**                                                                         | `geo/`                                                      | H3 + Redis live store + PostGIS radius with GiST index and graceful degradation. `recordDriverPosition`/`forgetDriverPosition` are already wired from the driver module. `findNearbyDrivers` needs a caller and a state filter. |
| **Outbox + relay + EventBus**                                                         | `core/events/`                                              | Transactional publish, claim-token relay with retry/backoff. Adding a subscriber is one `eventBus.on`.                                                                                                                          |
| **Job scheduler + workers + LockStore**                                               | `jobs/`, `core/cache/stores/LockStore.ts`                   | Cron registration, DI-resolved handlers, Redis distributed locks. Both driver jobs already ride it.                                                                                                                             |
| **`TransactionManager` + `lockForUpdate`**                                            | `core/database/`, `driver.repository.ts:7`                  | Correct `SELECT … FOR UPDATE` pattern, used well throughout. (Note its no-nesting constraint — P0-6.)                                                                                                                           |
| **`DriverDocumentRepository.updateVerificationStatus`**                               | `drivers/repositories/`                                     | Already writes `verifiedAt`/`verifiedBy`/`rejectionReason`. **The document-review service method needs this repository, not a new one.**                                                                                        |
| **`OnboardingService.onboardDriver`**                                                 | `drivers/services/onboarding/`                              | Idempotent, `P2002`-safe, transactional, event-publishing. Correct as-is.                                                                                                                                                       |
| **`StatusService` / `LocationService` / shift repo**                                  | `drivers/services/`                                         | Correct locking, correct gates, correct post-commit Redis handling. Only their inputs are missing.                                                                                                                              |
| **`DispatchService.offerToDriver` + `RideDispatchRepository` + `DispatchTimeoutJob`** | `rides/`                                                    | The dispatch primitives exist. Only the orchestrator is missing.                                                                                                                                                                |
| **`route-graph.test.ts`**                                                             | `tests/integration/`                                        | Pins the public route surface. Keep it green.                                                                                                                                                                                   |
| **The Prisma schema**                                                                 | `prisma/schema/`                                            | Anticipated the whole lifecycle (§23.2).                                                                                                                                                                                        |

---

## 31. Exact Missing Production Transitions

The complete list, ordered by position in the funnel. Each is a **transition**, not a feature.

| #       | Missing transition                                                    | What exists already                                                                                                                                  | What is absent                                                                                                         |
| ------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **T1**  | `driver-onboarding.controller.ts` → compiles                          | Everything else in the file                                                                                                                          | One import statement                                                                                                   |
| **T2**  | Driver app → resumable onboarding state                               | `findByUserId` already includes profile + documents + onlineStatus                                                                                   | `GET /drivers/me` returning 200-with-null instead of 404; a declared required-document set                             |
| **T3**  | Uploaded file → driver document                                       | Files upload/validation/read-policy, `DRIVER_DOCUMENT` purpose, `registerFileReference`                                                              | `fileId` in place of `fileUrl`; an ownership + purpose check on submission; a `DRIVER_DOCUMENT` reference registration |
| **T4**  | **Document `PENDING` → `VERIFIED` / `REJECTED`** ⛔ **FIRST BLOCKER** | `DriverDocumentRepository.updateVerificationStatus` (complete); `verifiedBy`/`verifiedAt`/`rejectionReason` columns; the `drivers:verify` permission | A service method; an admin route; a review queue listing                                                               |
| **T5**  | All required documents verified → driver reviewable                   | `verificationStatus` enum with `DOCUMENT_REVIEW`                                                                                                     | A completeness check; automatic promotion when the last document lands                                                 |
| **T6**  | Driver approval → requires verified documents                         | `reviewDriverVerification` with row locking                                                                                                          | A documents-table check before writing `VERIFIED`                                                                      |
| **T7**  | **Driver `VERIFIED` → `driver` role granted** ⛔ **SECOND BLOCKER**   | `grantRole` (complete, transactional, epoch-bumping); `driver.verified` event; the outbox relay                                                      | A caller — either in the approval transaction or in a `driver.verified` subscriber                                     |
| **T8**  | Role granted → driver app learns it                                   | Epoch bump → `401 TOKEN_STALE` → refresh → new claims                                                                                                | A way to tell the driver at all (P1-13); or a documented poll contract                                                 |
| **T9**  | Vehicle registration → driver assignment                              | Full `Vehicle` / `VehicleType` / `VehicleAssignment` / `VehicleDocument` schema                                                                      | The entire `vehicles` module; `currentVehicleId` maintenance                                                           |
| **T10** | Eligibility → ONLINE                                                  | `setOnline` with all four gates and shift management                                                                                                 | Nothing in `setOnline` — it is blocked by T4. Add licence-expiry and (if required) vehicle checks                      |
| **T11** | Location ingestion → gated by eligibility                             | `LocationService` with plausibility and mock-GPS rejection                                                                                           | An operability gate on the location/heartbeat/offline routes                                                           |
| **T12** | **`ride.requested` → nearby drivers discovered** ⛔                   | `findNearbyDrivers` (complete); `ride.requested` published; the EventBus                                                                             | A subscriber, and a driver-state filter on the query                                                                   |
| **T13** | Candidates → offers created                                           | `offerToDriver` (complete); `RideDispatch` schema with `dispatchRound`                                                                               | The orchestrator that calls it in rounds                                                                               |
| **T14** | Offer → driver notified                                               | —                                                                                                                                                    | Any push/realtime channel (none exists)                                                                                |
| **T15** | Offer timeout → next driver                                           | `DispatchTimeoutJob` marks `TIMEOUT`                                                                                                                 | Re-offer logic; `NO_DRIVERS_FOUND` terminal handling                                                                   |
| **T16** | Accept → offer validated                                              | `findByRequestAndDriver`, `updateResponse` (both zero-caller)                                                                                        | Calls to them in `acceptRideRequest`                                                                                   |
| **T17** | Accept → driver becomes unavailable                                   | `DriverStatus.BUSY` / `ON_TRIP` enum values                                                                                                          | Any writer; plus a `findActiveByDriver` check                                                                          |
| **T18** | Complete → driver available again, aggregates updated                 | Ride completion + ledger posting                                                                                                                     | Status restoration; `Driver`/`DriverShiftLog` statistic updates                                                        |
| **T19** | Suspend → driver taken offline                                        | `setSuspended` + `setOffline`                                                                                                                        | A non-deadlocking composition (P0-6)                                                                                   |
| **T20** | Every admin action → audit trail                                      | Outbox with `classification: 'audit'`                                                                                                                | Either an `AuditLog` model or a documented decision to rely on the outbox                                              |

---

## 32. Recommended Implementation Order

Sequencing only. **No implementation was performed, and none should begin before your decision.**

**Stage 0 — Unblock the build (minutes)**
T1. One import. Nothing else can be verified until `tsc` is clean. Consider adding `npm run typecheck` to CI alongside `npm test`, since `tsx` hides type errors (§25).

**Stage 1 — Close the funnel: document review and role assignment (the critical path)**
T4 → T6 → T7. This is the smallest change set that turns the lifecycle from impassable to passable end to end:

- a document-review service method over the existing `updateVerificationStatus`, plus an admin route
- a documents check inside `reviewDriverVerification`
- a `grantRole(userId, 'driver')` call on approval

On T7, the transactional-vs-event question is a real decision and worth making deliberately: an in-transaction grant is atomic but couples the driver module to `AuthService`; a `driver.verified` subscriber is decoupled but introduces an at-least-once, asynchronous window between `VERIFIED` and the role landing. **The outbox makes the event path safe (no lost grants), and `grantRole` is already idempotent, so a redelivery is harmless.** That combination argues for the event path — but it is your call, and it changes what the driver app must tolerate.

**Stage 2 — Secure the document pipeline**
T3, plus P0-5 and P1-7/P1-8/P1-9. Move to `fileId`, validate ownership and purpose, register the `DRIVER_DOCUMENT` file reference, add the unique constraint, clear stale review metadata on re-upload, and let rejected drivers re-enter review. Note this requires a schema change (P0-5, §23.3) — flagged, not created.

**Stage 3 — Make onboarding resumable and observable**
T2, plus P1-14. `GET /drivers/me` returning a stable shape, a declared required-document set, and Fastify schemas on the driver routes so the surface is documented and serialised.

**Stage 4 — Fix the operational defects**
P0-6 (suspend deadlock), P1-11 (body validation), P1-6 (licence expiry at go-online), P1-4 (gate location ingestion), P1-16 (audit staff access).

**Stage 5 — Vehicles**
T9. Required only if going online or accepting rides is to demand a vehicle. The schema is complete; the module is empty. Decide the requirement before building.

**Stage 6 — Ride-acceptance integrity**
T16, T17, T18, plus P1-1 and P1-2. These matter the moment a real driver can accept a real ride.

**Stage 7 — Dispatch**
T12 → T13 → T15, plus P1-5. Largest and last, because it depends on drivers existing, being online, and being filterable.

**Stage 8 — Notifications**
T14, P1-13. Genuinely new infrastructure. Dispatch is of limited use without it, which is a reason to decide its shape before Stage 7 rather than after.

**Cross-cutting:** every stage should add the missing HTTP-level test (§25.3 shows zero coverage for every driver route). Consider one integration test that walks OTP → onboard → profile → document → verify → approve → role → online **without a single direct database write** — that test is the definition of done for this work, and it cannot pass today.

---

## 33. What MUST NOT Be Rebuilt

Verified as working. Rebuilding any of these would destroy tested, correct code.

| Do not rebuild                                                  | Because                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OTP send/verify**                                             | Complete and hardened. The Driver App uses the same two endpoints. Building a driver OTP service would duplicate the rate limiting, lockout, challenge binding, and redaction — and split the audit trail.                                 |
| **Auth / sessions / tokens / refresh rotation**                 | Complete, with reuse detection, session caps, device binding, and deny-by-default.                                                                                                                                                         |
| **The epoch mechanism**                                         | Correct and automatic. It will work for drivers the instant `grantRole` is called.                                                                                                                                                         |
| **`AuthService.grantRole` / `revokeRole`**                      | Already idempotent, transactional, event-publishing, and epoch-bumping. **It needs a caller, not a reimplementation.**                                                                                                                     |
| **The `User` identity model**                                   | `User` is canonical; `Driver` is a 1:1 optional extension. Do not create a separate driver identity.                                                                                                                                       |
| **`User.email` as the canonical email**                         | Do not add an email column to `DriverProfile`. Fix the driver write path to go through `UserRepository.updateEmail`.                                                                                                                       |
| **The Files module**                                            | Complete: presigned upload, magic-byte/size/EXIF validation, purpose policies, operator read scopes, retention/sweeper/reconciliation jobs. The `DRIVER_DOCUMENT` purpose already exists. Connect to it; do not build a driver file store. |
| **The Geo module**                                              | Complete and well tested, with graceful Redis degradation. Position recording is already wired. Add a caller and a state filter; do not rewrite it.                                                                                        |
| **The outbox / relay / EventBus**                               | Transactional publish with retry and claim tokens. Add subscribers; do not build a second bus.                                                                                                                                             |
| **The job scheduler, workers, and `LockStore`**                 | Both driver jobs already ride it correctly.                                                                                                                                                                                                |
| **`TransactionManager` and the `lockForUpdate` pattern**        | Correct and used consistently. Respect its no-nesting constraint (P0-6).                                                                                                                                                                   |
| **`OnboardingService.onboardDriver`**                           | Explicit, idempotent, `P2002`-safe, transactional. Already matches the target design.                                                                                                                                                      |
| **`StatusService`, `LocationService`, `DriverShiftRepository`** | Correct locking, correct gates, correct post-commit Redis handling. Their inputs are missing, not their logic.                                                                                                                             |
| **`requireOperableDriver` / `DriverAccessRepository`**          | Correct, fail-closed, already applied to five routes.                                                                                                                                                                                      |
| **The `actingDriverId` / `authorizedDriverId` pattern**         | Correct BOLA handling with a staff bypass. Reuse it; `RideStateController` should import rather than duplicate it.                                                                                                                         |
| **The Prisma schema for driver, vehicle, and dispatch**         | Anticipated the entire lifecycle. Additive changes only (§23.3).                                                                                                                                                                           |
| **Backend-controlled role assignment**                          | Already enforced structurally — no request schema anywhere accepts a role. **Preserve this property.**                                                                                                                                     |
| **The Rides state machine**                                     | Transition table, row locks, compare-and-set updates, ownership checks, OTP start verification, ledger posting — all correct.                                                                                                              |
| **`route-graph.test.ts`**                                       | The best existing guard on the public route surface.                                                                                                                                                                                       |

---

## 34. Final Production Readiness Decision

> ### ❌ **NOT PRODUCTION READY**

**The precise state.** This is not an unbuilt module. Roughly 80% of the driver surface is implemented, correctly transactional, properly locked, and wired to live HTTP routes. What is missing is **three transitions in the middle of the funnel**, and their absence severs the chain so completely that nothing downstream can be reached by any real client:

1. **Document `PENDING` → `VERIFIED`** — no writer exists anywhere in production code
2. **Driver approved → `driver` role granted** — `grantRole` has zero production callers
3. **Ride requested → drivers discovered** — dispatch is two `export {};` files and a set of unconnected primitives

Plus one defect that stops the build outright: a single missing import.

**What works today, over real HTTP, with no database access:** OTP send and verify; user creation and session issuance; explicit driver onboarding; profile capture including name, gender, and email; document submission. That is a genuinely working front half.

**What cannot happen at all:** document verification; automatic role assignment; going online; suspension; dispatch; any notification to the driver.

**The most important thing this investigation found**, beyond the individual defects, is how much is already built and merely disconnected. `grantRole` is complete, idempotent, transactional, and epoch-bumping — it needs one caller. `DriverDocumentRepository.updateVerificationStatus` already writes `verifiedAt` and `verifiedBy` — it needs one service method and one route. `findNearbyDrivers` and `offerToDriver` are both complete — they need an orchestrator. The Files module already defines the `DRIVER_DOCUMENT` purpose with an operator `drivers:verify` scope and an 8-year retention rule named `DRIVER_RELATIONSHIP_ENDED`. The schema anticipated all of it.

**The risk in the next phase is therefore not under-building — it is rebuilding.** The correct plan is small, surgical, and mostly consists of connecting things that already exist.

**One process observation.** The unit suite is green (714/714) while the repository does not typecheck, because `tsx` strips types without checking them, and every test that needs a working driver manufactures one with three direct `INSERT`s. Both P0-2 and P0-3 would have been caught immediately by a single integration test that walks the lifecycle without touching the database. That test does not exist, and writing it should be treated as part of the fix rather than as follow-up.

---

## 15 · Final Decision Format

**1. Is the existing Customer OTP/Auth flow reusable for Driver?**
**YES.** `CODEBASE VERIFIED` — One `OtpService` with a single `LOGIN` purpose serves both apps. `AuthService.runVerifyOtp` has no driver-specific branch. No duplicate OTP service exists or is needed.

**2. Is the Driver onboarding module already implemented?**
**PARTIAL.** `CODEBASE VERIFIED` — `POST /drivers/me/onboard` is explicit, idempotent, `P2002`-safe, transactional, and event-publishing. But `GET /drivers/me` does not compile, `src/modules/onboarding/` is `export {};`, and there is no gate on who may apply.

**3. Is Driver profile collection production-ready?**
**PARTIAL.** `CODEBASE VERIFIED` — Name, gender, and email persist through a validated, transactional endpoint. But email is written via a private path that returns 500 on a unique collision and never manages `isEmailVerified`; every field is optional with no completeness definition; the `:driverId` parameter is ignored; and no event is published.

**4. Can documents be submitted securely through Files?**
**NO.** `CODEBASE VERIFIED` — Documents bypass Files entirely. `fileUrl: z.string().url()` accepts any client-supplied URL. No ownership check, no existence check, no content inspection. The `DRIVER_DOCUMENT` purpose exists in Files, fully specified, with zero consumers.

**5. Can documents be verified through a real production API?**
**NO.** `CODEBASE VERIFIED` — The only writers of `DriverDocument.verificationStatus` are the driver's submission (`PENDING`) and `DocExpirationJob` (`REJECTED`). No route, no service method with a caller, no job, no subscriber writes `VERIFIED`. The only `VERIFIED` writes in the repository are in `tests/integration/helpers/fixtures.ts`.

**6. Can an admin approve a Driver through a real production API?**
**YES.** `CODEBASE VERIFIED` — `POST /api/v1/drivers/:id/verify`, guarded by `roles: ['admin']`, writes `VERIFIED` under a row lock with `approvedAt`/`approvedBy` and publishes `driver.verified`.
⚠️ _With three serious caveats:_ it approves with zero documents; it grants no role; and there is no queue for finding who needs approving.

**7. Is the DRIVER role automatically assigned by backend after approval?**
**NO.** `CODEBASE VERIFIED` — `AuthService.grantRole` has zero production callers (definition + 28 test references). `driver.verified` has no subscriber; `EpochInvalidationConsumer` is the only subscriber in the codebase. No role, no epoch bump, no new claims.

**8. Can a fully approved Driver pass all eligibility gates?**
**NO.** `CODEBASE VERIFIED` — They pass `requireOperableDriver` (which checks the Driver row, not the role) and are then rejected by `StatusService.setOnline`'s requirement for a `VERIFIED` `DRIVING_LICENSE` — a status no production code can produce.

**9. Can the Driver go ONLINE in a real production flow?**
**NO.** `CODEBASE VERIFIED` — Blocked by Q5/Q8. `setOnline` throws `DriverNotVerifiedError` for every driver in the system, regardless of admin approval.

**10. Is the Vehicle module production-ready?**
**NO.** `CODEBASE VERIFIED` / `SCHEMA VERIFIED` — `src/modules/vehicles/index.ts` is `export {};`. No routes, services, repositories, or DI registration. The schema is complete (`Vehicle`, `VehicleType`, `VehicleDocument`, `VehicleImage`, `VehicleInspection`, `VehicleAssignment`) and `VehicleType` is read by fare quoting, but `VehicleAssignment` and `Driver.currentVehicleId` have zero hand-written references.

**11. Is Geo discovery actually reachable from dispatch?**
**NO.** `CODEBASE VERIFIED` — `GeoService.findNearbyDrivers` has zero production callers. Position _recording_ is wired (`LocationService` → `recordDriverPosition`; `StatusService.setOffline` → `forgetDriverPosition`); position _discovery_ is not. No geo routes exist.

**12. Is matching/dispatch production-ready?**
**NO.** `CODEBASE VERIFIED` — `src/modules/dispatch/` and `src/modules/matching/` are `export {};`. `offerToDriver`, `findByRequestAndDriver`, `updateResponse`, and `findNearbyDrivers` all have zero production callers. `ride.requested` has no subscriber. No `RideDispatch` row is ever created. `BUSY`/`ON_TRIP` are never written. `DispatchTimeoutJob` is scheduled and operates on a permanently empty table.

**13. Can the complete Driver lifecycle work without direct database manipulation?**
**NO.** `CODEBASE VERIFIED` — Two direct database writes are unavoidable today: setting `DriverDocument.verificationStatus = 'VERIFIED'` (no API exists) and inserting a `user_role_assignments` row for `driver` (no API exists, `grantRole` is uncalled). These are exactly the two shortcuts `tests/integration/helpers/fixtures.ts` performs, which is why the test suite is green and the lifecycle is not.

---

## Investigation Constraints Honoured

- ❌ No production code written or modified
- ❌ No migrations created
- ❌ No refactoring performed
- ❌ No empty folders deleted
- ❌ No missing modules implemented
- ❌ No implementation plan generated
- ❌ No conclusions drawn from folder names alone — every folder was opened and its contents read or byte-counted
- ✅ Only this artifact created: `docs/DRIVER_PLATFORM_EXISTING_CODEBASE_INVESTIGATION.md`

**Awaiting your decision before `/speckit.plan`, `/speckit.tasks`, or `/speckit.implement`.**
