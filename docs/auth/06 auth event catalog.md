# AUTH — Event Catalog

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `auth` · **Doc:** 06 of the AUTH chain · **Stack:** Node.js / Fastify / Prisma (ADR-0006)
> **Status:** 🟢 Final (v1) · **Owner:** Engineering (Auth) · **Last updated:** 2026-08-02
> **Answers:** _What events does AUTH emit, what is in each payload, and what are the delivery and audit guarantees?_
> **Traces from:** [01_BR](01%20auth%20business%20requirements.md) Appendix C · [02_SECURITY](02%20auth%20security%20spec.md) · [04_API](04%20auth%20api%20spec.md) §6
> **Traces to:** 07_AUTH_TEST_PLAN

---

## 1. Purpose & scope

This is the **canonical contract** for every event the AUTH module publishes. Doc 01 Appendix C was a
seed; **this doc wins** where they differ. It fixes the envelope, each payload schema, the
classification (audit / domain / observability), and the delivery guarantees so consumers
(`notifications`, `admin` audit, analytics, the fraud trail) can integrate without reading auth code.

**In scope:** the event envelope, payload schemas, ordering/delivery semantics, the audit subset, and
the no-secrets rule for payloads.

**Out of scope:** the transport implementation (outbox → broker), consumer business logic, and the
notification templates triggered by these events (owned by `notifications`).

---

## 2. Delivery model — transactional outbox

Auth writes state and its events in **one database transaction** via an **outbox** row
(`outbox` table, shared infra), which a relay publishes at-least-once to the broker. This gives:

- **Atomicity** — an event is never emitted for a change that rolled back, and a committed change
  never loses its event (no dual-write gap). Critical for audit (R-AUTH-21).
- **At-least-once delivery** — consumers **must be idempotent**, keyed on `eventId`.
- **Per-subject ordering** — events for one `userId` publish in commit order; there is no global
  order guarantee across users.

> **Audit events are non-negotiable.** Events classified **audit** (§4) are written in the _same
> transaction_ as the change they record. If the outbox write fails, the change fails. Observability
> events may be best-effort.

---

## 3. Envelope

Every auth event shares one envelope (platform convention). Names follow the repo's **dotted
lowercase** domain-event convention (`auth.otp.verified`, `account.suspended`) — never
SCREAMING_SNAKE.

```json
{
  "eventId": "<uuid v7>",
  "type": "auth.otp.verified",
  "version": 1,
  "occurredAt": "2026-07-27T10:15:03.221Z",
  "producer": "auth",
  "subject": { "userId": "<uuid|null>" },
  "correlation": { "requestId": "req_8f2c…", "sessionId": "<uuid|null>" },
  "data": {/* per-event payload — §5 */}
}
```

| Field            | Rule                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `eventId`        | Unique per event; consumers dedupe on it (at-least-once, §2).                              |
| `type`           | Stable machine string; consumers branch on this.                                           |
| `version`        | Integer; bumped on a **breaking** payload change (§7). v1 for everything here.             |
| `occurredAt`     | ISO-8601 UTC, set at commit time.                                                          |
| `subject.userId` | The identity the event is about; **null** only pre-account (e.g. OTP on an unknown phone). |
| `correlation`    | `requestId` for tracing (NFR-8); `sessionId` where a session context exists.               |
| `data`           | Payload; **never** contains a secret (§6).                                                 |

---

## 4. Classification

| Class             | Meaning                                                                                                                  | Guarantee          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| **audit**         | Legally/operationally significant; written to `outbox_events` in the change's own transaction (R-AUTH-21/28, doc 03 §6). | Transactional (§2) |
| **domain**        | Drives other modules' behavior (e.g. notifications, session UX).                                                         | At-least-once      |
| **observability** | Metrics / funnels / abuse counters; loss is tolerable.                                                                   | Best-effort        |

An event may carry more than one concern; the **strictest** class wins its delivery guarantee.

---

## 5. Event catalog

Phone numbers appear only where a consumer genuinely needs them (OTP delivery); everywhere else the
subject is referenced by `userId`. No payload carries an OTP code, a raw or hashed token, the pepper,
or a JWT (R-AUTH-18, §6).

### 5.1 OTP & login

| Type                   | Class         | Emitted when                              | `data` payload                                                                   |
| ---------------------- | ------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `auth.otp.requested`   | observability | An OTP send is requested (pre-delivery).  | `{ phoneNumber, purpose, deviceId?, ip?, challengeId }`                          |
| `auth.otp.sent`        | observability | The SMS/voice provider accepted the send. | `{ phoneNumber, purpose, channel, providerRef, challengeId }`                    |
| `auth.otp.verified`    | domain+audit  | A correct OTP was consumed (single-use).  | `{ userId?, phoneNumber, purpose, challengeId, isNewAccount }`                   |
| `auth.login.succeeded` | audit         | A session was issued after verification.  | `{ userId, sessionId, deviceId, ip?, isNewAccount }`                             |
| `auth.login.failed`    | observability | Verify failed (wrong / expired / locked). | `{ phoneNumber, purpose, reason: "invalid"\|"expired"\|"locked", attemptCount }` |

- `auth.login.failed.reason` is coarse on purpose — it must **not** distinguish "no account" from
  "wrong code" (enumeration resistance, R-AUTH-19). `phoneNumber` is present because the fraud trail
  keys on it, but the event never leaves the trust boundary to a client.

### 5.2 Sessions & tokens

| Type                          | Class         | Emitted when                                   | `data` payload                                                                                             |
| ----------------------------- | ------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `auth.session.created`        | domain+audit  | A new session/device binding is established.   | `{ userId, sessionId, deviceId, ip?, expiresAt }`                                                          |
| `auth.token.refreshed`        | observability | An access token was refreshed via rotation.    | `{ userId, sessionId, rotatedFrom, rotatedTo }`                                                            |
| `auth.refresh.reuse_detected` | audit         | A consumed refresh token was replayed (INV-5). | `{ userId, sessionId, offendingTokenId, familyRevokedCount }`                                              |
| `auth.session.revoked`        | domain+audit  | A session ended.                               | `{ userId, sessionId, reason: "logout"\|"suspension"\|"cap_evicted"\|"device_revoked"\|"reuse_detected" }` |

- `auth.session.revoked` is what tells the affected **device** it was signed out (doc 01 §5.2). On
  `allDevices` logout or suspension it is emitted **once per revoked `sid`** in the family.

### 5.3 Devices

| Type                  | Class        | Emitted when                    | `data` payload                                         |
| --------------------- | ------------ | ------------------------------- | ------------------------------------------------------ |
| `auth.device.flagged` | domain+audit | A device moved to `SUSPICIOUS`. | `{ userId, deviceId, from, to: "SUSPICIOUS", signal }` |
| `auth.device.revoked` | audit        | A device moved to `REVOKED`.    | `{ userId, deviceId, from, to: "REVOKED", actor }`     |

> `auth.device.flagged` exists in the contract now, but the **behavioral** signals that fire it are
> post-v1 (doc 02 §5.2, OD-8). In v1 only `auth.device.revoked` is emitted in practice.

### 5.4 Account & roles

| Type                         | Class | Emitted when                                | `data` payload                                 |
| ---------------------------- | ----- | ------------------------------------------- | ---------------------------------------------- |
| `account.role.granted`       | audit | A role was added to an identity.            | `{ userId, roleSlug, grantedBy?, expiresAt? }` |
| `account.role.revoked`       | audit | A role was removed (soft, `revoked_at`).    | `{ userId, roleSlug, revokedBy?, reason? }`    |
| `account.suspended`          | audit | Ops suspended the account (epoch bumped).   | `{ userId, actor, reason }`                    |
| `account.reactivated`        | audit | A suspended account was reactivated.        | `{ userId, actor }`                            |
| `account.recovery.completed` | audit | An audited recovery / number-change closed. | `{ userId, actor, changedPhone: boolean }`     |

- `account.suspended` / `account.role.*` are the events that make **epoch bumps** observable (doc 02
  §3.3) — consumers must not assume the session is still valid after seeing them.
- `roleSlug` uses the canonical slug (`customer` | `driver` | `admin` | `support`) — doc 03 §8.

---

## 6. Payload safety rules (R-AUTH-18)

A payload **must never** contain: an OTP code, a raw or hashed refresh token, the pepper or signing
secret, a JWT, a password, a stack trace, or SQL. Only stable identifiers (`userId`, `sessionId`,
`deviceId`, `roleSlug`, `challengeId`, `providerRef`) and coarse enums cross the boundary. `phoneNumber`
appears only in OTP/login/fraud events and never leaves the internal trust boundary to an end client.

---

## 7. Versioning & compatibility

- **Additive** changes (new optional field) do **not** bump `version`; consumers must ignore unknown
  fields.
- **Breaking** changes (rename/remove a field, change a type, tighten an enum) bump `version` and run
  **both** versions during rollout until consumers migrate (expand→contract, mirrors doc 03 §7).
- `type` strings are **permanent** once shipped; a retired event is deprecated, never repurposed.

---

## 8. Consumer map (who listens, informative)

| Event(s)                                                            | Consumer                   | Purpose                                  |
| ------------------------------------------------------------------- | -------------------------- | ---------------------------------------- |
| `auth.otp.requested/sent`                                           | `notifications`            | OTP delivery, cost/observability         |
| `auth.*` (audit subset)                                             | `admin`                    | `admin_activity_logs`, live-ops timeline |
| `auth.login.failed`, `auth.refresh.reuse_detected`, `auth.device.*` | fraud/risk                 | Abuse counters, investigation trail      |
| `auth.session.revoked`                                              | realtime / app             | Sign the affected device out             |
| `account.suspended/reactivated`, `account.role.*`                   | `notifications`, analytics | Security alerts, funnel                  |

Consumers are the authority on their own handling; this table is a routing aid, not a contract on
their behavior.

---

## 9. Traceability

| Event group                                           | Realizes                                     |
| ----------------------------------------------------- | -------------------------------------------- |
| `auth.otp.*`, `auth.login.*`                          | R-AUTH-1/2/8/9/19/20, doc 02 §4              |
| `auth.session.*`, `auth.token.refreshed`              | R-AUTH-4/6/11/24, AUTH-INV-4, doc 02 §3.3/§5 |
| `auth.refresh.reuse_detected`                         | R-AUTH-5, AUTH-INV-5, doc 02 §3.2            |
| `auth.device.*`                                       | R-DEVICE-2/3/4, AUTH-INV-6, doc 02 §5.2      |
| `account.role.*`                                      | R-ACCOUNT-3/7, doc 03 OD-2                   |
| `account.suspended/reactivated`, `recovery.completed` | R-ACCOUNT-4/9/10, R-AUTH-12/21               |
| transactional outbox + audit subset                   | R-AUTH-21/28, NFR-5/8, R-DATA-2              |

**Next: 07_AUTH_TEST_PLAN** — the test matrix that proves the acceptance criteria (doc 01 §13) and the
invariants (doc 01 §10), including that these events fire exactly when and how this catalog specifies.
