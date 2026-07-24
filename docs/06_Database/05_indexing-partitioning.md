# Indexing, Partitioning & Performance

**Owner:** Engineering (Data) · **Last reviewed:** 2026-07-06
**Realizes:** NFR-PERF-01/07, NFR-SCALE-03

Indexes make the queries we run fast; partitioning keeps the high-volume tables manageable. Both are
**deliberate** — we index the queries we actually run (from Volume 5 flows) and partition the tables
that actually grow without bound. Over-indexing slows writes; under-indexing slows reads. This page
records the decisions.

---

## Indexing strategy

### The rules

1. **Every foreign key is indexed.** Postgres does not auto-index FKs; unindexed FKs make joins and
   cascade checks slow. This is the #1 avoidable performance bug.
2. **Index for the hot query, not the table.** We index the columns in `WHERE`/`JOIN`/`ORDER BY` of
   the queries in Volume 5, not "every column just in case".
3. **Partial indexes for hot subsets.** Active trips, unpublished outbox rows, approved-and-online
   drivers — small hot slices of big tables get partial indexes so the index stays tiny.
4. **Composite index column order = equality first, then range/sort.** e.g.
   `(state, created_at)` supports `WHERE state=? ORDER BY created_at`.
5. **GiST for geometry** ([03](03_postgis-geo.md)); **B-tree** for the rest; **GIN** for JSONB/array
   search where needed.

### Key indexes by table (the ones that earn their keep)

| Table                        | Index                                                | Serves                                                  |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `users`                      | `uq_users_phone`                                     | login/lookup by phone                                   |
| `trips`                      | `uq_rider_one_active_trip` (partial unique)          | **enforces one active trip/rider** + fast active lookup |
| `trips`                      | `ix_trips_driver_active` (partial)                   | driver's current trip                                   |
| `trips`                      | `ix_trips_state_created`                             | ops queues, matching sweeps, `GET /trips/active`        |
| `ledger_entries`             | `ix_ledger_entries_account` (account_id, created_at) | balance computation, earnings, statements               |
| `ledger_transactions`        | `uq_ledger_txn_idem` (unique)                        | idempotent settlement (safety net)                      |
| `kyc_documents`              | `ix_kyc_documents_expiry` (partial)                  | daily expiry sweep (R-KYC-3)                            |
| `outbox`                     | `ix_outbox_unpublished` (partial)                    | relay picks up unsent events fast                       |
| `zones`                      | `ix_zones_geom` (GiST)                               | zone containment for surge/serviceability               |
| `driver_vehicle_assignments` | `uq_active_assignment_per_driver` (partial unique)   | one active vehicle/driver                               |

> **Partial unique indexes are doing real work here.** `uq_rider_one_active_trip` isn't just for
> speed — it makes "a rider has two active trips" _impossible at the database level_, backing up the
> application invariant. The DB is the last line of defense for invariants (Volume 6 principle #5).

---

## Partitioning strategy

Three tables grow without bound and are time-series by nature. They are **range-partitioned by
time** so old data can be dropped/archived cheaply and queries stay fast on recent data.

| Table              | Partition by                   | Why                                                                            | Retention                                                         |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `trip_locations`   | `RANGE (recorded_at)`, monthly | Millions of pings; queried by recent trip; needed for R-SAFE-4 then archivable | Hot: recent months; then archive/drop per safety-retention policy |
| `notification_log` | `RANGE (created_at)`, monthly  | High volume, only recent rows are operationally interesting                    | Short (e.g. 3–6 months)                                           |
| `audit_log`        | `RANGE (created_at)`, monthly  | Grows forever; compliance needs it but rarely queries old rows hot             | Long (compliance), archived to cold storage                       |

```sql
-- example: monthly partition creation (automated by a maintenance job)
CREATE TABLE trip_locations_2026_07 PARTITION OF trip_locations
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
```

Benefits: **dropping** an old partition is instant (vs. a slow `DELETE`), indexes stay small,
`autovacuum` stays healthy, and queries on recent data hit only recent partitions (partition
pruning). A maintenance job pre-creates next month's partition (Volume 13).

### What we do **not** partition (yet)

`trips`, `ledger_entries`, `users` — these grow, but at launch scale a well-indexed table is fine,
and partitioning money/trip tables adds complexity (cross-partition uniqueness, FKs). We partition
them **when** volume demands it, recorded as an ADR at that time — not speculatively (YAGNI, but the
door is open because IDs and time columns are already there).

---

## Read scaling

- **Read replicas** (Volume 4 deployment) serve read-heavy, non-critical queries: ops dashboards,
  reports, analytics. The **primary** serves all writes and read-your-write critical paths (a driver
  must see their just-created trip on the primary).
- Money/trip-state reads that must be current go to the **primary**; eventual-consistency-tolerant
  reads (reports, historical) go to **replicas**.

---

## Performance guardrails

| Guardrail                    | Target / practice                                                             |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Slow query log               | Log queries > 100 ms; review in ops (NFR-OBS)                                 |
| N+1 queries                  | Forbidden in review; use eager loading / explicit joins in repositories       |
| `EXPLAIN` on new hot queries | Required for any new query on `trips`/`ledger_entries`                        |
| Index bloat / unused indexes | Periodic audit; drop indexes nothing uses (they cost writes)                  |
| Connection pooling           | App uses a pooler (e.g. PgBouncer) so pod scaling doesn't exhaust connections |
| Geo query latency            | Nearby-driver ≤ 100 ms — served by Redis, not Postgres (NFR-PERF-07)          |
