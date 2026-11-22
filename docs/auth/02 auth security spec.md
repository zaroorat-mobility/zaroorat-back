# AUTH — Security Specification

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `auth` · **Doc:** 02 of the AUTH chain · **Stack:** Node.js / Fastify / Prisma (ADR-0006)
> **Status:** 🟢 Final (v1) · **Owner:** Engineering (Auth) / Security · **Last updated:** 2026-08-02
> **Answers:** _How do we mechanically satisfy the AUTH security requirements — token model, OTP, revocation, fraud response?_
> **Traces from:** [01_AUTH_BUSINESS_REQUIREMENTS](01_AUTH_BUSINESS_REQUIREMENTS.md)
> **Traces to:** 03_AUTH_DATABASE_SPEC → 04_AUTH_API_SPEC → 05_AUTH_ERROR_CATALOG → 06_AUTH_EVENT_CATALOG → 07_AUTH_TEST_PLAN
> **Closes ODs:** OD-3 (security angle), OD-5, OD-6, OD-8, OD-9 · **Leaves to 03:** OD-1, OD-2, OD-4, OD-7

---

## 1. Purpose & scope

This spec fixes the **mechanisms** behind the requirements in doc 01: the token architecture, OTP
handling, revocation, session/device rules, authorization enforcement, and the concrete fraud
responses. It is the authority for _how_; storage shapes are 03, endpoint contracts are 04, error
bodies are 05.

Where doc 01 flagged an implementation fork, the chosen resolution is stated inline and cross-linked
to its OD. One knob is deliberately left swappable (§3.1, HS256 vs RS256) because it is an isolated
config decision, not a structural one.

---

## 2. Threat model (what this defends)

| Threat                                  | Primary defense                                                |
| --------------------------------------- | -------------------------------------------------------------- |
| OTP brute force (guess the code)        | Short TTL + single-use + attempt lockout (§4.3)                |
| SMS flooding / cost abuse (BO-5)        | Per-phone **and** per-device **and** per-IP send limits (§4.2) |
| Account enumeration                     | Uniform responses + constant-time behavior (§4.4)              |
| Refresh-token theft / replay            | Rotation + reuse detection → family revoke (§3.2)              |
| Stale access after suspension/role loss | Redis **session epoch** checked on every request (§3.3)        |
| Session hijack across devices           | Per-session `sid`, device binding, revocable sessions (§5)     |
| Privilege escalation                    | Deny-by-default, out-of-band admin provisioning (§6)           |
| Compromised device (rooted/jailbroken)  | Device risk flags → step-up/deny on sensitive actions (§5.2)   |

**Non-goals (owned elsewhere):** edge DDoS and WAF (infra), SMS-provider compromise (vendor),
object-storage/KYC security (`files`), transport crypto beyond "TLS everywhere" (platform).

---

## 3. Credential & token architecture (closes OD-6)

Two credential types with deliberately different properties.

### 3.1 Access token — stateless JWT

- **Format:** JWT. **Algorithm: HS256** (symmetric). Since this is a **modular monolith** (ADR-0004)
  where the same process both mints and verifies, a shared secret is simpler and faster than RS256's
  asymmetric key management. **RS256 is a supported swap** and becomes worthwhile only if token
  verification moves to a separate service that must not hold the signing secret — it is a config
  change (`ALG` + key material), not a redesign.
- **TTL:** 15 minutes.
- **Claims:**

```json
{
  "sub": "<user uuid>",
  "sid": "<session uuid>", // ties the access token to one session (§5)
  "roles": ["customer", "driver"], // snapshot for fast authz; re-validated via epoch (§3.3)
  "epoch": 7, // user session-epoch at mint time (§3.3)
  "iat": 1750000000,
  "exp": 1750000900,
  "jti": "<uuid>"
}
```

- The access token is a **bearer of a snapshot**. It is never trusted for _current_ account state or
  role membership on its own — those are validated against the epoch on every request (§3.3). This is
  what keeps a 15-minute TTL from violating AUTH-INV-3.

### 3.2 Refresh token — opaque, rotating, hashed

- **Format:** opaque, **256-bit** value from a CSPRNG (`crypto.randomBytes(32)`, base64url). Never a
  JWT, never guessable, carries no claims.
- **Storage:** only the **HMAC-SHA256(token, PEPPER)** digest is persisted (03). The raw token exists
  only in the client. A DB leak does not yield usable tokens without the server-side pepper.
- **Rotation (R-AUTH-5):** every successful refresh **consumes** the presented token and issues a new
  one; the old row is marked rotated with a `rotated_to` link, forming a **session family** lineage.
- **Reuse detection (AUTH-INV-5):** if a token already marked _rotated/consumed_ is presented, the
  **entire family is revoked** immediately (all descendants + the current session), the user's epoch
  is bumped (§3.3), and `auth.refresh.reuse_detected` is emitted. This turns token theft into a
  single-use event: whoever refreshes second is locked out and the legitimate user is forced to
  re-authenticate.

### 3.3 Fast revocation — the Redis session epoch (satisfies AUTH-INV-3/4, R-AUTH-7/12/16)

A stateless JWT alone cannot honor "a suspended user is denied _immediately_, even with a
not-yet-expired token." We resolve this **without a Postgres hit** using a per-user counter in Redis:

- **Key:** `auth:epoch:{user_id}` → integer. Present in every access token as the `epoch` claim.
- **On every request**, the auth hook (§6) does: verify signature (stateless) → `GET auth:epoch:{sub}`
  (O(1) Redis) → **reject if `token.epoch != current_epoch`**.
- **What bumps the epoch** (invalidating every outstanding access token for that user at once):
  account suspension (R-AUTH-12), role grant/revoke (R-ACCOUNT-7), password/credential reset if ever
  added, and refresh-family reuse (§3.2).
- **Single-session logout / cap-eviction** does _not_ bump the whole epoch (that would sign out every
  device). Instead it revokes one **`sid`**: the session record is marked revoked (03) and its `sid`
  is added to a short-TTL Redis denylist checked alongside the epoch, so the one evicted device is
  rejected on its next request while the others survive.

> **Speed budget:** verification is one HMAC + one Redis `GET` (+ an optional `SISMEMBER` on the
> small `sid` denylist). No Postgres on the authorize path — NFR-1 holds, and revocation lands within
> one request cycle — NFR-5 holds.

### 3.4 Hashing summary (never bcrypt for tokens)

| Secret                          | Hash / handling                                     | Where           | Why not bcrypt                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Refresh token** (256-bit)     | **HMAC-SHA256 + server pepper**                     | Postgres (hash) | bcrypt is for low-entropy passwords; it's needlessly slow on the refresh hot path and truncates at 72 bytes. A random 256-bit token needs a fast keyed hash, not a work-factor. |
| **OTP** (6 digits, low-entropy) | **HMAC-SHA256 + pepper**, Redis-only, TTL + lockout | Redis           | Brute force is already infeasible via 5-attempt lockout + 5-min TTL; a slow hash buys nothing and adds verify latency.                                                          |
| **Password** (deferred, OD-7)   | **argon2id** _if/when introduced_                   | Postgres        | The correct slow hash for real human passwords — reserved, not built in v1.                                                                                                     |

- **Pepper and signing secret** live in the secret manager / environment, **never in the repo or
  Prisma schema**, and are rotatable (JWT via a `kid`/epoch-style rollover; pepper via dual-read
  during rotation).

---

## 4. OTP mechanism (closes OD-3 security angle + OD-8 OTP thresholds)

### 4.1 Generation & verification

- 6-digit code from a **CSPRNG**. Stored as `HMAC-SHA256(code, PEPPER)` under `otp:{purpose}:{phone}`
  in Redis with a **5-minute TTL**. The **plaintext/hash is never written to Postgres** (Vol 6 rule;
  closes OD-3 — see §4.5).
- **Single-use (AUTH-INV-2):** consumption is **atomic** — a Redis Lua script (or `GETDEL` + guarded
  compare) that verifies and deletes in one round trip so two concurrent verifies cannot both
  succeed.

### 4.2 Send rate limits (fixes OD-8 — three axes, not just phone)

An attacker rotates phone numbers from one host, so per-phone limits alone don't bound SMS cost or
enumeration. Three **independent** counters; the **strictest** applies:

| Axis       | Limit (v1 default, configurable)     | Key                          |
| ---------- | ------------------------------------ | ---------------------------- |
| Per phone  | 3 sends / rolling hour, ≥ 60 s apart | `ratelimit:otp:req:{phone}`  |
| Per device | 5 sends / rolling hour               | `ratelimit:otp:dev:{device}` |
| Per IP     | 20 sends / rolling hour              | `ratelimit:otp:ip:{ip}`      |

### 4.3 Verify lockout (OD-8)

- **5 failed verifies** → lock the phone (and its device) for **15 minutes** (`otp:lock:{phone}`).
- Failed attempts increment `otp:att:{phone}`; the counter and lock share the OTP horizon.

### 4.4 Enumeration resistance (R-AUTH-19)

- `POST /auth/otp/send` returns the **same response** whether or not the phone maps to an existing
  account (it never reveals "new vs returning"). Account creation happens on first successful verify,
  not on send.
- Verify responses do not distinguish "no account" from "wrong code" — both are a generic failure.
- Timing is kept uniform (do the same hash/compare work on the miss path) to avoid a timing oracle.

### 4.5 Durable attempt log (closes OD-3)

For fraud investigation (R-AUTH-22/30) the Postgres `otp_verifications` row stores **non-secret
metadata only** — phone, purpose, outcome, ip, device, timestamps. It **must not** carry the
`otp_hash` column that exists in the current Prisma model; 03 drops it from the persisted table (the
hash lives only in Redis). Rows are purged on a short cycle (R-AUTH-26).

---

## 5. Session & device mechanisms (closes OD-5)

### 5.1 Sessions

- A **session** = one authenticated context on one device, identified by `sid`, backed by a DB row
  (fields in 03) and the refresh-family lineage (§3.2).
- **Concurrent cap = 5 active sessions/account** (configurable; OD-5 value). On the **6th** login the
  **oldest active session is revoked** (its `sid` denylisted, row marked revoked) and
  `auth.session.revoked` is emitted so that device is signed out on its next request. No interactive
  "choose a device" prompt in v1 (that UX is P1).
- **SOS / safety flows are never blocked** by the cap (consistency with FR-SOS).
- `admin` / `support` sessions use a **lower cap** (default 2) — privileged sessions should not
  sprawl.

### 5.2 Device trust (from doc 01 §6 — deterministic v1, behavioral deferred)

| Transition     | v1 status       | Trigger                                                                                       |
| -------------- | --------------- | --------------------------------------------------------------------------------------------- |
| → `registered` | ✅ v1           | First login from a device.                                                                    |
| → `revoked`    | ✅ v1           | User/ops revoke; kills the device's sessions (AUTH-INV-6).                                    |
| → `trusted`    | ✅ v1 (passive) | Accrues history; the _reward_ (reduced friction) is deferred.                                 |
| → `suspicious` | ⏭ post-v1       | Behavioral signals (impossible travel, fingerprint mismatch) — **detection deferred** (OD-8). |

- **Rooted/jailbroken** (`is_rooted` / `is_jailbroken`) is captured at login and, per policy, **steps
  up or denies** a _sensitive_ action (e.g. wallet debit, number-change request). Default v1: capture
  - allow normal auth, **deny** the sensitive subset — the sensitive-action list is owned by each
    module, AUTH enforces the flag.

> **Honesty note (OD-8):** v1 ships the **deterministic** controls (rate limits, lockout, reuse
> detection, device revoke). The **behavioral** risk engine (what makes a device "suspicious") is
> post-v1; until then the `suspicious` state is defined but unreached.

---

## 6. Authorization enforcement (R-AUTH-14…17, 23)

A single Fastify **`onRequest`/`preHandler` hook** guards every protected route (deny-by-default):

```
1. extract bearer JWT              -> 401 if missing/invalid signature
2. GET auth:epoch:{sub}            -> 401 if token.epoch != current   (§3.3, suspension/role change)
3. SISMEMBER sid-denylist          -> 401 if this sid was revoked     (logout / cap-evict)
4. attach { userId, sid, roles }   -> request context
5. route role guard                -> 403 if none of the required roles ∈ roles   (R-AUTH-15)
```

- **Deny-by-default (R-AUTH-14):** routes are protected unless explicitly marked public
  (`/auth/otp/send`, `/auth/otp/verify`, health).
- **Privileged roles (R-AUTH-17):** `admin`/`support` are **provisioned out-of-band** (seed / ops
  tool), never grantable through the public flow.
- **Driver ride-accept conjunction (R-AUTH-23, AUTH-INV-7):** the ride-accept guard requires
  `has_role(driver)` **AND** a **live** `drivers.verification_status = 'VERIFIED'` (and not suspended)
  lookup **AND** `account.status = 'active'`. Operability is **not** in the JWT (it changes
  independently and is owned by `onboarding`), so this one check reads the driver domain live.
  Role-in-token is only the first of three conditions.

---

## 7. Fraud response mechanisms (closes OD-8; realizes doc 01 §8.1)

Detection thresholds are fixed here for the **deterministic** signals; behavioral detection is
deferred (§5.2). Responses **fail closed** — if the (future) risk service is unavailable, only the
deterministic controls run; the system never fails open.

| Signal                              | v1 mechanism                                               | Ref             |
| ----------------------------------- | ---------------------------------------------------------- | --------------- |
| OTP verify brute force              | 5 fails → 15-min lock (per phone + device)                 | §4.3, R-AUTH-8  |
| OTP send flooding                   | 3/hr phone · 5/hr device · 20/hr IP; 60 s min gap          | §4.2, R-AUTH-9  |
| Refresh-token reuse                 | Revoke family + bump epoch + emit event                    | §3.2, INV-5     |
| Over session cap                    | Revoke oldest session                                      | §5.1, R-AUTH-24 |
| Rooted/jailbroken on sensitive act. | Step-up or deny (per-action policy)                        | §5.2            |
| Impossible travel / fingerprint     | Mark `suspicious` → step-up — **detection post-v1**        | §5.2 (OD-8)     |
| Confirmed compromise (ops)          | Suspend → epoch bump → all sessions dead; audited recovery | §3.3, §8        |

---

## 8. Recovery security (closes OD-9)

- **v1: number change / account recovery is admin/support-assisted, out-of-band.** No self-service
  reset (deferred, doc 01 §2.3).
- The support flow **must** (R-ACCOUNT-10): verify identity through an audited procedure, be
  **rate-limited**, write an `admin_activity_logs` row (actor, action, before/after — see doc 03 §6),
  and **never display the OTP or any credential** to staff. Staff _trigger_ a re-verification to the
  user's new number; they do not read codes.
- A completed recovery **preserves the identity** and bumps the epoch (all old sessions die) and
  emits `account.recovery.completed`.

---

## 9. Secrets, transport & logging hygiene

- **TLS everywhere**; bearer tokens only over HTTPS.
- **No secret is ever logged** (R-AUTH-18): OTP codes, raw refresh tokens, JWT signing secret, and
  pepper are excluded from logs and error bodies by a redaction rule in the logger.
- **Signing secret + pepper** in the secret manager; rotatable; never committed.
- **Sensitive auth actions** (suspend, role change, forced logout, recovery) write their audit-class
  event to `outbox_events` **in the same transaction** as the change (R-AUTH-21, R-DATA-2); an
  admin-initiated one additionally writes `admin_activity_logs` from the `admin` module. See doc 03
  §6 — there is no `audit_log` table.
- **PII** (phone, device fingerprint) handled per NFR-10; device risk fields treated as security
  data.

---

## 10. What this hands to 03 (Database) and 04 (API)

**03 must provide (schema):**

- `sessions` — `id (sid)`, `user_id`, `device_id`, `created_at`, `last_seen_at`, `revoked_at`,
  `revoked_reason`; index for "active sessions per user" to enforce the cap.
- `refresh_tokens` — **hash only** (HMAC-SHA256), `rotated_from` / `rotated_to` lineage, `expires_at`,
  `revoked_at`; unique on the hash. (The current Prisma model is close; confirm hash-only + lineage.)
- `otp_verifications` — **metadata only, `otp_hash` removed** (§4.5).
- `user_devices` — trust `state`, `is_rooted` / `is_jailbroken`, fingerprint, platform.
- **Roles:** consolidate onto the existing `UserRoleAssignment` / `Role` join table (grant/revoke +
  `expires_at` already present) — **not** a `roles[]` array (OD-2; 03 to confirm and drop the scalar
  `role`). The epoch mechanism (§3.3) makes role changes effective immediately.
- **Epoch lives in Redis, not Postgres** — do not model it as a column.

**04 must expose:** `POST /auth/otp/send`, `POST /auth/otp/verify` (→ issues access+refresh),
`POST /auth/token/refresh` (rotation), `POST /auth/logout` (revoke `sid`). Error bodies → 05;
emitted events → 06.

---

## 11. OD status after this doc

| OD   | Status                    | Resolution                                                                                                                        |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| OD-3 | ✅ closed (security)      | OTP hash Redis-only; Postgres keeps non-secret metadata; purge cycle.                                                             |
| OD-5 | ✅ closed                 | Cap 5 (admin/support 2); revoke-oldest; device learns via event; SOS exempt.                                                      |
| OD-6 | ✅ closed                 | Access = HS256 JWT 15 min (RS256 swap noted); refresh = opaque 256-bit, HMAC-SHA256+pepper, rotating; Redis epoch for revocation. |
| OD-8 | ✅ closed (deterministic) | Rate limits on phone/device/IP; lockout; reuse→family-revoke. Behavioral detection **post-v1**.                                   |
| OD-9 | ✅ closed                 | Admin out-of-band, audited, no credential disclosure.                                                                             |
| OD-1 | → 03                      | UUID (UUIDv7 recommended, ADR-0006).                                                                                              |
| OD-2 | → 03                      | Consolidate on `UserRoleAssignment`/`Role`; drop scalar `role` + array.                                                           |
| OD-4 | → 03                      | Enum `{UNVERIFIED, ACTIVE, SUSPENDED, DEACTIVATED}`, expand→contract migration.                                                   |
| OD-7 | → 03                      | `email`/`password_hash` nullable-reserved; trim `OtpPurpose` to `{LOGIN, REGISTER}` for v1.                                       |

---

## 12. Traceability

| Mechanism (this doc)                 | Realizes (doc 01)                      |
| ------------------------------------ | -------------------------------------- |
| §3.1 JWT access token                | R-AUTH-3, R-AUTH-4, NFR-1              |
| §3.2 refresh rotation + reuse detect | R-AUTH-5, AUTH-INV-5                   |
| §3.3 Redis session epoch             | R-AUTH-7/12/16, AUTH-INV-3/4, NFR-5    |
| §3.4 hashing (HMAC, not bcrypt)      | R-AUTH-18                              |
| §4.1–4.3 OTP gen / limits / lockout  | R-AUTH-2/8/9/20, AUTH-INV-2            |
| §4.4 enumeration resistance          | R-AUTH-19                              |
| §4.5 durable attempt log (no hash)   | R-AUTH-22/26/30, OD-3                  |
| §5 sessions & device trust           | R-AUTH-11/24, R-DEVICE-1…5, AUTH-INV-6 |
| §6 authz hook + driver conjunction   | R-AUTH-14/15/16/17/23, AUTH-INV-7      |
| §7 fraud responses                   | R-AUTH-25, doc 01 §8.1                 |
| §8 recovery security                 | R-ACCOUNT-9/10, R-AUTH-21              |
| §9 secrets/logging/audit             | R-AUTH-18/21, NFR-7/8/10               |

**Next: 03_AUTH_DATABASE_SPEC** turns §10 into the concrete Prisma models + the raw-SQL migration
constraints (partial-unique for one-active-account-per-phone, indexes), closing OD-1, OD-2, OD-4,
OD-7.
