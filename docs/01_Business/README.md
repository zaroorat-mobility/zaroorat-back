# Volume 2 — Business Documentation

> Why Zaroorat Ride exists, who it serves, and the business rules that engineering must
> encode. This volume is the bridge between "what the business wants" and "what we build".
> Product specs (PRD/SRS/user stories) build on this in **Volume 3 — Product & Requirements**.

**Owner:** Product & Founders · **Last reviewed:** 2026-07-06

---

## Contents

| Doc                                                                | Topic                                                            | Audience              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------- |
| [01_vision.md](01_vision.md)                                       | Mission, problem, positioning, north-star metric                 | Everyone              |
| [02_business-requirements-brd.md](02_business-requirements-brd.md) | BRD: objectives, scope, stakeholders, success metrics            | Product, Eng leads    |
| [03_personas.md](03_personas.md)                                   | Riders, drivers, ops, fleet owners — who we build for            | Product, Design, Eng  |
| [04_business-rules.md](04_business-rules.md)                       | The rules engineering must enforce (pricing, cancellation, KYC…) | Eng, QA               |
| [05_monetization-and-metrics.md](05_monetization-and-metrics.md)   | How we make money and what we measure                            | Product, Finance, Eng |

---

## ⚠️ Assumptions on record

These are working assumptions. **Correct any that are wrong** — they cascade into pricing,
compliance, and data-model decisions downstream.

| #   | Assumption                                                                                                                                                                                                    | Impact if wrong                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A1  | Primary market is the **Kashmir region, India (UT of Jammu & Kashmir)**; currency is **INR (₹)**                                                                                                              | Currency, GST, phone formats, KYC docs, map coverage |
| A2  | Launch cities: **Srinagar & Jammu** first, then valley/Jammu-division towns (Anantnag, Baramulla, Sopore, Udhampur)                                                                                           | Zone config, surge tuning, ops staffing              |
| A3  | Vehicle types at launch: **economy car, auto-rickshaw, bike**; **shared/tourist taxi (Sumo/Innova)** as a fast follow given local demand                                                                      | Pricing tables, matching, driver onboarding          |
| A4  | Payment: **cash + in-app wallet** at launch; **UPI (Google Pay / PhonePe / Paytm)** as the digital rail thereafter                                                                                            | Payments module scope, reconciliation                |
| A5  | Regulatory model: ride-hailing **aggregator under the MoRTH Motor Vehicle Aggregator Guidelines 2020 + J&K State Transport rules**; drivers are **partners**, not employees; **GST** applies to platform fees | Contracts, liability, tax, labor law                 |

### A6 — Region-specific engineering constraints (Kashmir)

These are not optional nice-to-haves; they are baseline requirements the whole system inherits:

| #    | Constraint                                                                                           | Why it matters here                                                      | Where it lands                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| A6.1 | **Connectivity is intermittent/unreliable** — network disruptions and low-bandwidth areas are common | Riders/drivers must not be stranded by a dropped connection mid-flow     | Mobile offline-tolerance (V7), **SMS/OTP fallback is critical not optional**, small payloads |
| A6.2 | **Harsh winters & mountainous terrain** — snow, the Jammu–Srinagar highway closing, long detours     | ETAs and distances differ wildly from straight-line; safety matters more | Pricing (time-heavy fares), routing, surge, matching radius (V5/V6)                          |
| A6.3 | **Strong seasonal + tourist demand** — Gulmarg, Pahalgam, Sonmarg peaks; off-season troughs          | Demand is spiky and seasonal, not a flat weekday curve                   | Surge tuning, driver incentives, capacity planning (V2/V14)                                  |
| A6.4 | **Bilingual/multilingual users** — Urdu, Kashmiri, Hindi, English                                    | Literacy and language vary; UI must be reachable                         | i18n from day one, icon-forward driver UI (V7)                                               |

> If any of A1–A6 is inaccurate, tell me before Volume 3 — the PRD and data model depend on them.
> (Corrected 2026-07-06: market changed from Pakistan → Kashmir, India.)
