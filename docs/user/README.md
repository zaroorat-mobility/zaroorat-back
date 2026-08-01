# USER — Module Documentation

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `users` · **Status:** 🟡 Specified (v1) — implementation pending
> **Owner:** Product / Engineering (Identity) · **Last updated:** 2026-07-29

This directory is the **USER chain** — the same 01→06 discipline the [AUTH chain](../auth/) uses.
AUTH answers _"is this person who they say they are, and may they act?"_. USER answers _"who is this
person, and what have they told us about themselves?"_

---

## 1. The chain

Read in order. Each doc traces from the one before it; the last one proves the whole chain.

| Doc                                                                  | Answers                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [FLOW.md](FLOW.md)                                                   | What happens, step by step, in each user flow — the narrative overview. |
| [01_USER_BUSINESS_REQUIREMENTS.md](01_USER_BUSINESS_REQUIREMENTS.md) | What the module must do, and why — model-agnostic.                      |
| [02_USER_API_SPEC.md](02_USER_API_SPEC.md)                           | Exact endpoints, request/response shapes, guard wiring.                 |
| [03_USER_DATABASE_SPEC.md](03_USER_DATABASE_SPEC.md)                 | Models, constraints, indexes, retention, migration plan.                |
| [04_USER_ERROR_CATALOG.md](04_USER_ERROR_CATALOG.md)                 | Every failure on the wire, and how the client reacts.                   |
| [05_USER_EVENT_CATALOG.md](05_USER_EVENT_CATALOG.md)                 | Every event emitted, its payload, and its delivery guarantee.           |
| [06_USER_TEST_PLAN.md](06_USER_TEST_PLAN.md)                         | The tests that make all of the above provable.                          |

There is no separate security spec (the AUTH `02` equivalent). USER holds no credentials, issues no
tokens, and terminates no sessions on its own — it consumes AUTH's primitives. Security rules that
_do_ bind USER (ownership scoping, immutable fields, the phone-change re-verification) are stated
inline in 01 §7 and enforced per 02 §3.

---

## 2. What this module owns

| Owns                                                      | Table                |
| --------------------------------------------------------- | -------------------- |
| Profile attributes (name, DOB, gender, avatar, language)  | `user_profiles`      |
| Emergency contacts                                        | `emergency_contacts` |
| Saved places (home, work, custom)                         | `saved_places`       |
| The self-service read/write surface over the identity row | `users` (scoped)     |

## 3. What it does **not** own

| Not owned                                   | Owner                                     |
| ------------------------------------------- | ----------------------------------------- |
| Credentials, OTP, tokens, sessions, devices | `auth` — [docs/auth](../auth/)            |
| Role grants and account suspension by ops   | `auth` (mechanism) / `admin` (initiation) |
| Driver documents, KYC, vehicles             | `onboarding` / `documents` / `vehicles`   |
| Notification delivery (SMS, email, push)    | `notifications`                           |
| Referral code issuance and redemption       | `referral`                                |

USER never writes `users.status`, never touches `user_roles`, and never revokes a session directly —
it calls AUTH's services for those, inside the same transaction (01 §8).

---

## 4. Status

Specified, not built. `src/modules/users/` currently contains the directory skeleton
(`controllers/ dto/ repositories/ routes/ schemas/ services/ types/ tests/`) and an `index.ts` stub.
The models in §2 already exist in `prisma/schema/modules/user/user.prisma` and are migrated.

The implementation phases and their order are in [01 §12](01_USER_BUSINESS_REQUIREMENTS.md#12-delivery-phases).

---

## 5. Naming note

Files here use `NN_USER_TOPIC.md`; the AUTH chain uses `NN auth topic.md`. The two conventions
disagree. This chain follows the uppercase form; if the repo standardizes later, AUTH is the one that
moves (it is the older, less consistent set).
