# USER — API Specification

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `users` · **Doc:** 02 of the USER chain · **Stack:** Fastify / TypeScript (ADR-0006)
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Identity) · **Last updated:** 2026-07-29
> **Answers:** _What are the exact endpoints, request/response shapes, and guard wiring?_
> **Traces from:** [01_BR](01_USER_BUSINESS_REQUIREMENTS.md) · [AUTH 04](../auth/04%20auth%20api%20spec.md) §3 (the guard this module consumes)
> **Traces to:** 03_USER_DATABASE_SPEC · 04_USER_ERROR_CATALOG (bodies) · 05_USER_EVENT_CATALOG (schemas) · 06_USER_TEST_PLAN

---

## 1. Scope & conventions

Every endpoint here is **authenticated and self-scoped**. There is no public route in this module and
no route that takes another user's identifier.

| Convention      | Rule                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Base path       | `/api/v1/users/*` (platform API-versioning convention, mirrors `/api/v1/auth/*`)                      |
| Transport       | HTTPS only; JSON (`application/json`)                                                                 |
| Auth            | `Authorization: Bearer <jwt>` on **every** route — enforced by the global deny-by-default gate (§3)   |
| Subject         | Always `request.auth.userId` from the verified token. **Never** a path/body/query identifier.         |
| Partial update  | `PATCH` applies only the keys **present** in the body; absent ≠ null (R-USER-5)                       |
| Idempotency     | `Idempotency-Key: <uuid>` on **phone verify** and **deactivate** — the two flows that revoke sessions |
| Request tracing | `X-Request-Id` echoed on every response (NFR-8)                                                       |
| Rate limiting   | `429` with `Retry-After`; phone-change requests additionally limited per account (R-USER-15)          |
| Phone format    | E.164 (`+91…`); validated (`400 VALIDATION` on failure)                                               |
| Not-found rule  | A resource that exists but is **not owned** returns `404`, never `403` (R-USER-25)                    |

> **The platform rate limiter does not exist yet.** `src/plugins/rate-limit/rate-limit.plugin.ts` is a
> stub; the only live limiter today is AUTH's OTP limiter. So the per-account phone-change limit
> (R-USER-15) is **this module's own responsibility in v1**, built on the generic
> `RateLimitStore.hit(scope, id, limit, windowSeconds)` already in `src/core/cache/stores/`.
> **No other USER endpoint carries a per-endpoint limit in v1** — profile updates and collection writes
> are authenticated, self-scoped, and hard-capped, so the abuse ceiling is one account damaging its own
> data. They inherit the global limiter when it lands. This is a decision, not an omission.

---

## 2. Endpoints

### 2.1 `GET /api/v1/users/me` — read my account

Returns the identity row, the profile, and read-only projections of AUTH state (status, roles).

**Response `200`**

```json
{
  "id": "<uuid>",
  "phoneNumber": "+919876543210",
  "email": null,
  "isPhoneVerified": true,
  "isEmailVerified": false,
  "status": "ACTIVE",
  "roles": ["customer"],
  "createdAt": "2026-07-29T09:12:00.000Z",
  "lastLoginAt": "2026-07-29T09:12:00.000Z",
  "profile": {
    "firstName": "Aarav",
    "lastName": "Sharma",
    "dateOfBirth": "1994-03-11",
    "gender": "MALE",
    "profileImage": "https://…",
    "languageCode": "hi",
    "referralCode": null
  }
}
```

- `roles` is the **live** set of active role slugs, read from `user_roles` — not the token's claim,
  which may be one epoch stale.
- `profile` is never `null`; a fresh account returns it with every attribute `null` except
  `languageCode` (R-USER-1/2).
- **Errors:** the standard 401 family (04 §2).

---

### 2.2 `PATCH /api/v1/users/me/profile` — update my profile

**Request** — every field optional; only present keys are written.

```json
{
  "firstName": "Aarav",
  "lastName": "Sharma",
  "dateOfBirth": "1994-03-11",
  "gender": "MALE",
  "profileImage": "https://…",
  "languageCode": "hi"
}
```

| Field          | Rule                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `firstName`    | 1–64 chars, trimmed; letters/marks/spaces/hyphens/apostrophes           |
| `lastName`     | same as `firstName`                                                     |
| `dateOfBirth`  | `YYYY-MM-DD`, date-only, in the past, age ≥ 16                          |
| `gender`       | one of `MALE` \| `FEMALE` \| `OTHER` \| `PREFER_NOT_TO_SAY` (USER-OD-5) |
| `profileImage` | absolute `https` URL on a platform-owned host (issued by `files`)       |
| `languageCode` | BCP-47 primary subtag from the supported set (`en`, `hi`, …)            |

**Response `200`** — the full profile after the update (same shape as `2.1.profile`).

- **Explicit null** clears a nullable field; **omission** leaves it unchanged. This is the only place
  the distinction matters, and it is the reason the body is not merged blindly.
- Sending `phoneNumber`, `email`, `status`, `roles`, `isPhoneVerified`, `referralCode`, `userId`, or
  `id` → `400 IMMUTABLE_FIELD` naming the offending fields (USER-INV-5). It is **rejected, not
  ignored** — silently dropping a field the client believed it set is how bugs hide.
- **Errors:** `400 VALIDATION`, `400 IMMUTABLE_FIELD`, 401 family, `403 ACCOUNT_SUSPENDED`.
- **Events:** `user.profile.updated` (field **names** only).

---

### 2.3 `PATCH /api/v1/users/me` — reserved

Reserved for identity-row fields a user may edit directly. In v1 the only candidate is `email`,
deferred by **USER-OD-1**. The route is **not registered** until then — an unimplemented route that
returns `501` is worse than a `404`, because clients write code against it.

---

### 2.4 Phone-number change (two steps)

#### 2.4.1 `POST /api/v1/users/me/phone/change` — request

**Request**

```json
{ "newPhoneNumber": "+919876500099" }
```

**Response `202`**

```json
{ "challengeId": "<opaque>", "expiresInSec": 300, "resendAvailableInSec": 60 }
```

- Sends an OTP to the **new** number via AUTH's `OtpService` with purpose `PHONE_CHANGE`. USER never
  touches MSG91 or Redis directly.
- **Errors:** `400 VALIDATION`, `400 PHONE_UNCHANGED`, `409 PHONE_IN_USE`, `429 RATE_LIMITED`,
  `403 ACCOUNT_SUSPENDED`, 401 family.
- **Events:** `user.phone.change_requested`.

> **This endpoint deliberately reveals that a number is taken.** Everywhere else the platform refuses
> to confirm registration (R-AUTH-19). Here the caller is already authenticated and cannot proceed
> without knowing, the leak is one bit per rate-limited authenticated request, and the alternative —
> accepting the request and failing at step 2 after the user waits for an SMS that will never help —
> is worse for the honest majority. Scoped, accepted, and mirrored on AUTH's `ACCOUNT_SUSPENDED`
> trade-off (auth doc 05 §3.3).

#### 2.4.2 `POST /api/v1/users/me/phone/verify` — confirm

**Request** (`Idempotency-Key` header + body)

```json
{ "challengeId": "<opaque>", "code": "482913" }
```

**Response `200`** — a fresh token pair for the calling device only.

```json
{
  "accessToken": "<jwt>",
  "accessTokenExpiresInSec": 900,
  "refreshToken": "<opaque>",
  "refreshTokenExpiresInSec": 2592000,
  "user": { "id": "<uuid>", "phoneNumber": "+919876500099", "status": "ACTIVE" }
}
```

- Uniqueness is re-checked **inside the write transaction**, not only at step 1 — two users racing
  for the same free number must not both win (USER-INV-3, 06 §4).
- `user.id` is **unchanged** — the response proves R-USER-11 to the client.
- Every prior session is revoked and the epoch bumped after commit, so all other devices get
  `401 TOKEN_STALE` on their next request (R-USER-13).
- **Idempotency:** a retry with the same key replays the stored pair; it does not re-consume the OTP
  and does not revoke the newly issued session.
- **Errors:** `401 OTP_INVALID`, `410 OTP_EXPIRED`, `429 OTP_LOCKED`, `409 PHONE_IN_USE` (lost the
  race), 401 family.
- **Events:** `user.phone.changed`, `account.recovery.completed` (`changedPhone: true`),
  `auth.session.revoked` × n.

---

### 2.5 Emergency contacts

| Method   | Path                                      | Response                    |
| -------- | ----------------------------------------- | --------------------------- |
| `GET`    | `/api/v1/users/me/emergency-contacts`     | `200` — array, priority asc |
| `POST`   | `/api/v1/users/me/emergency-contacts`     | `201` — the created contact |
| `PATCH`  | `/api/v1/users/me/emergency-contacts/:id` | `200` — the updated contact |
| `DELETE` | `/api/v1/users/me/emergency-contacts/:id` | `204`                       |

**Create/update body**

```json
{ "contactName": "Priya", "phoneNumber": "+919876500042", "relationship": "SPOUSE", "priority": 1 }
```

- `contactName` 1–64 chars; `phoneNumber` E.164; `relationship` optional free text ≤ 32;
  `priority` integer ≥ 1, default 1.
- Exceeding the configured cap → `409 LIMIT_EXCEEDED` with the cap in `details`.
- An `:id` belonging to another user → `404 NOT_FOUND` (R-USER-25).
- **No pagination.** The cap bounds the list (R-USER-22), so `GET` always returns the complete set.
  An unbounded collection is what would need a cursor; this one cannot become unbounded.
- **`DELETE` is idempotent in effect, not in status.** The first call returns `204`, a retry returns
  `404` — the item is genuinely gone. Clients must treat a `404` on delete-retry as success, not error.
- **Events:** `user.emergency_contact.added` / `.updated` / `.removed`.

---

### 2.6 Saved places

| Method   | Path                                | Response                  |
| -------- | ----------------------------------- | ------------------------- |
| `GET`    | `/api/v1/users/me/saved-places`     | `200` — array             |
| `POST`   | `/api/v1/users/me/saved-places`     | `201` — the created place |
| `PATCH`  | `/api/v1/users/me/saved-places/:id` | `200` — the updated place |
| `DELETE` | `/api/v1/users/me/saved-places/:id` | `204`                     |

**Create/update body**

```json
{
  "label": "Home",
  "address": "12 MG Road, Bengaluru",
  "buildingName": "Sunrise Apartments",
  "landmark": "opposite the metro station",
  "floor": "3B",
  "instructions": "Call on arrival, the gate is locked after 10pm",
  "latitude": 12.9716,
  "longitude": 77.5946
}
```

- `label` 1–32 chars, **unique per user** (case-insensitive) → `409 CONFLICT` on a duplicate.
- `latitude` ∈ [−90, 90], `longitude` ∈ [−180, 180], both required together, 7 decimal places.
- The PostGIS `location` column is derived server-side from lat/lng; the client never sends geometry.
- `instructions` ≤ 280 chars — it reaches a driver's screen, so it is bounded.
- **`GET` returns places ordered by `label` ascending, case-insensitive.** The per-user uniqueness of
  `lower(label)` (03 §5) makes that a stable total order with no tie-break, so the client renders the
  list as received. Contacts order by `priority` (§2.5, R-USER-23); places have no priority concept.
- **No pagination**, for the same reason as §2.5 — the cap bounds the list (R-USER-24).
- **`DELETE`** behaves as in §2.5: `204` then `404` on retry.
- **Events:** `user.saved_place.added` / `.updated` / `.removed`.

---

### 2.7 `POST /api/v1/users/me/deactivate` — leave

**Request** (optional body) `{ "reason": "NOT_USING" }` · **Response `204`**

- Refused with `409 ACCOUNT_HAS_OBLIGATIONS` while a ride is active, a wallet balance is unsettled, or
  a dispute is open; `details` names which (R-USER-21).
- Sets status `DEACTIVATED`, revokes all sessions, bumps the epoch — via AUTH's services, in one
  transaction (R-USER-29).
- Idempotent: deactivating an already-deactivated account is a no-op `204`.
- **Events:** `user.account.deactivated`.

### 2.8 `POST /api/v1/users/me/delete-request` — request erasure

**Response `202`** `{ "scheduledFor": "2026-08-28T00:00:00.000Z" }`

- Performs the §2.7 deactivation **and** records the request. Erasure itself is a retention job, never
  this endpoint (R-USER-19).
- **Events:** `user.account.deletion_requested`.

---

## 3. Guard wiring

USER registers **no** authentication logic. AUTH installs a global `onRequest` gate that authenticates
every matched route unless it declares `config: { public: true }` (auth doc 04 §3). This module
declares no public route, so every path above is authenticated by construction — including any route
added later by someone who forgets to think about it. That is the point of deny-by-default.

```ts
// src/modules/users/routes/user.routes.ts — mounted at /api/v1/users
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  const controller = new UserController(container.resolve<UserService>('userService'));

  // No `config: { public: true }` anywhere — the global gate protects all of these.
  app.get('/me', controller.getMe);
  app.patch('/me/profile', controller.updateProfile);
  app.post('/me/phone/change', controller.requestPhoneChange);
  app.post('/me/phone/verify', controller.verifyPhoneChange);
  // …contacts, places, deactivate
}
```

Two rules the handlers must follow, enforced by review and by 06 §4:

1. **The subject comes from `request.auth.userId`.** A handler that reads a user id from `params`,
   `query`, or `body` is a bug, not a feature.
2. **Ownership is a `WHERE` clause, not an `if`.** Scope the query by `userId` so a wrong id returns
   no row; do not fetch by id and then compare. The second form is one forgotten `return` away from a
   data leak.

Role guards are not used in this module — every endpoint is available to any authenticated, active
account regardless of role. Suspended and deactivated accounts are stopped by the epoch check in the
gate before a handler runs.

---

## 4. Status-code map (bodies → 04)

| Code | Meaning (user)                                   | Example error code                                          |
| ---- | ------------------------------------------------ | ----------------------------------------------------------- |
| 200  | OK                                               | —                                                           |
| 201  | Created (collection item)                        | —                                                           |
| 202  | Accepted, pending confirmation (phone, deletion) | —                                                           |
| 204  | OK, no content (delete, deactivate)              | —                                                           |
| 400  | Malformed / validation / immutable field         | `VALIDATION`, `IMMUTABLE_FIELD`                             |
| 401  | Bad/expired/stale/revoked credential             | `TOKEN_*`, `SESSION_REVOKED`, `OTP_INVALID`                 |
| 403  | Authenticated but account not permitted          | `ACCOUNT_SUSPENDED`                                         |
| 404  | Not found **or not owned**                       | `NOT_FOUND`                                                 |
| 409  | State conflict                                   | `PHONE_IN_USE`, `LIMIT_EXCEEDED`, `ACCOUNT_HAS_OBLIGATIONS` |
| 410  | OTP expired                                      | `OTP_EXPIRED`                                               |
| 429  | Rate-limited or OTP lockout                      | `RATE_LIMITED`, `OTP_LOCKED`                                |

---

## 5. Cross-cutting

- **Idempotency:** `phone/verify` and `deactivate` store their success response at `idem:{key}`
  (~24 h) and replay it on retry (NFR-RESIL-02) — both revoke sessions, so a dropped response must
  not cause a second revocation storm.
- **No personal data in logs** (NFR-PRIV): names, dates of birth, and phone numbers are never logged
  in full; log the `userId` and the changed **field names**.
- **Audit:** phone change, deactivation, and deletion requests are audit-class events written in the
  same transaction as the change (05 §4).

---

## 6. What 03–05 inherit

- **03 (database):** `user_profiles` created in the registration transaction; the per-user uniqueness
  of a saved-place label; the indexes the `WHERE userId` scoping in §3 depends on.
- **04 (errors):** bodies for `IMMUTABLE_FIELD`, `PHONE_UNCHANGED`, `PHONE_IN_USE`, `NOT_FOUND`,
  `LIMIT_EXCEEDED`, `ACCOUNT_HAS_OBLIGATIONS`, plus the reused AUTH codes.
- **05 (events):** schemas for `user.profile.*`, `user.phone.*`, `user.account.*`,
  `user.emergency_contact.*`, `user.saved_place.*`, and the reuse of `account.recovery.completed`.

---

## 7. Traceability

| Endpoint                  | Realizes                       |
| ------------------------- | ------------------------------ |
| `GET /me`                 | R-USER-3/8, USER-INV-2         |
| `PATCH /me/profile`       | R-USER-4/5/6/7, USER-INV-5     |
| `POST /me/phone/change`   | R-USER-9/10/12/15              |
| `POST /me/phone/verify`   | R-USER-11/13/14, USER-INV-3/4  |
| emergency contacts        | R-USER-22/23/25/26, USER-INV-7 |
| saved places              | R-USER-24/25/26, USER-INV-7    |
| `POST /me/deactivate`     | R-USER-16/20/21, USER-INV-6    |
| `POST /me/delete-request` | R-USER-18/19                   |
| guard wiring              | R-USER-8, AUTH doc 04 §3       |

**Next: 03_USER_DATABASE_SPEC** — the models these endpoints read and write, the constraints that make
the invariants structural, and the indexes the ownership scoping needs.
