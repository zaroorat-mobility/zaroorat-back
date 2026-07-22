# BRD — Business Requirements Document

> **Project:** Zaroorat — Ride-Hailing Platform
> **Status:** 🟡 Draft · **Owner:** Product / Founders · **Last updated:** 2026-07-20
> **Answers:** _Why does this exist, and what business outcomes must it produce?_

---

## 1. Executive summary

Zaroorat is a ride-hailing platform that connects **riders** who need transport with **drivers** who provide it, in real time. The business exists because in our target markets, transport is a daily _necessity_ (the meaning of "zaroorat") yet existing options are **too expensive, unsafe, or unavailable**. Zaroorat wins on **reliability, safety, and fair pricing**.

This BRD defines the business goals, scope, stakeholders, and success criteria. It does **not** specify features (see the [PRD](./FEATURE_CATALOG.md)) or design (see the [HLD](../01_ARCHITECTURE/SYSTEM_ARCHITECTURE.md)).

---

## 2. Business objectives

| ID       | Objective                                                     | Why it matters                                                                        |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **BO-1** | Reliably match riders to nearby drivers within seconds        | Match rate and speed are the core value; a rider who can't get a ride churns.         |
| **BO-2** | Guarantee correct, transparent pricing and payments           | Trust in money is the license to operate; disputes and double-charges kill retention. |
| **BO-3** | Keep riders and drivers safe and verified                     | Safety is a legal requirement and the strongest differentiator.                       |
| **BO-4** | Grow a healthy two-sided marketplace (enough drivers online)  | Without driver supply there is no product; supply liquidity drives everything.        |
| **BO-5** | Operate profitably and efficiently at scale                   | Take-rate, low ops cost per trip, and high automation make the business viable.       |
| **BO-6** | Be expandable to new cities/countries without re-architecture | Growth path; avoid hard-coding one market.                                            |

---

## 3. Business requirements

Traceable business-level requirements. Each maps to product features in the PRD.

| ID        | Requirement                                                                             | Supports   |
| --------- | --------------------------------------------------------------------------------------- | ---------- |
| **BR-1**  | Riders can request a ride and be matched to a suitable nearby driver.                   | BO-1       |
| **BR-2**  | Riders see a fare estimate before confirming, and are charged fairly and transparently. | BO-2       |
| **BR-3**  | The platform supports multiple payment methods, including cash, and reconciles them.    | BO-2, BO-5 |
| **BR-4**  | Only verified drivers with valid documents and approved vehicles can operate.           | BO-3       |
| **BR-5**  | Riders and drivers can communicate during a trip and rate each other after.             | BO-3, BO-4 |
| **BR-6**  | Emergency help (SOS) and trip sharing are available during every trip.                  | BO-3       |
| **BR-7**  | Drivers can onboard, go online/offline, accept trips, and see earnings.                 | BO-4       |
| **BR-8**  | The platform can run promotions and referrals to acquire and retain users.              | BO-4, BO-5 |
| **BR-9**  | Operations staff can verify drivers, manage pricing, and resolve disputes.              | BO-3, BO-5 |
| **BR-10** | Leadership can measure marketplace health (match rate, completion, revenue).            | BO-5, BO-1 |
| **BR-11** | Pricing, currency, language, and service areas are configurable per market.             | BO-6       |

---

## 4. Scope

### 4.1 In scope (this phase)

- Two-sided ride-hailing: rider app + driver app backends.
- Core trip loop: request → match → dispatch → trip → pay → rate.
- Driver onboarding, document verification, vehicle approval.
- Cash and at least one digital payment method.
- Promotions/referrals, notifications, in-trip chat, SOS.
- Ops/admin tooling, support tickets, analytics.
- Single launch market, built to be multi-market-ready.

### 4.2 Out of scope (now)

- Food delivery, courier/logistics, or other verticals.
- Multi-tenant / white-label reselling of the platform.
- Native mobile app source (separate repos; this is the backend).
- Autonomous/scheduled-only fleets, public transit integration.

### 4.3 Assumptions

- Riders and drivers use smartphones on mobile data with variable connectivity.
- At least one local payment gateway and SMS/OTP provider are available in-market.
- Regulatory driver/vehicle verification requirements exist and must be met.
- Cash remains a significant payment method at launch.

### 4.4 Constraints

- **Legal:** PII protection and document retention rules apply.
- **Financial:** money flows must be auditable and reconcilable to the cent.
- **Operational:** the system must be observable and recoverable under load.
- **Time-to-market:** MVP core loop prioritized over breadth of features.

---

## 5. Stakeholders

| Stakeholder               | Interest / role                                         |
| ------------------------- | ------------------------------------------------------- |
| **Riders**                | Get a safe, affordable ride quickly.                    |
| **Drivers**               | Earn reliably with fair pay and low friction.           |
| **Founders / leadership** | Marketplace growth, unit economics, expansion.          |
| **Operations team**       | Verify supply, manage fares/promos, keep fleet healthy. |
| **Support team**          | Resolve rider/driver issues and safety incidents.       |
| **Finance**               | Reconcile payments, payouts, taxes, refunds.            |
| **Compliance / legal**    | Meet regulatory and data-protection obligations.        |
| **Engineering**           | Build and operate the platform reliably.                |

---

## 6. Success metrics (business KPIs)

| Metric                            | Definition                                         | Why                               |
| --------------------------------- | -------------------------------------------------- | --------------------------------- |
| **Match rate**                    | Ride requests matched to a driver ÷ total requests | Core supply/demand health (BO-1). |
| **Time-to-match (p50/p95)**       | Seconds from request to driver acceptance          | Rider experience (BO-1).          |
| **Trip completion rate**          | Completed ÷ accepted trips                         | Reliability (BO-1, BO-3).         |
| **Cancellation rate**             | Cancelled ÷ requested, split by party              | Friction and trust signal.        |
| **Payment success rate**          | Successful ÷ attempted payments                    | Money trust (BO-2).               |
| **Fare dispute rate**             | Disputed trips ÷ completed                         | Pricing transparency (BO-2).      |
| **Driver liquidity**              | Online drivers per active demand zone/hour         | Supply health (BO-4).             |
| **Active riders / drivers**       | Weekly/monthly active users each side              | Growth (BO-4).                    |
| **Take rate & cost per trip**     | Platform revenue and ops cost per trip             | Unit economics (BO-5).            |
| **Safety incident response time** | Time from SOS/incident to first response           | Safety (BO-3).                    |

---

## 7. Risks & mitigations

| Risk                                         | Impact                        | Mitigation                                                           |
| -------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| Insufficient driver supply at launch         | No liquidity → no product     | Driver incentives, promotions (BR-8), phased city launch.            |
| Payment errors / double charges              | Loss of trust, refunds, legal | Idempotent money ops, transactional integrity, reconciliation.       |
| Safety incident                              | Human harm, reputation, legal | SOS (BR-6), verification (BR-4), trip sharing, audit trails.         |
| Fraud (fake rides, promo abuse, chargebacks) | Financial loss                | OTP, verification, promo rules, anomaly detection in analytics.      |
| Regulatory non-compliance                    | Fines, shutdown               | Document verification, retention policy, per-market config (BR-11).  |
| Connectivity loss mid-trip                   | Broken trip state, disputes   | Reconnect-tolerant real-time layer, server-authoritative trip state. |
| Vendor lock-in (payments/maps/SMS)           | Cost, expansion friction      | Provider abstraction so vendors are swappable (BR-11).               |

---

## 8. High-level milestones

| Milestone                   | Business outcome                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------- |
| **M1 — Core loop MVP**      | A rider can request, ride, and pay (cash); a verified driver can accept and complete. |
| **M2 — Trust & engagement** | Chat, ratings, SOS, digital payments, promotions live.                                |
| **M3 — Operate & scale**    | Support tooling, admin console, analytics, and a second market ready.                 |

---

## 9. Traceability

Business requirements flow down into product features:

- **BR-1** → Matching, Dispatch, Geo features → [PRD FR-Matching/Dispatch]
- **BR-2, BR-3** → Pricing, Payments features → [PRD FR-Pricing/Payments]
- **BR-4** → Onboarding, Documents, Vehicles → [PRD FR-Onboarding]
- **BR-5, BR-6** → Chat, Reviews, SOS → [PRD FR-Safety/Engagement]
- **BR-7** → Drivers, Auth → [PRD FR-Driver]
- **BR-8** → Promotions → [PRD FR-Promotions]
- **BR-9** → Admin, Support → [PRD FR-Ops]
- **BR-10** → Analytics → [PRD FR-Analytics]
- **BR-11** → Settings → [PRD FR-Config]

See the [PRD](./FEATURE_CATALOG.md) for the full feature and story breakdown.
