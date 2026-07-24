# Business Rules

**Owner:** Product · **Last reviewed:** 2026-07-06

These are the rules engineering **must enforce** in code. Each has a stable ID (`R-<area>-<n>`)
so requirements, tests, and code comments can cite it (e.g. `# enforces R-CANCEL-2`). Rules are
policy, not implementation — the _how_ is in the relevant module (Volume 5) and the parameters
(fees, caps) live in **config**, not hard-coded, so ops can tune them without a deploy.

> **Convention:** MUST = enforced and tested. SHOULD = default, overridable by config/ops.

---

## R-ACCOUNT — Accounts & identity

| ID          | Rule                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------- |
| R-ACCOUNT-1 | A phone number MUST be verified by OTP before an account is active.                           |
| R-ACCOUNT-2 | One phone number maps to exactly one account per role (rider/driver).                         |
| R-ACCOUNT-3 | A person MAY be both a rider and a driver, but the driver capabilities unlock only after KYC. |
| R-ACCOUNT-4 | Accounts MAY be suspended by ops; a suspended account MUST NOT book or accept rides.          |

## R-KYC — Driver onboarding

| ID      | Rule                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R-KYC-1 | A driver MUST complete KYC before going online: **government ID (Aadhaar and/or PAN), a valid driving licence, and the vehicle Registration Certificate (RC)**; commercial permit/fitness where the vehicle class requires it. |
| R-KYC-2 | KYC MUST be reviewed/approved (auto or by ops) before the driver receives requests (BR-2).                                                                                                                                     |
| R-KYC-3 | Expired documents MUST move the driver to "documents required" and block new requests.                                                                                                                                         |
| R-KYC-4 | A vehicle MUST be approved and mapped to the driver before it can be used for trips.                                                                                                                                           |
| R-KYC-5 | KYC records MUST be retained per data-retention policy (Volume 14).                                                                                                                                                            |

## R-AVAIL — Driver availability & matching eligibility

| ID        | Rule                                                                                         |
| --------- | -------------------------------------------------------------------------------------------- |
| R-AVAIL-1 | A driver MUST be online, approved, and not on an active trip to be eligible for matching.    |
| R-AVAIL-2 | A driver MUST have a recent location fix (≤ 30s SHOULD) to be eligible.                      |
| R-AVAIL-3 | Matching MUST only consider drivers whose vehicle type matches the requested type.           |
| R-AVAIL-4 | Matching SHOULD prefer the nearest eligible driver, with fairness weighting to spread trips. |
| R-AVAIL-5 | A driver who declines/ignores an offer MUST NOT be re-offered the same request immediately.  |
| R-AVAIL-6 | A request MUST time out and expand its search radius / expire per config if unmatched.       |

## R-PRICE — Pricing

| ID        | Rule                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------- |
| R-PRICE-1 | Fare = base fare + (distance × per-km) + (time × per-min), by vehicle type and city.               |
| R-PRICE-2 | A minimum fare MUST apply; the fare MUST never be below it.                                        |
| R-PRICE-3 | Surge is a multiplier ≥ 1.0 applied per zone/time; it MUST be capped (default 3.0×).               |
| R-PRICE-4 | The rider MUST see the estimated (or locked) fare **before** confirming (BR-1, BR-4).              |
| R-PRICE-5 | The quoted fare MUST be honored for the trip unless the route materially changes (waypoint added). |
| R-PRICE-6 | Pricing parameters (base, per-km, per-min, surge caps) MUST be config, not code.                   |
| R-PRICE-7 | Platform commission is deducted from the fare per the take-rate policy (Volume 2 §monetization).   |
| R-PRICE-8 | Tolls/waiting charges, if any, MUST be itemized and disclosed.                                     |

## R-CANCEL — Cancellation

| ID         | Rule                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| R-CANCEL-1 | Either party MAY cancel before pickup; the reason SHOULD be captured.                               |
| R-CANCEL-2 | A rider cancellation after a grace window (default 2 min post-accept) MAY incur a cancellation fee. |
| R-CANCEL-3 | A driver cancellation after accepting SHOULD NOT charge the rider and MAY affect driver score.      |
| R-CANCEL-4 | Cancellation fees MUST be disclosed before they are charged and recorded in the ledger.             |
| R-CANCEL-5 | Excessive cancellations by either party MAY trigger review/penalty per policy.                      |

## R-TRIP — Trip lifecycle

| ID       | Rule                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------- |
| R-TRIP-1 | A trip's status transitions MUST follow the defined state machine (Volume 5, Trip).                   |
| R-TRIP-2 | Pickup MUST be confirmed (OTP or driver action) before the trip starts, to prevent wrong-rider trips. |
| R-TRIP-3 | A completed trip MUST record actual distance, time, route, and final fare.                            |
| R-TRIP-4 | Exactly one financial settlement MUST occur per completed trip (BR-5).                                |
| R-TRIP-5 | A trip cannot be both cancelled and completed; terminal states are mutually exclusive.                |

## R-PAY — Payments & wallet

| ID      | Rule                                                                                         |
| ------- | -------------------------------------------------------------------------------------------- |
| R-PAY-1 | Every money movement MUST be an immutable, double-entry ledger record (Volume 6).            |
| R-PAY-2 | A wallet balance MUST NOT go negative unless an explicitly allowed overdraft policy applies. |
| R-PAY-3 | Cash trips MUST still produce a ledger record (fare, commission owed by driver, net).        |
| R-PAY-4 | Driver payouts MUST reconcile to specific trips and respect the payout SLA (BR-8).           |
| R-PAY-5 | Refunds MUST be authorized per RBAC and recorded with reason and actor.                      |
| R-PAY-6 | Wallet debits MUST be concurrency-safe (row lock) to prevent double-spend.                   |

## R-RATE — Ratings & quality

| ID       | Rule                                                                     |
| -------- | ------------------------------------------------------------------------ |
| R-RATE-1 | Rider and driver MAY rate each other after a completed trip (1–5).       |
| R-RATE-2 | A driver's rolling average below a threshold MUST trigger review.        |
| R-RATE-3 | Ratings MUST be tied to a specific trip and not editable after a window. |

## R-SAFE — Safety

| ID       | Rule                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| R-SAFE-1 | Every active trip MUST expose share-trip and SOS to the rider.                        |
| R-SAFE-2 | Driver identity and vehicle details MUST be visible to the rider once matched.        |
| R-SAFE-3 | Safety incidents MUST be logged and routed to ops with an SLA.                        |
| R-SAFE-4 | Trip location history MUST be retained long enough to support incident investigation. |

## R-DATA — Auditability & retention

| ID       | Rule                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| R-DATA-1 | Financial and safety-relevant records MUST be append-only / soft-deleted, never hard-deleted.   |
| R-DATA-2 | Admin actions on money, accounts, and pricing MUST be audit-logged (actor, before/after, time). |
| R-DATA-3 | Personal data MUST be handled per the privacy/retention policy (Volume 14).                     |

---

## How these rules are used downstream

- **Volume 3 (PRD/SRS):** each functional requirement references the rules it satisfies.
- **Volume 5 (LLD):** module designs cite the rules they implement (e.g. Trip state machine ↔ R-TRIP-1).
- **Volume 12 (Testing):** every MUST rule has at least one test asserting it; tests reference the rule ID.
- **Config:** all tunable numbers (fees, caps, windows, radii) are parameters, owned by ops, not literals in code (R-PRICE-6).
