# Runbook

> **Status:** 🟡 Draft · **Owner:** Engineering / On-call · **Last updated:** 2026-07-20
> **See also:** [Monitoring](./MONITORING.md), [Incident Response](./INCIDENT_RESPONSE.md)

Operational procedures for common situations. Each entry: **symptom → checks → actions**. Keep it current — a stale runbook is worse than none.

---

## 0. First moves (any alert)

1. Check the relevant dashboard ([Monitoring](./MONITORING.md)) — is it one component or system-wide?
2. Check recent deploys/migrations — did something just change? If yes, consider rollback ([Deployment](./DEPLOYMENT.md)).
3. Grab the `requestId`/trace from an example failure and follow it API → worker.
4. If user-facing and severe, open an incident ([Incident Response](./INCIDENT_RESPONSE.md)).

---

## 1. API error rate high (5xx)

- **Checks:** which endpoint(s)? error logs for the top `code`; DB/Redis reachable (`/ready`)? recent deploy?
- **Actions:** if tied to a deploy → roll back. If a dependency (DB/Redis/provider) is down → see its section. Mitigate (feature-flag off a broken P1 feature) then fix forward.

## 2. Match rate dropped / riders can't get a ride

- **Checks:** driver liquidity (are drivers online?); geo freshness (stale locations excluded?); matching/dispatch error logs; `rides.worker` alive and draining?
- **Actions:** if `rides.worker` is down/stuck → restart/scale workers (dispatch timeouts depend on it). If geo presence is stale → check Redis and the `location:update` path. If a config change (radius/weights in `Setting`) caused it → revert the setting.

## 3. Payments failing / dead-letter rising

- **Checks:** `payments.worker` health; gateway success rate/latency; dead-letter queue contents; are failures retriable or permanent?
- **Actions:** **do not** manually re-run money jobs blindly — idempotency keys make retries safe, but confirm the key first. If the gateway is down → jobs retry with backoff; monitor. Drain the dead-letter queue deliberately after root-cause. Escalate to finance if reconciliation is affected. **Never** double-charge to "fix" a stuck payment.

## 4. Queue backlog growing (async falling behind)

- **Checks:** which queue? oldest-job age; worker count vs. load; a poison job crash-looping?
- **Actions:** scale workers horizontally. If one job type is stuck, isolate it (its own worker) so it doesn't starve others. Move a poison job to dead-letter for review.

## 5. Realtime broken (no live location/state)

- **Checks:** Socket.io/Redis adapter health; are clients reconnecting? adapter pub/sub flowing across instances?
- **Actions:** state is server-authoritative — clients reconcile via `GET /rides/:id`, so trips aren't lost. Restore Redis adapter; scale/restart API instances if socket layer is degraded.

## 6. Database issues

- **Slow queries:** find the query (slow-query log/trace); add an index or reshape — don't just add hardware.
- **Connection exhaustion:** check pool size vs. instances; look for leaked connections/long transactions.
- **Replication lag:** shift heavy reads off the replica if stale; investigate write load.
- **Never** run manual writes/migrations against prod outside the pipeline.

## 7. Redis issues

- **Memory pressure/evictions:** identify large/hot keys; check TTLs on presence/geo/idempotency; scale memory. Remember: Redis is loss-tolerant — cache/geo rebuilds; money/state are safe in Postgres.

## 8. Provider outage (payment / SMS / maps / storage)

- **Checks:** provider status; our outbound success rate.
- **Actions:** rely on retries/backoff for transient issues. Use fallback channel where available (push→SMS). Because vendors are behind interfaces (ADR-0007), a prolonged outage can be mitigated by switching provider config. Communicate impact.

## 9. SOS unacknowledged

- **This is safety — highest priority.** Page immediately. Verify the escalation path (`sos` → support/admin) is firing. Manually follow up on the affected trip. Root-cause why escalation didn't reach a human.

## 10. Deploy gone wrong

- Roll back to the previous image tag ([Deployment §7](./DEPLOYMENT.md)). If a migration is implicated, use the tested down-path or forward-fix. Verify the core loop after rollback.

---

## Routine operations

- **Scale workers:** increase replicas by queue depth.
- **Rotate a secret:** update the secret store → redeploy (config is read at boot).
- **Change fares/surge/flags:** update the `Setting` table (audited) — no deploy needed.
- **Restart cleanly:** rely on graceful shutdown (drains requests/jobs).
