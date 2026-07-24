# Volume 5 — Low-Level Design (LLD)

> The internals of each backend module: state machines, algorithms, data structures, concurrency,
> and edge cases. Volume 4 said _how the boxes connect_; this volume says _what happens inside each
> box_, at a level a developer can implement from directly. Every design here cites the functional
> requirements (`FR-…`) and business rules (`R-…`) it realizes.

**Owner:** Engineering · **Last reviewed:** 2026-07-06

---

## Contents

| Doc                                                  | Module                | The hard part it pins down                                |
| ---------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| [01_auth.md](01_auth.md)                             | `auth`                | OTP lifecycle, JWT/refresh, rate limiting, idempotency    |
| [02_trip-state-machine.md](02_trip-state-machine.md) | `rides` (trip)        | The trip state machine — the spine of the whole system    |
| [03_matching.md](03_matching.md)                     | `rides` (matching)    | Candidate search, offer loop, atomic assignment, fairness |
| [04_pricing.md](04_pricing.md)                       | `pricing`             | Fare formula, surge, zones, fare lock, config model       |
| [05_wallet-ledger.md](05_wallet-ledger.md)           | `wallet`              | Double-entry ledger, settlement, concurrency, GST         |
| [06_drivers-kyc.md](06_drivers-kyc.md)               | `drivers`, `vehicles` | Onboarding state machine, eligibility computation         |
| [07_notifications.md](07_notifications.md)           | `notifications`       | Channel selection, push→SMS fallback, templating          |
| [08_domain-events.md](08_domain-events.md)           | (cross-cutting)       | The event catalog + delivery/idempotency semantics        |

---

## Conventions used in this volume

- **State machines** are drawn with Mermaid `stateDiagram-v2` and accompanied by a **transition
  table** (from → event → to → guard → side-effects). The diagram is the picture; the table is the
  contract.
- **Pseudocode** follows Volume 1 coding standards (async, typed, service→repository layering,
  domain exceptions). It's illustrative, not copy-paste production code, but it's honest about the
  hard parts (locks, idempotency, ordering).
- **Edge cases** get their own subsection per module — the edge cases _are_ the design. Happy paths
  are easy; this volume earns its keep on the failures.
- **"Invariants"** boxes state what must _always_ be true. These become assertions and tests
  (Volume 12).

## How to read a module design

Each module doc is structured the same way:

1. **Responsibility** — one paragraph: what this module owns (and what it deliberately doesn't).
2. **Data structures** — the key entities/fields (schema detail is Volume 6; here it's shape).
3. **Core logic** — state machine and/or algorithm with diagrams + pseudocode.
4. **Concurrency & consistency** — locks, transactions, idempotency, race conditions.
5. **Edge cases & failure handling** — the interesting part.
6. **Invariants & traceability** — what must hold, and which `FR-`/`R-` it satisfies.

> Schemas (exact columns, indexes, migrations) are **Volume 6**. API contracts are **Volume 7**.
> This volume is the _behavior_; those are the _shape of data_ and the _shape of the interface_.
