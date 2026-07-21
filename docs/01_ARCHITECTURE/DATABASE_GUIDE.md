# Database Guide

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **Canonical schema:** [`prisma/schema.prisma`](../../prisma/schema.prisma) · **Model:** [ER Diagram](./ER_DIAGRAM.md) · **Decision:** [ADR-0003](./ADR/0003-postgres-prisma-source-of-truth.md)

PostgreSQL via Prisma is the **single source of truth**. Redis is never authoritative — if the two disagree, Postgres wins ([ADR-0004](./ADR/0004-redis-roles-not-source-of-truth.md)).

---

## 1. Schema & migrations
- **`prisma/schema.prisma` is the source of truth.** All changes go through committed, reviewed migrations (`prisma/migrations`).
- **Never** hand-edit a merged migration or the database directly.
- Validate & format before committing:
  ```bash
  npx prisma format && npx prisma validate
  npx prisma migrate dev --name <change>     # local
  npx prisma migrate deploy                   # prod (in release pipeline)
  ```
- A migration lands **with** the code that depends on it, in the same PR.

## 2. Migration review checklist
Every migration PR is reviewed for:
- [ ] **Indexes** for every new query path and foreign key.
- [ ] **Nullability** — is `NULL` meaningful, or should there be a default / NOT NULL?
- [ ] **Backfill / lock impact** — will this rewrite a large table or take a long lock? Plan online migrations for big tables.
- [ ] **Constraints** — unique, check, and FK constraints encode invariants at the DB level.
- [ ] **Reversibility** — is there a safe rollback path?
- [ ] **Enum changes** — additive only where possible; removing an enum value is breaking.

## 3. Access rules
- **Repositories are the only DB touchpoint.** Services never call Prisma directly ([Coding Standards §2](../02_ENGINEERING/CODING_STANDARDS.md)).
- **One writer per table** — a domain owns its tables; others go through its service or an event.
- Reads that cross domains go through the owning module's service or a dedicated read model (analytics).

## 4. Model conventions (every model follows these)

Consistency across models is a hard rule — a reviewer (or Claude) should be able to predict a model's shape.

### 4.1 Primary keys — UUID everywhere
```prisma
id String @id @default(uuid()) @db.Uuid
```
- **UUID for every `id`** — opaque, non-guessable, safe to expose, and merge-friendly across environments/markets.
- Clients treat ids as opaque strings; never expose sequential integers.

### 4.2 Timestamps — on every table
```prisma
createdAt DateTime @default(now())
updatedAt DateTime @updatedAt
```
- **`createdAt` + `updatedAt` on every model.** Stored in **UTC**.

### 4.3 Soft delete — on mutable master data
```prisma
deletedAt DateTime?   // null = live; set = soft-deleted
```
Add `deletedAt` to **user-facing, mutable master entities** — `User`, `RiderProfile`, `DriverProfile`, `Vehicle`, `Document`, `Promo`, `SupportTicket`, `Setting`.
- **Repositories filter `deletedAt: null` by default** on reads; deletion sets the timestamp, it does not remove the row.
- Index it where it participates in hot queries.

**Do NOT soft-delete (these are never deleted at all):**
- **Append-only / audit tables** — `TripEvent`, `LedgerEntry`, `SosEvent`: insert-only, no delete of any kind.
- **Money records** — `Payment`, `LedgerEntry`: immutable financial history.
- **The `Trip`** — closed by its terminal `status` (`CANCELLED`/`PAID`), not by deletion.
- **Ephemeral rows** — `OtpChallenge`, `IdempotencyRecord`: removed by TTL sweeps (`cleanup.worker`), not soft-deleted.

> Why the split: soft delete keeps referential history for things a user can "remove," but audit and money tables must be a complete, immutable record — soft-deleting them would corrupt the trail.

### 4.4 Data types
- **Money → `Decimal`**, never `Float`. Always store the `currency` (ISO-4217).
- **Geo → lat/lng `Decimal(9,6)`** now; a PostGIS `geography` column can be added later without breaking the model.
- **Enums** for closed value sets (status, role, category) — not free strings.
- **JSON columns** (`Fare.breakdown`, `Setting.value`) for flexible, non-queried structures — not as an escape hatch for real relations.

## 5. Invariants enforced at the DB
- `Payment.idempotencyKey` **unique** — DB backstop against double-charge.
- `Rating (tripId, raterId)` **unique** — one rating per party per trip.
- `PromoRedemption (promoId, userId)` **unique** — abuse guard.
- **Partial unique** "one active trip per driver" — added by hand in a migration (Prisma can't express it) **plus** guarded in `rides.service`.

## 6. Append-only (audit) tables
`TripEvent`, `LedgerEntry`, `SosEvent` are **append-only** — services `INSERT` only, never `UPDATE`/`DELETE`. They are the audit trail; balances and history are **derived** from them, never overwritten.

## 7. Transactions
- Money and trip-state mutations run in a **single transaction** (write + ledger + event together, or not at all).
- Keep transactions short; do no external I/O (gateway, SMS) inside a DB transaction — enqueue a job instead.

## 8. Seeding & environments
- `prisma/seed` holds **deterministic** seed data for local/dev/test.
- Never point a dev tool at production. Migrations to prod run only through the release pipeline.

## 9. Performance
- Index the columns you filter/sort/join on; review slow queries.
- Use the read replica for heavy analytical reads; keep the primary for the transactional path.
- Avoid N+1 — use Prisma `include`/`select` deliberately.
