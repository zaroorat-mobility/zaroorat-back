# USER — Business Requirements

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `users` · **Doc:** 01 of the USER chain
> **Status:** 🟡 Specified (v1) · **Revision:** v1.0 · **Owner:** Product / Engineering (Identity) · **Last updated:** 2026-07-29
> **Answers:** _What must the user/profile module do, and why — independent of how it's built?_
> **Traces from:** [AUTH 01 §2.2](../auth/01%20auth%20business%20requirements.md) (explicitly delegates profile data to `users`) · BRD BR-7 · PRD FR-PROFILE
> **Traces to:** 02_USER_API_SPEC → 03_USER_DATABASE_SPEC → 04_USER_ERROR_CATALOG → 05_USER_EVENT_CATALOG → 06_USER_TEST_PLAN

---

## 1. Purpose

AUTH established **that** a person is who they claim to be. This document defines **who that person
is** to the platform: the attributes they control, the collections they own, and the two operations
that change their identity anchor without destroying their history — a phone-number change and
leaving the platform.

The boundary is deliberate and load-bearing. AUTH doc 01 §2.2 puts "user profile data (name, saved
places, emergency contacts)" out of AUTH's scope and names `users` as the owner. This doc takes that
delegation and makes it a contract.

> **Boundary discipline.** This doc states policy. It does not fix tables, endpoints, TTLs, or field
> validation rules — those belong to 02 and 03. Where a requirement needs an AUTH mechanism (OTP,
> session revocation, epoch bump), it **names the dependency** rather than restating the mechanism.

---

## 2. Scope

### 2.1 In scope

- **Self-service profile** — the attributes a user sets about themselves: given/family name, date of
  birth, gender, avatar, preferred language.
- **Self-service account read** — one endpoint that answers "what does the platform know about me",
  including status and roles (read-only projections of AUTH state).
- **Phone-number change** — the authenticated, re-verified, audited flow that realizes AUTH's
  **R-ACCOUNT-9**, whose policy AUTH fixed and whose flow AUTH explicitly deferred.
- **Emergency contacts** — the people to notify in an SOS, owned by the user, consumed by `sos`.
- **Saved places** — named locations (home, work, custom) the user reuses when booking.
- **Leaving the platform** — self-service deactivation and a deletion **request**.

### 2.2 Out of scope (owned elsewhere)

- **Credentials, OTP issuance, tokens, sessions, devices** — `auth`. USER _calls_ these; it never
  reimplements them.
- **Role grants/revocations and ops-initiated suspension** — `auth` (mechanism), `admin`
  (initiation). USER reads role slugs; it never writes `user_roles`.
- **Self-service device and session management UI/API** — `auth`, mounted at `/api/v1/auth/me/*`
  (FLOW §7). The tables are AUTH's and so are their invariants.
- **Driver profile, documents, KYC, vehicles** — `onboarding` / `documents` / `vehicles`. A driver's
  _person_ is here; a driver's _licence_ is not.
- **Referral code generation and redemption** — `referral`. USER stores the code on the profile row
  because that is where the column lives; it does not mint one.
- **Notification delivery** for any of these events — `notifications`.
- **Rider/driver rating aggregates** — `reviews`.

### 2.3 Deferred (not v1)

- **Email as a usable identifier** (set, verify, log in with). See §11, **USER-OD-1** — the platform
  has no email delivery channel today, so an email could only be stored unverified.
- **Avatar upload pipeline** (storage, resize, moderation) — `files` owns it; v1 stores a URL the
  `files` module returns.
- **Self-service reactivation** — a deactivated user cannot authenticate, so there is no call they
  could make. Admin-initiated only (§6).
- **Profile completeness scoring / progressive onboarding prompts** — product feature, not identity.
- **Data-export (DSAR) endpoint** — operations-assisted in v1.

---

## 3. Actors

| Actor             | Relationship to this module                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------- |
| **Customer**      | Owns and edits their own profile, contacts, and places. The primary actor.                  |
| **Driver**        | Identical rights — a driver is a customer identity with an extra role (AUTH R-ACCOUNT-3).   |
| **Admin**         | Reads any profile; initiates reactivation. Acts through `admin`, never through `/me`.       |
| **Support**       | Reads a profile to resolve a ticket. Read-only, audited, through `admin`.                   |
| **Other modules** | `sos` reads emergency contacts; `rides` reads saved places; `notifications` reads language. |

A user is only ever the actor **on their own account** through this module. There is no user-to-user
surface here at all.

---

## 4. Profile requirements

| ID           | Requirement                                                                                                                                                                                | Traces         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| **R-USER-1** | Every account has **exactly one profile**, created **atomically with the account** — an account without a profile must be impossible.                                                      | R-ACCOUNT-6    |
| **R-USER-2** | Every profile attribute is **optional**. Registration collects a phone number and nothing else; the platform is usable with an empty profile.                                              | US-A1          |
| **R-USER-3** | A user may **read** their own account and profile in one call, including their status and role slugs.                                                                                      | PRD FR-PROFILE |
| **R-USER-4** | A user may **update** their own profile attributes at any time while their account is active.                                                                                              | PRD FR-PROFILE |
| **R-USER-5** | A profile update is a **partial** update — omitting a field leaves it unchanged; it is never interpreted as "clear it".                                                                    | NFR-6          |
| **R-USER-6** | A user may **never** change, through this module, the fields that define their identity or entitlements: phone number (except via §5), email verification state, account status, or roles. | NFR-7          |
| **R-USER-7** | **Preferred language** is part of the profile and is the authority for how every notification to this user is localized.                                                                   | NFR-11         |
| **R-USER-8** | A user reads and writes **only their own** data. No endpoint in this module accepts another user's identifier.                                                                             | NFR-7          |

> **On R-USER-2.** It is tempting to require a name at registration to make ride cards look better.
> We do not, because every field added to the signup screen costs conversion, and a rider's name is
> not needed until their first ride — at which point the booking flow can ask for it in context.

---

## 5. Phone-number change requirements

This realizes **AUTH R-ACCOUNT-8/9**, whose policy AUTH fixed ("authenticated, re-verified, audited,
preserves identity and all history") while deferring the flow. The flow is specified here.

| ID            | Requirement                                                                                                                                                | Traces                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **R-USER-9**  | A phone-number change is available only to an **authenticated, active** user.                                                                              | R-ACCOUNT-9             |
| **R-USER-10** | The change takes effect only after the user proves control of the **new** number by OTP. Proving control of the old number is not sufficient.              | R-ACCOUNT-8             |
| **R-USER-11** | The change **preserves the identity**: the same account, the same roles, the same rides, payments, wallet, ratings, and referral history.                  | R-ACCOUNT-9, BO-2       |
| **R-USER-12** | The new number must not already belong to another **active** account. A number freed by soft-deletion is available again.                                  | R-ACCOUNT-2             |
| **R-USER-13** | On success, **every existing session ends** — including the calling device's — and a fresh session is issued only to the device that completed the change. | R-AUTH-12, NFR-7        |
| **R-USER-14** | The change is **audited** and emits the platform's existing account-recovery event; it is never silent.                                                    | R-ACCOUNT-10, R-AUTH-21 |
| **R-USER-15** | Change requests are **rate-limited per account**, independently of the OTP send limits AUTH already applies per phone/device/IP.                           | R-AUTH-9, NFR-7         |

> **Why R-USER-13 is not negotiable.** A phone-number change is behaviorally identical to an account
> takeover: someone with a live session re-points the account at a number they control. If we let
> other sessions survive, a thief who stole one session keeps every other device signed in _and_ owns
> the recovery channel. Ending all sessions makes the flow self-limiting — the attacker gets one
> device, and the real owner's next login attempt tells them immediately that something is wrong.

---

## 6. Account-departure requirements

| ID            | Requirement                                                                                                                                 | Traces      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **R-USER-16** | A user may **deactivate** their own account, immediately ending access.                                                                     | R-ACCOUNT-5 |
| **R-USER-17** | Deactivation is **reversible by ops only** — a deactivated user cannot authenticate, so self-service restore cannot exist.                  | R-ACCOUNT-5 |
| **R-USER-18** | A user may **request deletion**. The request deactivates immediately; erasure follows the platform retention window.                        | R-DATA-1    |
| **R-USER-19** | Records are **soft-deleted, never physically removed**, by this module or any operations job it triggers.                                   | R-DATA-1    |
| **R-USER-20** | Deactivation and deletion requests are **audited**.                                                                                         | R-AUTH-21   |
| **R-USER-21** | A user with **obligations in flight** — an active ride, an unsettled wallet balance, an open dispute — cannot deactivate until those close. | BO-2        |

> **R-USER-21 is a cross-module read.** USER must ask `rides`, `wallet`, and `support` whether the
> account is clear. It does not model those obligations itself; it refuses the request when any owner
> says no, and names which one in the error (04 §2, `ACCOUNT_HAS_OBLIGATIONS`).

---

## 7. Owned-collection requirements

| ID            | Requirement                                                                                                                            | Traces      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **R-USER-22** | A user may add, list, and remove **emergency contacts**, up to a configurable cap.                                                     | PRD FR-SOS  |
| **R-USER-23** | Emergency contacts are **ordered by priority**; `sos` notifies in that order.                                                          | PRD FR-SOS  |
| **R-USER-24** | A user may add, list, edit, and remove **saved places**, up to a configurable cap.                                                     | PRD FR-RIDE |
| **R-USER-25** | Every collection item is **scoped to its owner**; an item belonging to another user is indistinguishable from one that does not exist. | NFR-7       |
| **R-USER-26** | Collection caps are **configuration, not code** — the numeric values are not fixed by this doc.                                        | NFR-6       |

> **On R-USER-25.** Returning `403 Forbidden` for another user's item confirms the item exists. The
> correct answer is `404` — the same answer a random UUID gets. This mirrors AUTH's enumeration
> discipline (auth doc 05 §3) applied to object IDs instead of phone numbers.

---

## 8. Transactional requirements

| ID            | Requirement                                                                                                                                           | Traces               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **R-USER-27** | Profile creation commits in the **same transaction** as account creation. A rolled-back registration leaves no profile.                               | R-USER-1             |
| **R-USER-28** | Every state change and its **audit event** commit together, via the transactional outbox AUTH already uses.                                           | R-AUTH-21, R-AUTH-28 |
| **R-USER-29** | The phone change — uniqueness re-check, number update, session revocation, and its events — is **one unit of work**. No partial outcome is reachable. | R-USER-11/13         |
| **R-USER-30** | Non-transactional side effects (Redis epoch bump, metrics) run **after commit**, never inside the transaction.                                        | AUTH doc 02 §3.3     |

---

## 9. Non-functional requirements that bind USER

| ID           | Binding on this module                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------- |
| **NFR-6**    | Partial updates and repeated deactivation calls are idempotent; a retry never double-applies.       |
| **NFR-7**    | Ownership scoping is enforced server-side from the token, never from client input.                  |
| **NFR-8**    | Every mutation is traceable by `requestId`; sensitive mutations are audited.                        |
| **NFR-11**   | Errors are localized via `messageKey`; the profile's `languageCode` is the resolution key.          |
| **NFR-PRIV** | Profile attributes are personal data: never logged in full, never placed in event payloads (05 §5). |

---

## 10. Invariants (must hold at the enforcement/data layer)

| ID             | Invariant                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **USER-INV-1** | Exactly **one** profile row per account, created in the account's own transaction. Zero or two is structurally impossible.               |
| **USER-INV-2** | No response ever contains another user's data. Every read and write is filtered by the token's `userId` at the query level.              |
| **USER-INV-3** | A phone change **never** changes the account identifier. History follows the identity, not the number.                                   |
| **USER-INV-4** | After a phone change commits, **no session issued before it remains usable** — including the caller's original one.                      |
| **USER-INV-5** | A profile update can never alter phone number, email, email-verification state, account status, or role assignments.                     |
| **USER-INV-6** | Deactivation and deletion never physically remove rows; a soft-deleted account's phone number becomes registrable as a **new** identity. |
| **USER-INV-7** | A user can never hold more emergency contacts or saved places than the configured cap, including under concurrent requests.              |

These are proven — not merely asserted — by [06_USER_TEST_PLAN](06_USER_TEST_PLAN.md) §4.

---

## 11. Open decisions

| ID            | Decision                                                                                    | Status                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **USER-OD-1** | Should `PATCH /me/email` ship in v1?                                                        | ❌ **No.** No email delivery channel exists (`NotificationService` is SMS-only). Storing an unverified address on a unique column invites squatting. Revisit when an email provider lands. |
| **USER-OD-2** | Who mints `user_profiles.referral_code`?                                                    | ✅ **`referral`.** USER creates the profile with a `null` code; the referral module fills it on first use.                                                                                 |
| **USER-OD-3** | Do device/session self-service endpoints live under `/users/me` or `/auth/me`?              | ✅ **`/auth/me`.** The tables and their invariants are AUTH's; splitting them across modules would split one model's rules.                                                                |
| **USER-OD-4** | Does the phone-change flow reuse AUTH's `account.recovery.completed` or define a new event? | ✅ **Reuse.** AUTH doc 06 §5.4 already defines it with a `changedPhone` flag and nothing emits it today.                                                                                   |
| **USER-OD-5** | Is `gender` a free string or a constrained enum?                                            | ✅ **Constrained string set** validated at the API edge, stored as text — 03 §3. An enum migration for a field with evolving values is not worth the schema churn.                         |
| **USER-OD-6** | Where do the collection caps live?                                                          | ✅ **Config** (`user.config.ts`), per R-USER-26.                                                                                                                                           |

---

## 12. Delivery phases

Ordered so each phase is shippable and the next builds on it.

| Phase | Delivers                                                                      | Depends on             |
| ----- | ----------------------------------------------------------------------------- | ---------------------- |
| **1** | `GET /me`, `PATCH /me/profile` — repository, service, DTOs, validation, tests | nothing (AUTH is done) |
| **2** | Profile row created inside AUTH's registration transaction                    | 1                      |
| **3** | Phone-number change (both steps)                                              | 1, AUTH OtpService     |
| **4** | Emergency contacts + saved places                                             | 1                      |
| **5** | Deactivation and delete-request                                               | 1, obligations reads   |
| **6** | Admin reactivation wiring                                                     | 5, `admin` module      |
| **7** | Email (USER-OD-1) — only once an email channel exists                         | deferred               |

---

## 13. Acceptance criteria (module "done" for v1)

USER v1 ships when all of these are demonstrable:

1. A newly registered account has exactly one profile row, created in the registration transaction; a rolled-back registration leaves none.
2. `GET /me` returns the caller's account, profile, status, and role slugs — and cannot be made to return anyone else's.
3. `PATCH /me/profile` applies only the fields present, leaves the rest untouched, and rejects every immutable field.
4. A phone change requires OTP on the **new** number, preserves `users.id` and all history, and ends every prior session.
5. A phone change to a number held by another active account is refused; one freed by soft-deletion is accepted.
6. Two concurrent phone changes onto the same free number result in exactly one success.
7. Emergency contacts and saved places are per-user capped, ordered where specified, and invisible across accounts (404, not 403).
8. Deactivation ends access immediately and is refused while obligations are open.
9. Every mutation emits its event in the same transaction as the change; a rollback emits nothing.
10. No event payload and no log line contains a profile value (name, DOB, phone) — field names only.
11. `prisma validate`, typecheck, lint (`--max-warnings=0`), and the full test suite pass.

---

## 14. Traceability

| Requirement group | Realizes                       | Proven by (06)               |
| ----------------- | ------------------------------ | ---------------------------- |
| R-USER-1/2/27     | R-ACCOUNT-6, AUTH 01 §2.2      | §3 #1, §4 USER-INV-1         |
| R-USER-3…8        | PRD FR-PROFILE, NFR-7          | §3 #2/#3, §4 USER-INV-2/5    |
| R-USER-9…15       | R-ACCOUNT-8/9/10, R-AUTH-12/21 | §3 #4/#5/#6, §4 USER-INV-3/4 |
| R-USER-16…21      | R-ACCOUNT-5, R-DATA-1, BO-2    | §3 #8, §4 USER-INV-6         |
| R-USER-22…26      | PRD FR-SOS, FR-RIDE, NFR-7     | §3 #7, §4 USER-INV-7         |
| R-USER-27…30      | R-AUTH-21/28, AUTH 02 §3.3     | §3 #9, §6                    |
| NFR bindings      | NFR-6/7/8/11, NFR-PRIV         | §5, §6                       |

**Next: 02_USER_API_SPEC** — the exact endpoints, payloads, and guard wiring that realize these
requirements.
