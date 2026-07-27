# AUTH — Database Specification

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `auth` (+ `users`) · **Doc:** 03 of the AUTH chain · **Stack:** Prisma / PostgreSQL (ADR-0006)
> **Status:** 🟢 Final (v1) · **Owner:** Engineering (Auth) / Data · **Last updated:** 2026-07-27
> **Answers:** _What are the exact tables, columns, relations, constraints, and migrations for AUTH?_
> **Traces from:** [01_BUSINESS_REQUIREMENTS](01_AUTH_BUSINESS_REQUIREMENTS.md) · [02_SECURITY_SPEC](02_AUTH_SECURITY_SPEC.md)
> **Traces to:** 04_AUTH_API_SPEC → 05 → 06 → 07
> **Closes ODs:** OD-1, OD-2, OD-4, OD-7 (OD-3/5/6/8/9 closed in 02)

---

## 1. Purpose

The concrete data model. The Prisma models below are **authoritative** for the AUTH module (ADR-0006:
`schema.prisma` is the source of truth; Prisma Migrate replaces Alembic). Several invariants can only
be enforced by **partial-unique indexes and other Postgres constructs Prisma cannot express** — those
are catalogued in §4 and ship as **hand-authored SQL inside the migration**, not generated DSL.

---

## 2. Open decisions resolved here

| OD                        | Resolution                                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OD-1** Identity ID      | **UUID**, generated **v7** (time-ordered) for index locality on high-volume tables (ADR-0006).                                                                                                              |
| **OD-2** Role storage     | **`Role` + `UserRoleAssignment` join table** is the single source of truth. The scalar `role` is **dropped**; the `roles[]` array is **not** introduced. Grant/revoke/expiry are first-class (R-ACCOUNT-7). |
| **OD-4** Account state    | Enum **`{UNVERIFIED, ACTIVE, SUSPENDED, DEACTIVATED}`** (doc 01 §4.1).                                                                                                                                      |
| **OD-7** Deferred factors | `email` / `password_hash` kept **nullable & reserved**; `OtpPurpose` trimmed to **`{LOGIN, REGISTER}`** for v1; the rest reserved in comments, not built.                                                   |

> **Epoch is not a column.** The per-user session epoch (doc 02 §3.3) lives in **Redis**
> (`auth:epoch:{user_id}`). It is deliberately absent from Postgres — modelling it as a column would
> put a hot, per-request-mutated counter on the system of record.

---

## 3. Prisma models (auth module)

```prisma
// ---------- enums ----------

enum UserStatus {
  UNVERIFIED
  ACTIVE
  SUSPENDED
  DEACTIVATED
}

enum OtpPurpose {
  LOGIN
  REGISTER
  // RESET_PASSWORD, CHANGE_PHONE, DELETE_ACCOUNT — reserved, not v1 (OD-7)
}

enum DeviceTrustState {
  REGISTERED
  TRUSTED
  SUSPICIOUS
  REVOKED
}

enum AppPlatform {
  IOS
  ANDROID
  WEB
}

// ---------- identity ----------

model User {
  id              String     @id @default(uuid(7)) @db.Uuid   // v7; see §4 note if your Prisma is older
  phoneNumber     String     @map("phone_number")             // E.164 (+91…); uniqueness is PARTIAL — see §4
  email           String?    @unique                          // reserved (OD-7), nullable
  passwordHash    String?    @map("password_hash")            // reserved (OD-7), nullable
  status          UserStatus @default(UNVERIFIED)
  isPhoneVerified Boolean    @default(false) @map("is_phone_verified")
  isEmailVerified Boolean    @default(false) @map("is_email_verified")
  lastLoginAt     DateTime?  @map("last_login_at")
  createdAt       DateTime   @default(now()) @map("created_at")
  updatedAt       DateTime   @updatedAt @map("updated_at")
  deletedAt       DateTime?  @map("deleted_at")               // soft delete (R-DATA-1)

  roleAssignments UserRoleAssignment[]
  sessions        UserSession[]
  refreshTokens   RefreshToken[]
  otpVerifications OtpVerification[]
  devices         UserDevice[]
  // REMOVED: `role UserRole` (OD-2). NOT ADDED: `roles[]` array. NOT ADDED: `epoch` column.

  @@index([status])
  @@map("users")
}

// ---------- roles (RBAC via join table) ----------

model Role {
  id          String   @id @default(uuid(7)) @db.Uuid
  slug        String   @unique                               // 'customer' | 'driver' | 'admin' | 'support'
  name        String
  description String?
  createdAt   DateTime @default(now()) @map("created_at")

  assignments UserRoleAssignment[]
  @@map("roles")
}

model UserRoleAssignment {
  id        String    @id @default(uuid(7)) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  roleId    String    @map("role_id") @db.Uuid
  grantedBy String?   @map("granted_by") @db.Uuid            // actor (R-ACCOUNT-7); null = system grant
  grantedAt DateTime  @default(now()) @map("granted_at")
  revokedAt DateTime? @map("revoked_at")                     // revocation is a timestamp, not a row delete
  expiresAt DateTime? @map("expires_at")                     // scoped / temporary roles

  user User @relation(fields: [userId], references: [id])
  role Role @relation(fields: [roleId], references: [id])

  @@index([userId])
  @@map("user_roles")
  // active-uniqueness is PARTIAL (re-grant allowed after revoke) — see §4
}

// ---------- sessions ----------

model UserSession {
  id            String    @id @default(uuid(7)) @db.Uuid     // = sid (doc 02 §3.3)
  userId        String    @map("user_id") @db.Uuid
  deviceId      String?   @map("device_id") @db.Uuid
  ipAddress     String?   @map("ip_address") @db.Inet
  createdAt     DateTime  @default(now()) @map("created_at")
  lastSeenAt    DateTime? @map("last_seen_at")
  expiresAt     DateTime  @map("expires_at")
  revokedAt     DateTime? @map("revoked_at")
  revokedReason String?   @map("revoked_reason")             // logout | suspension | cap_evicted | device_revoked | reuse_detected

  user          User           @relation(fields: [userId], references: [id])
  device        UserDevice?    @relation(fields: [deviceId], references: [id])
  refreshTokens RefreshToken[]

  @@index([userId])
  @@index([expiresAt])
  @@map("user_sessions")
  // fast "active sessions per user" for the 5-cap is a PARTIAL index — see §4
}

// ---------- refresh tokens (hash only, rotating) ----------

model RefreshToken {
  id            String    @id @default(uuid(7)) @db.Uuid
  userId        String    @map("user_id") @db.Uuid
  sessionId     String    @map("session_id") @db.Uuid
  tokenHash     String    @unique @map("token_hash")         // HMAC-SHA256(token, pepper) — hash ONLY (doc 02 §3.2)
  rotatedFrom   String?   @map("rotated_from") @db.Uuid
  rotatedTo     String?   @map("rotated_to") @db.Uuid
  expiresAt     DateTime  @map("expires_at")
  revokedAt     DateTime? @map("revoked_at")
  revokedReason String?   @map("revoked_reason")
  createdAt     DateTime  @default(now()) @map("created_at")

  user             User           @relation(fields: [userId], references: [id])
  session          UserSession    @relation(fields: [sessionId], references: [id])
  rotatedFromToken RefreshToken?  @relation("Rotation", fields: [rotatedFrom], references: [id])
  rotatedToTokens  RefreshToken[] @relation("Rotation")

  @@index([sessionId])
  @@index([expiresAt])
  @@map("refresh_tokens")
  // NO raw token column, ever. `token_hash @unique` is a native full-unique — fine.
}

// ---------- OTP attempt trail (NON-SECRET metadata; hash lives in Redis) ----------

model OtpVerification {
  id          String     @id @default(uuid(7)) @db.Uuid
  userId      String?    @map("user_id") @db.Uuid            // null until the account exists
  phoneNumber String     @map("phone_number")
  purpose     OtpPurpose
  outcome     String?                                        // sent | verified | failed | expired | locked
  attempts    Int        @default(0)
  ipAddress   String?    @map("ip_address") @db.Inet
  deviceId    String?    @map("device_id") @db.Uuid
  createdAt   DateTime   @default(now()) @map("created_at")
  verifiedAt  DateTime?  @map("verified_at")
  expiresAt   DateTime   @map("expires_at")
  // REMOVED vs current schema: `otp_hash` (doc 02 §4.5). The hash is Redis-only; this is a
  // purgeable fraud/audit trail (R-AUTH-22/30), NOT a verification store.

  user        User?      @relation(fields: [userId], references: [id])  // optional; null pre-account

  @@index([phoneNumber])
  @@index([createdAt])
  @@map("otp_verifications")
}

// ---------- devices ----------

model UserDevice {
  id           String            @id @default(uuid(7)) @db.Uuid
  userId       String            @map("user_id") @db.Uuid
  deviceId     String?           @map("device_id")           // client-reported stable id
  platform     AppPlatform?
  trustState   DeviceTrustState  @default(REGISTERED) @map("trust_state")
  fingerprint  String?           @map("device_fingerprint")
  isRooted     Boolean           @default(false) @map("is_rooted")
  isJailbroken Boolean           @default(false) @map("is_jailbroken")
  fcmToken     String?           @map("fcm_token")
  appVersion   String?           @map("app_version")
  osVersion    String?           @map("os_version")
  lastSeenAt   DateTime?         @map("last_seen_at")
  createdAt    DateTime          @default(now()) @map("created_at")

  user     User          @relation(fields: [userId], references: [id])
  sessions UserSession[]

  @@unique([userId, deviceId])
  @@index([userId])
  @@map("user_devices")
}
```

---

## 4. Raw-SQL constraints (what Prisma can't express — ship in the migration)

These enforce invariants **at the database level** (Vol 6 principle #5). They are written by hand in
the Prisma migration SQL and reviewed. **Without them the invariants are only app-enforced.**

```sql
-- AUTH-INV-1: at most one ACTIVE account per phone.
-- A plain @unique would block re-registration after a soft-delete, so it MUST be partial.
CREATE UNIQUE INDEX uq_users_phone_active
    ON users (phone_number) WHERE deleted_at IS NULL;

-- OD-2: at most one ACTIVE assignment per (user, role); re-grant allowed after revoke.
CREATE UNIQUE INDEX uq_user_role_active
    ON user_roles (user_id, role_id) WHERE revoked_at IS NULL;

-- Session cap (doc 02 §5.1): fast count of a user's live sessions.
CREATE INDEX ix_sessions_user_active
    ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- Housekeeping sweeps (retention §6): find expired/revoked rows cheaply.
CREATE INDEX ix_refresh_expired ON refresh_tokens (expires_at) WHERE revoked_at IS NULL;
```

> **UUIDv7 note.** `@default(uuid(7))` is supported on recent Prisma versions — **confirm yours**. If
> it isn't, use `@default(dbgenerated("uuidv7()"))` with a Postgres `uuidv7()` function (native in
> **PostgreSQL 18**; on earlier versions install a small SQL/extension function). App-side generation
> is the fallback. Do **not** silently fall back to v4 — random v4 defeats the locality this choice
> exists for.

> All partial/GiST/partition SQL for **other** modules (e.g. `uq_rider_one_active_trip`, zone GiST,
> `trip_locations` partitioning) follows the same "raw SQL in migration" rule — a full catalogue
> belongs in the Volume 6 DB docs now that Prisma is canonical (ADR-0006 follow-up).

---

## 5. Seed data (idempotent — Vol 6 doc 06)

The four roles are reference data, seeded idempotently so every environment is reproducible:

```sql
INSERT INTO roles (id, slug, name, description) VALUES
  (uuidv7(), 'customer', 'Customer', 'Requests rides'),
  (uuidv7(), 'driver',  'Driver',  'Provides rides (operability gated by drivers.verification_status)'),
  (uuidv7(), 'admin',   'Admin',   'Operations staff — provisioned out-of-band'),
  (uuidv7(), 'support', 'Support', 'Support staff — provisioned out-of-band')
ON CONFLICT (slug) DO NOTHING;
```

---

## 6. Retention per table (realizes doc 01 §11)

| Table               | Policy                                                               | Ref         |
| ------------------- | -------------------------------------------------------------------- | ----------- |
| `otp_verifications` | Short-cycle **purge** (non-secret trail; the secret was never here). | R-AUTH-26   |
| `refresh_tokens`    | Retain (hash) for a bounded theft-detection window, then purge.      | R-AUTH-27   |
| `user_sessions`     | Moderate retention for security review, then archive/prune.          | R-AUTH-29   |
| `user_roles`        | **Kept** (revoked rows retained — grant/revoke history is audit).    | R-ACCOUNT-7 |
| `users`             | Soft-deleted, never physically removed; archived per policy.         | R-DATA-1    |

Auth's write-audit (suspend, role change, recovery) lands in the shared **`audit_log`** (long
retention, append-only) — not duplicated here (R-AUTH-21/28).

---

## 7. Migration plan (expand → migrate → contract — NFR-AVAIL-03)

Old and new code run together during rollout, so breaking changes take three ordered steps.

**M1 — Expand (additive, backward-compatible)**

- Add `roles`, `user_roles` (with `revoked_at`), `user_sessions`, `user_devices`; alter
  `refresh_tokens` (add lineage + `revoked_reason`); alter `otp_verifications` (add metadata cols).
- `email` / `password_hash` are already nullable → no-op.
- Add the §4 partial indexes with `CREATE INDEX CONCURRENTLY` (no write lock, Vol 6 doc 06).
- **Seed roles** (§5). **Backfill** `user_roles` from the existing scalar `role`
  (`CUSTOMER→customer`, `DRIVER→driver`, `ADMIN→admin`, `SUPPORT→support`) in **batches**.

**M2 — Migrate (switch reads/writes)**

- App reads roles from `user_roles`; dual-writes both during rollout.
- **Status migration:** map `INACTIVE→DEACTIVATED`, `BLOCKED→SUSPENDED`; set `UNVERIFIED` where
  `is_phone_verified = false`, else `ACTIVE`. Because Postgres can't drop enum values in place, do it
  as **new type + swap**: create `UserStatus_new`, add/backfill a column, swap, then drop the old type
  in M3.

**M3 — Contract (remove the old, after nothing reads it)**

- Drop the scalar `role` column and the old `UserRole` enum.
- Drop the old `UserStatus` type (`INACTIVE`/`BLOCKED`).
- **Drop `otp_hash`** from `otp_verifications` once code no longer writes it (doc 02 §4.5).

Every migration has a working `down`; large backfills run off the critical path (Vol 6 doc 06 rules).

---

## 8. Terminology decision — **`customer`** (resolved)

Earlier drafts split on `rider` vs `customer`. **Resolved: the platform term is `customer`.** The
wider Prisma schema already commits to it everywhere (`CustomerWallet`, `customerRides`,
`CustomerRatingAggregate`, and the former `UserRole.CUSTOMER`), so aligning the AUTH chain to
`customer` is far less churn than the reverse. Applied consistently across this chain:

- The `Role.slug` for the ride-requesting role is **`customer`** (seed in §5, backfill in §7).
- Registration grants the **`customer`** role (doc 01 R-ACCOUNT-7); the JWT `roles` claim and the
  `account.role.granted` event carry `customer` (docs 02/04).
- "Rider" survives only as an informal actor noun in prose; every machine identifier is `customer`.

---

## 9. What 04 (API) needs from this schema

- **Endpoints** back these tables: `POST /auth/otp/send` (writes `otp_verifications` metadata),
  `POST /auth/otp/verify` (creates `users` on first verify, opens `user_sessions` + `refresh_tokens`,
  binds `user_devices`), `POST /auth/token/refresh` (rotates `refresh_tokens`),
  `POST /auth/logout` (sets `user_sessions.revoked_at`).
- **Role reads** come from `user_roles ⋈ roles` (active = `revoked_at IS NULL AND (expires_at IS NULL
OR expires_at > now())`), cached into the JWT `roles` claim + revalidated by epoch (doc 02).
- **Driver ride-accept** joins live `drivers.verification_status` — not in this schema, consumed cross-module
  (R-AUTH-23).

---

## 10. Traceability

| Schema element                                         | Realizes                          |
| ------------------------------------------------------ | --------------------------------- |
| `users` + `uq_users_phone_active`                      | R-ACCOUNT-2, AUTH-INV-1           |
| `UserStatus {UNVERIFIED…DEACTIVATED}`                  | R-ACCOUNT-4/5, doc 01 §4.1, OD-4  |
| `Role` + `UserRoleAssignment`                          | R-ACCOUNT-3/7, OD-2               |
| `user_sessions` + partial active index                 | R-AUTH-11/24, doc 02 §5           |
| `refresh_tokens` (hash + lineage)                      | R-AUTH-5, AUTH-INV-5, doc 02 §3.2 |
| `otp_verifications` (no hash)                          | R-AUTH-22/26, doc 02 §4.5, OD-3   |
| `user_devices` + `trust_state`                         | R-DEVICE-1…5, AUTH-INV-6          |
| nullable `email`/`password_hash`, trimmed `OtpPurpose` | OD-7                              |
| expand→contract migrations                             | NFR-AVAIL-03, NFR-MAINT-04        |

**Next: 04_AUTH_API_SPEC** — endpoint contracts, request/response shapes, and the auth hook wiring,
consuming these models and doc 02's token flow.
