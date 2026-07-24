# Volume 9 — Admin Dashboard

> The operations console — how the team runs the marketplace. Sana (ops persona) lives here all day:
> approving drivers, watching supply/demand, resolving disputes, tuning pricing, pulling reports.
> Built as a React + Vite + Tailwind SPA against the `👮` admin API (Volume 7).

**Owner:** Engineering (Web) · **Last reviewed:** 2026-07-06

---

## Contents

| Doc                                                        | Topic                                               |
| ---------------------------------------------------------- | --------------------------------------------------- |
| [01_project-structure.md](01_project-structure.md)         | React + Vite + Tailwind layout, routing, data layer |
| [02_rbac-permissions.md](02_rbac-permissions.md)           | Roles, scopes, and where they're enforced           |
| [03_dashboards-live-ops.md](03_dashboards-live-ops.md)     | Live supply/demand, active-trips map, health        |
| [04_dispute-resolution.md](04_dispute-resolution.md)       | Dispute workflow, trip evidence, refunds, audit     |
| [05_pricing-zones-reports.md](05_pricing-zones-reports.md) | Pricing/zone config UI, reports on V2 metrics       |

---

## Principles

1. **The admin is a client, not a backdoor.** It calls the same versioned API (Volume 7) with the
   same auth and **RBAC enforced server-side**. It has no privileged database access. A bug or a
   compromised admin account can't exceed what the API allows (NFR-SEC-04).
2. **Every consequential action is audited.** Approvals, refunds, suspensions, pricing changes all go
   through audited endpoints (Volume 6, R-DATA-2). The UI surfaces _who did what_, and never hides it.
3. **Least privilege by default.** Roles map to scopes; not every agent can refund or change pricing.
   The UI hides what a role can't do, but the **server is the real gate** ([02](02_rbac-permissions.md)).
4. **Evidence-first.** Ops decisions (disputes, refunds) are made against **trip evidence** — route,
   timeline, ledger, ratings — presented in one place, not pieced together from raw tables.
5. **Same design system as mobile.** Shares `packages/ui-kit` tokens/components so the product feels
   like one system (Volume 1/8).
6. **Server state via React Query.** Same rule as mobile (Volume 8): API data → React Query; UI state
   → local. No hand-rolled data stores.

---

## Tech choices

| Concern           | Choice                                   | Why                                      |
| ----------------- | ---------------------------------------- | ---------------------------------------- |
| Build/dev         | **Vite**                                 | fast dev server + build                  |
| UI                | **React + TypeScript (strict)**          | shared paradigm with mobile              |
| Styling           | **Tailwind** + `packages/ui-kit` tokens  | consistent, fast, themable               |
| Routing           | **React Router** (route-based pages)     | mature SPA routing                       |
| Server state      | **React Query**                          | caching, background refresh for live ops |
| Tables/data grids | virtualized data grid                    | large trip/ledger lists                  |
| Charts            | charting lib (see [dataviz])             | reports on V2 metrics                    |
| API client        | **generated** (`packages/api-contracts`) | drift-proof (Volume 7)                   |
| Realtime          | WS subscription for live dashboard       | active-trips map, live counts            |

---

## Who uses it (roles preview — detail in [02](02_rbac-permissions.md))

| Role               | Typical actions                                                 |
| ------------------ | --------------------------------------------------------------- |
| **Support agent**  | search trips, view evidence, respond to riders/drivers          |
| **Ops manager**    | approve/reject drivers, suspend accounts, monitor supply/demand |
| **Finance**        | view ledgers/earnings, issue refunds, run financial reports     |
| **Pricing/growth** | edit pricing configs, manage zones/surge                        |
| **Admin (super)**  | manage roles, all of the above                                  |

The UI adapts to the signed-in role; the API enforces it.
