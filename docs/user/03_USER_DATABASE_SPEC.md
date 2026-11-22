# USER — Database Specification

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `users` · **Doc:** 03 of the USER chain · **Stack:** Prisma 7 / PostgreSQL + PostGIS (ADR-0003, ADR-0006)
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Identity) · **Last updated:** 2026-08-02
> **Answers:** _What tables back this module, what does the database enforce, and how does the schema change safely?_
> **Traces from:** [01_BR](01_USER_BUSINESS_REQUIREMENTS.md) §10 · [02_API](02_USER_API_SPEC.md) §6
> **Traces to:** 04_USER_ERROR_CATALOG · 05_USER_EVENT_CATALOG · 06_USER_TEST_PLAN §8

---

## 1. Purpose

The models below **already exist and are migrated** (`prisma/schema/modules/user/user.prisma`,
migration `20260724173304_init`). This doc does not introduce them — it states which are USER's, what
the database must enforce that Prisma cannot express, and what is **missing today**.

The gaps in §5 are real: three indexes and one uniqueness rule that the API in doc 02 depends on do
not exist in the shipped migration. They are the required schema work for USER v1.

---

## 2. Ownership

| Table                                             | Owner   | This module's access                                                                          |
| ------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `user_profiles`                                   | `users` | Full — create (in AUTH's registration tx), read, update                                       |
| `emergency_contacts`                              | `users` | Full CRUD, scoped by `user_id`                                                                |
| `saved_places`                                    | `users` | Full CRUD, scoped by `user_id`                                                                |
| `users`                                           | `auth`  | **Read** any column; **write** only `phone_number` (§4.2) and `status` **via AUTH's service** |
| `user_roles`, `roles`                             | `auth`  | Read-only (role slugs for `GET /me`)                                                          |
| `user_devices`, `user_sessions`, `refresh_tokens` | `auth`  | None — USER calls AUTH services, never these tables                                           |

> **`users` is AUTH's table.** USER reads it freely and changes exactly one column, inside a flow AUTH
> co-owns. It never sets `status` with its own query; deactivation calls `AuthService.deactivate` so
> the session revocation and epoch bump stay attached to the status change (R-USER-29).

---

## 3. Models (as shipped)

### 3.1 `user_profiles` — the one-to-one profile

```prisma
model UserProfile {
  id           String    @id @default(uuid(7)) @db.Uuid
  userId       String    @unique @map("user_id") @db.Uuid   // 1:1 — USER-INV-1
  firstName    String?   @map("first_name")
  lastName     String?   @map("last_name")
  dateOfBirth  DateTime? @map("date_of_birth") @db.Date     // date-only, no timezone
  gender       String?                                       // constrained at the edge (USER-OD-5)
  profileImage String?   @map("profile_image")
  languageCode String?   @default("en") @map("language_code")
  referralCode String?   @unique @map("referral_code")      // minted by `referral` (USER-OD-2)
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id])

  @@map("user_profiles")
}
```

- **`userId @unique` is what makes USER-INV-1 structural** on the "at most one" side. The "at least
  one" side is not a constraint — it is the registration transaction (§4.1). A `NOT NULL` FK on
  `users` pointing at the profile would create a circular insert dependency, so the transaction is the
  right enforcement point.
- **`dateOfBirth` is `@db.Date`, not a timestamp.** A birthday has no instant and no timezone; storing
  it as `timestamptz` produces the classic off-by-one where a user born on the 1st sees the 31st.
- **`gender` is free text in the database, constrained at the API edge.** A Postgres enum would need a
  migration every time the accepted set changes, and this is a field whose accepted set does change.
  The trade-off is that the database will accept a bad value written by a future careless caller — 06
  §8 asserts the stored set instead.
- **`languageCode` defaults to `"en"`** so notification templates always resolve (R-USER-7).

### 3.2 `emergency_contacts`

```prisma
model EmergencyContact {
  id           String   @id @default(uuid(7)) @db.Uuid
  userId       String   @map("user_id") @db.Uuid
  contactName  String   @map("contact_name")
  phoneNumber  String   @map("phone_number")   // E.164; NOT an identity — no uniqueness
  relationship String?
  priority     Int      @default(1)            // ascending = notified first (R-USER-23)
  createdAt    DateTime @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id])

  @@map("emergency_contacts")
}
```

- `phoneNumber` here is **not an identity** — two users may list the same emergency contact, and a
  contact need not be a platform user. It is deliberately unconstrained.

### 3.3 `saved_places`

```prisma
model SavedPlace {
  id           String                                @id @default(uuid(7)) @db.Uuid
  userId       String                                @map("user_id") @db.Uuid
  label        String
  address      String?
  buildingName String?                               @map("building_name")
  landmark     String?
  floor        String?
  instructions String?
  latitude     Decimal?                              @db.Decimal(10, 7)
  longitude    Decimal?                              @db.Decimal(10, 7)
  location     Unsupported("geography(Point,4326)")?
  createdAt    DateTime                              @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id])

  @@map("saved_places")
}
```

- **`latitude`/`longitude` are `Decimal(10,7)`, not floats** — 7 decimal places is ~1 cm, and decimal
  avoids the float drift that turns a saved pickup point into a different side of the road.
- **`location` is the PostGIS geography**, derived server-side from lat/lng. It is `Unsupported`, so
  Prisma cannot read or write it — it is set by raw SQL in the repository (§4.4) and read only by
  geospatial queries in `rides` / `geo`.
- Storing both the decimals and the geography is intentional redundancy: the decimals are what the API
  returns and validates, the geography is what indexes and distance queries use.

### 3.4 `account_deletion_requests` — the erasure ledger

```prisma
model AccountDeletionRequest {
  id           String                @id @default(uuid(7)) @db.Uuid
  userId       String                @map("user_id") @db.Uuid
  status       DeletionRequestStatus @default(PENDING)
  requestedAt  DateTime              @default(now()) @map("requested_at")
  scheduledFor DateTime              @map("scheduled_for")
  erasedAt     DateTime?             @map("erased_at")
  cancelledAt  DateTime?             @map("cancelled_at")

  user User @relation(fields: [userId], references: [id])

  @@index([status, scheduledFor], map: "ix_deletion_requests_due")
  @@map("account_deletion_requests")
}
```

- **Why it exists.** `POST /me/delete-request` (02 §2.8) says it "records the request", and until this
  table there was nowhere to record it. The only durable trace was the
  `user.account.deletion_requested` outbox event — which is a dispatch queue, not a ledger: it is
  append-only by platform policy, has no "erased yet?" state to set, and offers nothing to index a
  due-date scan on. The endpoint was correct and audited and still accepted an obligation nothing
  could discharge.
- **`scheduled_for` is stored, not recomputed.** It is the date the user was told. Shortening
  `USER_DELETION_RETENTION_DAYS` therefore shortens the window for _future_ requests and can never
  bring forward an erasure somebody already has a date for.
- **Terminal states are one-way.** A cancelled request is not reopened; the user asks again and gets a
  fresh window from the day they ask. Two timestamp columns rather than one, because "erased" and
  "cancelled" are different answers to a compliance question and collapsing them loses which happened.

---

## 4. What the database must enforce

### 4.1 One profile per account, always (USER-INV-1)

Half of this is the `@unique` on `user_id`. The other half is transactional: the profile insert joins
AUTH's existing login unit of work, which already wraps user creation, role grant, device
registration, session creation, and the outbox writes in one `$transaction`.

```ts
// inside AuthService.verifyOtp's existing transactionManager.execute(async (tx) => { … })
const user = await this.userRepository.create({ phoneNumber }, tx);
await this.userProfileRepository.create({ userId: user.id }, tx); // ← the addition
```

An integration test proves it by failing a later write in the same transaction and asserting zero
profile rows (06 §4, mirroring the existing AUTH atomicity test).

### 4.2 Phone-number change (USER-INV-3)

No new column and no new table. The change is an `UPDATE users SET phone_number = $1 WHERE id = $2`
inside the transaction that also revokes sessions — `users.id` is untouched, so every foreign key
pointing at this identity (rides, payments, wallet, ratings, roles, referrals) follows it for free.
That is the whole reason identity is keyed on a surrogate UUID and not on the phone number.

Uniqueness is enforced by AUTH's **existing partial index**:

```sql
-- already shipped (auth doc 03 §4)
CREATE UNIQUE INDEX uq_users_phone_active ON users (phone_number) WHERE deleted_at IS NULL;
```

Two users racing onto the same free number both pass the step-1 check; the second one's `UPDATE`
violates this index and the transaction rolls back → `409 PHONE_IN_USE` (02 §2.4.2). The application
re-check inside the transaction is a courtesy for the error message; **the index is the enforcement**.

### 4.2b One open deletion request per account

```sql
CREATE UNIQUE INDEX uq_deletion_requests_one_pending
  ON account_deletion_requests (user_id) WHERE status = 'PENDING';
```

A second request while one is open is the **same** request, not a second one — the repository reads
the open row and returns it rather than inserting. Without the index that read is a race, and two
rows would both come due: the second would erase an already-erased account and emit a duplicate audit
event for an act that happened once.

Two `CHECK` constraints ride alongside it, both encoding facts the application would otherwise have
to remember at every call site:

```sql
-- a status and its timestamp are one fact in two columns
CHECK ((status='PENDING'   AND erased_at IS NULL     AND cancelled_at IS NULL)
    OR (status='ERASED'    AND erased_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status='CANCELLED' AND cancelled_at IS NOT NULL AND erased_at IS NULL));

-- a request cannot come due before it was made
CHECK (scheduled_for >= requested_at);
```

`ERASED` with no `erased_at` would make "when was this discharged?" unanswerable by the only table
that claims to answer it.

### 4.3 Ownership scoping (USER-INV-2)

Every collection query filters on `user_id`. That is a correctness rule in the repository and a
performance rule in the schema — see the missing indexes in §5.

### 4.4 Deriving `location` from lat/lng

```sql
UPDATE saved_places
   SET location = ST_SetSRID(ST_MakePoint($1::double precision, $2::double precision), 4326)::geography
 WHERE id = $3 AND user_id = $4;
```

Note the argument order: `ST_MakePoint(longitude, latitude)`. Reversing them is the single most common
PostGIS bug and it fails silently — the point lands in the wrong hemisphere rather than erroring. 06
§8 asserts a known coordinate round-trips.

---

## 5. Missing schema objects (the v1 database work)

Verified absent from `20260724173304_init` and from the Prisma models. These ship as one migration.

```sql
-- 1. Ownership scoping (§4.3). Every list/CRUD query in doc 02 filters on user_id;
--    today both tables sequential-scan for it.
CREATE INDEX ix_emergency_contacts_user ON emergency_contacts (user_id);
CREATE INDEX ix_saved_places_user       ON saved_places (user_id);

-- 2. Saved-place labels are unique per user, case-insensitively (doc 02 §2.6 → 409 CONFLICT).
--    Without this, "Home" and "home" both exist and the picker shows duplicates.
CREATE UNIQUE INDEX uq_saved_places_user_label ON saved_places (user_id, lower(label));

-- 3. Geospatial index. `location` exists but nothing can query it efficiently;
--    `rides`/`geo` need this the moment saved places reach the booking flow.
CREATE INDEX ix_saved_places_location ON saved_places USING GIST (location);

-- 4. Emergency-contact notification order (R-USER-23) — sos reads by (user, priority).
CREATE INDEX ix_emergency_contacts_priority ON emergency_contacts (user_id, priority);
```

Items 1 and 2 are **blocking** for doc 02. Items 3 and 4 are required before `sos` and `rides`
consume these tables, and are cheap to ship now rather than in a later migration.

The corresponding Prisma model changes (`@@index([userId])`, `@@index([userId, priority])`) go in the
same change so `prisma migrate diff` stays clean; the `lower(label)` unique and the GiST index are
raw SQL, because Prisma cannot express a functional index or a GiST index on an `Unsupported` column.

---

## 6. Retention

| Table                | Policy                                                                                         | Ref      |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| `user_profiles`      | Lives and dies with the account. Erased only by the retention job that erases the identity.    | R-DATA-1 |
| `emergency_contacts` | Same. Personal data about **third parties** — erased with the account, never retained past it. | NFR-PRIV |
| `saved_places`       | Same. Home and work addresses are among the most sensitive rows the platform holds.            | NFR-PRIV |
| `users`              | Soft-deleted, never physically removed; archived per policy.                                   | R-DATA-1 |

**What the erasure job actually does** (`AccountErasureJob`, R-USER-18/19). The platform resolves the
tension between R-DATA-1 and the DPDP right to erasure by **"erasing/anonymizing personal identifiers
while retaining the immutable financial/safety record"**
([15_Security/03](../15_Security/03_secrets-and-data-protection.md) §Privacy by design). Applied here:

| Data                                                  | Treatment        | Why                                                                                                                       |
| ----------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `user_profiles`, `emergency_contacts`, `saved_places` | **removed**      | The three rows above: they live and die with the account, and a `deleted_at` on a third party's phone number retains it   |
| The avatar object                                     | released         | Soft-deleted through `FileService`, so FILES' own retention erases the bytes on its schedule (files doc 09 §4.2)          |
| `users` row                                           | anonymized, kept | ~50 tables reference `users.id`. Removing it would take every ride, ledger entry, and dispute the law requires us to keep |
| Rides, wallet, tickets                                | untouched        | The immutable record the same paragraph says to retain                                                                    |

The identity keeps its `id` and its dates and loses everything that names a person: the phone number
becomes a per-account tombstone that is deliberately **not** E.164 (so no client input can match it),
`email` and `password_hash` are nulled, and `deleted_at` is set. A row that cannot be linked back to a
human is what erasure means when the foreign keys must survive.

**The obligation check runs again at erasure**, not just at the request (R-USER-21). Thirty days
passed; a dispute can be opened about a ride taken before the account closed, and erasing the identity
mid-dispute destroys the other side's evidence. A blocked request stays `PENDING` and is retried.

USER writes no audit table of its own. Audit-class changes land in the shared outbox and, for
admin-initiated actions, in `admin_activity_logs` (05 §4).

> **There is no `audit_log` table.** Earlier drafts of AUTH docs 02, 03, 04, 06, and 07 referred to
> one; the schema has `admin_activity_logs` (with `AuditFieldChange` rows) and the transactional
> outbox instead. Rather than invent a third audit store, this doc recorded the discrepancy — and the
> AUTH chain has since been corrected to name the two stores that exist (AUTH doc 03 §6).

---

## 7. Migration plan (expand → migrate → contract)

The §5 migration is **additive only** — four indexes, no column or type changes — so it deploys in one
step with no expand/contract dance. Two operational notes:

- `CREATE UNIQUE INDEX uq_saved_places_user_label` **can fail on existing data** if any user already
  holds two places whose labels differ only in case. The table is empty today; if that changes before
  the migration ships, deduplicate first and re-run.
- Build the indexes `CONCURRENTLY` in production (outside a transaction) so the tables stay writable;
  Prisma migrations run in a transaction by default, so this index goes in its own migration file with
  the transaction disabled.

Any **later** change that removes or retypes a column here follows the AUTH chain's expand → migrate →
contract sequence (auth doc 03 §7) — old and new code run together during a rollout.

---

## 8. What 04–06 inherit

- **04 (errors):** `409 PHONE_IN_USE` is an index violation surfaced as an error; `409 CONFLICT` on a
  saved-place label comes from `uq_saved_places_user_label`; `404 NOT_FOUND` is "the scoped query
  returned no row", not a permission check.
- **05 (events):** payloads carry `userId` and item ids — never a profile value, an address, or a
  contact's phone number (§6, NFR-PRIV).
- **06 (tests):** §8 asserts the §5 objects exist after migrate and actually enforce what they claim,
  including the lat/lng argument order in §4.4.

---

## 9. Traceability

| Schema element                            | Realizes                      |
| ----------------------------------------- | ----------------------------- |
| `user_profiles.userId @unique` + reg. tx  | USER-INV-1, R-USER-1/27       |
| `uq_users_phone_active` (AUTH's)          | USER-INV-3, R-USER-12         |
| phone change as an `UPDATE` on `users.id` | USER-INV-3, R-USER-11         |
| `ix_*_user` indexes (§5)                  | USER-INV-2, R-USER-8/25       |
| `uq_saved_places_user_label` (§5)         | doc 02 §2.6                   |
| `ix_saved_places_location` (§5)           | R-USER-24, PRD FR-RIDE        |
| `ix_emergency_contacts_priority` (§5)     | R-USER-23, PRD FR-SOS         |
| retention rules (§6)                      | R-USER-19, R-DATA-1, NFR-PRIV |

**Next: 04_USER_ERROR_CATALOG** — the concrete bodies for every failure these endpoints and constraints
can produce.
