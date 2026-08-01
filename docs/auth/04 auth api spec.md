# AUTH — API Specification

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `auth` · **Doc:** 04 of the AUTH chain · **Stack:** Fastify / TypeScript (ADR-0006)
> **Status:** 🟢 Final (v1) · **Owner:** Engineering (Auth) · **Last updated:** 2026-08-02
> **Answers:** _What are the exact endpoints, request/response shapes, and route-guard wiring?_
> **Traces from:** [01_BR](01_AUTH_BUSINESS_REQUIREMENTS.md) · [02_SECURITY](02_AUTH_SECURITY_SPEC.md) · [03_DATABASE](03_AUTH_DATABASE_SPEC.md)
> **Traces to:** 05_AUTH_ERROR_CATALOG (error bodies) · 06_AUTH_EVENT_CATALOG (event schemas) · 07_AUTH_TEST_PLAN

---

## 1. Scope & conventions

Nine endpoints — four public/near-public credential flows (§2.1–2.4) and five authenticated
self-service ones for sessions and devices (§2.5–2.6) — plus the shared auth guard every other module
consumes. This doc fixes the **contracts**; error _bodies_ are 05, event _schemas_ are 06.

| Convention      | Rule                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| Base path       | `/api/v1/auth/*` (platform API-versioning convention)                                                            |
| Transport       | HTTPS only; JSON (`application/json`)                                                                            |
| Access token    | `Authorization: Bearer <jwt>` (doc 02 §3.1)                                                                      |
| Refresh token   | in request/response **body**, stored in device secure storage (Keychain/Keystore) — not cookies (mobile clients) |
| Idempotency     | `Idempotency-Key: <uuid>` on **verify** and **refresh** (NFR-RESIL-02); stored at `idem:{key}` ~24 h             |
| Request tracing | `X-Request-Id` echoed; every auth decision is traceable (NFR-8)                                                  |
| Rate limiting   | `429` with `Retry-After`; limits per doc 02 §4.2                                                                 |
| Phone format    | E.164 (`+91…`); validated (`400 VALIDATION` on failure)                                                          |

---

## 2. Endpoints

### 2.1 `POST /api/v1/auth/otp/send` — request an OTP

- **Auth:** public. **Rate-limited** per phone + device + IP (doc 02 §4.2).
- **Enumeration-resistant (R-AUTH-19):** the response is **identical** whether or not the phone maps
  to an existing account. Account creation happens on _verify_, not here.

**Request**

```json
{
  "phoneNumber": "+919876543210",
  "device": {
    "deviceId": "a1b2c3",
    "platform": "ANDROID",
    "appVersion": "1.4.0",
    "osVersion": "14",
    "fingerprint": "…",
    "isRooted": false,
    "isJailbroken": false
  }
}
```

**Response `200`** (uniform)

```json
{ "challengeId": "<opaque>", "expiresInSec": 300, "resendAvailableInSec": 60 }
```

- **Errors:** `400 VALIDATION` (bad phone), `429 RATE_LIMITED`.
- **Events:** `auth.otp.requested`, then `auth.otp.sent` on provider acceptance.

---

### 2.2 `POST /api/v1/auth/otp/verify` — verify OTP, issue session

- **Auth:** public. **`Idempotency-Key` required.**
- On **first** successful verify: creates the `users` row (status `UNVERIFIED → ACTIVE`), grants the
  `customer` role, binds the `user_devices` row, opens a `user_sessions` + first `refresh_tokens`.
- On a **returning** verify: opens a new session (subject to the 5-cap, doc 02 §5.1).

**Request** (`Idempotency-Key` header + body)

```json
{
  "phoneNumber": "+919876543210",
  "code": "482913",
  "challengeId": "<opaque>",
  "device": { "deviceId": "a1b2c3", "platform": "ANDROID" }
}
```

**Response `200`**

```json
{
  "accessToken": "<jwt>",
  "accessTokenExpiresInSec": 900,
  "refreshToken": "<opaque>",
  "refreshTokenExpiresInSec": 2592000,
  "user": { "id": "<uuid>", "status": "ACTIVE", "roles": ["customer"], "isNew": true }
}
```

- **Idempotency:** a retry with the same `Idempotency-Key` returns the **stored** token set — it does
  **not** re-consume the (single-use) OTP. Without the key, the second attempt fails because the OTP
  was consumed (AUTH-INV-2).
- **Errors:** `400 VALIDATION`, `401 OTP_INVALID` (wrong code), `410 OTP_EXPIRED`,
  `429 OTP_LOCKED` (5-fail lockout, doc 02 §4.3). Bodies → 05.
- **Events:** `auth.otp.verified`, `auth.login.succeeded`, `auth.session.created`; on first verify
  also `account.role.granted` (customer).

---

### 2.3 `POST /api/v1/auth/token/refresh` — rotate the session

- **Auth:** the **refresh token** itself. **`Idempotency-Key` required** — it is what distinguishes a
  legitimate retry from an attack (see the callout).
- **Rotation (R-AUTH-5):** a valid, unconsumed token is consumed and a new access+refresh pair
  issued.

**Request**

```json
{ "refreshToken": "<opaque>" }
```

**Response `200`**

```json
{
  "accessToken": "<jwt>",
  "accessTokenExpiresInSec": 900,
  "refreshToken": "<new opaque>",
  "refreshTokenExpiresInSec": 2592000
}
```

> **The retry-vs-theft distinction (important).** After rotation, if the client's _response_ is lost,
> it will retry with the **now-consumed** old token. That looks identical to an attacker replaying a
> **stolen** consumed token — but the consequences must differ:
>
> - **Same `Idempotency-Key`** as the rotation that consumed it → **replay**: return the stored new
>   pair from `idem:{key}`. No family revoke.
> - **Consumed token, no matching key** → **theft** (AUTH-INV-5): revoke the **entire family**, bump
>   the user epoch (doc 02 §3.3), `401 TOKEN_REUSE`.
>
> Without the idempotency key, a dropped-response retry would nuke the honest user's session. The key
> is not optional here.

- **Errors:** `401 TOKEN_INVALID` (unknown/expired), `401 TOKEN_REUSE` (family revoked).
- **Events:** `auth.token.refreshed`; or on reuse `auth.refresh.reuse_detected` + `auth.session.revoked` (family).

---

### 2.4 `POST /api/v1/auth/logout` — end session(s)

- **Auth:** required (`Bearer`).
- **Default:** revokes the **current** session (`sid` → `revoked_at`, denylisted). **`allDevices: true`**
  bumps the user epoch (doc 02 §3.3) → every device signed out.

**Request** (optional body) `{ "allDevices": false }` · **Response `204`** (idempotent — revoking an
already-revoked session is a no-op).

- **Events:** `auth.session.revoked` (one `sid`, or family on `allDevices`).

---

### 2.5 Session self-service

| Method   | Path                            | Response                    |
| -------- | ------------------------------- | --------------------------- |
| `GET`    | `/api/v1/auth/me/sessions`      | `200` — array, oldest first |
| `DELETE` | `/api/v1/auth/me/sessions/{id}` | `204`                       |
| `DELETE` | `/api/v1/auth/me/sessions`      | `204` — all, epoch bumped   |

**Response `200`** — each entry:

```json
{
  "id": "<sid>",
  "deviceId": "<uuid|null>",
  "ipAddress": "203.0.113.4",
  "userAgent": "Zaroorat/1.4 (Android 14)",
  "loginMethod": "otp",
  "createdAt": "…",
  "lastSeenAt": "…",
  "expiresAt": "…",
  "current": true
}
```

- **Auth:** required on all three; the subject is always `request.auth.userId` (R-AUTH-11).
- `current` marks the caller's own `sid`, so a client can warn before signing itself out.
- Revoking **one** session denylists that `sid` only; revoking **all** bumps the epoch, exactly as
  `logout { allDevices: true }` does.
- **Events:** `auth.session.revoked` per affected `sid`.

### 2.6 Device self-service (R-DEVICE-3, AUTH-INV-6)

| Method   | Path                           | Response                          |
| -------- | ------------------------------ | --------------------------------- |
| `GET`    | `/api/v1/auth/me/devices`      | `200` — array, most recently seen |
| `DELETE` | `/api/v1/auth/me/devices/{id}` | `204`                             |

**Response `200`** — each entry:

```json
{
  "id": "<uuid>",
  "deviceId": "<client-reported id|null>",
  "platform": "ANDROID",
  "trustState": "REGISTERED",
  "isRooted": false,
  "isJailbroken": false,
  "appVersion": "1.4.0",
  "osVersion": "14",
  "lastSeenAt": "…",
  "createdAt": "…",
  "current": true
}
```

- **`device_fingerprint` is never returned.** It is a signal AUTH matches against, so echoing it
  makes it readable from one compromised session and replayable from another (R-DEVICE-5).
- **Revoked devices stay in the list**, carrying `trustState: "REVOKED"`. Hiding a revocation hides
  the security event the user most needs to see.
- Revoking a device marks it `REVOKED` **and ends every session bound to it** (AUTH-INV-6). It
  re-registers on its next verified login (R-DEVICE-3) — it cannot restore itself.
- Revoking the **calling** device signs the caller out; that is the intended lost-phone flow, and
  `current` is what lets a client confirm first.
- **Events:** `auth.device.revoked` (`actor: "self"` here; `"system"` for ops), plus
  `auth.session.revoked` per session ended.

> **Unknown and not-owned are one answer.** On both `DELETE` paths, an id belonging to another
> account and an id that never existed return **byte-identical** bodies — confirming that someone
> else's session or device exists is an enumeration oracle. Note the status is `400 VALIDATION`,
> **not** the `404 NOT_FOUND` the USER module uses for the same shape (user doc 04 §2.1). Both are
> enumeration-safe; the divergence is real and worth settling in one direction.

---

## 3. The shared auth guard (Fastify wiring — realizes doc 02 §6)

Auth exposes two decorators the whole monolith consumes. Authentication is **deny-by-default**: a
global `onRequest` gate authenticates every matched route, so a route opts out only by declaring
`config: { public: true }`. Authorization (roles + the driver conjunction) is applied per route as a
`fastify.authorize({ ... })` preHandler.

```ts
// fastify.authenticate — steps 1–4 of doc 02 §6 (deny-by-default, R-AUTH-14).
// Installed as a global onRequest gate that skips routes marked config.public.
async function authenticate(req, reply) {
  const jwt = getBearer(req); // 401 if missing / bad signature
  const claims = verifyHS256(jwt); // stateless
  const epoch = await redis.get(`auth:epoch:${claims.sub}`);
  if (String(claims.epoch) !== epoch) return reply.code(401).send(err('TOKEN_STALE')); // suspension / role change
  if (await redis.sismember(`auth:sid:revoked`, claims.sid))
    // logout / cap-evict
    return reply.code(401).send(err('SESSION_REVOKED'));
  req.auth = { userId: claims.sub, sid: claims.sid, roles: claims.roles };
}

// fastify.authorize({ roles, requireOperableDriver, requireUntamperedDevice })
// — a preHandler factory: role guard, the driver conjunction (R-AUTH-15/23,
// AUTH-INV-7), and the root/jailbreak refusal (doc 02 §5.2, R-DEVICE-5).
function authorize({ roles: need = [], requireOperableDriver, requireUntamperedDevice }) {
  return async (req, reply) => {
    if (need.length && !need.some((r) => req.auth.roles.includes(r)))
      return reply.code(403).send(err('FORBIDDEN'));
    // requireUntamperedDevice resolves the device from the calling SESSION, not a
    // claim: the token carries no device, and a flag minted at login would keep
    // its access until the token expired. A session with no device binding is
    // DENIED — "cannot assess" must not resolve to "allowed" here.
    // requireOperableDriver is checked LIVE against the driver domain, not the token:
    //   -> drivers.verification_status = 'VERIFIED' (and not suspended) AND account = active (R-AUTH-23)
  };
}
```

**Route declaration pattern** (example lives in the `rides` module, guard is auth's). The global gate
authenticates it; only `authorize` is wired per route:

```ts
fastify.post(
  '/api/v1/rides/:id/accept',
  { preHandler: [fastify.authorize({ roles: ['driver'], requireOperableDriver: true })] },
  acceptRideHandler,
);
```

- **Suspension is immediate** (AUTH-INV-3): suspend bumps the epoch → step 2 rejects the next request,
  even mid-token-lifetime.
- **Operability is never in the token** — `requireOperableDriver` forces a live
  `drivers.verification_status` read, because a driver's approval can flip independently of their
  session.
- **Device integrity is never in the token either** — `requireUntamperedDevice` reads the device the
  calling session is bound to, so a handset that becomes rooted loses the sensitive subset on its
  **next** request rather than at token expiry. Normal authentication is unaffected: doc 02 §5.2's
  v1 policy is capture, allow ordinary use, deny the sensitive subset. **The list of sensitive
  actions belongs to each module; AUTH only enforces the flag** — the phone-number change opts in
  (user doc 02 §2.4), and that is the whole list today.

---

## 4. Status-code map (bodies → 05)

| Code | Meaning (auth)                              | Example error code                          |
| ---- | ------------------------------------------- | ------------------------------------------- |
| 200  | OK                                          | —                                           |
| 204  | OK, no content (logout)                     | —                                           |
| 400  | Malformed / validation                      | `VALIDATION`                                |
| 401  | Bad/expired/stale/reused credential         | `TOKEN_*`, `OTP_INVALID`, `SESSION_REVOKED` |
| 403  | Authenticated but wrong role / not operable | `FORBIDDEN`                                 |
| 410  | OTP expired                                 | `OTP_EXPIRED`                               |
| 429  | Rate-limited or OTP lockout                 | `RATE_LIMITED`, `OTP_LOCKED`                |

`429` carries `Retry-After`. Auth **never leaks** whether a phone exists via status or body (§2.1, R-AUTH-19).

---

## 5. Cross-cutting

- **Idempotency:** `verify` and `refresh` store their success response at `idem:{key}` (~24 h); retries
  replay it (NFR-RESIL-02). `send` is not keyed (a resend is a resend, rate-limited instead).
- **No secret in any response or log** (R-AUTH-18): OTP codes and raw refresh tokens appear only where
  spec'd (refresh token in its issuing response body); never echoed in errors.
- **Audit:** logout-all, device revocation, and any admin-initiated revoke/suspend routes (owned by
  `admin`) write their audit-class event to `outbox_events` in the same transaction as the change
  (R-AUTH-21); admin-initiated actions additionally write `admin_activity_logs`. See doc 03 §6 —
  there is no `audit_log` table.

---

## 6. What 05 & 06 inherit

- **05 (errors):** concrete bodies for `VALIDATION`, `OTP_INVALID`, `OTP_EXPIRED`, `OTP_LOCKED`,
  `RATE_LIMITED`, `TOKEN_INVALID`, `TOKEN_STALE`, `TOKEN_REUSE`, `SESSION_REVOKED`, `FORBIDDEN` — with
  the enumeration-resistance rule that `send`/`verify` failures stay generic.
- **06 (events):** schemas for the events emitted above — `auth.otp.requested/sent/verified`,
  `auth.login.succeeded/failed`, `auth.session.created/revoked`, `auth.token.refreshed`,
  `auth.refresh.reuse_detected`, `account.role.granted` (Appendix C of doc 01 is the seed).

---

## 7. Traceability

| Endpoint / guard           | Realizes                                      |
| -------------------------- | --------------------------------------------- |
| `/otp/send`                | R-AUTH-1/2/9/19/20, doc 02 §4                 |
| `/otp/verify`              | R-AUTH-1/3/10, AUTH-INV-2, R-ACCOUNT-6        |
| `/token/refresh`           | R-AUTH-4/5/10, AUTH-INV-5, doc 02 §3.2        |
| `/logout` (+ allDevices)   | R-AUTH-6/11, AUTH-INV-4, doc 02 §3.3          |
| `/me/sessions` (§2.5)      | R-AUTH-11, AUTH-INV-4, doc 02 §5.1            |
| `/me/devices` (§2.6)       | R-DEVICE-1/3/5, AUTH-INV-6, doc 02 §5.2       |
| `authenticate` hook        | R-AUTH-7/12/14/16, AUTH-INV-3, doc 02 §3.3/§6 |
| `authorize` + driver conj. | R-AUTH-15/17/23, AUTH-INV-7                   |
| `authorize` + device conj. | R-DEVICE-5, doc 02 §5.2                       |
| idempotency handling       | NFR-6, NFR-RESIL-02                           |

**Next: 05_AUTH_ERROR_CATALOG** — the concrete error bodies, codes, and the enumeration-safe
messaging rules for every failure above.
