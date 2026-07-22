# Monitoring

> **Status:** 🟡 Draft · **Owner:** Engineering / DevOps · **Last updated:** 2026-07-20
> **Stack:** `observability/` · **See also:** [Logging](../02_ENGINEERING/LOGGING_GUIDE.md), [Runbook](./RUNBOOK.md)

If we can't see it, we can't operate it. Monitoring covers **business health**, **system health**, and **the async plane**.

---

## 1. The three pillars

- **Logs** — structured, correlated by `requestId` ([Logging](../02_ENGINEERING/LOGGING_GUIDE.md)).
- **Metrics** — counters/gauges/histograms for rates, latency, saturation.
- **Traces** — a request followed across API → queue → worker.

## 2. Business KPIs (marketplace health)

From the [Business Requirements](../00_PROJECT/BUSINESS_REQUIREMENTS.md). Dashboard these:

- **Match rate**, **time-to-match** (p50/p95).
- **Trip completion rate**, **cancellation rate** (by party).
- **Payment success rate**, **fare dispute rate**.
- **Driver liquidity** (online drivers per demand zone/hour).
- **SOS / safety-incident response time**.

## 3. System (RED / USE)

- **Rate** — requests/sec per endpoint; socket connections; jobs/sec.
- **Errors** — 5xx rate, error-log rate, socket errors.
- **Duration** — p50/p95/p99 latency per endpoint; DB query time; realtime push latency.
- **Saturation** — CPU/memory, DB connections, Redis memory, event-loop lag.

## 4. Async plane (queues)

- Queue **depth** and **age of oldest job** per queue.
- Job **throughput**, **failure rate**, **retry rate**.
- **Dead-letter count** — especially `payments` (see [Queues](../01_ARCHITECTURE/QUEUE_GUIDE.md)).

## 5. Data & dependencies

- Postgres: connections, replication lag, slow queries, disk.
- Redis: memory, evictions, connection count.
- Providers (payment, SMS, maps, storage): success rate and latency of outbound calls.

## 6. Health endpoints

- `/health` — liveness (process up).
- `/ready` — readiness (DB + Redis reachable). Orchestration gates traffic on this.

## 7. Alerting (symptom-based, not noise)

Alert on user-visible symptoms with clear ownership. Examples:

| Alert                       | Condition (tune)              | Why                           |
| --------------------------- | ----------------------------- | ----------------------------- |
| Core API error rate high    | 5xx > threshold for N min     | riders/drivers failing        |
| Match rate dropped          | below baseline                | supply/matching broken        |
| Payment success dropped     | below baseline                | money at risk                 |
| Payments dead-letter rising | any sustained growth          | charges/payouts stuck         |
| Queue backlog growing       | oldest-job age > threshold    | async plane falling behind    |
| p95 latency breach          | core endpoint > 300 ms        | perf regression               |
| DB/Redis saturation         | connections/memory near limit | imminent outage               |
| SOS unacknowledged          | open SOS > response SLA       | **safety** — page immediately |

- Every alert links to the [Runbook](./RUNBOOK.md) step for it.
- Avoid alert fatigue: page on symptoms, dashboard the rest.

## 8. Dashboards

- **Marketplace** (KPIs), **API health** (RED), **Async** (queues), **Data** (DB/Redis), **Providers**.
- Reviewed at release ([Release Checklist](./RELEASE_CHECKLIST.md)) and during incidents.
