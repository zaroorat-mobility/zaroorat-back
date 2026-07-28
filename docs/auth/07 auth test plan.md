# AUTH — Test Plan

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `auth` (+ `users`) · **Doc:** 07 of the AUTH chain · **Stack:** tsx test runner / Fastify inject / Prisma (ADR-0006)
> **Status:** 🟢 Final (v1) · **Owner:** Engineering (Auth) / QA · **Last updated:** 2026-07-27
> **Answers:** _How do we prove AUTH meets its requirements, invariants, and security properties before it ships?_
> **Traces from:** [01_BR](01%20auth%20business%20requirements.md) §13 · [02_SECURITY](02%20auth%20security%20spec.md) · [03_DB](03%20auth%20database%20spec.md) · [04_API](04%20auth%20api%20spec.md) · [05_ERRORS](05%20auth%20error%20catalog.md) · [06_EVENTS](06%20auth%20event%20catalog.md)

---

## 1. Purpose & scope

This plan defines the tests that make AUTH **provably** correct against the chain: every acceptance
criterion (doc 01 §13), every invariant (doc 01 §10), the security mechanisms (doc 02), the error
contract (doc 05), and the event contract (doc 06). A criterion or invariant is "done" only when a
test named here is green.

Aligns with the platform testing pyramid (Volume 09 / `docs/13_Testing`): **many** fast unit tests, a
solid band of integration tests against a real Postgres + Redis, a **thin** e2e layer, plus dedicated
**security** and **load** suites for the hot path.

---

## 2. Test levels & tooling

| Level           | Runner / harness                                                   | Dependencies                         |
| --------------- | ------------------------------------------------------------------ | ------------------------------------ |
| **Unit**        | `tsx --test` (`tests/unit/**`)                                     | none — pure functions, mocked ports  |
| **Integration** | `tsx --test` (`tests/integration/**`) + Fastify `.inject()`        | ephemeral Postgres + Redis (compose) |
| **E2E**         | HTTP against a booted app in a disposable environment              | full stack                           |
| **Security**    | targeted integration tests + scripted abuse                        | Postgres + Redis                     |
| **Load**        | k6 / autocannon against `/otp/*`, `/token/refresh`, the authz hook | full stack                           |

- **Time is injected**, never `sleep`. TTLs (OTP 5 min, access 15 min, lockout 15 min) are driven by a
  fake clock so expiry paths are deterministic — mirrors the existing readiness-probe timeout test.
- **Isolation:** each integration test runs in a transaction rolled back at teardown, or against a
  freshly migrated schema; Redis uses a per-test key namespace flushed on teardown.
- **Env:** `APP_ENV=test` (see `.env.test`); the testing seed provides the four canonical roles
  (doc 03 §5) so role grants resolve.

---

## 3. Acceptance-criteria matrix (doc 01 §13 — the ship gate)

Every row must be green for v1. IDs map 1:1 to the twelve criteria in doc 01 §13.

| #   | Criterion (abbreviated)                                             | Level(s)          | Key assertions                                                                                                                  |
| --- | ------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Register/login with phone + OTP; returning login identical          | integration, e2e  | first verify creates `users` (status `ACTIVE`) + grants `customer`; second verify opens a session, no dup account               |
| 2   | OTP time-limited, single-use, rate-limited, lockout after threshold | integration, sec  | expired code → `410`; reused code → fail; 6th send/hr/phone → `429`; 5 fails → `OTP_LOCKED` 15 min                              |
| 3   | Refresh rotates; replayed refresh kills the family                  | integration, sec  | rotate returns new pair; old token replay → `TOKEN_REUSE`, all family sessions revoked, epoch bumped                            |
| 4   | Logout & suspension immediately end sessions                        | integration       | post-logout `sid` → `SESSION_REVOKED`; suspend bumps epoch → next request `TOKEN_STALE`                                         |
| 5   | Deny-by-default; multi-role user authorized for both                | unit, integration | unguarded route protected; `{customer,driver}` user passes both role guards                                                     |
| 6   | `driver` role but not `VERIFIED` → ride-accept **denied**           | integration       | role-only driver → `FORBIDDEN`; after `drivers.verification_status=VERIFIED` (not suspended) → allowed _(key regression guard)_ |
| 7   | Concurrent-session cap revokes the oldest                           | integration       | 6th login revokes session #1; its `sid` → `SESSION_REVOKED`; `auth.session.revoked` emitted                                     |
| 8   | Revoked device cannot use its sessions                              | integration       | device `REVOKED` → its sessions all `SESSION_REVOKED`                                                                           |
| 9   | verify/refresh/logout idempotent under retry                        | integration, sec  | same `Idempotency-Key` replays stored result; no double session, no OTP re-consume                                              |
| 10  | Sensitive actions audited; no secret logged/returned                | integration, sec  | suspend/role-change write `audit_log` in-txn; grep responses+logs → no code/token/pepper                                        |
| 11  | Phone enumeration impossible via auth responses                     | security          | send uniform for known/unknown; `OTP_INVALID` merged + constant-time                                                            |
| 12  | Fraud matrix + recovery deterministic responses enforced            | integration, sec  | lockout, family-revoke, cap-evict all fire per doc 02 §7                                                                        |

---

## 4. Invariant tests (doc 01 §10 — must be _structurally_ impossible to violate)

These target the data/enforcement layer, including the raw-SQL constraints from doc 03 §4. Several
must be proven **under concurrency**, not just sequentially.

| Invariant      | Test                                                                                                                                                                         | Level                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **AUTH-INV-1** | Two concurrent registrations for the same phone → exactly one active `users` row (partial unique `uq_users_phone_active`). Re-register after soft-delete **succeeds**.       | integration (concurrent) |
| **AUTH-INV-2** | Two concurrent verifies of the same OTP → exactly one succeeds (atomic Redis consume, doc 02 §4.1).                                                                          | integration (concurrent) |
| **AUTH-INV-3** | Suspended account with a still-valid access token → request denied (`TOKEN_STALE`) on the next call.                                                                         | integration              |
| **AUTH-INV-4** | A revoked `sid` cannot be used again (denylist + row `revoked_at`).                                                                                                          | integration              |
| **AUTH-INV-5** | Replay of a rotated refresh token revokes the whole family and bumps epoch.                                                                                                  | integration, sec         |
| **AUTH-INV-6** | A `REVOKED` device's sessions are all rejected; it must re-register.                                                                                                         | integration              |
| **AUTH-INV-7** | Ride-accept impossible unless `role=driver` AND `drivers.verification_status=VERIFIED` (not suspended) AND `account=active` — all checked; flipping any one to false denies. | integration              |

- **Partial-index proof:** `uq_user_role_active` allows re-granting a role after `revoked_at` is set;
  a second _active_ grant of the same (user, role) is rejected by the DB (doc 03 §4, OD-2).

---

## 5. Security suite (doc 02 + doc 05 §3)

| Property                        | Test                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enumeration resistance          | `send` byte-identical for known/unknown phone; `OTP_INVALID` merged; miss-path does equal hash work → timing spread within tolerance (doc 02 §4.4). |
| Token hygiene                   | refresh token stored only as HMAC hash; DB dump contains no raw token, no OTP, no JWT.                                                              |
| Fast revocation                 | epoch bump invalidates every outstanding access token for a user within one request cycle (NFR-5).                                                  |
| Fail-closed                     | Redis down on the authorize path → `503 SERVICE_UNAVAILABLE`, never a fall-through to success (doc 02 §7, doc 05).                                  |
| Rate-limit axes                 | phone / device / IP counters each independently trip `429`; strictest applies (doc 02 §4.2).                                                        |
| Rooted/jailbroken sensitive act | flagged device → sensitive action stepped-up or denied per policy (doc 02 §5.2).                                                                    |
| No-secrets-in-errors            | every code in doc 05 §2 asserted to omit codes/tokens/IDs/stack traces (doc 05 §5).                                                                 |
| 401-family branching            | `TOKEN_INVALID` vs `TOKEN_STALE` vs `TOKEN_REUSE` vs `SESSION_REVOKED` each returns its distinct `code` (doc 05 §4).                                |

---

## 6. Event-contract tests (doc 06)

| Assertion                                                                                                                                                                                    | Level             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Each endpoint emits exactly the events doc 04/06 list, with the §3 envelope and §5 payload.                                                                                                  | integration       |
| **Audit** events (`auth.login.succeeded`, `auth.session.revoked`, `account.*`, `auth.refresh.reuse_detected`) are written in the **same transaction** as their change (rollback ⇒ no event). | integration       |
| **No payload** carries an OTP, raw/hashed token, pepper, or JWT (doc 06 §6).                                                                                                                 | unit, integration |
| Consumers are idempotent: redelivering an `eventId` causes no double effect (at-least-once).                                                                                                 | integration       |
| `auth.login.failed.reason` never distinguishes "no account" from "wrong code" (R-AUTH-19).                                                                                                   | unit              |

---

## 7. Load & performance (NFR-1/3)

| Scenario                  | Target                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Authorize hook under load | p95 < 300 ms server-side; the hot path does **1 HMAC + 1 Redis GET** (+ optional denylist `SISMEMBER`), **no Postgres** (doc 02 §3.3). |
| `/otp/send` burst         | rate limiter holds; SMS cost bounded; no unbounded Redis growth.                                                                       |
| `/token/refresh` churn    | rotation throughput sustained; no lock contention on the refresh table.                                                                |
| Suspension fan-out        | epoch bump reflected in authorize decisions within one request cycle at load.                                                          |

---

## 8. Data & migration tests (doc 03)

- **Schema validation** — `prisma validate` is green; `prisma generate` produces the expected models
  (`Role.slug`, `UserRoleAssignment.revokedAt`, `UserDevice.trustState`, `RefreshToken.tokenHash`,
  `UserStatus {UNVERIFIED,ACTIVE,SUSPENDED,DEACTIVATED}`, `OtpPurpose {LOGIN,REGISTER}`).
- **Raw-SQL constraints** — the four indexes in doc 03 §4 exist after migrate and enforce their
  invariants (proved in §4 above).
- **Seed idempotency** — running the role seed twice leaves exactly four roles (upsert on `slug`).
- **No secret column** — `otp_verifications` has **no** `otp_hash`; `refresh_tokens` stores only
  `token_hash` (doc 02 §4.5, §3.2).

---

## 9. Coverage & exit criteria

AUTH v1 may ship when **all** hold:

1. Every row in §3 (acceptance) and §4 (invariants) is green in CI.
2. The security suite (§5) and event-contract suite (§6) pass, including the concurrency and
   fail-closed cases.
3. The regression guard **#6 / AUTH-INV-7** (driver-role-without-approval is denied) is green — this
   is the single most important cross-module check.
4. Load targets (§7) met on the authorize hot path.
5. `prisma validate`, `typecheck` (src + tools), `lint --max-warnings=0`, and the full `tsx --test`
   suite pass — the repo's standing gates.

---

## 10. Traceability

| Suite (this doc) | Proves                                      |
| ---------------- | ------------------------------------------- |
| §3 acceptance    | doc 01 §13 (all 12)                         |
| §4 invariants    | doc 01 §10 (AUTH-INV-1…7), doc 03 §4        |
| §5 security      | doc 02 §3/§4/§5/§7, doc 05 §3/§4/§5         |
| §6 events        | doc 06 (envelope, audit subset, no-secrets) |
| §7 load          | NFR-1/3, doc 02 §3.3                        |
| §8 data          | doc 03 (models, §4 constraints, §5 seed)    |

**End of the AUTH chain.** 01 (why) → 02 (how, security) → 03 (schema) → 04 (API) → 05 (errors) →
06 (events) → **07 (proof)**. Every requirement in 01 is now traceable to a mechanism, a table, an
endpoint, an error, an event, and a test.
