# Performance

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **Targets from:** [Feature Catalog — NFRs](../00_PROJECT/FEATURE_CATALOG.md)

Performance is a feature: a rider who waits churns. Design for it, measure it, defend it.

---

## 1. Targets (NFRs)
| Metric | Target |
|---|---|
| p95 latency, core endpoints (request ride, get status) | < 300 ms server-side |
| Realtime push latency (location/state) | < 2 s typical end-to-end |
| Core API availability | ≥ 99.9% |
| Match/dispatch turnaround | fast enough that time-to-match stays low |

## 2. Principles
- **Keep the request path short.** Slow, external, or must-not-lose work goes to a worker ([Queues](../01_ARCHITECTURE/QUEUE_GUIDE.md)), never inline.
- **No external I/O inside a DB transaction.** Gateways, SMS, maps calls happen outside the txn or in a job.
- **Cache hot, cheap-to-recompute, loss-tolerant data in Redis** (driver presence, geo, config) — never money/state (ADR-0004).
- **Index every query path** ([Database Guide](../01_ARCHITECTURE/DATABASE_GUIDE.md)); avoid N+1 with deliberate `select`/`include`.
- **Bound everything:** location-update frequency, matching radius/candidate count, page sizes, payload sizes.

## 3. Realtime
- Rate-limit driver `location:update` to a sane frequency; drop/merge excess.
- Fan out via the Redis Socket.io adapter; don't broadcast to more clients than necessary (scoped rooms).
- Exclude stale locations (> TTL) from matching so we don't chase ghosts.

## 4. Database
- Read replica for heavy analytical reads; primary stays lean for the transactional path.
- Short transactions; avoid long locks and table rewrites (plan online migrations).
- Watch slow-query logs; add indexes or reshape queries, don't paper over with more hardware.

## 5. Scaling
- **API scales horizontally** behind the load balancer; sockets shared via Redis adapter.
- **Workers scale on queue depth**, independent of the API.
- Stateless API instances — no in-memory session/state that breaks under scale-out.

## 6. Measuring (before optimizing)
- Never guess. Use metrics/traces (`observability/`) to find the real bottleneck.
- Track per-endpoint p50/p95/p99, DB query time, queue depth/latency, cache hit rate.
- Load-test the core loop before launch and before major releases.
- Optimize the measured hot path; leave cold paths simple.

## 7. Budgets & regressions
- Treat the NFR targets as budgets. A change that blows the budget is a regression, caught in review/monitoring.
- Add a perf note to PRs that touch the hot path (matching, dispatch, pricing, geo, payments).
