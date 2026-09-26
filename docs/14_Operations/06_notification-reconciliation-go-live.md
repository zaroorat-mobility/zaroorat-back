# Notification reconciliation (F3) — go-live

**Owner:** Engineering (notifications) · **Last reviewed:** 2026-09-26

The outbox notification reconciliation recovers ride and payment push notifications that were
**lost before a notification row existed**: the live consumer's lookup or insert failed, the
consumer swallowed the failure (as it must, to keep ride and payment state safe), and the outbox
relay marked the event published. PA-11 cannot recover those — it only re-enqueues rows that
exist. This document takes the reconciliation from its shipped default (**dry run**) to **on**,
with evidence at every step.

> Rollback and emergency disable: [RB-09](02_runbooks.md#rb-09--notification-event-reconciliation-disable-or-roll-back--sev3).

---

## 1. What is being switched on

The job `notification-event-reconciliation` runs every minute on the `notifications-maintenance`
queue (beside PA-11). What it does is set by `NOTIFICATION_EVENT_RECONCILIATION_MODE` on the
**worker**:

| Mode                 | What a run does                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| unset or `dry-run`   | Scans, plans and **counts** what it would recover (`…_would_recover`). Writes nothing, enqueues nothing.            |
| `on`                 | Writes each missing notification and enqueues it — **a real push reaches the rider or driver**, up to an hour late. |
| `off` (or any other) | Nothing. No lock, no database or Redis access.                                                                      |

It only reconciles events published at least **60 s** ago and created less than **1 h** ago (the
delivery TTL). Ride offers are never reconciled. It reuses the live consumer's planner and
writer, so a recovered notification is exactly what the consumer would have written.

**Where to look.** Worker metrics — every `notification_event_reconciliation_*` series, PA-11's
`notification_reconciliation_*` — are served at `http://<worker>:3001/metrics`. Live-path failures
(`notification_live_*`) are on the API's `/metrics`. Each run also logs
`[NotificationEventReconciliation] run finished` with its full report (only when it scanned
something or stopped early).

## 2. Prerequisites — all must hold before Phase 1

- [ ] The release contains the whole F3 change (planner/writer consumer, reconciliation job,
      metrics, scheduling, worker `/metrics`) and the Phase A migrations.
- [ ] Both indexes exist (the unique index is the correctness boundary):

  ```sql
  SELECT indexname FROM pg_indexes
  WHERE indexname IN ('notifications_idempotency_key_key', 'outbox_events_status_published_at_idx');
  -- expect 2 rows
  ```

- [ ] Prometheus scrapes **every worker** at `:3001/metrics` (internal network only). There is no
      scrape configuration in this repository; add a target per worker. Check:
      `curl -s http://<worker>:3001/metrics | grep notification_event_reconciliation_runs`.
- [ ] API and worker clocks are NTP-synchronised (skew well under 1 s; the 60 s grace assumes it).
- [ ] Both schedulers are installed — from a worker container:

  ```sh
  node -e "const {Queue}=require('bullmq');const Redis=require('ioredis');const q=new Queue('notifications-maintenance',{connection:new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:null})});q.getJobSchedulers().then(s=>{console.log(s.map(x=>x.key+' '+x.pattern));return q.close();}).then(()=>process.exit(0))"
  # expect: notification-reconciliation, notification-event-reconciliation
  ```

- [ ] On-call has read RB-09.

## 3. Phase 1 — staging

**3.1 Dry run.** Deploy with the mode unset. `notification_event_reconciliation_runs{result="caught_up",scope="dry-run"}`
rises by one a minute; `…_runs{result="error"}` stays 0.

**3.2 Fault injection** — proves the gap is real and closed. Uses
[`scripts/notification-event-fault-probe.sql`](../../scripts/notification-event-fault-probe.sql).
**Staging only.** Keep the mode at `dry-run` while the probe is installed: an `on` run would hit the
same constraint and record a permanent failure.

1. Run the `INJECT` statement from the probe script (`psql`). Every new `ride.started`
   notification insert is now rejected.
2. Drive a staging ride to **started** (test rider with a real device).
3. Within ~2 minutes expect:
   - API: `notification_live_persist_failed{event_type="ride.started"}` +1; no notification row.
   - Worker: `notification_event_reconciliation_would_recover{event_type="ride.started"}` +1.
   - [`scripts/notification-event-audit.sql`](../../scripts/notification-event-audit.sql):
     `ride.started / customer` has `missing = 1`.
4. Run the `REMOVE` statement. Confirm: `SELECT 1 FROM pg_constraint WHERE conname = 'f3_fault_probe'`
   returns nothing.
5. Set `NOTIFICATION_EVENT_RECONCILIATION_MODE=on` on the staging worker and restart it.
6. Within ~2 minutes: `…_recovered{event_type="ride.started"}` +1, the test device shows
   **"Trip started"**, and the audit shows `missing = 0`.

Pass = all of step 3 and step 6 observed. The same procedure is exercised against PostgreSQL by
`tests/integration/notification-event-audit-postgres.test.ts`.

## 4. Phase 2 — production dry run (at least 7 days, including a weekend peak)

Deploy with the mode unset. Check daily:

| Signal                        | PromQL (sum across worker instances)                                                                                       | Expect                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| What `on` would recover       | `sum by (event_type) (increase(notification_event_reconciliation_would_recover[1d]))`                                      | Small; close to the next row    |
| What the live path lost (API) | `sum by (event_type) (increase(notification_live_persist_failed[1d]))`, and the same for `notification_live_lookup_failed` | Together, explain the row above |
| Runs by outcome               | `sum by (result) (increase(notification_event_reconciliation_runs[1d]))`                                                   | `caught_up` ≈ 1440; no `error`  |
| Permanent failures            | `sum by (reason) (increase(notification_event_reconciliation_failed{result="permanent"}[1d]))`                             | 0, or each one explained        |
| Lag                           | `max(notification_event_reconciliation_lag_seconds)`                                                                       | 0 almost always                 |
| Run duration                  | `max(notification_event_reconciliation_last_run_duration_ms)`                                                              | Well under 5 000                |
| PA-11 (unchanged)             | `sum(increase(notification_reconciliation_reenqueued[1d]))`                                                                | At its pre-release baseline     |

**Audit cross-check (at least three times, one at peak).** The audit is independent of the job, so
agreement means both are right:

1. `DEL notification:event-reconciliation:cursor:dry-run` (the next dry run rescans the last hour).
2. At the next minute boundary, run the audit (`psql "$DATABASE_URL" -f scripts/notification-event-audit.sql`)
   and read that minute's `run finished` log line.
3. The audit's total `missing` should equal the run's `wouldRecover`, give or take events crossing
   the window edges between the two queries.

**Query plan.** Once, on production (`EXPLAIN` without `ANALYZE` executes nothing):

```sql
EXPLAIN SELECT id FROM outbox_events
WHERE status = 'PUBLISHED' AND event_type IN ('ride.started','ride.completed')
  AND published_at >= now() - interval '1 hour' AND published_at < now() - interval '1 minute'
ORDER BY published_at, id LIMIT 200;
-- expect: Index Scan using outbox_events_status_published_at_idx
```

## 5. Go / no-go

Switch on only if **all** hold:

- [ ] Phase 1 passed (both halves of the fault injection observed).
- [ ] At least 7 production days in dry run, including a weekend peak.
- [ ] No `runs{result="error"}`; permanent failures 0 or each explained.
- [ ] `lag_seconds` 0 in at least 99% of runs; `last_run_duration_ms` under 5 000 at peak.
- [ ] Three audit cross-checks agreed.
- [ ] PA-11's re-enqueue rate unchanged from before the release.
- [ ] The query plan uses `outbox_events_status_published_at_idx`.
- [ ] The alerts in §7 are live.

## 6. Phase 3 — switch on (production)

1. Optional, to avoid a burst of up-to-an-hour-late pushes: run the audit first. If it reports a
   large `missing`, switch at a quiet time, or skip the backlog by starting the `on` cursor at
   now minus 60 s, in the application's Redis database (the one `REDIS_URL` selects):
   `SET notification:event-reconciliation:cursor '{"publishedAt":"<ISO now − 60 s>","id":"00000000-0000-0000-0000-000000000000"}'`.
2. Set `NOTIFICATION_EVENT_RECONCILIATION_MODE=on` on the **worker** and roll the workers. The API
   needs nothing.
3. First hour: `…_recovered` matches what the dry run predicted; `…_failed{result="permanent"}` 0;
   `…_enqueue_failed` 0 (any are PA-11's to recover); delivery outcomes
   (`notification_no_active_device`) at baseline.
4. First day: the audit shows `missing` 0 outside the grace minute.

## 7. Alerts

Validate with `promtool` before loading. Counters are per process; sum across instances.

| Alert                  | Expression                                                                               | For  | Route                 |
| ---------------------- | ---------------------------------------------------------------------------------------- | ---- | --------------------- |
| Reconciliation lagging | `max(notification_event_reconciliation_lag_seconds) > 600`                               | 10 m | Page → RB-09          |
| Permanent failures     | `sum(increase(notification_event_reconciliation_failed{result="permanent"}[1h])) > 0`    | —    | Ticket                |
| Database aborts        | `sum(increase(notification_event_reconciliation_runs{result="transient_db"}[10m])) >= 5` | —    | Ticket (see RB-05)    |
| Run errors             | `sum(increase(notification_event_reconciliation_runs{result="error"}[15m])) > 0`         | —    | Ticket                |
| Slow runs              | `max(notification_event_reconciliation_last_run_duration_ms) > 30000`                    | 15 m | Ticket                |
| Not running            | `sum(increase(notification_event_reconciliation_runs[5m])) == 0`                         | 10 m | Ticket (worker down?) |

"Not running" stays silent if the worker target disappears entirely (the sum is then empty, not
zero); pair it with the standard `up{…} == 0` alert on the worker scrape target.

## 8. Last step — make `on` the default (plan step S12)

After at least 14 days `on` in production with §5's signals holding, change the code default so an
unset mode means `on`: `resolveReconciliationMode`, `.env.example`, and — deliberately — the tests
that pin "unset is a dry run". Until then `on` exists only as an explicit worker setting, and every
other environment stays in dry run.

## 9. Rollback

- **Disable:** `NOTIFICATION_EVENT_RECONCILIATION_MODE=off`, restart workers.
- **Remove the code:** revert, **and** remove the scheduler — [RB-09](02_runbooks.md#rb-09--notification-event-reconciliation-disable-or-roll-back--sev3).
  Without it the leftover scheduler fails a job every minute.

Recovered notifications are ordinary notifications; nothing needs undoing.
