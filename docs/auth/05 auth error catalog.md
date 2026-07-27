# AUTH — Error Catalog

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `auth` · **Doc:** 05 of the AUTH chain · **Stack:** Fastify / TypeScript (ADR-0006)
> **Status:** 🟢 Final (v1) · **Owner:** Engineering (Auth) · **Last updated:** 2026-07-27
> **Answers:** _What does every auth failure look like on the wire, and how should the client react?_
> **Traces from:** [04_API_SPEC](04_AUTH_API_SPEC.md) (+ 01/02) · **Traces to:** 06_EVENT_CATALOG · 07_TEST_PLAN

---

## 1. Error envelope

Every auth error uses one shape (platform convention):

```json
{
  "error": {
    "code": "OTP_INVALID",
    "messageKey": "auth.otp.invalid",
    "message": "The code you entered is incorrect.",
    "requestId": "req_8f2c…",
    "retryAfterSec": 60,
    "details": [{ "field": "phoneNumber", "code": "INVALID_FORMAT" }]
  }
}
```

- **`code`** — stable machine string (never localized); clients branch on this, never on `message`.
- **`messageKey`** — i18n key resolved against the user's `locale` (NFR-11, A6.4); `message` is the
  resolved fallback (English).
- **`retryAfterSec`** — present on `429` only; mirrors the `Retry-After` header.
- **`details`** — field-level errors; `VALIDATION` only.
- **Never** contains: OTP codes, tokens, stack traces, internal identifiers, or anything that reveals
  whether a phone/account exists (§3).

---

## 2. Catalog

| Code                  | HTTP | Fires when                                                   |   Enum-safe    | Client action                                                            |
| --------------------- | ---- | ------------------------------------------------------------ | :------------: | ------------------------------------------------------------------------ |
| `VALIDATION`          | 400  | Malformed body / bad phone / bad code shape                  |      n/a       | Show `details` inline; don't retry blindly.                              |
| `OTP_INVALID`         | 401  | Wrong code **or** no matching challenge/account (**merged**) |     ✅ yes     | Let user re-enter; count toward lockout.                                 |
| `OTP_EXPIRED`         | 410  | Code TTL passed                                              |     ✅ yes     | Prompt **resend**.                                                       |
| `OTP_LOCKED`          | 429  | 5 failed verifies → phone/device locked (doc 02 §4.3)        |     ✅ yes     | Show cooldown from `retryAfterSec`; disable input.                       |
| `RATE_LIMITED`        | 429  | Send/verify throttle hit (doc 02 §4.2)                       |     ✅ yes     | Show cooldown; back off.                                                 |
| `TOKEN_INVALID`       | 401  | Unknown/expired/malformed access or refresh token            |       —        | Access → try refresh; refresh → **re-login**.                            |
| `TOKEN_STALE`         | 401  | Access-token `epoch` ≠ current (suspension/role change)      |       —        | Try refresh **once**: success → continue; failure → **re-login**.        |
| `TOKEN_REUSE`         | 401  | Consumed refresh token replayed → family revoked (INV-5)     |       —        | **Hard logout**: clear tokens, show "signed out for security", re-login. |
| `SESSION_REVOKED`     | 401  | `sid` revoked (logout elsewhere / cap-evict / device revoke) |       —        | Clear tokens; **re-login**.                                              |
| `FORBIDDEN`           | 403  | Authenticated, missing required role / not operable          |       —        | Show "not permitted"; if `DRIVER_NOT_OPERABLE`, route to onboarding.     |
| `ACCOUNT_SUSPENDED`   | 403  | Correct credential but account `SUSPENDED`                   | ⚠️ post-verify | Show suspended screen + support contact.                                 |
| `SERVICE_UNAVAILABLE` | 503  | Auth infra (Redis) down → **fail closed** (doc 02 §7)        |     ✅ yes     | Generic "try again shortly"; never treated as success.                   |
| `INTERNAL`            | 500  | Unexpected                                                   |     ✅ yes     | Generic retry-later; `requestId` for support.                            |

---

## 3. Enumeration-safety rules (R-AUTH-19 — non-negotiable)

The attacker must not learn "is this phone registered?" from any response.

1. **`/otp/send` is uniform** — existing and non-existing phones both get `200` with an identical body
   (§2.1 of doc 04). There is **no** "user not found" error on send.
2. **`OTP_INVALID` is merged** — "wrong code", "no such challenge", and "no account for this phone"
   all return the **same** `OTP_INVALID` body with the **same timing** (do equivalent hash/compare work
   on the miss path, doc 02 §4.4). Never a distinct "account not found".
3. **`ACCOUNT_SUSPENDED` is the one deliberate existence-reveal** — but it fires **only after a
   correct OTP**, so an attacker would already need the code. The owner genuinely needs to know they're
   suspended (to contact support), so this trade-off is accepted and scoped to the post-verification
   path only.
4. **Lockout/rate-limit errors don't leak existence** — they key on phone/device/IP regardless of
   whether an account exists, so `OTP_LOCKED` / `RATE_LIMITED` reveal nothing about registration.

---

## 4. The 401 family — client handling matters

These four all return `401` but demand **different** client behavior; branching on `code` (not status)
is required:

- **`TOKEN_INVALID`** (access expired) → the normal case; silently refresh and retry the request.
- **`TOKEN_STALE`** (epoch bumped) → _why_ it bumped decides the outcome: a **role change** lets refresh
  succeed with a fresh epoch (continue seamlessly); a **suspension** makes refresh fail too → re-login.
  The client tries refresh once and lets the result decide.
- **`TOKEN_REUSE`** → a security event, not a routine expiry. The family is already dead server-side;
  the client must **discard all tokens** and surface a security notice, because either this device or
  another was compromised.
- **`SESSION_REVOKED`** → this specific device was signed out (logged out elsewhere, evicted by the
  5-cap, or its device revoked); clear and re-login, no security alarm.

> Collapsing these into one "please log in again" is a real UX/security regression — `TOKEN_REUSE`
> deserves a different message from a routine `SESSION_REVOKED`.

---

## 5. Hygiene rules (apply to every error)

- **No secrets, ever** (R-AUTH-18): codes, tokens, pepper, internal IDs, SQL, stack traces are never
  in an error body or client-visible log.
- **Fail closed** (doc 02 §7): when a dependency needed to _authorize safely_ is unavailable, return
  `503 SERVICE_UNAVAILABLE` — never fall through to success.
- **Localized** (NFR-11): the client renders `messageKey`; the server's `message` is only a fallback.
- **Traceable** (NFR-8): every error carries `requestId`; sensitive-action failures still audit.
- **Consistent status semantics** (doc 04 §4): `401` = credential problem, `403` = identity is fine
  but not permitted, `429` = slow down.

---

## 6. Traceability

| Rule / code group                   | Realizes                       |
| ----------------------------------- | ------------------------------ |
| Merged `OTP_INVALID`, uniform send  | R-AUTH-19, doc 02 §4.4         |
| `OTP_LOCKED` / `RATE_LIMITED`       | R-AUTH-8/9/20, doc 02 §4.2/4.3 |
| `TOKEN_STALE` (epoch)               | R-AUTH-7/12/16, AUTH-INV-3     |
| `TOKEN_REUSE`                       | R-AUTH-5, AUTH-INV-5           |
| `SESSION_REVOKED`                   | R-AUTH-6/24, AUTH-INV-4/6      |
| `FORBIDDEN` (+ driver not operable) | R-AUTH-15/23, AUTH-INV-7       |
| `ACCOUNT_SUSPENDED`                 | R-ACCOUNT-4, R-AUTH-12         |
| no-secrets / fail-closed / i18n     | R-AUTH-18, NFR-7/8/11          |

**Next: 06_AUTH_EVENT_CATALOG** — the envelope and payload schema for each event these endpoints emit,
and which are audit vs domain vs observability.
