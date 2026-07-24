# Monetization & Metrics

**Owner:** Product & Finance · **Last reviewed:** 2026-07-06

How Zaroorat Ride makes money, and the exact definitions of the numbers we steer by. Metric
definitions here are **canonical** — dashboards (Volume 8) and analytics (Volume 17) must
compute them this way, or the numbers won't agree across the company.

---

## Revenue model

Primary revenue is a **commission (take rate)** on completed trips.

| Stream                | Description                                                                              | v1?   |
| --------------------- | ---------------------------------------------------------------------------------------- | ----- |
| **Commission**        | Platform keeps a % of each completed trip's fare (default **15%**, config, range 12–18%) | ✅    |
| **Cancellation fees** | Rider no-show/late-cancel fee, split per policy                                          | ✅    |
| **Surge share**       | Commission applies to the surged fare; extra demand → extra revenue                      | ✅    |
| Wallet float          | Interest/float on prepaid wallet balances                                                | later |
| Driver subscriptions  | Optional flat fee / lower commission tier                                                | later |
| Ads / partnerships    | In-app promotions                                                                        | later |

> **Tax (India/GST):** platform commission and cancellation/convenience fees are subject to
> **GST**. Under the aggregator model the platform is responsible for collecting/remitting GST on
> its service fee (and, depending on vehicle class e.g. autos vs. cabs, potentially on the ride
> fare per prevailing rules). Every ledger entry (R-PAY-1) MUST therefore record its **tax
> component separately** so net revenue, driver payout, and GST liability are individually
> reconcilable. Confirm exact rates/treatment with a tax advisor before launch — the _data model_
> must carry a tax field regardless (Volume 6). All fares/fees are denominated in **INR (₹)**.

### How money splits on a completed trip

```
Rider pays fare (cash or wallet)
        │
        ├─►  Platform commission (take rate %)      → Zaroorat revenue
        └─►  Driver net earnings (fare − commission) → Driver ledger

Cash trip:   driver collects cash, OWES commission to platform (deducted from wallet/future earnings)
Wallet trip: platform collects, credits driver net, keeps commission
```

Every split above is one or more **ledger entries** (R-PAY-1). See Volume 6 for the schema.

### Unit economics (per trip) — the model we track

```
Revenue per trip      = commission + attributable fees
Variable cost per trip = payment processing + SMS/push + support allocation + incentives
Contribution margin    = revenue per trip − variable cost per trip
```

**BO-4 target:** contribution margin per trip positive by month 9. Incentives/subsidies are the
lever that can push it negative — they are tracked explicitly, not hidden.

---

## Metric definitions (canonical)

> Time zone for "day/week" boundaries is the **market local time**. A "week" is Mon–Sun unless
> a dashboard states otherwise.

### Marketplace

| Metric                                  | Definition                                                 |
| --------------------------------------- | ---------------------------------------------------------- |
| **Weekly Completed Trips** (north star) | Count of trips reaching `completed` in the week            |
| Request→Match rate                      | matched requests ÷ total ride requests                     |
| Match→Completion rate                   | completed trips ÷ matched requests                         |
| Avg pickup ETA                          | mean(driver arrival time − match time) for completed trips |
| Fulfillment rate                        | completed trips ÷ total ride requests (end-to-end)         |

### Riders

| Metric                     | Definition                                                   |
| -------------------------- | ------------------------------------------------------------ |
| Weekly Active Riders (WAR) | distinct riders with ≥ 1 completed trip in the week          |
| Trips per rider per week   | completed trips ÷ WAR                                        |
| Rider W4 retention         | % of a signup cohort with a completed trip in their 4th week |

### Drivers

| Metric                      | Definition                                           |
| --------------------------- | ---------------------------------------------------- |
| Weekly Active Drivers (WAD) | distinct drivers with ≥ 1 completed trip in the week |
| Earnings per online hour    | driver net earnings ÷ online hours                   |
| Acceptance rate             | accepted offers ÷ offers received                    |
| Driver W4 retention         | % of an onboarding cohort active in their 4th week   |
| Utilization                 | on-trip time ÷ online time                           |

### Quality & trust

| Metric               | Definition                                                              |
| -------------------- | ----------------------------------------------------------------------- |
| Completion rate      | completed trips ÷ (completed + cancelled after accept)                  |
| Cancellation rate    | cancelled-after-accept ÷ matched requests                               |
| Avg rating           | mean of trip ratings (rider→driver and driver→rider tracked separately) |
| Safety incident rate | logged safety incidents ÷ completed trips                               |

### Business

| Metric                   | Definition                                                 |
| ------------------------ | ---------------------------------------------------------- |
| GMV                      | sum of completed-trip fares                                |
| Net revenue              | commission + fees − refunds                                |
| Take rate                | net revenue ÷ GMV                                          |
| Contribution margin/trip | (net revenue − variable cost) ÷ completed trips            |
| CAC payback              | acquisition cost ÷ contribution margin per user per period |

---

## Guardrails (metrics we watch to avoid gaming)

Optimizing one metric can harm the marketplace. We pair growth metrics with guardrails:

| If we push…                   | Watch that we don't hurt…                 |
| ----------------------------- | ----------------------------------------- |
| Trips (via low fares)         | Contribution margin, driver earnings/hour |
| Take rate (higher commission) | Driver retention, acceptance rate         |
| Surge revenue                 | Rider trust, cancellation rate            |
| Fast matching (wider radius)  | Pickup ETA, driver dead miles             |

A change that moves a target metric while breaking a guardrail is **not** a win. This tension is
the whole job of a two-sided marketplace, and it's why the north star is _completed trips_ — the
one number that only rises when both sides are genuinely served.
