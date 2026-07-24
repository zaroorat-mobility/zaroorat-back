# Volume 3 (Part A) — Product

> The **product** half of Volume 3. Translates the business (Volume 2) into features and testable
> user stories — the _what_ and _why_. The precise, verifiable _requirements_ (functional SRS,
> non-functional SRS, traceability) are **Part B → [`03_Requirements/`](../03_Requirements/README.md)**.

**Owner:** Product · **Last reviewed:** 2026-07-06 · **Market context:** Kashmir, India (see [Volume 2](../01_Business/README.md))

> **Volume 3 spans two folders** (mirroring the repository structure):
>
> - **`02_Product/`** (this folder) — PRD + user stories (product intent)
> - **`03_Requirements/`** — SRS functional, SRS non-functional, traceability (engineering spec)

---

## Contents (Part A — Product)

| Doc                                      | Topic                                                      | Primary audience     |
| ---------------------------------------- | ---------------------------------------------------------- | -------------------- |
| [01_prd.md](01_prd.md)                   | Product Requirements: epics, MVP scope, M0–M4 release plan | Product, Eng, Design |
| [02_user-stories.md](02_user-stories.md) | User stories with Given/When/Then acceptance criteria      | Eng, QA, Design      |

**Part B — Requirements** (in [`03_Requirements/`](../03_Requirements/README.md)):

| Doc                                                                       | Topic                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [01_srs-functional.md](../03_Requirements/01_srs-functional.md)           | Functional requirements (FR-###) traced to business rules  |
| [02_srs-nonfunctional.md](../03_Requirements/02_srs-nonfunctional.md)     | NFRs: performance, reliability, security, i18n, resilience |
| [03_traceability-matrix.md](../03_Requirements/03_traceability-matrix.md) | Business rule → FR → story → test coverage map             |

---

## How to read requirement IDs

The handbook uses one consistent ID scheme so a rule can be traced end-to-end:

```
Business rule (V2)      →  Functional req (V3)  →  User story (V3)  →  Test (V12)
   R-PRICE-4                    FR-PRICE-03            US-RIDE-02          T-PRICE-03
"rider sees fare          "system SHALL display   "As a rider I want   (asserts the
 before confirming"        the fare estimate…"     to see the fare…"    behavior)
```

- **R-…** business rules — _policy_ (Volume 2).
- **FR-…** functional requirements — _system behavior_ (`03_Requirements/`). Each cites the R-rules it satisfies.
- **NFR-…** non-functional requirements — _qualities_ (performance, security…).
- **US-…** user stories — _user-facing, testable slices_ with acceptance criteria (this folder).
- **T-…** tests — _proof_ (Volume 12).

The [traceability matrix](../03_Requirements/03_traceability-matrix.md) is the single view that ties these together.

## Prioritization language (MoSCoW)

Requirements are tagged **Must / Should / Could / Won't (this release)**. "Must" = MVP-blocking.
