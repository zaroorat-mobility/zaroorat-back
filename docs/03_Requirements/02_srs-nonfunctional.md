# SRS — Non-Functional Requirements (NFRs)

**Owner:** Engineering & SRE · **Last reviewed:** 2026-07-06

NFRs are the **qualities** the system must have — how fast, how reliable, how secure, how
usable. They are as binding as functional requirements and are the acceptance bar for
architecture (Volume 4) and operations (Volume 13). Each has an ID (`NFR-<area>-##`) and a
**measurable** target — an NFR without a number is an opinion, not a requirement.

---

## NFR-PERF — Performance & latency

| ID          | Requirement                                     | Target                              |
| ----------- | ----------------------------------------------- | ----------------------------------- |
| NFR-PERF-01 | API read endpoints P95 latency                  | ≤ 300 ms (server-side)              |
| NFR-PERF-02 | API write endpoints P95 latency                 | ≤ 500 ms                            |
| NFR-PERF-03 | Fare estimate response                          | ≤ 800 ms end-to-end (incl. routing) |
| NFR-PERF-04 | Match assignment (request → first offer)        | ≤ 3 s under normal load             |
| NFR-PERF-05 | Live location update propagation (driver→rider) | ≤ 2 s                               |
| NFR-PERF-06 | Mobile cold start to interactive                | ≤ 3 s on a mid-range Android        |
| NFR-PERF-07 | Nearby-driver geo query                         | ≤ 100 ms at launch data volumes     |

## NFR-SCALE — Scalability & capacity

| ID           | Requirement                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-SCALE-01 | The backend SHALL scale horizontally (stateless API instances behind a load balancer).                                                       |
| NFR-SCALE-02 | Session/state SHALL live in Postgres/Redis, not in app-instance memory, so any instance can serve any request.                               |
| NFR-SCALE-03 | The system SHALL sustain the launch-city concurrent-trip load with headroom for 10× seasonal tourist peaks (A6.3) via scaling, not redesign. |
| NFR-SCALE-04 | High-frequency driver location writes SHALL go to Redis, not Postgres, per ADR-0003.                                                         |

## NFR-AVAIL — Availability & reliability

| ID           | Requirement                                                                                    | Target                                   |
| ------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| NFR-AVAIL-01 | Core API monthly availability                                                                  | ≥ 99.5% at launch (→ 99.9% as we mature) |
| NFR-AVAIL-02 | No single-instance failure SHALL lose an in-progress trip (trip state is durable in Postgres). | —                                        |
| NFR-AVAIL-03 | Planned deploys SHALL be zero-downtime (rolling).                                              | —                                        |
| NFR-AVAIL-04 | RTO ≤ 1 h, RPO ≤ 5 min for the primary datastore (backups + PITR; see Volume 13).              | —                                        |

## NFR-RESIL — Connectivity resilience (Kashmir-critical, A6.1)

| ID           | Requirement                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-RESIL-01 | The mobile apps SHALL tolerate intermittent connectivity: queue user actions and reconcile on reconnect without data loss or duplication.           |
| NFR-RESIL-02 | All state-changing operations SHALL be **idempotent** (client-supplied idempotency key) so retries after a drop don't double-book or double-charge. |
| NFR-RESIL-03 | Critical flows (OTP, ride lifecycle) SHALL have an **SMS fallback** independent of app data connectivity.                                           |
| NFR-RESIL-04 | The apps SHALL degrade gracefully on low bandwidth: minimal payloads, no blocking on non-critical assets.                                           |
| NFR-RESIL-05 | On reconnect, a client SHALL be able to fetch the authoritative current trip state in one call.                                                     |

## NFR-SEC — Security & privacy

| ID         | Requirement                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| NFR-SEC-01 | All traffic SHALL be TLS-encrypted in transit; secrets SHALL never be in source (Volume 1, 14).                        |
| NFR-SEC-02 | Passwords/OTPs SHALL be hashed/one-time; tokens SHALL be signed (JWT) with rotation and refresh revocation.            |
| NFR-SEC-03 | KYC and personal data SHALL be access-controlled (RBAC) and audit-logged on access to sensitive fields.                |
| NFR-SEC-04 | The system SHALL enforce authorization on every endpoint (default-deny); no endpoint SHALL rely on client-side checks. |
| NFR-SEC-05 | Sensitive data at rest (documents, PII) SHALL be encrypted.                                                            |
| NFR-SEC-06 | The system SHALL rate-limit and detect anomalous behavior (OTP abuse, fake-trip fraud) per Volume 14.                  |
| NFR-SEC-07 | Rider↔driver contact SHALL be privacy-preserving (masked calling/chat) where offered.                                  |

## NFR-COMPLY — Compliance (India / J&K)

| ID            | Requirement                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| NFR-COMPLY-01 | The platform SHALL support GST-compliant fee/tax recording and reporting (ledger tax field).                               |
| NFR-COMPLY-02 | Data handling SHALL follow applicable Indian data-protection obligations and stated retention policies.                    |
| NFR-COMPLY-03 | Onboarding SHALL be configurable to satisfy MoRTH aggregator + J&K State Transport requirements (A5) without code changes. |

## NFR-USE — Usability, accessibility & localization

| ID         | Requirement                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-USE-01 | The apps SHALL support **internationalization from day one**; launch languages: English + one regional (Urdu/Hindi/Kashmiri roadmap, A6.4). |
| NFR-USE-02 | The driver UI SHALL be usable while stationary with large tap targets and audible ride-offer alerts (Imran persona).                        |
| NFR-USE-03 | The apps SHALL be usable on mid-range Android devices (the launch-market baseline).                                                         |
| NFR-USE-04 | Money SHALL be displayed in **INR (₹)** with correct formatting.                                                                            |

## NFR-OBS — Observability & operability

| ID         | Requirement                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------- |
| NFR-OBS-01 | The backend SHALL emit structured (JSON) logs with correlation/request IDs.                         |
| NFR-OBS-02 | The system SHALL expose metrics for the Volume 2 marketplace/quality KPIs and system health.        |
| NFR-OBS-03 | Critical alerts (matching failures, payment errors, availability) SHALL page on-call per Volume 13. |
| NFR-OBS-04 | Distributed traces SHALL cover the request→match→trip→settle path for debugging.                    |

## NFR-MAINT — Maintainability

| ID           | Requirement                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| NFR-MAINT-01 | Code SHALL meet Volume 1 standards (typed, linted, module boundaries enforced).                               |
| NFR-MAINT-02 | Every MUST functional requirement SHALL have automated test coverage (Volume 12).                             |
| NFR-MAINT-03 | Configuration (pricing, limits, feature flags) SHALL be changeable without a redeploy where the rule says so. |
| NFR-MAINT-04 | Schema changes SHALL ship as reversible migrations (Volume 1, 6).                                             |

---

## Acceptance

An NFR is "met" only when there is **evidence** — a load test, a chaos/connectivity-drop test, a
security scan, or a dashboard — not an assertion. The mapping of NFR → verifying test lives in
Volume 12, and the runtime evidence (dashboards/SLOs) in Volume 13.
