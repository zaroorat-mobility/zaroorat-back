# Zaroorat Mobility

# Driver Registration & Phone Onboarding Audit — Phase 1A

**Date:** 2026-08-16 · **Branch:** `feature/auth` · **Committed base:** `290b3c6`
**Gates at audit time:** typecheck PASS · lint PASS · prisma validate PASS
**Nothing was modified.** No code, schema, migrations, or tests changed.

**Evidence classes:** **[ZAROORAT]** proven from this repo with file:line · **[INDUSTRY]** publicly documented elsewhere · **[INFERENCE]** my reasoning.

---

## 1. Current Registration Flow

**[ZAROORAT]** There is **no driver-specific registration or login route**. The complete mounted auth surface is:

```
POST /api/v1/auth/otp/send      ← public
POST /api/v1/auth/otp/verify    ← public, mints tokens
POST /api/v1/auth/token/refresh ← public
POST /api/v1/auth/logout
GET/DELETE /api/v1/auth/me/sessions · /me/sessions/:id
GET/DELETE /api/v1/auth/me/devices  · /me/devices/:id
```

Drivers and customers authenticate through **the same two endpoints, with the same OTP purpose** (`AUTH_OTP_PURPOSE = 'LOGIN'`, `auth.constants.ts:1`). Nothing in the request distinguishes a driver.

### What actually happens, traced end to end

```
Driver App
  → POST /auth/otp/send  { phoneNumber, device }
      AuthController.sendOtp → AuthService.sendOtp → OtpService.send
      · OtpStore.claimChallenge (Lua: cooldown + per-phone budget + claim, atomic)
      · OtpGenerator.generate → OtpHasher.hash → Redis SET (TTL)
      · otpRepository.create({ outcome: 'queued' })
      · otpProducer.enqueue → BullMQ → worker → MSG91/mock
      ← { challengeId, expiresInSec, resendAvailableInSec }

  → POST /auth/otp/verify { phoneNumber, code, challengeId, device }
      AuthService.verifyOtp (optionally Idempotency-Key wrapped)
      · OtpService.verify — lockout check, challenge-binding, atomic consume
      · TRANSACTION:
          resolveAccount(phone)      → find-or-create User (status ACTIVE)
          assertAuthenticatable      → deletedAt / DEACTIVATED / non-ACTIVE refused
          userProfileRepository.ensureExists
          ensureDefaultRole          → grants 'customer' ONLY
          deviceService.register
          roleRepository.findActiveRoleSlugs   → ['customer']
          sessionService.createInTransaction
          tokenService.issuePair({ userId, sessionId, roles })
          outbox: auth.otp.verified, auth.login.succeeded, auth.session.created
        COMMIT
      · sessionService.enforceCap
      ← { accessToken, refreshToken, user: { id, status, roles, isNew } }

  → GET /api/v1/drivers/me
      OnboardingService.createOrGetDriver(callerId)
      · findByUserId → if absent: TRANSACTION { createDriver(PENDING), outbox driver.onboarded }
      ← DriverView
```

**[ZAROORAT] The driver record is created by a `GET`, with no role check and no application step** (`driver.routes.ts:12`, `driver-onboarding.controller.ts:19`).

---

## 2. Phone Number Flow

| Question                               | Answer                                                                                                                                             | Evidence                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Can a new driver enter a phone number? | **YES** — same endpoint as customers                                                                                                               | `auth.routes.ts`          |
| Phone validation                       | **VERIFIED** — shared `phone` zod schema                                                                                                           | `auth.schemas.ts:23`      |
| Phone ownership proof                  | **VERIFIED** — possession proven by OTP; `isPhoneVerified: true` set on creation                                                                   | `auth.service.ts:401`     |
| Phone uniqueness                       | **VERIFIED** — partial unique index `uq_users_phone_active`; `resolveAccount` catches P2002 and re-reads the winner                                | `auth.service.ts:408-414` |
| Phone change mid-onboarding            | **SAFE** — `Driver` is keyed on `userId`, not phone. `POST /users/me/phone/change` + `/verify` exists; the driver record and all documents survive | `driver.prisma:5`         |
| Enumeration resistance                 | **VERIFIED** — send returns the same shape whether or not the account exists; covered by `auth-enumeration.test.ts`                                | —                         |

---

## 3. OTP Flow

**[ZAROORAT] Fully implemented and the strongest part of this chain.**

| Property                  | Status                                                                                                                 | Evidence                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Cryptographic generation  | **VERIFIED**                                                                                                           | `otp.generator.ts`                                   |
| Never stored in plaintext | **VERIFIED** — HMAC + pepper in Redis                                                                                  | `otp.hasher.ts`, `OtpStore.store`                    |
| Expiry                    | **VERIFIED** — `otpConfig.ttlSeconds`                                                                                  | —                                                    |
| Attempt limit + lockout   | **VERIFIED**                                                                                                           | `otp.rate-limiter.ts`                                |
| Replay impossible         | **VERIFIED** — atomic Lua compare-and-delete on consume                                                                | `OtpStore.CONSUME_LUA`                               |
| Send rate limited         | **VERIFIED** — per phone (in the claim Lua), per device, per IP                                                        | `OtpStore.CLAIM_CHALLENGE_LUA`, `checkSecondaryAxes` |
| Cooldown atomicity        | **VERIFIED** — cooldown, budget and claim in one round trip; documented as fixing a read-then-write double-SMS race    | `OtpStore.ts:44-59`                                  |
| Challenge binding         | **VERIFIED** — `assertChallengeBelongsToCaller` checks phone + purpose + unverified                                    | `otp.service.ts:202`                                 |
| Idempotent verify         | **VERIFIED** — optional `Idempotency-Key` wraps the whole verify                                                       | `auth.service.ts:101-107`                            |
| Delivery                  | **ASYNC** — BullMQ worker; `outcome: 'queued'` until the gateway answers                                               | `otp.service.ts:157`                                 |
| Failure rollback          | **VERIFIED** — on enqueue failure the cooldown is released and the secret cleared, so the caller may retry immediately | `otp.service.ts:158-165`                             |

**[ZAROORAT] One caveat:** a debug line logs the generated code. As audited it reads `logger.debug({ otp: code, … })`; `otp` is in `SENSITIVE_FIELDS` so pino redacts it. This line has been rewritten several times during recent sessions — if it ever reverts to a key **not** in `SENSITIVE_FIELDS` (notably `code`, which `redact.ts` deliberately leaves open for domain error codes), every OTP is published in plaintext to every log sink. `src/shared/logger/redact.ts:11-14` documents that exact assumption.

**Does OTP send work for a new driver? [ZAROORAT] YES** — there is no account-existence precondition; `resolveAccount` creates the user at verify time.

---

## 4. User Creation

| Question                                         | Answer                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Does verify create or identify the correct User? | **VERIFIED** — `findActiveByPhone`, else create; on a unique-violation race, re-read the winner (`auth.service.ts:398-416`) |
| Status on creation                               | `ACTIVE`, `isPhoneVerified: true`                                                                                           |
| Existing DEACTIVATED account                     | **Refused** — `AccountDeactivatedError`; no silent reactivation (`assertAuthenticatable`, `auth.service.ts:418-422`)        |
| Existing SUSPENDED / deleted                     | **Refused** — `AccountSuspendedError`                                                                                       |
| Profile                                          | Auto-created via `userProfileRepository.ensureExists`, emitting `user.profile.created`                                      |
| Concurrent registration                          | **SAFE** — DB unique constraint + P2002 recovery path                                                                       |

---

## 5. Driver Creation

| Question                                  | Answer                                                                                                                                                                                                                 | Evidence                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Created automatically after registration? | **NO** — created lazily on the first `GET /drivers/me`                                                                                                                                                                 | `driver-onboarding.controller.ts:19` |
| `Driver.userId` unique?                   | **YES** — `@unique`                                                                                                                                                                                                    | `driver.prisma:5`                    |
| Duplicate prevention                      | **PARTIAL** — `createOrGetDriver` is read-then-create with no P2002 catch. Two simultaneous `GET /drivers/me` both miss, both insert; the loser gets a unique violation surfaced as a 500 rather than the existing row | `onboarding.service.ts:26-43`        |
| Initial state                             | `verificationStatus: PENDING`, `isAvailable: false`, `isSuspended: false`                                                                                                                                              | `driver.repository.ts:22-27`         |
| Who may create one?                       | **Anyone authenticated** — no role check on the route                                                                                                                                                                  | `driver.routes.ts:12`                |
| Event                                     | `driver.onboarded` to the outbox, in the same transaction                                                                                                                                                              | `onboarding.service.ts:33`           |

**What happens if OTP is valid but no driver profile exists? [ZAROORAT]** Login succeeds and returns tokens; the driver record simply does not exist until the app calls `GET /drivers/me`, which creates it. No error, no special state. The Driver App must call that endpoint to begin onboarding.

---

## 6. Role Assignment — the central finding

### **[ZAROORAT] The `driver` role is never granted in production.**

| Fact                                                                                       | Evidence                                                                                       |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `driver` role **is** seeded                                                                | `prisma/seed/shared/roles.ts` — `{ slug: 'driver', name: 'Driver' }`                           |
| The only role granted at login is `DEFAULT_ROLE_SLUG`                                      | `ensureDefaultRole`, `auth.service.ts:424-429`                                                 |
| `DEFAULT_ROLE_SLUG` = `'customer'`                                                         | `auth.constants.ts:3` (`process.env.DEFAULT_USER_ROLE ?? 'customer'`)                          |
| `AuthService.grantRole` exists, is transactional, idempotent, audited, and bumps the epoch | `auth.service.ts:266-303`                                                                      |
| **`grantRole` has zero production callers**                                                | `grep -rn "grantRole" src/` returns only its own definition; every other hit is under `tests/` |
| No HTTP route grants a role                                                                | Full 31-route inventory contains no role-management endpoint                                   |

**[INFERENCE]** The role machinery is complete and well tested (`auth-roles.test.ts`, 14 tests including a concurrency case). What is missing is any way to _invoke_ it — no admin endpoint, no self-service upgrade, no seeding path for real drivers. A production driver logs in and receives `roles: ['customer']`.

### Where the `driver` role is actually consumed

**[ZAROORAT]** Exactly two places, both behavioural branches in Rides:

| Location                                                 | Behaviour when the role is absent                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ride-query.controller.ts:16` — `GET /rides/active`      | Falls through to the **customer** branch. A driver asking for their active ride gets their _passenger_ ride (usually `null`). **A driver can never see the ride they are assigned to.**                             |
| `ride-state.controller.ts:74` — `POST /rides/:id/cancel` | Falls through to the **customer** branch → `cancelRide(id, 'CUSTOMER', callerId)` → `lockAndValidate` compares `ride.customerId` to the caller → `RideCustomerMismatchError`. **A driver can never cancel a ride.** |

**[ZAROORAT] `requireOperableDriver` does NOT check the role.** It is a database query on the `drivers` table (`driver-access.repository.ts:8-14`): `verificationStatus = 'VERIFIED' AND isSuspended = false AND deletedAt IS NULL`. So `/rides/accept|arrive|start|complete` and `/drivers/status/online` work **without** the `driver` role, while the two branches above silently misbehave.

**[INFERENCE]** This is an inconsistency, not a security hole: the operability gate is the stricter of the two, so nothing is _over_-permitted. The effect is a driver who can accept and complete a ride but cannot list it or cancel it.

---

## 7. Existing Onboarding

**[ZAROORAT]** Against the intended client flow:

| Step                           | Status                                                                                                                                                             | Evidence                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Enter phone number             | **IMPLEMENTED**                                                                                                                                                    | `POST /auth/otp/send`                                       |
| Send OTP                       | **IMPLEMENTED**                                                                                                                                                    | §3                                                          |
| Verify OTP                     | **IMPLEMENTED**                                                                                                                                                    | §3                                                          |
| Create/continue DRIVER account | **PARTIALLY IMPLEMENTED** — a `Driver` row is created, but no `driver` role is ever granted                                                                        | §5, §6                                                      |
| Driver profile                 | **IMPLEMENTED**                                                                                                                                                    | `PATCH /drivers/:driverId/profile` → `DriverProfile` upsert |
| Documents                      | **PARTIALLY IMPLEMENTED** — submission works; accepts an arbitrary `fileUrl` string, bypassing the Files module                                                    | `driver.schemas.ts`, `onboarding.service.ts:52-77`          |
| Vehicle                        | **MISSING** — `src/modules/vehicles/index.ts` is `export {};`; no production code touches any vehicle table                                                        | —                                                           |
| Submit for approval            | **MISSING** — no endpoint. Submitting a document implicitly moves `PENDING → DOCUMENT_REVIEW`                                                                      | `onboarding.service.ts:65-73`                               |
| Pending approval               | **PARTIALLY IMPLEMENTED** — `DOCUMENT_REVIEW` exists as a status; nothing surfaces a queue to operators                                                            | —                                                           |
| Approved                       | **PARTIALLY IMPLEMENTED** — `POST /drivers/:id/verify` (admin) sets the **driver** `VERIFIED`, but checks **no documents**. No path sets a **document** `VERIFIED` | §6 of the Phase 1 audit                                     |
| Eligible                       | **MISSING** — `setOnline` demands a `VERIFIED` `DRIVING_LICENSE`, which no code can produce                                                                        | `status.service.ts:46-52`                                   |
| Go ONLINE                      | **MISSING (blocked)**                                                                                                                                              | —                                                           |

### Onboarding state

**[ZAROORAT]** There is **no onboarding-state field**. Progress is inferred entirely from `Driver.verificationStatus` (`PENDING → DOCUMENT_REVIEW → VERIFIED|REJECTED`). No step tracker, no per-step completion flags, no "required documents outstanding" projection.

| Question                              | Answer                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Are profile/document steps persisted? | **YES** — `driver_profiles` and `driver_documents` rows                                         |
| Can the driver resume after logout?   | **YES** — all state is in PostgreSQL; a fresh login plus `GET /drivers/me` restores it          |
| App closed mid-onboarding?            | **SAFE** — every step is an independent committed transaction; nothing is held in session state |
| Duplicate registration attempts?      | **SAFE at login** (phone unique + P2002 recovery). **Racy at driver creation** — see §5         |
| Concurrent registration requests?     | **SAFE for User**; **unhandled unique violation for Driver** under exact concurrency            |

---

## 8. Security

| Check                                             | Result                                                                                                                                                                                                    | Evidence                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Phone ownership                                   | **PASS** — possession proven by OTP before any account is created                                                                                                                                         |
| **Can the client submit `role=DRIVER`?**          | **NO** — `sendOtpSchema` accepts `{ phoneNumber, device }`; `verifyOtpSchema` accepts `{ phoneNumber, code, challengeId?, device }`. No role field exists anywhere in the auth request surface            | `auth.schemas.ts:22-32`   |
| Privilege escalation via body                     | **PASS** — roles are read from the database (`findActiveRoleSlugs`), never from input                                                                                                                     | `auth.service.ts:133`     |
| Driver → admin escalation                         | **PASS** — no role-management route exists at all; `admin`/`support`/`finance` are documented as provisioned out-of-band                                                                                  | `roles.ts`                |
| **Can a customer register themselves as DRIVER?** | **They can create a `Driver` row** by calling `GET /drivers/me` — no role check. They **cannot** obtain the `driver` role, and cannot pass `requireOperableDriver` without admin verification             | `driver.routes.ts:12`     |
| Customer → driver conversion                      | **NOT AN EXPLICIT FLOW** — implicit and undocumented; there is no controlled upgrade step                                                                                                                 |
| **Can an unapproved driver log in?**              | **YES** — correctly. Login is account-level; driver approval is separate                                                                                                                                  |
| **Can an unapproved driver go ONLINE?**           | **NO** — refused by both gates. (Also: _no_ driver can, approved or not — §7)                                                                                                                             |
| **Can an unapproved driver receive rides?**       | **NO** — `requireOperableDriver` guards all four ride-state routes                                                                                                                                        |
| BOLA / IDOR                                       | **PASS** — `actingDriverId` derives from the JWT and **ignores the `:driverId` path parameter entirely**; `authorizedDriverId` permits self or `admin`/`support`. Covered by `authorization-bola.test.ts` | `driver-identity.ts:6-28` |
| Duplicate accounts                                | **PASS at User level**; unhandled race at Driver level (§5)                                                                                                                                               |
| OTP replay                                        | **PASS** — atomic consume-and-delete                                                                                                                                                                      |
| Concurrent registration                           | **PASS for User**; **P2** for Driver                                                                                                                                                                      |
| Session cap                                       | **VERIFIED** — enforced per role class after login                                                                                                                                                        | `auth.service.ts:205-208` |

**[INFERENCE]** The registration surface is genuinely well defended. The notable weakness is not escalation but the reverse: the role that _should_ be granted never is, so authorization decisions in Rides silently take the wrong branch.

---

## 9. Test Coverage

### Existing **[ZAROORAT]**

| Area                | File                                                                           | Coverage                                                                                |
| ------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Phone auth / login  | `auth-login.test.ts`                                                           | account creation, role grant, session, events                                           |
| OTP hardening       | `auth-security.test.ts`, `otp-*` unit tests                                    | replay, lockout, binding, format                                                        |
| Enumeration         | `auth-enumeration.test.ts`                                                     | identical responses for known/unknown phones                                            |
| Token / refresh     | `auth-tokens.test.ts`, `refresh-rotation-atomic.test.ts`                       | rotation, reuse detection                                                               |
| **Role assignment** | `auth-roles.test.ts` — 14 tests                                                | grant, revoke, idempotence, expiry, re-grant, **concurrent grants**, epoch invalidation |
| Driver gate         | `auth-driver-gate.test.ts` — 5 tests                                           | verified / unverified / suspended / non-driver                                          |
| Authorization       | `authorization-bola.test.ts` — 15 driver-related                               | ownership, self-service, admin separation                                               |
| Sessions / devices  | `auth-devices.test.ts`, `auth-session-cap.test.ts`, `auth-concurrency.test.ts` | —                                                                                       |

### Missing **[ZAROORAT]**

- **No test for driver registration as a flow** — nothing exercises `GET /drivers/me` creating a `Driver`.
- **No test asserting a real driver ends up with the `driver` role** — every test that needs it calls `grantRole` directly, which is precisely what conceals the absent production path.
- **No test for `Driver.userId` uniqueness under concurrency** — the read-then-create race is untested.
- **No onboarding-resumption test** (logout → login → state intact).
- **No test for phone change mid-onboarding.**
- **No test for the two role-branching behaviours** in `GET /rides/active` and `POST /rides/:id/cancel` when the caller lacks the `driver` role.
- **No test that document submission moves `PENDING → DOCUMENT_REVIEW`.**

---

## 10. Missing Functionality

1. **Any way to grant the `driver` role in production** — the mechanism exists and has no caller.
2. **An explicit customer → driver upgrade flow** — today it is an implicit side effect of a GET.
3. **A "submit for approval" action** — status advances as a side effect of uploading a document.
4. **Document approval** — no path can set a document `VERIFIED` (Phase 1 finding, unchanged).
5. **Vehicle registration** — module is a stub.
6. **Onboarding state model** — no step tracking or outstanding-requirements projection for the app to render.
7. **Operator queue** — nothing lists drivers awaiting review.

---

## 11. P0 Findings

| #        | Finding                                                                                                                                                                       | Evidence                                                     | Why P0                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| **P0-1** | **The `driver` role is never granted in production.** `grantRole` has zero non-test callers; login grants only `customer`.                                                    | `auth.service.ts:266-303`, `:424-429`; `auth.constants.ts:3` | Every role-dependent behaviour takes the wrong branch      |
| **P0-2** | **A driver can never see their assigned ride.** `GET /rides/active` branches on `callerHasRole(req,'driver')`, which is always false, returning the caller's _customer_ ride. | `ride-query.controller.ts:16`                                | The Driver App cannot restore an active trip after restart |
| **P0-3** | **A driver can never cancel a ride.** `POST /rides/:id/cancel` falls into the customer branch and fails `RideCustomerMismatchError`.                                          | `ride-state.controller.ts:74`; `lifecycle.service.ts:98-100` | Driver-side cancellation is impossible                     |
| **P0-4** | **Document approval does not exist**, so no driver reaches eligibility or ONLINE.                                                                                             | Phase 1 audit §3                                             | Carried forward; still blocks the chain                    |

## 12. P1 Findings

| #    | Finding                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 | No explicit customer → driver upgrade; a `Driver` row is created by an unguarded `GET /drivers/me` with no role check, no consent step, no audit beyond `driver.onboarded` |
| P1-2 | `requireOperableDriver` ignores the `driver` role entirely, so the role gate and the operability gate disagree about who is a driver                                       |
| P1-3 | No "submit for approval" endpoint; `DOCUMENT_REVIEW` is reached as a side effect of an upload                                                                              |
| P1-4 | Driver documents accept an arbitrary `fileUrl`, bypassing the Files module (ownership, MIME, scan, key validation all skipped)                                             |
| P1-5 | Admin verification (`POST /drivers/:id/verify`) checks no documents — a driver can be `VERIFIED` with none submitted                                                       |
| P1-6 | No onboarding state model — the app cannot render progress or outstanding requirements without deriving it client-side                                                     |
| P1-7 | The OTP debug log line is one field name away from publishing plaintext codes; `redact.ts` leaves `code` deliberately unredacted                                           |

## 13. P2 Findings

| #    | Finding                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | `createOrGetDriver` is read-then-create with no P2002 recovery — concurrent first calls surface a 500 instead of the existing row |
| P2-2 | Driver record auto-provisions on a `GET`, so `drivers` accumulates `PENDING` rows for any curious customer                        |
| P2-3 | No operator queue listing drivers awaiting review                                                                                 |
| P2-4 | `DriverView` exposes no onboarding progress — only `verificationStatus`                                                           |
| P2-5 | No test proves a production driver ever holds the `driver` role                                                                   |
| P2-6 | `DEFAULT_USER_ROLE` is env-configurable; setting it to `driver` would grant every registrant the driver role platform-wide        |

---

## 14. Recommended Implementation Order

Dependency-ordered. Steps 1–2 are small and unblock correctness that is currently silently wrong.

**STEP 1 — Grant the `driver` role.** Add a controlled customer → driver upgrade that calls the existing `AuthService.grantRole(userId, 'driver')`. It is already transactional, idempotent, audited, and bumps the security epoch so the stale roles claim is retired. Decide deliberately whether the grant happens at driver-record creation, at approval, or on an explicit "become a driver" action — approval is the safest default.
_Fixes P0-1, P0-2, P0-3 together._

**STEP 2 — Make the customer → driver upgrade explicit.** Replace creation-by-`GET` with a `POST` that records intent, then have `GET /drivers/me` read only. Keeps the audit trail honest and stops accidental driver rows.

**STEP 3 — Reconcile the two gates.** Have `requireOperableDriver` also require the `driver` role, so role and operability agree on who is a driver.

**STEP 4 — Document approval + submit-for-approval** (Phase 1 Step 1). Unblocks eligibility and ONLINE.

**STEP 5 — Documents through the Files module.** Closes the reviewer-facing SSRF/phishing surface before operators start opening these links.

**STEP 6 — Onboarding state model.** A derived projection (steps complete, documents outstanding, current stage) so the Driver App can render progress without guessing.

**STEP 7 — Tests.** Driver registration as a flow; a real driver holding the `driver` role; the two role-branch behaviours; `Driver.userId` concurrency; onboarding resumption; phone change mid-onboarding.

**Not in this phase:** vehicle, dispatch, matching, realtime, push.

---

## 15. Verdict

Phone-based authentication is production-grade and shared correctly between customers and drivers. Account creation, phone ownership, OTP handling, session issuance and BOLA protection are all sound and well tested.

The registration chain then fails at a single, narrow point: **the `driver` role is never granted.** The mechanism to grant it is written, tested and audited — it simply has no caller. That one gap silently breaks two ride behaviours (`/rides/active` and driver cancellation) in ways no current test would catch, because every test grants the role directly.

Onboarding beyond that is **partially implemented**: profile and document submission persist and resume correctly; vehicle, approval, and eligibility do not exist.
