# USER — Flows

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `users` · **Doc:** FLOW (narrative overview) · **Status:** 🟡 Specified (v1)
> **Owner:** Engineering (Identity) · **Last updated:** 2026-07-29
> **Answers:** _What actually happens, step by step, in each user-facing identity flow?_
> **Traces to:** [01_BR](01_USER_BUSINESS_REQUIREMENTS.md) · [02_API](02_USER_API_SPEC.md) · [05_EVENTS](05_USER_EVENT_CATALOG.md)

This is the narrative companion to the chain. Every step here has a contract in 02, an error in 04,
and an event in 05. Where a step is owned by AUTH it is marked **[auth]**.

---

## 1. Registration — where the profile comes from

The profile is **not** created by a USER endpoint. It is created inside AUTH's login transaction, on
the first successful OTP verification, so an account can never exist without one (R-USER-27, USER-INV-1).

```
POST /api/v1/auth/otp/verify        [auth]
  │
  ├─ BEGIN TRANSACTION              [auth]
  │    ├─ create users row                          (status ACTIVE, phone verified)   [auth]
  │    ├─ create user_profiles row  ◀── USER        (all fields null, language "en")
  │    ├─ grant customer role                                                          [auth]
  │    ├─ register device                                                              [auth]
  │    ├─ create session + refresh token                                               [auth]
  │    └─ outbox: auth.otp.verified, auth.login.succeeded, auth.session.created,
  │              account.role.granted, user.profile.created  ◀── USER
  └─ COMMIT
```

The profile row is deliberately **empty** — no name is collected at registration, because the OTP
screen is the whole signup. `referralCode` stays `null`; the `referral` module fills it when the user
first opens the referral screen. `languageCode` defaults to `"en"` and is overwritten by the first
`PATCH /me/profile` the client sends after reading the device locale.

---

## 2. Reading the account — `GET /api/v1/users/me`

```
GET /api/v1/users/me
  │
  ├─ global deny-by-default gate authenticates      [auth]  → 401 if no/stale/revoked token
  ├─ read users row scoped to request.auth.userId
  ├─ read user_profiles by userId
  ├─ read active role slugs                          [auth]
  └─ 200 { id, phoneNumber, email, status, roles, profile { … } }
```

There is **no** `GET /users/:id`. The only identity a caller can read through this module is their
own; the userId comes from the verified token, never from the path or body (USER-INV-2).

---

## 3. Editing the profile — `PATCH /api/v1/users/me/profile`

```
PATCH /api/v1/users/me/profile  { firstName?, lastName?, dateOfBirth?, gender?, languageCode? }
  │
  ├─ validate (Zod)                → 400 VALIDATION with field details
  ├─ reject immutable fields       → 400 IMMUTABLE_FIELD   (phoneNumber, status, roles, …)
  │
  ├─ BEGIN TRANSACTION
  │    ├─ update user_profiles (only the keys present in the body)
  │    └─ outbox: user.profile.updated { changedFields: [...] }
  └─ COMMIT  → 200 with the full updated profile
```

The event carries **field names only, never values** — a profile update is not interesting enough to
justify shipping a date of birth through the broker (05 §5).

---

## 4. Changing the phone number — the one security-grade flow

This preserves the identity (`users.id` never changes) and therefore every ride, payment, rating, and
role attached to it (R-ACCOUNT-9). It is a two-step flow because the user must prove they control the
**new** number before we re-bind to it.

### Step 1 — request

```
POST /api/v1/users/me/phone/change  { newPhoneNumber }
  │
  ├─ new number == current?                → 400 PHONE_UNCHANGED
  ├─ new number already on an active user? → 409 PHONE_IN_USE
  ├─ send OTP to the NEW number             [auth: OtpService, purpose PHONE_CHANGE]
  └─ 202 { challengeId, expiresInSec }
       └─ outbox: user.phone.change_requested
```

> **Why `PHONE_IN_USE` is allowed to leak existence here.** Everywhere else the platform refuses to
> confirm whether a number is registered (R-AUTH-19). Here the caller is already authenticated as a
> known user, and they cannot proceed without being told the number is taken. The leak is one bit,
> costs one authenticated request, and is rate-limited per user — the same accepted trade-off AUTH
> makes for `ACCOUNT_SUSPENDED` (auth doc 05 §3.3).

### Step 2 — confirm

```
POST /api/v1/users/me/phone/verify  { challengeId, code }
  │
  ├─ consume OTP                            [auth]  → 401 OTP_INVALID / 410 OTP_EXPIRED / 429 OTP_LOCKED
  │
  ├─ BEGIN TRANSACTION
  │    ├─ re-check uniqueness under the write lock  → 409 PHONE_IN_USE  (lost the race)
  │    ├─ update users.phone_number, keep users.id
  │    ├─ revoke every session + refresh token       [auth]
  │    └─ outbox: user.phone.changed, account.recovery.completed { changedPhone: true },
  │              auth.session.revoked (one per sid)  [auth]
  ├─ COMMIT
  │
  ├─ bump the Redis epoch                    [auth]   ← after commit (R-USER-30, AUTH's UoW rule)
  └─ 200 { accessToken, refreshToken, … }             ← a fresh session for the calling device only
```

Every other device is signed out (USER-INV-4). This is intentional: a number change is exactly the
shape of an account takeover, so the flow ends with one device holding credentials — the one that
just proved it controls the new SIM.

Note that `account.recovery.completed` is **AUTH's existing event** (auth doc 06 §5.4), defined but
never emitted until now. This flow is its trigger. USER does not invent a duplicate.

---

## 5. Emergency contacts and saved places

Both are simple owned-collection CRUD, capped per user, and both matter to flows outside this module —
`sos` reads emergency contacts, `rides` reads saved places for the pickup picker.

```
POST   /api/v1/users/me/emergency-contacts   → 201  (409 LIMIT_EXCEEDED past the cap)
GET    /api/v1/users/me/emergency-contacts   → 200
DELETE /api/v1/users/me/emergency-contacts/:id → 204  (404 NOT_FOUND if not owned)

POST   /api/v1/users/me/saved-places         → 201
GET    /api/v1/users/me/saved-places         → 200
PATCH  /api/v1/users/me/saved-places/:id     → 200
DELETE /api/v1/users/me/saved-places/:id     → 204
```

`:id` is always re-checked against `request.auth.userId` before the write — an ID from another user's
account returns **404, not 403**, so the endpoint never confirms that someone else's row exists.

---

## 6. Leaving — deactivation and deletion

```
POST /api/v1/users/me/deactivate   { reason? }
  │
  ├─ BEGIN TRANSACTION
  │    ├─ users.status = DEACTIVATED             [auth: AuthService]
  │    ├─ revoke all sessions + refresh tokens   [auth]
  │    └─ outbox: user.account.deactivated
  ├─ COMMIT
  ├─ bump epoch                                  [auth]
  └─ 204
```

Reactivation is **not** self-service — a deactivated user cannot authenticate, so there is no
authenticated call they could make to undo it. It is an admin action (`admin` module) that reuses
AUTH's existing `activate`, and it emits `user.account.restored`.

Deletion is a **request**, never an immediate erase:

```
POST /api/v1/users/me/delete-request  → 202
  └─ deactivate (as above) + user.account.deletion_requested
```

The row is soft-deleted (`users.deleted_at`) after the statutory retention window by an operations
job, never by the endpoint (R-DATA-1). Because `uq_users_phone_active` is a **partial** unique index
on `deleted_at IS NULL`, the freed phone number can register a brand-new account afterwards — a new
identity, with none of the old history (USER-INV-6).

---

## 7. Where devices and sessions live

They are **not here**. Self-service device and session management are AUTH surfaces, mounted
alongside the existing `/api/v1/auth/me/sessions`:

| Flow               | Endpoint                              | Doc                                          |
| ------------------ | ------------------------------------- | -------------------------------------------- |
| List sessions      | `GET /api/v1/auth/me/sessions`        | [auth 04](../auth/04%20auth%20api%20spec.md) |
| Revoke one session | `DELETE /api/v1/auth/me/sessions/:id` | auth 04                                      |
| List devices       | `GET /api/v1/auth/me/devices`         | auth 04 _(pending)_                          |
| Revoke a device    | `DELETE /api/v1/auth/me/devices/:id`  | auth 04 _(pending)_                          |

They live with AUTH because `user_devices` and `user_sessions` are AUTH-owned tables whose lifecycle
rules (trust states, the concurrency cap, the revocation denylist) are AUTH invariants. Putting the
routes under `/users/me` would split one model's rules across two modules.

---

## 8. Flow → contract index

| Flow         | API     | Errors    | Events                                       | Invariant    |
| ------------ | ------- | --------- | -------------------------------------------- | ------------ |
| Registration | auth 04 | auth 05   | `user.profile.created`                       | USER-INV-1   |
| Read me      | 02 §2.1 | 04 §2     | —                                            | USER-INV-2   |
| Edit profile | 02 §2.2 | 04 §2     | `user.profile.updated`                       | USER-INV-5   |
| Phone change | 02 §2.4 | 04 §2, §3 | `user.phone.*`, `account.recovery.completed` | USER-INV-3/4 |
| Contacts     | 02 §2.5 | 04 §2     | `user.emergency_contact.*`                   | USER-INV-7   |
| Saved places | 02 §2.6 | 04 §2     | `user.saved_place.*`                         | USER-INV-7   |
| Deactivate   | 02 §2.7 | 04 §2     | `user.account.deactivated`                   | USER-INV-6   |
