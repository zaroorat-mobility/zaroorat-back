# Pricing, Zones & Reports

**Owner:** Engineering (Web) + Ops · **Last reviewed:** 2026-07-06
**Realizes:** FR-ADMIN-05, FR-PRICE-02, R-PRICE-3/6, R-DATA-2, Volume 2 metrics

Two ops capabilities that let the business steer without engineering: **tuning the marketplace's
economics** (pricing, zones, surge) and **measuring it** (reports). Both are built on foundations laid
earlier — config-driven pricing (Volume 5) and canonical metrics (Volume 2).

---

## Pricing configuration UI

Pricing parameters are **data, not code** (R-PRICE-6). This UI is how authorized ops (`pricing:write`)
edit them — safely, with bounds, versioning, and audit.

```
┌──────── Pricing — Srinagar / auto ─────────  (version 7, effective now) ┐
│ Base fare        ₹30.00                                                 │
│ Per km           ₹10.00                                                 │
│ Per min          ₹1.00                                                  │
│ Booking fee      ₹0.00                                                  │
│ Minimum fare     ₹40.00                                                 │
│ Surge cap        3.0×                                                   │
│ Cancellation fee ₹20.00   grace 120s                                    │
│ Commission       15.0%     GST  5.0%                                    │
│                              [ Preview effect ]   [ Save (audited) ]    │
└─────────────────────────────────────────────────────────────────────────┘
```

Rules baked into the UI + API:

- **Bounded inputs:** each field has validation bounds (e.g. surge cap ≤ platform max, commission
  within policy) so ops can't set a nonsensical or policy-violating value.
- **Preview before save:** shows the effect on sample trips before committing — no blind price
  changes.
- **Versioned + audited:** saving creates a **new `pricing_configs` version** (Volume 6) and writes
  `audit_log` with before/after and actor (R-DATA-2). It takes effect for **new estimates only** —
  never retroactively re-prices booked/completed trips (R-PRICE-5).
- **No deploy needed** — the whole point (R-PRICE-6). A demand spike is answered in the UI, not a
  release.

### Surge

- Surge multipliers are largely **auto-computed** from demand/supply per zone (Volume 5 §04), but ops
  can **cap, pause, or override** within bounds from here — and every override is audited.
- The dashboard's surge overlay ([03](03_dashboards-live-ops.md)) shows what's currently surging.

---

## Zone management (PostGIS-backed)

Zones (serviceable areas, surge zones, airport, restricted) are **polygons** (Volume 6 §03). The UI
lets ops:

- **Draw/edit** zone polygons on a map (saved as `geometry(Polygon,4326)`, GiST-indexed).
- Set a zone's **kind** (serviceable / surge / airport / restricted) and city.
- **Validate** geometry on save (`ST_IsValid`) — an invalid polygon silently breaks containment, so
  the UI rejects it.

Serviceability zones define **where the app offers rides** at all; surge zones feed pricing. Getting
these right for Srinagar/Jammu (and seasonal tourist spots, A6.3) is an ops lever for expansion.

---

## Reports

Reports present the **Volume 2 metrics** using their **canonical definitions** — so the number in a
report, a dashboard tile ([03](03_dashboards-live-ops.md)), and a board deck all agree. This
consistency is the entire reason those definitions are canonical.

| Report            | Metrics (V2)                                                      | Audience        |
| ----------------- | ----------------------------------------------------------------- | --------------- |
| **Marketplace**   | weekly completed trips (north star), match rate, ETA, fulfillment | Ops, founders   |
| **Riders**        | WAR, trips/rider, W4 retention                                    | Growth          |
| **Drivers**       | WAD, earnings/online-hour, acceptance, retention, utilization     | Ops, driver-ops |
| **Quality/Trust** | completion, cancel rate, ratings, safety incidents                | Ops, safety     |
| **Finance**       | GMV, net revenue, take rate, contribution margin, GST liability   | Finance         |

Report characteristics:

- **Read from replicas / analytics** (Volume 6 §05), never heavy scans on the primary.
- **Filter by city + date range**; export (CSV) for finance/board use.
- **Guardrail pairing:** growth reports show their guardrails alongside (Volume 2) — e.g. trips growth
  next to driver earnings/hour — so "growth" that's harming a side is visible.
- Charts follow the **[dataviz]** guidance (consistent, accessible, light/dark).

> Deeper analytics (cohorts, funnels, ML inputs) belong to the analytics/data volume (reserved
> `17_Data/`); this admin reporting covers the **operational** reporting ops and finance need daily.

---

## Traceability

| Element                                     | Satisfies                           |
| ------------------------------------------- | ----------------------------------- |
| Bounded, previewed, versioned pricing edits | FR-PRICE-02, FR-ADMIN-05, R-PRICE-6 |
| Effect on new estimates only                | R-PRICE-5                           |
| Surge cap/override, audited                 | R-PRICE-3, R-DATA-2                 |
| Zone polygon editing + validation           | R-PRICE-3, Volume 6 §03             |
| Reports on canonical metrics                | Volume 2 metrics                    |
| Reports off replicas                        | NFR-PERF, Volume 6 §05              |
