# Runbooks

**Owner:** Engineering (SRE) · **Last reviewed:** 2026-07-06

Step-by-step responses for the critical alerts (Volume 11 §05). Each runbook is written to be
followed **at 3am by a tired on-call engineer** — concrete commands and decisions, not prose. Every
page-level alert links here. Runbooks are living: game days and incidents update them.

> Runbook template: **Alert → Impact → Likely causes → Diagnose → Mitigate → Verify → Escalate.**

---

## RB-01 — Settlement / ledger errors 🔴 SEV1

- **Alert:** settlement error rate > 0, or nightly reconciliation ≠ zero (Volume 5 §05, Volume 11).
- **Impact:** money integrity — drivers/riders may be mis-charged/mis-paid. **Top priority.**
- **Likely causes:** a bug in the settlement consumer, a poisoned event in the DLQ, a data anomaly, a
  recent deploy touching `wallet`.
- **Diagnose:**
  1. Check the **money dashboard**: which transactions failed? Which account doesn't reconcile?
  2. Inspect the **DLQ** (Volume 10 §05) for failed `trip.completed`/settlement events.
  3. Correlate with recent deploys (Volume 11) — did `wallet`/`rides` change?
- **Mitigate:**
  - If a **recent deploy** caused it → **roll back** (Volume 11 §03). Settlements retry from the
    outbox once the good version is back (idempotent — no double-settle, W-4).
  - If a **poison event** → move it aside, keep others flowing; do **not** delete money events.
  - **Never** hand-edit the ledger. Corrections are **reversing transactions** only (Volume 5, W-2).
- **Verify:** reconciliation returns to zero; DLQ drains; no new settlement errors.
- **Escalate:** finance owner + engineering lead; keep the timeline (this will get a postmortem).

## RB-02 — Match rate low / matching failing 🟠 SEV2

- **Alert:** request→match rate below threshold, or assignment latency > target, per city/zone.
- **Impact:** riders can't get rides — direct revenue + trust hit (Volume 2).
- **Likely causes:** driver supply gap in a zone; matching worker backlog; Redis GEO issue; a bug in
  matching after a deploy.
- **Diagnose:**
  1. **Ops dashboard (Volume 9):** is it **low supply** (few online drivers in the zone) or a
     **system** failure (drivers online but not matching)?
  2. Check matching **worker health / queue depth** (Volume 10 §05) and Redis GEO.
- **Mitigate:**
  - **Supply gap** (business) → trigger **driver incentive** / notify ops to rebalance; not an eng
    outage. Surge will also draw supply.
  - **System failure** → scale/restart matching workers; if post-deploy, **roll back**; verify Redis
    GEO reachable.
- **Verify:** match rate recovers in the affected zone; assignment latency back under target.
- **Escalate:** ops (for supply) or eng lead (for system).

## RB-03 — OTP / SMS delivery failing 🟠 SEV2

- **Alert:** OTP send failure rate high, or login-success rate dropping.
- **Impact:** **users can't log in**, and critical notifications may not arrive — acute in this
  low-connectivity market (A6.1).
- **Likely causes:** SMS provider outage/quota, provider key/config issue, regional delivery problem.
- **Diagnose:** check provider status + our send logs (Volume 5 notifications); is it total or
  regional? Is push still working (fallback path)?
- **Mitigate:**
  - Fail over to a **secondary SMS provider** if configured; else contact provider.
  - Ensure **push and voice-OTP fallbacks** are functioning (Volume 5) so some path works.
  - If quota/key → rotate/raise via config (Volume 10 §03), no deploy.
- **Verify:** OTP delivery + login success recover.
- **Escalate:** vendor + eng lead; note for the SMS-provider redundancy action (PRD Q1).

## RB-04 — API availability / error-rate SLO burn 🔴 SEV1/🟠 SEV2

- **Alert:** availability SLO burning fast / 5xx rate elevated.
- **Impact:** riders/drivers hit failures across the app.
- **Diagnose:** which endpoints/services? Correlate with **recent deploy**, DB/Redis health, and
  resource saturation (Volume 11 §05). Check traces for the failing hop.
- **Mitigate:** **roll back** if deploy-correlated (most common); **scale** the saturated tier;
  **failover** DB if it's the data tier (RB-05); shed load / tighten rate limits if a flood.
- **Verify:** error rate normal; SLO stops burning.
- **Escalate:** IC for SEV1; all-hands if platform-wide.

## RB-05 — Primary database failure / high latency 🔴 SEV1

- **Alert:** Postgres unreachable, replication lag high, or connection saturation.
- **Impact:** most of the platform (Postgres is the system of record).
- **Diagnose:** managed-DB console: is the primary down, saturated, or lagging? Connection pool
  exhausted (Volume 6 §05)?
- **Mitigate:**
  - **Primary down** → **promote a read replica** to primary (Volume 11 §06); reconnect app
    (rolling restart to pick up the new endpoint); target RTO ≤ 1h / RPO ≤ 5 min.
  - **Connection saturation** → check the pooler (PgBouncer); scale it / lower per-pod pool; find the
    query storm (slow-query log).
  - **Bad migration/corruption** → **PITR** to just before it (Volume 11 §06) — a heavy call, IC-led.
- **Verify:** app healthy on the new/recovered primary; replication re-established; data intact.
- **Escalate:** IC + DBA/eng lead; postmortem mandatory.

## RB-06 — Worker backlog / DLQ growing 🟠 SEV2

- **Alert:** Redis queue depth rising or dead-letter queue growing (Volume 10 §05).
- **Impact:** delayed settlements, notifications, matching — silent user pain if ignored.
- **Diagnose:** which consumer is behind? Are workers crashing (logs) or just under-scaled? Any
  poison message in the DLQ?
- **Mitigate:** **scale workers** (HPA max, Volume 11 §03); if crashing post-deploy → **roll back**;
  quarantine a poison message (never drop money/safety events) and process the rest.
- **Verify:** queue drains; DLQ stops growing; delayed side-effects catch up (idempotent, safe).
- **Escalate:** eng lead if a consumer bug.

## RB-07 — Redis unavailable / flushed 🟠 SEV2

- **Alert:** Redis unreachable or memory-evicting critical keys.
- **Impact:** live locations, matching locks, rate limits, idempotency **cache** affected — but **not
  the system of record** (Volume 6 §04).
- **Diagnose:** managed Redis health; memory/eviction; connectivity.
- **Mitigate:** restore/failover Redis (HA). Meanwhile: locations **repopulate** within seconds from
  pings; **DB unique constraints** still prevent double-settle/double-active-trip (defense in depth,
  Volume 6 §04) so correctness holds even degraded.
- **Verify:** matching/live-tracking recover; rate limits functioning.
- **Escalate:** SRE.

## RB-08 — Safety / SOS pipeline broken 🔴 SEV1

- **Alert:** SOS routing failing, or safety-event processing errors.
- **Impact:** a rider in danger might not reach help. **Highest human priority.**
- **Mitigate:** immediately ensure the **manual** safety-response path is staffed (ops/phone) while
  the automated path is restored; page the safety owner (Volume 14).
- **Verify:** test SOS end-to-end; confirm routing + logging (R-SAFE-3).
- **Escalate:** safety owner + eng lead; regulatory/comms per policy.

---

## Runbook hygiene

- **Every SEV1/2 postmortem** ([01](01_incident-response.md)) reviews the runbook used — did it work?
  Update it.
- **New page-level alert ⇒ new runbook** in the same change (an alert without a runbook is a gap).
- **Game days** (Volume 12 §05) execute these against staging so they're proven, and RTOs are timed.
