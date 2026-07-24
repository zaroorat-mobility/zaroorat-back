# Personas

**Owner:** Product & Design · **Last reviewed:** 2026-07-06

Personas keep us building for real people, not an abstract "user". When a requirement is
ambiguous, ask "what would _this_ persona need here?". Each persona lists goals, frustrations,
context, and the design implications engineering must honor.

---

## Primary personas

### 🧕 Ayesha — the everyday commuter (Rider)

- **Age/context:** 26, office worker in Srinagar, mid-range Android phone, budget-conscious.
- **Goals:** Get to work/home reliably and affordably; know the fare up front; feel safe,
  especially in the evening.
- **Frustrations:** Haggling with rickshaw drivers; surge she didn't expect; unsafe drivers;
  running out of cash.
- **Context of use:** On the street, in a hurry, sometimes low battery, sometimes patchy data.
- **Design implications:**
  - Fare MUST be shown and locked before booking (BR-1).
  - App MUST work on low-end devices and tolerate flaky connectivity (offline-tolerant, small payloads).
  - Safety features (share trip, SOS, driver identity) must be one tap away.
  - Wallet top-up and cash both easy.

### 🛺 Imran — the driver-partner (Driver)

- **Age/context:** 34, drives an auto-rickshaw in Jammu (and a shared taxi in season),
  primary breadwinner, moderate literacy, relies on the app for daily income.
- **Goals:** Maximize earnings per online hour; steady stream of nearby requests; get paid fast
  and understand exactly what he earned; minimal idle time and dead miles.
- **Frustrations:** High commissions; unclear earnings; long pickups; unfair penalties; delayed payouts.
- **Context of use:** Driving, glancing at the phone, mounted device, gloves/heat, needs big
  tap targets and audio cues.
- **Design implications:**
  - Accept/decline MUST be large, fast, and safe to use while stationary; audio alerts for new requests.
  - Earnings screen MUST be transparent: fare, commission, net, per trip and per day.
  - Payout MUST be traceable to trips and within SLA (BR-8).
  - Matching rules should spread trips fairly, not starve some drivers.
  - Minimize data usage (background location, efficient payloads).

### 👩‍💼 Sana — the operations agent (Admin)

- **Context:** Works from the admin dashboard; monitors live supply/demand, resolves rider–driver
  disputes, manages driver onboarding approvals, adjusts zones and surge.
- **Goals:** See what's happening in real time; act fast on incidents; resolve disputes with
  evidence; keep supply healthy.
- **Frustrations:** Slow tools; missing trip evidence; having to touch the database directly.
- **Design implications:**
  - Admin needs live dashboards, searchable trip/ledger history, and audit trails (Volume 8).
  - Role-based access — not every agent can refund or change pricing (RBAC).
  - Every admin action MUST be logged and reversible where possible.

---

## Secondary personas

### 🧑‍🔧 Kamran — the fleet owner

- Owns 5 rickshaws, employs drivers, wants aggregate earnings and vehicle-level reporting.
- **Design implications:** vehicle ↔ driver may be many-to-one over time; fleet reporting is a
  later feature but the **data model must not assume one driver owns exactly one vehicle**.

### 🛡️ Compliance officer

- Needs KYC records, data-retention adherence, and incident reports.
- **Design implications:** immutable audit tables, retention policies, exportable records (Volume 6, 14).

### 💰 Finance analyst

- Reconciles cash and wallet daily, reports take rate and margins.
- **Design implications:** the financial ledger is append-only and reconcilable; every trip maps
  to transactions (Volume 6).

---

## Persona → priority matrix

When trading off, this is the default priority order for **v1**:

1. **Driver supply** (Imran) — no drivers, no marketplace.
2. **Rider trust** (Ayesha) — no trust, no demand.
3. **Ops efficiency** (Sana) — keeps the marketplace healthy at low cost.
4. Fleet/finance/compliance — critical but not the daily UX we optimize first.

> This ordering is why driver-side reliability and transparent earnings are non-negotiable in v1,
> even ahead of some rider niceties.
