# Platform — Full Workflow and Module Ownership Audit

**Repository:** `backend_zaroorat` · **Branch:** `feature/auth` · **HEAD:** `269e927`
**Date:** 2026-08-20
**Type:** Read-only. No code modified, moved, or renamed. No migration, no module, no spec. Nothing fixed.

**Evidence labels:** `CODEBASE VERIFIED` · `TEST VERIFIED` · `SCHEMA VERIFIED` · `BUILD VERIFIED` · `INFERENCE`
**Status vocabulary:** `WORKING` · `PARTIAL` · `DISCONNECTED` · `MISSING` · `BLOCKED` · `STUB` · `NOT_VERIFIABLE`

> **Standing note on repeated verification.** This is the third full-platform pass. The working tree is **byte-identical** to the previous two audits — same HEAD `269e927`, clean `git status`. Every conclusion below was re-verified against the current code, and **every one is unchanged**. The single genuinely new artifact in this pass is the **eight-invariant database protection table** (§21), which resolves the last open integrity question: `VehicleAssignment` has **no unique constraint**.
>
> Companion reports: `docs/FULL_PLATFORM_DRIVER_WORKFLOW_INVESTIGATION.md`, `docs/DRIVER_PLATFORM_COMPLETE_WORKFLOW_AND_MODULE_AUDIT.md`.

---

## 1. Executive Summary

**Well-built modules, disconnected at five specific seams.** This is a wiring problem, not a build problem.

**Health:** typecheck `PASS`, lint `PASS`, build completes end-to-end, 714/714 unit tests, working tree clean. Only `format:check` fails — 34 files, **all outside `src/`** — and it is **CI's first gate**, so nothing merges until it is resolved. `BUILD VERIFIED`

**Eight findings define the platform:**

1. **The lifecycle stops at document `PENDING → VERIFIED`** — step 8 of 30. No route, service, job, or subscriber writes `VERIFIED`. Since `setOnline` requires a verified licence, **no driver can ever go online**.
2. **Ride completion already posts a correct double-entry ledger transaction** in the same transaction as the status write, branching properly on cash vs prepaid. Driver earnings **are** recorded.
3. **The money never surfaces.** `SettlementJob` is DI-registered as `settlementJob` and absent from **both** `JOB_SCHEDULES` and `MAINTENANCE_HANDLERS`; `DriverWallet` is **only ever created, never updated**. The wallet reads zero forever.
4. **Three of eight critical database invariants are `NOT_PROTECTED`** — one document per driver/type, one active ride per driver, one active vehicle assignment per driver. §21.
5. **Four zero-caller symbols summarise everything:** `grantRole`, `offerToDriver`, `findActiveByDriver` each have **exactly 1 reference in `src/`** — their own definition.
6. **One event subscriber exists platform-wide.** Every other event is durably outboxed and triggers nothing.
7. **`Drivers → Auth` would NOT cycle.** `DriverAccessRepository` imports only `@core/database`; the coupling is schema-level. Both role-assignment mechanisms are structurally safe.
8. **Zero files should move to another top-level module.** The only genuine placement issues are _internal_ to `drivers/`.

---

## 2. Current Platform Module Map

`CODEBASE VERIFIED` — 23 modules.

| Module                                                                                                          | Status      | Routes             | Jobs                                              | Notes                                        |
| --------------------------------------------------------------------------------------------------------------- | ----------- | ------------------ | ------------------------------------------------- | -------------------------------------------- |
| `auth`                                                                                                          | **WORKING** | `/api/v1/auth`     | `auth-retention`, `otp-delivery`                  | Only module with an event subscriber         |
| `users`                                                                                                         | **WORKING** | `/api/v1/users`    | `account-erasure`                                 | —                                            |
| `files`                                                                                                         | **WORKING** | `/api/v1/files`    | `sweeper`, `retention`, `reconciliation`          | 5 purposes; only `PROFILE_IMAGE` consumed    |
| `payments`                                                                                                      | **PARTIAL** | `/api/v1/payments` | `reconciliation` ✅ · **`settlement` ❌**         | Ledger correct; settlement never runs        |
| `rides`                                                                                                         | **PARTIAL** | `/api/v1/rides`    | `dispatch-timeout`, `request-expiry`              | Lifecycle solid; dispatch half unreachable   |
| `drivers`                                                                                                       | **PARTIAL** | `/api/v1/drivers`  | `heartbeat-timeout` ✅ · `doc-expiration` (inert) | Stops at document review                     |
| `geo`                                                                                                           | **PARTIAL** | none               | none                                              | Write path wired; read path unwired          |
| `notifications`                                                                                                 | **PARTIAL** | none               | none                                              | SMS only; **no push**                        |
| `vehicles`                                                                                                      | **STUB**    | none               | none                                              | Full schema, `export {};`                    |
| `dispatch`, `matching`                                                                                          | **STUB**    | none               | none                                              | Primitives live in `rides/`                  |
| `admin`, `support`                                                                                              | **STUB**    | none               | none                                              | 2 admin routes live in `drivers/`            |
| `documents`, `onboarding`, `riders`, `pricing`, `promotions`, `reviews`, `chat`, `sos`, `analytics`, `settings` | **STUB**    | none               | none                                              | `export {};` + identical boilerplate READMEs |

**Registered HTTP surface (complete):** `/health`, `/ready`, `/metrics`, `/api/v1/{auth,users,files,rides,drivers,payments}`. No `/api/v1/admin`, `/support`, `/vehicles`, `/geo`, or `/notifications`.

---

## 3. End-to-End Customer Workflow

`CODEBASE VERIFIED`

```
phone → POST /auth/otp/send  →  OtpService.send  [WORKING]
     → POST /auth/otp/verify →  AuthService.verifyOtp (one transaction) [WORKING]
        find-or-create User → ensureDefaultRole('customer') → session → JWT
     → GET/PATCH /users/me/*                                 [WORKING]
     → POST /rides/quote                                     [WORKING]
     → POST /rides/requests → RideRequest(CREATED)           [WORKING]
        └─ publish ride.requested → ZERO SUBSCRIBERS         [DISCONNECTED]
     → matching / nearby discovery                           [MISSING]
```

The customer path is production-solid up to ride request. **It then stops** — nothing consumes `ride.requested`.

---

## 4. End-to-End Driver Workflow

`CODEBASE VERIFIED` — status per arrow.

| Arrow                         | Status           | Evidence                                           |
| ----------------------------- | ---------------- | -------------------------------------------------- |
| phone → OTP → User/JWT        | **WORKING**      | Same two endpoints as Customer; no driver branch   |
| → `POST /drivers/me/onboard`  | **WORKING**      | Explicit, idempotent, `P2002`-safe                 |
| → profile (name/gender/email) | **PARTIAL**      | Persists; email via raw `client.user.update`       |
| → file upload via Files       | **DISCONNECTED** | `drivers/` never imports `@modules/files`          |
| → document submission         | **PARTIAL**      | Works; `fileUrl: z.string().url()` accepts any URL |
| → **document review**         | **MISSING**      | ⛔ **No writer of `VERIFIED` anywhere**            |
| → driver approval             | **PARTIAL**      | Route works; approves with zero documents          |
| → **DRIVER role**             | **DISCONNECTED** | `grantRole` 1 ref = definition                     |
| → eligibility                 | **BLOCKED**      | by document review                                 |
| → online                      | **BLOCKED**      | `setOnline` needs a `VERIFIED` licence             |
| → location                    | **PARTIAL**      | Works with **no eligibility gate**                 |
| → geo availability            | **WORKING**      | PostGIS + H3 + Redis                               |
| → nearby discovery            | **DISCONNECTED** | `findNearbyDrivers` 0 callers outside geo          |
| → matching                    | **STUB**         | `export {};`                                       |
| → dispatch / offer            | **DISCONNECTED** | `offerToDriver` 1 ref = definition                 |
| → notification delivery       | **MISSING**      | No push exists                                     |
| → accept                      | **PARTIAL**      | No offer validation                                |
| → vehicle validation          | **MISSING**      | Nothing validated                                  |
| → BUSY / ON_TRIP              | **MISSING**      | No writer anywhere                                 |
| → ride start / complete       | **WORKING**      | Row locks, CAS, start-OTP                          |
| → payment ledger              | **WORKING**      | `recordTripPayment` in-transaction                 |
| → driver earnings             | **WORKING**      | `DRIVER_PAYABLE` posted                            |
| → settlement                  | **DISCONNECTED** | Job never scheduled                                |
| → wallet projection           | **MISSING**      | `DriverWallet` never updated                       |
| → payout readiness            | **MISSING**      | `DriverBankRepository` 0 callers                   |

---

## 5. Auth / OTP / User / Files Ownership Map

`CODEBASE VERIFIED` — all four are **WORKING** and correctly owned.

| Concern                                                              | Owner   | Verified                                                     |
| -------------------------------------------------------------------- | ------- | ------------------------------------------------------------ |
| OTP generation/verification, challenge binding, rate limits, lockout | `auth`  | Single `AUTH_OTP_PURPOSE = 'LOGIN'` serves both apps         |
| JWT, sessions, refresh rotation, reuse detection, session caps       | `auth`  | —                                                            |
| Roles, `grantRole`/`revokeRole`, security epoch                      | `auth`  | `uq_user_role_active` partial unique                         |
| `User` identity, `users.email`, `UserProfile`                        | `users` | `Driver` is a 1:1 optional extension                         |
| `UserDevice.fcmToken` storage                                        | `auth`  | Written at OTP verify; **never read**                        |
| File bytes, storage, metadata, upload authorization, access rules    | `files` | 5 purposes, magic-byte + EXIF validation, scan state machine |

**Answers to Phase 2:**

| #   | Question                                         | Answer                                                                                              |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | Same User shared between Customer and Driver?    | **YES** — `Driver.userId @unique` FK to `User.id`                                                   |
| 2   | Does becoming a Driver create a separate User?   | **NO**                                                                                              |
| 3   | Can Customer login accidentally create a Driver? | **NO** — fixed today in `b7f7da7`; the prior HEAD called `createOrGetDriver` from `GET /drivers/me` |
| 4   | Is driver creation explicit?                     | **YES** — `POST /drivers/me/onboard`                                                                |
| 5   | Does `GET /drivers/me` write?                    | **NO** — pure `findByUserId`                                                                        |
| 6   | Is onboard idempotent + concurrency-safe?        | **YES** — read-then-create, `P2002` re-read, `drivers_user_id_key` backstop                         |
| 7   | Name/Gender/Email persistence                    | Name+gender → `driver_profiles`; email → `users.email` **via raw Prisma write** ⚠️                  |
| 8   | Can onboarding resume?                           | **YES** — `findByUserId` returns profile + documents + onlineStatus in one read                     |
| 9   | How is the driver role assigned?                 | **It is not**                                                                                       |
| 10  | Is Auth dependent on Drivers?                    | **No import edge** — schema-level read only                                                         |
| 11  | Would `Drivers → Auth` cycle?                    | **NO**                                                                                              |
| 12  | Are role revocations durable?                    | **NO for the default role** — `ensureDefaultRole` runs on **every** login and silently re-grants    |
| 13  | Is `DEFAULT_USER_ROLE` validated at startup?     | **NO** — absent from `EnvironmentSchema`                                                            |
| 14  | Can config assign a privileged role?             | **YES** — `DEFAULT_USER_ROLE=admin` grants admin to every account at login                          |

**Roles are un-injectable by construction:** no `role`/`roles`/`userType`/`appType` field in any auth request schema; Zod strips unknown keys; roles read from `user_roles` at issuance and re-read on refresh.

---

## 6. Driver Module Ownership Map

`CODEBASE VERIFIED` — 54 files, 19 directories, none empty.

| Responsibility                       | Location                                                 | Classification                                   |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------ |
| Onboarding, profile                  | `services/onboarding/` (2 of 4 methods)                  | `KEEP_IN_DRIVERS`                                |
| Document submission                  | `submitDocument` **inside onboarding service**           | `KEEP_IN_DRIVERS` (wrong submodule)              |
| Document persistence                 | `repositories/driver-document.repository.ts`             | `KEEP_IN_DRIVERS`                                |
| Driver approval                      | `reviewDriverVerification` **inside onboarding service** | `KEEP_IN_DRIVERS` (wrong submodule)              |
| Status / eligibility                 | `services/status/`                                       | `KEEP_IN_DRIVERS` / `CROSS_MODULE_ORCHESTRATION` |
| Shifts                               | `driver-shift.repository.ts` ✅ / `ShiftService`         | `KEEP_IN_DRIVERS` / `DEAD_CODE`                  |
| Location + plausibility              | `services/location/`                                     | `KEEP_IN_DRIVERS`                                |
| Wallet read projection               | `services/wallet/`                                       | `KEEP_IN_DRIVERS`                                |
| Bank accounts                        | `driver-bank.repository.ts`                              | `NEEDS_DECISION` — 0 callers                     |
| Events, jobs, metrics, errors, types | respective folders                                       | `KEEP_IN_DRIVERS`                                |

**`MOVE_TO_ANOTHER_MODULE`: zero files.** `CODEBASE VERIFIED`

**`DEAD_CODE`:** `plugins/driver.plugin.ts`, `schemas/driver.responses.ts`, `services/shift/shift.service.ts`, `DriverWalletRepository.lockForUpdate`, `InvalidDriverStatusTransitionError`, `DocumentValidationError`, `DriverMetrics.heartbeatTimeout`, `DriverVerificationStatus.SUSPENDED`, `driverConfig.requireApprovedDocuments`, `driverConfig.maxContinuousShiftHours`, 4 unpublished events.

**`DUPLICATED`:** `actingDriverId` re-implemented privately in `rides/controllers/ride-state.controller.ts`; two write paths to `users.email`.

---

## 7. Correct Driver Internal Folder Placement

Only folders with enough real code to justify them.

| Proposed        | Justified?   | Existing code                                                                                                                                              |
| --------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents/`    | **YES**      | `driver-document.repository.ts`, `submitDocument`, `doc-expiration.job.ts`, `submitDriverDocumentSchema`, 1 route — **plus the missing review lands here** |
| `verification/` | **YES**      | `reviewDriverVerification`, `reviewVerificationSchema`, 1 route — **plus the `grantRole` hook**                                                            |
| `onboarding/`   | **YES**      | `onboardDriver`, `updateProfile`, `getMe`, `driver-code.util`                                                                                              |
| `status/`       | **YES**      | `StatusService`, `driver-status.repository`, `heartbeat-timeout.job`, `heartbeatSchema`, 4 routes                                                          |
| `location/`     | **YES**      | `LocationService`, `location-plausibility`, `driver-location.repository`, 2 routes                                                                         |
| `shift/`        | **MARGINAL** | Only `driver-shift.repository.ts` (the service is dead)                                                                                                    |
| `wallet/`       | **YES**      | `DriverWalletViewService`, `driver-wallet.repository`, 2 routes                                                                                            |
| `profile/`      | **NO**       | Two methods and one schema — scaffolding without substance; keep in `onboarding/`                                                                          |
| `earnings/`     | **NO**       | Zero Drivers code; Payments owns it                                                                                                                        |

**Highest-value extraction: `documents/` + `verification/`** (~8 file moves). Doing it _before_ writing document review means writing that feature once, in the right place. The full vertical split (~35 files) is optional.

---

## 8. File / Document Ownership Boundaries

`CODEBASE VERIFIED`

| Concern                                                                                                                    | Owner       | State                              |
| -------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------- |
| Physical bytes, object storage, upload authorization, file metadata, access rules                                          | **Files**   | ✅ Complete, **unused by Drivers** |
| Driver KYC record, document type/number, expiry, verification status, rejection reason, reviewer, eligibility consequences | **Drivers** | ✅ Correctly owned                 |

**Current integration: (B) — client-supplied URL.** `fileUrl: z.string().url()`. No `fileId`, no ownership check, no purpose check, no existence check, no scanning.

| Check                                   | Result                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| File ownership validated?               | **NO** — no file record is referenced                                                                              |
| Purpose enforced?                       | **NO**                                                                                                             |
| Arbitrary URLs submittable?             | **YES**                                                                                                            |
| Replacing a document safe?              | **PARTIAL** — status resets to `PENDING` ✅, but `verifiedBy`/`verifiedAt`/`rejectionReason` **survive untouched** |
| Duplicate submissions concurrency-safe? | **NO** — `findFirst`-then-`create` with no unique index                                                            |

**Files already provides, with zero consumers:** `DRIVER_DOCUMENT` purpose (10 MB, jpeg/png/webp/pdf, `rejectExifLocation: true`, 300 s read TTL, 2920-day ARCHIVE on `DRIVER_RELATIONSHIP_ENDED`), `decideRead` with a `drivers:verify` operator scope (held by `admin`, deliberately not `support`), and `registerFileReference`.

> **`DriverDocument` should NOT move to Files.** Files owns bytes; Drivers owns the KYC record. Document types are entirely driver KYC, and `VehicleDocument` already exists as a separate model — the schema author chose per-domain document tables. `INFERENCE`

---

## 9. Driver Onboarding Verification

| Check                                   | Result                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Explicit onboarding                     | ✅ `POST /drivers/me/onboard`                                              |
| Idempotency                             | ✅ Returns the existing row                                                |
| `P2002` / concurrency                   | ✅ Caught, winner re-read                                                  |
| BOLA / IDOR                             | ✅ `callerId(req)` from JWT `sub`; `:driverId` parsed and **ignored**      |
| Identity mapping                        | ✅ JWT-derived only                                                        |
| Profile validation                      | ⚠️ `fullLegalName` length-only; `gender` Zod-enum but bare `String?` in DB |
| Resume behaviour                        | ✅ Server-side state complete                                              |
| Onboarding completion                   | **Derived**, not explicit                                                  |
| Documents before required profile data? | ❌ **YES** — `submitDocument` never reads the profile                      |

> **An `onboardingStep` column is not required.** `Driver.verificationStatus` is the explicit state, and `findByUserId` returns everything needed in one read. What is missing is a **declared required-document set**, not a new column. `INFERENCE`

---

## 10. Document Review Verification

**Every writer of `DriverDocument.verificationStatus`**, exhaustive. `CODEBASE VERIFIED`

| Status         | Production writer                                                         |
| -------------- | ------------------------------------------------------------------------- |
| `PENDING`      | `DriverDocumentRepository.upsertDocument` (both branches)                 |
| `REJECTED`     | `DocExpirationJob:23` — **the only caller of `updateVerificationStatus`** |
| **`VERIFIED`** | **NONE**                                                                  |

| Question                          | Answer                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| Admin review route?               | **NO**                                                            |
| Review service?                   | **NO**                                                            |
| Is the repository method called?  | **Once**, by the expiry job, always with `REJECTED`               |
| Individual document verification? | **NO**                                                            |
| Rejection with reason?            | **NO** (expiry writes a fixed string)                             |
| Reviewer identity stored?         | **NO** — `verifiedBy` never written                               |
| Expiry job scheduled?             | **YES** — `0 2 * * *`, DI-resolved, Redis-locked                  |
| Does it have data to operate on?  | **NO** — its query needs `VERIFIED` documents, which cannot exist |

> **`PENDING → VERIFIED` is a DISCONNECTED lifecycle transition.** The repository method supports it with `verifiedAt`/`verifiedBy`; nothing calls it that way.

**Two further defects:** a `REJECTED` driver who re-uploads stays `REJECTED` (promotion happens only from exactly `PENDING`), and stale review metadata survives re-upload.

---

## 11. Driver Approval + Role Assignment Verification

| #   | Question                                     | Answer                                                                                                               |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Can an admin approve a driver today?         | **YES** — `POST /api/v1/drivers/:id/verify`, `roles:['admin']`                                                       |
| 2   | Can approval happen with zero documents?     | **YES** — documents table never queried                                                                              |
| 3   | Is `requireApprovedDocuments` present?       | **YES**, default `true`                                                                                              |
| 4   | Is it consumed?                              | **NO — zero consumers**                                                                                              |
| 5   | Which documents are required?                | **None declared anywhere in `src/`**                                                                                 |
| 6   | Is required-document validation centralized? | **No such validation exists**                                                                                        |
| 7   | Does approval grant the `driver` role?       | **NO**                                                                                                               |
| 8   | Production callers of `grantRole`            | **0** (1 ref = definition; 28 test refs)                                                                             |
| 9   | Consumers of `DRIVER_EVENT_CATALOG.VERIFIED` | **0**                                                                                                                |
| 10  | `eventBus.on` registrations                  | **1** — `epoch-invalidation.consumer.ts:17`                                                                          |
| 11  | Existing cross-module event pattern          | `EventPublisher.publish(input, tx?)` → `event_outbox` → `OutboxRelay` (claim token, retry/backoff) → `EventBus.emit` |
| 12  | Outbox behaviour                             | Transactional publish; durable; at-least-once on relay                                                               |
| 13  | Is event-driven safer than a direct call?    | **Neither is unsafe** — §11.1                                                                                        |
| 14  | Circular dependency risk                     | **NONE**                                                                                                             |

**Token propagation, verified:** `grantRole` → `epochService.bump` → `authPlugin` compares `claims.epoch` → `401 TOKEN_STALE` → client refreshes → `resolveActiveRoles` re-reads the database. **Existing tokens do not immediately gain the role; a refresh is required.**

### 11.1 The two mechanisms

|                   | A — in the approval transaction              | B — `driver.verified` subscriber                                |
| ----------------- | -------------------------------------------- | --------------------------------------------------------------- |
| Cycle             | none                                         | none                                                            |
| Atomicity         | strong — role and status commit together     | eventual window                                                 |
| Precedent in repo | none                                         | **matches `EpochInvalidationConsumer`, the only consumer**      |
| Failure mode      | rolls back visibly                           | outbox retry ⇒ at-least-once; `grantRole` idempotent ⇒ harmless |
| Caution           | epoch bump fires **before** the outer commit | app must tolerate the window                                    |

**Recommendation on evidence, not preference:** **B is the better fit** — it is the only cross-module side-effect pattern the repository already uses, the outbox guarantees no lost grants, and `grantRole` is idempotent twice over. **A is also safe** and simpler. The trade-off is atomicity vs decoupling, and it is the owner's call. `INFERENCE`

---

## 12. Eligibility and Online Verification

`setOnline`, one transaction after `lockForUpdate`:

| Gate                                  | Present                    | Status                         |
| ------------------------------------- | -------------------------- | ------------------------------ |
| Driver exists                         | ✅                         | `WORKING`                      |
| `verificationStatus === 'VERIFIED'`   | ✅ guard **and** service   | `WORKING`                      |
| `!isSuspended`                        | ✅ both                    | `WORKING`                      |
| **`DRIVING_LICENSE` with `VERIFIED`** | ✅                         | **`IMPOSSIBLE TO SATISFY`**    |
| Existing active shift                 | ✅ idempotent `startShift` | `WORKING`                      |
| `driver` role                         | ❌                         | `MISSING`                      |
| Vehicle                               | ❌                         | `MISSING` (correct per schema) |
| Active-ride conflict                  | ❌                         | `MISSING`                      |
| Licence expiry                        | ❌                         | `MISSING`                      |

### 12.1 Where vehicle validation belongs — from schema

| Fact                                           | Implication                                                     |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `rides.vehicle_id` **NOT NULL**                | A ride cannot exist without a vehicle → **hard gate at ACCEPT** |
| `RideDispatch.vehicleId` **nullable**          | An offer may exist without one → **no gate at OFFER**           |
| `DriverOnlineStatus` has **no vehicle column** | Availability modelled independently → **no gate at ONLINE**     |

**Answer: (C) to ACCEPT a ride — not (A) online, not (B) offer.** `SCHEMA VERIFIED`

---

## 13. Status / Shift / Heartbeat / Suspension Verification

| Status             | Writers                                             | Verdict                                            |
| ------------------ | --------------------------------------------------- | -------------------------------------------------- |
| `ONLINE`           | `setOnline`                                         | `WORKING` (unreachable)                            |
| `OFFLINE`          | `setOffline`, `HeartbeatTimeoutJob`, `setSuspended` | `WORKING`                                          |
| **`BUSY`**         | **NONE**                                            | `STUB` — enum only                                 |
| **`ON_TRIP`**      | **NONE**                                            | `STUB` — read once in `setOffline`'s refusal guard |
| `BREAK`            | **NONE**                                            | `STUB`                                             |
| `SUSPENDED` (enum) | **NONE**                                            | `STUB` — suspension uses the `isSuspended` boolean |

**Shift chain:** online → `startShift` (idempotent under the row lock) → heartbeat → `HeartbeatTimeoutJob` (`* * * * *`, DI token `heartbeatTimeoutJob`, Redis-locked) → `setOffline` → `endShift` computes `totalOnlineMinutes`. **Every other shift statistic stays at its default.** Drivers with `heartbeatAt = null` are **never swept**.

**Suspension — self-deadlock confirmed:**

```ts
await this.txManager.execute(async (tx) => {
  await this.driverRepo.lockForUpdate(driverId, tx);   // outer tx holds SELECT … FOR UPDATE
  await this.driverRepo.setSuspended(driverId, isSuspended, tx);
  if (isSuspended) {
    await this.setOffline(driverId, 'ADMIN_SUSPENSION'); // ← opens a SECOND transaction
```

`TransactionManager.execute` unconditionally calls `$transaction` — it does not join an in-flight one. The nested `setOffline` runs on a **different pooled connection** and locks the same row. It blocks; the outer cannot commit; Prisma's 5 s timeout aborts. **`POST /drivers/:id/suspend` with `{"isSuspended": true}` fails.** The body is also read via a raw cast with no Zod schema.

---

## 14. Location + Geo Verification

| Driver state         | Enters live geo index? | Correct? |
| -------------------- | ---------------------- | -------- |
| `PENDING`            | **YES**                | ❌       |
| `DOCUMENT_REVIEW`    | **YES**                | ❌       |
| Suspended            | **YES**                | ❌       |
| `VERIFIED` + OFFLINE | **YES**                | ❌       |
| `VERIFIED` + ONLINE  | YES                    | ✅       |
| `BUSY` / `ON_TRIP`   | n/a — never written    | —        |

**Root cause:** `POST /drivers/location` has **no eligibility guard**, and `PostgisProvider.findNearbyDrivers` queries `driver_locations` **alone** — no join to `drivers`, no filter on `verificationStatus`/`isSuspended`/`isAvailable`/online status.

**Removal:** explicit `forgetDriverPosition` on `setOffline` (correctly post-commit) · Redis TTL 300 s · PostGIS freshness bound 120 s. **None is state-aware.** Suspension's removal sits on the deadlocking path.

**`GeoService.findNearbyDrivers` — 3 references, all inside geo's own delegation chain. `DISCONNECTED`.**

---

## 15. Matching + Dispatch Verification

`matching/` and `dispatch/` are both `export {};` — **`STUB`**.

| Symbol                                      | Production callers          | Status         |
| ------------------------------------------- | --------------------------- | -------------- |
| `findNearbyDrivers`                         | 0 outside geo               | `DISCONNECTED` |
| `offerToDriver`                             | **0**                       | `DISCONNECTED` |
| `RideDispatchRepository.createOffer`        | 0                           | `DISCONNECTED` |
| `findByRequestAndDriver` / `updateResponse` | **0**                       | `DISCONNECTED` |
| `findActiveByDriver`                        | **0**                       | `DISCONNECTED` |
| `claimForMatch`                             | **1** — `acceptRideRequest` | `CONNECTED`    |

`ride.requested` → zero subscribers → chain ends. `DispatchTimeoutJob` is scheduled and runs on a **permanently empty table**, and **does not re-offer** — timeout is terminal.

---

## 16. Notification / FCM Verification

`NotificationService` has exactly `sendSms` and `sendOtp`, behind an `SmsProvider` interface (MSG91 + mock). Callers: `OtpService.notifyLocked`, `OtpDeliveryJob.run`.

**Every `fcmToken` reference:** `auth.controller.ts:22` (write), `device.repository.ts:11,54,76` (write/clear), `auth.responses.ts:62` + `auth.schemas.ts:15` (schema), `auth.service.ts:53` + `auth.types.ts:8` (types). **Zero reads for delivery.**

**Delivery channels:** push ❌ · websocket ❌ (`plugins/socket/socket.plugin.ts` is `export {};` and unregistered) · socket ❌ · polling ❌ · event consumer ❌.

> **Dispatch has no delivery channel at all** — plausibly _why_ it was never wired. `INFERENCE`

---

## 17. Vehicle + Acceptance Integrity Verification

| #   | Question                                       | Answer        |
| --- | ---------------------------------------------- | ------------- |
| 1   | Can a driver accept multiple concurrent rides? | **YES**       |
| 2–3 | Code and DB constraints                        | Neither — §21 |
| 4   | Protected by?                                  | **Nothing**   |

**`vehicleId` at acceptance is client-supplied and validated for nothing:**

| Check               | Present? | Consequence                                                            |
| ------------------- | -------- | ---------------------------------------------------------------------- |
| Vehicle exists      | ❌       | Arbitrary UUID ⇒ FK violation ⇒ **500**                                |
| Belongs to driver   | ❌       | **A driver can accept using another driver's vehicle**                 |
| Is active           | ❌       | Retired vehicles usable                                                |
| Category compatible | ❌       | **Accept a premium request in a hatchback, be paid the premium quote** |
| Documents valid     | ❌       | —                                                                      |

`Driver.currentVehicleId` has **no `@relation`** and therefore no FK, and zero hand-written references.

---

## 18. Ride Lifecycle → Driver Status Verification

| Ride transition | Updates driver status?                                                      |
| --------------- | --------------------------------------------------------------------------- |
| offer           | n/a — no offers created                                                     |
| **accept**      | **NO** — driver stays `ONLINE`, `isAvailable: true`, still in the geo index |
| arrive          | NO                                                                          |
| start           | NO                                                                          |
| **complete**    | **NO**                                                                      |
| cancel          | NO                                                                          |

**The ride lifecycle and driver status are completely disconnected.** A driver mid-trip remains fully available and discoverable.

> **The missing orchestration belongs in Rides**, which already owns the state machine and already writes the ride row inside a transaction — it should call a Drivers status method. **Do not move ride lifecycle ownership into Drivers.** `INFERENCE`

---

## 19. Payments / Ledger / Settlement / Wallet Verification

`LifecycleService.completeRide` (`lifecycle.service.ts:284`) calls `ledgerService.recordTripPayment(...)` **inside the same transaction** as the status write and fare record:

| Payment method | Ledger entries                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| **CASH**       | `DRIVER_PAYABLE` **DEBIT** commission + `PLATFORM_COMMISSION` **CREDIT** — driver _owes_ the platform      |
| **Prepaid**    | `CUSTOMER_WALLET` **DEBIT** fare + `DRIVER_PAYABLE` **CREDIT** earnings + `PLATFORM_COMMISSION` **CREDIT** |

`postTransactionGroup` rejects non-positive amounts. Double-entry is sound.

| #   | Question                                  | Answer                                                               |
| --- | ----------------------------------------- | -------------------------------------------------------------------- |
| 1   | `SettlementJob` DI-registered?            | **YES** — `settlementJob`                                            |
| 2   | Scheduled?                                | **NO**                                                               |
| 3   | In `JOB_SCHEDULES`?                       | **NO** (9 entries, absent)                                           |
| 4   | In `MAINTENANCE_HANDLERS`?                | **NO** (9 entries, absent)                                           |
| 5   | Worker token correct?                     | n/a — never looked up                                                |
| 6   | `calculateSettlement` production callers? | Only `SettlementJob.run`, which never runs                           |
| 7   | Is `DriverWallet` created?                | **YES** — lazily via `getOrCreateWallet`                             |
| 8   | Is it ever updated?                       | **NO** — sole write is `driverWallet.create`                         |
| 9   | Balance zero despite `DRIVER_PAYABLE`?    | **YES**                                                              |
| 10  | Source of truth or projection?            | **Intended projection; currently neither** — the ledger is the truth |
| 11  | Who owns mutations?                       | **Payments**                                                         |
| 12  | Who owns the driver wallet read API?      | **Drivers** — 2 read methods, correctly scoped                       |

**No duplicate money logic exists.** `grep -rln "earnings" src` → 3 Payments files, zero Drivers files.

---

## 20. Background Jobs — Exact Map

`CODEBASE VERIFIED` — jobs resolve by **string token** in `src/jobs/workers/index.ts`; a rename fails **at cron time, not compile time**.

| Job                      | Source                                  | DI token              | `JOB_SCHEDULES` | `MAINTENANCE_HANDLERS` | Schedule       | Classification                                              |
| ------------------------ | --------------------------------------- | --------------------- | --------------- | ---------------------- | -------------- | ----------------------------------------------------------- |
| File sweep               | `files/jobs/sweeper.job.ts`             | `fileSweeperJob`      | ✅              | ✅                     | `*/15 * * * *` | `SCHEDULED_AND_WORKING`                                     |
| File retention           | `files/jobs/retention.job.ts`           | `fileRetentionJob`    | ✅              | ✅                     | `0 3 * * *`    | `SCHEDULED_AND_WORKING`                                     |
| Account erasure          | `users/jobs/account-erasure.job.ts`     | `accountErasureJob`   | ✅              | ✅                     | config         | `SCHEDULED_AND_WORKING`                                     |
| Auth retention           | `auth/jobs/auth-retention.job.ts`       | `authRetentionJob`    | ✅              | ✅                     | `30 4 * * *`   | `SCHEDULED_AND_WORKING`                                     |
| Dispatch timeout         | `rides/jobs/dispatch-timeout.job.ts`    | `dispatchTimeoutJob`  | ✅              | ✅                     | `* * * * *`    | **`SCHEDULED_BUT_DISCONNECTED`** — empty table              |
| Request expiry           | `rides/jobs/request-expiry.job.ts`      | `requestExpiryJob`    | ✅              | ✅                     | `* * * * *`    | `SCHEDULED_AND_WORKING`                                     |
| Driver heartbeat timeout | `drivers/jobs/heartbeat-timeout.job.ts` | `heartbeatTimeoutJob` | ✅              | ✅                     | `* * * * *`    | `SCHEDULED_AND_WORKING`                                     |
| Driver doc expiration    | `drivers/jobs/doc-expiration.job.ts`    | `docExpirationJob`    | ✅              | ✅                     | `0 2 * * *`    | **`SCHEDULED_BUT_DISCONNECTED`** — no `VERIFIED` docs exist |
| Payment reconciliation   | `payments/jobs/reconciliation.job.ts`   | `reconciliationJob`   | ✅              | ✅                     | `15 * * * *`   | `SCHEDULED_AND_WORKING`                                     |
| **Settlement**           | `payments/jobs/settlement.job.ts`       | **`settlementJob`**   | ❌              | ❌                     | —              | **`REGISTERED_BUT_NEVER_SCHEDULED`**                        |
| OTP delivery             | `auth/jobs/otp-delivery.job.ts`         | `otpDeliveryJob`      | queue consumer  | n/a                    | on demand      | `SCHEDULED_AND_WORKING`                                     |

---

## 21. Database Integrity and Index Map

`SCHEMA VERIFIED` — enumerated **every** `CREATE UNIQUE INDEX` across all migrations. **This is the new artifact in this pass.**

| #   | Invariant                                    | Database                                                                       | Code                                            | Protection state     |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- | -------------------- |
| 1   | **One Driver per User**                      | `drivers_user_id_key`                                                          | read-then-create + `P2002` re-read              | **BOTH** ✅          |
| 2   | **One DriverProfile per Driver**             | `driver_profiles_driver_id_key`                                                | `upsert`                                        | **BOTH** ✅          |
| 3   | **One active role assignment per user/role** | **`uq_user_role_active`** (partial: `WHERE revoked_at IS NULL`)                | `grantRole` returns `false` if active           | **BOTH** ✅          |
| 4   | **One live profile image per user**          | **`uq_files_one_live_profile_image`** (partial)                                | `attachProfileImage` releases the outgoing file | **BOTH** ✅          |
| 5   | **One document per driver/document type**    | ❌ **none** — only plain indexes on `driver_id`, `document_type`, `expires_at` | `findFirst`-then-`create` (racy)                | **NOT_PROTECTED** ⛔ |
| 6   | **One active ride per driver**               | ❌ **none** — only plain `rides_driver_id_idx`                                 | ❌ `findActiveByDriver` has **0 call sites**    | **NOT_PROTECTED** ⛔ |
| 7   | **One ride per request**                     | **`rides_request_id_key`**                                                     | `claimForMatch` conditional claim (1 call site) | **BOTH** ✅          |
| 8   | **One active vehicle assignment per driver** | ❌ **none** — `VehicleAssignment` has only `@@index([driverId])`               | ❌ no code at all                               | **NOT_PROTECTED** ⛔ |

**Supporting evidence for #6:** `findActiveByCustomer` has **3 call sites** (the customer side _is_ guarded, by `createRequest`); `findActiveByDriver` has **0**. The driver-side twin was written and never used.

**The codebase already knows the partial-unique pattern** — `uq_users_phone_active`, `uq_user_role_active`, `uq_files_one_live_profile_image`. It simply was not applied to invariants 5, 6, and 8.

**Six UUID columns with no foreign key:** `Driver.currentVehicleId`, `Driver.approvedBy`, `DriverDocument.verifiedBy`, `DriverBankAccount.verifiedBy`, `DriverOnlineStatus.currentShiftId`, `DriverLocation.rideId`.

**Also:** `driver_location_history` appears in **no migration** despite a schema comment claiming raw-SQL management — **no location history is retained**. `AuditLog` does not exist (`audit.prisma` is one comment line).

---

## 22. Events and DI Connectivity Map

**All routes mounted:** ✅ 6 prefixes + health/metrics · **controllers DI-resolvable:** ✅ (`di-wiring.test.ts` statically parses `src/` for `asClass` + constructor params) · **services/repositories registered:** ✅ 20 tokens in `drivers/index.ts` alone.

**Events consumed:** `grep -rn "eventBus.on(" src --exclude-dir=generated` → **1 hit**, `epoch-invalidation.consumer.ts:17`, handling `account.role.granted`/`revoked`/`account.suspended`/`auth.refresh.reuse_detected`.

| Event                                    | Producer                                    | Subscriber                         |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------- |
| `driver.onboarded`                       | `onboardDriver`                             | ❌                                 |
| **`driver.verified`**                    | `reviewDriverVerification`                  | ❌ **the missing role-grant hook** |
| `driver.status_changed`                  | `setOnline`/`setOffline`                    | ❌                                 |
| `driver.suspended`                       | `setSuspended`                              | ❌                                 |
| **`ride.requested`**                     | `createRequest`                             | ❌ **the missing dispatch hook**   |
| `ride.accepted`, `ride.dispatch_offered` | rides                                       | ❌                                 |
| `account.role.granted`                   | `grantRole` (0 callers) + new-account login | ✅ epoch bump                      |

**Declared but never published:** `driver.document_expired`, `driver.shift_started`, `driver.shift_ended`, `driver.location_updated`.

**Orphaned modules:** 15 stubs, none imported or registered.

---

## 23. Dependency / Circular Import Analysis

**Outbound from `drivers/`:** `@core/database` ×11 · `@core/database/TransactionManager` ×7 · `@shared/logger` ×4 · **`@modules/geo` ×4 — the only domain-module dependency** · `@config` ×4 · `@core/auth` ×3 · `@core/events` ×2 · `@core/cache` ×2 · `@core/{metrics,errors,di}` ×3.

**Inbound to `drivers/`:** `core/di.ts` (barrel ✅) · `routes/register.ts` (barrel ✅) · **`rides/controllers/ride-state.controller.ts` (2 deep imports ⚠️)** · 4 test files (deep).

| Pair                | Exists                              | Classification                                    |
| ------------------- | ----------------------------------- | ------------------------------------------------- |
| Drivers → Auth      | **NO**                              | _missing edge_ — why `grantRole` is uncalled      |
| Auth → Drivers      | **NO import** (schema-level)        | allowed                                           |
| Drivers → Files     | **NO**                              | _missing edge_ — why `fileUrl` is unvalidated     |
| Drivers → Users     | **NO**                              | _missing edge_ — why the raw `user.update` exists |
| Drivers → Geo       | **YES ×4, public barrel**           | **allowed**                                       |
| Drivers → Rides     | **NO**                              | correct — would cycle                             |
| **Rides → Drivers** | **YES, 1 file, deep**               | **questionable** — internal leak                  |
| Rides → Payments    | **YES, deep** (`ledger.service.js`) | questionable — needs a barrel                     |

**Actual cycles: ZERO.** Two edges must never be added: `drivers → rides`, and `geo → drivers` (pass a predicate _into_ Geo).

---

## 24. Test Coverage Matrix

`TEST VERIFIED` — 109 files, 714 unit tests passing.

| Workflow step                              | HTTP integration coverage                                             |
| ------------------------------------------ | --------------------------------------------------------------------- |
| OTP send/verify, user, customer role       | **REAL END-TO-END**                                                   |
| Driver onboarding                          | **NONE**                                                              |
| Profile update                             | **NONE**                                                              |
| Document submission                        | **NONE**                                                              |
| Document review                            | **NONE** (no production code)                                         |
| Driver approval                            | **NONE**                                                              |
| Role assignment                            | **FIXTURE SHORTCUT ONLY**                                             |
| Online / offline / suspension              | **NONE**                                                              |
| Location                                   | **PARTIAL** — unit only                                               |
| Ride request                               | **PARTIAL**                                                           |
| Dispatch / accept / active-ride protection | **NONE**                                                              |
| Ride completion, ledger                    | **REAL (unit + service)**                                             |
| Settlement                                 | **SERVICE-LEVEL** — proves ledger grouping, **not that the job runs** |

**Fixture shortcuts** (`tests/integration/helpers/fixtures.ts`) insert directly: **VERIFIED drivers, VERIFIED documents, DRIVER role, active rides, geo positions, vehicles**. These hide P0-1 and P0-2 specifically.

> **First missing integration boundary: `POST /drivers/me/onboard`.** Everything from onboarding onward has zero HTTP coverage — which is why an unfinished onboarding rewrite sat in the tree without a single failing test.

---

## 25. Build and CI Health

`BUILD VERIFIED`

| Check                      | Status                                              | Category                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | **PASS**                                            | —                                                                                                                                                                                           |
| `npm run lint`             | **PASS**                                            | —                                                                                                                                                                                           |
| `npm run build`            | **PASS** (clean → tsc → tsc-alias → copy-generated) | —                                                                                                                                                                                           |
| `npm run prisma:validate`  | **PASS**                                            | —                                                                                                                                                                                           |
| `npm run test:unit`        | **PASS** — 714/714                                  | —                                                                                                                                                                                           |
| `npm run test:integration` | **NOT_VERIFIABLE**                                  | **INFRASTRUCTURE UNAVAILABLE** — no local Postgres/Redis; Docker daemon unreachable (`npipe:////./pipe/dockerDesktopLinuxEngine`). **CI runs them** with PostGIS + Redis service containers |
| `npm run format:check`     | **FAIL** — 34 files, all outside `src/`             | **PRE-EXISTING CI FAILURE**                                                                                                                                                                 |

**CI order** (`.github/workflows/ci.yml`, `quality` job): `format:check` → `lint` → `typecheck`. **`format:check` runs first, so this pre-existing failure blocks every merge.** The `build` job additionally greps `dist/` for unresolved path aliases — a guard someone deliberately added.

**No source-code failure and no test failure exist.** The only red is formatting, in frontend files, Spec Kit templates, and audit docs.

---

## 26. Disconnected Functions — Zero Production Callers

| Symbol                                                                                          | Module       | Prod callers        | Status                |
| ----------------------------------------------------------------------------------------------- | ------------ | ------------------- | --------------------- |
| `AuthService.grantRole` / `revokeRole`                                                          | auth         | **0**               | `DISCONNECTED`        |
| `DriverDocumentRepository.updateVerificationStatus` (`VERIFIED` path)                           | drivers      | 1 (`REJECTED` only) | `PARTIALLY_CONNECTED` |
| `GeoService.findNearbyDrivers`                                                                  | geo          | **0** outside geo   | `DISCONNECTED`        |
| `DispatchService.offerToDriver`                                                                 | rides        | **0**               | `DISCONNECTED`        |
| `RideDispatchRepository.findByRequestAndDriver` / `updateResponse` / `createOffer`              | rides        | **0**               | `DISCONNECTED`        |
| `RideRepository.findActiveByDriver`                                                             | rides        | **0**               | `DISCONNECTED`        |
| `SettlementService.calculateSettlement` / `SettlementJob`                                       | payments     | **0** effective     | `DISCONNECTED`        |
| `UserDevice.fcmToken` (delivery read)                                                           | auth         | **0**               | `DISCONNECTED`        |
| `driverConfig.requireApprovedDocuments` / `maxContinuousShiftHours`                             | config       | **0**               | `DEAD`                |
| `PermissionRepository.findAllowedCodesForUser`                                                  | auth         | **0**               | `DEAD`                |
| `ShiftService.getActiveShift` · `DriverBankRepository` · `DriverWalletRepository.lockForUpdate` | drivers      | **0**               | `DEAD`                |
| `driverExtension.findActiveDrivers` · `DriverMetrics.heartbeatTimeout`                          | core/drivers | **0**               | `DEAD`                |
| `GeoService.liveDriverPosition` / `calculateExactDistanceMeters` / `PostgisProvider.isWithin`   | geo          | **0**               | `DEAD`                |
| `driverPlugin` + 4 sibling plugins · `schemas/driver.responses.ts`                              | various      | **0**               | `DEAD`                |
| `BUSY` / `ON_TRIP` writers                                                                      | drivers      | **0**               | `STUB`                |

---

## 27. Stubs and Empty Implementations

15 modules are `export {};` + an identical boilerplate README: `vehicles`, `dispatch`, `matching`, `admin`, `support`, `documents`, `onboarding`, `riders`, `pricing`, `promotions`, `reviews`, `chat`, `sos`, `analytics`, `settings`.

Plus ~20 one-line files across `src/common/`, `src/infrastructure/`, `src/middleware/`, `src/shared/{cache,events,pagination,response}`, `src/plugins/socket`, `src/plugins/jwt`, `src/routes/index.ts`. **None imported anywhere.**

---

## 28. Incorrectly Placed Code

**Zero files belong in another top-level module.** Three genuine issues, all internal or hygiene:

| Current                                                                     | Correct                          | Risk                                   |
| --------------------------------------------------------------------------- | -------------------------------- | -------------------------------------- |
| `submitDocument` in `services/onboarding/onboarding.service.ts`             | `drivers/documents/services/`    | MEDIUM                                 |
| `reviewDriverVerification` in the same file                                 | `drivers/verification/services/` | MEDIUM                                 |
| `actingDriverId` duplicated in `rides/controllers/ride-state.controller.ts` | import from `drivers`            | LOW — **security-relevant drift risk** |

---

## 29. Missing Transitions in the Complete Workflow

1. Document `PENDING → VERIFIED` — **no writer** ⛔
2. Required-documents check → driver approval — **no validation**
3. Driver `VERIFIED` → `driver` role — **no caller**
4. `ride.requested` → nearby-driver discovery — **no subscriber**
5. Candidates → offer created — **no orchestrator**
6. Offer → driver notified — **no delivery channel**
7. Offer timeout → next driver — **terminal, no re-offer**
8. Accept → offer validated — **no check**
9. Accept → `BUSY`/`ON_TRIP` — **no writer**
10. Accept → one-active-ride guard — **no code, no index**
11. Accept → vehicle validated — **no check**
12. Complete → driver available again — **nothing to restore**
13. Ledger → settlement — **job never scheduled**
14. Settlement → wallet balance — **never written**

---

## 30. P0 / P1 / P2 Findings

### P0

| ID    | Finding                                                        | Reuse available                      |
| ----- | -------------------------------------------------------------- | ------------------------------------ |
| P0-1  | No writer of `DriverDocument.verificationStatus = VERIFIED`    | ✅ repository method                 |
| P0-2  | `grantRole` zero production callers                            | ✅ complete + idempotent             |
| P0-3  | Driver approvable with zero/`PENDING`/`REJECTED` documents     | ✅ `requireApprovedDocuments` exists |
| P0-4  | Documents accept arbitrary client URLs                         | ✅ Files complete                    |
| P0-5  | `POST /drivers/:id/suspend` self-deadlocks                     | —                                    |
| P0-6  | One driver, unlimited concurrent rides — **no code, no index** | ✅ `findActiveByDriver` exists       |
| P0-7  | `vehicleId` unvalidated at acceptance                          | —                                    |
| P0-8  | Dispatch has no orchestrator                                   | ✅ primitives exist                  |
| P0-9  | **`SettlementJob` never scheduled**                            | ✅ job + service exist               |
| P0-10 | **`DriverWallet` never updated**                               | ✅ ledger correct                    |

### P1

`/rides/active` + `/history` serve customer data to drivers (fixed by P0-2) · unverified/suspended/offline drivers in the geo index · `findNearbyDrivers` has no state filter · licence expiry unchecked at go-online · racy document upsert · stale review metadata survives re-upload · `REJECTED` driver cannot re-enter review · driver email via raw Prisma (500 not 409) · suspend body unvalidated · no admin review queue · **no push channel** · **revoked default role silently re-granted** · `DEFAULT_USER_ROLE` unvalidated at boot · `heartbeatAt = null` never swept · `BUSY`/`ON_TRIP` never written · driver aggregates + shift stats never written · `cancel` has no operability guard · **no unique on `VehicleAssignment`** · no location history · no Fastify schemas on driver routes.

### P2

`format:check` blocks CI · document/verification concerns inside the onboarding service · 13 routes and 5 schemas in single files · `actingDriverId` duplicated · deep imports (rides→drivers, rides→payments) · six UUID columns with no FK · no `EXPIRED` document status · three authorization vocabularies · `super_admin` not seeded · dead-code set · stale `drivers/README.md`.

---

## 31. Recommended Implementation Order

**Stage 0 — unblock CI.** Resolve `format:check` (34 non-`src/` files). Add HTTP smoke tests for the 13 driver routes.

**Stage 1 — close the driver funnel.** P0-1 → P0-3 → P0-2: document review service + admin route; document-completeness gate via `requireApprovedDocuments`; `grantRole` on approval. **The smallest change set that lets a real driver go ONLINE**, and it fixes `/rides/active` for free. **Decide the role mechanism (§11.1) first.**

**Stage 2 — two-line money fix.** P0-9: add `SettlementJob` to `JOB_SCHEDULES` and `MAINTENANCE_HANDLERS`. Then P0-10: project `DRIVER_PAYABLE` into `DriverWallet`, or have the wallet API read the ledger. **Independent of Stage 1 — can run in parallel.**

**Stage 3 — secure documents.** P0-4 plus the missing unique index (invariant 5).

**Stage 4 — operational correctness.** P0-5, eligibility gate on location, licence expiry, suspend body validation, `heartbeatAt = null` sweep, revoked-default-role re-grant, `DEFAULT_USER_ROLE` allow-list.

**Stage 5 — ride integrity.** P0-6 (code **and** partial unique index), P0-7, `BUSY`/`ON_TRIP` writes from the Rides lifecycle.

**Stage 6 — vehicles.** Registration, documents, assignment (+ invariant 8 index), approval. Gate at **accept** per §12.1.

**Stage 7 — notifications.** Push/FCM. **Decide before Stage 8** — dispatch without delivery is inert.

**Stage 8 — matching + dispatch.** P0-8. Largest and last.

---

## 32. Recommended Module Cleanup Order

1. **Before Stage 1:** extract `drivers/documents/` and `drivers/verification/` (~8 moves) — so document review is written once, in the right place.
2. **Stage 3:** have Rides import `actingDriverId` from Drivers instead of duplicating it.
3. **Stage 3:** route the driver email write through `UserRepository.updateEmail`.
4. **Any time:** add barrel exports so `rides` stops deep-importing Drivers and Payments internals.
5. **Last:** delete the dead-code set in one commit; refresh `drivers/README.md`.
6. **Never:** move `DriverDocument` to Files, driver onboarding to `onboarding/`, earnings to Drivers, or ride lifecycle to Drivers.

---

## 33. End-to-End Truth Table

| #   | Step                       | Owner         | Status           | Blocker                          |
| --- | -------------------------- | ------------- | ---------------- | -------------------------------- |
| 1   | Phone login                | auth          | **WORKING**      | —                                |
| 2   | OTP send                   | auth          | **WORKING**      | —                                |
| 3   | OTP verify                 | auth          | **WORKING**      | —                                |
| 4   | User create/fetch          | auth/users    | **WORKING**      | —                                |
| 5   | Default role assignment    | auth          | **WORKING**      | ⚠️ re-grants revoked             |
| 6   | JWT issuance               | auth          | **WORKING**      | —                                |
| 7   | Driver onboarding          | drivers       | **WORKING**      | —                                |
| 8   | Driver profile             | drivers       | **PARTIAL**      | raw `users.email` write          |
| 9   | File upload via Files      | files         | **DISCONNECTED** | drivers never imports files      |
| 10  | Document submission        | drivers       | **PARTIAL**      | arbitrary `fileUrl`              |
| 11  | **Document review**        | drivers       | **MISSING**      | ⛔ **no writer of `VERIFIED`**   |
| 12  | Required-document check    | drivers       | **MISSING**      | no required set declared         |
| 13  | Driver approval            | drivers       | **PARTIAL**      | approves with zero documents     |
| 14  | **DRIVER role grant**      | auth          | **DISCONNECTED** | ⛔ `grantRole` 0 callers         |
| 15  | Token refresh → new claims | auth          | **WORKING**      | never fires                      |
| 16  | Eligibility                | drivers       | **BLOCKED**      | by #11                           |
| 17  | Go ONLINE                  | drivers       | **BLOCKED**      | by #11                           |
| 18  | Shift creation             | drivers       | **WORKING**      | unreachable                      |
| 19  | Heartbeat                  | drivers       | **WORKING**      | —                                |
| 20  | Location update            | drivers       | **PARTIAL**      | no eligibility gate              |
| 21  | Geo indexing               | geo           | **WORKING**      | —                                |
| 22  | Nearby discovery           | geo           | **DISCONNECTED** | 0 callers                        |
| 23  | Matching                   | matching      | **STUB**         | `export {};`                     |
| 24  | Dispatch orchestration     | dispatch      | **MISSING**      | no orchestrator                  |
| 25  | Offer creation             | rides         | **DISCONNECTED** | `offerToDriver` 0 callers        |
| 26  | Offer delivery (push)      | notifications | **MISSING**      | no channel                       |
| 27  | Driver accept              | rides         | **PARTIAL**      | no offer validation              |
| 28  | Vehicle validation         | vehicles      | **MISSING**      | stub                             |
| 29  | One-active-ride guard      | rides         | **MISSING**      | no code, no index                |
| 30  | BUSY / ON_TRIP             | drivers       | **MISSING**      | no writer                        |
| 31  | Ride arrive                | rides         | **WORKING**      | —                                |
| 32  | Ride start (OTP)           | rides         | **WORKING**      | —                                |
| 33  | Ride complete              | rides         | **WORKING**      | —                                |
| 34  | Payment ledger             | payments      | **WORKING**      | —                                |
| 35  | Driver payable             | payments      | **WORKING**      | —                                |
| 36  | Settlement                 | payments      | **DISCONNECTED** | job never scheduled              |
| 37  | Wallet projection          | payments      | **MISSING**      | never written                    |
| 38  | Wallet read API            | drivers       | **WORKING**      | returns zero                     |
| 39  | Payout readiness           | payments      | **MISSING**      | `DriverBankRepository` 0 callers |
| 40  | Driver available again     | drivers       | **MISSING**      | nothing to restore               |

**Tally:** `WORKING` **17** · `PARTIAL` **6** · `DISCONNECTED` **6** · `MISSING` **9** · `BLOCKED` **2** · `STUB` **1**

---

## Answers to the Decision-Rule Questions

**What already works?** Auth (OTP, JWT, sessions, refresh rotation, epoch) · Users · Files · Geo write path · driver onboarding/profile/status/location/shift/heartbeat mechanics · the Rides state machine from accept through complete · **the Payments ledger including `recordTripPayment`**.

**What is partially implemented?** Driver profile (raw email write) · document submission (arbitrary URL) · driver approval (no document gate) · location (no eligibility gate) · ride accept (no offer/vehicle/concurrency checks).

**What exists with no production caller?** `grantRole`/`revokeRole` · `updateVerificationStatus`'s `VERIFIED` path · `findNearbyDrivers` · `offerToDriver` · `RideDispatchRepository` methods · `findActiveByDriver` · `SettlementJob` · `fcmToken` reads · `requireApprovedDocuments` · `maxContinuousShiftHours` · plus the dead-code set.

**What is missing?** Document review · required-document declaration · matching · dispatch orchestration · push notifications · vehicles module · `BUSY`/`ON_TRIP` writers · wallet projection · admin review queue · location history · driver aggregates · `AuditLog` · `EXPIRED` status · three unique indexes.

**What is in the wrong place?** Nothing at module level. Internally: `submitDocument` and `reviewDriverVerification` sit inside the onboarding service.

**What should remain where it is?** Everything in `drivers/`; OTP/JWT/roles in `auth`; `users.email` in `users`; bytes in `files`; spatial queries in `geo`; money in `payments`; the ride aggregate in `rides`; vehicles in `vehicles`; delivery in `notifications`.

**What should move inside the Driver module?** Nothing from outside. Only the two internal extractions.

**What exact transitions prevent the first real driver completing the lifecycle?** In order: **(1) document `PENDING → VERIFIED`** — no writer; **(2) driver `VERIFIED` → `driver` role** — no caller; **(3) `setOnline`'s licence gate** — unsatisfiable because of (1). Fixing (1) and (2) is sufficient for a driver to reach ONLINE.

---

FULL PLATFORM WORKFLOW AND MODULE OWNERSHIP VERIFICATION COMPLETE — READY FOR SPECIFICATION AND PRODUCTION IMPLEMENTATION PLANNING.
