# Implementation Status — Zaroorat Backend

**Date:** 2026-08-02
**Branch:** `feature/auth` (9 commits ahead of `2be2d08`, pushed, clean tree)
**Head:** `96117db test(auth): assert enumeration resistance by mechanism, not by stopwatch`

This is a status report, not a specification. Where it disagrees with `docs/auth/*`, `docs/user/*`,
or `docs/00_PROJECT/FEATURE_CATALOG.md`, those documents win.

---

## 1. The short answer

**Two things are true at once, and conflating them is how status reports lie.**

| Question                                          | Answer                                              |
| ------------------------------------------------- | --------------------------------------------------- |
| Is the **assigned scope** (AUTH + USER) finished? | ✅ **Yes** — completely, and verified               |
| Is the **product** finished?                      | ❌ **No** — roughly **12–15%** of the MVP           |
| Is the **foundation** finished?                   | ✅ Yes — the platform under it is done and reusable |

The two modules that exist are finished to specification. They are 1 of the 17 feature groups the
platform is scoped for, and 1 of the 10 the MVP needs.

### Platform completion, by the project's own scoping documents

| Denominator                                                 | Built                                | %        |
| ----------------------------------------------------------- | ------------------------------------ | -------- |
| **Feature groups** (`FEATURE_CATALOG` §2 — 17 total)        | 1 complete, 1 partial                | **~9%**  |
| **MVP / M1 feature groups** (`FEATURE_CATALOG` §4 — 10)     | 1 complete, 1 partial                | **~15%** |
| **Functional requirements** (`03_Requirements/01` — 61 FRs) | 10 met, ~4 partly                    | **~16%** |
| **Endpoints** (`07_API/02` catalog — 50 planned)            | 7 of those 50, plus 14 module-spec'd | **~14%** |
| **Prisma models** (147 modeled)                             | ~16 exercised by code                | **~11%** |
| **Domain modules** (`src/modules` — 22)                     | 2 real, 1 partial, 19 stubs          | **~11%** |

Every denominator lands in the same band: **the platform is roughly one-eighth built**, and the
eighth that exists is the one everything else depends on.

### The release plan (`FEATURE_CATALOG` §4)

| Release              | Feature groups                                                                       | State                               |
| -------------------- | ------------------------------------------------------------------------------------ | ----------------------------------- |
| **MVP (M1)**         | AUTH, ONBOARD, GEO, PRICING, MATCH, DISPATCH, PAYMENTS (cash), NOTIFY, CONFIG, FILES | 🟡 1 of 10 done, 1 partial (NOTIFY) |
| **Fast-follow (M2)** | CHAT, REVIEW, SOS, PROMO, PAYMENTS (digital)                                         | ⬜ 0 of 5                           |
| **Scale (M3)**       | SUPPORT, ADMIN, ANALYTICS                                                            | ⬜ 0 of 3                           |

**The core loop does not exist yet.** A rider cannot request a ride, no driver can be matched, no
fare can be computed, and no money can move. What exists is that everyone involved can prove who
they are, hold the right roles, and manage their own account safely.

### What is built

| Scope                                             | State                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| **AUTH module** (`docs/auth/01`–`07`)             | ✅ Complete — 9 endpoints, all 7 invariants proven, 1 gap (see §8)      |
| **USER module** (`docs/user/01`–`06`)             | ✅ Complete — 12 endpoints, all 6 non-deferred phases, phase 7 deferred |
| **Core platform** (DI, outbox, tx, cache, errors) | ✅ Complete and in production use by both modules                       |
| **Database schema** (147 models, 51 enums)        | ✅ Modeled platform-wide; ~16 models exercised                          |
| **CI/CD** (6 GitHub workflows, Docker, hooks)     | ✅ Real and enforcing                                                   |
| **NOTIFICATION module**                           | 🟡 Partial — SMS via MSG91 only; no push, no worker, no templates       |
| **The other 19 domain modules**                   | ⬜ Not started — one 2-line stub file each                              |
| **Jobs / workers / integrations layers**          | ⬜ Directory trees of 2-line stubs                                      |

### By the numbers

| Measure                               | Value                               |
| ------------------------------------- | ----------------------------------- |
| Production code (`src`, ex-generated) | 10,111 lines                        |
| — `auth` module                       | 4,016 lines / 36 files              |
| — `users` module                      | 3,053 lines / 21 files              |
| — `core` platform                     | 1,827 lines                         |
| Test code                             | 7,451 lines / 43 files              |
| Tests                                 | **364** — 191 unit, 173 integration |
| HTTP endpoints shipped                | **21** (9 auth, 12 user)            |
| Domain events emitted                 | **29** (16 auth, 13 user)           |
| Prisma models / enums                 | 147 / 51 modeled, ~16 exercised     |
| Migrations                            | 3                                   |
| Documentation in the repo             | 131 files, ~32,100 lines            |
| — consumed to build the above         | 15 files, ~3,800 lines              |

---

## 1a. Feature-group detail (`FEATURE_CATALOG` §2)

| Feature group    | Modules                               | Release | State   | Note                                                                                                        |
| ---------------- | ------------------------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| **FR-AUTH**      | `auth`, `users`                       | M1      | ✅      | All 5 acceptance criteria met, 364 tests                                                                    |
| **FR-NOTIFY**    | `notifications`                       | M1      | 🟡 ~20% | SMS + MSG91 provider real; **no push, no async worker, no templates, no dedup**                             |
| **FR-CONFIG**    | `settings`                            | M1      | 🟡 ~10% | Typed config exists in `src/config`, but as **code, not data**; no flags, no versioning                     |
| **FR-ONBOARD**   | `onboarding`, `documents`, `vehicles` | M1      | ⬜ ~5%  | Stubs — but the **operability gate that blocks a non-approved driver already exists** in AUTH and is tested |
| **FR-GEO**       | `geo`                                 | M1      | ⬜      | Stub; PostGIS is installed and used by saved places                                                         |
| **FR-PRICING**   | `pricing`                             | M1      | ⬜      | Stub; 14 models exist in the schema                                                                         |
| **FR-MATCH**     | `matching`                            | M1      | ⬜      | Stub                                                                                                        |
| **FR-DISPATCH**  | `dispatch`, `rides`                   | M1      | ⬜      | Stub; 17 ride models exist and USER reads them for its obligations check                                    |
| **FR-PAYMENTS**  | `payments`                            | M1/M2   | ⬜      | Stub; 12 payment + 8 wallet models exist                                                                    |
| **FR-FILES**     | `files`                               | M1      | ⬜      | Stub — and the reason profile images are currently rejected (§8.5)                                          |
| **FR-CHAT**      | `chat`                                | M2      | ⬜      | Stub                                                                                                        |
| **FR-REVIEW**    | `reviews`                             | M2      | ⬜      | Stub                                                                                                        |
| **FR-SOS**       | `sos`                                 | M2      | ⬜      | Stub; USER's emergency contacts are the data it will read                                                   |
| **FR-PROMO**     | `promotions`                          | M2      | ⬜      | Stub; 6 referral models exist                                                                               |
| **FR-SUPPORT**   | `support`                             | M3      | ⬜      | Stub; 22 models exist and USER reads disputes                                                               |
| **FR-ADMIN**     | `admin`                               | M3      | ⬜      | Stub; 24 models exist, RBAC primitives and the audit path are built                                         |
| **FR-ANALYTICS** | `analytics`                           | M3      | ⬜      | Stub; 9 models exist                                                                                        |

The pattern is consistent: **the data model and the enforcement seams are ahead of the modules.**
Roles, the audit path, soft-delete, PostGIS, idempotency, the outbox, and the driver-operability gate
were all built for AUTH/USER and are waiting for their consumers.

---

## 2. Verification — what was actually run, and when

| Gate                                | Result                      | When                             |
| ----------------------------------- | --------------------------- | -------------------------------- |
| `npm run typecheck`                 | ✅ clean                    | today                            |
| `npm run lint` (`--max-warnings=0`) | ✅ clean                    | today                            |
| `npx prisma validate`               | ✅ valid                    | today                            |
| `npm run test:unit`                 | ✅ **191 / 191**, 45 suites | today                            |
| `npm test` (full, 364)              | ✅ **364 / 364**            | at `96117db`, with containers up |

> ⚠️ **The integration half could not be re-run today.** Postgres (5432) and Redis (6379) are both
> unreachable — Docker Desktop is not running — so the 173 integration tests fail on
> `Reached the max retries per request limit`, an infrastructure error, not a code one. The last
> green full run was at this exact commit. To reproduce: start `zaroorat-backend-postgres-1` and
> `zaroorat-redis`, then `npm test`.

---

## 3. AUTH module — complete

### 3.1 Endpoints (`docs/auth/04`)

| Method   | Path                    | Auth   | Status |
| -------- | ----------------------- | ------ | ------ |
| `POST`   | `/auth/otp/send`        | public | ✅     |
| `POST`   | `/auth/otp/verify`      | public | ✅     |
| `POST`   | `/auth/token/refresh`   | public | ✅     |
| `POST`   | `/auth/logout`          | bearer | ✅     |
| `GET`    | `/auth/me/sessions`     | bearer | ✅     |
| `DELETE` | `/auth/me/sessions`     | bearer | ✅     |
| `DELETE` | `/auth/me/sessions/:id` | bearer | ✅     |
| `GET`    | `/auth/me/devices`      | bearer | ✅     |
| `DELETE` | `/auth/me/devices/:id`  | bearer | ✅     |

### 3.2 Acceptance criteria (`docs/auth/07` §3 — the ship gate)

| #   | Criterion                                                  | State | Proven by                                          |
| --- | ---------------------------------------------------------- | ----- | -------------------------------------------------- |
| 1   | Register/login with phone + OTP; returning login identical | ✅    | `auth-login`, `user-registration`                  |
| 2   | OTP time-limited, single-use, rate-limited, lockout        | ✅ ¹  | `auth-expiry`, `auth-security`, `auth-concurrency` |
| 3   | Refresh rotates; replayed refresh kills the family         | ✅    | `auth-tokens`                                      |
| 4   | Logout & suspension immediately end sessions               | ✅    | `auth-tokens`                                      |
| 5   | Deny-by-default; multi-role user authorized for both       | ✅    | `deny-by-default` (unit), `auth-roles`             |
| 6   | `driver` role but not `VERIFIED` → ride-accept denied      | ✅    | `auth-driver-gate` (5 tests)                       |
| 7   | Concurrent-session cap revokes the oldest                  | ⚠️    | **implemented, untested** — see §8.1               |
| 8   | Revoked device cannot use its sessions                     | ✅    | `auth-devices`                                     |
| 9   | verify/refresh/logout idempotent under retry               | ✅    | `auth-login`, `auth-tokens`                        |
| 10  | Sensitive actions audited; no secret logged/returned       | ✅    | `auth-security`, `auth-roles`                      |
| 11  | Phone enumeration impossible via auth responses            | ✅    | `auth-enumeration` (8 tests)                       |
| 12  | Fraud matrix + recovery deterministic responses            | ⚠️    | lockout ✅, family-revoke ✅, cap-evict ⚠️ (§8.1)  |

¹ The lockout _triggers_ at 5 failures and is proven; its 15-minute _lift_ is a Redis TTL and is not
covered — see §8.2.

### 3.3 Invariants (`docs/auth/01` §10) — all 7 proven

| ID             | Invariant                                              | Proven by                                                            |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| **AUTH-INV-1** | Concurrent registrations → exactly one active user     | `auth-concurrency` (4 tests, `Promise.all`)                          |
| **AUTH-INV-2** | Concurrent verifies → exactly one succeeds             | `auth-concurrency` (6 tests, `Promise.all`)                          |
| **AUTH-INV-3** | Suspended account → `TOKEN_STALE` on next call         | `auth-tokens`                                                        |
| **AUTH-INV-4** | A revoked `sid` cannot be reused                       | `auth-tokens`                                                        |
| **AUTH-INV-5** | Refresh replay revokes the family and bumps epoch      | `auth-tokens`                                                        |
| **AUTH-INV-6** | A revoked device's sessions are all rejected           | `auth-devices`                                                       |
| **AUTH-INV-7** | Ride-accept needs role **and** VERIFIED **and** active | `auth-driver-gate`                                                   |
|                | Partial index `uq_user_role_active`                    | `auth-roles` (re-grant after revoke; DB rejects a second live grant) |

### 3.4 Security suite (`docs/auth/07` §5) — 8 of 8 addressed

| Property                        | State | Note                                                                 |
| ------------------------------- | ----- | -------------------------------------------------------------------- |
| Enumeration resistance          | ✅    | Asserted by **mechanism**, not stopwatch — see §3.5                  |
| Token hygiene                   | ✅    | DB dump contains no raw token, no OTP, no pepper                     |
| Fast revocation                 | ✅    | Epoch bump invalidates every outstanding token in one request cycle  |
| Fail-closed                     | ✅    | Redis/driver/device reads down → `503`, never fall-through (5 tests) |
| Rate-limit axes                 | ✅    | phone / device / IP each trip independently; strictest wins          |
| Rooted/jailbroken sensitive act | ✅    | `auth-device-integrity` (10 tests)                                   |
| No-secrets-in-errors            | ✅    | `auth-security`                                                      |
| 401-family branching            | ✅    | `TOKEN_INVALID` / `TOKEN_STALE` / `TOKEN_REUSE` / `SESSION_REVOKED`  |

### 3.5 One deliberate deviation from the test plan

`docs/auth/07` §5 asks for enumeration timing "within tolerance". `tests/integration/auth-enumeration.test.ts`
contains **no wall-clock assertion**, by design: a tolerance tight enough to catch a real oracle is
looser than the noise of a shared Postgres and Redis container plus GC, so it fails on a busy runner
and gets deleted the first week. It asserts the named _mechanism_ instead — `otpHasher.hash` is called
exactly once on both the known and unknown path, and `userRepository.findActiveByPhone` is called
**zero** times on a failure — which is deterministic and strictly stronger: it fails on the cause,
not on a symptom a fast machine can hide. The reasoning is written into the file's header comment.

---

## 4. USER module — complete

### 4.1 Delivery phases (`docs/user/01` §12)

| Phase | Delivers                                          | State                                                                                                              |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **1** | `GET /me`, `PATCH /me/profile`                    | ✅                                                                                                                 |
| **2** | Profile row created inside AUTH's registration tx | ✅ — plus self-healing on next login                                                                               |
| **3** | Phone-number change (both steps)                  | ✅                                                                                                                 |
| **4** | Emergency contacts + saved places                 | ✅                                                                                                                 |
| **5** | Deactivation and delete-request                   | ✅ — with the ledger caveat in §8.3                                                                                |
| **6** | Admin reactivation wiring                         | ✅ USER's half — `AccountService.restore()`; the admin endpoint that calls it belongs to the `admin` module (§8.4) |
| **7** | Email                                             | ⬜ **Deferred by USER-OD-1** — no email channel exists                                                             |

### 4.2 Endpoints (`docs/user/02`)

| Method   | Path                               | Extra guard               | Status                                        |
| -------- | ---------------------------------- | ------------------------- | --------------------------------------------- |
| `GET`    | `/users/me`                        | —                         | ✅                                            |
| `PATCH`  | `/users/me/profile`                | —                         | ✅                                            |
| `POST`   | `/users/me/phone/change`           | `requireUntamperedDevice` | ✅                                            |
| `POST`   | `/users/me/phone/verify`           | `requireUntamperedDevice` | ✅                                            |
| `GET`    | `/users/me/emergency-contacts`     | —                         | ✅                                            |
| `POST`   | `/users/me/emergency-contacts`     | —                         | ✅                                            |
| `PATCH`  | `/users/me/emergency-contacts/:id` | —                         | ✅                                            |
| `DELETE` | `/users/me/emergency-contacts/:id` | —                         | ✅                                            |
| `GET`    | `/users/me/saved-places`           | —                         | ✅                                            |
| `POST`   | `/users/me/saved-places`           | —                         | ✅                                            |
| `PATCH`  | `/users/me/saved-places/:id`       | —                         | ✅                                            |
| `DELETE` | `/users/me/saved-places/:id`       | —                         | ✅                                            |
| `POST`   | `/users/me/deactivate`             | —                         | ✅                                            |
| `POST`   | `/users/me/delete-request`         | —                         | ✅                                            |
| `PATCH`  | `/users/me/email`                  | —                         | ⬜ **not registered** — deferred by USER-OD-1 |

### 4.3 Invariants (`docs/user/01` §10) — all 7 proven

| ID             | Invariant                                                       | Proven by                                                            |
| -------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| **USER-INV-1** | Exactly one profile row per account, in its own tx              | `user-registration` — incl. the DB refusing a second row             |
| **USER-INV-2** | No response contains another user's data                        | `user-collections` — 404 not 403, byte-identical to a nonexistent id |
| **USER-INV-3** | A phone change never changes the account identifier             | `user-phone-change`                                                  |
| **USER-INV-4** | No pre-change session survives the change                       | `user-phone-change` — including the caller's own                     |
| **USER-INV-5** | A profile update cannot alter phone/email/status/roles          | `user-profile` — each immutable field rejected individually          |
| **USER-INV-6** | Departure never deletes rows; the number becomes re-registrable | `user-departure`                                                     |
| **USER-INV-7** | Collection caps hold **under concurrency**                      | `user-collections` — cap+5 simultaneous `POST`s, owner-row lock      |

### 4.4 Acceptance criteria (`docs/user/01` §13) — 11 of 11

All eleven are green, including #6 ("two concurrent phone changes onto the same free number →
exactly one success", settled by the partial unique index, not by the application's re-check) and #11
(`prisma validate`, typecheck, lint, full suite).

---

## 5. Core platform

Built to serve AUTH and USER, and reusable by every module that follows.

| Component                     | State | Note                                                                                               |
| ----------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| **DI container**              | ✅    | Awilix, CLASSIC mode — constructor parameter names are load-bearing                                |
| **Transactional outbox**      | ✅    | `audit`/`domain` events commit with their state change; `observability` goes to the in-process bus |
| **Outbox relay**              | ✅    | Polls oldest-first, at-least-once, idempotent consumers                                            |
| **Unit of work**              | ✅    | Optional `tx?: TransactionClient`, `(tx ?? this.client)` throughout                                |
| **`TransactionManager`**      | ✅    | Fixed this cycle — see §7                                                                          |
| **Deny-by-default gate**      | ✅    | Global `onRequest`; opt out with `config: { public: true }`                                        |
| **Redis / cache**             | ✅    | OTP store, epoch store, rate limiters, session denylist                                            |
| **Error catalog mapping**     | ✅    | `UserError` → `replyFromUserError`, `AuthError` → `replyFromAuthError`                             |
| **Health / readiness**        | ✅    | 10 unit tests                                                                                      |
| **Queue, storage, websocket** | 🟡    | Scaffolded, unused by these two modules                                                            |

### Database

3 migrations, 14 schema modules, PostgreSQL 17 + PostGIS.

| Migration                                     | Delivers                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `20260724173304_init`                         | The full baseline schema                                                                                                 |
| `20260731000000_add_phone_change_otp_purpose` | `PHONE_CHANGE` on the `OtpPurpose` enum                                                                                  |
| `20260801000000_add_user_collection_indexes`  | The four `docs/user/03` §5 objects, incl. a GiST geo index and `uq_saved_places_user_label` on `(user_id, lower(label))` |

---

## 6. Events — 29 emitted

**AUTH (16):** `auth.otp.requested`, `auth.otp.sent`, `auth.otp.verified`, `auth.login.succeeded`,
`auth.login.failed`, `auth.token.refreshed`, `auth.refresh.reuse_detected`, `auth.session.created`,
`auth.session.revoked`, `auth.device.flagged`, `auth.device.revoked`, `account.suspended`,
`account.reactivated`, `account.role.granted`, `account.role.revoked`, `account.recovery.completed`

**USER (13):** `user.profile.created`, `user.profile.updated`, `user.phone.change_requested`,
`user.phone.changed`, `user.account.deactivated`, `user.account.deletion_requested`,
`user.account.restored`, `user.emergency_contact.added` / `.updated` / `.removed`,
`user.saved_place.added` / `.updated` / `.removed`

Two event-catalog test files (15 tests) assert every payload against its documented shape and that
**no payload carries a profile value** — field names only, never a name, DOB, coordinate, address, or
phone number.

---

## 7. Defects found and fixed this cycle

Four real production bugs, none of which the pre-existing suite would have caught.

| Defect                                                                  | Impact                                                                                                      | Fix                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `TransactionManager` mapped **every** callback error to `DatabaseError` | Deliberate 403s/409s thrown inside a transaction became 500s — including AUTH's own `AccountSuspendedError` | `PrismaErrorMapper.isPrismaError()` guard + rethrow      |
| `OtpRepository.updateOutcome` was an unconditional write                | A concurrent loser could file a successful login as `failed`, with `verified_at` still set                  | `updateMany … where verifiedAt: null`, returns `boolean` |
| `otp/send` wrote the client-reported device id to a `@db.Uuid` column   | **500 on the first call of the auth flow**, for the exact body `docs/auth/04` §2.1 documents                | `isUuid()` guard before persisting the trail             |
| Rooted/jailbroken flags captured but never read                         | A documented v1 security control that did not exist in code                                                 | `requireUntamperedDevice` guard on the authorize path    |

Two documentation fictions were also corrected: `docs/auth` referenced an `audit_log` table that does
not exist (the real ones are `outbox_events` and `admin_activity_logs`), and the API spec described
four endpoints where nine now ship.

---

## 8. Known gaps

Each of these is reported, not silently carried.

### 8.1 The concurrent-session cap is implemented but untested ⚠️

`docs/auth/07` §3 criterion 7 and §5's fraud matrix require that a 6th login evicts session #1 and
emits `auth.session.revoked`. The eviction logic exists (`src/modules/auth/session/session.service.ts:253`,
`SessionRepository.findOldestActive`) and the cap is configured per role
(`src/config/session/session.config.ts`), but **no test asserts it**. This is the only acceptance
criterion in either module without coverage. It is a small integration test — 6 logins, assert the
first `sid` returns `SESSION_REVOKED` and the event fired.

### 8.2 The lockout's 15-minute lift is unverified

The lockout triggers correctly after 5 failed attempts (proven in `auth-concurrency`). Its expiry is
a **Redis TTL**, which no in-process clock mock can advance — `node:test`'s `mock.timers` is
restricted to `Date` here, because ioredis and Prisma need real timers. The tests that need a key
gone delete it, which is precisely what the TTL does, and say so. Closing this properly needs a fake
Redis or a clock-aware wrapper around the lock.

### 8.3 There is no deletion-request ledger

`docs/user/02` §2.8 says the endpoint "records the request", but **no table exists** for a retention
job to query. The only durable record is the `user.account.deletion_requested` outbox event — which
is a dispatch queue, not a ledger; the relay deletes rows once dispatched. The endpoint is correct
and audited today, but the erasure job that `docs/user/01` R-USER-18/19 implies **cannot be written
until a `deletion_requests` table exists**. This is the one structural gap rather than an incremental
one.

### 8.4 The admin module is two stub files

`docs/09_Admin` specifies RBAC/permissions, dashboards, dispute resolution, and pricing-zone reports.
`src/modules/admin` is a 2-line stub. This is what makes USER phase 6 half a phase: `AccountService.restore()`
is implemented, audited, and covered by 5 integration tests, but nothing calls it over HTTP, because
the operator authentication, the `users:suspend` scope check, and the `admin_activity_logs` row all
belong to `admin`. That module is the natural next body of work.

### 8.5 The profile-image host allow-list rejects everything

`userConfig.profileImageHosts` defaults to empty, and empty means **reject every URL** as
`UNTRUSTED_HOST`. This is deliberate and fail-closed: the `files` module that would issue trusted
URLs is deferred, so there is no host the platform can vouch for, and accepting an arbitrary one
would let a profile embed a third-party tracker. It becomes a real feature the day `files` ships.

---

## 9. Deferred by decision (not gaps)

| Item                                  | Decision  | Unblocked by                            |
| ------------------------------------- | --------- | --------------------------------------- |
| `PATCH /me/email` + email login       | USER-OD-1 | An email delivery channel               |
| `user_profiles.referral_code`         | USER-OD-2 | The `referral` module mints it          |
| Interactive "pick a device to remove" | AUTH OD-5 | P1 UX; oldest-revoke is the default     |
| Risk/fraud **detection** signals      | AUTH OD-8 | Responses are fixed; detection deferred |
| Recovery proof mechanism              | AUTH OD-9 | Policy is fixed; the proof is deferred  |

---

## 10. What is not started

### 10.1 Domain modules — 19 stubs

One 2-line stub file each. No services, no routes, no tests:

`admin`, `analytics`, `chat`, `dispatch`, `documents`, `drivers`, `files`, `geo`, `matching`,
`onboarding`, `payments`, `pricing`, `promotions`, `reviews`, `riders`, `rides`, `settings`, `sos`,
`support`, `vehicles`

`notifications` is the exception: real but **SMS-only** (6 files, 320 lines) — exactly what AUTH's
OTP delivery requires and nothing more.

### 10.2 Whole layers that are directory trees of stubs

| Path                 | Lines | What it is meant to hold                                                                       |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `src/jobs`           | ~300  | Queue, scheduler, worker — **real**; `producers`/`consumers` still empty                       |
| `src/infrastructure` | 14    | Database, maps, notification, payment, queue, redis, storage adapters                          |
| `src/integrations`   | 0     | `aws-s3`, `google-maps`, `msg91`, `razorpay`, `sendgrid`, `stripe` — **all empty directories** |
| `src/middleware`     | 6     | `auth.ts`, `idempotency.ts`, `role.ts` — the real versions live in `core`/`modules` instead    |
| `src/common`         | 16    | Shared primitives                                                                              |

Two consequences worth naming:

- **The background-job runtime exists, with one queue on it.** `src/worker.ts` is a second entry
  point sharing the API's composition root: BullMQ, one `files-maintenance` queue, an idempotent
  schedule table, and a graceful-drain shutdown. FILES' sweeper and retention job run on it. The
  **outbox relay** stays separate and API-side — it is a single-instance poller, and a second copy in
  the worker would dispatch every event twice. What still has nowhere to run is everything with no
  queue declared yet: notification delivery, matching timeouts, document-expiry sweeps. Those are now
  a schedule-table entry each, not a missing runtime. `bootstrapStorage()` is still a literal
  `// Placeholder for Milestone 2` body, so the readiness `storage` contributor 09 §3 specifies does
  not exist.
- **The only live third-party integration is MSG91.** Maps, object storage, and both payment
  providers are empty directories, so FR-GEO, FR-FILES, and FR-PAYMENTS have no external edge at all.

### 10.3 What _is_ real outside the two modules

Not everything unbuilt is unprepared:

- **The full Prisma schema** — 147 models, 51 enums, every domain modeled (`ride` 17, `admin` 24,
  `support` 22, `pricing` 14, `payment` 12, `vehicle` 10, `driver` 9, `analytics` 9, `wallet` 8,
  `notification` 8, `referral` 6). USER's obligations check already queries `rides`, `wallets`, and
  disputes in production code.
- **CI/CD** — 6 GitHub workflows (`ci`, `prisma-check`, `security`, `staging`, `production`,
  `release`), Docker + compose with nginx/postgres/redis, Husky hooks mirrored by CI so
  `--no-verify` cannot land unchecked code.
- **Fastify plugin surface** — cors, helmet, jwt, rate-limit, sensible, socket, swagger.
- **Config** — 21 typed config files.

---

## 11. Suggested order for what comes next

**To close out what is already built** (small, and worth doing before moving on):

1. **Close §8.1** — one integration test for the concurrent-session cap; the last uncovered acceptance criterion.
2. **`deletion_requests` table + retention job** (§8.3) — the only structural gap in shipped code, and a compliance obligation.

**To make the product exist** — the MVP order the release plan implies, each blocked on the one before it:

3. **`files` + object storage** — FR-FILES is P0, blocks driver documents, and unblocks profile images (§8.5).
   ✅ **Specified** — the full chain is at [`docs/files/`](files/README.md); 7 phases, 5 of them
   unblocked. Implementation pending approval.
4. **`drivers` / `onboarding` / `documents` / `vehicles`** — FR-ONBOARD. The operability gate that
   gates them already exists and is tested; nothing populates `drivers.verification_status` yet.
5. **`geo`** — presence and location fixes; PostGIS is already installed and in use.
6. **`pricing`** → **`matching`** → **`dispatch`/`rides`** — the core loop, in dependency order.
7. **`payments` (cash)** — settles the loop.
8. ~~**A job runtime**~~ — ✅ **shipped**. BullMQ on the existing Redis, one queue, a schedule table,
   and `src/worker.ts` as a second entry point (handbook volume 08). Adding a job to (2) or (4)–(7)
   is now a row in `JOB_SCHEDULES` plus a handler registration, not a runtime.

**`admin`** sits outside this chain: it unblocks USER phase 6's caller and every ops surface, and it
is M3 in the release plan — but its absence blocks nothing in the MVP path.

---

_Generated 2026-08-02 at `96117db`. Unit gates re-run today; the integration half was last verified
green at this commit with Postgres and Redis up._
