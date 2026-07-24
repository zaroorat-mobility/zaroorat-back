# Database Maintenance

**Owner:** Engineering (SRE / DBA) · **Last reviewed:** 2026-07-06
**Realizes:** Volume 6 (schema, partitions, backups), Volume 5 §05 (reconciliation)

Postgres is the system of record — its health _is_ the platform's health. This page is the routine
care that keeps it fast, correct, and recoverable. Most of it is **automated jobs** (Volume 10 §05
scheduler / k8s CronJobs); this page is what they do and what humans check.

---

## Routine maintenance (automated)

| Task                           | Cadence    | Purpose                                                   | Ref           |
| ------------------------------ | ---------- | --------------------------------------------------------- | ------------- |
| **Partition management**       | daily      | pre-create next month's partitions; drop/archive old ones | Volume 6 §05  |
| **Autovacuum monitoring**      | continuous | prevent bloat & transaction-ID wraparound                 | Postgres      |
| **Reconciliation**             | daily      | assert global ledger sums to zero; alert finance on drift | Volume 5 §05  |
| **Backup + WAL archiving**     | continuous | PITR (RPO ≤ 5 min)                                        | Volume 11 §06 |
| **Backup restore drill**       | periodic   | prove backups actually restore                            | Volume 11 §06 |
| **KYC/doc expiry sweep**       | daily      | move drivers with expired docs → `docs_required`          | Volume 5 §06  |
| **Location snapshot/archival** | periodic   | archive old `trip_locations` per retention                | Volume 6 §05  |
| **Slow-query review**          | weekly     | catch regressions, missing indexes                        | Volume 6 §05  |
| **Index/bloat audit**          | periodic   | drop unused indexes; reindex if bloated                   | Volume 6 §05  |
| **Token/OTP cleanup**          | periodic   | prune expired refresh tokens                              | Volume 5 §01  |

---

## Partitioning maintenance (the one that bites if forgotten)

High-volume tables (`trip_locations`, `notification_log`, `audit_log`) are **range-partitioned by
time** (Volume 6 §05). Maintenance:

```mermaid
flowchart LR
    J["daily job"] --> C["CREATE next-month partition (ahead of time)"]
    C --> A["archive/drop partitions past retention"]
    A --> V["verify partition pruning working"]
```

- **Pre-create ahead:** the next partition must exist **before** rows need it — a missing partition =
  failed inserts. The job creates it with margin.
- **Drop is instant:** old partitions past retention are **dropped** (or archived first), which is
  instant vs. a slow `DELETE` — the whole reason for partitioning.
- **Alert if the job fails** — a missing future partition is a latent SEV.

---

## Reconciliation (money correctness) — Volume 5 §05

The daily reconciliation is a **correctness check**, not just maintenance:

- Sum all `ledger_entries` per account and globally; **assert the global ledger sums to zero** (W-5).
- Assert **cash-clearing** matches reported cash collection.
- Any drift → **RB-01 (SEV1)**: money integrity is at stake (Volume 13 §02). This job is a primary
  fraud/bug detector (BR-5) — it's how a silent double-post or a missed commission surfaces.

---

## Vacuum & bloat

- **Autovacuum** must keep up on hot tables (`trips`, `ledger_entries`) — monitor dead-tuple ratios
  and vacuum lag. Tune autovacuum for high-write tables.
- **Transaction-ID wraparound** is monitored (a classic Postgres foot-gun) — alert well before any
  threshold.
- Append-only tables (ledger/audit) bloat little (no updates), which is a side-benefit of the
  immutability design (Volume 6 §06).

---

## Migrations in production (operational view)

- Applied by the pipeline as a **pre-deploy Job**, expand→contract (Volume 6/11) — the _contract_
  (destructive) step is a **separate, later** release after all code uses the new schema.
- **Large backfills** run in **batches off the critical path** (Volume 6 §06) so they don't hold long
  locks or block the deploy — a big `UPDATE` in a migration is a known outage cause; we don't do it.
- **`CREATE INDEX CONCURRENTLY`** for indexes on big tables (no write lock).
- Every migration is tested on a **prod-like DB in staging** first (Volume 11 §02) to catch
  lock/perf issues before production.

---

## Connections & pooling

- The app connects through a **pooler** (PgBouncer) so pod autoscaling (Volume 11 §03) doesn't
  exhaust Postgres connections (Volume 6 §05). Pool sizing is a capacity lever (Volume 13 §04).
- **Connection saturation** is a common incident (RB-05) — monitored, with the pooler as the
  mitigation.

---

## Read replicas

- **Reads that tolerate slight staleness** (ops dashboards, reports, analytics) go to **replicas**;
  writes and read-your-write critical paths go to the **primary** (Volume 6 §05).
- **Replication lag** is monitored — high lag means replicas serve stale data and is a signal (could
  precede RB-05). A replica is also the **failover target** (Volume 11 §06).

---

## Health checklist (what on-call/DBA watches)

| Check              | Healthy                                |
| ------------------ | -------------------------------------- |
| Reconciliation     | sums to zero daily                     |
| Next partitions    | pre-created; old ones archived/dropped |
| Autovacuum / bloat | keeping up; no wraparound risk         |
| Replication lag    | low                                    |
| Connections        | headroom via pooler                    |
| Slow queries       | none new / all indexed                 |
| Backups            | recent + **restore-drill passed**      |

A red on **reconciliation** or **backups** is treated most seriously — one is money correctness, the
other is our ability to recover at all.
