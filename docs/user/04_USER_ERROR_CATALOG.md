# USER — Error Catalog

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `users` · **Doc:** 04 of the USER chain · **Stack:** Fastify / TypeScript (ADR-0006)
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Identity) · **Last updated:** 2026-07-29
> **Answers:** _What does every user-module failure look like on the wire, and how should the client react?_
> **Traces from:** [02_API](02_USER_API_SPEC.md) §4 · [03_DB](03_USER_DATABASE_SPEC.md) §8 · [AUTH 05](../auth/05%20auth%20error%20catalog.md) (the envelope and the reused codes)
> **Traces to:** 05_USER_EVENT_CATALOG · 06_USER_TEST_PLAN §5

---

## 1. Envelope — shared with AUTH, unchanged

USER does **not** define its own error shape. It reuses the platform envelope already implemented in
`src/modules/auth/http/error-response.ts`:

```json
{
  "error": {
    "code": "LIMIT_EXCEEDED",
    "messageKey": "user.emergency_contact.limit_exceeded",
    "message": "You can save up to 5 emergency contacts.",
    "requestId": "req_8f2c…",
    "retryAfterSec": 60,
    "details": [{ "field": "priority", "code": "OUT_OF_RANGE" }]
  }
}
```

- **`code`** — stable machine string; clients branch on this, never on `message`.
- **`messageKey`** — i18n key, resolved against the user's `languageCode` (R-USER-7, NFR-11).
- **`retryAfterSec`** — `429` only; mirrors the `Retry-After` header.
- **`details`** — field-level errors on `VALIDATION` and `IMMUTABLE_FIELD`; the cap on `LIMIT_EXCEEDED`;
  the blocking obligation on `ACCOUNT_HAS_OBLIGATIONS`.
- **Never** contains: a profile value, an address, a contact's phone number, an OTP, a token, a stack
  trace, or an internal identifier (§5).

The status map extends `AUTH_ERROR_STATUS` with the USER-only codes in §2; the resolver keeps the same
shape so one error handler serves both modules.

---

## 2. Catalog

### 2.1 USER-specific codes

| Code                      | HTTP | Fires when                                                                     | Client action                                                                                   |
| ------------------------- | ---- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `IMMUTABLE_FIELD`         | 400  | A `PATCH` body carries a field this module never lets a user set (02 §2.2)     | **Fix the client.** This is a programming error, not a user error — do not surface it verbatim. |
| `PHONE_UNCHANGED`         | 400  | Phone-change request where the new number equals the current one               | Show inline on the field; no request was sent.                                                  |
| `PHONE_IN_USE`            | 409  | The target number belongs to another **active** account (03 §4.2)              | Tell the user the number is already registered; offer support.                                  |
| `NOT_FOUND`               | 404  | A collection item does not exist **or is not owned** (R-USER-25)               | Refresh the list; the item is gone.                                                             |
| `CONFLICT`                | 409  | A saved-place label already exists for this user (case-insensitive)            | Ask for a different label; suggest editing the existing one.                                    |
| `LIMIT_EXCEEDED`          | 409  | The per-user cap on contacts or places is reached                              | Show the cap from `details`; prompt to remove one first.                                        |
| `ACCOUNT_HAS_OBLIGATIONS` | 409  | Deactivation attempted with an active ride, unsettled balance, or open dispute | Show which obligation from `details` and deep-link to it.                                       |

### 2.2 Reused platform codes (defined in AUTH 05 §2)

| Code                  | HTTP | Fires here when                                                                    |
| --------------------- | ---- | ---------------------------------------------------------------------------------- |
| `VALIDATION`          | 400  | Any malformed body — bad date, bad E.164, out-of-range coordinate, oversize string |
| `OTP_INVALID`         | 401  | Wrong code on `phone/verify`                                                       |
| `OTP_EXPIRED`         | 410  | The phone-change challenge's TTL passed                                            |
| `OTP_LOCKED`          | 429  | Repeated failed phone-change verifications                                         |
| `RATE_LIMITED`        | 429  | Phone-change requests exceeded the per-account limit (R-USER-15)                   |
| `TOKEN_INVALID`       | 401  | Missing/expired/malformed access token — from the global gate                      |
| `TOKEN_STALE`         | 401  | Epoch bumped — **including by this module's own phone change** (§4)                |
| `SESSION_REVOKED`     | 401  | The caller's `sid` was revoked                                                     |
| `FORBIDDEN`           | 403  | Reserved; no role guard exists in this module today                                |
| `ACCOUNT_SUSPENDED`   | 403  | Correct credential, account `SUSPENDED` or `DEACTIVATED`                           |
| `SERVICE_UNAVAILABLE` | 503  | Redis or a dependency needed to answer safely is down → **fail closed**            |
| `INTERNAL`            | 500  | Unexpected                                                                         |

USER adds no new `401`. Every authentication failure here comes from AUTH's gate, with AUTH's code and
AUTH's client-handling rules (auth doc 05 §4) — the client needs one implementation, not two.

---

## 3. The three 409s are not interchangeable

They share a status because they are all state conflicts, but the client must branch on `code`:

- **`PHONE_IN_USE`** — someone else owns the number. The user's only path forward is a different
  number or support. Terminal for this attempt.
- **`CONFLICT`** (saved-place label) — trivially recoverable; the user renames and retries. Never
  show a security-flavoured message for it.
- **`LIMIT_EXCEEDED`** — recoverable by deleting something. The cap belongs in `details` so the copy
  can say "5 of 5 used" without hard-coding a number that lives in config (R-USER-26).
- **`ACCOUNT_HAS_OBLIGATIONS`** — not the user's mistake at all; something is genuinely in flight.
  `details` names the blocking module so the client can link straight to it.

Collapsing these into one "conflict" toast is a real UX regression: three of the four have a specific
next action, and the fourth is the only one that should ever mention support.

---

## 4. `TOKEN_STALE` after a successful phone change is expected, not an error

`POST /me/phone/verify` succeeds, returns a fresh token pair — and simultaneously invalidates every
other session on the account, including any in-flight request from another device (R-USER-13).

Clients must therefore treat `TOKEN_STALE` immediately after a phone change as **normal**: the calling
device already holds new tokens and must use them; every other device follows AUTH's standard handling
(try refresh once; on failure, re-login). A client that retries the old access token in a loop will
hammer the gate and show a spurious error — this is the one place where the response body and the
subsequent `401` are both correct at the same time.

---

## 5. Privacy rules (NFR-PRIV — apply to every error)

USER handles more personal data than AUTH does, so its hygiene rules are stricter in one respect:

- **No personal value is ever echoed in an error.** `VALIDATION` on `dateOfBirth` says the field and
  the rule (`MUST_BE_PAST`), never the submitted date. `details[].field` and `details[].code`, never
  `details[].value`. Error bodies end up in client crash reports and support screenshots.
- **No third-party data.** An emergency contact is personal data about someone who never agreed to
  platform terms; their name and number never appear in an error, a log, or an event.
- **`NOT_FOUND` reveals nothing.** Another user's item id and a random UUID produce byte-identical
  responses (R-USER-25). This is object-level enumeration resistance, the same discipline AUTH applies
  to phone numbers.
- **No secrets, ever** (R-AUTH-18): the phone-change OTP, tokens, and internal ids stay out of every
  body and every log line.
- **Fail closed:** when a dependency needed to answer safely is down, return `503` — never fall
  through to a partial success (auth doc 02 §7).

---

## 6. Validation `details` vocabulary

`VALIDATION` and `IMMUTABLE_FIELD` carry a stable, non-localized `details` array so clients can
highlight fields without parsing prose.

| `code`              | Meaning                                 | Example field  |
| ------------------- | --------------------------------------- | -------------- |
| `REQUIRED`          | Field missing                           | `contactName`  |
| `INVALID_FORMAT`    | Shape wrong (E.164, BCP-47, URL, date)  | `phoneNumber`  |
| `TOO_LONG`          | Exceeds the maximum length              | `instructions` |
| `OUT_OF_RANGE`      | Numeric bound violated                  | `latitude`     |
| `MUST_BE_PAST`      | Date is not in the past                 | `dateOfBirth`  |
| `AGE_BELOW_MINIMUM` | Under the minimum age                   | `dateOfBirth`  |
| `NOT_ALLOWED`       | Value outside the accepted set          | `gender`       |
| `IMMUTABLE`         | Field cannot be set through this module | `phoneNumber`  |
| `UNTRUSTED_HOST`    | URL is not on a platform-owned host     | `profileImage` |

---

## 7. Traceability

| Code / rule                       | Realizes                                    |
| --------------------------------- | ------------------------------------------- |
| `IMMUTABLE_FIELD`                 | R-USER-6, USER-INV-5                        |
| `PHONE_UNCHANGED`, `PHONE_IN_USE` | R-USER-10/12, USER-INV-3, 03 §4.2           |
| `NOT_FOUND` (not `403`)           | R-USER-25, USER-INV-2                       |
| `CONFLICT` (label)                | 02 §2.6, 03 §5 `uq_saved_places_user_label` |
| `LIMIT_EXCEEDED`                  | R-USER-22/24/26, USER-INV-7                 |
| `ACCOUNT_HAS_OBLIGATIONS`         | R-USER-21                                   |
| `TOKEN_STALE` handling (§4)       | R-USER-13, USER-INV-4                       |
| privacy rules (§5)                | NFR-PRIV, NFR-7, R-AUTH-18                  |
| reused AUTH codes                 | AUTH doc 05 §2/§4                           |

**Next: 05_USER_EVENT_CATALOG** — the envelope and payload for every event these flows emit, and which
of them are audit-class.
