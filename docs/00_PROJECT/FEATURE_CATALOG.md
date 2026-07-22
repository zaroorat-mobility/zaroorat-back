# PRD — Product Requirements Document

> **Project:** Zaroorat — Ride-Hailing Platform
> **Status:** 🟡 Draft · **Owner:** Product · **Last updated:** 2026-07-20
> **Answers:** _What does the product do — features, user stories, and acceptance criteria?_
> **Traces from:** [BRD](./BUSINESS_REQUIREMENTS.md) · **Traces to:** [HLD](../01_ARCHITECTURE/SYSTEM_ARCHITECTURE.md), [LLD](../01_ARCHITECTURE/SYSTEM_ARCHITECTURE.md)

---

## 1. Personas

| Persona                  | Goal                                   | Pain we remove                                      |
| ------------------------ | -------------------------------------- | --------------------------------------------------- |
| **Rider (Ayesha)**       | Get a safe, affordable ride now        | Uncertain availability, unclear price, safety worry |
| **Driver (Bilal)**       | Earn steadily with minimal hassle      | Idle time, unclear pay, complicated onboarding      |
| **Ops agent (Sana)**     | Keep supply verified and fares correct | Manual, error-prone verification and pricing        |
| **Support agent (Omar)** | Resolve issues and incidents fast      | No context, no tools, slow escalation               |

---

## 2. Functional requirements by module

Each feature has an **ID (FR-x)**, the **module** that owns it (`src/modules/*`), user stories, and acceptance criteria. Priority: **P0** (MVP) · **P1** (fast-follow) · **P2** (scale).

---

### FR-AUTH — Authentication & accounts · `auth`, `users` · P0 · traces BR-7

**Stories**

- **US-A1:** As a rider/driver, I can sign up and log in with my phone number and an OTP.
- **US-A2:** As a user, my session stays valid and refreshes without re-login until it expires or I log out.
- **US-A3:** As the system, I assign roles (rider, driver, admin, support) that gate access.

**Acceptance criteria**

- OTP is time-limited, single-use, and rate-limited per phone/device.
- On successful OTP, an access token (short-lived) + refresh token are issued.
- Expired access tokens refresh transparently; revoked/blacklisted tokens are rejected.
- A user may hold multiple roles; endpoints enforce required roles (deny by default).
- Failed OTP attempts are throttled and logged.

---

### FR-ONBOARD — Driver onboarding & compliance · `onboarding`, `documents`, `vehicles` · P0 · traces BR-4

**Stories**

- **US-O1:** As a driver, I complete onboarding steps (profile, documents, vehicle) and see my status.
- **US-O2:** As a driver, I upload required documents (license, ID/CNIC, insurance, vehicle reg).
- **US-O3:** As ops, I review, approve, or reject each document with a reason.
- **US-O4:** As the system, I block a driver from going online until fully verified.

**Acceptance criteria**

- Onboarding is a state machine: `STARTED → DOCS_SUBMITTED → UNDER_REVIEW → APPROVED / REJECTED`.
- Each document has a type, file reference, status, and (where relevant) an expiry date.
- A driver is **operable** only when: all required docs `APPROVED` and non-expired, and ≥1 vehicle `APPROVED`.
- Expiring/expired documents flip the driver to non-operable and notify them.
- Rejections carry a human-readable reason surfaced to the driver.

---

### FR-GEO — Location & presence · `geo` · P0 · traces BR-1

**Stories**

- **US-G1:** As a driver, my location is streamed while I'm online so I can be matched.
- **US-G2:** As a rider, I see nearby drivers and my driver's live position during a trip.
- **US-G3:** As the system, I answer "which drivers are near point X?" quickly.

**Acceptance criteria**

- Driver location updates are accepted via socket at a bounded frequency and are idempotent.
- Stale locations (no update within TTL) are excluded from matching.
- Proximity query returns candidate drivers within a radius, filtered by availability and category.
- Location data is private: only the paired rider (during an active trip) and ops (audited) can see a driver's live position.

---

### FR-PRICING — Fare estimation & finalization · `pricing` · P0 · traces BR-2

**Stories**

- **US-P1:** As a rider, I see a fare estimate (or range) before I confirm a ride.
- **US-P2:** As a rider, my final fare matches the quote unless a transparent factor changed it.
- **US-P3:** As ops, I configure base fares, per-km/min rates, minimums, and surge per category/zone.

**Acceptance criteria**

- Estimate = f(distance, duration, vehicle category, active surge, applicable promo).
- The quote is persisted and referenced by the trip; the rider-visible number is honored.
- Final fare adjustments (waiting time, route deviation, tolls) are itemized and recorded.
- Surge multiplier is bounded and disclosed to the rider before confirmation.
- Fare math is deterministic and reproducible from stored inputs (auditable).

---

### FR-MATCH — Matching · `matching` · P0 · traces BR-1

**Stories**

- **US-M1:** As a rider, my request is offered to the most suitable available driver.
- **US-M2:** As a driver, I only receive offers I'm eligible for (category, proximity, online, verified).
- **US-M3:** As the platform, matching is fair to drivers and optimizes time-to-pickup.

**Acceptance criteria**

- Candidate set = online + operable + correct category + within radius + not on an active trip.
- Ranking considers ETA/proximity and fairness (e.g. idle time), configurable.
- Produces an ordered offer list handed to `dispatch`.
- No driver is offered two active requests simultaneously.

---

### FR-DISPATCH — Dispatch & trip lifecycle · `dispatch`, `rides` · P0 · traces BR-1

**Stories**

- **US-D1:** As a driver, I get a ride offer and can accept or decline within a time window.
- **US-D2:** As a rider, if no driver accepts, I'm re-matched or told none are available.
- **US-D3:** As both parties, the trip moves through clear states I can see live.
- **US-D4:** As either party, I can cancel per the cancellation policy.

**Acceptance criteria**

- Offer has a countdown; on decline or timeout, the next candidate is offered (a **worker** enforces the timeout).
- Trip states advance only forward: `REQUESTED → MATCHING → DRIVER_ASSIGNED → ARRIVING → ARRIVED → IN_PROGRESS → COMPLETED → PAID`; with `CANCELLED` / `NO_DRIVERS` terminal branches.
- Illegal transitions are rejected with a clear error.
- Every transition is timestamped, recorded, and pushed live to both apps.
- Cancellation applies policy (grace window, possible fee) and frees the driver.

---

### FR-PAYMENTS — Payments, payouts, refunds · `payments` · P0 (cash) / P1 (digital) · traces BR-2, BR-3

**Stories**

- **US-Pay1:** As a rider, I pay by cash or a digital method at trip end.
- **US-Pay2:** As a driver, my earnings are recorded and paid out on schedule.
- **US-Pay3:** As ops/finance, I can issue a refund or adjustment with an audit trail.

**Acceptance criteria**

- On `COMPLETED`, a charge is created for the final fare; success moves the trip to `PAID`.
- All money operations are **idempotent** (client key / operation key) — retries never double-charge or double-pay.
- Cash trips are reconciled (driver owes platform commission; ledger tracks balances).
- A per-user/driver **ledger** records every credit/debit; balances are derivable and auditable.
- Refunds/adjustments are linked to the original transaction and reason-coded.
- Payment capture and payout run in **workers**, retryable on transient failure.

---

### FR-PROMO — Promotions & referrals · `promotions` · P1 · traces BR-8

**Stories**

- **US-Pr1:** As a rider, I apply a promo code and see the discount before confirming.
- **US-Pr2:** As a rider, I refer a friend and we both get credit on their first trip.
- **US-Pr3:** As ops, I create campaigns with rules (caps, eligibility, expiry).

**Acceptance criteria**

- A promo validates against rules (eligibility, usage cap, min fare, expiry, market) before applying.
- Discount is reflected in the fare estimate and the final charge.
- Referral credit is granted only on the referee's qualifying completed+paid trip.
- Promo abuse (self-referral, repeat use) is prevented and logged.

---

### FR-NOTIFY — Notifications · `notifications` · P0 · traces BR-1, BR-5

**Stories**

- **US-N1:** As a user, I receive timely push/SMS/in-app updates about my trip and account.
- **US-N2:** As the system, notifications are templated, localized, and sent asynchronously.

**Acceptance criteria**

- Trip events (matched, arriving, arrived, completed) and account events trigger notifications.
- Delivery is async via a **worker**; a failure to notify never blocks the trip flow.
- Templates support localization and channel fallback (push → SMS).
- Duplicate events do not produce duplicate user-visible spam (dedup).

---

### FR-CHAT — In-trip chat · `chat` · P1 · traces BR-5

**Stories**

- **US-C1:** As a rider/driver, I can message the other party during an active trip.

**Acceptance criteria**

- Chat is enabled only during active trip states, disabled after completion/cancellation.
- Messages are delivered in real time and persisted for the trip's record.
- Messages are private to the two trip parties (and audited ops access).
- Delivery tolerates reconnects; duplicate sends are de-duplicated.

---

### FR-SOS — Safety & SOS · `sos` · P1 · traces BR-6

**Stories**

- **US-S1:** As a rider/driver, I can trigger SOS during a trip to raise an emergency alert.
- **US-S2:** As a rider, I can share my live trip with a trusted contact.

**Acceptance criteria**

- SOS is available in every active-trip state and **cannot be blocked** by rate limits or flags.
- Triggering SOS escalates (alert to ops/support, capture trip + location snapshot).
- Trip sharing produces a link showing live status/location to the recipient until trip end.
- All SOS events are logged with full context for follow-up.

---

### FR-REVIEW — Ratings & reviews · `reviews` · P1 · traces BR-5

**Stories**

- **US-R1:** As a rider/driver, after a trip I can rate the other party and leave feedback.

**Acceptance criteria**

- Both parties can submit one rating per completed trip.
- Ratings aggregate into each user's average; low ratings can flag ops review.
- A rider cannot see the driver's rating of them influence their own submission (no gaming), per policy.

---

### FR-SUPPORT — Support & disputes · `support` · P2 · traces BR-9

**Stories**

- **US-Su1:** As a user, I can raise a ticket about a trip, payment, or account.
- **US-Su2:** As a support agent, I can view context and resolve/escalate tickets.

**Acceptance criteria**

- Tickets link to the relevant trip/payment and carry a status lifecycle.
- Agents see trip timeline, payment, and chat context (audited) to resolve issues.
- Resolutions can trigger refunds/adjustments via `payments`.

---

### FR-ADMIN — Operations console · `admin` · P2 · traces BR-9

**Stories**

- **US-Ad1:** As ops, I verify drivers, manage fares/promos, and monitor the fleet.

**Acceptance criteria**

- All admin actions are role-gated and **audited** (who did what, when).
- Ops can perform document review, fare/surge config, promo management, and dispute actions.
- No admin endpoint exposes another user's private data without an audited reason.

---

### FR-ANALYTICS — Analytics & reporting · `analytics` · P2 · traces BR-10

**Stories**

- **US-An1:** As leadership, I see marketplace KPIs (match rate, completion, revenue, liquidity).

**Acceptance criteria**

- Domain events feed aggregated metrics (the BRD KPI set).
- Reports are queryable by time range, market, and category.
- Analytics reads never impact the transactional path (separate read model/aggregation).

---

### FR-CONFIG — Platform settings · `settings` · P0 · traces BR-11

**Stories**

- **US-Cf1:** As ops, I configure service areas, fares, surge, currency, language, and feature flags per market.

**Acceptance criteria**

- Currency, language, service areas, and fare config are data, not code.
- Feature flags toggle P1/P2 features without deploys.
- Changing config is audited and versioned.

---

### FR-FILES — File storage · `files` · P0 · traces BR-4

**Stories**

- **US-F1:** As a driver, I upload documents; as ops, I view them securely.

**Acceptance criteria**

- Uploads go to object storage behind a provider abstraction; the DB stores references, not blobs.
- Access is via short-lived signed URLs; documents are not public.
- File type/size are validated; malicious uploads are rejected.

---

## 3. Non-functional requirements (NFR)

| ID                            | Requirement                                                 | Target                                   |
| ----------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| **NFR-1 Performance**         | p95 latency on core endpoints (request ride, get status)    | < 300 ms server-side                     |
| **NFR-2 Real-time**           | Location/state push latency                                 | < 2 s end-to-end typical                 |
| **NFR-3 Availability**        | Core API uptime                                             | ≥ 99.9%                                  |
| **NFR-4 Scalability**         | Horizontal scale of API + workers; Redis-backed sockets     | No single-instance bottleneck            |
| **NFR-5 Consistency**         | Money & trip state                                          | Strong (transactional, DB-authoritative) |
| **NFR-6 Idempotency**         | All non-idempotent/money POSTs                              | Safe to retry                            |
| **NFR-7 Security**            | Auth on every endpoint, deny-by-default, PII protected      | No unauthenticated data access           |
| **NFR-8 Observability**       | Structured logs, request IDs, metrics, traces               | Every request traceable API↔worker       |
| **NFR-9 Recoverability**      | Graceful shutdown, retryable jobs, no lost trips on restart | Zero orphaned active trips               |
| **NFR-10 Privacy/compliance** | PII & document retention per market policy                  | Configurable, auditable                  |
| **NFR-11 Localization**       | Currency/language/market config                             | No hard-coded locale                     |

---

## 4. Release plan

| Release              | Includes (FRs)                                                                      | Business milestone         |
| -------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| **MVP (M1)**         | AUTH, ONBOARD, GEO, PRICING, MATCH, DISPATCH, PAYMENTS(cash), NOTIFY, CONFIG, FILES | Core loop works end-to-end |
| **Fast-follow (M2)** | CHAT, REVIEW, SOS, PROMO, PAYMENTS(digital)                                         | Trust & engagement         |
| **Scale (M3)**       | SUPPORT, ADMIN, ANALYTICS                                                           | Operate & grow             |

---

## 5. Open product questions 🔴

- Cancellation-fee policy specifics (grace window, amount) per market?
- Surge model: algorithmic vs. zone-based, and disclosure wording?
- Payout schedule and minimum-cashout for drivers?
- Which digital payment methods at launch (wallet, card, bank)?
- Rating threshold that triggers automatic ops review / deactivation?

Resolve each before its module leaves Draft. See design in [HLD](../01_ARCHITECTURE/SYSTEM_ARCHITECTURE.md) and [LLD](../01_ARCHITECTURE/SYSTEM_ARCHITECTURE.md).
