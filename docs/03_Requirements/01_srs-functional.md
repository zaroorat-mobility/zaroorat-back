# SRS — Functional Requirements

**Owner:** Product & Engineering · **Last reviewed:** 2026-07-06

The Software Requirements Specification states **exactly what the system SHALL do**, at a level
precise enough to build and test against. Each requirement has a stable ID (`FR-<area>-##`),
a priority (MoSCoW), and the **business rule(s)** it satisfies. "SHALL" = mandatory.

> Non-functional qualities (performance, security, resilience) are in
> [02_srs-nonfunctional.md](02_srs-nonfunctional.md).

---

## FR-AUTH — Authentication & Accounts

| ID         | Requirement                                                                                                                                  | Pri    | Satisfies                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------ |
| FR-AUTH-01 | The system SHALL allow registration with a phone number and SHALL activate an account only after OTP verification.                           | Must   | R-ACCOUNT-1              |
| FR-AUTH-02 | The system SHALL deliver OTP via SMS and SHALL provide a resend mechanism after a configurable interval.                                     | Must   | R-ACCOUNT-1, A6.1        |
| FR-AUTH-03 | The system SHALL rate-limit OTP requests and verification attempts per phone number and per device.                                          | Must   | R-ACCOUNT-1              |
| FR-AUTH-04 | The system SHALL issue a short-lived access token and a longer-lived refresh token on successful verification.                               | Must   | —                        |
| FR-AUTH-05 | The system SHALL allow exactly one active account per phone number per role, and SHALL allow one person to hold both rider and driver roles. | Must   | R-ACCOUNT-2, R-ACCOUNT-3 |
| FR-AUTH-06 | The system SHALL let ops suspend an account, after which it SHALL NOT be able to book or accept rides.                                       | Must   | R-ACCOUNT-4              |
| FR-AUTH-07 | The system SHALL revoke refresh tokens on logout and on suspension.                                                                          | Should | —                        |

## FR-KYC — Driver Onboarding & KYC

| ID        | Requirement                                                                                                                                                   | Pri  | Satisfies              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------- |
| FR-KYC-01 | The system SHALL let a user apply as a driver and upload Aadhaar/PAN, driving licence, and vehicle RC (and permit/fitness where the vehicle class requires).  | Must | R-KYC-1                |
| FR-KYC-02 | The system SHALL NOT allow a driver to go online or receive requests until KYC is approved.                                                                   | Must | R-KYC-2, BR-2          |
| FR-KYC-03 | The system SHALL provide ops a review queue to approve/reject with a recorded reason.                                                                         | Must | R-KYC-2, R-DATA-2      |
| FR-KYC-04 | The system SHALL track document expiry and SHALL move a driver to "documents required" (blocking requests) when a required document expires.                  | Must | R-KYC-3                |
| FR-KYC-05 | The system SHALL require an approved vehicle mapped to the driver before trips, and SHALL support a vehicle being reassigned over time (not permanently 1:1). | Must | R-KYC-4, fleet persona |
| FR-KYC-06 | The system SHALL retain KYC records per the retention policy.                                                                                                 | Must | R-KYC-5, R-DATA-1      |

## FR-RIDE — Ride Request & Estimate

| ID         | Requirement                                                                                                                        | Pri    | Satisfies            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------- |
| FR-RIDE-01 | The system SHALL let a rider specify pickup and drop via GPS, map pin, or search, and SHALL allow manual pickup when GPS is poor.  | Must   | A6.2                 |
| FR-RIDE-02 | The system SHALL compute and display an itemized fare estimate (base, distance, time, surge, total) **before** the rider confirms. | Must   | R-PRICE-1, R-PRICE-4 |
| FR-RIDE-03 | The system SHALL let the rider select an available vehicle type and SHALL update the estimate accordingly.                         | Must   | R-AVAIL-3            |
| FR-RIDE-04 | The system SHALL indicate a vehicle type as unavailable when no eligible driver of that type is within the search area.            | Should | R-AVAIL-3            |
| FR-RIDE-05 | On confirmation, the system SHALL create a ride request in a well-defined initial state and begin matching.                        | Must   | R-TRIP-1             |

## FR-MATCH — Matching

| ID          | Requirement                                                                                                                                            | Pri  | Satisfies     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------- |
| FR-MATCH-01 | The system SHALL consider only drivers who are online, approved, not on an active trip, of the requested vehicle type, and with a recent location fix. | Must | R-AVAIL-1/2/3 |
| FR-MATCH-02 | The system SHALL offer the request to the best candidate (nearest, with fairness weighting) and SHALL apply an offer timeout.                          | Must | R-AVAIL-4     |
| FR-MATCH-03 | On decline/timeout, the system SHALL offer the next candidate and SHALL NOT immediately re-offer to the same driver.                                   | Must | R-AVAIL-5     |
| FR-MATCH-04 | The system SHALL expand the search radius up to a configured limit and SHALL expire the request if no driver accepts.                                  | Must | R-AVAIL-6     |
| FR-MATCH-05 | The system SHALL guarantee a request is accepted by at most one driver (no double assignment).                                                         | Must | R-TRIP-1      |

## FR-TRIP — Trip Lifecycle

| ID         | Requirement                                                                                                               | Pri  | Satisfies        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------- |
| FR-TRIP-01 | The system SHALL enforce the trip state machine; only defined transitions SHALL be permitted.                             | Must | R-TRIP-1         |
| FR-TRIP-02 | The system SHALL require pickup verification (OTP) before a trip transitions to in-progress.                              | Must | R-TRIP-2         |
| FR-TRIP-03 | The system SHALL stream the driver's live location to the rider (and vice-versa as needed) during the trip.               | Must | US-TRIP-01       |
| FR-TRIP-04 | On completion, the system SHALL record actual distance, time, route, and final fare.                                      | Must | R-TRIP-3         |
| FR-TRIP-05 | The system SHALL create exactly one financial settlement per completed trip.                                              | Must | R-TRIP-4, BR-5   |
| FR-TRIP-06 | The system SHALL treat completed and cancelled as mutually exclusive terminal states.                                     | Must | R-TRIP-5         |
| FR-TRIP-07 | The system SHALL reconcile client and server trip state after a connectivity loss without duplicating or losing the trip. | Must | A6.1, US-TRIP-04 |

## FR-CANCEL — Cancellation

| ID           | Requirement                                                                                                                    | Pri    | Satisfies    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------ |
| FR-CANCEL-01 | The system SHALL allow either party to cancel before pickup and SHALL capture a reason.                                        | Must   | R-CANCEL-1   |
| FR-CANCEL-02 | The system SHALL apply a configurable rider cancellation fee only after a grace window, and SHALL disclose it before charging. | Should | R-CANCEL-2/4 |
| FR-CANCEL-03 | A driver cancellation after accepting SHALL NOT charge the rider and MAY affect driver score.                                  | Should | R-CANCEL-3   |

## FR-PRICE — Pricing & Surge

| ID          | Requirement                                                                                                                           | Pri    | Satisfies   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| FR-PRICE-01 | The system SHALL compute fare = base + (distance × per-km) + (time × per-min) by vehicle type and city, never below the minimum fare. | Must   | R-PRICE-1/2 |
| FR-PRICE-02 | Pricing parameters SHALL be configuration, changeable by authorized ops without a deploy.                                             | Must   | R-PRICE-6   |
| FR-PRICE-03 | The system SHALL apply a surge multiplier (≥ 1.0) per zone/time, SHALL cap it, and SHALL disclose it to the rider before booking.     | Must   | R-PRICE-3/4 |
| FR-PRICE-04 | The system SHALL honor the quoted fare for the trip unless the route materially changes.                                              | Must   | R-PRICE-5   |
| FR-PRICE-05 | The system SHALL itemize any tolls/waiting charges and SHALL disclose them.                                                           | Should | R-PRICE-8   |

## FR-PAY — Payments, Wallet & Earnings

| ID        | Requirement                                                                                                                                 | Pri    | Satisfies         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------- |
| FR-PAY-01 | The system SHALL record every money movement as an immutable, double-entry ledger record carrying amount, commission, **tax/GST**, and net. | Must   | R-PAY-1, GST      |
| FR-PAY-02 | The system SHALL settle cash trips by recording fare collected, commission owed by the driver, and net.                                     | Must   | R-PAY-3           |
| FR-PAY-03 | The system SHALL debit a wallet atomically and concurrency-safely, and SHALL NOT allow a negative balance.                                  | Must   | R-PAY-2/6         |
| FR-PAY-04 | The system SHALL present the driver a transparent per-trip and per-period earnings breakdown with cash-vs-owed reconciliation.              | Must   | BR-8, US-PAY-03   |
| FR-PAY-05 | The system SHALL support RBAC-gated refunds, recorded with actor and reason, reflected in the ledger.                                       | Must   | R-PAY-5, R-DATA-2 |
| FR-PAY-06 | The system SHALL make driver payouts traceable to specific trips and SHALL respect the payout SLA.                                          | Should | R-PAY-4, BR-8     |

## FR-RATE — Ratings

| ID         | Requirement                                                                                             | Pri    | Satisfies |
| ---------- | ------------------------------------------------------------------------------------------------------- | ------ | --------- |
| FR-RATE-01 | The system SHALL allow a 1–5 rating from each party after a completed trip, tied to that trip.          | Should | R-RATE-1  |
| FR-RATE-02 | The system SHALL maintain a rolling driver average and SHALL flag drivers below a threshold for review. | Should | R-RATE-2  |
| FR-RATE-03 | Ratings SHALL NOT be editable after a configurable window.                                              | Should | R-RATE-3  |

## FR-SAFE — Safety

| ID         | Requirement                                                                                             | Pri  | Satisfies |
| ---------- | ------------------------------------------------------------------------------------------------------- | ---- | --------- |
| FR-SAFE-01 | The system SHALL expose share-trip and SOS on every active trip.                                        | Must | R-SAFE-1  |
| FR-SAFE-02 | The system SHALL show driver and vehicle identity to the rider once matched.                            | Must | R-SAFE-2  |
| FR-SAFE-03 | An SOS SHALL route an alert (identity, location, trip) to ops/emergency per policy and SHALL be logged. | Must | R-SAFE-3  |
| FR-SAFE-04 | The system SHALL retain trip location history sufficient for incident investigation.                    | Must | R-SAFE-4  |

## FR-NOTIF — Notifications

| ID          | Requirement                                                                                                 | Pri  | Satisfies |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ---- | --------- |
| FR-NOTIF-01 | The system SHALL send push notifications for ride lifecycle events (matched, arriving, started, completed). | Must | E11       |
| FR-NOTIF-02 | The system SHALL fall back to SMS for critical events when push/data is unavailable.                        | Must | A6.1      |

## FR-ADMIN — Admin / Ops

| ID          | Requirement                                                                                                            | Pri  | Satisfies              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------- |
| FR-ADMIN-01 | The system SHALL provide a live ops dashboard of supply/demand and active trips.                                       | Must | E12                    |
| FR-ADMIN-02 | The system SHALL provide searchable rider/driver/trip/ledger records with trip evidence for dispute resolution.        | Must | US-ADMIN-02            |
| FR-ADMIN-03 | The system SHALL enforce RBAC so sensitive actions (refunds, pricing, suspension) require the appropriate role.        | Must | R-PAY-5, R-DATA-2      |
| FR-ADMIN-04 | The system SHALL audit-log every admin action on money, accounts, and pricing with actor, before/after, and timestamp. | Must | R-DATA-2               |
| FR-ADMIN-05 | The system SHALL let authorized ops configure zones, pricing, and surge, taking effect for new estimates.              | Must | R-PRICE-6, US-ADMIN-03 |

---

## Data-integrity requirements (cross-cutting)

| ID         | Requirement                                                                                           | Pri  | Satisfies    |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---- | ------------ |
| FR-DATA-01 | Financial and safety records SHALL be append-only / soft-deleted, never hard-deleted.                 | Must | R-DATA-1     |
| FR-DATA-02 | Every entity SHALL carry `created_at`/`updated_at`; soft-deletable entities SHALL carry `deleted_at`. | Must | Naming conv. |
| FR-DATA-03 | All monetary values SHALL be stored as exact decimals in INR minor units or `Decimal`, never floats.  | Must | R-PAY-1      |
