# FILES — Operations

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `files` · **Doc:** 09 of the FILES chain
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Platform) · **Last updated:** 2026-08-02
> **Answers:** _How do we know this module is healthy, and what runs on a schedule?_
> **Traces from:** [01_BUSINESS](01_FILES_BUSINESS_REQUIREMENTS.md) §6, §9 · [07_PROVIDER](07_FILES_STORAGE_PROVIDER.md) §2 · [08_CONFIG](08_FILES_CONFIGURATION.md) §6
> **Traces to:** [11_Infrastructure/06](../11_Infrastructure/06_backups-and-dr.md) · [14_Operations/02](../14_Operations/02_runbooks.md)

---

## 1. Scope of this document

Metrics, health, and the two scheduled jobs. **Backups and disaster recovery are deliberately not
here** — see §6.

---

## 2. Metrics

Follows `OtpMetrics` and `user.metrics.ts` exactly: a small injected class, one method per event,
counters and histograms only. No metric carries a file id, a key, or a URL — a metric label is a
high-cardinality leak waiting to happen, and FILE-INV-2 applies to telemetry too.

### 2.1 Upload

| Metric                    | Type      | Labels              | Answers                           |
| ------------------------- | --------- | ------------------- | --------------------------------- |
| `file.upload.requested`   | counter   | `purpose`           | Demand per purpose                |
| `file.upload.completed`   | counter   | `purpose`           | Successful completions            |
| `file.upload.rejected`    | counter   | `purpose`, `reason` | `reason` ∈ the 04 §2.2 code set   |
| `file.upload.duration_ms` | histogram | `purpose`           | Permission issued → completed     |
| `file.upload.size_bytes`  | histogram | `purpose`           | Whether the §3 ceilings are right |

`file.upload.rejected{reason="CONTENT_MISMATCH"}` is the one to alert on: a sustained rise means
either a broken client or someone probing the magic-byte check.

### 2.2 Read

| Metric                       | Type      | Labels                                |
| ---------------------------- | --------- | ------------------------------------- |
| `file.read.signed`           | counter   | `purpose`, `actor` (`owner` \| `ops`) |
| `file.read.denied`           | counter   | `purpose`                             |
| `file.read.sign_duration_ms` | histogram | `purpose`                             |

`file.read.denied` rising for one purpose is an enumeration attempt — the metric exists precisely
because the _response_ deliberately reveals nothing (04 §4). The signal has to live somewhere, and
telemetry is where it is safe.

### 2.3 Provider

| Metric                           | Type      | Labels                               |
| -------------------------------- | --------- | ------------------------------------ |
| `file.provider.call_duration_ms` | histogram | `provider`, `operation`              |
| `file.provider.errors`           | counter   | `provider`, `operation`, `retryable` |
| `file.provider.retries`          | counter   | `provider`, `operation`              |

### 2.4 Lifecycle and storage

| Metric                                 | Type    | Labels    | Source                              |
| -------------------------------------- | ------- | --------- | ----------------------------------- |
| `file.objects.pending`                 | gauge   | —         | sweeper, per run                    |
| `file.objects.ready`                   | gauge   | `purpose` | retention, per run                  |
| `file.objects.deleted_pending_erasure` | gauge   | —         | retention, per run                  |
| `file.storage.bytes_total`             | gauge   | `purpose` | retention, per run                  |
| `file.sweeper.reclaimed`               | counter | —         | sweeper                             |
| `file.retention.archived`              | counter | `purpose` | retention                           |
| `file.retention.erased`                | counter | `purpose` | retention                           |
| `file.retention.blocked`               | counter | `purpose` | reference guard refused (R-FILE-19) |

The four gauges are **emitted by the jobs**, not computed on a scrape. A `SELECT sum(size_bytes)
GROUP BY purpose` on every Prometheus scrape is a table scan every 15 seconds; once a night, from a
job already reading those rows, is free.

**These gauges light up on the jobs' schedule, not on demand.** The sweeper emits its pair every 15
minutes and retention emits its pair nightly, so a gauge is at worst one interval stale — and is dark
entirely if the `files-maintenance` worker is not deployed, which is itself the signal that nothing
is reclaiming orphans.

### 2.5 Alerts worth defining

| Condition                                               | Severity | Means                                        |
| ------------------------------------------------------- | -------- | -------------------------------------------- |
| `file.provider.errors{retryable=false}` > 0             | **page** | Bad credentials or missing bucket            |
| `file.upload.rejected{reason=CONTENT_MISMATCH}` rate ×5 | warn     | Broken client, or probing                    |
| `file.objects.pending` growing for 24 h                 | warn     | Sweeper not running (expected pre-phase-6)   |
| `file.retention.blocked` > 0 sustained                  | warn     | A consumer never releases its reference      |
| p95 `file.provider.call_duration_ms` > 1 s              | warn     | Provider degradation before it becomes a 503 |

---

## 3. Health and readiness

The app already exposes health and readiness probes with their own tests (10 unit tests). FILES
**registers a readiness contributor**, not a new endpoint.

```
readiness → storage:
  provider.health() with a 2 s budget
    reachable ∧ bucketExists ∧ credentialsValid → ready
    otherwise                                    → not ready, with the failing field
```

| Rule                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Readiness, not liveness.** A storage outage must drain this instance from the load balancer; it must not restart a process that is working fine.                              |
| **Never in the request path.** Health runs on the probe's schedule. Checking the bucket per upload would double every request's latency to prove something that changes hourly. |
| **The result is cached** for the probe interval — probes must not become a load test.                                                                                           |
| **`mock` always reports healthy.** It has nothing to be unhealthy about, and CI must not need a bucket.                                                                         |

The response names the failing field (`bucketExists: false`) and **never** the bucket, region, or
credentials (04 §5).

---

## 4. Background jobs

Two jobs, both running on the `files-maintenance` queue (01 §13.4). Both stay written as plain
services and tested by direct invocation (06 §8); the worker's processor is a thin adapter that
resolves one from the container and calls `run(now)`, so nothing about the jobs knows a queue exists.

Both cron patterns below are interpreted in **`Etc/UTC`**, pinned by the scheduler rather than
inherited from the host clock.

### 4.1 The sweeper — R-FILE-22

| Property    | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schedule    | every 15 min (`FILE_SWEEPER_CRON`)                                                                                                                       |
| Query       | `status = 'PENDING' AND upload_expires_at < now()`, `LIMIT 500`, riding `ix_files_sweep_pending`                                                         |
| Action      | `provider.delete(key)` — idempotent — then delete the row                                                                                                |
| Ordering    | **Object first, row second.** A deleted row with a live object is an orphan nobody can ever find; a deleted object with a live row is retried next pass. |
| Failure     | Leave the row; the next run retries. No dead-letter — the work is inherently idempotent and self-healing.                                                |
| Concurrency | One run at a time, guarded by a Redis lock. Two sweepers would both try to delete the same keys — harmless, but wasteful.                                |

### 4.2 Retention — R-FILE-18/20/21

| Property | Value                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schedule | daily 03:00 (`FILE_RETENTION_CRON`)                                                                                                                                                                                                                                      |
| Query    | `(deleted_at IS NOT NULL OR status = 'SUPERSEDED') AND erased_at IS NULL AND archived_at IS NULL`, plus per-purpose window from 02 §5, `LIMIT 200`                                                                                                                       |
| Guard    | **Ask the owning module first** (R-FILE-19). Refused → count `file.retention.blocked` and skip.                                                                                                                                                                          |
| Action   | `archive()` or **`erase()`** — never `delete()` — per 02 §5's terminal action; then set **`archived_at` or `erased_at`, never both** (FILE-INV-9). A plain delete on a versioned bucket leaves the bytes recoverable while the audit trail says they are gone (08 §2.2). |
| Event    | `file.erased` with `action`, in the same transaction as the row update                                                                                                                                                                                                   |
| Failure  | Per-file, isolated. One file's failure never aborts the batch.                                                                                                                                                                                                           |
| Retries  | `FILE_JOB_MAX_ATTEMPTS` (5), then **dead-letter** — see §4.3                                                                                                                                                                                                             |

### 4.3 Why retention has a dead-letter queue and the sweeper does not

The sweeper's failure mode is "an orphan survives another 15 minutes" — self-correcting, invisible,
and free. Retention's failure mode is **"a file that should have been erased was not"**, which is a
compliance finding. It must not fail silently, and it must not retry forever pretending it will
eventually work.

After 5 attempts the file is recorded in the dead-letter queue with its last error, `file.retention.blocked`
increments, and the alert in §2.5 fires. A human decides.

### 4.4 Ordering constraint

Retention **must not** run while the sweeper is mid-batch on the same rows. In practice their query
predicates are disjoint (`PENDING` vs `deleted_at IS NOT NULL`), so no lock is shared — recorded
because that disjointness is a property worth preserving, not an accident.

---

## 5. Runbook entries

To be added to [14_Operations/02_runbooks.md](../14_Operations/02_runbooks.md) when this ships:

| Symptom                                       | First move                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| All uploads returning `503`                   | Check readiness `storage` contributor; likely credentials or bucket policy           |
| No maintenance job has run at all             | Check the `files-maintenance` worker deployment is up — it owns the schedules too    |
| `CONTENT_MISMATCH` spike from one app version | Client bug — do not relax the check; ship a client fix                               |
| `file.objects.pending` climbing               | Sweeper stopped, or a client that never calls `complete`                             |
| A `READY` file whose object is missing        | Data loss. Restore from the versioned bucket (§6), then audit the reference guard    |
| Retention dead-letter non-empty               | A consumer's reference check is failing; find it before the compliance window closes |

---

## 6. Backups and disaster recovery — owned upstream

**Deliberately not specified here.** [11_Infrastructure/06_backups-and-dr.md](../11_Infrastructure/06_backups-and-dr.md)
already covers object storage at the platform level:

> **Object storage** (KYC docs, media) — versioned, encrypted bucket + cross-location replication;
> versioned; lifecycle per retention policy.

and names the recovery path for object-storage loss ("restore from versioned/replicated bucket").
Restating that in a module document creates two sources of truth for one bucket, and the module's
copy would be the one that goes stale.

What this module contributes to that story, and what §4.2 must therefore never do:

| Platform DR assumes        | This module guarantees                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioning is on           | Nothing here disables it. The sweeper's `delete()` writes a delete marker; only retention's `erase()` removes versions, and only for files whose window has closed (08 §2.2) |
| Retention drives lifecycle | 02 §5's retention column is the input to the bucket's lifecycle rules                                                                                                        |
| Cross-region replication   | Keys are region-agnostic (03 §5) — no key encodes a region                                                                                                                   |
| Restore is possible        | `files` rows survive object loss, so a restored object rejoins its row                                                                                                       |

**The last row is the design's real DR property.** Because the database holds the key and the object
holds only bytes, a restored bucket needs no reconciliation pass: every row still points where it
always pointed. This is what would have been lost had domain rows stored URLs (01 §13.1).

---

## 7. Traceability

| Section | Realizes                       | Proven by (06)            |
| ------- | ------------------------------ | ------------------------- |
| §2      | NFR-8 observability            | metrics asserted per flow |
| §3      | NFR-3, 04 §6 fail-closed       | §5 fail-closed            |
| §4.1    | R-FILE-22                      | §8 direct invocation      |
| §4.2    | R-FILE-18/19/20/21, FILE-INV-5 | §4, §6                    |
| §6      | 11_Infrastructure/06           | — (platform-owned)        |
