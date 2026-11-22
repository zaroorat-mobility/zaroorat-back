# Zaroorat Mobility

# Role Source & Auth Flow Audit

**Date:** 2026-08-16 · **Branch:** `feature/auth` · **Committed base:** `290b3c6`
**Question:** when a customer logs in via OTP, where does their role actually come from?
**Answer:** **the backend database, exclusively.** The frontend cannot influence it, and I proved that empirically rather than by inspection alone.

**Nothing was modified.** No code, schema, migrations, or tests changed.

---

## 1. Request Contract

### Backend — the authoritative schema

**[ZAROORAT]** `src/modules/auth/schemas/auth.schemas.ts`:

```ts
export const sendOtpSchema = z.object({
  phoneNumber, // E.164 regex
  device: deviceSchema, // optional
});

export const verifyOtpSchema = z.object({
  phoneNumber,
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  challengeId: z.string().min(1).optional(),
  device: deviceSchema,
});
```

`deviceSchema` = `{ deviceId?, platform? ('IOS'|'ANDROID'|'WEB'), appVersion?, osVersion?, fingerprint?, isRooted?, isJailbroken?, fcmToken? }`.

### Frontend — what the client actually sends

**[ZAROORAT]** `ride-demo-frontend/src/auth/api/auth.types.ts`:

```ts
export interface SendOtpRequest {
  phoneNumber: string;
  device?: DeviceContext;
}
export interface VerifyOtpRequest {
  phoneNumber: string;
  code: string;
  challengeId?: string;
  device?: DeviceContext;
}
```

### Answers

| Question                                           | Answer                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does the frontend send `role`?                     | **NO**                                                                                                                                                                   |
| Does the frontend send an application type?        | **NO**                                                                                                                                                                   |
| Does it send customer/driver?                      | **NO**                                                                                                                                                                   |
| Does it send any user type?                        | **NO**                                                                                                                                                                   |
| Does it send anything that can influence the role? | **NO.** The only discriminator transmitted is `device.platform` (`IOS`/`ANDROID`/`WEB`), which is stored on the device record and never consulted during role resolution |

**[ZAROORAT]** Every `role` occurrence in the frontend source is either an HTML ARIA attribute (`role="alert"`, `role="img"`) or read-only display of roles the backend returned. `ride-demo-frontend/src/user/components/UserRoles.tsx:1` states it explicitly: _"Role slugs exactly as the backend returns them. Read-only: roles are granted…"_. `RequireAuth.tsx:6` adds: _"Authentication only — no role checks."_

---

## 2. OTP Verify Path

**[ZAROORAT]** Every function in the chain:

```
POST /api/v1/auth/otp/verify                        auth.routes.ts:51
  config: { public: true }
  preHandler: app.rateLimit(rateLimits.otpVerify)
  schema.body: verifyOtpBodySchema                   auth.responses.ts:82
    ↓
AuthController.verifyOtp                             auth.controller.ts:86
  requireIdempotencyKey(request, reply)               ← 400 if absent
  verifyOtpSchema.safeParse(request.body)             ← Zod
  builds the service input from NAMED FIELDS ONLY:
      { phoneNumber, code, device, ip, userAgent, challengeId? }
    ↓
AuthService.verifyOtp(input, idempotencyKey)         auth.service.ts:101
  redisService.idempotency.runOnce(key, TTL, …)
    ↓
AuthService.runVerifyOtp                             auth.service.ts:110
  ├─ OtpService.verify(...)                          otp.service.ts:176
  │    · otpRateLimiter.isLocked
  │    · assertChallengeBelongsToCaller
  │    · otpValidator.isValidFormat + OtpStore.consume (atomic Lua)
  │
  └─ TransactionManager.execute:
       ├─ resolveAccount(phoneNumber, tx)            auth.service.ts:394
       │    └─ ensureDefaultRole(userId, tx)         auth.service.ts:424  ★ ROLE ASSIGNED HERE
       ├─ assertAuthenticatable(user)                auth.service.ts:418
       ├─ userProfileRepository.ensureExists
       ├─ deviceService.register
       ├─ roleRepository.findActiveRoleSlugs(user.id, undefined, tx)   ★ ROLE READ HERE
       ├─ sessionService.createInTransaction
       ├─ userRepository.updateLastLoginAt
       ├─ tokenService.issuePair({ userId, sessionId, roles })  ★ ROLE ENTERS JWT
       └─ outbox: auth.otp.verified, auth.login.succeeded, auth.session.created
     COMMIT
    ↓
sessionService.enforceCap(userId, capForRoles(roles), sessionId)
    ↓
200 { accessToken, accessTokenExpiresInSec, refreshToken, refreshTokenExpiresInSec,
      user: { id, status, roles, isNew } }
```

---

## 3. User Creation

**[ZAROORAT]** `AuthService.resolveAccount` (`auth.service.ts:394-416`):

```ts
const existing = await this.userRepository.findActiveByPhone(phoneNumber, tx);
if (existing) {
  let user = existing;
  if (!user.isPhoneVerified || user.status === 'UNVERIFIED') {
    await this.userRepository.markPhoneVerified(user.id, tx);
    user = await this.userRepository.updateStatus(user.id, 'ACTIVE', tx);
  }
  await this.ensureDefaultRole(user.id, tx); // ← existing-user branch
  return { user, isNew: false };
}

try {
  const created = await this.userRepository.create(
    { phoneNumber, status: 'ACTIVE', isPhoneVerified: true },
    tx,
  );
  await this.ensureDefaultRole(created.id, tx); // ← new-user branch
  return { user: created, isNew: true };
} catch (err) {
  if (!isPhoneAlreadyTakenError(err)) throw err; // P2002 recovery
  const winner = await this.userRepository.findActiveByPhone(phoneNumber, tx);
  if (!winner) throw err;
  await this.ensureDefaultRole(winner.id, tx); // ← race-loser branch
  return { user: winner, isNew: false };
}
```

**The user row itself carries no role column.** `userRepository.create` receives exactly `{ phoneNumber, status: 'ACTIVE', isPhoneVerified: true }` — no role, and nothing derived from the request beyond the phone number.

| Question                     | Answer                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Default role                 | `customer`                                                                                           |
| Role source                  | Server constant, resolved from environment                                                           |
| Constant                     | `DEFAULT_ROLE_SLUG = process.env.DEFAULT_USER_ROLE ?? 'customer'` — `auth.constants.ts:3`            |
| Database value               | A row in `user_roles` (`UserRoleAssignment`) pointing at the `roles` row whose `slug` = `'customer'` |
| Supplied by the request?     | **NO**                                                                                               |
| Hard-coded?                  | **Defaulted**, with an environment override                                                          |
| From configuration?          | **YES** — `DEFAULT_USER_ROLE`                                                                        |
| Assigned by another service? | **NO** — `AuthService` alone                                                                         |

---

## 4. Role Assignment — every production caller

**[ZAROORAT]** Complete inventory. Tests excluded, as instructed.

| Caller                                                      | Input                                            | Role source                  | Authorization                           | Transaction                                                 |
| ----------------------------------------------------------- | ------------------------------------------------ | ---------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| `AuthService.ensureDefaultRole` (`auth.service.ts:424-429`) | `userId` only                                    | `DEFAULT_ROLE_SLUG` constant | None needed — system grant during login | **YES** — inside the login transaction, `tx` passed through |
| `AuthService.grantRole` (`auth.service.ts:266-303`)         | `userId`, `roleSlug`, `{grantedBy?, expiresAt?}` | Caller argument              | **N/A — has no production caller**      | YES — plus outbox `account.role.granted` and an epoch bump  |
| `AuthService.revokeRole` (`auth.service.ts:305-…`)          | `userId`, `roleSlug`                             | Caller argument              | **N/A — has no production caller**      | YES — plus outbox `account.role.revoked`                    |

```
grep -rn "grantRole\|revokeRole" src/   → only the definitions in auth.service.ts
                                          every other hit in the repository is under tests/
```

**[ZAROORAT] `ensureDefaultRole` is the only role-assigning code that runs in production.** It fires on **every** login, in all three branches of `resolveAccount`, and is idempotent (`findActiveAssignment` before `grant`).

**[INFERENCE]** A side effect worth noting: because it runs on every login rather than only at creation, a user whose `customer` role was revoked silently regains it at their next login.

**No HTTP route grants or revokes any role.** The full mounted surface is 31 routes and contains no role-management endpoint. `roles.ts` documents `admin`/`support`/`finance` as _"provisioned out-of-band"_.

---

## 5. JWT / Session

**[ZAROORAT]** The chain, with the exact hand-offs:

```
auth.service.ts:133   const roles = await this.roleRepository.findActiveRoleSlugs(user.id, undefined, tx);
auth.service.ts:149   const pair = await this.tokenService.issuePair({ userId: user.id, sessionId: session.id, roles }, tx);
jwt.service.ts:53     const payload: AccessTokenClaims = { sub, sid, roles: input.roles, epoch, jti, iat, exp, iss };
```

`RoleRepository.findActiveRoleSlugs` (`role.repository.ts:37-51`):

```ts
const assignments = await (tx ?? this.client).userRoleAssignment.findMany({
  where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
  select: { role: { select: { slug: true } } },
});
return assignments.map((a) => a.role.slug);
```

| Consumer                 | How it obtains roles                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Access token             | `roles` claim, signed HS256 with `kid`                                                                                            |
| Refresh / session        | **No roles stored.** `user_sessions` and `refresh_tokens` carry none; roles are re-read on every issuance                         |
| Request context          | `auth.plugin.ts:66` — `request.auth = { userId: claims.sub, sid: claims.sid, roles: claims.roles }` (from the **verified** token) |
| Authorization middleware | `authorize({ roles })` compares against `auth.roles`; `callerHasRole` reads `request.auth.roles`                                  |

**Source of the JWT role claim: the DATABASE.** `user_roles` → `roles.slug`, read inside the login transaction. Never the request body, never a header, never the device.

**[ZAROORAT]** Staleness is handled: `grantRole`/`revokeRole` bump the security epoch, and `auth.plugin.ts:50` rejects any token whose `epoch` no longer matches — so a role change invalidates outstanding tokens rather than waiting for expiry.

---

## 6. Database Role Model

**[ZAROORAT]** `prisma/schema/modules/admin/admin.prisma`:

```
User ──1:*── UserRoleAssignment ──*:1── Role ──1:*── RolePermission ──*:1── Permission
```

| Model                | Table              | Key fields                                                                | Constraints                                                                                                                         |
| -------------------- | ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Role`               | `roles`            | `slug` (canonical id), `name`, `isSystem`                                 | `slug @unique`                                                                                                                      |
| `UserRoleAssignment` | `user_roles`       | `userId`, `roleId`, `grantedBy?`, `grantedAt`, `revokedAt?`, `expiresAt?` | `@@index([userId])`; **partial unique index** (one live assignment per user+role, re-grant allowed after revoke) shipped as raw SQL |
| `Permission`         | `permissions`      | `code`, `resource`, `action`                                              | `code @unique`                                                                                                                      |
| `RolePermission`     | `role_permissions` | `roleId`, `permissionId`, `effect`                                        | `@@unique([roleId, permissionId])`                                                                                                  |

**Design notes proven by the schema:** revocation is a **timestamp, not a row delete**, so history is preserved; `expiresAt` supports scoped/temporary roles; there is **no role column on `User`**.

**Seeded roles** (`prisma/seed/shared/roles.ts`): `customer`, `driver`, `admin`, `support`, `finance`. All five exist in the database. **`driver` is seeded but never assigned.**

**[ZAROORAT]** Permissions are modelled but not enforced: `app.authorize({ roles: [...] })` checks **role slugs**, not permission codes — stated in the seed file's own comment.

---

## 7. Customer App Evidence

**[ZAROORAT]** The repository contains `ride-demo-frontend/` (untracked; a React/Vite customer app).

| Check                                     | Result                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Sends `role`?                             | **NO**                                                                  |
| Sends `userType`?                         | **NO**                                                                  |
| Sends `application` / `appType`?          | **NO**                                                                  |
| Sends `isDriver` / `driver` / `customer`? | **NO**                                                                  |
| Displays roles?                           | **YES, read-only** — `UserRoles.tsx` renders chips from `GET /users/me` |
| Any role in auth requests?                | **NO** — `auth.api.ts` posts the typed body verbatim                    |

`ride-demo-frontend/checks/user.tsx:127` asserts `loadedHtml.includes('customer')` — a display assertion on a backend-supplied value, not an input.

**Does the backend trust anything the frontend sends about identity? No.** The user is identified solely by the phone number that passed OTP possession.

---

## 8. Driver App Evidence

**[ZAROORAT]** No Driver App exists in this repository. The backend exposes **no driver-specific auth route** — the full auth surface is the four endpoints above. A Driver App would necessarily use the same `POST /auth/otp/send` and `POST /auth/otp/verify`.

| Scenario                             | What actually happens                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New phone via Driver App**         | `resolveAccount` creates a `User` (`ACTIVE`, `isPhoneVerified: true`), `ensureDefaultRole` grants **`customer`**. JWT `roles: ['customer']`. **No `Driver` row exists** until the app calls `GET /drivers/me`, which lazily creates one at `verificationStatus: PENDING`. |
| **Existing CUSTOMER via Driver App** | Recognised as the same account — phone is the identity. Logs in normally, `roles: ['customer']`. Calling `GET /drivers/me` creates a `Driver` row with no role check and no consent step.                                                                                 |
| **Existing DRIVER via Driver App**   | Identical. Even a driver who has been admin-verified (`verificationStatus: VERIFIED`) still receives `roles: ['customer']`, because nothing ever grants the `driver` role.                                                                                                |

**[ZAROORAT] Consequences of the missing `driver` role.** It is consumed in exactly two places, both behavioural branches in Rides:

| Location                                                 | Behaviour when the role is absent                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ride-query.controller.ts:16` — `GET /rides/active`      | Falls to the customer branch → returns the caller's _passenger_ ride. A driver can never retrieve the ride they are assigned to.                                               |
| `ride-state.controller.ts:74` — `POST /rides/:id/cancel` | Falls to the customer branch → `cancelRide(id, 'CUSTOMER', callerId)` → `lockAndValidate` compares `ride.customerId` → `RideCustomerMismatchError`. A driver can never cancel. |

**[ZAROORAT]** `requireOperableDriver` does **not** check the role — it queries the `drivers` table (`driver-access.repository.ts:8-14`). So `/rides/accept|arrive|start|complete` work without it, while the two branches above silently misbehave.

---

## 9. Security Analysis — can a client inject a role?

### The test: `POST /auth/otp/verify` with `{"role":"driver"}` or `{"role":"super_admin"}`

**[ZAROORAT] Result: HTTP 200. The field is silently stripped. It has no effect.** Not rejected — _ignored_.

Three independent layers, each sufficient on its own:

**Layer 1 — Fastify route schema: does NOT reject.**
`verifyOtpBodySchema` (`auth.responses.ts:82-96`) declares `type: 'object'` with `properties` and **no `additionalProperties: false`**. JSON Schema defaults to permitting extra keys, so `role` passes this layer untouched.

**Layer 2 — Zod: strips.** Empirically verified against the project's own `zod@4.4.3`:

```
input : { phoneNumber:'+919876543210', code:'123456', role:'driver', roles:['admin'], userType:'DRIVER' }
output: success: true
        parsed data: {"phoneNumber":"+919876543210","code":"123456"}
```

`z.object()` is non-strict, so unknown keys are removed rather than raising. `role`, `roles` and `userType` are all gone before the controller sees them.

**Layer 3 — Controller allow-list.** `auth.controller.ts:97-105` constructs the service input from explicitly named fields (`parsed.data.phoneNumber`, `.code`, `.device`, `.challengeId`). Even a surviving key could not reach `AuthService`.

**Layer 4 — Roles are read, not received.** `findActiveRoleSlugs(user.id)` is a database query. There is no code path anywhere in `src/` that derives a role from request input.

### Escalation matrix

| Attempt                                     | Outcome                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `{"role":"customer"}`                       | Stripped. Customer is granted anyway, by the server.                   |
| `{"role":"driver"}`                         | **Stripped. No effect.**                                               |
| `{"role":"support"}`                        | **Stripped. No effect.**                                               |
| `{"role":"super_admin"}`                    | **Stripped. No effect** — and `super_admin` is not even a seeded slug. |
| `{"roles":["admin"]}`                       | **Stripped. No effect.**                                               |
| Forged JWT with `roles:['admin']`           | **Rejected** — HS256 signature verification fails.                     |
| Replaying a valid token after a role change | **Rejected** — epoch mismatch → `TOKEN_STALE`.                         |

### The one real risk in this area

**[ZAROORAT]** `DEFAULT_ROLE_SLUG = process.env.DEFAULT_USER_ROLE ?? 'customer'`.

Setting `DEFAULT_USER_ROLE=driver` grants the `driver` role to **every registrant, platform-wide**, with no code change and no audit signal. It is a single environment variable between the current state and universal driver access. The value is not validated against the seeded slug set at boot; an unseeded value throws `Role "…" is not seeded` at first login instead — a runtime failure rather than a startup one.

**[INFERENCE]** This is not currently exploitable from outside — it requires deployment access — but it is the only place where a role is chosen by configuration rather than by an authorization decision, and it deserves a boot-time guard.

---

## 10. Final Flow

**[ZAROORAT]** With real file and function names:

```
Customer App  (ride-demo-frontend/src/auth/api/auth.api.ts)
   │  sendOtp({ phoneNumber, device })                    ← no role field exists in the type
   ▼
POST /api/v1/auth/otp/send                                 auth.routes.ts:27
   │  AuthController.sendOtp → AuthService.sendOtp → OtpService.send
   │  OtpStore.claimChallenge (Lua) → OtpGenerator → OtpHasher → Redis
   │  otpRepository.create({ outcome:'queued' }) → otpProducer.enqueue → BullMQ
   ▼  { challengeId, expiresInSec, resendAvailableInSec }

   │  verifyOtp({ phoneNumber, code, challengeId, device }, Idempotency-Key)
   ▼
POST /api/v1/auth/otp/verify                               auth.routes.ts:51
   │  AuthController.verifyOtp
   │    verifyOtpSchema.safeParse  ──► strips any unknown key (role, userType, …)
   │    builds input from named fields only
   ▼
AuthService.verifyOtp → runVerifyOtp                       auth.service.ts:101,110
   │  OtpService.verify — lockout, challenge binding, atomic consume
   │  TRANSACTION
   │    resolveAccount ──► userRepository.create({ phoneNumber, status:'ACTIVE',
   │    │                                          isPhoneVerified:true })
   │    │                  ★ no role column on User
   │    └─ ensureDefaultRole ──► roleRepository.findBySlug(DEFAULT_ROLE_SLUG='customer')
   │                            roleRepository.grant({ userId, roleId })
   │                            ★ CUSTOMER ROLE ASSIGNED — server constant
   │    roleRepository.findActiveRoleSlugs(user.id)  ──► ['customer']   ★ read from DB
   │    tokenService.issuePair({ userId, sessionId, roles })
   │      └─ JwtService.sign → payload.roles = ['customer']             ★ DB → JWT
   │  COMMIT
   ▼
200 { accessToken, refreshToken, user: { id, status, roles:['customer'], isNew } }
   │
   ▼
Every later request: auth.plugin.ts verifies signature + epoch + revocation,
                     sets request.auth.roles from the VERIFIED token claim.
```

---

## 11. Production Decision

| #   | Question                                              | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is CUSTOMER assigned by frontend or backend?          | **BACKEND**, exclusively                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | Where exactly?                                        | `AuthService.ensureDefaultRole` — `src/modules/auth/services/auth.service.ts:424-429`, called from `resolveAccount` (`:394-416`) inside the login transaction                                                                                                                                                                                                                                                                                   |
| 3   | Can the frontend choose CUSTOMER?                     | **NO** — and it does not need to; the server grants it                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | Can the frontend choose DRIVER?                       | **NO** — stripped by Zod, never reaches the service                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | Can the frontend choose SUPPORT?                      | **NO**                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | Can the frontend choose SUPER_ADMIN?                  | **NO** — and no such slug is seeded                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | New Driver App user?                                  | A `User` with `roles: ['customer']`. No `Driver` row until `GET /drivers/me` creates one at `PENDING`                                                                                                                                                                                                                                                                                                                                           |
| 8   | Existing customer entering the Driver App?            | Same account, same `customer` role. `GET /drivers/me` creates a `Driver` row with no role check, no consent, no explicit upgrade                                                                                                                                                                                                                                                                                                                |
| 9   | What must change for production driver onboarding?    | **One thing, then three.** (a) Call the existing `AuthService.grantRole(userId,'driver')` from a controlled upgrade or at approval — it is already transactional, idempotent, audited, and bumps the epoch. Then (b) make the customer→driver upgrade explicit rather than a side effect of a GET, (c) have `requireOperableDriver` also require the `driver` role so the two gates agree, and (d) add a boot-time guard on `DEFAULT_USER_ROLE` |
| 10  | Can the existing OTP implementation remain unchanged? | **YES — leave it alone.** Phone-based OTP is correctly role-agnostic: it proves phone possession and nothing else. Role is an authorization concern resolved after identity. Adding an app-type or role field to the OTP request would be a regression — it would move a trust decision from the database to the client                                                                                                                         |

---

## 12. Exact Production Recommendation

**Do not change OTP. Do not change the auth request contract. Do not add an app-type field.**

The current design is right: one phone-based identity, roles resolved server-side from `user_roles`, JWT claims sourced from the database, epoch invalidation on change. The frontend is correctly ignorant of roles.

The single missing piece is that **`grantRole` has no production caller.** Everything needed to fix it already exists and is tested (`auth-roles.test.ts`, 14 tests including concurrent grants):

1. **Grant `driver` at a deliberate point** — safest at admin approval, so the role and the operability gate become true together. `grantRole` handles idempotence, the audit event and the epoch bump.
2. **Make customer → driver explicit** — replace creation-by-`GET` with a `POST` that records intent; leave `GET /drivers/me` as a read.
3. **Reconcile the gates** — `requireOperableDriver` should also require the `driver` role, so `GET /rides/active` and driver cancellation stop taking the customer branch.
4. **Guard `DEFAULT_USER_ROLE`** — validate at boot that it is a seeded slug and refuse `driver`/`admin`/`support`/`finance` outright.

Items 1 and 3 together fix the two silent Rides misbehaviours; neither is visible in the current test suite because every test calls `grantRole` directly.
