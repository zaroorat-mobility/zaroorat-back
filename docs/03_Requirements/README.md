# Volume 3 (Part B) — Requirements

> The **requirements** half of Volume 3. Where the product intent from
> **Part A → [`02_Product/`](../02_Product/README.md)** becomes a precise, verifiable engineering
> specification: exactly what the system _shall_ do (functional), how well it must do it
> (non-functional), and a matrix proving every business rule is covered end-to-end.

**Owner:** Product & Engineering · **Last reviewed:** 2026-07-06 · **Market context:** Kashmir, India

---

## Contents (Part B — Requirements)

| Doc                                                    | Topic                                                                                                             | Primary audience  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------- |
| [01_srs-functional.md](01_srs-functional.md)           | Functional requirements (`FR-###`) — exact system behavior, each traced to a business rule                        | Eng, QA           |
| [02_srs-nonfunctional.md](02_srs-nonfunctional.md)     | Non-functional requirements (`NFR-###`) — measurable qualities: latency, availability, security, resilience, i18n | Eng, SRE, QA      |
| [03_traceability-matrix.md](03_traceability-matrix.md) | The spine: Business rule → FR → user story → test                                                                 | Product, QA leads |

**Part A — Product** lives in [`02_Product/`](../02_Product/README.md): the PRD and user stories.

---

## Why these are separate documents

| Document            | Answers                                         | Nature                                                          |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| Functional SRS      | "_What_ must it do?"                            | Behavior, testable, traced to rules                             |
| Non-functional SRS  | "_How well_ must it do it?"                     | Measurable qualities, the acceptance bar for architecture & ops |
| Traceability matrix | "Did we cover everything, and can we prove it?" | The audit view across V2→V3→V12                                 |

A functional requirement without a rule is scope creep; a rule without a functional requirement is
a gap; a "Must" requirement without a test is a risk. The [matrix](03_traceability-matrix.md)
surfaces all three, and every new `FR-` **must** add a row there in the same PR.

## Requirement ID conventions

- **`FR-<area>-##`** — functional (e.g. `FR-MATCH-02`). "SHALL" = mandatory. Tagged MoSCoW.
- **`NFR-<area>-##`** — non-functional, always with a _measurable_ target (a number, not an adjective).
- Both trace **back** to business rules (`R-…`, Volume 2) and **forward** to tests (`T-…`, Volume 12).

See the full ID scheme and the read-the-IDs guide in [Part A](../02_Product/README.md#how-to-read-requirement-ids).
