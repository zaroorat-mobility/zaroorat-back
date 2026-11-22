# Driver Platform — Final Current-State Audit

**Repository:** `backend_zaroorat`
**Branch:** `feature/auth`
**HEAD:** `273aadb refactor: remove unnecessary comments from src to improve readability`
**Date:** 2026-08-18
**Scope:** Investigation only. No source file modified, no migration created, no refactor, no write commands, no plan.

**Evidence labels:** `ZAROORAT CODEBASE` · `TEST EVIDENCE` · `BUILD EVIDENCE` · `MIGRATION/SCHEMA EVIDENCE` · `INFERENCE`
**Classifications:** `IMPLEMENTED + WIRED` · `IMPLEMENTED BUT DISCONNECTED` · `PARTIALLY IMPLEMENTED` · `STUB / EMPTY` · `MISSING` · `BROKEN` · `NOT_VERIFIABLE`

A **production caller** is a call site reachable from a registered route, a registered event subscriber, or a scheduled job. Test files never count. `src/generated/**` is excluded from every caller search so Prisma's generated declarations are never mistaken for callers.

---

## 1. Executive Summary

The Driver Platform is **NO-GO for baseline freeze** — but only just, and for a reason that takes minutes to fix rather than weeks.

Most of the platform is genuinely built, correctly transactional, properly locked, and routed. What is missing is a small number of **middle-of-funnel transitions**, plus one **in-flight uncommitted changeset that has broken the build**.

**Eight findings that define the current state:**

1. **The tree does not compile, lint, or build, and the emitted artifact is unrunnable.** One type error and one lint error, both in **uncommitted** driver code. `tsc` emits despite the error, `tsc-alias` never runs, so `dist/` keeps `require("@core/auth")` → `MODULE_NOT_FOUND`. `BUILD EVIDENCE` §4–5.

2. **An in-flight refactor is rewriting exactly this flow.** At `HEAD`, `GET /drivers/me` **created a Driver row as a side effect** (`createOrGetDriver`). The uncommitted diff replaces it with a pure read, adds `POST /me/onboard`, adds `P2002` handling, and adds email capture — and left out one import. Several answers differ between HEAD and the tree. §3.

3. **No production code can mark a driver document `VERIFIED`.** Only writers are the driver's own submission (`PENDING`) and `DocExpirationJob` (`REJECTED`). **P0 BLOCKER.** §13.

4. **`AuthService.grantRole` has zero production callers** — the `driver` role is never granted by the backend. §15.

5. **That already breaks two shipped endpoints.** `GET /rides/active` and `GET /rides/history` branch on `callerHasRole(req, 'driver')`, so a real approved driver is silently served **customer** data. Live defect. §16.

6. **`requireApprovedDocuments` — the config flag for the exact missing gate — exists, defaults to `true`, and has zero consumers.** The author anticipated the document-approval gate; nothing reads the flag. §14, §26.

7. **A revoked default role silently returns on next login.** `ensureDefaultRole` runs on _every_ login and re-grants when no live assignment exists. §8.

8. **One driver can hold unlimited concurrent active rides** — no service check (`findActiveByDriver` has zero callers) and **no database constraint**. Verified against both code and indexes. §23.

**What is solid and must not be rebuilt:** Auth, OTP, Users, Files, Geo, outbox/relay/EventBus, the job scheduler with Redis locks, the Rides state machine, and the Prisma schema — which anticipated the entire lifecycle. §31.

**Shape of the work:** overwhelmingly _wiring_, not building. §32 lists eleven complete-but-disconnected assets.

---

## 2. Working Tree Baseline

`ZAROORAT CODEBASE` — `git status --short`, re-run twice this session with identical output.

**The tree is DIRTY.** 16 modified files, plus untracked `.claude/`, `.specify/`, and several `docs/*.md`.

| Area                                                     | Modified files                                                                                                                                                                          | In-flight refactor?                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **drivers**                                              | `controllers/driver-onboarding.controller.ts`, `repositories/driver.repository.ts`, `routes/driver.routes.ts`, `schemas/driver.schemas.ts`, `services/onboarding/onboarding.service.ts` | **YES — this is the onboarding rewrite** |
| **auth**                                                 | `repositories/user.repository.ts` (`+ updateEmail`)                                                                                                                                     | Supporting the above                     |
| **users**                                                | `constants/user.constants.ts`, `controllers/profile.controller.ts`, `repositories/user-profile.repository.ts`, `schemas/user.schemas.ts`, `services/user.service.ts`                    | Email on the user profile path           |
| **shared**                                               | `logger/logger.ts` (dev-only redaction relaxation)                                                                                                                                      | Independent                              |
| **tests**                                                | `tests/integration/user-profile.test.ts`                                                                                                                                                | Follows the users change                 |
| **frontend**                                             | `ride-demo-frontend/src/user/*` (3 files)                                                                                                                                               | Out of scope                             |
| **OTP, files, rides, geo, matching, dispatch, vehicles** | **none**                                                                                                                                                                                | No                                       |

> **Does the in-flight refactor make results unstable? YES, for onboarding only.** Steps 6, 12, 13, 14 of the entry-flow trace answer differently at HEAD vs. the tree (§9). Everything outside `drivers/` + `users/` email is stable, because those files are untouched.
>
> No changes were modified or discarded.

---

## 3. HEAD vs Current Tree Differences

`ZAROORAT CODEBASE` — from `git diff`.

| Behaviour                    | At `HEAD` (`273aadb`)                                                            | In the working tree                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /drivers/me`            | **Called `createOrGetDriver`** — a read endpoint that **created a Driver row**   | Pure read + `DriverNotFoundError` — **but the import is missing, so it does not compile** |
| Explicit onboarding route    | **Does not exist**                                                               | `POST /api/v1/drivers/me/onboard` exists                                                  |
| Onboarding service method    | `createOrGetDriver(userId)`                                                      | `onboardDriver(userId)`                                                                   |
| Concurrent onboarding        | **No `P2002` handling** — a lost race threw                                      | `P2002` caught, winner's row re-read                                                      |
| Email on driver profile      | **Not accepted** — no `email` in the schema                                      | Accepted; written to `User.email` via a **raw `client.user.update`**                      |
| `updateProfile` signature    | `(driverId, data)`                                                               | `(userId, driverId, data)`, wrapped in a transaction                                      |
| `UserRepository.updateEmail` | **Does not exist**                                                               | **Added — and the driver path does not use it**                                           |
| Log redaction                | Always on                                                                        | Relaxed in `development` only                                                             |
| Typecheck / lint / build     | _(presumed green — HEAD not checked out, per instruction not to touch the tree)_ | **All three FAIL**                                                                        |

> **The create-on-GET defect the brief asks about was real at `HEAD` and is caught mid-remediation.** `INFERENCE` from the diff: someone is ~90 % of the way through the exact fix this audit was commissioned to scope. The right next step is to **finish and land it**, not to design it.

---

## 4. Build Health

`BUILD EVIDENCE` — all commands executed this session.

| Check             | Command                             | Result                                                                                                                                      |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck (app)   | `npx tsc -p tsconfig.json --noEmit` | **BROKEN** — `src/modules/drivers/controllers/driver-onboarding.controller.ts(18,28): error TS2304: Cannot find name 'DriverNotFoundError'` |
| Typecheck (tools) | `npx tsc -p tsconfig.tools.json`    | **BROKEN** — same single error                                                                                                              |
| Lint              | `npm run lint`                      | **BROKEN** — 1 error, `--max-warnings=0`: `onboarding.service.ts:39:19 Unexpected any @typescript-eslint/no-explicit-any`                   |
| Format            | `npm run format:check`              | **BROKEN** — 29 files, incl. `src/modules/drivers/repositories/driver.repository.ts`                                                        |
| Prisma validate   | `npm run prisma:validate`           | **PASS** — "The schemas at prisma\schema are valid 🚀"                                                                                      |
| Migrations        | inspection only                     | **PARTIAL** — 14 ordered migration dirs; `migrate status` needs a live DB                                                                   |
| Unit tests        | `npm run test:unit`                 | **PASS — 714 / 714, 142 suites.** Run twice (10.7 s, 7.1 s) — reproducible                                                                  |
| Integration tests | `npm run test:integration`          | **NOT_VERIFIABLE** — see §4.2                                                                                                               |
| Production build  | `npm run build`                     | **BROKEN** — §5                                                                                                                             |

### 4.1 Type errors hidden by the transpile-only runner

`npm test` runs `tsx --test`. **`tsx` strips types without checking them.** 714 unit tests therefore pass against code that does not compile. `npm run typecheck` exists and is **not** part of the test command.

> **Finding (`BROKEN`, process):** CI must run `typecheck` and `lint` alongside `test`, or this class of defect ships again. `INFERENCE` from `package.json` scripts + the observed pass/fail split.

### 4.2 Integration tests — `NOT_VERIFIABLE`, with reason

`.env.test` expects `postgresql://…@localhost:5432/zaroorat_test` and `redis://localhost:6379/1`. Neither is running. Docker is unavailable: `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`.

One test was run to capture real evidence rather than assume:

```
POST /api/v1/auth/otp/send → 503
[rate-limit] store unavailable (MaxRetriesPerRequestError, ioredis ECONNREFUSED)
PrismaInternalError: Invalid `prisma.$executeRawUnsafe()` invocation
✖ first verify registers the account, grants customer, opens a session (1601ms)
```

> **`NOT_VERIFIABLE`, not FAIL.** The failures are purely infrastructural. I will not claim a pass I cannot reproduce, nor a failure the code did not cause.
>
> One genuine positive is visible: the rate limiter **failed closed** with `503` rather than allowing the request. Correct, deliberate behaviour. `BUILD EVIDENCE`

---

## 5. Production Artifact Health — `BROKEN`

`BUILD EVIDENCE`. This is worse than a type error, and it was verified **at the artifact level**, not inferred.

`package.json`: `build = clean && tsc && tsc-alias && copy-generated.js`. `tsc` emits JavaScript even when it reports errors (`noEmitOnError` is not set), then the `&&` chain stops. So `rimraf` has run, `tsc` has emitted, and **neither `tsc-alias` nor `copy-generated.js` ran.**

Inspecting the emitted file confirms both failure modes:

```js
// dist/modules/drivers/controllers/driver-onboarding.controller.js
const auth_1 = require("@core/auth");      // ← unresolved path alias: tsc-alias never ran
...
async getMe(req, reply) {
    const driver = await this.driverRepository.findByUserId((0, auth_1.callerId)(req));
    if (!driver)
        throw new DriverNotFoundError((0, auth_1.callerId)(req));   // ← no import, no require
```

| Check requested                           | Result                                                             |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Unresolved path aliases                   | **YES** — `require("@core/auth")` survives in `dist/`              |
| Missing runtime imports                   | **YES** — `DriverNotFoundError` has no `require` in the emitted JS |
| Emitted broken JavaScript                 | **YES** — both of the above                                        |
| Build stops before alias rewriting        | **YES** — `tsc` exits non-zero, `tsc-alias` never runs             |
| TS errors hidden by transpile-only runner | **YES** — §4.1                                                     |

**Two consequences, artifact-verified:**

1. `node dist/server.js` fails immediately with `MODULE_NOT_FOUND: @core/auth`. **There is no runnable artifact.**
2. Even with aliases resolved, `GET /api/v1/drivers/me` throws `ReferenceError: DriverNotFoundError is not defined` — a `500`, not the intended `404` — for every user without a Driver row.

---

## 6. Customer Auth Flow — `IMPLEMENTED + WIRED`

`ZAROORAT CODEBASE` — `auth.service.ts:115-216` (`runVerifyOtp`), one transaction:

```
POST /api/v1/auth/otp/send   → OtpService.send
  Redis challenge claim (cooldown + per-phone window) → secondary per-device/per-IP axes
  → hashed OTP in Redis → audit row in otp_verifications → BullMQ auth-otp
  → OtpDeliveryJob → NotificationService.sendOtp (MSG91)

POST /api/v1/auth/otp/verify → AuthService.verifyOtp  [Idempotency-Key → redis.idempotency.runOnce]
  1. otpService.verify — assertChallengeBelongsToCaller binds challengeId to
     phoneNumber + purpose + verifiedAt === null; throws before any write
  2. resolveAccount — find-or-create User; P2002 phone collision re-read
  3. ensureDefaultRole → grants 'customer'
  4. assertAuthenticatable — rejects deletedAt / DEACTIVATED / non-ACTIVE
  5. userProfileRepository.ensureExists → publishes user.profile.created if new
  6. deviceService.register (UserDevice; where fcmToken lands)
  7. roleRepository.findActiveRoleSlugs   ← THE role read
  8. sessionService.createInTransaction (UserSession)
  9. tokenService.issuePair({ userId, sessionId, roles })
 10. publishes auth.otp.verified, auth.login.succeeded, auth.session.created
     (+ account.role.granted when the account is new)
  → after commit: sessionService.enforceCap (privileged roles get a higher cap)
```

`TEST EVIDENCE` — `auth-login.test.ts`, `user-registration.test.ts`, `otp-hardening.test.ts`, `auth-enumeration.test.ts` cover this **end to end over HTTP**.

**The Driver App uses these same two endpoints.** There is no driver branch anywhere in this flow. `ZAROORAT CODEBASE`

---

## 7. Driver Auth Flow

`ZAROORAT CODEBASE` — current tree.

```
Phone → OTP → User → JWT(roles:['customer'])          ✅ IMPLEMENTED + WIRED  (identical to §6)
  → POST /drivers/me/onboard → Driver(PENDING)         ✅ (uncommitted; §3)
  → PATCH /drivers/:driverId/profile (name/gender/email) ⚠️ PARTIALLY IMPLEMENTED
  → POST /drivers/:driverId/documents (arbitrary URL)  ⚠️ PARTIALLY IMPLEMENTED
  → ─── document review ───                            ❌ MISSING  ⛔ P0
  → POST /drivers/:id/verify (admin)                   ⚠️ PARTIALLY IMPLEMENTED (no doc check)
  → ─── DRIVER role assignment ───                     ❌ DISCONNECTED  ⛔ P0
  → POST /drivers/status/online                        ❌ BROKEN (unsatisfiable licence gate)
  → POST /drivers/location                             ⚠️ works with NO eligibility gate
  → ─── dispatch discovery ───                         ❌ MISSING  ⛔ P0
```

---

## 8. Role Source and JWT Claims

### 8.1 Where roles come from — `IMPLEMENTED + WIRED`

`ZAROORAT CODEBASE`. Roles originate **solely** from the `user_roles` table, read at exactly two points:

- **Issuance** — `runVerifyOtp` → `roleRepository.findActiveRoleSlugs(user.id)` → `tokenService.issuePair`
- **Rotation** — `refresh` → `tokenService.rotate(token, (userId) => resolveActiveRoles(userId))` → re-reads the database

`authPlugin` copies `claims.roles` into `request.auth.roles`. Nothing else supplies a role.

### 8.2 The 15 required answers

| #   | Question                                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                                                        |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Where is the customer role assigned?                         | `AuthService.ensureDefaultRole` (`auth.service.ts:409-414`), called from all three branches of `resolveAccount`                                                                                                                                                                                                                                                                                                                                                | `ZAROORAT CODEBASE`                                                                                             |
| 2   | Only on creation, or every login?                            | **Every login.** `resolveAccount` calls it for the existing-user, created-user, and race-winner paths                                                                                                                                                                                                                                                                                                                                                          | `ZAROORAT CODEBASE`                                                                                             |
| 3   | **Can a revoked role accidentally return?**                  | **YES — for the default role.** `ensureDefaultRole` does `findActiveAssignment` → grants if none. `revoke` sets `revokedAt`, so `findActiveAssignment` returns `null`, and the **next login silently re-grants**. Revoking `customer` is not durable. Explicit `grantRole` re-grant after revoke is _intended_ and DB-safe (a new row, not a revival) — `TEST EVIDENCE` `auth-roles.test.ts:181-193`. The defect is the automatic re-grant, not the manual one | `ZAROORAT CODEBASE`                                                                                             |
| 4   | Where does `DEFAULT_USER_ROLE` come from?                    | `process.env.DEFAULT_USER_ROLE ?? 'customer'` — `auth.constants.ts:3`                                                                                                                                                                                                                                                                                                                                                                                          | `ZAROORAT CODEBASE`                                                                                             |
| 5   | **Is it validated at boot?**                                 | **NO.** `EnvironmentSchema` (`config/env/schema.ts`) validates only `APP_ENV`, `NODE_ENV`, `APP_NAME`, `HOST`, `PORT`, `DATABASE_URL`, `REDIS_URL`, and the two JWT secrets. `DEFAULT_USER_ROLE` is read straight from `process.env`, unvalidated                                                                                                                                                                                                              | `ZAROORAT CODEBASE`                                                                                             |
| 6   | Can misconfiguration grant an unsafe role?                   | **YES.** `DEFAULT_USER_ROLE=admin` grants `admin` to **every account at every login**. Sole mitigation: `ensureDefaultRole` throws if the slug is not seeded — so a _typo_ fails loudly, but a _valid privileged slug_ succeeds silently. Fails at first login, not at boot                                                                                                                                                                                    | `INFERENCE` from 4 + 5                                                                                          |
| 7   | Where is the DRIVER role assigned?                           | **Nowhere**                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `ZAROORAT CODEBASE`                                                                                             |
| 8   | Does `grantRole` exist?                                      | **Yes** — `auth.service.ts:256-294`, complete and correct                                                                                                                                                                                                                                                                                                                                                                                                      | `ZAROORAT CODEBASE`                                                                                             |
| 9   | Does it have a current production caller?                    | **NO.** `grep -rn "grantRole" src --exclude-dir=generated` → **one line, the definition.** 28 further refs, all in `tests/`                                                                                                                                                                                                                                                                                                                                    | `ZAROORAT CODEBASE`                                                                                             |
| 10  | Transactional or event-driven?                               | **Neither — it does not happen.** `grantRole` _itself_ is transactional and bumps the epoch after commit                                                                                                                                                                                                                                                                                                                                                       | `ZAROORAT CODEBASE`                                                                                             |
| 11  | Trace the event producer → subscriber                        | `driver.verified` published by `reviewDriverVerification` (`onboarding.service.ts:103`) → `event_outbox` in-tx → `OutboxRelay` claims and calls `EventBus.emit` → **ZERO subscribers**                                                                                                                                                                                                                                                                         | `ZAROORAT CODEBASE`                                                                                             |
| 12  | Is a subscriber registered at startup?                       | Only one, for auth. `bootstrapEvents()` registers `epochInvalidationConsumer` and nothing else. `grep -rn "eventBus.on(" src --exclude-dir=generated` → **one hit**, `epoch-invalidation.consumer.ts:17`                                                                                                                                                                                                                                                       | `ZAROORAT CODEBASE`                                                                                             |
| 13  | Is the grant idempotent?                                     | **Yes, doubly.** `grantRole` returns `false` if a live assignment exists; and `uq_user_role_active` is a **partial unique index** on `(user_id, role_id) WHERE revoked_at IS NULL` (`migration.sql:3620`)                                                                                                                                                                                                                                                      | `MIGRATION/SCHEMA EVIDENCE` + `TEST EVIDENCE` (`auth-roles.test.ts` — 4 concurrent grants, exactly one applied) |
| 14  | Do role changes invalidate stale claims?                     | **Yes, two independent paths.** Direct: `grantRole`/`revokeRole` → `epochService.bump`. Event: `EpochInvalidationConsumer` on `account.role.granted`/`revoked`/`account.suspended`/`auth.refresh.reuse_detected`. `authPlugin` compares `claims.epoch` → `401 TOKEN_STALE` → refresh re-reads roles. **Complete; simply never triggered for drivers**                                                                                                          | `ZAROORAT CODEBASE`                                                                                             |
| 15  | Can the frontend inject `role`/`roles`/`userType`/`appType`? | **NO — structurally impossible.** §8.3                                                                                                                                                                                                                                                                                                                                                                                                                         | `ZAROORAT CODEBASE`                                                                                             |

### 8.3 Request-boundary verification — `IMPLEMENTED + WIRED`

| Boundary                    | Accepted fields                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `sendOtpSchema`             | `phoneNumber`, `device?`                                                                                 |
| `verifyOtpSchema`           | `phoneNumber`, `code`, `challengeId?`, `device?`                                                         |
| `deviceSchema`              | `deviceId`, `platform`, `appVersion`, `osVersion`, `fingerprint`, `isRooted`, `isJailbroken`, `fcmToken` |
| `refreshSchema`             | `refreshToken`                                                                                           |
| `updateDriverProfileSchema` | 12 profile fields — **no role-shaped field**                                                             |

**No `role`, `roles`, `userType`, `appType`, or `isDriver` field exists anywhere in the request surface.** Zod strips unknown keys. Controllers build explicit allow-lists field by field (`updateProfile` copies 12 named fields). The database is the only role source.

> **The brief's core security requirement is already satisfied by construction. Preserve it; do not build it.**

---

## 9. Driver Entry and Onboarding

`ZAROORAT CODEBASE` — current tree; HEAD differences flagged.

| #   | Question                                                   | Answer                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is Driver creation explicit?                               | **Tree: YES** — `POST /drivers/me/onboard` → `onboardDriver`. **HEAD: NO**                                                                                                                                                                                 |
| 2   | Does `GET /me` have a creation side effect?                | **Tree: NO** (pure read, but does not compile). **HEAD: YES — `createOrGetDriver`**                                                                                                                                                                        |
| 3   | Can a Customer accidentally create a Driver row?           | **Tree: NO** accidentally. **HEAD: YES** via `GET /me`. Note the tree has **no role gate** on `/me/onboard`, so any authenticated user may _deliberately_ apply — self-service signup, not a defect, but Driver-row existence signals nothing about intent |
| 4   | Exactly one Driver per User?                               | **YES** — `Driver.userId @unique` (`MIGRATION/SCHEMA EVIDENCE`)                                                                                                                                                                                            |
| 5   | Concurrent onboarding safe?                                | **Tree: YES** — read-then-create + `P2002` re-read. **HEAD: NO**                                                                                                                                                                                           |
| 6   | `P2002` handled?                                           | **Tree: yes** (`onboarding.service.ts:39-45`) — though `catch (err: any)` is the lint failure. **HEAD: no**                                                                                                                                                |
| 7   | Can the request choose arbitrary `userId`/`driverId`?      | **NO.** `onboard` takes no body and no param. `updateProfile`/`submitDocument` parse `:driverId` and **ignore it**, using `actingDriverId(req)`                                                                                                            |
| 8   | Identity from JWT?                                         | **YES** — `callerId(req)` → `request.auth.userId` ← JWT `sub`                                                                                                                                                                                              |
| 9   | Name, Gender, Email all persisted?                         | **YES** in the tree. Name/gender → `DriverProfile`; email → `User.email`. Weak name validation (length only; `" a"` passes)                                                                                                                                |
| 10  | Split User/DriverProfile writes consistent?                | **Transactionally yes** — `updateProfile` wraps both. **Architecturally no** — it uses a raw `client.user.update` instead of `UserRepository.updateEmail` added in the same changeset                                                                      |
| 11  | Can onboarding resume safely?                              | **Data: yes.** `findByUserId` includes `profile` + `documents` + `onlineStatus` in one read. **Endpoint: no** — `GET /me` does not compile and 404s instead of returning an empty state                                                                    |
| 12  | Explicit profile-completion rule/state?                    | **NO.** Every profile field is `.optional()`; no completeness check anywhere                                                                                                                                                                               |
| 13  | Can incomplete profiles submit documents?                  | **YES** — `submitDocument` never reads the profile                                                                                                                                                                                                         |
| 14  | Is the onboarding state machine real or frontend-inferred? | **Real but derived, not explicit** — §10                                                                                                                                                                                                                   |
| 15  | Events emitted?                                            | `driver.onboarded` only (in-tx, outbox). Profile update emits **nothing** — unlike the users module, which publishes `user.profile.updated`                                                                                                                |

---

## 10. Profile and Resume

**The brief asks not to recommend a state column without first proving one is absent. It is absent — and it is also not needed.**

`Driver.verificationStatus` is the explicit backend state (`PENDING | DOCUMENT_REVIEW | VERIFIED | REJECTED | SUSPENDED`, `MIGRATION/SCHEMA EVIDENCE`). Only three of five are ever written; `SUSPENDED` is dead (suspension uses the `isSuspended` boolean).

One `GET /drivers/me` already returns everything the app needs:

| Question                                   | Derivable from                                                        |
| ------------------------------------------ | --------------------------------------------------------------------- |
| Applied?                                   | 404 vs 200                                                            |
| Profile filled?                            | `profile === null` / `profile.fullLegalName === null`                 |
| Documents submitted / approved / rejected? | `documents[].documentType`, `.verificationStatus`, `.rejectionReason` |
| Under review?                              | `verificationStatus === 'DOCUMENT_REVIEW'`                            |
| Approved?                                  | `verificationStatus === 'VERIFIED'`, `approvedAt`                     |
| Online?                                    | `onlineStatus.status`                                                 |

> **Classification: `PARTIALLY IMPLEMENTED` — a design gap, not a blocker.** The two safety-critical gates (unapproved → online, suspended → online) are each enforced twice (§17). What is missing is smaller than a state column: the compile fix; `GET /me` returning **200-with-null** instead of `404`; a **declared required-document set**; and a completeness check before approval. A new `onboardingStep` enum would duplicate data the schema already carries and would need to be kept consistent with it — a fresh bug class. `INFERENCE` from `ZAROORAT CODEBASE`.

---

## 11. Files Integration — `IMPLEMENTED BUT DISCONNECTED`

The Files module is production-grade and **the driver module never connects to it**. `ZAROORAT CODEBASE`

| Capability                                                                                                                                                      | Location                                                | State                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DRIVER_DOCUMENT` purpose — jpeg/png/webp/pdf, 10 MB, 5000×5000 px, `rejectExifLocation: true`, 300 s read TTL, 2920-day ARCHIVE on `DRIVER_RELATIONSHIP_ENDED` | `config/file/file.config.ts:39-46`                      | **Defined, ZERO consumers**                                                           |
| Presigned PUT → `POST /files/:id/complete` — magic bytes vs declared type, size, dimensions, checksum, EXIF-location; refused objects deleted from storage      | `files/routes/file.routes.ts`, `file-upload.service.ts` | Live                                                                                  |
| Scan state machine — unusable until `READY`                                                                                                                     | migration `20260812150000_file_scan_state_machine`      | Live. **Driver documents get none of it**                                             |
| `decideRead` — `DRIVER_DOCUMENT` requires `drivers:verify`, held by `admin`, deliberately **not** `support`; operator reads audited                             | `files/services/file-access.service.ts:28-39`           | Live, **already anticipates driver review**                                           |
| `registerFileReference(purpose, check)` → `DELETE /files/:id` returns `409 FILE_IN_USE`                                                                         | `files/services/file-reference.service.ts`              | Live. Only `users` registers (`PROFILE_IMAGE`). **No `DRIVER_DOCUMENT` registration** |
| Retention / sweeper / reconciliation jobs                                                                                                                       | `files/jobs/*`                                          | Live and scheduled                                                                    |

> The purpose name, the `DRIVER_RELATIONSHIP_ENDED` retention trigger, and the `drivers:verify` operator scope all show Files was designed for driver documents. **Connect it; do not build a driver file store.** `INFERENCE`

---

## 12. Driver Documents — `PARTIALLY IMPLEMENTED`

### 12.1 The 12 required answers

| #   | Question                                        | Answer                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `fileId` or raw `fileUrl`?                      | **Raw `fileUrl`.** `submitDriverDocumentSchema`: `fileUrl: z.string().url()`. `DriverDocument.fileUrl String` — no `fileId`, no FK to `files` (`MIGRATION/SCHEMA EVIDENCE`)                                                                                                                                                                                 |
| 2   | Can the client submit an arbitrary URL?         | **YES — any URL that parses.** No host allow-list                                                                                                                                                                                                                                                                                                           |
| 3   | Does the backend validate file ownership?       | **NO.** There is no file record to own                                                                                                                                                                                                                                                                                                                      |
| 4   | Does it validate the `DRIVER_DOCUMENT` purpose? | **NO**                                                                                                                                                                                                                                                                                                                                                      |
| 5   | Can another user's file be attached?            | **The question does not apply** — the driver never references a file record at all, so there is nothing to own and no check to pass. `INFERENCE`                                                                                                                                                                                                            |
| 6   | Resubmission behaviour?                         | `upsertDocument` → `findFirst` by `(driverId, documentType)` → update or create                                                                                                                                                                                                                                                                             |
| 7   | Does resubmission reset verification safely?    | **Status: yes** (→ `PENDING`, correct). **Metadata: no** — `verifiedBy`, `verifiedAt`, `verificationNotes`, `rejectionReason` **survive untouched**. A re-uploaded document reads `PENDING` while still carrying the previous reviewer's identity                                                                                                           |
| 8   | Which Indian KYC types exist?                   | `DRIVING_LICENSE`, `RC`, `INSURANCE`, `AADHAAR`, `PAN`, `PUC`, `POLICE_VERIFICATION`, `PROFILE_PHOTO` (`MIGRATION/SCHEMA EVIDENCE`). **No mandatory subset is declared anywhere in `src/`**                                                                                                                                                                 |
| 9   | Are expiration dates stored?                    | **YES** — `expiresAt DateTime? @db.Date`, indexed                                                                                                                                                                                                                                                                                                           |
| 10  | Is expiration checked before eligibility?       | **NO at go-online** — `setOnline` ignores `expiresAt`. Only the nightly job looks at it, so a licence expiring at 03:00 stays usable ~23 h                                                                                                                                                                                                                  |
| 11  | Is there an expiration job?                     | **YES** — `DocExpirationJob`                                                                                                                                                                                                                                                                                                                                |
| 12  | Is it registered and reachable?                 | **YES, fully** — scheduled `0 2 * * *` on `drivers-maintenance`; `MAINTENANCE_HANDLERS[DRIVER_DOC_EXPIRATION] = 'docExpirationJob'`; DI-registered; worker started by `startMaintenanceWorkers()`; Redis-locked with release in `finally`. **And it can never fire** — its query requires `verificationStatus: 'VERIFIED'`, which no production code writes |

### 12.2 Every writer of `DriverDocument.verificationStatus`

Exhaustive search of `src/` excluding `generated/`. `ZAROORAT CODEBASE`

| Value                                              | Production writer                                                                                  | Caller                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `PENDING`                                          | `DriverDocumentRepository.upsertDocument` (both branches)                                          | `OnboardingService.submitDocument` ← `POST /drivers/:driverId/documents` |
| `REJECTED`                                         | `DriverDocumentRepository.updateVerificationStatus(id, 'REJECTED', undefined, 'Document expired')` | `DocExpirationJob:23` — **the only caller of that method**               |
| **`VERIFIED`**                                     | **NONE**                                                                                           | —                                                                        |
| `verifiedBy`                                       | **NONE** — the sole caller passes `undefined`                                                      | —                                                                        |
| `verifiedAt`                                       | **NONE** — only set on the unreachable `VERIFIED` branch                                           | —                                                                        |
| `verificationNotes`, `ocrData`, `documentChecksum` | **NONE** — never written by any code                                                               | —                                                                        |

**No `EXPIRED` status exists**: `VerificationStatus` is `PENDING | VERIFIED | REJECTED` (`MIGRATION/SCHEMA EVIDENCE`), so the job overloads `REJECTED` and "expired" is indistinguishable from "rejected for fraud".

### 12.3 Concurrency

`findFirst`-then-`create` with **no unique constraint on `(driver_id, document_type)`** — re-verified: `driver_documents` has plain indexes on `driver_id`, `document_type`, `expires_at` only (`migration.sql:2631-2637`). Two concurrent submissions of one type both miss and both insert; `docs.some(...)` then passes if _either_ copy is approved. `MIGRATION/SCHEMA EVIDENCE`

---

## 13. Document Review — `MISSING` ⛔ **P0 BLOCKER**

Every possible writer, searched exhaustively:

| Transition            | Production writer                            |
| --------------------- | -------------------------------------------- |
| `PENDING → VERIFIED`  | **NONE**                                     |
| `PENDING → REJECTED`  | Only `DocExpirationJob` (expiry, not review) |
| `VERIFIED → REJECTED` | Only `DocExpirationJob`                      |
| `→ EXPIRED`           | **Status does not exist**                    |

| #   | Question                                                           | Answer                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is there an HTTP route?                                            | **NO.** The only admin driver routes are `POST /:id/verify` and `POST /:id/suspend`; neither touches `driver_documents`                                                                                                                                                                     |
| 2–3 | Who can call it? Admin only, or + Support?                         | **N/A — no route.** For the _driver-level_ route it is `admin` only. The seeded permission `drivers:verify` is held by `admin`, deliberately not `support` (`prisma/seed/shared/roles.ts`) — but `authorize()` checks **role slugs, not permission codes**, so the two agree by coincidence |
| 4–6 | Reviewer identity, `verifiedBy`/`verifiedAt`, `rejectionReason`    | **Columns exist; never populated** (§12.2)                                                                                                                                                                                                                                                  |
| 7   | Verified twice safely?                                             | **N/A.** The repository method is idempotent in effect                                                                                                                                                                                                                                      |
| 8   | Can a verified document be re-uploaded?                            | **YES** — resets to `PENDING` (correct) but keeps stale review metadata                                                                                                                                                                                                                     |
| 9   | What happens after resubmission?                                   | Driver status is promoted **only from exactly `PENDING`**, so a `REJECTED` driver's resubmission **never re-enters the queue**                                                                                                                                                              |
| 10  | Can a reviewer approve a nonexistent or another driver's document? | **N/A — no route.** Note the repository method takes a bare `documentId` with **no driver scoping**, so any future route must add the ownership check itself. `INFERENCE`                                                                                                                   |
| 11  | BOLA checks correct?                                               | **N/A**; flagged as a design constraint for the eventual route                                                                                                                                                                                                                              |
| 12  | Review events emitted?                                             | **NO** — no `document.verified` event exists in any catalog                                                                                                                                                                                                                                 |

> **Everything needed is already in place except the service method and the route:** `DriverDocumentRepository.updateVerificationStatus(id, status, verifiedBy?, rejectionReason?, tx?)` already writes `verifiedAt` and accepts `verifiedBy`; the schema columns exist; the `drivers:verify` permission is seeded; the Files operator read-scope exists.
>
> **P0 BLOCKER — this is the first blocking transition in the lifecycle.**

---

## 14. Driver Approval — `PARTIALLY IMPLEMENTED`

`ZAROORAT CODEBASE` — `POST /api/v1/drivers/:id/verify`, `preHandler: authorize({ roles: ['admin'] })` → `OnboardingService.reviewDriverVerification`.

**Done well:** `lockForUpdate` (`SELECT … FOR UPDATE`) before the read-modify-write; `approvedAt`/`approvedBy` set on the `VERIFIED` branch; `driver.verified` published inside the transaction via the outbox; a `warn` log carrying `{ driverId, status, reviewerUserId }`.

| #   | Question                                          | Answer                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Approvable with zero documents?                   | **YES.** The documents table is never queried                                                                                                                                                                                             |
| 2   | Approvable with required documents `PENDING`?     | **YES**                                                                                                                                                                                                                                   |
| 3   | Approvable with `REJECTED` required documents?    | **YES**                                                                                                                                                                                                                                   |
| 4   | One centralized eligibility function?             | **NO — two, and they disagree.** `DriverAccessRepository.isOperableDriver` checks `verificationStatus + isSuspended + deletedAt`. `StatusService.setOnline` additionally requires a `VERIFIED` `DRIVING_LICENSE`. Approval checks neither |
| 5   | Do document-approval and `setOnline` rules agree? | **NO.** Approval requires no documents; `setOnline` requires a verified licence. A driver can be `VERIFIED` and still unable to go online — which is exactly today's state                                                                |
| 6   | Is driver status distinct from document status?   | **YES** — `DriverVerificationStatus` (5 values) vs `VerificationStatus` (3). Correct separation                                                                                                                                           |
| 7   | Atomic, or can a race occur?                      | The **write** is atomic under the row lock. There is **nothing to race on**, because no eligibility conditions are read                                                                                                                   |
| 8   | Production reachable?                             | **YES**                                                                                                                                                                                                                                   |
| 9   | RBAC protected?                                   | **YES** — `roles: ['admin']`                                                                                                                                                                                                              |
| 10  | Audit fields/events written?                      | **Partially.** `approvedAt`/`approvedBy` + `driver.verified` (`classification: 'audit'`) + a `warn` log. **No `AuditLog` model exists** — `prisma/schema/shared/audit.prisma` is a single comment line (`MIGRATION/SCHEMA EVIDENCE`)      |

> ### The config flag for the missing gate already exists and is dead
>
> `config/driver/driver.config.ts:13` — `requireApprovedDocuments: process.env.DRIVER_REQUIRE_APPROVED_DOCS !== 'false'`, **defaulting to `true`**.
>
> `grep` across `src/` excluding `generated/`: **the only occurrences are its own interface declaration and initialiser. ZERO consumers.** `ZAROORAT CODEBASE`
>
> The author anticipated precisely the document-approval gate that is missing, shipped the flag turned on, and never wired it. Same file, same pattern: **`maxContinuousShiftHours: 12` also has zero consumers** — no shift-duration enforcement exists anywhere.

**Idempotency:** re-approving rewrites `approvedAt` and re-publishes the event. No legal-predecessor check — `REJECTED → VERIFIED` is permitted directly. `InvalidDriverStatusTransitionError` exists in `driver.errors.ts` with **zero throw sites**.

---

## 15. Driver Role Assignment — `IMPLEMENTED BUT DISCONNECTED` ⛔ **P0**

| #   | Question                                                             | Answer                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does this happen today?                                              | **NO**                                                                                                                                                                                                                                               |
| 2   | Exactly where?                                                       | **Nowhere.** `grep -rn "grantRole" src --exclude-dir=generated` → `auth.service.ts:256`, the definition only                                                                                                                                         |
| 3   | Smallest existing extension point?                                   | Two, both already built — §15.2                                                                                                                                                                                                                      |
| 4   | Does the codebase already use events/outbox for domain side effects? | **YES** — `EventPublisher.publish(input, tx?)` writes to `event_outbox` inside the caller's transaction; `OutboxRelay` claims batches with a claim token and retry/backoff (migrations `20260805180000`, `20260806090000`) and calls `EventBus.emit` |
| 5   | Is there a registered subscriber mechanism?                          | **YES, and exactly one subscriber uses it** — `bootstrapEvents()` → `epochInvalidationConsumer.register()` → `eventBus.on(type, …)` for four auth events                                                                                             |
| 6   | Which fits the existing architecture better?                         | Evidence-based comparison in §15.2                                                                                                                                                                                                                   |

### 15.1 The broken chain

```
POST /drivers/:id/verify { status: 'VERIFIED' }
  └─ reviewDriverVerification
       ├─ updateVerificationStatus → VERIFIED      ✅ happens
       ├─ driverMetrics.driverVerified             ✅ happens
       └─ publish driver.verified → event_outbox   ✅ happens
                    ↓  OutboxRelay → EventBus.emit('driver.verified')
            ┌──────────────────────────┐
            │   ZERO SUBSCRIBERS       │
            └──────────────────────────┘
        AuthService.grantRole(userId,'driver')   ← NEVER CALLED
        EpochService.bump(userId)                ← never fires for this
```

### 15.2 The two options, on evidence — **DO NOT IMPLEMENT**

|                         | **Option A — in the approval transaction**                                                                                                                      | **Option B — `driver.verified` subscriber**                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension point         | `reviewDriverVerification`, inside the existing `txManager.execute`                                                                                             | New `drivers/consumers/*.ts` + one line in `bootstrapEvents()`                                                                                          |
| Atomicity               | **Strong** — role and status commit together or not at all                                                                                                      | Eventual: a window exists between `VERIFIED` and the role landing                                                                                       |
| Fits existing patterns? | `grantRole` currently bumps the epoch **after** commit, so calling it inside another transaction needs care — the epoch bump would fire before the outer commit | **Matches the only precedent in the codebase** (`EpochInvalidationConsumer`) and the module boundary the outbox was built for                           |
| Coupling                | `drivers` → `AuthService` directly                                                                                                                              | Decoupled; `drivers` publishes, `auth` reacts                                                                                                           |
| Failure mode            | Approval rolls back if the grant fails — visible, safe                                                                                                          | Outbox retry/backoff makes it **at-least-once**; `grantRole` is **idempotent** (returns `false`, plus `uq_user_role_active`), so redelivery is harmless |
| Risk                    | Nested-transaction hazard — the same class of bug as P0-6 (§18)                                                                                                 | The driver app must tolerate a brief `VERIFIED`-without-role window                                                                                     |

> **Evidence tilts to Option B:** it is the only pattern the repository already uses for cross-module side effects, the outbox guarantees no lost grants, `grantRole` is already idempotent, and it avoids the nested-transaction hazard that has already produced one live deadlock in this very module. **But it changes what the Driver App must tolerate, so the decision is the owner's, not this audit's.**

---

## 16. Authorization Consistency

### 16.1 Four mechanisms that can disagree

`ZAROORAT CODEBASE`

| Mechanism                             | Checks                                                    | Used at                                                       |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `requireOperableDriver`               | `drivers` row: `VERIFIED` + `!isSuspended` + `!deletedAt` | 5 routes                                                      |
| `callerHasRole(req,'driver')`         | JWT claim                                                 | `RideStateController.cancel`, `RideQueryController.getActive` |
| `Driver.verificationStatus` + licence | Re-read inside `setOnline`                                | `setOnline`                                                   |
| `actingDriverId`                      | A Driver row exists for this user                         | every driver-scoped controller                                |

### 16.2 Per-endpoint trace

| Endpoint                                       | Guard                               | `driver` role required? | Notes                                      |
| ---------------------------------------------- | ----------------------------------- | ----------------------- | ------------------------------------------ |
| `GET /rides/active`                            | authenticated only                  | branches on it          | **BROKEN — §16.3**                         |
| `GET /rides/history`                           | authenticated only                  | **ignored**             | **BROKEN — always customer rides**         |
| `POST /rides/accept`                           | `requireOperableDriver`             | no                      | No offer/vehicle/active-ride checks (§23)  |
| `POST /rides/:id/arrive`                       | `requireOperableDriver`             | no                      | Row lock + ownership + transition table ✅ |
| `POST /rides/:id/start`                        | `requireOperableDriver`             | no                      | + OTP verify ✅                            |
| `POST /rides/:id/complete`                     | `requireOperableDriver`             | no                      | + ledger ✅                                |
| `POST /rides/:id/cancel`                       | rate limit only                     | branches on it          | **No operability guard**                   |
| `POST /drivers/status/online`                  | `requireOperableDriver`             | no                      | Unsatisfiable (§17)                        |
| `POST /drivers/status/offline`                 | **none**                            | no                      | Any user with a Driver row                 |
| `POST /drivers/heartbeat`                      | **none**                            | no                      | Early-returns when `OFFLINE`               |
| `POST /drivers/location`                       | rate limit only                     | no                      | **No eligibility gate** (§19)              |
| `GET /drivers/:id/location`                    | `authorizedDriverId` + staff bypass | no                      | Correct BOLA ✅                            |
| `GET /drivers/:driverId/wallet[/transactions]` | same                                | no                      | Correct BOLA ✅                            |

### 16.3 `BROKEN` — the missing role already breaks two shipped endpoints

`ride-query.controller.ts:11-19`:

```ts
if (callerHasRole(req, 'driver')) {
  const driverRide = await this.rideRepo.findActiveByDriverUserId(userId);
  return reply.send({ data: driverRide });
}
const activeRide = await this.rideRepo.findActiveByCustomer(userId);
```

Because **no user ever holds the `driver` role** (§8.2 Q9), the `if` is dead. A real approved driver mid-trip calls `GET /rides/active` and receives `findActiveByCustomer` — **their passenger ride, or `null`**. Their actual trip is invisible to their own app.

`listHistory` is worse: it calls `listCustomerRides(callerId(req))` **unconditionally** (`ride-query.controller.ts:60`), so a driver's history is always their passenger history.

> `findActiveByDriverUserId` **has** a production caller but sits behind an unreachable branch. This is a **current** defect, not a future consequence, and it is fixed for free by wiring the role grant. `ZAROORAT CODEBASE`

### 16.4 The three required answers

| Question                                                                           | Answer                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a real approved Driver fail ride authorization because the JWT lacks `driver`? | **Not on the write routes** — they use `requireOperableDriver`, which reads the `drivers` table, so an approved driver passes. **Yes on the read routes** — `GET /rides/active` and `/history` silently serve customer data (§16.3)      |
| Can a person operate as a Driver because a Driver row exists **without** the role? | **YES — by design today.** All five write guards key off the `drivers` table, not the role. The `driver` role currently confers **no authorization anywhere**; it is read in exactly two places and both are branch selectors, not gates |
| Can role claims become stale?                                                      | **Mechanically no** — epoch bump → `401 TOKEN_STALE` → refresh re-reads the database. The mechanism is complete and simply never fires for drivers                                                                                       |

---

## 17. Online / Offline / Shifts

`MIGRATION/SCHEMA EVIDENCE` — `DriverStatus`: `ONLINE | OFFLINE | BUSY | ON_TRIP | BREAK`.

| Transition               | Endpoint / trigger                     | Guard                   | Writes                                                             | Tx / lock            | Event                   | Reachable?                                        |
| ------------------------ | -------------------------------------- | ----------------------- | ------------------------------------------------------------------ | -------------------- | ----------------------- | ------------------------------------------------- |
| → `ONLINE`               | `POST /drivers/status/online`          | `requireOperableDriver` | `driver_online_status`, `drivers.isAvailable`, `driver_shift_logs` | ✅ tx + `FOR UPDATE` | `driver.status_changed` | **`BROKEN` — unsatisfiable**                      |
| → `OFFLINE` (driver)     | `POST /drivers/status/offline`         | **none**                | same + `shiftEnd`                                                  | ✅ tx + lock         | `driver.status_changed` | ✅                                                |
| → `OFFLINE` (stale)      | `HeartbeatTimeoutJob` cron `* * * * *` | job                     | same                                                               | ✅                   | ✅                      | ✅                                                |
| → `OFFLINE` (suspension) | `POST /drivers/:id/suspend`            | `roles:['admin']`       | `isSuspended` + status                                             | ❌ **nested tx**     | `driver.suspended`      | **`BROKEN` — §18**                                |
| → `BUSY`                 | —                                      | —                       | —                                                                  | —                    | —                       | ❌ **no writer anywhere**                         |
| → `ON_TRIP`              | —                                      | —                       | —                                                                  | —                    | —                       | ❌ **no writer anywhere**                         |
| → `BREAK`                | —                                      | —                       | —                                                                  | —                    | —                       | ❌ **no writer**; only read by `findStaleDrivers` |

### 17.1 The 12 required answers

| #   | Question                                         | Answer                                                                                                                                                                            |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Exact requirements for `ONLINE`                  | Inside one tx after `lockForUpdate`: driver exists → `verificationStatus === 'VERIFIED'` → `!isSuspended` → a `DRIVING_LICENSE` document with `verificationStatus === 'VERIFIED'` |
| 2   | Required document checks                         | **Only `DRIVING_LICENSE`.** RC, INSURANCE, PUC, AADHAAR, PAN, POLICE_VERIFICATION never required. **Expiry ignored**                                                              |
| 3   | Driver verification checks                       | Enforced twice — route guard + service                                                                                                                                            |
| 4   | Vehicle requirements                             | **None** — and per §22 that matches the schema                                                                                                                                    |
| 5   | Shift creation idempotent?                       | **YES** — `startShift` returns the open shift rather than creating a second, executed under the driver row lock                                                                   |
| 6   | Shift closure                                    | `endShift` sets `shiftEnd` + computes `totalOnlineMinutes`. **Every other stat column stays at its default**                                                                      |
| 7   | `BUSY`/`ON_TRIP`/`BREAK` reachable?              | **NO — none of the three is ever written**                                                                                                                                        |
| 8   | Can `OFFLINE` happen during `ON_TRIP`?           | **NO** — `setOffline` throws `DriverOnTripError` if status is `ON_TRIP`. A guard against a state nothing can produce                                                              |
| 9   | Suspension behaviour                             | **`BROKEN`** — §18                                                                                                                                                                |
| 10  | Nested transaction / `FOR UPDATE` self-deadlock? | **YES, one confirmed** — §18                                                                                                                                                      |
| 11  | Heartbeat races                                  | `recordHeartbeat` is an unlocked upsert; last-write-wins is acceptable for a heartbeat. `PARTIALLY IMPLEMENTED`                                                                   |
| 12  | Can offline drivers still heartbeat?             | **NO** — `recordHeartbeat` returns early when there is no status row or `status === 'OFFLINE'`, so it cannot resurrect an offline driver ✅                                       |

### 17.2 Every writer of availability / status

`ZAROORAT CODEBASE` — `DriverStatusRepository.updateStatus` and `updateHeartbeat`; `DriverRepository.updateAvailability` and `setSuspended`. Callers: `StatusService.{setOnline,setOffline,recordHeartbeat,setSuspended}`, `LocationService.updateLocation` (heartbeat only), `HeartbeatTimeoutJob`.

### 17.3 `HeartbeatTimeoutJob`

Fully wired (cron, DI, Redis lock). Sweeps `status IN ('ONLINE','BREAK')` with `heartbeatAt <= now - 300s`. Two gaps: it never calls `driverMetrics.heartbeatTimeout()`, which exists for exactly this; and a driver who went `ONLINE` but never sent a heartbeat has `heartbeatAt = null`, which does not match `{ lte: threshold }` and is **never swept**.

---

## 18. Suspension and Concurrency — `BROKEN`

### 18.1 The self-deadlock

`StatusService.setSuspended`:

```ts
await this.txManager.execute(async (tx) => {
  await this.driverRepo.lockForUpdate(driverId, tx);        // outer tx holds SELECT … FOR UPDATE
  await this.driverRepo.setSuspended(driverId, isSuspended, tx);
  if (isSuspended) {
    await this.setOffline(driverId, 'ADMIN_SUSPENSION');    // ← opens a SECOND transaction
```

`TransactionManager.execute` unconditionally calls `this.provider.client.$transaction(callback, …)` — `TransactionManager.ts:29`, verified. It does **not** detect or join an in-flight transaction. The nested `setOffline` therefore runs on a **different pooled connection** and issues its own `FOR UPDATE` on the row the outer transaction still holds.

The inner statement blocks; the outer cannot commit because it awaits the inner; Prisma's interactive-transaction timeout (5 s default, not overridden) aborts it.

> **`POST /api/v1/drivers/:id/suspend` with `{"isSuspended": true}` hangs, then fails. Suspending a driver — a safety operation — does not work.** `{"isSuspended": false}` skips the branch and succeeds. `ZAROORAT CODEBASE` + `INFERENCE`.
>
> Secondary: `setOffline` publishes `driver.status_changed` from _its_ transaction while the outer one is open, so outbox ordering is wrong even on hypothetical success.
>
> Also: the body is read as `req.body as { isSuspended: boolean }` — a raw cast, the **only** driver route with no Zod parse. A malformed body yields `undefined`, the `if` is falsy, and the admin receives `{ success: true }` for a no-op.

### 18.2 Availability has three sources of truth

`Driver.isAvailable` · `DriverOnlineStatus.status` · the Redis live geo index.

`setOnline`/`setOffline` write all three consistently. **`setSuspended` writes only the first** and reaches the other two only through the deadlocking `setOffline`. On timeout, a suspended driver can be left `isAvailable: false` while `DriverOnlineStatus.status` is still `ONLINE` **and they remain in the geo index** — dispatchable the moment dispatch is wired. `INFERENCE`

### 18.3 Concurrency controls that are correct

`lockForUpdate` before every driver read-modify-write in `setOnline`/`setOffline`/`reviewDriverVerification`; `claimForMatch` conditional claim; `updateStatusIf` compare-and-set on every ride transition; `startShift` idempotency under the row lock; `P2002` re-read in `onboardDriver` and `resolveAccount`; `forgetDriverPosition` correctly **after** commit; Redis distributed locks on all ten jobs; `uq_user_role_active` partial unique index; `rides_request_id_key`.

---

## 19. Location and Geo Index

`POST /api/v1/drivers/location` — rate-limited, **no operability guard**. `LocationService.updateLocation`: reject mock GPS → driver exists → `assessPlausibility` → raw `INSERT … ON CONFLICT (driver_id) DO UPDATE` writing decimal lat/lng **and** the PostGIS `geography(Point,4326)` column → `geoService.recordDriverPosition` (H3 cell → Redis) → `statusRepo.updateHeartbeat`.

### 19.1 The 10 required answers

| #   | Question                                       | Answer                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Who can send location?                         | **Any authenticated user with a Driver row**, in any state                                                                                                                                                                                                                                                              |
| 2   | Can `PENDING` drivers send location?           | **YES** — and they enter the live index                                                                                                                                                                                                                                                                                 |
| 3   | Can `DOCUMENT_REVIEW` drivers?                 | **YES**                                                                                                                                                                                                                                                                                                                 |
| 4   | Can `SUSPENDED` drivers?                       | **YES** — and §18.2 means suspension may not remove them                                                                                                                                                                                                                                                                |
| 5   | Can `OFFLINE` drivers populate live discovery? | **YES** — nothing in the query filters on online status                                                                                                                                                                                                                                                                 |
| 6   | Can `ONLINE`/`BUSY`/`ON_TRIP`?                 | `ONLINE` yes (correct). `BUSY`/`ON_TRIP` are unreachable states                                                                                                                                                                                                                                                         |
| 7   | Is removal from the index reliable?            | **Partially.** Explicit `forgetDriverPosition` on `setOffline` ✅; Redis TTL `liveLocationTtlSeconds = 300` ✅; PostGIS freshness bound `candidateStalenessSeconds = 120` ✅. **Not removed by suspension** (§18.2) or by going on-trip                                                                                 |
| 8   | Stale heartbeat/location cleanup?              | **YES** — `HeartbeatTimeoutJob` + both TTL mechanisms, with the `heartbeatAt = null` gap (§17.3)                                                                                                                                                                                                                        |
| 9   | Ordering / CAS logic correct?                  | **Reasonable.** `RedisGeoProvider.setPosition` returns a boolean stale-rejection and the service emits `positionRejectedStale` — real monotonicity protection. Plausibility is an unlocked read-then-write, acceptable for a position stream; `ON CONFLICT` keeps the row consistent. DB and Redis can briefly disagree |
| 10  | Mock location: signal, proof, or rejection?    | **Rejection.** `driverConfig.rejectMockLocation` defaults to **`true`** (`DRIVER_REJECT_MOCK_LOCATION !== 'false'`), and `LocationService` throws `MockLocationRejectedError` and emits `mockLocationRejected`. `TEST EVIDENCE` — `tests/unit/drivers/mock-location.test.ts`                                            |

**Root cause of rows 2–5:** the location route has no eligibility gate, **and** `PostgisProvider.findNearbyDrivers` queries `driver_locations` **alone** — no join to `drivers`, no filter on `verificationStatus`, `isSuspended`, `isAvailable`, or `DriverOnlineStatus.status` (`postgis.provider.ts:31-44`).

### 19.2 `findNearbyDrivers` — **DISCONNECTED PRODUCTION PRIMITIVE**

> Searched `src/` excluding `generated/`. The only call sites are `geo.service.ts:19` (facade → `nearby.find`) and `nearby-driver.service.ts:44` (→ `postgisProvider`) — **both internal delegation within the geo module**. No route, no service outside geo, no job, no subscriber. 23 references in `tests/`, all resolving the service straight from the DI container.
>
> **DISCONNECTED PRODUCTION PRIMITIVE. Geo write path exists; discovery read path is unwired.** `ZAROORAT CODEBASE` + `TEST EVIDENCE`

Also disconnected in geo: `GeoService.liveDriverPosition`, `GeoService.calculateExactDistanceMeters`, `PostgisProvider.isWithin`.

---

## 20. Matching — `STUB / EMPTY`

`src/modules/matching/index.ts` = `export {};` (2 bytes of content), plus a README. Re-verified this session. No service, no function, no route, no worker, no DI registration. **There is nothing to classify beyond the folder.**

---

## 21. Dispatch — `STUB / EMPTY` module over `IMPLEMENTED BUT DISCONNECTED` primitives

`src/modules/dispatch/index.ts` = `export {};` (re-verified). The dispatch primitives live inside `rides/`.

| Component                                       | Location                                         | Route/event/worker caller                                                                | Classification                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DispatchService.offerToDriver`                 | `rides/services/dispatch/dispatch.service.ts:13` | **NONE.** Registered in DI, hung off `rideService.dispatch`; nothing reads that property | `IMPLEMENTED BUT DISCONNECTED`                                                                                           |
| `RideDispatchRepository.createOffer`            | `:6`                                             | only via the unreachable `offerToDriver`                                                 | `IMPLEMENTED BUT DISCONNECTED`                                                                                           |
| `RideDispatchRepository.findByRequestAndDriver` | `:32`                                            | **NONE** — the offer-validation check `accept` should perform                            | `IMPLEMENTED BUT DISCONNECTED`                                                                                           |
| `RideDispatchRepository.updateResponse`         | `:44`                                            | **NONE** — nothing records a driver's accept/reject                                      | `IMPLEMENTED BUT DISCONNECTED`                                                                                           |
| `DispatchTimeoutJob`                            | `rides/jobs/dispatch-timeout.job.ts`             | ✅ cron `* * * * *`, Redis-locked                                                        | `IMPLEMENTED + WIRED` but **inert** — operates on a table nothing writes, and **does not re-offer**; timeout is terminal |
| `RideOffer`                                     | —                                                | —                                                                                        | **MISSING** — no such model or symbol; the offer concept is `RideDispatch`                                               |

### 21.1 The chain, traced

```
POST /rides/requests → RideRequest(CREATED)
  └─ publish ride.requested ──► ZERO SUBSCRIBERS ──► ✗ END

   [ findNearbyDrivers  — complete, 0 production callers ]
   [ offerToDriver      — complete, 0 production callers ]
   [ notification/socket — MISSING entirely (§24, §11 of the brief) ]
   [ timeout            — job runs, table always empty, no re-offer ]

POST /rides/accept ← the ONLY way a Ride is ever created,
                     and the driver must already know the requestId
```

| Stage                    | EXISTS | HAS PRODUCTION CALLER | END-TO-END WORKING               |
| ------------------------ | ------ | --------------------- | -------------------------------- |
| `ride.requested` emitted | ✅     | ✅                    | ✅                               |
| matching                 | ❌     | ❌                    | ❌                               |
| nearby discovery         | ✅     | ❌                    | ❌                               |
| eligibility filtering    | ❌     | ❌                    | ❌                               |
| offer creation           | ✅     | ❌                    | ❌                               |
| offer delivery           | ❌     | ❌                    | ❌                               |
| timeout                  | ✅     | ✅                    | ❌ (empty table)                 |
| next driver              | ❌     | ❌                    | ❌                               |
| accept                   | ✅     | ✅                    | ⚠️ only with a known `requestId` |

> **The primitives exist and are individually correct. The orchestrator does not exist. Do not rebuild the primitives.** `INFERENCE`

---

## 22. Vehicles — `STUB / EMPTY` over a complete schema

`src/modules/vehicles/index.ts` = `export {};` (re-verified). No routes, services, repositories, controllers, or DI registration.

| #   | Question                                                | Answer                                                                                                                                                                                 |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which models exist?                                     | `Vehicle`, `VehicleType`, `VehicleDocument`, `VehicleImage`, `VehicleInspection`, `VehicleAssignment`, `MaintenanceLog`, `FuelLog`, `InsuranceClaim` — all `MIGRATION/SCHEMA EVIDENCE` |
| 2   | Vehicle registration?                                   | **Schema yes** (`registrationNumber @unique`, `vin @unique`, make/model/year/fuel/seating, `currentDriverId`, `isActive`). **Code: none**                                              |
| 3   | Vehicle approval?                                       | Per-document `verificationStatus` only; **no vehicle-level approval column**. No code                                                                                                  |
| 4   | Vehicle assignment?                                     | `VehicleAssignment` model complete (driverId, vehicleId, assignedAt, releasedAt, reason, assignedBy, status). **Zero hand-written references**                                         |
| 5   | `Driver.currentVehicleId` / `VehicleAssignment` used?   | **Neither.** `currentVehicleId` exists as a column with **no `@relation` and therefore no FK**; zero references outside generated Prisma types                                         |
| 6   | **Do rides require `vehicleId` at the database level?** | **YES — `rides.vehicle_id UUID NOT NULL`** (`migration.sql:1567`), `vehicle Vehicle @relation` non-optional                                                                            |
| 7   | Is `RideDispatch.vehicleId` nullable?                   | **YES** — `String?`, `vehicle Vehicle?`                                                                                                                                                |
| 8   | Does ONLINE status store a vehicle?                     | **NO** — `DriverOnlineStatus` has no vehicle column at all                                                                                                                             |
| 9   | Where does vehicle validation belong?                   | §22.1                                                                                                                                                                                  |

### 22.1 The lifecycle-stage decision, from schema evidence

> **The vehicle requirement belongs at ACCEPT — not at onboarding, approval, or online.**
>
> Three schema facts decide it, without appeal to preference:
>
> | Fact                                           | Implication                                                                 |
> | ---------------------------------------------- | --------------------------------------------------------------------------- |
> | `rides.vehicle_id` is **NOT NULL**             | A ride **cannot exist** without a vehicle → hard gate at accept             |
> | `RideDispatch.vehicleId` is **nullable**       | An **offer may be made** without one → no gate at dispatch                  |
> | `DriverOnlineStatus` has **no vehicle column** | Availability was modelled **independently of vehicles** → no gate at online |
>
> Adding a hard vehicle requirement to `setOnline` would contradict a schema deliberately built without one. A **soft** signal at online time (a warning, or a `hasEligibleVehicle` field in `GET /me`) is compatible. `MIGRATION/SCHEMA EVIDENCE` + `INFERENCE`.

### 22.2 Client-supplied `vehicleId` at accept — `BROKEN`

`acceptRideRequestSchema` requires `vehicleId: z.string().uuid()`; `LifecycleService.acceptRideRequest` passes it **straight to `rideRepo.create`**.

| Validation             | Present? | Consequence                                                                                                                                |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Existence              | ❌       | An arbitrary UUID produces an FK violation surfacing as **500**                                                                            |
| Ownership / assignment | ❌       | `VehicleAssignment` never consulted — **a driver can accept in another driver's vehicle**                                                  |
| Active status          | ❌       | `isActive` never read                                                                                                                      |
| Type compatibility     | ❌       | `vehicle.vehicleTypeId` never compared to `request.vehicleTypeId` — **accept a premium request in a hatchback, be paid the premium quote** |
| Approval / documents   | ❌       | `VehicleDocument.verificationStatus` never read                                                                                            |

Nothing creates a `Vehicle` row in production, so accept cannot currently be satisfied at all. `TEST EVIDENCE` — `fixtures.ts` `makeVehicle`/`makeVehicleType` insert directly.

---

## 23. Ride Acceptance and Concurrent Ride Protection — `BROKEN`

| #   | Question                                         | Answer                                                                                                                                                                                                                              |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does accept check existing active rides?         | **NO.** `RideRepository.findActiveByDriver` (`ride.repository.ts:85`) has **zero callers** — while the customer-side twin `findActiveByCustomer` **is** called by `createRequest`. The driver-side check was written and never used |
| 2   | Is the check in the same transaction?            | **N/A — there is no check**                                                                                                                                                                                                         |
| 3   | **Can two concurrent accepts succeed?**          | **For the same request: NO.** For **different requests: YES** — §23.1                                                                                                                                                               |
| 4   | Does a database constraint protect against this? | **NO.** §23.1                                                                                                                                                                                                                       |
| 5   | When does availability become `BUSY`/`ON_TRIP`?  | **Never.** Neither value is written by any code. The driver stays `ONLINE`, `isAvailable: true`, and in the geo index throughout the trip                                                                                           |
| 6   | Are status and ride updates atomic?              | Ride updates yes (row lock + CAS). **Driver status is not updated at all**                                                                                                                                                          |
| 7   | Retry / idempotency?                             | `claimForMatch` makes a **repeat accept of the same request** safe — `RideRequestAlreadyMatchedError`. No idempotency key on accept                                                                                                 |

### 23.1 What the database does and does not protect

`MIGRATION/SCHEMA EVIDENCE` — every relevant unique index, enumerated:

| Index                                                                                                                      | Protects                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `rides_request_id_key` on `rides(request_id)` — migration `20260810100000`                                                 | **One ride per request.** Two drivers cannot double-book the _same_ request |
| `ride_dispatches_request_id_driver_id_key`                                                                                 | One offer per (request, driver)                                             |
| `uq_user_role_active` on `user_roles(user_id, role_id) WHERE revoked_at IS NULL`                                           | One live role assignment                                                    |
| `driver_profiles_driver_id_key`, `driver_wallets_driver_id_key`, `driver_settlements(driver_id, period_start, period_end)` | Unrelated                                                                   |
| **Nothing on `rides(driver_id)` for active statuses**                                                                      | ❌ **One driver, many concurrent rides is unprotected**                     |

Application layer: `claimForMatch` is a correct conditional claim (`updateMany … status IN ('CREATED','SEARCHING') → 'MATCHED'`, returning `count === 1`), but it is scoped to **one request**.

> **So: driver accepts request A → ride 1; accepts request B → ride 2. Both succeed.** `rides_request_id_key` does not help (different `request_id`s), `claimForMatch` does not help (different requests), `findActiveByDriver` is never called, and no index constrains it. **Confirmed at both the code and schema level.**

### 23.2 Documentation drift worth noting

Migration `20260810100000` reasons about its own safety with: _"On a database that has never served traffic (the current state: the rides routes are not mounted) it returns nothing."_

**That is now stale.** `routes/register.ts:20` mounts `rideRoutes` at `/api/v1/rides`. `ZAROORAT CODEBASE`. The migration is still correct; its safety _argument_ no longer holds, which matters if it is ever replayed against a database that has served traffic.

---

## 24. Events / Outbox / Subscribers

### 24.1 Subscriber census — the entire repository

```
$ grep -rn "eventBus.on(" src --exclude-dir=generated
src/modules/auth/consumers/epoch-invalidation.consumer.ts:17
```

**One subscriber, four event types.** `bootstrapEvents()` registers only `epochInvalidationConsumer`. Every other event published anywhere in the platform has **zero listeners** — durably persisted to `event_outbox` (a real, replayable audit trail) but triggering nothing.

### 24.2 The required trace table

| Event                                    | Producer                                    | Tx / Outbox | Publisher     | Subscriber                  | Registered? | Side effect                            |
| ---------------------------------------- | ------------------------------------------- | ----------- | ------------- | --------------------------- | ----------- | -------------------------------------- |
| `driver.onboarded`                       | `onboardDriver`                             | ✅ in tx    | `OutboxRelay` | —                           | ❌          | none                                   |
| document submitted                       | **no such event**                           | —           | —             | —                           | ❌          | —                                      |
| document verified                        | **no such event**                           | —           | —             | —                           | ❌          | —                                      |
| `driver.verified`                        | `reviewDriverVerification:103`              | ✅ in tx    | `OutboxRelay` | —                           | ❌          | none — **the missing role-grant hook** |
| `account.role.granted`                   | `grantRole` (0 callers) + new-account login | ✅ in tx    | `OutboxRelay` | `EpochInvalidationConsumer` | ✅          | **epoch bump**                         |
| `driver.status_changed` (online/offline) | `setOnline`/`setOffline`                    | ✅ in tx    | `OutboxRelay` | —                           | ❌          | none                                   |
| `driver.suspended`                       | `setSuspended` (deadlocking path)           | ✅ in tx    | `OutboxRelay` | —                           | ❌          | none                                   |
| `ride.requested`                         | `createRequest`                             | ✅ in tx    | `OutboxRelay` | —                           | ❌          | none — **the missing dispatch hook**   |
| `ride.dispatch_offered`                  | `offerToDriver` (0 callers)                 | ✅          | `OutboxRelay` | —                           | ❌          | none                                   |
| `ride.accepted`                          | `acceptRideRequest`                         | ✅ in tx    | `OutboxRelay` | —                           | ❌          | none                                   |

### 24.3 Declared but never published

`driver.document_expired` (the job emits a metric instead), `driver.shift_started`, `driver.shift_ended`, `driver.location_updated` — four of eight entries in `DRIVER_EVENT_CATALOG`. `ZAROORAT CODEBASE`

### 24.4 Consumers that exist but are never registered

**None.** `EpochInvalidationConsumer` is the only consumer class in the repository, and it _is_ registered. The gap is the reverse: **events with no consumer**, not consumers with no registration.

> The outbox is well built — transactional publish, claim-token relay with retry/backoff. **Adding a subscriber is one `eventBus.on`. Do not build a second bus.**

---

## 25. Tests and Fixture Shortcuts

**714 unit tests pass, reproducibly, against code that does not compile** (§4.1).

### 25.1 Direct-insert shortcuts, verbatim

`TEST EVIDENCE` — `tests/integration/helpers/fixtures.ts`:

```ts
export async function grantRole(userId, slug) {              // bypasses AuthService.grantRole
  ... await db().client.userRoleAssignment.create({ data: { userId, roleId: role.id } });
}

export async function makeDriver(userId, { verified = true, suspended = false } = {}) {
  const driver = await db().client.driver.create({ data: {
    userId, driverCode: …, verificationStatus: verified ? 'VERIFIED' : 'PENDING', … }});
  if (verified) {
    await db().client.driverDocument.create({ data: {         // ← the insert that hides the P0
      driverId: driver.id, documentType: 'DRIVING_LICENSE',
      verificationStatus: 'VERIFIED',                         // ← no production code can write this
      fileUrl: 'https://example.invalid/licence.jpg',         // ← no production code validates this
    }});
  }
}
```

Direct inserts confirmed for: **VERIFIED drivers**, **VERIFIED documents**, **DRIVER role**, **active rides** (`makeRide`, raw SQL), **geo positions** (via `locationRepo` directly), vehicles, vehicle types.

`auth-driver-gate.test.ts` compounds it: inserts a `userRoleAssignment` row, logs in twice to pick up the claim, inserts a `VERIFIED` driver, and registers its **own ad-hoc route** (`app.get('/test/ride-accept', …)`) rather than exercising a production one.

### 25.2 Lifecycle coverage

| Step                            | Coverage                                                                   |
| ------------------------------- | -------------------------------------------------------------------------- |
| Phone → OTP send                | **REAL END-TO-END**                                                        |
| OTP verify → tokens             | **REAL END-TO-END**                                                        |
| User + `customer` role          | **REAL END-TO-END**                                                        |
| Onboarding (`POST /me/onboard`) | **NO COVERAGE**                                                            |
| Profile (name/gender/email)     | **NO COVERAGE**                                                            |
| File upload → document          | **NO COVERAGE** (integration does not exist)                               |
| Document submission             | **NO COVERAGE**                                                            |
| Document review                 | **NO COVERAGE** (no production code)                                       |
| Document → VERIFIED             | **FIXTURE SHORTCUT ONLY**                                                  |
| Driver approval                 | **NO COVERAGE**                                                            |
| Role assignment                 | **FIXTURE SHORTCUT ONLY**                                                  |
| Token refresh → new claims      | **PARTIAL** — mechanism proven in `auth-roles.test.ts`, never for a driver |
| Online                          | **NO COVERAGE** with an expectation of success                             |
| Location                        | **PARTIAL** — unit only; route never exercised                             |
| Discovery / offer / accept      | **NO COVERAGE** of the path                                                |

**Zero tests exercise any route in `driver.routes.ts`** except two auth/BOLA probes.

> ### TEST DOES NOT PROVE PRODUCTION FLOW
>
> The suite cannot prove the lifecycle. Every test needing a working driver manufactures one in three `INSERT`s, so no test ever asks _"could a real client have produced this row?"_ — which is exactly why the two P0s went unnoticed while CI stayed green. `TEST EVIDENCE` + `INFERENCE`

**Genuinely valuable tests to keep:** `route-graph.test.ts` (pins the public route surface to nine sanctioned entries), `ride-state-machine.test.ts`, `ride-lifecycle-concurrency.test.ts`, `auth-roles.test.ts`, `geo-nearby.test.ts`, `log-redaction.test.ts`.

---

## 26. Existing Modules / Folders Classification

| Module / component                                                                                                                                                      | Classification                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `auth` (OTP, sessions, tokens, epoch)                                                                                                                                   | `IMPLEMENTED + WIRED`                                                                              |
| `auth` → `grantRole` / `revokeRole`                                                                                                                                     | `IMPLEMENTED BUT DISCONNECTED`                                                                     |
| `auth` → `PermissionRepository.findAllowedCodesForUser`                                                                                                                 | `IMPLEMENTED BUT DISCONNECTED`                                                                     |
| `users`                                                                                                                                                                 | `IMPLEMENTED + WIRED`                                                                              |
| `files`                                                                                                                                                                 | `IMPLEMENTED + WIRED`                                                                              |
| `files` → `DRIVER_DOCUMENT` purpose + `registerFileReference`                                                                                                           | `IMPLEMENTED BUT DISCONNECTED`                                                                     |
| `payments`                                                                                                                                                              | `IMPLEMENTED + WIRED`                                                                              |
| `drivers` → onboarding                                                                                                                                                  | `PARTIALLY IMPLEMENTED` (uncommitted; build broken)                                                |
| `drivers` → `getMe`                                                                                                                                                     | **`BROKEN`**                                                                                       |
| `drivers` → document submission                                                                                                                                         | `PARTIALLY IMPLEMENTED`                                                                            |
| `drivers` → document review                                                                                                                                             | **`MISSING`**                                                                                      |
| `drivers` → approval                                                                                                                                                    | `PARTIALLY IMPLEMENTED`                                                                            |
| `drivers` → online/offline/shifts                                                                                                                                       | `PARTIALLY IMPLEMENTED`                                                                            |
| `drivers` → suspend                                                                                                                                                     | **`BROKEN`**                                                                                       |
| `drivers` → location                                                                                                                                                    | `IMPLEMENTED + WIRED` (ungated)                                                                    |
| `drivers` → wallet (read)                                                                                                                                               | `IMPLEMENTED + WIRED`                                                                              |
| `drivers` → `ShiftService`, `DriverBankRepository`, `driver.plugin.ts`, `driver.responses.ts`                                                                           | `IMPLEMENTED BUT DISCONNECTED`                                                                     |
| `drivers` → both jobs                                                                                                                                                   | `IMPLEMENTED + WIRED` (`DocExpirationJob` inert)                                                   |
| `geo` → position recording                                                                                                                                              | `IMPLEMENTED + WIRED`                                                                              |
| `geo` → `findNearbyDrivers`, `liveDriverPosition`, `calculateExactDistanceMeters`, `isWithin`                                                                           | `IMPLEMENTED BUT DISCONNECTED`                                                                     |
| `rides` → request/quote                                                                                                                                                 | `IMPLEMENTED + WIRED`                                                                              |
| `rides` → accept/arrive/start/complete                                                                                                                                  | `PARTIALLY IMPLEMENTED`                                                                            |
| `rides` → active/history reads                                                                                                                                          | **`BROKEN`** (§16.3)                                                                               |
| `rides` → dispatch primitives                                                                                                                                           | `IMPLEMENTED BUT DISCONNECTED`                                                                     |
| `notifications` (SMS)                                                                                                                                                   | `IMPLEMENTED + WIRED`                                                                              |
| Push / FCM / APNs / WebSocket                                                                                                                                           | **`MISSING`** (`plugins/socket/socket.plugin.ts` is `export {};` and unregistered)                 |
| `matching`, `dispatch`, `vehicles`, `admin`, `support`, `onboarding`, `documents`, `analytics`, `chat`, `settings`, `sos`, `reviews`, `promotions`, `pricing`, `riders` | **`STUB / EMPTY`** (`export {};` + README)                                                         |
| `core/database/extensions/DriverExtensions.findActiveDrivers`                                                                                                           | `IMPLEMENTED BUT DISCONNECTED` (extension **is** applied to the client; the method has no callers) |
| `driverConfig.requireApprovedDocuments`                                                                                                                                 | `IMPLEMENTED BUT DISCONNECTED` — **dead flag for the exact missing gate**                          |
| `driverConfig.maxContinuousShiftHours`                                                                                                                                  | `IMPLEMENTED BUT DISCONNECTED` — no shift-duration enforcement exists                              |
| `src/common/`, `src/infrastructure/`, `src/middleware/`, `src/shared/{cache,events,pagination,response}`, `src/routes/index.ts`, `plugins/jwt`                          | **`STUB / EMPTY`** — ~20 one-line `export {};` files, none imported                                |

---

## 27. Production Gap Matrix

| #   | Capability                       | Files | Logic   | Route/Event | Prod caller | Classification                                                                                                        |
| --- | -------------------------------- | ----- | ------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | OTP send/verify                  | ✅    | ✅      | ✅          | ✅          | `IMPLEMENTED + WIRED`                                                                                                 |
| 2   | User + `customer` role           | ✅    | ✅      | ✅          | ✅          | `IMPLEMENTED + WIRED`                                                                                                 |
| 3   | Explicit onboarding              | ✅    | ✅      | ✅*         | ✅          | `PARTIALLY IMPLEMENTED` (*uncommitted)                                                                                |
| 4   | Resume probe (`GET /me`)         | ✅    | ✅      | ✅          | ✅          | **`BROKEN`**                                                                                                          |
| 5   | Profile name/gender              | ✅    | ✅      | ✅          | ✅          | `PARTIALLY IMPLEMENTED`                                                                                               |
| 6   | Profile email                    | ✅    | ✅      | ✅          | ✅          | `PARTIALLY IMPLEMENTED`                                                                                               |
| 7   | Files-backed documents           | ✅    | ✅      | ✅          | ❌          | `IMPLEMENTED BUT DISCONNECTED`                                                                                        |
| 8   | Document submission              | ✅    | ✅      | ✅          | ✅          | `PARTIALLY IMPLEMENTED`                                                                                               |
| 9   | **Document review → VERIFIED**   | ❌    | ❌      | ❌          | ❌          | **`MISSING`** ⛔                                                                                                      |
| 10  | Driver approval                  | ✅    | ✅      | ✅          | ✅          | `PARTIALLY IMPLEMENTED`                                                                                               |
| 11  | **DRIVER role assignment**       | ✅    | ✅      | ❌          | ❌          | **`IMPLEMENTED BUT DISCONNECTED`** ⛔                                                                                 |
| 12  | Epoch invalidation               | ✅    | ✅      | ✅          | ✅          | `IMPLEMENTED + WIRED`                                                                                                 |
| 13  | Centralized eligibility          | ❌    | partial | ✅          | ✅          | `PARTIALLY IMPLEMENTED` (two disagreeing gates)                                                                       |
| 14  | Go ONLINE                        | ✅    | ✅      | ✅          | ✅          | **`BROKEN`**                                                                                                          |
| 15  | Go OFFLINE                       | ✅    | ✅      | ✅          | ✅          | `PARTIALLY IMPLEMENTED` (ungated)                                                                                     |
| 16  | Heartbeat + timeout              | ✅    | ✅      | ✅          | ✅          | `IMPLEMENTED + WIRED`                                                                                                 |
| 17  | Suspend                          | ✅    | ✅      | ✅          | ✅          | **`BROKEN`**                                                                                                          |
| 18  | Location ingestion               | ✅    | ✅      | ✅          | ✅          | `PARTIALLY IMPLEMENTED` (ungated)                                                                                     |
| 19  | Location history                 | ❌    | ❌      | ❌          | ❌          | **`MISSING`** — `driver_location_history` in **no** migration despite `driver.prisma:221` claiming raw-SQL management |
| 20  | Geo discovery                    | ✅    | ✅      | ❌          | ❌          | **`IMPLEMENTED BUT DISCONNECTED`** ⛔                                                                                 |
| 21  | Matching                         | ❌    | ❌      | ❌          | ❌          | **`STUB / EMPTY`**                                                                                                    |
| 22  | Dispatch orchestration           | ❌    | ❌      | ❌          | ❌          | **`MISSING`**                                                                                                         |
| 23  | Offer create/respond             | ✅    | ✅      | ❌          | ❌          | `IMPLEMENTED BUT DISCONNECTED`                                                                                        |
| 24  | Offer delivery                   | ❌    | ❌      | ❌          | ❌          | **`MISSING`**                                                                                                         |
| 25  | `BUSY`/`ON_TRIP` writes          | ❌    | ❌      | ❌          | ❌          | **`MISSING`**                                                                                                         |
| 26  | Concurrent-ride protection       | ✅    | ❌      | ✅          | ❌          | **`BROKEN`** (no code, no index)                                                                                      |
| 27  | Vehicle validation at accept     | ❌    | ❌      | ✅          | ✅          | **`BROKEN`**                                                                                                          |
| 28  | Vehicle module                   | ❌    | ❌      | ❌          | ❌          | **`STUB / EMPTY`**                                                                                                    |
| 29  | Driver active-ride/history reads | ✅    | ✅      | ✅          | ✅          | **`BROKEN`** (dead role branch)                                                                                       |
| 30  | Admin review queue               | ❌    | ❌      | ❌          | ❌          | **`MISSING`**                                                                                                         |
| 31  | Role management API              | ✅    | ✅      | ❌          | ❌          | `IMPLEMENTED BUT DISCONNECTED`                                                                                        |
| 32  | Push / realtime                  | ❌    | ❌      | ❌          | ❌          | **`MISSING`**                                                                                                         |
| 33  | Driver aggregates + shift stats  | ❌    | ❌      | ❌          | ❌          | **`MISSING`**                                                                                                         |
| 34  | Audit log                        | ❌    | ❌      | ❌          | ❌          | **`MISSING`** (outbox may suffice)                                                                                    |

---

## 28. P0 Blockers

**P0-1 — Tree does not compile/lint/build; artifact unrunnable.** `BROKEN` · `BUILD EVIDENCE`
`driver-onboarding.controller.ts:18` (`DriverNotFoundError` unimported) + `onboarding.service.ts:39` (`catch (err: any)` vs `--max-warnings=0`). Both **uncommitted**. `dist/` retains `require("@core/auth")` → `MODULE_NOT_FOUND`. **Impact:** nothing deployable; nothing else verifiable. **Action:** two lines.

**P0-2 — No production writer for `DriverDocument.verificationStatus = VERIFIED`.** `MISSING` · `ZAROORAT CODEBASE`
**Impact:** `setOnline`'s licence gate is permanently unsatisfiable; `DocExpirationJob` permanently inert; the document pipeline terminates. **First blocker in the lifecycle.** **Action:** service method + admin route over the existing repository method.

**P0-3 — `grantRole` has zero production callers; `driver` role never granted.** `IMPLEMENTED BUT DISCONNECTED` · `ZAROORAT CODEBASE`
**Impact:** no driver holds the role; the epoch chain never fires; **and it already breaks `GET /rides/active` + `/history`** (§16.3). **Action:** one call — see §15.2 for the two options.

**P0-4 — Driver approvable with zero / `PENDING` / `REJECTED` documents.** `BROKEN` · `ZAROORAT CODEBASE`
**Impact:** an unvetted person reaches `VERIFIED`, satisfying `requireOperableDriver` on five routes. **Action:** wire `requireApprovedDocuments` (which already exists and defaults to `true`) and declare the mandatory set.

**P0-5 — Documents bypass Files; arbitrary client URLs trusted.** `BROKEN` · `ZAROORAT CODEBASE`
**Impact:** no ownership proof, no content validation, no scanning, no retention; an admin reviewer's browser fetches a driver-controlled URL. **Action:** `fileId` + Files ownership/purpose check + `registerFileReference`. **Requires a schema change** — flagged, not created.

**P0-6 — `POST /drivers/:id/suspend` self-deadlocks and can corrupt availability.** `BROKEN` · §18
**Impact:** a safety operation does not work; partial suspension leaves the driver dispatchable. **Action:** pass `tx` into `setOffline`, or restructure so only one transaction is open.

**P0-7 — Dispatch is not a running system.** `MISSING` · §21
**Impact:** no ride can be matched; accept requires a `requestId` the driver cannot legitimately obtain. **Action:** orchestrator over existing primitives.

**P0-8 — One driver can hold unlimited concurrent active rides.** `BROKEN` · §23
No service check (`findActiveByDriver` 0 callers) **and no database constraint**. **Impact:** double-booked passengers, duplicate fares, undefined driver state. **Action:** call the existing query inside the accept transaction; consider a partial unique index as backstop.

---

## 29. P1 Issues

| #     | Issue                                                                                            | Class                          |
| ----- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| P1-1  | `GET /rides/active` + `/history` serve customer data to drivers                                  | `BROKEN` (fixed by P0-3)       |
| P1-2  | `vehicleId` at accept unvalidated — existence, assignment, active, type match, approval          | `BROKEN`                       |
| P1-3  | Unverified / suspended / offline drivers enter the geo index                                     | `BROKEN`                       |
| P1-4  | `findNearbyDrivers` has no driver-state filter                                                   | `PARTIALLY IMPLEMENTED`        |
| P1-5  | Licence `expiresAt` unchecked at go-online                                                       | `PARTIALLY IMPLEMENTED`        |
| P1-6  | Racy document upsert; no unique index on `(driver_id, document_type)`                            | `PARTIALLY IMPLEMENTED`        |
| P1-7  | Stale `verifiedBy`/`verifiedAt`/`rejectionReason` survive re-upload                              | `PARTIALLY IMPLEMENTED`        |
| P1-8  | `REJECTED` driver cannot re-enter review                                                         | `PARTIALLY IMPLEMENTED`        |
| P1-9  | Email written via raw path; `500` on collision; `isEmailVerified` unmanaged                      | `PARTIALLY IMPLEMENTED`        |
| P1-10 | `POST /:id/suspend` body unvalidated (raw cast)                                                  | `PARTIALLY IMPLEMENTED`        |
| P1-11 | **Revoked default role silently re-granted on next login**                                       | `BROKEN`                       |
| P1-12 | `DEFAULT_USER_ROLE` unvalidated at boot; misconfiguration grants a privileged role platform-wide | `PARTIALLY IMPLEMENTED`        |
| P1-13 | No admin review queue — an admin cannot discover who needs review                                | `MISSING`                      |
| P1-14 | No notification channel to the driver                                                            | `MISSING`                      |
| P1-15 | No Fastify schemas on driver routes; `GET /me` echoes the raw Prisma row                         | `PARTIALLY IMPLEMENTED`        |
| P1-16 | No location history                                                                              | `MISSING`                      |
| P1-17 | Staff bypass in `authorizedDriverId` unaudited                                                   | `PARTIALLY IMPLEMENTED`        |
| P1-18 | `BUSY`/`ON_TRIP` never written — driver stays available and indexed while on a trip              | `MISSING`                      |
| P1-19 | Driver aggregates + shift stats never written                                                    | `MISSING`                      |
| P1-20 | `heartbeatAt = null` drivers never swept                                                         | `PARTIALLY IMPLEMENTED`        |
| P1-21 | `requireApprovedDocuments` + `maxContinuousShiftHours` are dead config flags                     | `IMPLEMENTED BUT DISCONNECTED` |
| P1-22 | Two disagreeing eligibility functions; no single source                                          | `PARTIALLY IMPLEMENTED`        |
| P1-23 | `POST /rides/:id/cancel` has no operability guard                                                | `PARTIALLY IMPLEMENTED`        |

---

## 30. P2 Issues

| #     | Issue                                                                                                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1  | `:driverId` params parsed and ignored — a trap for future readers                                                                                                                                                                                 |
| P2-2  | No `EXPIRED` status; expiry overloads `REJECTED` with a magic string                                                                                                                                                                              |
| P2-3  | `DriverVerificationStatus.SUSPENDED` dead                                                                                                                                                                                                         |
| P2-4  | Four of eight driver events never published; `BREAK` never written                                                                                                                                                                                |
| P2-5  | `driverMetrics.heartbeatTimeout()` never called                                                                                                                                                                                                   |
| P2-6  | Dead code: `ShiftService`, `DriverBankRepository`, `driver.responses.ts`, `InvalidDriverStatusTransitionError`, `DocumentValidationError`, five module `plugins/`, `driverExtension.findActiveDrivers`, `PermissionRepository`, three geo methods |
| P2-7  | `RideStateController` duplicates `actingDriverId` instead of importing it                                                                                                                                                                         |
| P2-8  | `POST /me/onboard` returns `201` for a pre-existing driver                                                                                                                                                                                        |
| P2-9  | `fullLegalName` length-only; whitespace-only passes; `gender` has no DB enum                                                                                                                                                                      |
| P2-10 | `rejectionReason` optional when rejecting a driver                                                                                                                                                                                                |
| P2-11 | `super_admin` is not a seeded role (seed has customer, driver, admin, support, finance)                                                                                                                                                           |
| P2-12 | Three authorization vocabularies: role slugs (enforced), `PERMISSION_SEED` (unenforced), Files' hardcoded `SCOPES_FOR_ROLE`                                                                                                                       |
| P2-13 | `drivers/README.md` claims "0 errors / 550 tests"; actual 1 error / 714 tests                                                                                                                                                                     |
| P2-14 | `format:check` fails on 29 files incl. `driver.repository.ts`                                                                                                                                                                                     |
| P2-15 | Migration `20260810100000` comment "the rides routes are not mounted" is stale (§23.2)                                                                                                                                                            |
| P2-16 | `driver.prisma:221` claims `driver_location_history` is managed in raw SQL; no migration creates it                                                                                                                                               |
| P2-17 | ~20 `export {};` placeholders across `common/`, `infrastructure/`, `middleware/`, `shared/`                                                                                                                                                       |

---

## 31. Existing Code to Reuse — DO NOT REBUILD

| Asset                                                                             | Why                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OTP send/verify** (`auth/services/otp/`)                                        | Challenge binding, multi-axis rate limits, lockout, hashed storage, BullMQ delivery with backoff, audit rows, verified redaction. The Driver App uses the **same two endpoints**                       |
| **`AuthService.runVerifyOtp`**                                                    | Find-or-create, `P2002` handling, profile + device + session + tokens, idempotency                                                                                                                     |
| **`grantRole` / `revokeRole`**                                                    | Idempotent (service **and** `uq_user_role_active`), transactional, event-publishing, epoch-bumping. **Needs a caller, not an implementation**                                                          |
| **Epoch mechanism** (`EpochService` + `EpochInvalidationConsumer` + `authPlugin`) | Complete stale-claim invalidation; fires automatically once `grantRole` is called                                                                                                                      |
| **`authorize()` + `DriverAccessRepository`**                                      | Deny-by-default, fail-closed (`503`), already on five routes                                                                                                                                           |
| **Files module**                                                                  | Presigned upload, magic-byte/size/dimension/EXIF validation, scan state machine, purpose policies, operator read scopes, retention jobs. `DRIVER_DOCUMENT` **already defined for this exact use case** |
| **`registerFileReference`**                                                       | Blocks deletion of a referenced file. Driver documents need **one** registration call                                                                                                                  |
| **Geo stack**                                                                     | H3 + Redis live store + PostGIS/GiST with graceful degradation and stale-position rejection                                                                                                            |
| **Outbox / relay / EventBus**                                                     | Transactional publish, claim tokens, retry/backoff                                                                                                                                                     |
| **Job scheduler + workers + `LockStore`**                                         | Both driver jobs already ride it correctly                                                                                                                                                             |
| **`TransactionManager` + `lockForUpdate`**                                        | Correct pattern — respect the **no-nesting** constraint (P0-6)                                                                                                                                         |
| **Rides state machine**                                                           | `ALLOWED_TRANSITIONS`, `lockAndValidate`, `updateStatusIf` CAS, OTP start, ledger posting                                                                                                              |
| **`claimForMatch` + `rides_request_id_key`**                                      | Correct atomic claim with a database backstop, and a migration that documents its own reasoning                                                                                                        |
| **`User` canonical identity; `Driver` as 1:1 optional extension**                 | Correct model — do not create a separate driver identity                                                                                                                                               |
| **`User.email` as canonical**                                                     | Do **not** add email to `DriverProfile`; fix the driver write path to use `UserRepository.updateEmail`                                                                                                 |
| **Backend-controlled roles**                                                      | No role-shaped field in any request schema. **Preserve this property**                                                                                                                                 |
| **`route-graph.test.ts`**                                                         | Best existing guard on the public surface                                                                                                                                                              |
| **Prisma schema** (driver, vehicle, dispatch)                                     | Anticipated the whole lifecycle; additive changes only                                                                                                                                                 |

---

## 32. Disconnected Existing Code — NEEDS WIRING

The highest-leverage, lowest-risk work in the entire audit.

| Existing asset                                                         | Wire to                                 | Unblocks                    |
| ---------------------------------------------------------------------- | --------------------------------------- | --------------------------- |
| `AuthService.grantRole`                                                | Driver approval                         | **P0-3**, and P1-1 for free |
| `DriverDocumentRepository.updateVerificationStatus`                    | New review service method + admin route | **P0-2**                    |
| `driverConfig.requireApprovedDocuments` (already `true`)               | `reviewDriverVerification`              | **P0-4**                    |
| Files upload + `registerFileReference` + `DRIVER_DOCUMENT` purpose     | Document submission                     | **P0-5**                    |
| `GeoService.findNearbyDrivers`                                         | A `ride.requested` subscriber           | **P0-7**                    |
| `DispatchService.offerToDriver` + `RideDispatchRepository.createOffer` | The dispatch orchestrator               | **P0-7**                    |
| `RideRepository.findActiveByDriver`                                    | `acceptRideRequest`                     | **P0-8**                    |
| `RideDispatchRepository.findByRequestAndDriver` / `updateResponse`     | `acceptRideRequest`                     | P1-2                        |
| `driverConfig.maxContinuousShiftHours`                                 | Shift enforcement                       | P1-19                       |
| `DriverMetrics.heartbeatTimeout`                                       | `HeartbeatTimeoutJob`                   | P2-5                        |
| `PermissionRepository.findAllowedCodesForUser`                         | `authorize()` — or delete it            | P2-12                       |
| `ShiftService`, `DriverBankRepository`                                 | Routes — or delete them                 | P2-6                        |

---

## 33. Exact Lifecycle Transition Matrix

| #   | Transition                               | Writer                        | Route                               | Prod caller            | Classification                                        |
| --- | ---------------------------------------- | ----------------------------- | ----------------------------------- | ---------------------- | ----------------------------------------------------- |
| 1   | phone → OTP sent                         | `OtpService.send`             | `POST /auth/otp/send`               | ✅                     | `IMPLEMENTED + WIRED`                                 |
| 2   | OTP → verified                           | `OtpService.verify`           | `POST /auth/otp/verify`             | ✅                     | `IMPLEMENTED + WIRED`                                 |
| 3   | verified → User + session                | `resolveAccount`              | same                                | ✅                     | `IMPLEMENTED + WIRED`                                 |
| 4   | User → `customer` role                   | `ensureDefaultRole`           | same                                | ✅                     | `IMPLEMENTED + WIRED` (re-grants revoked — P1-11)     |
| 5   | User → Driver(`PENDING`)                 | `onboardDriver`               | `POST /drivers/me/onboard`          | ✅*                    | `PARTIALLY IMPLEMENTED` (*uncommitted)                |
| 6   | Driver → profile persisted               | `updateProfile`               | `PATCH /drivers/:driverId/profile`  | ✅                     | `PARTIALLY IMPLEMENTED`                               |
| 7   | file → owned, validated `fileId`         | Files                         | `POST /files` + `/:id/complete`     | ✅ (unused by drivers) | `IMPLEMENTED BUT DISCONNECTED`                        |
| 8   | file → DriverDocument                    | `upsertDocument`              | `POST /drivers/:driverId/documents` | ✅                     | `PARTIALLY IMPLEMENTED`                               |
| 9   | `PENDING` → `DOCUMENT_REVIEW`            | `submitDocument`              | same                                | ✅                     | `PARTIALLY IMPLEMENTED` (only from exactly `PENDING`) |
| 10  | **document `PENDING` → `VERIFIED`**      | **NONE**                      | **NONE**                            | **NONE**               | **`MISSING`** ⛔                                      |
| 11  | document `PENDING` → `REJECTED` (review) | **NONE**                      | **NONE**                            | **NONE**               | **`MISSING`**                                         |
| 12  | document → `REJECTED` (expiry)           | `DocExpirationJob`            | cron                                | ✅                     | `IMPLEMENTED + WIRED` (inert)                         |
| 13  | all required verified → reviewable       | **NONE**                      | —                                   | —                      | **`MISSING`**                                         |
| 14  | Driver → `VERIFIED`                      | `reviewDriverVerification`    | `POST /drivers/:id/verify`          | ✅                     | `PARTIALLY IMPLEMENTED` (no doc check)                |
| 15  | **`VERIFIED` → `driver` role**           | **NONE**                      | —                                   | —                      | **`IMPLEMENTED BUT DISCONNECTED`** ⛔                 |
| 16  | role → fresh claims                      | `epochService.bump` → refresh | `POST /auth/token/refresh`          | ✅                     | `IMPLEMENTED + WIRED` (never fires)                   |
| 17  | eligible → `ONLINE`                      | `setOnline`                   | `POST /drivers/status/online`       | ✅                     | **`BROKEN`**                                          |
| 18  | `ONLINE` → geo index                     | `recordDriverPosition`        | `POST /drivers/location`            | ✅                     | `PARTIALLY IMPLEMENTED` (ungated)                     |
| 19  | `ride.requested` → candidates            | **NONE**                      | —                                   | —                      | **`MISSING`** ⛔                                      |
| 20  | candidates → offer                       | `offerToDriver`               | —                                   | **NONE**               | `IMPLEMENTED BUT DISCONNECTED`                        |
| 21  | offer → driver notified                  | **NONE**                      | —                                   | —                      | **`MISSING`**                                         |
| 22  | offer → timeout                          | `DispatchTimeoutJob`          | cron                                | ✅                     | `IMPLEMENTED + WIRED` (inert, no re-offer)            |
| 23  | timeout → next driver                    | **NONE**                      | —                                   | —                      | **`MISSING`**                                         |
| 24  | accept → Ride                            | `acceptRideRequest`           | `POST /rides/accept`                | ✅                     | `PARTIALLY IMPLEMENTED`                               |
| 25  | accept → offer validated                 | **NONE**                      | —                                   | —                      | **`MISSING`**                                         |
| 26  | accept → `BUSY`/`ON_TRIP`                | **NONE**                      | —                                   | —                      | **`MISSING`**                                         |
| 27  | accept → one-ride guard                  | **NONE**                      | —                                   | —                      | **`BROKEN`** (no code, no index)                      |
| 28  | arrive / start / complete                | `LifecycleService`            | 3 routes                            | ✅                     | `IMPLEMENTED + WIRED`                                 |
| 29  | complete → aggregates                    | **NONE**                      | —                                   | —                      | **`MISSING`**                                         |
| 30  | `ONLINE` → `OFFLINE`                     | `setOffline`                  | `POST /drivers/status/offline`      | ✅                     | `PARTIALLY IMPLEMENTED` (ungated)                     |
| 31  | stale → `OFFLINE`                        | `HeartbeatTimeoutJob`         | cron                                | ✅                     | `IMPLEMENTED + WIRED`                                 |
| 32  | admin → suspended                        | `setSuspended`                | `POST /drivers/:id/suspend`         | ✅                     | **`BROKEN`**                                          |

---

## 34. Recommended Baseline Freeze Requirements

**Minimum to freeze — three items.** These are prerequisites for a _stable spec_, not the production fix list.

| #      | Requirement                                                               | Why it blocks freezing                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **F1** | **Fix the two build errors and commit or stash the in-flight changeset.** | A spec written against a tree that does not compile, on files another changeset is actively rewriting, will drift within a day. This also settles the HEAD-vs-tree ambiguity in §3 that changes four answers |
| **F2** | **Add `typecheck` + `lint` to CI alongside `test`.**                      | Without it, the next such defect is invisible again — 714 green tests over a non-compiling tree is not a hypothetical                                                                                        |
| **F3** | **Decide the role-assignment mechanism** (§15.2, Option A vs B).          | It determines the module boundary, whether a new consumer file exists, and what the Driver App must tolerate. It is the one architectural fork the spec cannot leave open                                    |

**Recommended but not blocking:** decide whether push/realtime is in scope (it gates the usefulness of dispatch); confirm the vehicle gate sits at accept per §22.1; decide whether the outbox suffices as the audit trail or an `AuditLog` model is required.

**Explicitly NOT required before freeze:** an `onboardingStep` state column (§10 — the derived state is sufficient); deleting dead code (§30 P2-6); the location-history table.

---

## 35. Final Go / No-Go Decision

> ### 🚫 **NO-GO for baseline freeze — pending F1–F3**
>
> **Two failures of different kinds.**
>
> **Mechanical:** the tree does not compile, does not lint, does not build, and `dist/` is unrunnable. Two lines of uncommitted code. Until that is fixed, no claim about this repository can be reproduced, and a specification written against it is built on sand.
>
> **Structural:** eight P0 blockers, of which three sever the lifecycle outright — document `PENDING → VERIFIED` (no writer), driver approved → `driver` role (no caller), ride requested → drivers discovered (no orchestrator).
>
> **What genuinely works over real HTTP:** OTP send/verify; user creation and session issuance; explicit driver onboarding _(uncommitted)_; profile capture including name, gender, and email; document submission. A real, working front half.
>
> **What cannot happen at all:** document verification; role assignment; going online; suspension; dispatch; any notification to a driver. And two shipped endpoints already serve drivers the wrong data.
>
> **The most important conclusion for the specification** is that this is a **wiring problem, not a building problem**. §32 lists eleven complete, correct, disconnected assets. `grantRole` is idempotent, transactional, and epoch-bumping — it needs one caller. `updateVerificationStatus` already writes `verifiedAt`/`verifiedBy` — it needs one method and one route. `requireApprovedDocuments` already exists and defaults to `true` — it needs one `if`. Files already defines `DRIVER_DOCUMENT` with a `drivers:verify` operator scope and an eight-year retention rule. The schema anticipated all of it. **The risk in the next phase is rebuilding what already exists.**
>
> **Two systemic findings worth carrying into the spec**, because they explain how the P0s survived this long:
>
> 1. `tsx` strips types, so CI is green over a non-compiling tree.
> 2. Every test needing a working driver manufactures one in three `INSERT`s, so no test ever asks whether a real client could have produced that row.
>
> A single integration test walking OTP → onboard → profile → document → verify → approve → role-in-claims → online **with zero direct database writes** would have caught P0-2, P0-3, and P0-4 on the day they appeared. That test is the definition of done for Stage 1 — and it is the strongest single guard this codebase could add.
>
> **Fix F1–F3 — realistically under an hour — and the answer becomes GO.**

---

## Final 15 Questions

**1. Can a real Driver complete phone → OTP → User → explicit onboarding?**
**YES in the working tree, NO at HEAD, and NO as a shippable artifact.** `POST /drivers/me/onboard` → `onboardDriver` exists and is correct (uncommitted). At `HEAD` the route does not exist and `GET /me` created the row as a side effect. The tree does not compile, so nothing ships. `ZAROORAT CODEBASE` + `BUILD EVIDENCE`

**2. Is Driver creation explicit and concurrency-safe?**
**YES in the tree.** Explicit route, read-then-create, `P2002` re-read, `Driver.userId @unique` as the database backstop. **NO at HEAD** — no `P2002` handling, and creation happened on a GET. `ZAROORAT CODEBASE` + `MIGRATION/SCHEMA EVIDENCE`

**3. Can the complete profile be persisted and resumed?**
**PARTIALLY.** Name, gender, and email persist transactionally, and `findByUserId` returns profile + documents + onlineStatus in one read — everything resume needs. But the probe endpoint `GET /drivers/me` **does not compile**, and it 404s rather than returning an empty state. No completeness rule exists. `ZAROORAT CODEBASE`

**4. Are Driver documents securely connected to the Files module?**
**NO.** `fileUrl: z.string().url()` — any URL the client types. No `fileId`, no FK to `files`, no ownership check, no purpose check, no content inspection, no scanning, no retention. The `DRIVER_DOCUMENT` purpose exists in Files fully specified with **zero consumers**. `ZAROORAT CODEBASE` + `MIGRATION/SCHEMA EVIDENCE`

**5. Can authorized staff actually verify individual documents?**
**NO.** No route, no service method, no job, no subscriber writes `VERIFIED`. The only writers are `upsertDocument` (`PENDING`) and `DocExpirationJob` (`REJECTED`). `DriverDocumentRepository.updateVerificationStatus` supports it and has exactly one caller, which never passes `VERIFIED`. The only `VERIFIED` write in the repository is `tests/integration/helpers/fixtures.ts:31-38`. **P0 BLOCKER.** `ZAROORAT CODEBASE` + `TEST EVIDENCE`

**6. Can a Driver be approved only after required documents are verified?**
**NO — approval ignores documents entirely.** `reviewDriverVerification` never queries `driver_documents`; zero-document, `PENDING`-document, and `REJECTED`-document drivers can all be set `VERIFIED`. No mandatory set is declared, and `driverConfig.requireApprovedDocuments` (defaulting to `true`) has **zero consumers**. `ZAROORAT CODEBASE`

**7. Does approval automatically result in the DRIVER role being granted?**
**NO.** `grep -rn "grantRole" src --exclude-dir=generated` → one line, the definition. `driver.verified` is published to a bus whose only subscriber handles four auth events. No role, no epoch bump, no new claims. `ZAROORAT CODEBASE`

**8. Can authorization roles and Driver operability disagree?**
**YES — and they do today.** All five write guards use `requireOperableDriver`, which reads the `drivers` table, so an approved role-less driver **passes**. But `GET /rides/active` and `GET /rides/history` branch on `callerHasRole(req,'driver')`, so the same driver is served **customer** data. The `driver` role currently confers no authorization anywhere. `ZAROORAT CODEBASE`

**9. Can a fully approved Driver go ONLINE?**
**NO.** They pass `requireOperableDriver` and are then rejected by `setOnline`'s requirement for a `VERIFIED` `DRIVING_LICENSE` — a status no production code can write. The client sees `403 "Driver is not operable"`; the real cause is `DRIVER_NOT_VERIFIED`. `ZAROORAT CODEBASE`

**10. Can an unapproved/offline/suspended Driver enter the live Geo discovery index?**
**YES, all three.** `POST /drivers/location` has no eligibility gate, and `PostgisProvider.findNearbyDrivers` queries `driver_locations` alone — no join to `drivers`, no filter on `verificationStatus`, `isSuspended`, `isAvailable`, or online status. Suspension's `forgetDriverPosition` sits on the deadlocking path (§18.2), so it may never run. `ZAROORAT CODEBASE`

**11. Is `findNearbyDrivers` actually called by production matching/dispatch?**
**NO.** The only call sites are `geo.service.ts:19` and `nearby-driver.service.ts:44` — internal delegation within the geo module. No route, no external service, no job, no subscriber. 23 test references, all container-resolved. **DISCONNECTED PRODUCTION PRIMITIVE.** `ZAROORAT CODEBASE` + `TEST EVIDENCE`

**12. Can a discovered Driver receive and accept a ride end-to-end?**
**NO.** No driver is ever discovered (Q11), no `RideDispatch` row is ever created, no delivery channel exists (no push, no realtime), and `ride.requested` has no subscriber. `POST /rides/accept` works **only** for a driver who already knows a `requestId` — which nothing legitimately gives them. `ZAROORAT CODEBASE`

**13. Is vehicle selection/validation enforced correctly at the correct lifecycle stage?**
**NO — not enforced anywhere.** `vehicleId` is client-supplied at accept and validated for nothing: existence, ownership/assignment, active status, type compatibility, or document approval. On the _stage_ question, the schema is decisive: `rides.vehicle_id` is **NOT NULL**, `RideDispatch.vehicleId` is nullable, and `DriverOnlineStatus` has no vehicle column — so the gate belongs at **accept**, not at online. `MIGRATION/SCHEMA EVIDENCE` + `ZAROORAT CODEBASE`

**14. Can one Driver accept multiple concurrent active rides?**
**YES.** No service check — `findActiveByDriver` has zero callers, while the customer-side equivalent _is_ called. And **no database constraint**: the only relevant uniques are `rides_request_id_key` (one ride per _request_) and `ride_dispatches(request_id, driver_id)`. Nothing constrains `rides(driver_id)` for active statuses. Accepting two different requests succeeds both times. `ZAROORAT CODEBASE` + `MIGRATION/SCHEMA EVIDENCE`

**15. Is the CURRENT working tree safe enough to freeze and begin `/speckit.specify`?**
**NO — not as it stands, but the gap is small.** Three prerequisites (§34): fix the two build errors and land or stash the in-flight changeset (F1); add `typecheck` + `lint` to CI (F2); decide the role-assignment mechanism (F3). F1 is two lines. Freezing now would pin a specification to a non-compiling tree whose onboarding files another changeset is actively rewriting — and four of this audit's answers would change the moment that changeset lands. **Do F1–F3 first; then freeze and specify.**

---

## Constraints Honoured

- ❌ No production code written or modified
- ❌ No migrations created
- ❌ No refactoring
- ❌ No prettier/write commands run (`format:check` only — read-only)
- ❌ No `/speckit.plan`, `/speckit.tasks`, `/speckit.implement`
- ❌ No `spec.md`, `plan.md`, `tasks.md`, source files, or migrations created
- ✅ Nobody's uncommitted changes modified or discarded
- ✅ Current working tree used as the source of truth; code re-read from disk this session
- ✅ Earlier reports not treated as evidence — every material claim re-verified
- ✅ Verification commands re-executed; unit tests run twice for reproducibility
- ✅ Test-only callers never counted as production callers; `src/generated/**` excluded from every caller search
- ✅ Unverifiable checks reported as `NOT_VERIFIABLE` with the exact reason
- ✅ Only this artifact created: `docs/DRIVER_PLATFORM_FINAL_CURRENT_STATE_AUDIT.md`

**Stopping here. Awaiting your decision.**
