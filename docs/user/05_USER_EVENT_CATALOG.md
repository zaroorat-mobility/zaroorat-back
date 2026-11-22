# USER — Event Catalog

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `users` · **Doc:** 05 of the USER chain · **Stack:** Node.js / Fastify / Prisma (ADR-0006)
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Identity) · **Last updated:** 2026-07-29
> **Answers:** _What events does USER emit, what is in each payload, and what are the delivery and audit guarantees?_
> **Traces from:** [01_BR](01_USER_BUSINESS_REQUIREMENTS.md) §8 · [02_API](02_USER_API_SPEC.md) §6 · [AUTH 06](../auth/06%20auth%20event%20catalog.md) (envelope, outbox, classification — inherited unchanged)
> **Traces to:** 06_USER_TEST_PLAN §6

---

## 1. Purpose & scope

The canonical contract for every event `users` publishes. Consumers (`notifications`, `sos`,
`referral`, `admin` audit, analytics) integrate against this doc, not against USER's code.

**In scope:** payload schemas, classification, the audit subset, and the privacy rule that makes these
payloads different from AUTH's.

**Out of scope:** the envelope, the outbox mechanism, the versioning policy, and the delivery
guarantees — all inherited **unchanged** from [AUTH doc 06](../auth/06%20auth%20event%20catalog.md)
§2/§3/§4/§7. There is one event bus, one outbox table, one envelope. This doc restates none of it.

---

## 2. Inherited contract (summary only — AUTH 06 is authoritative)

- **Transactional outbox.** State and event commit in one transaction; a rolled-back change emits
  nothing, a committed change never loses its event (R-USER-28).
- **At-least-once delivery**, deduplicated by consumers on `eventId`.
- **Per-subject ordering** — events for one `userId` publish in commit order.
- **Envelope** — `eventId`, `type`, `version`, `occurredAt`, `producer`, `subject`, `correlation`,
  `data`. `producer` is `"users"` for everything in §3.
- **Classification** — `audit` (transactional, legally significant) / `domain` (drives other modules)
  / `observability` (best-effort). The strictest class an event carries wins.
- **Naming** — dotted lowercase, `user.*` for this module's own events. Permanent once shipped.

---

## 3. Event catalog

### 3.1 Profile

| Type                   | Class  | Emitted when                                           | `data` payload                        |
| ---------------------- | ------ | ------------------------------------------------------ | ------------------------------------- |
| `user.profile.created` | domain | The profile row is created (in AUTH's registration tx) | `{ userId }`                          |
| `user.profile.updated` | domain | `PATCH /me/profile` commits                            | `{ userId, changedFields: string[] }` |

- **`changedFields` carries names, never values.** `["firstName","dateOfBirth"]` — never the name,
  never the date. See §5.
- `user.profile.created` exists so `referral` knows a profile is ready to receive a code, and so
  analytics can count registrations from one source rather than joining two modules' events.

### 3.2 Phone number

| Type                          | Class          | Emitted when                          | `data` payload                                                |
| ----------------------------- | -------------- | ------------------------------------- | ------------------------------------------------------------- |
| `user.phone.change_requested` | observability  | An OTP was requested for a new number | `{ userId, challengeId, newPhoneMasked }`                     |
| `user.phone.changed`          | domain + audit | The number change committed           | `{ userId, oldPhoneMasked, newPhoneMasked, sessionsRevoked }` |

Plus **two events USER does not own but does trigger**, emitted in the same transaction:

| Type                         | Owner  | Why it fires here                                                                                                                                                                                                                                               |
| ---------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account.recovery.completed` | `auth` | AUTH 06 §5.4 defines it as "an audited recovery / number-change closed" with a `changedPhone` flag. This flow is its trigger — USER emits AUTH's event with `{ userId, actor: "self", changedPhone: true }` rather than inventing a near-duplicate (USER-OD-4). |
| `auth.session.revoked`       | `auth` | One per revoked `sid`, emitted by AUTH's `SessionService.logoutAll` inside the same transaction, so every signed-out device learns why.                                                                                                                         |

- **Phone numbers are masked** (`+9198765•••99`) in every payload. The number is not needed downstream
  — `notifications` looks it up from the identity when it needs to send — and an unmasked before/after
  pair in the event stream is a re-identification gift.
- `sessionsRevoked` is a **count**, not a list of session ids: it makes the security notification
  ("you were signed out of 3 devices") possible without shipping session identifiers around.

### 3.3 Account lifecycle

| Type                              | Class          | Emitted when                               | `data` payload                                                        |
| --------------------------------- | -------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `user.account.deactivated`        | domain + audit | Self-service deactivation committed        | `{ userId, actor: "self", reason? }`                                  |
| `user.account.deletion_requested` | audit          | A deletion request was accepted            | `{ userId, scheduledFor }`                                            |
| `user.account.restored`           | domain + audit | An admin reactivated a deactivated account | `{ userId, actor: "admin", actorId }`                                 |
| `user.account.erased`             | audit          | The retention job discharged a request     | `{ userId, emergencyContacts, savedPlaces, profile, avatarReleased }` |

- `user.account.erased` carries **counts, not contents**. It outlives the data it describes — by the
  time anyone reads it the profile, the contacts, and the places are gone — so it has to say what was
  removed without becoming a copy of it. It is also the only surviving proof the obligation was
  discharged, which is why it commits in the same transaction that closes the ledger row.
- It is emitted **once per erasure**. The ledger transition is conditional on the request still being
  `PENDING`, so two runners produce one event between them: a single irreversible act must not look
  like two in an audit trail.
- `user.account.restored` is emitted by the `admin` flow that calls AUTH's existing `activate`; it is
  catalogued here because the **subject** is a user-module concern and consumers look for it under
  `user.*`. AUTH's `account.reactivated` remains the ops-suspension counterpart — a reactivation from
  **suspension** is AUTH's, a restore from **self-deactivation** is this one. They are different
  business events with different notification copy.
- `reason` is a **coarse enum** (`NOT_USING` | `PRIVACY` | `SWITCHING` | `OTHER`), never free text —
  free text is where personal data leaks into an event stream.

### 3.4 Owned collections

| Type                             | Class  | Emitted when          | `data` payload                         |
| -------------------------------- | ------ | --------------------- | -------------------------------------- |
| `user.emergency_contact.added`   | domain | A contact was created | `{ userId, contactId, priority }`      |
| `user.emergency_contact.updated` | domain | A contact was edited  | `{ userId, contactId, changedFields }` |
| `user.emergency_contact.removed` | domain | A contact was deleted | `{ userId, contactId }`                |
| `user.saved_place.added`         | domain | A place was created   | `{ userId, placeId, label }`           |
| `user.saved_place.updated`       | domain | A place was edited    | `{ userId, placeId, changedFields }`   |
| `user.saved_place.removed`       | domain | A place was deleted   | `{ userId, placeId }`                  |

- **No contact name, no contact phone number, ever.** An emergency contact is personal data about a
  **third party** who never accepted platform terms; `sos` reads the row from the database when it
  actually needs to call someone. Putting it in an event would broadcast it to every consumer,
  every log sink, and every broker retention window for no benefit.
- **No address and no coordinates** on `user.saved_place.*`. `label` is included because it is
  user-chosen and low-risk, and because `rides` uses it for UI freshness. Home coordinates in an event
  stream are the single most dangerous payload this module could emit.

---

## 4. Audit subset

These are written in the **same transaction** as the change they record. If the outbox write fails,
the change fails (AUTH 06 §2).

- `user.phone.changed` + `account.recovery.completed` — R-USER-14, R-ACCOUNT-10
- `user.account.deactivated` — R-USER-20
- `user.account.deletion_requested` — R-USER-20, R-DATA-1
- `user.account.restored` — R-USER-17

Everything else in §3 is `domain` or `observability`: a profile edit is not an audit event, and
treating it as one would put a transactional guarantee on the highest-frequency write in the module
for no legal or operational benefit.

Admin-initiated actions additionally write `admin_activity_logs` with the actor, entity, and field
changes — that row is the `admin` module's job, not USER's (03 §6).

---

## 5. Payload privacy rules (NFR-PRIV — stricter than AUTH's)

AUTH's rule is "no secrets" (AUTH 06 §6). USER's rule is **"no secrets and no personal values"**,
because this module's whole surface is personal data.

A USER payload **must never** contain: a name (the subject's or a contact's), a date of birth, a
gender, an unmasked phone number, an address, a landmark, delivery instructions, coordinates, a
profile image URL, an email, or free-text of any kind.

It carries only: **identifiers** (`userId`, `contactId`, `placeId`, `challengeId`), **field names**
(`changedFields`), **counts** (`sessionsRevoked`), **coarse enums** (`reason`, `actor`), **masked**
phone numbers, and the user-chosen `label`.

> **Why the line is drawn at field names.** A consumer that genuinely needs a profile value can read
> it from the database under its own access controls, at the moment it needs it, subject to deletion.
> A value placed in an event is copied into every consumer's storage, every broker's retention window,
> and every log aggregator — and it survives the user's deletion request. `changedFields` gives
> consumers everything they need to decide _whether_ to act, without any of that.

---

## 6. Metrics

Events are the contract; metrics are the alerting surface. They are **not** the same thing and this
module does not mirror one into the other.

USER emits counters for exactly one flow — the phone change — following the existing pattern in
`src/modules/auth/otp/otp.metrics.ts` and `session/session.metrics.ts`: a small class writing one
structured `metric: user.*` line per event, a drop-in seam for Prometheus/OpenTelemetry later.

| Counter                     | Emitted when                                       |
| --------------------------- | -------------------------------------------------- |
| `user.phone.change_request` | A change was requested for a new number            |
| `user.phone.change_success` | The change committed                               |
| `user.phone.change_failed`  | Verification failed (wrong / expired / lost race)  |
| `user.phone.rate_limited`   | A change request was rejected by the R-USER-15 cap |

> **Why only this flow.** OTP and session counters exist because those paths are abuse targets that
> need alerting independently of whether the event pipeline is healthy. The phone change is this
> module's only path with that property — it is the account-takeover shape (01 §5). Profile edits,
> contacts, and saved places are ordinary self-scoped writes; a counter on them would duplicate an
> event that §7 already routes to analytics, and a metric that only ever feeds a dashboard is a
> second copy of the event stream with none of its guarantees.

Fields carry `userId` and coarse reasons only — never a number, masked or otherwise (§5).

---

## 7. Consumer map (informative)

| Event(s)                                        | Consumer                           | Purpose                                     |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------------- |
| `user.profile.created`                          | `referral`                         | Mint the referral code (USER-OD-2)          |
| `user.profile.updated` (`languageCode` changed) | `notifications`                    | Re-resolve the user's locale                |
| `user.phone.changed`                            | `notifications`                    | Security alert; update delivery destination |
| `user.phone.*`, `user.account.*`                | `admin`                            | Audit timeline, live-ops                    |
| `user.account.deactivated/deletion_requested`   | `rides`, `wallet`, `notifications` | Stop targeting, close subscriptions         |
| `user.emergency_contact.*`                      | `sos`                              | Cache invalidation for the notify list      |
| `user.saved_place.*`                            | `rides`                            | Invalidate the pickup-picker cache          |
| all                                             | analytics                          | Funnels, retention                          |

Consumers are the authority on their own handling; this table is a routing aid, not a contract on
their behavior.

---

## 8. Traceability

| Event group                                   | Realizes                                | Proven by (06) |
| --------------------------------------------- | --------------------------------------- | -------------- |
| `user.profile.created`                        | R-USER-1/27, USER-INV-1                 | §4, §6         |
| `user.profile.updated`                        | R-USER-4/5, NFR-PRIV                    | §6             |
| `user.phone.*` + `account.recovery.completed` | R-USER-11/14, R-ACCOUNT-9/10, USER-OD-4 | §3 #4, §6      |
| `user.account.*`                              | R-USER-16/17/18/20, R-DATA-1            | §3 #8, §6      |
| `user.emergency_contact.*`                    | R-USER-22/23                            | §6             |
| `user.saved_place.*`                          | R-USER-24                               | §6             |
| audit subset (§4)                             | R-USER-28, R-AUTH-21/28                 | §6             |
| privacy rules (§5)                            | NFR-PRIV, R-USER-8                      | §5, §6         |

**Next: 06_USER_TEST_PLAN** — the test matrix that proves the acceptance criteria (01 §13) and the
invariants (01 §10), including that these events fire exactly when and how this catalog specifies.
