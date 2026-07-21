# Project Vision

> **Status:** 🟡 Draft · **Owner:** Founders / Product · **Last updated:** 2026-07-20
> **See also:** [Business Requirements](./BUSINESS_REQUIREMENTS.md), [Feature Catalog](./FEATURE_CATALOG.md), [Phase 0 Planning](../phase-0-project-planning.md)

## The one-liner

**Zaroorat is a ride-hailing platform that connects riders who need a trip with drivers who can provide it, in real time — reliably, safely, and at a fair price.**

*Zaroorat* means "necessity." That is the thesis: transport is a daily need, not a luxury. We win in markets where the alternatives are too expensive, unsafe, or simply unavailable.

## What the backend must be

- **Real-time first.** A ride request, a driver moving on the map, a trip's state, a chat message — all live. Latency and correctness of state *are* the product.
- **Trustworthy with money.** Fares, payouts, promos, and refunds must be exactly right, auditable, and idempotent. A double charge is worse than a slow response.
- **Safe by design.** SOS, trip sharing, document verification, and ride history are core features, not add-ons.
- **Operable at 3 a.m.** The team can observe, debug, and recover the system under load without heroics.

## North-star outcome

A rider opens the app, is matched to a nearby **verified** driver in seconds, watches the car approach live, completes the trip, is charged the **exact quoted fare**, and both parties can rate each other and get help if something goes wrong.

## Who we serve

| | Need |
|---|---|
| **Riders** | A safe, affordable ride, now — with a price they can trust. |
| **Drivers** | Reliable earnings with low friction and fair pay. |
| **Operations** | Tools to verify supply, manage pricing, and resolve issues. |

## What success looks like (headline metrics)

- High **match rate** and low **time-to-match**.
- High **trip completion** and **payment success**, low **dispute** rate.
- Healthy **driver liquidity** (enough drivers online where demand is).
- Fast **safety-incident response**.

(Full KPI definitions in the [Business Requirements](./BUSINESS_REQUIREMENTS.md).)

## Explicit non-goals (for now)

- Not a food-delivery, courier, or logistics marketplace.
- Not a multi-tenant / white-label SaaS. One brand, one platform.
- No native mobile app source here — **this repo is the backend and real-time services only**.

## Guiding principles

1. **Postgres is truth; Redis is speed.**
2. **The `rides` module owns trip state; everyone else asks.**
3. **Workers own time.**
4. **Money is transactional and idempotent — always.**
5. **Validate at the edge; deny by default.**
6. **Everything important leaves an append-only audit trail.**
7. **Build for a second market from day one — no hard-coded locale, currency, or fares.**

These principles are enforced in the [engineering standards](../02_ENGINEERING/) and the [architecture](../01_ARCHITECTURE/SYSTEM_ARCHITECTURE.md).
