# Testing

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **Rule:** every module change ships with tests. Business rules (services) require unit tests; critical flows require integration tests.

---

## 1. The pyramid

| Layer           | What it proves                                                                              | Against                                |
| --------------- | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Unit**        | service business rules & invariants (state machine, pricing math, idempotency, promo rules) | mocked repositories/adapters           |
| **Integration** | `routes → controller → service → repository → DB`                                           | real Postgres + Redis (docker-compose) |
| **Contract**    | request/response match the published JSON Schema / Swagger                                  | route schemas                          |
| **Worker**      | job idempotency & retry (dispatch timeout, charge capture)                                  | real queue                             |
| **E2E flow**    | the full core loop: request → match → dispatch → ride → pay                                 | full stack                             |

Most tests are **unit** (fast, many); fewer **integration**; a handful of **E2E** for the money-critical journeys.

## 2. What must be tested (non-negotiable)

- **Trip state machine:** every legal transition succeeds; every illegal one is rejected with `INVALID_TRIP_TRANSITION`.
- **Idempotency:** replaying a money POST / re-running a charge job does **not** double-charge.
- **Pricing determinism:** stored `quoteInputs` reproduce the same fare.
- **Authorization:** a user cannot access another user's trip/payment; role gates hold.
- **Dispatch timeout:** worker re-offers on timeout; late accept after reassignment is rejected.
- **Operable gating:** a non-verified/expired-doc driver cannot go online.

## 3. Conventions

- Tests live in `tests/`, mirroring `src/modules/<name>`.
- Name tests by behavior: `rejects late accept after reassignment`, not `test accept 2`.
- **Arrange–Act–Assert**; one behavior per test.
- Deterministic: no real time, randomness, or network. Use fixed clocks and seeded data (`prisma/seed`).
- Integration tests spin real Postgres/Redis via `docker-compose`; each test isolates its data (transaction rollback or unique keys).
- No external vendor calls — adapters (payment/SMS/maps/storage) are mocked at the interface (ADR-0007).

## 4. Coverage

- Coverage is a signal, not a target to game. **Services and critical flows must be covered**; trivial getters need not be.
- A PR that adds business logic without tests does not merge.

## 5. Running

```bash
npm test                 # unit
npm run test:integration # integration (needs docker-compose up)
npm run test:e2e         # full core loop
```

CI runs all layers on every PR; a red suite blocks merge ([Git Workflow](./GIT_WORKFLOW.md)).

## 6. Test data & safety

- Never test against production or real user data.
- Seed data is deterministic and lives in `prisma/seed`.
- Fixtures for money use exact decimals; assert to the cent.
