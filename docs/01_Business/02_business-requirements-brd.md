# Business Requirements Document (BRD)

**Owner:** Product · **Last reviewed:** 2026-07-06 · **Status:** Baseline v1

The BRD states _what the business needs and why_, at a level above features. It is the contract
between the business and engineering about goals, scope, and success — not about implementation.
The detailed _how_ (features, flows, acceptance criteria) is the PRD/SRS in Volume 3.

---

## 1. Business objectives

| #    | Objective                                                   | Target (first 12 months)                             |
| ---- | ----------------------------------------------------------- | ---------------------------------------------------- |
| BO-1 | Establish a reliable two-sided marketplace in launch cities | 10k weekly completed trips by month 12               |
| BO-2 | Build driver supply that trusts the platform                | 2k weekly active drivers; W4 driver retention ≥ 40%  |
| BO-3 | Deliver a trustworthy rider experience                      | Trip completion rate ≥ 90%; avg rating ≥ 4.5         |
| BO-4 | Prove sustainable unit economics                            | Positive contribution margin per trip by month 9     |
| BO-5 | Operate safely and within regulation                        | 100% driver KYC; documented safety incident response |

## 2. Scope

### In scope (v1 — MVP marketplace)

- Rider app: signup/OTP, book a ride (bike/rickshaw/car), live tracking, fare estimate,
  cash + wallet payment, rate driver, trip history, cancel, SOS/share trip.
- Driver app: onboarding + KYC, go online/offline, receive & accept/decline requests,
  navigation handoff, collect fare, earnings & payout view, ratings.
- Matching: nearest suitable available driver, with cancellation and re-offer handling.
- Pricing: transparent up-front fare = base + distance + time, with surge and caps.
- Wallet: rider top-up, driver earnings ledger, payouts.
- Admin: ops dashboard for rides, drivers, riders, disputes, pricing/zones, reports.
- Notifications: OTP, ride lifecycle push/SMS.

### Out of scope (v1)

- Digital wallet gateways beyond a single provider integration (phase 2).
- Scheduled/pre-booked rides, ride-pooling, corporate accounts.
- Multi-language beyond primary + English (phase 2).
- Delivery/parcel, intercity.

## 3. Stakeholders

| Stakeholder            | Interest / what they need from the product                     |
| ---------------------- | -------------------------------------------------------------- |
| **Riders**             | Availability, fair fare, safety, easy payment                  |
| **Drivers**            | Consistent trips, fair earnings, fast payout, support          |
| **Operations team**    | Tools to monitor supply/demand, resolve disputes, manage zones |
| **Finance**            | Accurate ledgers, reconciliation, take-rate reporting          |
| **Compliance/Legal**   | KYC, data protection, regulatory adherence                     |
| **Founders/Investors** | North-star growth, unit economics, defensible trust            |
| **Engineering**        | Clear, stable requirements and prioritization                  |

## 4. Success metrics

Tied to objectives; measured weekly. (Formulas in [05_monetization-and-metrics.md](05_monetization-and-metrics.md).)

- **Growth:** weekly completed trips (north star), WoW growth rate.
- **Liquidity:** request→match rate ≥ 85%, avg pickup ETA ≤ 5 min in covered zones.
- **Quality:** completion rate ≥ 90%, cancellation rate ≤ 10%, rating ≥ 4.5.
- **Economics:** take rate 12–18%, positive contribution margin/trip.
- **Trust/Safety:** KYC coverage 100%, SOS response SLA met, chargeback/fraud rate low.

## 5. High-level requirements (business, not technical)

| ID    | Requirement                                                                 |
| ----- | --------------------------------------------------------------------------- |
| BR-1  | Riders MUST see the fare before confirming a booking.                       |
| BR-2  | Only KYC-verified drivers MAY receive ride requests.                        |
| BR-3  | Fares MUST be computed by the platform, not negotiated in-app.              |
| BR-4  | Surge MUST be capped and disclosed to the rider before booking.             |
| BR-5  | Every completed trip MUST produce an auditable financial record.            |
| BR-6  | Riders and drivers MUST be able to cancel, under transparent fee rules.     |
| BR-7  | The platform MUST support cash and wallet at launch.                        |
| BR-8  | Driver payouts MUST be traceable to specific trips and within SLA.          |
| BR-9  | Safety features (share trip, SOS, support) MUST be available on every trip. |
| BR-10 | The system MUST retain records required for tax and dispute resolution.     |

## 6. Constraints

- **Regulatory:** ride-hailing rules vary by city/province; drivers are partners (A5).
- **Market:** cash-heavy; low-end devices and intermittent connectivity are common.
- **Financial:** limited runway — features must move the north star or economics.
- **Operational:** small ops team at launch; tooling must reduce manual work.
- **Technical:** see engineering constraints in Volume 1 & 4 (async, PostGIS, mobile-first).

## 7. Assumptions

See [README.md](README.md) A1–A5. Additionally:

- Drivers own or have reliable access to a smartphone with GPS and data.
- Riders can receive SMS for OTP fallback.
- Map/geocoding coverage is adequate in launch cities.

## 8. Risks (business-level)

| Risk                                 | Likelihood | Impact | Mitigation                                                 |
| ------------------------------------ | ---------- | ------ | ---------------------------------------------------------- |
| Insufficient driver supply at launch | High       | High   | Driver incentives, phased city rollout, referral program   |
| Incumbent price war                  | Medium     | High   | Compete on trust/economics, not just price; protect margin |
| Regulatory change                    | Medium     | High   | Compliance-first posture, adaptable zone/pricing config    |
| Fraud (fake trips, wallet abuse)     | Medium     | Medium | KYC, device checks, anomaly detection (Volume 14)          |
| Cash reconciliation errors           | Medium     | Medium | Immutable ledger, daily reconciliation (Volume 6)          |

## 9. Out-of-scope decisions deferred to later ADRs/PRDs

- Choice of digital-wallet gateway(s).
- Driver incentive/subsidy structure.
- Multi-language and accessibility roadmap.
