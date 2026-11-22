# Specification Quality Checklist: Payment & Fare Settlement

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Gate result**: **PASSED** — ready for `/speckit-plan`
**Created**: 2026-08-23 · **Revalidated**: 2026-08-23 (pass 1: correction · pass 2: consolidation · pass 3: decision application)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — the "Current State" section describes observed _behaviour_, which is required context for a brownfield feature
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — the Business Decisions section is deliberately written for a product owner, not an engineer
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No `[NEEDS CLARIFICATION]` markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable (SC-001…SC-010)
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded — explicit Out of Scope section, plus `[DEFERRED]` tags on requirements consciously excluded
- [x] Dependencies and assumptions identified
- [x] **Every requirement is tagged `[V1]`, `[BLOCKED: BD-n]`, or `[DEFERRED]`** so no blocked requirement can be picked up by accident

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification
- [x] **✅ No unresolved business decision would force the implementation to choose a financial policy** — **PASSES.** All seven (BD-1 … BD-7) were approved on 2026-08-23; see [decisions.md](../decisions.md).

## Correction Pass Findings (2026-08-23)

### Corrected: the critical finding was overstated

The first draft described the wallet top-up hole as a live financial vulnerability — "any authenticated rider can create money", "a live loss". Exhaustive re-tracing of the committed code showed the fabricated balance has **no spend path**: no withdrawal, no transfer, and no ride debits a customer wallet.

Reclassified **B — verified design gap, not currently exploitable**, with the qualifier that it converts to class A the moment this feature adds the debit path. The fix remains sequenced first; the justification changed from "money is being stolen" to "do not ship a debit path onto a mintable balance". Full evidence table in spec.md §Critical Finding Classification.

Four mandatory regression tests (RT-1…RT-4) now gate the debit path's merge.

### Two new findings discovered while re-verifying

1. **The ledger asserts payments that never happened.** `recordTripPayment` runs unconditionally at completion, so every non-cash ride has ledger entries claiming the customer paid. It also debits `CUSTOMER_WALLET` for card and UPI rides, which is the wrong account under the convention the codebase otherwise follows. → FR-037, FR-038.
2. **A client can name its own amount and `rideId` on a payment intent.** Neither is validated. Harmless today because nothing reads `intent.rideId`; a fare-bypass hole the moment collection does. → FR-012, US2-7, RT-3.

### Assumptions withdrawn

Three defaults previously recorded in the Assumptions section were setting financial policy and have been withdrawn and escalated: earnings recognition on failed collection (BD-1), debt ceilings (BD-2, BD-3), retry window (BD-4). A fifth was newly identified: cash confirmation rollout (BD-5), which would leave every cash ride unpaid if the backend shipped before the driver app could confirm. Pass 2 added BD-6 and BD-7.

### Speculative scope removed

`payment_intents(ride_id)` index · `payment.cash.confirmed` event · `payment.debt.recorded` event · hold capture · `GET /drivers/me/settlements` · `PAYMENT_DRIVER_DEBT_LIMIT` · ride-linked refund reversal · `AUTHORIZED`/`REFUNDED` states.

**Net as of pass 2** (superseded by the pass-3 figures below, once the approved decisions were applied): migrations 4 → 4 · config knobs 5 → 4 · new events 4 → 2.

### Retained despite scrutiny, with justification

**Driver debt is not speculative and is not caused by customer payment failure.** It arises from cash rides, where the driver holds 100% of the fare and owes the platform its commission. `recordTripPayment`'s cash branch already posts that debit and `SettlementService` already carries a code comment about the negative-netting case. The concept exists; only recovery is missing. Driver _blocking_, by contrast, was speculative and is now BD-3 with a recommendation against it.

## Pass 2 Findings — consistency & decision consolidation

### Decisions consolidated into one source of truth

BD options, defaults and recommendations were previously restated across spec.md, plan.md and research.md — three places to read and three to update. **[decisions.md](../decisions.md) is now the single source of truth**; every other artifact references decisions by ID only. Verified: no other file restates an option table.

### Two further findings

3. **The idempotency claim was broader than the code.** `withIdempotency` has exactly five call sites; `POST /intents/:intentId/confirm` is not one of them despite being mutating. Safe in effect via an incidental transition guard, but not by the mechanism the contract asserted. → FR-040, plus a route-by-route audit table replacing the blanket claim.
4. **Two events described one state transition.** `payment.debt.recorded` published in the same transaction as `payment.ride.collection_failed(willRetry: false)`. A consumer on both would double-notify. Removed; debt is derivable from the retained event. → new event count 4 → 2.

### Terminology disambiguated

`FAILED` meant two different things at two levels — a failed _attempt_ and a standing _debt_. Three vocabularies are now explicit, with a derivation table: attempt (`RidePayment.status`), obligation (`Ride.paymentStatus`), and a derived public `collectionState` in which **the token `FAILED` never appears**. → FR-041.

### Standing debt made precise

Debt is **not a row**. It is `Ride.paymentStatus = FAILED` with the amount from `RideFare.totalFare`, so duplicate debts are impossible by construction — a ride has one `paymentStatus`, guaranteed by its primary key. Repeated events, sweeps and retries have nothing to duplicate. Repayment is a new attempt row against the same ride.

### Breaking change narrowed

The `POST /wallet/topup` response is now **additive** — every existing field retained, `balance` reporting the current uncredited value. Pass 1 proposed dropping the wallet fields, which would have been an avoidable shape break. Only behaviour changes, which is unavoidable and is the point.

## Pass 3 — Decision Application

All seven decisions approved and applied verbatim, without reinterpretation.

### Requirements unblocked

| FR     | Was           | Now                               | Because                                                 |
| ------ | ------------- | --------------------------------- | ------------------------------------------------------- |
| FR-015 | BLOCKED: BD-4 | **[V1]**                          | Bounded, configurable retry approved                    |
| FR-016 | BLOCKED: BD-2 | **[V1]**                          | Threshold approved; `>=`; settling never blocked        |
| FR-019 | BLOCKED: BD-5 | **[V1]**                          | Feature-flagged, default OFF, unreachable when disabled |
| FR-022 | BLOCKED: BD-3 | **[CLOSED — will not implement]** | No driver blocking approved                             |
| FR-026 | BLOCKED: BD-1 | **[V1]**                          | Earnings recognised regardless of collection            |
| FR-027 | BLOCKED: BD-1 | **[V1]**                          | Later settlement clears the receivable only             |
| FR-039 | BLOCKED: BD-1 | **[V1]**                          | `CUSTOMER_RECEIVABLE` posting defined                   |

**FR-022 is the one that did not become `[V1]`.** BD-3 resolved it by deciding _not_ to build it. Marking it `[V1]` would have inverted the approved decision, so it is closed as will-not-implement — the driver commission tracking it was sometimes confused with (FR-020, FR-021) was never blocked and remains in V1.

### Requirements added by approved decisions

FR-042 (write-off, BD-1c) · FR-043 (automatic cash resolution, BD-6) · FR-044 (prospective-only ledger, BD-7). None speculative — each is mandated by approved text.

### Scope changes

Migrations 4 → **5** (write-off uniqueness) · knobs 4 → **7** (BD-1c, BD-6, BD-7 each mandate one) · events 2 → **3** (write-off audit event) · ledger accounts 4 → **6** (`CUSTOMER_RECEIVABLE`, `BAD_DEBT_EXPENSE`) · sweep jobs 1 → **2** (write-off cadence is days, not minutes).

### Consequence flagged for the product owner

BD-1c and BD-2 read together mean **a written-off receivable stops counting toward the debt threshold**, so a rider who waits out the ageing period is unblocked. This is a faithful consequence of both approved decisions, not a defect in either — surfaced so it is a known trade-off rather than a surprise in production.

## Notes

**This specification IS ready for `/speckit-plan`.** All business decisions are approved and applied; no financial policy remains for the implementation to choose.

`tasks.md` exists from an earlier pass and carries a blocking header. It is **superseded** and must be regenerated with `/speckit-tasks`: BD-1 changed the settlement query, BD-3 removed a task entirely, and BD-1c/BD-6/BD-7 added work that did not exist when it was written.

The constitution at `.specify/memory/constitution.md` is **RATIFIED** (v1.0.0, 2026-08-23) — 73 REQUIRED, 6 SHOULD and 5 EXCEPTION rules across 18 areas, each citing the code that enforces it. The plan constitution gate is therefore a real gate and it **passes**.
