# Volume 6 — Database Design

> The exact data model. Volume 5 described _behavior_; this volume pins down _storage_: every table,
> column, type, key, and index. If Volume 5 is the blueprint, this is the bill of materials. The
> schema here is authoritative — the SQLAlchemy models and Alembic migrations must match it.

**Owner:** Engineering (Data) · **Last reviewed:** 2026-07-06

---

## Contents

| Doc                                                                    | Topic                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| [01_er-diagram.md](01_er-diagram.md)                                   | The entity-relationship map across all modules           |
| [02_schema-postgres.md](02_schema-postgres.md)                         | Concrete PostgreSQL DDL, per module                      |
| [03_postgis-geo.md](03_postgis-geo.md)                                 | Geometry columns, SRID, spatial indexes, zone queries    |
| [04_redis-keys.md](04_redis-keys.md)                                   | The Redis key catalog: structure, TTL, purpose           |
| [05_indexing-partitioning.md](05_indexing-partitioning.md)             | Indexes, partitioning, and query performance             |
| [06_audit-softdelete-migrations.md](06_audit-softdelete-migrations.md) | Audit, soft delete, immutability, versioning, migrations |

---

## Global conventions (apply to every table)

These are non-negotiable and follow [Volume 1 naming](../00_Project/03_naming-conventions.md):

| Convention   | Rule                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Table names  | `snake_case`, **plural** (`ride_requests`, `ledger_entries`)                                     |
| Column names | `snake_case`, **singular** (`driver_id`, `created_at`)                                           |
| Primary key  | `id` — `BIGINT GENERATED ALWAYS AS IDENTITY` (or ULID where external-facing)                     |
| Foreign key  | `<singular_table>_id`, with an explicit `REFERENCES` + index                                     |
| Timestamps   | every table has `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`; mutable tables add `updated_at` |
| Soft delete  | soft-deletable tables add `deleted_at TIMESTAMPTZ NULL` (R-DATA-1)                               |
| Money        | **`BIGINT` paisa** (integer minor units) — never `float`/`money` (FR-DATA-03)                    |
| Enums        | Postgres `ENUM` or a `*_type`/`*_status` text column with a `CHECK` — chosen per case            |
| Time         | **`TIMESTAMPTZ`** everywhere, stored UTC; never naive timestamps                                 |
| Geo          | PostGIS `geography(Point,4326)` / `geometry(Polygon,4326)` (see [03](03_postgis-geo.md))         |
| Booleans     | named as questions (`is_online`, `is_suspended`)                                                 |

## Design principles

1. **Postgres is the system of record; Redis is derived/ephemeral** (ADR-0003, Volume 4). If losing
   it on a restart is unacceptable, it's in Postgres.
2. **Money is append-only double-entry** — the ledger is never updated in place (Volume 5, W-2).
3. **Normalize by default; denormalize deliberately** — with a comment/ADR when we do (e.g. a
   cached balance), never by accident.
4. **Every FK is indexed** — unindexed FKs are a classic performance trap.
5. **Constraints in the database, not just the app** — `NOT NULL`, `CHECK`, `UNIQUE`, and FK
   constraints encode invariants the app can't be trusted to always enforce.
6. **High-volume, time-series tables are partitioned** (locations, events, audit) — see [05](05_indexing-partitioning.md).

## Module → tables map

| Module        | Primary tables                                                                     |
| ------------- | ---------------------------------------------------------------------------------- |
| users         | `users`                                                                            |
| auth          | `refresh_tokens` (OTP lives in Redis)                                              |
| drivers       | `drivers`, `kyc_documents`                                                         |
| vehicles      | `vehicles`, `driver_vehicle_assignments`                                           |
| rides         | `ride_requests`, `trips`, `trip_locations`, `trip_events`                          |
| pricing       | `pricing_configs`, `zones`, `surge_states`                                         |
| wallet        | `accounts`, `ledger_transactions`, `ledger_entries`, `account_balances`, `payouts` |
| payments      | `payment_intents` (phase 2)                                                        |
| notifications | `device_tokens`, `notification_log`                                                |
| ratings       | `ratings`                                                                          |
| admin/cross   | `audit_log`, `outbox`, `users_suspensions`                                         |
