# Driver Platform — Final Production Baseline

**Repository:** `backend_zaroorat`
**Date:** 2026-08-18
**Source of truth:** the **current working tree**, including uncommitted changes. Re-read from disk; commands re-executed. Prior reports were not treated as evidence.
**Phase:** Investigation and verification only. No code written or modified. No migrations created. No plan produced.

**Git baseline**

```
HEAD  273aadb  refactor: remove unnecessary comments from src to improve readability
      290b3c6  fix: restore eslint configurations and test assumptions broken by comment stripping
      c0b5acd  feat(core): record deletion requests and erase accounts on the ledger
```

> ### ⚠️ Read this before anything else
>
> **The working tree is dirty, and the uncommitted changes are an in-progress rewrite of exactly the Driver onboarding flow this audit was asked to assess.** Sixteen files are modified, six of them in `src/modules/drivers/`. The changeset introduces the explicit onboarding endpoint, renames `createOrGetDriver` → `onboardDriver`, adds `P2002` race handling, and adds email capture — and it is **unfinished**: it does not compile and does not lint.
>
> This means several answers differ between `HEAD` and the working tree. Both are reported below. **Do not commit or deploy the tree as-is.**

**Classification vocabulary:** `IMPLEMENTED_AND_WIRED`, `IMPLEMENTED_BUT_PARTIAL`, `IMPLEMENTED_BUT_UNWIRED`, `EMPTY_OR_STUB`, `MISSING`, `TEST_ONLY`.
**Status vocabulary:** `PASS`, `PARTIAL`, `FAIL`, `UNWIRED`, `STUB`, `MISSING`, `NOT_VERIFIABLE`.

A **production caller** is a call site reachable from a registered route, a registered event subscriber, or a scheduled job. Test files are never counted. `src/generated/**` (Prisma client output) is excluded from all caller searches so generated type declarations are never mistaken for callers.

---

## 1. Executive Summary

The Driver platform is **not production ready**. The reason is not that it is unbuilt — most of it is built, correctly transactional, and routed. The reason is that **three transitions in the middle of the funnel have no implementation**, and one **in-progress local changeset has broken the build**.

**Six findings that define the current state:**

1. **The repository does not compile, does not lint, and does not build.** One type error (`DriverNotFoundError` used without an import, `driver-onboarding.controller.ts:18`) and one lint error (`catch (err: any)`, `onboarding.service.ts:39`). Both live in **uncommitted** driver code. `npm run build` fails after `rimraf` has already deleted `dist/`, and because `tsc` emits despite errors while `tsc-alias` never runs, the emitted `dist/` is **unrunnable** — its `require("@core/auth")` aliases were never rewritten. `PASS`/`FAIL` evidence in §2.

2. **No production code can mark a driver document `VERIFIED`.** The only writers of `DriverDocument.verificationStatus` are the driver's own submission (`PENDING`) and `DocExpirationJob` (`REJECTED`). This is the **first production blocker**. §6.

3. **`AuthService.grantRole` has zero production callers.** The `driver` role is never granted to anyone by the backend. Its 28 references are all tests. §5.

4. **The missing role grant already breaks two shipped read endpoints.** Because `GET /rides/active` and `GET /rides/history` branch on `callerHasRole(req, 'driver')`, a real approved driver — who holds no `driver` role — silently falls through to the **customer** branch and is served customer data. This is a live defect today, not a future one. §14.

5. **A driver can be approved with zero documents**, and driver documents **bypass the Files module entirely** (`fileUrl: z.string().url()` — any client-supplied URL). §6, §7.

6. **Dispatch is not a running system.** `dispatch/` and `matching/` are `export {};`. `findNearbyDrivers` and `offerToDriver` are complete with zero callers. `BUSY`/`ON_TRIP` are never written. §13.

**What is genuinely done and must be preserved:** Auth, OTP, Users, Files, Geo, the outbox/relay/EventBus, the job scheduler with Redis locks, and the Prisma schema — which anticipated the entire lifecycle. The driver module's own status, location, and shift services are correctly written and merely starved of input.

**Shape of the remaining work:** small and surgical. `grantRole` needs a caller. `DriverDocumentRepository.updateVerificationStatus` needs a service method and a route. `findNearbyDrivers` needs an orchestrator. **The risk in the next phase is rebuilding, not under-building.**

---

## 2. Current Repository / Build Health

All commands executed in this session against the current tree. Results reproduced where noted.

| Check              | Command                             | Status             | Evidence                                                                                                                                        |
| ------------------ | ----------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript (app)   | `npx tsc -p tsconfig.json --noEmit` | **FAIL**           | Exactly 1 error: `src/modules/drivers/controllers/driver-onboarding.controller.ts(18,28): error TS2304: Cannot find name 'DriverNotFoundError'` |
| TypeScript (tools) | `npx tsc -p tsconfig.tools.json`    | **FAIL**           | Same single error                                                                                                                               |
| Build              | `npm run build`                     | **FAIL**           | `clean` → `tsc` fails → `tsc-alias` and `copy-generated.js` never run                                                                           |
| Lint               | `npm run lint`                      | **FAIL**           | 1 error, `--max-warnings=0`: `onboarding.service.ts:39:19 Unexpected any @typescript-eslint/no-explicit-any`                                    |
| Format             | `npm run format:check`              | **FAIL**           | 29 files, incl. `src/modules/drivers/repositories/driver.repository.ts`                                                                         |
| Prisma validate    | `npm run prisma:validate`           | **PASS**           | "The schemas at prisma\schema are valid 🚀"                                                                                                     |
| Migrations         | inspection (no DB)                  | **PARTIAL**        | 14 migration dirs present and ordered; `migrate status` needs a live DB — see below                                                             |
| Unit tests         | `npm run test:unit`                 | **PASS**           | **714 pass / 0 fail / 142 suites.** Run twice (10.7 s, 7.1 s) — reproducible                                                                    |
| Integration tests  | `npm run test:integration`          | **NOT_VERIFIABLE** | No infrastructure in this environment                                                                                                           |

### 2.1 The build failure is worse than a type error

`tsc` emits JavaScript even when it reports errors (`noEmitOnError` is not set). The `&&` chain then stops. Both halves were verified against the artifact:

```js
// dist/modules/drivers/controllers/driver-onboarding.controller.js
const auth_1 = require("@core/auth");          // ← tsc-alias never ran; unresolvable at runtime
...
if (!driver)
    throw new DriverNotFoundError((0, auth_1.callerId)(req));   // ← no import, no require
```

Two consequences, both now **artifact-verified rather than inferred**:

- `node dist/server.js` fails immediately with `MODULE_NOT_FOUND: @core/auth`. **There is no deployable artifact.**
- Even if aliases resolved, `GET /api/v1/drivers/me` throws `ReferenceError: DriverNotFoundError is not defined` — a `500`, not the intended `404` — on every request from a user without a Driver row.

### 2.2 Why the test suite hides this

`npm test` runs `tsx --test`. `tsx` **strips** types without checking them, so type errors are invisible to the test step. 714 unit tests pass against code that does not compile. `npm run typecheck` exists and is not part of the test command.

> **Finding (process, `PASS`-blocking):** CI must run `typecheck` and `lint` alongside `test`, or this class of defect ships again.

### 2.3 Integration test infrastructure

`.env.test` expects `postgresql://…@localhost:5432/zaroorat_test` and `redis://localhost:6379/1`. Neither is running; the Docker daemon is unavailable (`npipe:////./pipe/dockerDesktopLinuxEngine` — not found).

A single test was attempted to capture real evidence rather than assume:

```
POST /api/v1/auth/otp/send → 503
[rate-limit] store unavailable  (MaxRetriesPerRequestError, ioredis ECONNREFUSED)
PrismaInternalError: Invalid `prisma.$executeRawUnsafe()` invocation
✖ first verify registers the account, grants customer, opens a session (1601ms)
```

> **Status: `NOT_VERIFIABLE`, not FAIL.** The failures are purely infrastructural. I will not claim a pass I cannot reproduce, nor a failure the code did not cause.
>
> One genuine positive is visible in the evidence: the rate limiter **failed closed** with `503` rather than allowing the request. That is correct, deliberate behaviour.

### 2.4 The uncommitted changeset

`git status --short` — 16 modified files. The six in `src/modules/drivers/` plus two supporting:

| File                                                  | Uncommitted change                                                                                                         | Assessment                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `drivers/controllers/driver-onboarding.controller.ts` | `getMe` switched from `createOrGetDriver` to a pure read + `DriverNotFoundError`; new `onboard` method                     | ✅ Right direction. ❌ **Missing import — breaks the build**         |
| `drivers/routes/driver.routes.ts`                     | `+ POST /me/onboard`                                                                                                       | ✅ Correct                                                           |
| `drivers/services/onboarding/onboarding.service.ts`   | `createOrGetDriver` → `onboardDriver`; `P2002` race handling; `updateProfile` now takes `userId` and runs in a transaction | ✅ Right direction. ❌ **`catch (err: any)` breaks lint**            |
| `drivers/repositories/driver.repository.ts`           | `updateProfile` accepts `userId` + `email`; writes `User.email` via a **raw `client.user.update`**                         | ⚠️ Works, but bypasses the helper added in the same changeset (§5.4) |
| `drivers/schemas/driver.schemas.ts`                   | `+ email` on the profile schema                                                                                            | ✅ Correct                                                           |
| `auth/repositories/user.repository.ts`                | **`+ updateEmail(id, email, tx)`**                                                                                         | ✅ Correct — **and the driver path does not use it**                 |
| `shared/logger/logger.ts`                             | Redaction relaxed in development only                                                                                      | ✅ Safe (§4.3)                                                       |
| `users/*` (5 files)                                   | Email on the user profile path                                                                                             | Out of driver scope                                                  |

> **This is the single most important context for planning.** The explicit-onboarding work the brief describes as desired is already ~90 % written locally. The correct next step is to **finish and land it**, not to design it. Two one-line fixes make the tree green.

---

## 3. Complete Module Inventory

### 3.1 Registered production route surface

From `src/routes/register.ts`. This is the entire HTTP surface. `CODEBASE VERIFIED`

```
/health, /ready, /metrics        (+ /api/v1-prefixed health & ready)
/api/v1/auth      → registerAuthRoutes
/api/v1/users     → registerUserRoutes
/api/v1/files     → registerFileRoutes
/api/v1/rides     → rideRoutes
/api/v1/drivers   → driverRoutes
/api/v1/payments  → paymentRoutes
```

No `/api/v1/admin`, `/support`, `/vehicles`, `/geo`, or `/notifications`.

### 3.2 Module-level inventory

| Component                                                                            | Files Exist              | Logic Exists | Route/Event Exists                    | Production Caller                    | Test Coverage      | Status                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------ | ------------ | ------------------------------------- | ------------------------------------ | ------------------ | ----------------------------------------------------------------------- |
| `auth` (OTP, sessions, tokens)                                                       | ✅ 54                    | ✅           | ✅ `/api/v1/auth`                     | ✅                                   | Extensive HTTP     | `IMPLEMENTED_AND_WIRED`                                                 |
| `auth` → `grantRole` / `revokeRole`                                                  | ✅                       | ✅           | ❌ no route                           | ❌ **none**                          | Tested via service | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `auth` → `PermissionRepository`                                                      | ✅                       | ✅           | ❌                                    | ❌ **none**                          | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `auth` → `EpochInvalidationConsumer`                                                 | ✅                       | ✅           | ✅ subscriber                         | ✅ `bootstrapEvents`                 | ✅                 | `IMPLEMENTED_AND_WIRED`                                                 |
| `users`                                                                              | ✅ 41                    | ✅           | ✅ `/api/v1/users`                    | ✅                                   | Extensive HTTP     | `IMPLEMENTED_AND_WIRED`                                                 |
| `files`                                                                              | ✅ 47                    | ✅           | ✅ `/api/v1/files`                    | ✅                                   | Extensive          | `IMPLEMENTED_AND_WIRED`                                                 |
| `files` → `DRIVER_DOCUMENT` purpose                                                  | ✅                       | ✅ policy    | n/a                                   | ❌ **no consumer**                   | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `payments`                                                                           | ✅ 55                    | ✅           | ✅ `/api/v1/payments`                 | ✅                                   | Good               | `IMPLEMENTED_AND_WIRED`                                                 |
| `drivers` → onboarding                                                               | ✅                       | ✅           | ✅ `POST /me/onboard` _(uncommitted)_ | ✅                                   | ❌ **none**        | `IMPLEMENTED_BUT_PARTIAL`                                               |
| `drivers` → `getMe`                                                                  | ✅                       | ✅           | ✅ `GET /me`                          | ✅                                   | auth-probe only    | **`FAIL` — does not compile**                                           |
| `drivers` → documents (submit)                                                       | ✅                       | ✅           | ✅ `POST /:driverId/documents`        | ✅                                   | ❌ none            | `IMPLEMENTED_BUT_PARTIAL`                                               |
| `drivers` → document **review**                                                      | ❌                       | ❌           | ❌                                    | ❌                                   | ❌                 | **`MISSING`**                                                           |
| `drivers` → driver approval                                                          | ✅                       | ✅           | ✅ `POST /:id/verify` (`admin`)       | ✅                                   | ❌ none            | `IMPLEMENTED_BUT_PARTIAL`                                               |
| `drivers` → status/online-offline                                                    | ✅                       | ✅           | ✅                                    | ✅                                   | mock + fixture     | `IMPLEMENTED_BUT_PARTIAL`                                               |
| `drivers` → suspend                                                                  | ✅                       | ✅           | ✅ `POST /:id/suspend`                | ✅                                   | ❌ none            | **`FAIL` — deadlocks (§11.4)**                                          |
| `drivers` → location                                                                 | ✅                       | ✅           | ✅ `POST /location`                   | ✅                                   | unit only          | `IMPLEMENTED_AND_WIRED`                                                 |
| `drivers` → wallet (read)                                                            | ✅                       | ✅           | ✅                                    | ✅                                   | via earnings       | `IMPLEMENTED_AND_WIRED`                                                 |
| `drivers` → `ShiftService`                                                           | ✅                       | ✅           | ❌                                    | ❌ **none**                          | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `drivers` → `DriverBankRepository`                                                   | ✅                       | ✅           | ❌                                    | ❌ **none**                          | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `drivers` → `HeartbeatTimeoutJob`                                                    | ✅                       | ✅           | ✅ cron `* * * * *`                   | ✅                                   | ✅ runtime         | `IMPLEMENTED_AND_WIRED`                                                 |
| `drivers` → `DocExpirationJob`                                                       | ✅                       | ✅           | ✅ cron `0 2 * * *`                   | ✅                                   | ✅ runtime         | `IMPLEMENTED_AND_WIRED` (inert — §6.5)                                  |
| `drivers` → `plugins/driver.plugin.ts`                                               | ✅                       | ✅           | ❌                                    | ❌ **none**                          | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `drivers` → `schemas/driver.responses.ts`                                            | ✅                       | types only   | ❌                                    | ❌ **none**                          | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `geo` → position recording                                                           | ✅ 24                    | ✅           | via drivers                           | ✅                                   | ✅ integration     | `IMPLEMENTED_AND_WIRED`                                                 |
| `geo` → `findNearbyDrivers`                                                          | ✅                       | ✅           | ❌ no route                           | ❌ **none**                          | ✅ integration     | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `rides` → request / quote                                                            | ✅ 56                    | ✅           | ✅                                    | ✅                                   | good               | `IMPLEMENTED_AND_WIRED`                                                 |
| `rides` → accept/arrive/start/complete                                               | ✅                       | ✅           | ✅                                    | ✅                                   | unit + concurrency | `IMPLEMENTED_BUT_PARTIAL`                                               |
| `rides` → `DispatchService.offerToDriver`                                            | ✅                       | ✅           | ❌                                    | ❌ **none**                          | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `rides` → `RideDispatchRepository`                                                   | ✅                       | ✅           | ❌                                    | ❌ (except timeout job)              | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `rides` → `DispatchTimeoutJob`                                                       | ✅                       | ✅           | ✅ cron                               | ✅                                   | ✅ runtime         | `IMPLEMENTED_AND_WIRED` (inert)                                         |
| `rides` → `findActiveByDriver`                                                       | ✅                       | ✅           | ❌                                    | ❌ **none**                          | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |
| `rides` → `findActiveByDriverUserId`                                                 | ✅                       | ✅           | ✅ `GET /rides/active`                | ✅                                   | ❌                 | `IMPLEMENTED_AND_WIRED` (unreachable branch — §14.1)                    |
| `notifications` (SMS)                                                                | ✅ 7                     | ✅           | via OTP                               | ✅                                   | ✅                 | `IMPLEMENTED_AND_WIRED`                                                 |
| Push / FCM / APNs / realtime                                                         | ❌                       | ❌           | ❌                                    | ❌                                   | ❌                 | **`MISSING`**                                                           |
| `dispatch` module                                                                    | 2 (`export {}` + README) | ❌           | ❌                                    | ❌                                   | ❌                 | **`EMPTY_OR_STUB`**                                                     |
| `matching` module                                                                    | 2                        | ❌           | ❌                                    | ❌                                   | ❌                 | **`EMPTY_OR_STUB`**                                                     |
| `vehicles` module                                                                    | 2                        | ❌           | ❌                                    | ❌                                   | fixture inserts    | **`EMPTY_OR_STUB`**                                                     |
| `admin` module                                                                       | 2                        | ❌           | ❌                                    | ❌                                   | ❌                 | **`EMPTY_OR_STUB`**                                                     |
| `support` module                                                                     | 2                        | ❌           | ❌                                    | ❌                                   | ❌                 | **`EMPTY_OR_STUB`**                                                     |
| `onboarding` module                                                                  | 2                        | ❌           | ❌                                    | ❌                                   | ❌                 | **`EMPTY_OR_STUB`** (real code lives in `drivers/services/onboarding/`) |
| `documents` module                                                                   | 2                        | ❌           | ❌                                    | ❌                                   | ❌                 | **`EMPTY_OR_STUB`** (real code lives in `drivers/repositories/`)        |
| `analytics`, `chat`, `settings`, `sos`, `reviews`, `promotions`, `pricing`, `riders` | 2 each                   | ❌           | ❌                                    | ❌                                   | ❌                 | **`EMPTY_OR_STUB`**                                                     |
| `core/database/extensions/DriverExtensions`                                          | ✅                       | ✅           | applied to client                     | ❌ `findActiveDrivers` **0 callers** | ❌                 | `IMPLEMENTED_BUT_UNWIRED`                                               |

Re-verified in this session: `dispatch/index.ts`, `matching/index.ts`, `vehicles/index.ts`, `admin/index.ts` all contain exactly `export {};`.

### 3.3 Repository-wide empty scaffolding

`src/common/` (8 files), `src/infrastructure/` (7), `src/middleware/` (3), `src/plugins/socket/`, `src/plugins/jwt/`, `src/shared/{cache,events,pagination,response}`, `src/routes/index.ts` — all one-line `export {};`, none imported anywhere. Left in place per instructions. None is a partially built feature.

---

## 4. Actual Driver Entry / Onboarding Flow

Traced against the working tree. Steps 6–10 do **not** exist at `HEAD`.

| #   | Step                                                             | Status                                       | Exact code path                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Driver enters phone                                              | `PASS`                                       | `POST /api/v1/auth/otp/send` → `AuthController.sendOtp` → `AuthService.sendOtp`                                                                                                                                                                                 |
| 2   | Existing OTP service sends OTP                                   | `PASS`                                       | `OtpService.send` → Redis challenge claim → `otpProducer.enqueue` → BullMQ `auth-otp` → `OtpDeliveryJob` → `NotificationService.sendOtp` (MSG91). **No driver-specific OTP path exists or is needed.**                                                          |
| 3   | OTP verifies phone ownership                                     | `PASS`                                       | `OtpService.verify` → `assertChallengeBelongsToCaller` (binds `challengeId` to `phoneNumber` + `purpose` + unconsumed) → `redisService.otp.consume(hash)`                                                                                                       |
| 4   | Backend resolves authenticated User                              | `PASS`                                       | `AuthService.resolveAccount` — find-or-create by phone, `P2002` collision re-read via `isPhoneAlreadyTakenError`, `ensureDefaultRole` grants `customer`                                                                                                         |
| 5   | JWT / session issued                                             | `PASS`                                       | `SessionService.createInTransaction` → `TokenService.issuePair({ userId, sessionId, roles })`; `roles` from `RoleRepository.findActiveRoleSlugs`                                                                                                                |
| 6   | Explicit onboarding endpoint                                     | `PASS` _(working tree)_ / **`FAIL` at HEAD** | `POST /api/v1/drivers/me/onboard` → `DriverOnboardingController.onboard` → `OnboardingService.onboardDriver`. **At `HEAD` this route does not exist** — see step 12                                                                                             |
| 7   | Driver record created                                            | `PASS`                                       | `DriverRepository.createDriver` — `verificationStatus: PENDING`, `isAvailable: false`, `driverCode` generated, in a transaction with the `driver.onboarded` outbox event                                                                                        |
| 8   | Name stored                                                      | `PARTIAL`                                    | `PATCH /:driverId/profile` → `DriverProfile.fullLegalName`. `z.string().min(2).max(100).optional()` — length only; `" a"` passes                                                                                                                                |
| 9   | Gender stored                                                    | `PASS`                                       | `z.enum(['MALE','FEMALE','OTHER'])` at the boundary. Column is bare `String?` — Zod is the only enforcement                                                                                                                                                     |
| 10  | Email stored                                                     | `PARTIAL` _(uncommitted)_                    | `DriverRepository.updateProfile` → raw `client.user.update({ data: { email } })`. Bypasses `UserRepository.updateEmail` added in the same changeset. `@unique` collision → **500, not 409**; `isEmailVerified` never managed                                    |
| 11  | Survives logout / restart                                        | `PARTIAL`                                    | All state is persisted server-side and `findByUserId` returns `profile` + `documents` + `onlineStatus` in one read. But the probe endpoint (`GET /me`) does not compile, and 404s rather than returning an empty state                                          |
| 12  | GET does not create Driver records                               | **`PASS` (tree) / `FAIL` (HEAD)**            | **At `HEAD`, `getMe` called `createOrGetDriver` — `GET /api/v1/drivers/me` created a Driver row as a side effect.** The uncommitted diff replaces this with a pure read. This is the create-on-GET defect, caught mid-remediation                               |
| 13  | Concurrent onboarding safe                                       | `PASS` _(uncommitted)_                       | Read-then-create plus `P2002` re-read; `Driver.userId` is `@unique` (`SCHEMA VERIFIED`). At `HEAD` there is no `P2002` handling — a lost race threw                                                                                                             |
| 14  | Customer cannot accidentally become a Driver via a read endpoint | **`PASS` (tree) / `FAIL` (HEAD)**            | Same root cause as 12. Note that in the tree there is still **no role gate** on `POST /me/onboard` — any authenticated user may _deliberately_ apply. That is self-service signup, not a defect, but it means Driver-row existence signals nothing about intent |
| 15  | Frontend cannot submit another person's `userId`/`driverId`      | `PASS`                                       | `onboard` takes no body and no param. `updateProfile` and `submitDocument` parse `:driverId` and **ignore it**, using `actingDriverId(req)`. Safe — but the API signature lies (§17-S4)                                                                         |
| 16  | BOLA/IDOR uses JWT identity                                      | `PASS`                                       | `callerId(req)` → `request.auth.userId` ← JWT `sub`. `authorizedDriverId` adds a `['admin','support']` staff bypass for wallet/location reads                                                                                                                   |

**Verdict:** steps 1–5 are production-solid and shared with the Customer App. Steps 6–14 are correct **only in the uncommitted tree**, and that tree does not build.

---

## 5. Role Source of Truth

### 5.1 Where roles come from

`CODEBASE VERIFIED`. Roles originate solely from the `user_role_assignments` table, read at exactly two points:

- **Issuance** — `AuthService.runVerifyOtp` → `roleRepository.findActiveRoleSlugs(user.id)` → `tokenService.issuePair({ …, roles })`
- **Rotation** — `AuthService.refresh` → `tokenService.rotate(token, (userId) => this.resolveActiveRoles(userId))` → re-reads from the database

`authPlugin` then reads `claims.roles` into `request.auth.roles`. Nothing else supplies a role.

### 5.2 Can the frontend inject a role?

**No — structurally impossible.** `CODEBASE VERIFIED`

| Request schema    | Fields accepted                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `sendOtpSchema`   | `phoneNumber`, `device?`                                                                                 |
| `verifyOtpSchema` | `phoneNumber`, `code`, `challengeId?`, `device?`                                                         |
| `deviceSchema`    | `deviceId`, `platform`, `appVersion`, `osVersion`, `fingerprint`, `isRooted`, `isJailbroken`, `fcmToken` |
| `refreshSchema`   | `refreshToken`                                                                                           |

There is **no `role`, `roles`, `userType`, or `isDriver` field anywhere in the auth request surface**, and Zod strips unknown keys. `role=driver` and `role=admin` are both un-injectable.

> **The brief's core requirement is already satisfied and enforced by construction. It must be preserved, not built.**

### 5.3 `DEFAULT_USER_ROLE` risk

`DEFAULT_ROLE_SLUG = process.env.DEFAULT_USER_ROLE ?? 'customer'` (`auth.constants.ts:3`), consumed by `ensureDefaultRole` on every login.

> **Finding (`PARTIAL`, security-relevant):** this is an **unvalidated environment variable that assigns a role to every user at login**. Setting `DEFAULT_USER_ROLE=admin` would grant `admin` to every account that logs in. There is no allow-list restricting it to `customer`. Mitigations that exist: `ensureDefaultRole` throws if the slug is not seeded, so a typo fails loudly rather than silently. **Recommended action:** validate against a constant set at config load. Low likelihood, catastrophic impact.

### 5.4 Is the `driver` role ever granted in production?

**No.** Re-verified in this session:

```
$ grep -rn "grantRole" src --exclude-dir=generated
src/modules/auth/services/auth.service.ts:256:  async grantRole(
```

One hit — the definition. 28 further references, all under `tests/`. `tests/integration/helpers/fixtures.ts:5` defines its own `grantRole` that inserts `userRoleAssignment` rows directly with Prisma, bypassing the service.

`grantRole` itself is **complete and correct**: resolves the slug (throws if unseeded), checks for an existing active assignment inside a transaction and returns `false` if present (idempotent), inserts, publishes `account.role.granted` to the outbox in the same transaction, and calls `epochService.bump(userId)` after commit.

### 5.5 The required future chain — does it exist?

```
Admin approves driver
  → POST /api/v1/drivers/:id/verify  { status: 'VERIFIED' }   ✅ EXISTS
  → backend verifies eligibility                              ❌ MISSING — documents never checked
  → backend assigns DRIVER role                               ❌ MISSING — grantRole never called
  → token state refreshed / invalidated                       ⚠️  MECHANISM EXISTS, never triggered
  → driver accesses Driver-only functionality                 ❌ BLOCKED
```

Link 4 deserves precision: `EpochInvalidationConsumer` subscribes to `account.role.granted` and bumps the epoch; `authPlugin` compares `claims.epoch` to the live epoch and returns `401 TOKEN_STALE`; the client refreshes and `resolveActiveRoles` re-reads from the database. **The invalidation machinery is complete and will fire automatically the moment `grantRole` is called.** Nothing to build there.

**Status: `MISSING` at links 2 and 3. The rest is `PASS`.**

---

## 6. Document Lifecycle

### 6.1 Supported types

`SCHEMA VERIFIED` — `DriverDocumentType`: `DRIVING_LICENSE`, `RC`, `INSURANCE`, `AADHAAR`, `PAN`, `PUC`, `POLICE_VERIFICATION`, `PROFILE_PHOTO`. Mirrored in `driver.constants.ts` and `submitDriverDocumentSchema`.

**Mandatory set: not declared anywhere in `src/`.** The only requirement encoded in production code is in `StatusService.setOnline`:

```ts
const hasValidLicense = docs.some(
  (d) => d.documentType === 'DRIVING_LICENSE' && d.verificationStatus === 'VERIFIED',
);
```

One type, and **`expiresAt` is ignored** at that moment.

### 6.2 Is client-supplied `fileUrl` trusted directly?

**Yes, completely.** `CODEBASE VERIFIED`

```ts
// drivers/schemas/driver.schemas.ts
fileUrl: z.string().url(),
```

`SCHEMA VERIFIED` — `DriverDocument.fileUrl String @map("file_url")`. A plain string, no `fileId`, no FK to `files`.

There is no upload step, no ownership check, no existence check, no content inspection, no host allow-list. **The question "can a driver reference another user's uploaded file?" does not apply** — the driver never references a file record at all.

**What the Files module already provides and nothing uses:**

| Capability                                                                                                                                                      | Location                                      | State                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DRIVER_DOCUMENT` purpose — jpeg/png/webp/pdf, 10 MB, 5000×5000 px, `rejectExifLocation: true`, 300 s read TTL, 2920-day ARCHIVE on `DRIVER_RELATIONSHIP_ENDED` | `config/file/file.config.ts:39-46`            | Defined, **zero consumers**                                                           |
| Presigned PUT → `POST /files/:id/complete` (magic bytes vs declared type, size, dimensions, checksum, EXIF-location; refused objects deleted)                   | `files/routes`, `file-upload.service.ts`      | Live                                                                                  |
| `decideRead` — `DRIVER_DOCUMENT` requires `drivers:verify`, held by `admin`, deliberately **not** `support`; operator reads audited                             | `files/services/file-access.service.ts:28-39` | Live, **already anticipates driver review**                                           |
| `registerFileReference(purpose, check)` → `DELETE /files/:id` returns `409 FILE_IN_USE`                                                                         | `files/services/file-reference.service.ts`    | Live. Only `users` registers (`PROFILE_IMAGE`). **No `DRIVER_DOCUMENT` registration** |
| Scan state machine — files unusable until `READY` (migration `20260812150000`)                                                                                  | `files/`                                      | Live. **Driver documents get none of it**                                             |

> The purpose name, the retention trigger `DRIVER_RELATIONSHIP_ENDED`, and the `drivers:verify` operator scope all show Files was designed for this. The driver module simply never connected. **Connect it; do not build a driver file store.**

### 6.3 Submission and re-submission

`DriverDocumentRepository.upsertDocument`:

```ts
const existing = await client.driverDocument.findFirst({ where: { driverId, documentType } });
if (existing) return client.driverDocument.update({ where: { id: existing.id }, data: {
  fileUrl, documentNumber: …, issuedAt: …, expiresAt: …,
  verificationStatus: 'PENDING',      // ← reset on re-upload ✅ correct
}});
return client.driverDocument.create({ … verificationStatus: 'PENDING' });
```

Status reset on re-upload is **correct** — an approved-then-swapped document cannot keep its approval. Two defects:

1. **Stale review metadata survives.** `verifiedBy`, `verifiedAt`, `verificationNotes`, `rejectionReason` are left intact. A re-uploaded document reads `PENDING` while still carrying the previous reviewer's identity and timestamp.
2. **Racy.** `SCHEMA VERIFIED` — re-checked `migration.sql`: `driver_documents` has plain indexes on `driver_id`, `document_type`, `expires_at` and **no unique constraint on `(driver_id, document_type)`**. Concurrent submissions of one type both miss `findFirst` and both `create`. `docs.some(...)` then passes if _either_ copy is approved.

Driver-status side effect: `submitDocument` promotes `PENDING → DOCUMENT_REVIEW` **only from exactly `PENDING`**. A `REJECTED` driver who re-uploads stays `REJECTED` — the resubmission never re-enters the queue.

### 6.4 Every production writer of the four review fields

Exhaustive, `src/` excluding `generated/`. `CODEBASE VERIFIED`

| Field                                              | Production writers                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `verificationStatus = PENDING`                     | `DriverDocumentRepository.upsertDocument` (create + update branches)                                                                    |
| `verificationStatus = REJECTED`                    | `DocExpirationJob` → `updateVerificationStatus(doc.id, 'REJECTED', undefined, 'Document expired')` — **the only caller of that method** |
| **`verificationStatus = VERIFIED`**                | **NONE**                                                                                                                                |
| `verifiedBy`                                       | **NONE** — the sole caller passes `undefined`                                                                                           |
| `verifiedAt`                                       | **NONE** — set only on the `VERIFIED` branch, which is unreachable                                                                      |
| `rejectionReason`                                  | Only `DocExpirationJob`, always the literal `'Document expired'`                                                                        |
| `verificationNotes`, `ocrData`, `documentChecksum` | **NONE** — never written by any code                                                                                                    |

There is **no `EXPIRED` status**: `VerificationStatus` is `PENDING | VERIFIED | REJECTED` (`SCHEMA VERIFIED`), so the expiry job overloads `REJECTED` and "expired" is indistinguishable from "rejected for fraud".

### 6.5 The expiration job

Fully plumbed — verified end to end: scheduled `0 2 * * *` on `drivers-maintenance`; `MAINTENANCE_HANDLERS[DRIVER_DOC_EXPIRATION] = 'docExpirationJob'`; registered in DI; worker started by `startMaintenanceWorkers()`; Redis lock acquired and released in `finally`.

> **It can never fire.** Its query requires `verificationStatus: 'VERIFIED'`, which no production code writes. Correct, scheduled, locked, and permanently a no-op.

### 6.6 The decisive answer

> **Can any real production API mark a driver document `VERIFIED`?**
>
> **NO.** `CODEBASE VERIFIED`
>
> No route (the only admin driver routes are `/:id/verify` and `/:id/suspend`; neither touches `driver_documents`). No service (`OnboardingService` has no document-review method). No job (`DocExpirationJob` writes only `REJECTED`). No subscriber (`EpochInvalidationConsumer` is the only one in the codebase, handling four auth events).
>
> The only `VERIFIED` writes to that column anywhere are `db().client.driverDocument.create({ … verificationStatus: 'VERIFIED' })` in `tests/integration/helpers/fixtures.ts:31-38` — a fixture, excluded by definition.
>
> **Classification: `MISSING`. This is the first production blocker.**

---

## 7. Driver Approval Lifecycle

`SCHEMA VERIFIED` — `DriverVerificationStatus`: `PENDING | DOCUMENT_REVIEW | VERIFIED | REJECTED | SUSPENDED`.

### 7.1 Actual transitions

| Transition                    | Writer                                                                                       | Status    |
| ----------------------------- | -------------------------------------------------------------------------------------------- | --------- |
| → `PENDING`                   | `createDriver` default                                                                       | `PASS`    |
| `PENDING` → `DOCUMENT_REVIEW` | `submitDocument` (only from exactly `PENDING`); `DocExpirationJob`                           | `PARTIAL` |
| → `VERIFIED`                  | `reviewDriverVerification` via `POST /:id/verify`                                            | `PARTIAL` |
| → `REJECTED`                  | Same route                                                                                   | `PARTIAL` |
| → `SUSPENDED`                 | **Never.** Suspension uses the separate boolean `Driver.isSuspended`; the enum value is dead | `MISSING` |

### 7.2 What approval does

`OnboardingService.reviewDriverVerification` — done well: `lockForUpdate` before the read-modify-write; `approvedAt`/`approvedBy` on the `VERIFIED` branch; `driver.verified` published inside the transaction via the outbox; a `warn` log with `{ driverId, status, reviewerUserId }`.

### 7.3 What approval does not do

| Question                                         | Answer            | Evidence                                                                                                                                                                                                        |
| ------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Can admin approve with zero documents?**       | **YES**           | `reviewDriverVerification` never queries `driver_documents`. `POST /:id/verify {"status":"VERIFIED"}` succeeds on a driver with no profile, no documents, no vehicle. `FAIL`                                    |
| Which documents are mandatory?                   | **None declared** | No required set anywhere in `src/`                                                                                                                                                                              |
| Must mandatory documents be `VERIFIED`?          | **Not checked**   | —                                                                                                                                                                                                               |
| Are expired documents excluded from eligibility? | **Only nightly**  | `setOnline` ignores `expiresAt`                                                                                                                                                                                 |
| Can an approved driver resubmit?                 | Yes               | `upsertDocument` resets to `PENDING`                                                                                                                                                                            |
| What happens to eligibility after resubmission?  | **Nothing**       | `Driver.verificationStatus` stays `VERIFIED`; `isOperableDriver` still passes. Only `setOnline`'s licence check would fail — on a _new_ online attempt. An already-online driver is unaffected. `FAIL`          |
| Can `support` approve?                           | **No**            | Route requires `roles: ['admin']`. Matches the seed (`support` lacks `drivers:verify`) — by coincidence, since the route checks the role slug, not the permission code                                          |
| Can `admin` approve?                             | Yes               | `PASS`                                                                                                                                                                                                          |
| Is approval transactional?                       | Yes               | `txManager.execute` + `lockForUpdate`                                                                                                                                                                           |
| Are events/outbox entries emitted?               | Yes               | `driver.verified`, `classification: 'audit'`                                                                                                                                                                    |
| Is approval idempotent?                          | **Partially**     | Re-approving rewrites `approvedAt` and re-publishes the event. No legal-predecessor check; `REJECTED` → `VERIFIED` is permitted directly. `InvalidDriverStatusTransitionError` exists with **zero throw sites** |
| Is there an audit trail?                         | **Partially**     | No `AuditLog` model — `prisma/schema/shared/audit.prisma` is a single comment line (`SCHEMA VERIFIED`). What exists: `warn` logs, and outbox rows classified `audit`                                            |

### 7.4 Does approval trigger the role grant?

**No.** §5.4. `driver.verified` is published to a bus with zero subscribers, and `grantRole` is never called from anywhere.

---

## 8. Onboarding State Decision

The brief asked not to assume a missing explicit state is automatically a P0. It is not.

**What already exists.** `DriverRepository.findByUserId` uses `include: { profile: true, documents: true, onlineStatus: true }`, so one `GET /drivers/me` returns everything needed:

| Question                          | Derivable from                                        |
| --------------------------------- | ----------------------------------------------------- |
| Applied?                          | 404 vs 200                                            |
| Profile filled?                   | `profile === null` / `profile.fullLegalName === null` |
| Documents submitted?              | `documents[].documentType`                            |
| Approved / rejected per document? | `documents[].verificationStatus`, `rejectionReason`   |
| Under review?                     | `verificationStatus === 'DOCUMENT_REVIEW'`            |
| Approved?                         | `verificationStatus === 'VERIFIED'`, `approvedAt`     |
| Why rejected?                     | `rejectionReason`                                     |
| Online?                           | `onlineStatus.status`                                 |

**What the backend actually prevents:**

| Guard                                    | Enforced?                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Incomplete profile → document submission | ❌ Not enforced. All profile fields are `.optional()`; `submitDocument` never reads the profile |
| Incomplete documents → driver approval   | ❌ **Not enforced** (§7.3)                                                                      |
| Unapproved driver → online               | ✅ Enforced twice — `requireOperableDriver` + `setOnline`                                       |
| Suspended driver → online                | ✅ Enforced twice                                                                               |

> ### Classification: **`DESIGN_GAP`** — not a `PRODUCTION_BLOCKER`
>
> **Evidence.** The two safety-critical gates (unapproved → online, suspended → online) are both enforced, in two independent layers. The persisted fields already support every progress question the app needs, in a single round trip. A dedicated `onboardingStep` enum would duplicate information the schema already carries and would need to be kept consistent with it — a new class of bug.
>
> **What is actually needed** is smaller than a state column:
>
> 1. the compile fix, so the endpoint works at all (P0-1);
> 2. `GET /me` returning **200 with an empty/null payload** instead of `404`, so the app can distinguish "not applied" from "server error";
> 3. a **declared required-document set** in one shared constant, so client and server agree on "complete";
> 4. a completeness check before approval (P0-4).
>
> Items 3 and 4 are the real gap. **This is the single most important place not to over-build.**

---

## 9. Vehicle Module Status

**Classification: `EMPTY_OR_STUB` over a complete schema.** `src/modules/vehicles/` = `index.ts` (`export {};`, re-verified) + `README.md`. No routes, services, repositories, controllers, or DI registration.

| Capability                                | Schema                                                                                                                         | Production code                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Vehicle registration                      | ✅ `Vehicle` — `registrationNumber @unique`, `vin @unique`, make/model/year/colour/fuel/seating, `currentDriverId`, `isActive` | ❌ None                                   |
| Vehicle types / service type              | ✅ `VehicleType` — `code`, `isActive`, capacities, full fare basis                                                             | ⚠️ **Read-only** by `rides/services/fare` |
| Vehicle documents (RC / INSURANCE / PUC)  | ✅ `VehicleDocument` — `documentType` is free-text `String`, **not an enum**; `fileUrl`, `expiresAt`, `verificationStatus`     | ❌ None                                   |
| Expiry                                    | ✅ `expiresAt` + index                                                                                                         | ❌ No job                                 |
| Admin approval                            | ⚠️ Per-document `verificationStatus` only; no vehicle-level approval column                                                    | ❌ None                                   |
| Driver assignment                         | ✅ `VehicleAssignment` — driverId, vehicleId, assignedAt, releasedAt, reason, assignedBy, status                               | ❌ **Zero hand-written references**       |
| `Driver.currentVehicleId`                 | ⚠️ Column exists, **no `@relation`, therefore no FK**                                                                          | ❌ **Zero hand-written references**       |
| Inspections / maintenance / fuel / claims | ✅ Four models                                                                                                                 | ❌ None                                   |

### 9.1 The architecture decision, from schema evidence

> **Should a driver require an eligible assigned vehicle before going ONLINE?**
>
> **No — the requirement belongs at ACCEPT, not at ONLINE.** This is what the committed schema implies, not a preference:
>
> | Model                    | Field     | Nullability                                                                                                                    |
> | ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
> | `Ride.vehicleId`         | `String`  | **NOT NULL** — confirmed in `migration.sql:1567` (`"vehicle_id" UUID NOT NULL`) and `vehicle Vehicle @relation` (non-optional) |
> | `RideDispatch.vehicleId` | `String?` | **NULLABLE** — `vehicle Vehicle? @relation`                                                                                    |
> | `DriverOnlineStatus`     | —         | **No vehicle column at all**                                                                                                   |
>
> The schema therefore states three things explicitly: an **offer** may exist without a vehicle; a **ride cannot be created** without one; and **availability is modelled independently of vehicles**.
>
> **Consequence for design:** going online without a vehicle is schema-legal and should stay legal. The hard gate belongs on `POST /rides/accept`, which today accepts a client-supplied `vehicleId` with **no validation whatsoever** (§14.2). Adding a vehicle requirement to `setOnline` would contradict `DriverOnlineStatus`, which was deliberately built without one.
>
> A soft signal at online time (warn, or expose `hasEligibleVehicle` in `GET /me`) is compatible with the schema. A hard block is not.

---

## 10. Eligibility Gate

Two independent mechanisms that check different things.

**Route guard** — `authPlugin` `requireOperableDriver` → `DriverAccessRepository.isOperableDriver`:

```ts
findFirst({
  where: { userId, verificationStatus: 'VERIFIED', isSuspended: false, deletedAt: null },
});
```

Fails closed (`503`) on database error. Applied to `POST /drivers/status/online` and `POST /rides/{accept,:id/arrive,:id/start,:id/complete}`.

**Service gate** — `StatusService.setOnline`, inside one transaction after `lockForUpdate`: driver exists → `VERIFIED` → not suspended → a `VERIFIED` `DRIVING_LICENSE`.

### 10.1 Full gate matrix

| Gate                              | Enforced?                              | Where                                                                                                                           |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated user                | ✅                                     | `authPlugin` deny-by-default `onRequest`                                                                                        |
| **`driver` role in JWT**          | ❌ **Not checked on any driver route** | The `roles:['driver']` + `requireOperableDriver` pairing exists only in a **test-only** route inside `auth-driver-gate.test.ts` |
| Driver record exists              | ✅                                     | `actingDriverId` + `isOperableDriver`                                                                                           |
| `verificationStatus === VERIFIED` | ✅ twice                               | guard + service                                                                                                                 |
| Required verified documents       | ⚠️ **`DRIVING_LICENSE` only**          | RC, INSURANCE, PUC, AADHAAR, PAN, POLICE_VERIFICATION never required                                                            |
| Licence expiry at go-online       | ❌                                     | `setOnline` ignores `expiresAt`                                                                                                 |
| Vehicle requirement               | ❌                                     | `currentVehicleId` never read (and per §9.1 should not gate online)                                                             |
| Vehicle assignment                | ❌                                     | `VehicleAssignment` never touched                                                                                               |
| Suspension                        | ✅ twice                               | guard + service                                                                                                                 |
| Active-ride conflict              | ❌                                     | `findActiveByDriver` has **zero callers**                                                                                       |
| Existing active shift             | ✅                                     | `startShift` returns the open shift rather than creating a second                                                               |

> **Note the layering subtlety:** `requireOperableDriver` checks the _Driver row_, not the JWT role. An admin-approved driver therefore **passes the route guard** and is rejected one layer deeper by `setOnline`'s licence check. The client sees `403 "Driver is not operable"` while the real cause is `DRIVER_NOT_VERIFIED`. Misleading during debugging.

---

## 11. Online / Offline State Machine

`SCHEMA VERIFIED` — `DriverStatus`: `ONLINE | OFFLINE | BUSY | ON_TRIP | BREAK`.

| Transition               | Endpoint                       | Service                       | Authorization               | DB write                                                           | Tx / lock                    | Event                   | Production caller                                 |
| ------------------------ | ------------------------------ | ----------------------------- | --------------------------- | ------------------------------------------------------------------ | ---------------------------- | ----------------------- | ------------------------------------------------- |
| → `ONLINE`               | `POST /drivers/status/online`  | `setOnline`                   | `requireOperableDriver`     | `driver_online_status`, `drivers.isAvailable`, `driver_shift_logs` | ✅ tx + `FOR UPDATE`         | `driver.status_changed` | ✅ (unsatisfiable)                                |
| → `OFFLINE` (driver)     | `POST /drivers/status/offline` | `setOffline`                  | ⚠️ **no operability guard** | same + `shiftEnd`                                                  | ✅ tx + lock                 | `driver.status_changed` | ✅                                                |
| → `OFFLINE` (heartbeat)  | —                              | `HeartbeatTimeoutJob`         | job                         | same                                                               | ✅                           | ✅                      | ✅ cron                                           |
| → `OFFLINE` (suspension) | `POST /drivers/:id/suspend`    | `setSuspended` → `setOffline` | `roles:['admin']`           | `drivers.isSuspended` + status                                     | ❌ **nested tx — deadlocks** | `driver.suspended`      | ✅ (broken)                                       |
| → `BUSY`                 | —                              | —                             | —                           | —                                                                  | —                            | —                       | ❌ **no writer anywhere**                         |
| → `ON_TRIP`              | —                              | —                             | —                           | —                                                                  | —                            | —                       | ❌ **no writer anywhere**                         |
| → `BREAK`                | —                              | —                             | —                           | —                                                                  | —                            | —                       | ❌ **no writer**; only read by `findStaleDrivers` |
| → `SUSPENDED` (enum)     | —                              | —                             | —                           | —                                                                  | —                            | —                       | ❌ dead enum value                                |

### 11.1 Answers to the specific questions

| Question                                                    | Answer                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Can an unverified driver go online?                         | **No** — blocked twice                                                                                                 |
| Can a driver with unverified mandatory documents go online? | **No for `DRIVING_LICENSE`** (and that is why _nobody_ can go online). **Yes for every other type** — none is required |
| Can a driver with an expired licence go online?             | **Yes, for up to ~24 h** — `setOnline` ignores `expiresAt`; only the 02:00 UTC job reacts                              |
| Is the `DRIVER` role required?                              | **No** — no driver route checks it                                                                                     |
| Is a vehicle required?                                      | **No** — and per §9.1 that matches the schema                                                                          |
| Can an already-active driver accept another ride?           | **Yes** — `findActiveByDriver` has zero callers                                                                        |
| Who writes `BUSY`?                                          | **Nobody**                                                                                                             |
| Who writes `ON_TRIP`?                                       | **Nobody**                                                                                                             |
| Is `setSuspended` safe?                                     | **No — it self-deadlocks.** §11.4                                                                                      |
| One source of truth for availability?                       | **No — three.** §11.5                                                                                                  |

### 11.4 `setSuspended` self-deadlock — `FAIL`

```ts
await this.txManager.execute(async (tx) => {
  await this.driverRepo.lockForUpdate(driverId, tx);        // outer tx holds SELECT … FOR UPDATE
  await this.driverRepo.setSuspended(driverId, isSuspended, tx);
  if (isSuspended) {
    await this.setOffline(driverId, 'ADMIN_SUSPENSION');    // ← opens a SECOND transaction
```

`TransactionManager.execute` unconditionally calls `this.provider.client.$transaction(callback, …)` — verified at `TransactionManager.ts:29`. It does not detect or join an in-flight transaction. The nested `setOffline` therefore runs on a **different pooled connection** and issues its own `FOR UPDATE` on the row the outer transaction still holds.

The inner statement blocks; the outer cannot commit because it awaits the inner; Prisma's interactive-transaction timeout (5 s default, not overridden) aborts it.

> **`POST /api/v1/drivers/:id/suspend` with `{"isSuspended": true}` hangs, then fails. Suspending a driver — a safety operation — does not work.** `{"isSuspended": false}` skips the branch and succeeds.
>
> Secondary defect: `setOffline` publishes `driver.status_changed` from its own transaction while the outer one is still open, so even on hypothetical success the outbox ordering is wrong.
>
> Also: the body is read as `req.body as { isSuspended: boolean }` — a raw cast, the only driver route with no Zod parse. A malformed body yields `undefined`, the `if` is falsy, and the admin gets `{ success: true }` for a no-op.

### 11.5 Availability has three sources of truth

`CODEBASE VERIFIED` — three separate stores must be kept in agreement:

1. `Driver.isAvailable` (boolean)
2. `DriverOnlineStatus.status` (enum)
3. The Redis live geo index (`RedisGeoProvider`)

`setOnline`/`setOffline` write all three consistently. But **`setSuspended` writes only #1** (via `setSuspended` → `isAvailable: false`) and reaches #2/#3 only through the deadlocking `setOffline`. When suspension times out, a suspended driver can be left `isAvailable: false` while `DriverOnlineStatus.status` is still `ONLINE` and they remain in the geo index.

> **Finding (`FAIL`, concurrency):** suspension can leave the three stores permanently inconsistent, and the inconsistency makes a suspended driver dispatchable the moment dispatch is wired.

### 11.6 `HeartbeatTimeoutJob`

Fully wired (cron `* * * * *`, DI-resolved, Redis-locked). Sweeps `status IN ('ONLINE','BREAK')` with `heartbeatAt <= now - heartbeatTimeoutSeconds`, calling `setOffline(driverId, 'HEARTBEAT_TIMEOUT')` per driver with per-driver error capture.

Two gaps: it never calls `driverMetrics.heartbeatTimeout()`, which exists for exactly this; and a driver who went `ONLINE` but never sent a heartbeat has `heartbeatAt = null`, which does not match `{ lte: threshold }` and is **never swept**.

---

## 12. Location and Geo

**`POST /api/v1/drivers/location`** — rate-limited (`rateLimits.driverLocation`), **no operability guard**. `LocationService.updateLocation`:

1. Reject `isMockLocation === true` when `driverConfig.rejectMockLocation` → `MockLocationRejectedError`
2. Driver must exist
3. `assessPlausibility` vs the previous fix → `ImplausibleLocationError` + `warn` log
4. `locationRepo.updateLocation` — raw `INSERT … ON CONFLICT (driver_id) DO UPDATE`, writing decimal lat/lng **and** the PostGIS `geography(Point,4326)` column, `recorded_at = now()`
5. `geoService.recordDriverPosition` — H3 cell computed, written to the Redis live store
6. `statusRepo.updateHeartbeat` — a location fix doubles as a heartbeat

`GET /api/v1/drivers/:id/location` — `authorizedDriverId(req, repo, id, ['admin','support'])`. Correct BOLA handling.

### 12.1 Who can enter the geo index

| Driver state                      | Enters index? | Correct?                                                                               |
| --------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `PENDING`                         | **YES**       | ❌ **No** — never approved                                                             |
| `DOCUMENT_REVIEW`                 | **YES**       | ❌ **No**                                                                              |
| `VERIFIED` + `OFFLINE`            | **YES**       | ❌ **No** — offline drivers should not be candidates                                   |
| `SUSPENDED` (`isSuspended: true`) | **YES**       | ❌ **No** — and suspension's `forgetDriverPosition` is on the deadlocking path (§11.4) |
| `VERIFIED` + `ONLINE`             | YES           | ✅ Correct                                                                             |
| `BUSY` / `ON_TRIP`                | n/a           | Unreachable states                                                                     |

The root cause is that **the location route has no eligibility gate**, and `PostgisProvider.findNearbyDrivers` queries `driver_locations` **alone** — no join to `drivers`, no filter on `verificationStatus`, `isSuspended`, `isAvailable`, or `DriverOnlineStatus.status`.

### 12.2 What removes a driver from the index

Three mechanisms, none state-aware:

1. **Explicit** — `setOffline` → `geoService.forgetDriverPosition`, correctly placed **after** commit so a Redis failure cannot roll back the database write. Errors are logged and swallowed inside the geo service.
2. **Redis TTL** — `geoConfig.liveLocationTtlSeconds` = 300 s (`GEO_LIVE_LOCATION_TTL_SEC`).
3. **PostGIS freshness** — `candidateStalenessSeconds` = 120 s bounds `recorded_at` in the radius query.

**Not removed by:** suspension (see above), or entering `BUSY`/`ON_TRIP` (never written).

### 12.3 Race protection

Plausibility checking is a read-then-write with no lock, so two concurrent updates for one driver can interleave; the `ON CONFLICT` upsert keeps the row consistent, and last-write-wins on a position stream is acceptable. `RedisGeoProvider.setPosition` returns a boolean indicating a stale rejection, and the service emits `positionRejectedStale` — so the live store does have monotonicity protection. `PASS`, with the caveat that database and Redis can briefly disagree.

### 12.4 The required statement

> `findNearbyDrivers` production callers: **searched `src/` excluding `generated/` — the only call sites are `geo.service.ts:19` (facade → `nearby.find`) and `nearby-driver.service.ts:44` (→ `postgisProvider`), both internal delegation within the geo module.** No route, no service outside geo, no job, no subscriber. 23 references in `tests/`, all resolving the service straight from the DI container.
>
> **"Geo write path exists, discovery read path is unwired."**

---

## 13. Matching and Dispatch

| Question                               | Answer                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatch module?                       | **`EMPTY_OR_STUB`** — `src/modules/dispatch/index.ts` is `export {};` (re-verified)                                                                                                                                                                                                                  |
| Matching module?                       | **`EMPTY_OR_STUB`** — same                                                                                                                                                                                                                                                                           |
| `findNearbyDrivers` production caller? | **None** (§12.4)                                                                                                                                                                                                                                                                                     |
| `RideDispatch` exists?                 | **In schema yes** — `@@unique([requestId, driverId])`, `dispatchRound`, `expiresAt`, `response`, `driverDistanceM`, `driverEtaSeconds`. In code, referenced only by `RideDispatchRepository` and `DispatchTimeoutJob`                                                                                |
| `RideOffer` exists?                    | **No such model or symbol** anywhere. The offer concept is `RideDispatch`                                                                                                                                                                                                                            |
| `LockStore` exists?                    | **Yes, and genuinely used** — `core/cache/stores/LockStore.ts`, Lua compare-and-delete release. Ten live callers: `auth-retention`, `session.service`, `doc-expiration`, `heartbeat-timeout`, `files/{reconciliation,retention,sweeper}`, `payments/{reconciliation,settlement}`, `dispatch-timeout` |
| `offerToDriver` callers?               | **None.** `DispatchService.offerToDriver` is complete (creates the offer, 30 s expiry, metric, publishes `ride.dispatch_offered`). Registered in DI and hung off `rideService.dispatch`; nothing reads that property                                                                                 |
| Redis locks used?                      | **Yes** (above)                                                                                                                                                                                                                                                                                      |
| Offer timeout job?                     | **Yes, scheduled** — `DispatchTimeoutJob`, `* * * * *`, Redis-locked. Marks `PENDING` + `expiresAt <= now` as `TIMEOUT`. **Operates on a table nothing writes, and does not re-offer** — timeout is terminal                                                                                         |
| One-driver-one-active-ride?            | **Not enforced** — `findActiveByDriver` has zero callers                                                                                                                                                                                                                                             |
| `ONLINE`/`BUSY`/`ON_TRIP` written?     | `ONLINE` ✅, `OFFLINE` ✅, **`BUSY` ❌, `ON_TRIP` ❌**                                                                                                                                                                                                                                               |

### 13.1 Where the chain breaks

`RideRequestService.createRequest` ends at:

```ts
const request = await this.requestRepo.create(createInput, tx);
this.rideMetrics.requestCreated({ requestId: request.id });
await this.eventPublisher.publish(rideEvent(RIDE_EVENT_CATALOG.REQUESTED, …), tx);
return request;
```

```
POST /rides/requests
  └─ RideRequest row (CREATED)
       └─ publish ride.requested ──► ZERO SUBSCRIBERS ──► ✗ END

  [ findNearbyDrivers      — complete, 0 production callers ]
  [ offerToDriver          — complete, 0 production callers ]
  [ RideDispatchRepository — complete, 0 callers except the timeout job ]
  [ DispatchTimeoutJob     — scheduled, permanently empty table ]

POST /rides/accept ← the ONLY way a Ride is ever created,
                     and the driver must already know the requestId
```

`RequestExpiryJob` (cron `* * * * *`) is the only thing that currently happens to a request after creation.

> **Assessment: the dispatch primitives exist and are individually correct. What is missing is the orchestrator** — a subscriber or job that reacts to `ride.requested`, calls `findNearbyDrivers`, filters by operability and availability, calls `offerToDriver` in rounds, and advances on timeout. **Do not recreate the primitives.**

---

## 14. Ride Authorization

### 14.1 Competing gates — and a live defect

Four mechanisms exist and they do **not** all agree:

| Mechanism                      | What it checks                                          | Used where                                                    |
| ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| `requireOperableDriver`        | `drivers` row: `VERIFIED` + not suspended + not deleted | 5 routes                                                      |
| `callerHasRole(req, 'driver')` | JWT claim                                               | `RideStateController.cancel`, `RideQueryController.getActive` |
| `Driver.verificationStatus`    | Read again in `setOnline`                               | `setOnline`                                                   |
| `actingDriverId`               | Driver row exists for this user                         | All driver-scoped controllers                                 |

> ### Finding (`FAIL`, live today): the missing role grant already breaks two shipped endpoints
>
> `RideQueryController.getActive` (`GET /api/v1/rides/active`):
>
> ```ts
> if (callerHasRole(req, 'driver')) {
>   const driverRide = await this.rideRepo.findActiveByDriverUserId(userId);
>   return reply.send({ data: driverRide });
> }
> const activeRide = await this.rideRepo.findActiveByCustomer(userId);
> ```
>
> Because **no user ever holds the `driver` role** (§5.4), the `if` is dead. A real approved driver on an active trip calls `GET /rides/active` and is served `findActiveByCustomer` — **their customer ride, or `null`**. Their actual trip is invisible to their own app.
>
> `RideQueryController.listHistory` is worse: it calls `listCustomerRides(callerId(req))` **unconditionally**, so a driver's ride history is always their passenger history.
>
> This is not a future consequence. It is a current defect whose root cause is P0-3, and it means `findActiveByDriverUserId` — though it _has_ a production caller — sits behind an unreachable branch.

### 14.2 Per-action verification

| Action   | `driver` role?          | `VERIFIED`? | State req?          | Ownership?         | Active-ride check? | Tx / lock?              | Idempotent?            |
| -------- | ----------------------- | ----------- | ------------------- | ------------------ | ------------------ | ----------------------- | ---------------------- |
| Accept   | ❌                      | ✅ guard    | ❌                  | n/a                | ❌ **none**        | ✅ tx + `claimForMatch` | ✅ via `claimForMatch` |
| Arrive   | ❌                      | ✅ guard    | ✅ transition table | ✅ `ride.driverId` | n/a                | ✅ tx + lock + CAS      | ✅ CAS                 |
| Start    | ❌                      | ✅ guard    | ✅                  | ✅                 | n/a                | ✅ + OTP verify         | ✅ CAS                 |
| Complete | ❌                      | ✅ guard    | ✅                  | ✅                 | n/a                | ✅ + ledger             | ✅ CAS                 |
| Cancel   | ⚠️ `callerHasRole` only | ❌ no guard | ✅                  | ✅                 | n/a                | ✅                      | ✅ CAS                 |

The state machine (`ALLOWED_TRANSITIONS`), `lockAndValidate` (row lock + ownership + transition check), and `updateStatusIf` compare-and-set are all **well built**. `TEST VERIFIED` — `ride-state-machine.test.ts`, `ride-lifecycle-concurrency.test.ts`, `ride-otp.test.ts`.

**Gaps in `acceptRideRequest`:**

1. **No offer validation** — `RideDispatchRepository.findByRequestAndDriver` has zero callers. Any operable driver who learns a `requestId` can claim the ride.
2. **No one-driver-one-ride guard** — `findActiveByDriver` has zero callers, while the customer-side twin `findActiveByCustomer` **is** called by `createRequest`. The driver-side check was written and never used.
3. **Driver status unchanged** — no `BUSY`/`ON_TRIP` write; the driver stays `ONLINE`, `isAvailable: true`.
4. **`vehicleId` entirely unvalidated** — `z.string().uuid()` then passed straight to `rideRepo.create`. No check that the vehicle exists, belongs to this driver (`VehicleAssignment` never consulted), is active, or that `vehicle.vehicleTypeId` matches `request.vehicleTypeId`. **A driver can accept a premium-tier request in a hatchback and be paid the premium quote.**
5. **`Cancel` has no operability guard** — only `rateLimits.rideWrite`.
6. **No driver aggregates updated on completion** — `Driver.totalRides`, `totalDistanceKm`, `totalEarnings`, `lastRideAt`, `acceptanceRate`, `completionRate`, `cancellationRate` are never written by any code.

---

## 15. Events and Subscribers

### 15.1 Subscriber census — the entire repository

```
$ grep -rn "eventBus.on(" src --exclude-dir=generated
src/modules/auth/consumers/epoch-invalidation.consumer.ts:17
```

**One subscriber**, handling four types. `bootstrapEvents()` registers only `epochInvalidationConsumer`. Every other event published anywhere in the platform has **zero listeners** — durably persisted to `event_outbox` (a real audit trail, replayable later) but triggering nothing.

### 15.2 Driver-relevant events

| Event                              | Producer                                                        | Tx / Outbox                 | Subscriber                  | Production subscriber? | Effect                                         |
| ---------------------------------- | --------------------------------------------------------------- | --------------------------- | --------------------------- | ---------------------- | ---------------------------------------------- |
| `driver.onboarded`                 | `onboardDriver`                                                 | ✅ in tx                    | —                           | ❌                     | none                                           |
| `driver.verified`                  | `reviewDriverVerification`                                      | ✅ in tx                    | —                           | ❌                     | none — **this is the missing role-grant hook** |
| `driver.status_changed`            | `setOnline` / `setOffline`                                      | ✅ in tx                    | —                           | ❌                     | none                                           |
| `driver.suspended`                 | `setSuspended`                                                  | ✅ in tx (deadlocking path) | —                           | ❌                     | none                                           |
| `driver.document_expired`          | **never published** — `DocExpirationJob` emits a metric instead | —                           | —                           | ❌                     | —                                              |
| `driver.shift_started`             | **never published**                                             | —                           | —                           | ❌                     | —                                              |
| `driver.shift_ended`               | **never published**                                             | —                           | —                           | ❌                     | —                                              |
| `driver.location_updated`          | **never published**                                             | —                           | —                           | ❌                     | —                                              |
| `document.verified`                | **no such event in the catalog**                                | —                           | —                           | ❌                     | —                                              |
| `driver.online` / `driver.offline` | **no such events** — folded into `driver.status_changed`        | —                           | —                           | ❌                     | —                                              |
| `ride.requested`                   | `createRequest`                                                 | ✅ in tx                    | —                           | ❌                     | none — **the missing dispatch hook**           |
| `ride.dispatch_offered`            | `offerToDriver` (0 callers)                                     | ✅                          | —                           | ❌                     | none                                           |
| `account.role.granted`             | `grantRole` (0 callers) / new-account login                     | ✅                          | `EpochInvalidationConsumer` | ✅                     | **epoch bump**                                 |

Verified directly: `DRIVER_EVENT_CATALOG.VERIFIED` appears at `catalog.ts:4` (definition) and `onboarding.service.ts:103` (publish). No consumer.

> The outbox mechanism is well built — transactional publish, claim-token relay with retry/backoff (migrations `20260805180000`, `20260806090000`). **Adding a subscriber is one `eventBus.on`. Do not build a second bus.**

---

## 16. Test Reliability and Fixture Shortcuts

**714 unit tests pass, reproducibly, against code that does not compile** (§2.2).

### 16.1 Driver test classification

| File                                               | Class                                   | Note                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/unit/drivers/verification-gate.test.ts`     | **UNIT (mock-only)**                    | Builds `StatusService` with seven `{} as never` deps. Never reaches the licence check, shift repo, or database                                   |
| `tests/unit/drivers/location-plausibility.test.ts` | **UNIT**                                | ✅ Genuine — pure function                                                                                                                       |
| `tests/unit/drivers/mock-location.test.ts`         | **UNIT**                                | ✅ Genuine                                                                                                                                       |
| `tests/integration/auth-driver-gate.test.ts`       | **FIXTURE_SHORTCUT**                    | Inserts `userRoleAssignment` directly, inserts a `VERIFIED` driver directly, and registers its **own ad-hoc route** rather than a production one |
| `tests/integration/authorization-bola.test.ts`     | **HTTP_INTEGRATION + FIXTURE_SHORTCUT** | BOLA assertions are real; driver setup is fixture-made                                                                                           |
| `tests/integration/earnings-pipeline.test.ts`      | **SERVICE_INTEGRATION**                 | Fixture drivers                                                                                                                                  |
| `tests/integration/geo-nearby.test.ts`             | **SERVICE_INTEGRATION**                 | Container-resolved, no HTTP — correct, since no route exists                                                                                     |
| `tests/integration/route-graph.test.ts`            | **HTTP_INTEGRATION**                    | ✅ **The most valuable existing guard** — pins the public route surface to nine sanctioned entries                                               |

### 16.2 The shortcuts, exactly

`tests/integration/helpers/fixtures.ts`:

```ts
export async function grantRole(userId, slug) {          // bypasses AuthService.grantRole
  ... await db().client.userRoleAssignment.create({ data: { userId, roleId: role.id } });
}

export async function makeDriver(userId, { verified = true, suspended = false } = {}) {
  const driver = await db().client.driver.create({ data: {
    userId, driverCode: …, verificationStatus: verified ? 'VERIFIED' : 'PENDING', … }});
  if (verified) {
    await db().client.driverDocument.create({ data: {        // ← the insert that hides P0-2
      driverId: driver.id, documentType: 'DRIVING_LICENSE',
      verificationStatus: 'VERIFIED',                        // ← no production code can write this
      fileUrl: 'https://example.invalid/licence.jpg',        // ← no production code validates this
    }});
  }
}
```

Direct inserts found for: **VERIFIED drivers**, **VERIFIED documents**, **roles**, **active rides** (`makeRide`, raw SQL), **geo positions** (via `locationRepo` directly), **vehicles**, **vehicle types**.

> Each fixture is individually defensible — a guard test should not walk the whole funnel. **Collectively they are why P0-2 and P0-3 went unnoticed:** every test needing a working driver manufactures one in three `INSERT`s, so no test ever asks "could a real client have produced this row?"

### 16.3 Can the current tests prove the real lifecycle?

**No.** Coverage by transition:

| Transition                               | Coverage                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Phone → OTP send                         | **REAL_END_TO_END**                                                        |
| OTP verify → tokens                      | **REAL_END_TO_END**                                                        |
| Token → User + `customer` role           | **REAL_END_TO_END**                                                        |
| Explicit onboarding (`POST /me/onboard`) | **NO COVERAGE**                                                            |
| Profile (name/gender/email)              | **NO COVERAGE**                                                            |
| Document upload via Files                | **NO COVERAGE** (integration does not exist)                               |
| Document submission                      | **NO COVERAGE**                                                            |
| Admin document verification              | **NO COVERAGE** (no production code)                                       |
| Document → VERIFIED                      | **FIXTURE_SHORTCUT ONLY**                                                  |
| Driver approval (`POST /:id/verify`)     | **NO COVERAGE**                                                            |
| Backend role assignment                  | **FIXTURE_SHORTCUT ONLY**                                                  |
| New token/claims after role change       | **PARTIAL** — mechanism proven in `auth-roles.test.ts`, never for a driver |
| Eligibility gate                         | **PARTIAL** — fixture-backed, ad-hoc route                                 |
| ONLINE                                   | **NO COVERAGE** with an expectation of success                             |
| Location                                 | **PARTIAL** — unit only; route never exercised                             |
| Discovery / offer / accept / ON_TRIP     | **NO COVERAGE** of the path                                                |

**Zero tests exercise any route in `driver.routes.ts`** except two auth/BOLA probes.

**Missing integration tests, in priority order:**

1. **The full-lifecycle test with zero direct database writes** — OTP → onboard → profile → document upload via Files → submit → admin verify document → admin approve driver → role appears in refreshed claims → online. _This test is the definition of done and cannot pass today._
2. `POST /me/onboard` — idempotency, concurrency, no-role-gate behaviour
3. `GET /me` — before onboarding, after onboarding, after approval (would have caught P0-1)
4. `PATCH /:driverId/profile` — including the email-collision → 409 case
5. `POST /:driverId/documents` — file ownership rejection, re-upload status reset
6. `POST /:id/verify` — must fail with zero/unverified documents
7. `POST /:id/suspend` — would have caught the deadlock
8. `POST /status/online` — every gate, each rejection code
9. `GET /rides/active` as a real driver — would have caught §14.1

---

## 17. Security Findings

| #   | Finding                                                                          | Class     | Evidence                                                                                                                                    | Impact                                                                                                                           | Action                                                   |
| --- | -------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| S1  | **Arbitrary `fileUrl` accepted for driver documents**                            | `FAIL`    | `driver.schemas.ts` `fileUrl: z.string().url()`                                                                                             | Unvalidated content; reviewer's browser fetches a driver-controlled URL (SSRF-adjacent); no ownership proof; no malware scanning | Move to `fileId` + Files ownership/purpose check         |
| S2  | **Driver approvable with zero documents**                                        | `FAIL`    | `reviewDriverVerification` never reads `driver_documents`                                                                                   | Unvetted person becomes `VERIFIED` in one admin call                                                                             | Require the mandatory set to be `VERIFIED`               |
| S3  | **Unverified drivers enter the live geo index**                                  | `FAIL`    | No guard on `POST /drivers/location`; `findNearbyDrivers` has no state filter                                                               | `PENDING`/suspended drivers become dispatch candidates once dispatch is wired                                                    | Gate the route; filter the query                         |
| S4  | `:driverId` params parsed and ignored                                            | `PARTIAL` | `updateProfile`, `submitDocument` use `actingDriverId`                                                                                      | Not exploitable today; a future reader who honours the param introduces a real IDOR                                              | Drop the param or enforce it                             |
| S5  | **`DEFAULT_USER_ROLE` is an unvalidated env var granting a role at every login** | `PARTIAL` | `auth.constants.ts:3` → `ensureDefaultRole`                                                                                                 | Misconfiguration grants `admin` platform-wide                                                                                    | Validate against an allow-list                           |
| S6  | Staff bypass in `authorizedDriverId` is unaudited                                | `PARTIAL` | `driver-identity.ts`                                                                                                                        | `admin`/`support` read any driver's wallet and location with no audit record — unlike Files, which audits operator reads         | Emit an audit event                                      |
| S7  | Driver routes have no Fastify schemas                                            | `PARTIAL` | `driver.routes.ts` — no `schema:` blocks                                                                                                    | No response serialisation; `GET /me` echoes the raw Prisma row incl. `fileUrl`, `approvedBy`, `rejectionReason`; no OpenAPI      | Add response schemas                                     |
| S8  | `POST /:id/suspend` body unvalidated                                             | `PARTIAL` | `driver-status.controller.ts:44` raw cast                                                                                                   | Silent no-op reported as success                                                                                                 | Add a Zod schema                                         |
| S9  | Three divergent authorization vocabularies                                       | `PARTIAL` | role slugs (enforced), `PERMISSION_SEED` (seeded, unenforced — `findAllowedCodesForUser` has 0 callers), Files' hardcoded `SCOPES_FOR_ROLE` | Drift risk; "can support verify drivers?" has three answers                                                                      | Converge on one                                          |
| S10 | No `AuditLog` model                                                              | `PARTIAL` | `audit.prisma` is one comment line                                                                                                          | Admin approve/suspend leave only a `warn` log + outbox row                                                                       | Decide: outbox is likely sufficient                      |
| S11 | Email collision → `500`                                                          | `PARTIAL` | Raw `client.user.email` write; `handleDriverError` does not map `P2002`                                                                     | Information-poor error; retry storms                                                                                             | Route through `UserRepository.updateEmail`, map to `409` |

**Verified as correct and worth preserving:** deny-by-default `onRequest` authentication; fail-closed on Redis/DB unavailability (observed live as `503`); OTP redaction in production (`otp`/`phoneNumber` in `REDACT_PATHS`, and `level: 'info'` outside development — the `logger.debug({ otp: code })` line at `otp.service.ts:106` is doubly suppressed); challenge binding; no role field in any request schema; JWT-derived identity everywhere.

---

## 18. Concurrency / Transaction Findings

| #   | Finding                                                                       | Class     | Evidence                                                                                                                        |
| --- | ----------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **Nested transaction deadlock in `setSuspended`**                             | `FAIL`    | §11.4. `TransactionManager.execute` always opens a fresh `$transaction`; the nested `setOffline` locks a row the outer tx holds |
| C2  | **Availability split across three stores, reconciled only on the happy path** | `FAIL`    | §11.5. Suspension timeout leaves `isAvailable`, `DriverOnlineStatus.status`, and the Redis index inconsistent                   |
| C3  | **Racy document upsert**                                                      | `PARTIAL` | `findFirst`-then-`create` with **no unique index on `(driver_id, document_type)`** (`SCHEMA VERIFIED`)                          |
| C4  | No one-driver-one-active-ride guard                                           | `PARTIAL` | `findActiveByDriver` 0 callers; customer-side equivalent _is_ called                                                            |
| C5  | Outbox published from a nested transaction                                    | `PARTIAL` | `setOffline` publishes while the outer `setSuspended` tx is open — wrong ordering                                               |
| C6  | Location plausibility is read-then-write, unlocked                            | `PARTIAL` | Acceptable for a position stream; `ON CONFLICT` keeps the row consistent and Redis has a stale-rejection check                  |

**Correct and worth preserving:** `lockForUpdate` (`SELECT … FOR UPDATE`) before every driver read-modify-write in `setOnline`/`setOffline`/`reviewDriverVerification`; `claimForMatch` atomic claim on ride requests; `updateStatusIf` compare-and-set on every ride transition; `startShift` idempotency under the driver row lock; `P2002` re-read in `onboardDriver` and `resolveAccount`; `forgetDriverPosition` correctly placed **after** commit; Redis distributed locks on all ten jobs.

---

## 19. Production Gap Matrix

| #   | Capability                                          | Files      | Logic   | Route/Event | Prod caller | Status                                                    |
| --- | --------------------------------------------------- | ---------- | ------- | ----------- | ----------- | --------------------------------------------------------- |
| 1   | OTP send / verify                                   | ✅         | ✅      | ✅          | ✅          | `PASS`                                                    |
| 2   | User resolution + `customer` role                   | ✅         | ✅      | ✅          | ✅          | `PASS`                                                    |
| 3   | Explicit driver onboarding                          | ✅         | ✅      | ✅*         | ✅          | `PARTIAL` (*uncommitted; build broken)                    |
| 4   | Onboarding resume probe (`GET /me`)                 | ✅         | ✅      | ✅          | ✅          | **`FAIL`** (does not compile)                             |
| 5   | Profile: name / gender                              | ✅         | ✅      | ✅          | ✅          | `PARTIAL` (weak name validation, no completeness)         |
| 6   | Profile: email                                      | ✅         | ✅      | ✅          | ✅          | `PARTIAL` (private write path, 500 on collision)          |
| 7   | Document upload via Files                           | ✅ (Files) | ✅      | ✅          | ❌          | **`UNWIRED`**                                             |
| 8   | Document submission                                 | ✅         | ✅      | ✅          | ✅          | `PARTIAL` (arbitrary URL, racy)                           |
| 9   | **Document review / VERIFIED**                      | ❌         | ❌      | ❌          | ❌          | **`MISSING`** ⛔                                          |
| 10  | Driver approval                                     | ✅         | ✅      | ✅          | ✅          | `PARTIAL` (no document check)                             |
| 11  | **DRIVER role assignment**                          | ✅         | ✅      | ❌          | ❌          | **`UNWIRED`** ⛔                                          |
| 12  | Epoch / stale-token invalidation                    | ✅         | ✅      | ✅          | ✅          | `PASS` (never triggered for drivers)                      |
| 13  | Eligibility gate                                    | ✅         | ✅      | ✅          | ✅          | `PARTIAL` (one document type; no expiry)                  |
| 14  | Go ONLINE                                           | ✅         | ✅      | ✅          | ✅          | **`FAIL`** (unsatisfiable)                                |
| 15  | Go OFFLINE                                          | ✅         | ✅      | ✅          | ✅          | `PARTIAL` (no guard)                                      |
| 16  | Heartbeat + timeout job                             | ✅         | ✅      | ✅          | ✅          | `PASS` (null-heartbeat gap)                               |
| 17  | Suspend                                             | ✅         | ✅      | ✅          | ✅          | **`FAIL`** (deadlock)                                     |
| 18  | Location ingestion                                  | ✅         | ✅      | ✅          | ✅          | `PARTIAL` (no eligibility gate)                           |
| 19  | Location history                                    | ❌         | ❌      | ❌          | ❌          | **`MISSING`** (`driver_location_history` in no migration) |
| 20  | Geo discovery                                       | ✅         | ✅      | ❌          | ❌          | **`UNWIRED`** ⛔                                          |
| 21  | Dispatch orchestration                              | ❌         | ❌      | ❌          | ❌          | **`MISSING`**                                             |
| 22  | Offer create / respond / timeout                    | ✅         | ✅      | partial     | ❌          | **`UNWIRED`**                                             |
| 23  | `BUSY` / `ON_TRIP` writes                           | ❌         | ❌      | ❌          | ❌          | **`MISSING`**                                             |
| 24  | Ride accept integrity (offer, vehicle, active-ride) | ✅         | partial | ✅          | ✅          | `PARTIAL`                                                 |
| 25  | Driver's own active ride / history                  | ✅         | ✅      | ✅          | ✅          | **`FAIL`** (dead role branch — §14.1)                     |
| 26  | Vehicle module                                      | ❌         | ❌      | ❌          | ❌          | **`EMPTY_OR_STUB`**                                       |
| 27  | Admin review queue                                  | ❌         | ❌      | ❌          | ❌          | **`MISSING`**                                             |
| 28  | Role management API                                 | ✅         | ✅      | ❌          | ❌          | **`UNWIRED`**                                             |
| 29  | Push / realtime                                     | ❌         | ❌      | ❌          | ❌          | **`MISSING`**                                             |
| 30  | Driver aggregates & shift stats                     | ❌         | ❌      | ❌          | ❌          | **`MISSING`**                                             |

---

## 20. P0 Blockers

**P0-1 — Repository does not compile, lint, or build; `dist/` is unrunnable.**
`FAIL` · `driver-onboarding.controller.ts:18` (`DriverNotFoundError` unimported) + `onboarding.service.ts:39` (`catch (err: any)` vs `--max-warnings=0`). Both **uncommitted**. `tsc` emits despite the error but `tsc-alias` never runs, so `dist/` retains `require("@core/auth")` → `MODULE_NOT_FOUND` on `npm start`. **Impact:** nothing is deployable. **Action:** add the import; type the catch as `unknown` with a narrowing guard. Two lines.

**P0-2 — No production API can mark a driver document `VERIFIED`.**
`MISSING` · Only writers are `upsertDocument` (`PENDING`) and `DocExpirationJob` (`REJECTED`). **Impact:** the licence gate in `setOnline` is permanently unsatisfiable; `DocExpirationJob` is permanently inert; the whole document pipeline terminates. **This is the FIRST production blocker.** **Action:** service method + admin route over the existing `DriverDocumentRepository.updateVerificationStatus`.

**P0-3 — `AuthService.grantRole` has zero production callers; the `driver` role is never granted.**
`UNWIRED` · Definition + 28 test refs. `driver.verified` has no subscriber. **Impact:** no driver ever holds the role; the epoch/refresh chain never fires; and it **already breaks `GET /rides/active` and `GET /rides/history` for real drivers** (§14.1). **Action:** call `grantRole(userId, 'driver')` on approval — in-transaction or via a `driver.verified` subscriber.

**P0-4 — Driver approvable with zero documents.**
`FAIL` · `reviewDriverVerification` never queries `driver_documents`. **Impact:** an unvetted person reaches `VERIFIED`, satisfying `requireOperableDriver` on five routes. **Action:** declare the mandatory set; require all `VERIFIED` and unexpired before approval.

**P0-5 — Driver documents bypass Files; arbitrary client URLs trusted.**
`FAIL` · `fileUrl: z.string().url()`. **Impact:** no ownership proof, no content validation, no scanning, no retention; reviewer fetches driver-controlled URLs. **Action:** switch to `fileId` with a Files ownership + `DRIVER_DOCUMENT` purpose check, and register the file reference. **Requires a schema change** — flagged, not created.

**P0-6 — `POST /drivers/:id/suspend` self-deadlocks and can corrupt availability.**
`FAIL` · §11.4, §11.5. **Impact:** a safety operation does not work, and a partially-applied suspension leaves the driver dispatchable. **Action:** pass `tx` into `setOffline`, or split the locking so only one transaction is open.

**P0-7 — Dispatch is not a running system.**
`MISSING` · `dispatch/`, `matching/` are `export {};`; `findNearbyDrivers` and `offerToDriver` have zero callers; `ride.requested` has no subscriber; no `RideDispatch` row is ever created; `BUSY`/`ON_TRIP` never written. **Impact:** no ride can be matched; a driver can only accept a `requestId` they already know. **Action:** build the orchestrator over the existing primitives.

---

## 21. P1 Gaps

| #     | Gap                                                                                            | Class     | Action                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| P1-1  | `GET /rides/active` + `/history` serve customer data to drivers                                | `FAIL`    | Fixed for free by P0-3; add a driver-path test                                                 |
| P1-2  | `POST /rides/accept` does not validate `vehicleId` (existence, assignment, active, type match) | `FAIL`    | Validate against `VehicleAssignment` + `vehicleTypeId`                                         |
| P1-3  | No one-driver-one-active-ride guard                                                            | `PARTIAL` | Call the existing `findActiveByDriver`                                                         |
| P1-4  | No dispatch-offer validation on accept                                                         | `PARTIAL` | Call the existing `findByRequestAndDriver`                                                     |
| P1-5  | Unverified/suspended/offline drivers in the geo index                                          | `FAIL`    | Gate the location route; add a state filter to `findNearbyDrivers`                             |
| P1-6  | Licence expiry unchecked at go-online                                                          | `PARTIAL` | Add `expiresAt > now` to `setOnline`                                                           |
| P1-7  | Racy document upsert; no unique index                                                          | `PARTIAL` | Add the constraint + real `upsert`                                                             |
| P1-8  | Stale `verifiedBy`/`verifiedAt` survive re-upload                                              | `PARTIAL` | Clear review metadata on reset                                                                 |
| P1-9  | `REJECTED` driver cannot re-enter review                                                       | `PARTIAL` | Allow `REJECTED → DOCUMENT_REVIEW` on resubmission                                             |
| P1-10 | Email written via a raw path; `500` on collision; `isEmailVerified` unmanaged                  | `PARTIAL` | Use `UserRepository.updateEmail` (already added in the same changeset) and map `P2002` → `409` |
| P1-11 | `POST /:id/suspend` body unvalidated                                                           | `PARTIAL` | Zod schema                                                                                     |
| P1-12 | No admin review queue                                                                          | `MISSING` | List endpoints for drivers/documents pending review                                            |
| P1-13 | No notification channel to the driver                                                          | `MISSING` | Decide push vs. polling before Stage 7                                                         |
| P1-14 | No Fastify schemas on driver routes                                                            | `PARTIAL` | Add response schemas                                                                           |
| P1-15 | No location history (`driver_location_history` in no migration)                                | `MISSING` | Decide whether trip reconstruction is required                                                 |
| P1-16 | Staff bypass unaudited                                                                         | `PARTIAL` | Emit an audit event                                                                            |
| P1-17 | `BUSY`/`ON_TRIP` never written; driver stays available on a trip                               | `MISSING` | Write on accept/complete                                                                       |
| P1-18 | Driver aggregates + shift stats never written                                                  | `MISSING` | Update on completion                                                                           |
| P1-19 | `DEFAULT_USER_ROLE` unvalidated                                                                | `PARTIAL` | Allow-list at config load                                                                      |
| P1-20 | `heartbeatAt = null` drivers never swept                                                       | `PARTIAL` | Include nulls or set on going online                                                           |

---

## 22. P2 Gaps

| #     | Gap                                                                                                                                                                                                                                                                                                                        | Class     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| P2-1  | `:driverId` params decorative                                                                                                                                                                                                                                                                                              | `PARTIAL` |
| P2-2  | No `EXPIRED` status; expiry overloads `REJECTED` with a magic string                                                                                                                                                                                                                                                       | `PARTIAL` |
| P2-3  | `DriverVerificationStatus.SUSPENDED` dead                                                                                                                                                                                                                                                                                  | `PARTIAL` |
| P2-4  | Four of eight driver events never published; `BREAK` never written                                                                                                                                                                                                                                                         | `PARTIAL` |
| P2-5  | `driverMetrics.heartbeatTimeout()` never called                                                                                                                                                                                                                                                                            | `PARTIAL` |
| P2-6  | Dead code: `ShiftService`, `DriverBankRepository`, `driver.responses.ts`, `InvalidDriverStatusTransitionError`, `DocumentValidationError`, five module `plugins/`, `driverExtension.findActiveDrivers`, `PermissionRepository`, `GeoService.{liveDriverPosition,calculateExactDistanceMeters}`, `PostgisProvider.isWithin` | `UNWIRED` |
| P2-7  | `RideStateController` duplicates `actingDriverId` instead of importing it                                                                                                                                                                                                                                                  | `PARTIAL` |
| P2-8  | `POST /me/onboard` returns `201` for an existing driver                                                                                                                                                                                                                                                                    | `PARTIAL` |
| P2-9  | `fullLegalName` length-only; whitespace-only passes; `gender` has no DB enum                                                                                                                                                                                                                                               | `PARTIAL` |
| P2-10 | `rejectionReason` optional when rejecting                                                                                                                                                                                                                                                                                  | `PARTIAL` |
| P2-11 | `super_admin` is not a seeded role (the brief references it)                                                                                                                                                                                                                                                               | `MISSING` |
| P2-12 | `drivers/README.md` claims "0 errors / 550 tests"; actual 1 error / 714 tests                                                                                                                                                                                                                                              | `PARTIAL` |
| P2-13 | `format:check` fails on 29 files incl. `driver.repository.ts`                                                                                                                                                                                                                                                              | `PARTIAL` |
| P2-14 | ~20 `export {};` placeholders across `common/`, `infrastructure/`, `middleware/`, `shared/`                                                                                                                                                                                                                                | `STUB`    |

---

## 23. Reuse / Fix / Wire / Build Decision Matrix

### A. REUSE AS-IS — do not touch

| Asset                                                            | Why                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OTP send/verify (`auth/services/otp/`)                           | Challenge binding, multi-axis rate limits, lockout, hashed storage, BullMQ delivery with backoff, audit rows, verified redaction. Driver App uses the same two endpoints |
| `AuthService.runVerifyOtp` / user resolution                     | Find-or-create, `P2002` handling, profile + device + session + tokens, idempotency                                                                                       |
| `EpochService` + `EpochInvalidationConsumer` + `authPlugin`      | Complete stale-token invalidation; fires automatically once `grantRole` is called                                                                                        |
| `authorize()` guard + `DriverAccessRepository`                   | Deny-by-default, fail-closed, already on five routes                                                                                                                     |
| Files module (upload, validation, purposes, read policy, jobs)   | `DRIVER_DOCUMENT` purpose + `drivers:verify` scope already defined for this use case                                                                                     |
| Geo module                                                       | H3 + Redis live store + PostGIS/GiST with graceful degradation                                                                                                           |
| Outbox / relay / EventBus                                        | Transactional publish, claim tokens, retry/backoff                                                                                                                       |
| Job scheduler + workers + `LockStore`                            | Both driver jobs already ride it correctly                                                                                                                               |
| `TransactionManager` + `lockForUpdate` pattern                   | Correct; respect the no-nesting constraint                                                                                                                               |
| Rides state machine (transitions, locks, CAS, OTP start, ledger) | Well built and tested                                                                                                                                                    |
| `User` as canonical identity; `Driver` as 1:1 optional extension | Correct model                                                                                                                                                            |
| Backend-controlled roles (no role field in any request schema)   | **Preserve this property**                                                                                                                                               |
| `route-graph.test.ts`                                            | Best existing guard on the public surface                                                                                                                                |
| Prisma schema for driver / vehicle / dispatch                    | Anticipated the whole lifecycle                                                                                                                                          |

### B. FIX EXISTING CODE

| Target                                    | Fix                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `driver-onboarding.controller.ts:18`      | Add the missing import (P0-1)                                             |
| `onboarding.service.ts:39`                | `catch (err: unknown)` + narrowing (P0-1)                                 |
| `StatusService.setSuspended`              | Remove the nested transaction (P0-6)                                      |
| `reviewDriverVerification`                | Require mandatory documents `VERIFIED` (P0-4)                             |
| `DriverRepository.updateProfile`          | Use `UserRepository.updateEmail`; map `P2002` → `409` (P1-10)             |
| `DriverDocumentRepository.upsertDocument` | Clear stale review metadata; real `upsert` on a new unique index (P1-7/8) |
| `submitDocument`                          | Allow `REJECTED → DOCUMENT_REVIEW` (P1-9)                                 |
| `StatusService.setOnline`                 | Check licence `expiresAt` (P1-6)                                          |
| `acceptRideRequest`                       | Validate offer, vehicle, active ride; write `ON_TRIP` (P1-2/3/4/17)       |
| `driver-status.controller.suspend`        | Add a Zod schema (P1-11)                                                  |
| `GET /drivers/me`                         | Return 200-with-null instead of 404 (§8)                                  |
| `driver.routes.ts`                        | Add Fastify schemas; gate location/heartbeat/offline (P1-5/14)            |
| `DEFAULT_ROLE_SLUG`                       | Allow-list validation (P1-19)                                             |
| CI config                                 | Add `typecheck` + `lint` to the pipeline (§2.2)                           |

### C. WIRE EXISTING CODE — highest leverage, lowest risk

| Existing asset                                                     | Wire it to                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `AuthService.grantRole`                                            | Driver approval (P0-3)                                    |
| `DriverDocumentRepository.updateVerificationStatus`                | A new document-review service method + admin route (P0-2) |
| Files upload + `registerFileReference`                             | Driver document submission (P0-5)                         |
| `GeoService.findNearbyDrivers`                                     | A `ride.requested` subscriber (P0-7)                      |
| `DispatchService.offerToDriver` + `RideDispatchRepository`         | The dispatch orchestrator (P0-7)                          |
| `RideRepository.findActiveByDriver`                                | `acceptRideRequest` (P1-3)                                |
| `RideDispatchRepository.findByRequestAndDriver` / `updateResponse` | `acceptRideRequest` (P1-4)                                |
| `DriverMetrics.heartbeatTimeout`                                   | `HeartbeatTimeoutJob` (P2-5)                              |

### D. IMPLEMENT MISSING CODE

Document review service + route and admin review queue; the dispatch/matching orchestrator; the `vehicles` module (registration, documents, assignment, approval); `BUSY`/`ON_TRIP` writes; driver aggregates and shift statistics; a notification channel; location history (if required); the full-lifecycle integration test.

### E. REMOVE / DEPRECATE DEAD CODE

`ShiftService` (or wire it), `DriverBankRepository` (or wire it), `driver.responses.ts`, `InvalidDriverStatusTransitionError`, `DocumentValidationError`, the five unused module `plugins/`, `driverExtension.findActiveDrivers`, `PermissionRepository` (or make it the enforcement path), `GeoService.liveDriverPosition`/`calculateExactDistanceMeters`, `PostgisProvider.isWithin`, and the `export {};` scaffolding under `common/`/`infrastructure/`/`middleware/`/`shared/`. **Deletion is optional and lowest priority — but it should be a conscious decision, not drift.**

---

## 24. Recommended Implementation Stages

Sequencing only. No work performed.

**Stage 0 — Make the tree green (minutes).** P0-1: two lines. Land the in-flight onboarding changeset. Add `typecheck` + `lint` to CI. _Nothing else can be verified until this is done._

**Stage 1 — Close the funnel (the critical path).** P0-2 → P0-4 → P0-3. Document review service + admin route; a mandatory-document check in approval; `grantRole` on approval. **This is the smallest change set that makes the lifecycle passable end to end.**

> **One decision belongs to you.** In-transaction grant is atomic but couples `drivers` to `AuthService`; a `driver.verified` subscriber is decoupled but opens an asynchronous window between `VERIFIED` and the role landing. The outbox makes the event path lossless and `grantRole` is already idempotent, so redelivery is harmless — which argues for the event path. It changes what the Driver App must tolerate, so it is your call, not mine.

**Stage 2 — Secure the document pipeline.** P0-5, P1-7, P1-8, P1-9. `fileId` + ownership/purpose check + `registerFileReference`; unique index; clear stale metadata; let rejected drivers re-enter review. _Requires a schema change._

**Stage 3 — Resumable, observable onboarding.** §8 items 2–3, P1-14. `GET /me` 200-with-null; a declared required-document set; Fastify schemas.

**Stage 4 — Operational correctness.** P0-6, P1-11, P1-6, P1-5, P1-16, P1-19, P1-20.

**Stage 5 — Vehicles.** Per §9.1, the gate belongs at accept, not online. Registration, documents, assignment, approval, `currentVehicleId` maintenance.

**Stage 6 — Ride-acceptance integrity.** P1-2, P1-3, P1-4, P1-17, P1-18, P1-1 regression test.

**Stage 7 — Dispatch.** P0-7 + P1-5. Largest and last; depends on drivers existing, being online, and being filterable.

**Stage 8 — Notifications.** P1-13. Genuinely new infrastructure. Decide its shape **before** Stage 7 — dispatch without a delivery channel is of limited use, and that is likely why it was never wired.

---

## 25. Files Likely to Change per Stage

_Predicted surface, for scoping only._

| Stage | Files                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | `drivers/controllers/driver-onboarding.controller.ts`, `drivers/services/onboarding/onboarding.service.ts`, `.github/workflows/*`                                                                                                                                                                                                                                                                      |
| 1     | `drivers/services/onboarding/onboarding.service.ts`, `drivers/controllers/driver-onboarding.controller.ts`, `drivers/routes/driver.routes.ts`, `drivers/schemas/driver.schemas.ts`, `drivers/constants/driver.constants.ts` (mandatory set), `drivers/events/catalog.ts`, **new** `drivers/consumers/driver-verified.consumer.ts` (if event path), `bootstrap/events.bootstrap.ts`, `drivers/index.ts` |
| 2     | `drivers/schemas/driver.schemas.ts`, `drivers/repositories/driver-document.repository.ts`, `drivers/services/onboarding/onboarding.service.ts`, `drivers/index.ts` (`registerFileReference`), `prisma/schema/modules/driver/driver.prisma`, **new migration**                                                                                                                                          |
| 3     | `drivers/controllers/driver-onboarding.controller.ts`, `drivers/schemas/driver.responses.ts`, `drivers/routes/driver.routes.ts`                                                                                                                                                                                                                                                                        |
| 4     | `drivers/services/status/status.service.ts`, `drivers/controllers/driver-status.controller.ts`, `drivers/routes/driver.routes.ts`, `drivers/controllers/driver-identity.ts`, `modules/auth/constants/auth.constants.ts`, `drivers/jobs/heartbeat-timeout.job.ts`                                                                                                                                       |
| 5     | **new** `modules/vehicles/**`, `routes/register.ts`, `core/di.ts`, `prisma/schema/modules/vehicle/vehicle.prisma` (FK for `currentVehicleId`), **new migration**                                                                                                                                                                                                                                       |
| 6     | `rides/services/lifecycle/lifecycle.service.ts`, `rides/schemas/ride.schemas.ts`, `rides/controllers/ride-query.controller.ts`, `drivers/repositories/driver-status.repository.ts`                                                                                                                                                                                                                     |
| 7     | **new** `modules/dispatch/**` or `rides/consumers/`, `modules/geo/providers/postgis.provider.ts`, `rides/jobs/dispatch-timeout.job.ts`, `bootstrap/events.bootstrap.ts`, `jobs/scheduler/index.ts`                                                                                                                                                                                                     |
| 8     | **new** `modules/notifications/providers/push.*`, `notifications/notification.service.ts`, `plugins/socket/socket.plugin.ts`                                                                                                                                                                                                                                                                           |

---

## 26. Tests Required per Stage

| Stage | Tests                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | CI runs `typecheck` + `lint`. `GET /drivers/me` HTTP test for all three states (would have caught P0-1)                                                                                                                                                                                                                                                                               |
| 1     | **The full-lifecycle integration test with zero direct DB writes** (the definition of done). Document verify/reject over HTTP with `verifiedBy`/`verifiedAt` asserted. Approval **refused** with zero/unverified documents. `driver` role present in refreshed claims after approval. Epoch bump → `401 TOKEN_STALE` → refresh → role visible. `grantRole` idempotency on re-approval |
| 2     | Reject a `fileId` owned by another user. Reject a wrong-purpose file. Re-upload resets status **and** clears review metadata. Concurrent same-type submission yields one row. `REJECTED` driver resubmission re-enters review. `DELETE /files/:id` → `409` while referenced                                                                                                           |
| 3     | `GET /me` before/after onboarding and after approval. Required-document set reflected in the response                                                                                                                                                                                                                                                                                 |
| 4     | `POST /:id/suspend` **completes** (would have caught P0-6) and leaves all three availability stores consistent. Malformed suspend body → `400`. Expired licence → online refused. `PENDING` driver location → refused. Staff read emits an audit event                                                                                                                                |
| 5     | Vehicle registration, document approval, assignment. Accept refused without an eligible assigned vehicle                                                                                                                                                                                                                                                                              |
| 6     | Accept without an offer → refused. Second concurrent accept → refused. Mismatched `vehicleTypeId` → refused. `ON_TRIP` written on accept and cleared on complete. `GET /rides/active` as a real driver returns the **driver** ride                                                                                                                                                    |
| 7     | `ride.requested` → offer created. Unverified/suspended/offline drivers excluded from candidates. Timeout advances to the next driver. `NO_DRIVERS_FOUND` terminal                                                                                                                                                                                                                     |
| 8     | Push delivery on document decision, approval, and offer                                                                                                                                                                                                                                                                                                                               |

---

## 27. Final Production Readiness Decision

> ### ❌ **NOT PRODUCTION READY**
>
> **Two independent reasons, of different kinds.**
>
> **1. The tree does not build.** One missing import and one `any` — both in uncommitted driver code — fail `typecheck`, `lint`, and `build`. `dist/` is emitted but unrunnable (unrewritten path aliases). There is no deployable artifact right now. This is minutes of work, and it must happen before anything else can be verified.
>
> **2. Three lifecycle transitions have no implementation.** Document `PENDING → VERIFIED`; driver approved → `driver` role granted; ride requested → drivers discovered. Each severs the chain on its own.
>
> **What genuinely works today over real HTTP:** OTP send and verify; user creation and session issuance; explicit driver onboarding _(uncommitted)_; profile capture including name, gender, and email; document submission. A real working front half.
>
> **What cannot happen at all:** document verification; role assignment; going online; suspension; dispatch; any notification to a driver. And two shipped endpoints (`GET /rides/active`, `/history`) already serve drivers the wrong data because of the missing role.
>
> **The most important finding for planning** is how much is built and merely disconnected. `grantRole` is complete, idempotent, transactional, and epoch-bumping — it needs one caller. `updateVerificationStatus` already writes `verifiedAt`/`verifiedBy` — it needs one service method and one route. `findNearbyDrivers` and `offerToDriver` are complete — they need an orchestrator. Files already defines `DRIVER_DOCUMENT` with a `drivers:verify` operator scope and a `DRIVER_RELATIONSHIP_ENDED` retention rule. The schema anticipated all of it. **The risk in the next phase is rebuilding, not under-building.**
>
> **One process finding worth acting on regardless:** 714 unit tests pass against code that does not compile, because `tsx` strips types and every test needing a working driver manufactures one in three `INSERT`s. Both P0-2 and P0-3 would have been caught by a single integration test walking the lifecycle without a direct database write. Writing that test is part of the fix, not follow-up.

---

## Final Answers

**1. What already works and must not be rebuilt?**
OTP send/verify (shared, hardened, single `LOGIN` purpose); Auth — sessions, tokens, refresh rotation with reuse detection, session caps, deny-by-default, fail-closed; the epoch/stale-token mechanism; `grantRole`/`revokeRole` themselves; `User` as canonical identity with `Driver` as a 1:1 optional extension; the Files module including the already-defined `DRIVER_DOCUMENT` purpose and `drivers:verify` operator scope; the Geo stack; the outbox/relay/EventBus; the job scheduler with Redis `LockStore`; `TransactionManager` + the `lockForUpdate` pattern; the Rides state machine; `OnboardingService.onboardDriver`; `StatusService`/`LocationService`/`DriverShiftRepository` logic; `requireOperableDriver`; the `actingDriverId`/`authorizedDriverId` pattern; **backend-controlled role assignment**; the Prisma schema; `route-graph.test.ts`.

**2. What is implemented but merely unwired?**
`AuthService.grantRole`/`revokeRole`; `DriverDocumentRepository.updateVerificationStatus` for `VERIFIED`; `GeoService.findNearbyDrivers`; `DispatchService.offerToDriver`; `RideDispatchRepository.findByRequestAndDriver`/`updateResponse`; `RideRepository.findActiveByDriver`; Files' `DRIVER_DOCUMENT` purpose and `registerFileReference`; `ShiftService`; `DriverBankRepository`; `PermissionRepository`; `driverExtension.findActiveDrivers`; `GeoService.liveDriverPosition`/`calculateExactDistanceMeters`; `PostgisProvider.isWithin`; five module `plugins/`; `driver.responses.ts`; `InvalidDriverStatusTransitionError`; `DocumentValidationError`; `DriverMetrics.heartbeatTimeout`.

**3. What is actually missing?**
Document review (service, route, queue); the dispatch/matching orchestrator; the `vehicles` module; `BUSY`/`ON_TRIP` writes; driver aggregates and shift statistics; push/realtime notifications; an admin review queue; a role-management API; location history; an `EXPIRED` document status; a unique index on `(driver_id, document_type)`; an `AuditLog` model (possibly unnecessary — the outbox may suffice); the `super_admin` role; and the full-lifecycle integration test.

**4. What is the FIRST production blocker to fix?**
Mechanically first: **P0-1, the build break** — `DriverNotFoundError` unimported at `driver-onboarding.controller.ts:18` plus the lint-failing `catch (err: any)` at `onboarding.service.ts:39`. Two lines; nothing else is verifiable until it is green.
First blocker in the **lifecycle**: **P0-2 — document `PENDING → VERIFIED` has no production writer.**

**5. Can a real driver complete the full lifecycle without direct database manipulation?**
**No.** Two direct writes are unavoidable: setting `DriverDocument.verificationStatus = 'VERIFIED'` and inserting a `user_role_assignments` row for `driver`. These are exactly the two shortcuts `tests/integration/helpers/fixtures.ts` performs — which is why the suite is green and the lifecycle is not.

**6. Exactly where is the DRIVER role assigned in production?**
**Nowhere.** `grep -rn "grantRole" src --exclude-dir=generated` returns one line: `src/modules/auth/services/auth.service.ts:256`, the definition. No route, service, job, or subscriber calls it. The only backend role assignment that happens at all is `ensureDefaultRole` granting `DEFAULT_ROLE_SLUG` (`customer`) during `AuthService.resolveAccount`.

**7. Exactly where does a document become VERIFIED in production?**
**Nowhere.** The only production writers of `DriverDocument.verificationStatus` are `DriverDocumentRepository.upsertDocument` (`PENDING`, both branches) and `DocExpirationJob` at `jobs/doc-expiration.job.ts:23` (`REJECTED`). The single `VERIFIED` write in the repository is `tests/integration/helpers/fixtures.ts:31-38`.

**8. Exactly where is `findNearbyDrivers` called in production?**
**Nowhere outside the geo module's own delegation chain.** `geo.service.ts:19` (facade → `nearby.find`) and `nearby-driver.service.ts:44` (→ `postgisProvider.findNearbyDrivers`). No route, no external service, no job, no subscriber. 23 test references, all resolving the service from the DI container. **Geo write path exists; discovery read path is unwired.**

**9. Can an approved driver safely go ONLINE?**
**No.** They pass `requireOperableDriver` (which checks the Driver row, not the role) and are then rejected by `StatusService.setOnline`'s requirement for a `VERIFIED` `DRIVING_LICENSE` — a status no production code can write. The `403` says "Driver is not operable"; the real cause is `DRIVER_NOT_VERIFIED`. Even if they got online, licence expiry is unchecked at that moment and suspension cannot reliably take them offline (P0-6).

**10. Does the current system support the full lifecycle from OTP to ride assignment?**
**No.** It supports OTP → user → onboarding → profile → document submission. It stops at document review, and stops again at role assignment, and again at dispatch. Ride assignment is reachable only by a driver who already knows a `requestId`, on a request nothing offered them, in a vehicle nobody validated.

**11. What is the minimum Stage 1 change set?**

1. Add the `DriverNotFoundError` import; change `catch (err: any)` to `unknown` with a narrowing guard. _(Build green.)_
2. Add `verifyDocument(documentId, status, reviewerUserId, rejectionReason?)` to `OnboardingService` over the existing `DriverDocumentRepository.updateVerificationStatus`, plus `POST /api/v1/drivers/documents/:documentId/verify` guarded by `roles: ['admin']`.
3. Declare the mandatory document set in one shared constant and require all of them `VERIFIED` and unexpired inside `reviewDriverVerification` before writing `VERIFIED`.
4. Call `AuthService.grantRole(driver.userId, 'driver', { grantedBy })` on approval — in the approval transaction, or from a new `driver.verified` subscriber registered in `bootstrapEvents`.
5. One integration test walking OTP → onboard → profile → document → verify → approve → role-in-claims → online with **no direct database writes**.

Items 2–4 are roughly one service method, one route, one guard, and one call. That is the whole critical path.

**12. Is the repository ready for `/speckit.specify` after this investigation?**
**Yes, with one precondition.** The baseline is established, the gaps are enumerated with evidence, and the reuse boundary is explicit — enough to write a spec against.
**The precondition is Stage 0.** The in-flight uncommitted onboarding changeset should be finished and committed first, because it changes the answers to questions 4, 6, and 12–14 of the entry-flow trace, and a spec written against a non-compiling tree will drift from reality within a day. Land the two-line fix, commit the changeset, then specify.

---

## Investigation Constraints Honoured

- ❌ No code written or modified
- ❌ No migrations created
- ❌ No refactoring performed
- ❌ No Spec Kit plan, tasks, or implementation produced
- ❌ `/speckit.plan`, `/speckit.tasks`, `/speckit.implement` not run
- ✅ Working tree used as the source of truth, including uncommitted changes
- ✅ Code re-read from disk this session; earlier reports not treated as evidence
- ✅ Verification commands re-executed; unit tests run twice for reproducibility
- ✅ Test-only callers never counted as production callers; `src/generated/**` excluded from all caller searches
- ✅ Unverifiable checks reported as `NOT_VERIFIABLE` rather than assumed
- ✅ Only this artifact created: `docs/DRIVER_PLATFORM_FINAL_PRODUCTION_BASELINE.md`

**Stopping here. Awaiting your decision.**
