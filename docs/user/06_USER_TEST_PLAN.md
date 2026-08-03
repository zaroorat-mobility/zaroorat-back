# USER — Test Plan

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `users` · **Doc:** 06 of the USER chain · **Stack:** `tsx --test` / Fastify inject / Prisma (ADR-0006)
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Identity) / QA · **Last updated:** 2026-07-29
> **Answers:** _How do we prove USER meets its requirements and invariants before it ships?_
> **Traces from:** [01_BR](01_USER_BUSINESS_REQUIREMENTS.md) §10/§13 · [02_API](02_USER_API_SPEC.md) · [03_DB](03_USER_DATABASE_SPEC.md) · [04_ERRORS](04_USER_ERROR_CATALOG.md) · [05_EVENTS](05_USER_EVENT_CATALOG.md)

---

## 1. Purpose & scope

A criterion or invariant is "done" only when a test named here is green. This plan mirrors the AUTH
test plan's structure and **reuses its harness** — there is one integration harness, not two.

---

## 2. Test levels & tooling

| Level           | Runner / harness                                              | Dependencies                         |
| --------------- | ------------------------------------------------------------- | ------------------------------------ |
| **Unit**        | `tsx --test` (`tests/unit/users/**`)                          | none — pure functions, stubbed ports |
| **Integration** | `tsx --test` (`tests/integration/**`) + Fastify `.inject()`   | live Postgres + Redis                |
| **Security**    | targeted integration tests (ownership, immutability, privacy) | Postgres + Redis                     |
| **Load**        | k6 / autocannon on `GET /me`                                  | full stack                           |

Reuse the existing `tests/integration/helpers/harness.ts` as-is: `bootApp()`, `db()`, `resetState()`,
and the fixed-OTP patch. Two additions are needed:

- `resetState()`'s `TRUNCATE` list gains `user_profiles`, `emergency_contacts`, `saved_places`
  (`CASCADE` already covers them via `users`, but naming them keeps the reset explicit).
- A `loginAs(phone)` helper returning `{ userId, accessToken }`, because every USER test starts
  authenticated. Today each AUTH test rebuilds that inline; extracting it is the prerequisite work.

Standing constraints inherited from the AUTH suite: `--test-concurrency=1` (integration files share
one database) and `--test-force-exit` (live Redis/Prisma handles keep the loop alive). **Time is
injected, never slept.**

---

## 3. Acceptance-criteria matrix (01 §13 — the ship gate)

Every row must be green for v1. IDs map 1:1 to the eleven criteria in 01 §13.

| #   | Criterion (abbreviated)                                                | Level(s)                 | Key assertions                                                                                                                      |
| --- | ---------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Registration creates exactly one profile, atomically                   | integration              | after first verify: 1 `user_profiles` row; inject a failure later in the same tx → **0** users **and** 0 profiles                   |
| 2   | `GET /me` returns the caller's data and no one else's                  | integration, sec         | body matches the caller; a second account's token returns its own row; live `roles` reflect a grant made after the token was issued |
| 3   | `PATCH /me/profile` is partial and rejects immutable fields            | integration              | omitted key unchanged; explicit `null` clears; `phoneNumber`/`status`/`roles` → `400 IMMUTABLE_FIELD` naming each                   |
| 4   | Phone change requires OTP on the **new** number and preserves identity | integration              | `users.id` unchanged; roles, rides, wallet rows still resolve; wrong code → `401 OTP_INVALID`, number unchanged                     |
| 5   | Phone change to a taken number is refused; a freed number is accepted  | integration              | active holder → `409 PHONE_IN_USE`; after soft-delete of the holder → success                                                       |
| 6   | Two concurrent changes onto the same free number → exactly one wins    | integration (concurrent) | one `200`, one `409`; exactly one `users` row holds the number                                                                      |
| 7   | Collections are capped, ordered, and invisible across accounts         | integration, sec         | cap+1 → `409 LIMIT_EXCEEDED`; contacts list ordered by `priority` asc; another user's `:id` → **`404`, not `403`**                  |
| 8   | Deactivation ends access and is refused while obligations are open     | integration              | open ride → `409 ACCOUNT_HAS_OBLIGATIONS`; clean account → `204`, next request `401 TOKEN_STALE`                                    |
| 9   | Every mutation emits its event in the same transaction as the change   | integration              | outbox row present on success; rollback → **0** outbox rows                                                                         |
| 10  | No event payload and no log line carries a personal value              | unit, sec                | scan every emitted payload for name/DOB/address/unmasked phone; assert `changedFields` holds names only                             |
| 11  | Repo gates pass                                                        | CI                       | `prisma validate`, typecheck, `lint --max-warnings=0`, full `tsx --test`                                                            |

---

## 4. Invariant tests (01 §10 — must be _structurally_ impossible to violate)

| Invariant      | Test                                                                                                                                                                                                                                     | Level                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **USER-INV-1** | Every account has exactly one profile. A direct second insert for the same `user_id` is rejected by `user_profiles_user_id_key`. A registration that rolls back leaves zero.                                                             | integration              |
| **USER-INV-2** | No cross-account read or write. For each endpoint: user B's token + user A's item id → `404`; A's row is unmodified afterwards. **Table-driven over every route** so a new endpoint added without scoping fails this test.               | integration, sec         |
| **USER-INV-3** | A phone change never changes `users.id`. Capture the id before and after; assert equality and that a pre-existing related row (a role assignment) still joins.                                                                           | integration              |
| **USER-INV-4** | After a phone change commits, no previously issued access token works — including the caller's original one. Open two sessions, change the number from one, assert both old tokens → `401 TOKEN_STALE` and only the returned pair works. | integration              |
| **USER-INV-5** | A profile update can never alter phone, email, verification state, status, or roles. Send each forbidden field individually and as a batch; assert `400` **and** that the underlying column is byte-identical afterwards.                | integration, sec         |
| **USER-INV-6** | Deactivation and deletion never remove rows. After both, the `users` row still exists; after the retention job soft-deletes it, the freed phone registers a **new** account with a **different** id and no inherited history.            | integration              |
| **USER-INV-7** | Caps hold under concurrency. Fire `cap + 5` simultaneous creates; assert exactly `cap` rows exist. _(This is the one that fails first if the cap is checked with a read-then-write instead of a constraint or a locked count.)_          | integration (concurrent) |

> **Concurrency is not optional for INV-3/4 (via #6) and INV-7.** Sequential tests pass on a
> read-then-write cap check and on an unguarded uniqueness check; only concurrent ones fail. AUTH's
> equivalent rows (AUTH-INV-1/2) are still unwritten in the shipped suite — this module should not
> repeat that gap.

---

## 5. Security & privacy suite

| Property                       | Test                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership from the token only  | Static check: no handler reads a user identifier from `params`/`query`/`body` (02 §3). Grep-based, asserted in CI.                            |
| Object-level enumeration       | Another user's item id and a random UUID produce **byte-identical** `404` bodies (R-USER-25).                                                 |
| Immutable-field rejection      | Every field in USER-INV-5 rejected explicitly, never silently dropped (04 §2.1).                                                              |
| Personal data out of errors    | Every code in 04 §2 asserted to omit submitted values; `details` carries `field` + `code` only, never `value`.                                |
| Personal data out of events    | Every payload in 05 §3 asserted against the §5 allow-list — identifiers, field names, counts, coarse enums, masked phones.                    |
| Personal data out of logs      | Capture Pino output across the full suite; assert no name, DOB, address, **coordinate**, **contact phone number**, or unmasked phone appears. |
| Third-party data containment   | Emergency-contact name and number appear in **no** event and **no** log — only in the row and the `sos` read path.                            |
| Phone-change enumeration bound | `PHONE_IN_USE` reachable only when authenticated, and rate-limited per account (R-USER-15) — assert the limit trips.                          |
| Fail-closed                    | Redis down on the phone-change path → `503 SERVICE_UNAVAILABLE`, never a partial change.                                                      |

---

## 6. Event-contract tests (05)

| Assertion                                                                                                            | Level       |
| -------------------------------------------------------------------------------------------------------------------- | ----------- |
| Each endpoint emits exactly the events 02/05 list, with AUTH's envelope and 05 §3's payload.                         | integration |
| **Audit** events (05 §4) are written in the **same transaction** as their change — rollback ⇒ no event.              | integration |
| The phone change emits AUTH's `account.recovery.completed` with `changedPhone: true` — **not** a `user.*` duplicate. | integration |
| `user.phone.changed.sessionsRevoked` equals the number of `auth.session.revoked` events in the same transaction.     | integration |
| `changedFields` holds field **names** and never values (05 §5).                                                      | unit        |
| Redelivering an `eventId` causes no double effect (at-least-once).                                                   | integration |

---

## 7. Load & performance

| Scenario               | Target                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /me` under load   | p95 < 300 ms (NFR-1). It is called on every app foreground, so it is this module's only hot path.              |
| `GET /me` query count  | **Bounded and asserted** — identity + profile + roles, no N+1. A regression here is invisible until it is not. |
| Collection list growth | Response size bounded by the caps; no unbounded list endpoint exists.                                          |

Phone change, deactivation, and collection writes are low-frequency and are not load-tested.

---

## 8. Data & migration tests (03)

- **Schema validation** — `prisma validate` green; `prisma generate` produces `UserProfile`,
  `EmergencyContact`, `SavedPlace` with the fields in 03 §3.
- **The §5 objects exist after migrate** and enforce what they claim:
  - `ix_emergency_contacts_user`, `ix_saved_places_user`, `ix_emergency_contacts_priority` present;
  - `uq_saved_places_user_label` rejects `"Home"` after `"home"` for the same user, and **allows** both
    for different users;
  - `ix_saved_places_location` present and of type GiST.
- **PostGIS round-trip** — insert a known coordinate, read it back through `ST_X`/`ST_Y`, assert
  longitude and latitude are **not swapped** (03 §4.4). This is the cheapest test in the plan and it
  catches the most expensive mistake.
- **Date-only storage** — a `dateOfBirth` written from a `UTC+05:30` client reads back as the same
  calendar date (03 §3.1).
- **`gender` value set** — the API rejects a value outside the accepted set even though the column
  does not (03 §3.1, USER-OD-5).

---

## 9. Coverage & exit criteria

USER v1 may ship when **all** hold:

1. Every row in §3 (acceptance) and §4 (invariants) is green in CI, **including the three concurrent
   cases**.
2. The security/privacy suite (§5) and the event-contract suite (§6) pass.
3. The privacy assertions (§5 rows 4–7) are green — this module's equivalent of AUTH's
   "no-secrets-in-errors" gate, and the one most likely to regress silently as fields are added.
4. `GET /me`'s query count is asserted, not just its latency.
5. `prisma validate`, typecheck (src + tools), `lint --max-warnings=0`, and the full `tsx --test`
   suite pass — the repo's standing gates.

---

## 10. Traceability

| Suite (this doc) | Proves                                     |
| ---------------- | ------------------------------------------ |
| §3 acceptance    | 01 §13 (all 11)                            |
| §4 invariants    | 01 §10 (USER-INV-1…7), 03 §4/§5            |
| §5 security      | R-USER-6/8/15/25, NFR-PRIV, 04 §5          |
| §6 events        | 05 (envelope, audit subset, privacy rules) |
| §7 load          | NFR-1                                      |
| §8 data          | 03 (models, §5 objects, §4.4 PostGIS)      |

**End of the USER chain.** 01 (why) → 02 (API) → 03 (schema) → 04 (errors) → 05 (events) →
**06 (proof)**. Every requirement in 01 is traceable to an endpoint, a table, an error, an event, and
a test.
