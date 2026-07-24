# Product Requirements Document (PRD)

**Owner:** Product · **Last reviewed:** 2026-07-06 · **Status:** Baseline v1 (MVP)

The PRD defines the product at the level of **epics and features** — what we build, for whom,
in what order. Exact system behavior is in the [SRS](../03_Requirements/01_srs-functional.md); this document is
the map. Everything here targets the **Kashmir, India** market (Volume 2, A1–A6).

---

## 1. Product summary

Zaroorat Ride is a two-sided ride-hailing app (rider + driver) with an ops admin. MVP proves
the core loop: **a rider requests a ride → the system prices and matches a nearby verified
driver → the trip is tracked to completion → money settles → both rate each other**, working
reliably on unreliable connectivity and cash-first payments.

## 2. MVP goal & guardrails

- **Goal:** deliver the end-to-end core loop for **economy car, auto-rickshaw, and bike** in
  **Srinagar and Jammu**, with **cash + wallet**, that works despite intermittent connectivity.
- **Done means:** a real rider and real driver can complete and pay for a trip, and ops can see
  and support it — measured by the north star (Weekly Completed Trips).
- **Explicitly deferred:** UPI, scheduled rides, pooling, shared/tourist taxi type, multi-city
  beyond launch, native second language beyond English+one. (These are **Could/Won't** below.)

## 3. Epics (the MVP backbone)

Each epic maps to a backend module (Volume 5) and has a MoSCoW priority for **this release**.

| Epic    | Name                                      | Priority   | Backend module           |
| ------- | ----------------------------------------- | ---------- | ------------------------ |
| **E1**  | Accounts & Authentication (phone + OTP)   | Must       | `auth`, `users`          |
| **E2**  | Driver Onboarding & KYC                   | Must       | `drivers`, `vehicles`    |
| **E3**  | Ride Request & Fare Estimate              | Must       | `rides`, `pricing`       |
| **E4**  | Driver Matching                           | Must       | `rides` (matching)       |
| **E5**  | Trip Lifecycle & Live Tracking            | Must       | `rides` (trip)           |
| **E6**  | Pricing & Surge                           | Must       | `pricing`                |
| **E7**  | Payments & Wallet (cash + wallet)         | Must       | `wallet`, `payments`     |
| **E8**  | Driver Earnings & Payouts                 | Must       | `wallet`                 |
| **E9**  | Ratings & Feedback                        | Should     | `rides`, `users`         |
| **E10** | Safety (SOS, share trip, driver identity) | Must       | `rides`, `notifications` |
| **E11** | Notifications (OTP, ride lifecycle)       | Must       | `notifications`          |
| **E12** | Admin / Ops Console                       | Must       | `admin`                  |
| **E13** | In-app Chat / Call-mask (rider↔driver)    | Should     | `chat`                   |
| **E14** | UPI digital payments                      | Could      | `payments`               |
| **E15** | Scheduled & shared/tourist-taxi rides     | Won't (v1) | —                        |

## 4. Epic detail

### E1 — Accounts & Authentication (Must)

- **Why:** identity is the gate for everything; OTP suits a mobile-first, low-friction market.
- **Features:** phone-number signup, **OTP verification (SMS, with resend + fallback)**, session
  via JWT access/refresh, profile basics, role (rider/driver), logout, account suspension (ops).
- **Kashmir note:** OTP delivery MUST tolerate flaky data — SMS is the fallback channel and is
  mandatory, not optional (A6.1). Voice-OTP is a Could.
- **Out:** social login, email/password (Won't v1).

### E2 — Driver Onboarding & KYC (Must)

- **Why:** only verified drivers may receive requests (R-KYC-2, BR-2).
- **Features:** driver application, document upload (**Aadhaar/PAN, driving licence, vehicle
  RC**, permit/fitness where required), review queue (ops approve/reject with reason), document
  expiry tracking, vehicle registration & type mapping, driver ↔ vehicle assignment.
- **Out:** automated OCR/identity verification (Could — start manual/ops review).

### E3 — Ride Request & Fare Estimate (Must)

- **Features:** set pickup (GPS + map + search) and drop, pick vehicle type, **see up-front fare
  estimate before confirming** (R-PRICE-4), confirm request, view assigned driver.
- **Kashmir note:** map/geocode must cover valley + Jammu; handle poor GPS in narrow lanes.

### E4 — Driver Matching (Must)

- **Features:** find nearest eligible driver (online, approved, correct vehicle type, recent
  location), offer with timeout, accept/decline, re-offer to next candidate, radius expansion,
  request expiry, fairness weighting to spread trips (R-AVAIL-*).

### E5 — Trip Lifecycle & Live Tracking (Must)

- **Features:** trip state machine (accepted → arriving → **pickup OTP verified** → in-progress
  → completed / cancelled), live driver location to rider, live rider→driver navigation handoff,
  actual distance/time capture, trip summary.
- **Pickup OTP** (R-TRIP-2) prevents wrong-rider trips — a Must.

### E6 — Pricing & Surge (Must)

- **Features:** fare = base + distance + time by vehicle type & city (R-PRICE-1), minimum fare,
  **config-driven** parameters (R-PRICE-6), surge multiplier per zone/time capped & disclosed
  (R-PRICE-3/4), fare lock, itemized breakdown.
- **Kashmir note:** time component matters more (terrain/traffic/winter detours, A6.2).

### E7 — Payments & Wallet (Must)

- **Features:** rider wallet (top-up placeholder, balance), **cash trip settlement**, wallet
  trip settlement, **double-entry immutable ledger** (R-PAY-1) with **GST/tax field**, commission
  deduction, refunds (RBAC-gated). Concurrency-safe wallet debits (R-PAY-6).

### E8 — Driver Earnings & Payouts (Must)

- **Features:** per-trip earnings breakdown (fare, commission, net, tax), daily/weekly summary,
  cash-collected vs. commission-owed reconciliation, payout requests traceable to trips (BR-8).

### E9 — Ratings & Feedback (Should)

- **Features:** post-trip 1–5 rating both ways, optional comment/tags, rolling driver average,
  low-rating review trigger (R-RATE-2).

### E10 — Safety (Must)

- **Features:** driver + vehicle identity shown once matched (R-SAFE-2), **share trip** link,
  **SOS** button routing to ops/emergency, trip location retained for investigation (R-SAFE-4).

### E11 — Notifications (Must)

- **Features:** OTP (SMS), ride lifecycle push (matched, arriving, started, completed), SMS
  fallback for critical events when push/data unavailable (A6.1).

### E12 — Admin / Ops Console (Must)

- **Features:** live ops dashboard (supply/demand, active trips map), driver approval queue,
  rider/driver/trip search, dispute resolution with trip evidence, zone & pricing/surge config,
  refunds, RBAC, audit log of admin actions (R-DATA-2). Reports for the Volume 2 metrics.

### E13 — Chat / Call-mask (Should)

- Masked calling and/or in-app chat between rider and driver for pickup coordination, privacy-preserving.

## 5. Release plan

| Milestone                             | Contents                                              | Exit criteria                                                    |
| ------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| **M0 — Foundations**                  | E1, E2, E12 (skeleton), infra & CI (V1)               | A driver can be onboarded & approved; a user can log in          |
| **M1 — Core loop (private beta)**     | E3, E4, E5, E6, E11, E10 (SOS/share), cash only       | A real trip completes end-to-end with cash in one launch city    |
| **M2 — Money & trust**                | E7 (wallet), E8, E9, E12 (full ops), E13              | Wallet trips settle; ledger reconciles; ops can resolve disputes |
| **M3 — Scale-in-city**                | surge tuning, fairness, resilience hardening, reports | Metrics dashboards live; connectivity-loss flows verified        |
| **M4 — Second city + UPI (post-MVP)** | E14, second launch city, i18n second language         | Expansion checklist met                                          |

## 6. Success criteria for MVP (tie to Volume 2)

- Core loop completes at **≥ 90% completion rate** in beta (BO-3).
- **Request→match ≥ 85%**, pickup ETA ≤ 5 min in covered zones (BR success metrics).
- Ledger reconciles to zero discrepancy daily (R-PAY-1, BR-5).
- Connectivity-loss scenarios (drop during request/trip) recover without a stuck trip (A6.1).

## 7. Dependencies & risks (product-level)

- **Maps/geocoding** provider coverage in Kashmir — validate early (blocks E3/E5).
- **SMS provider** reliability in-region — critical for E1/E11 (A6.1).
- **Driver supply** at launch — product levers: referral, incentives (Volume 2 risks).
- **Regulatory** — aggregator compliance (A5) may add onboarding fields; keep KYC config-driven.

## 8. Open product questions

| #   | Question                                              | Needed by |
| --- | ----------------------------------------------------- | --------- |
| Q1  | Which SMS provider(s) have reliable Kashmir delivery? | M0        |
| Q2  | Maps/geocoding/routing provider for the region?       | M1        |
| Q3  | Default commission % and surge cap for launch?        | M1        |
| Q4  | Cancellation fee amount & grace window?               | M1        |
| Q5  | Payout cadence & method for drivers (bank/UPI)?       | M2        |
