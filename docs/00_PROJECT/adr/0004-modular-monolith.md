# ADR-0004: Modular monolith backend (not microservices at launch)

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Engineering

## Context

The backend spans many domains (auth, rides, matching, pricing, wallet, payments, notifications,
admin). We must choose a decomposition. Microservices offer independent scaling and team autonomy
but impose distributed-systems cost: network calls, distributed transactions, per-service infra,
and operational overhead. At launch we are a small team, money correctness is critical (a trip
settlement spans trip + wallet + ledger), and time-to-market matters.

## Decision

We will build a **modular monolith**: a single deployable FastAPI service internally divided into
**domain modules with strictly enforced boundaries** (see
[component architecture](../../04_Architecture/02_component-architecture.md)). Modules communicate
only through (a) other modules' **service interfaces** in-process, or (b) **domain events** over
Redis pub/sub — never by reaching into another module's repository, models, or tables. Boundaries
are enforced mechanically (import-linter in CI) and by CODEOWNERS.

## Alternatives considered

- **Microservices now.** Independent scaling/teams, but distributed transactions for money
  (sagas), N deployment pipelines, and heavy ops for a small team — premature.
- **Unstructured monolith.** Fast initially, but boundaries rot into a big ball of mud; extraction
  later becomes a rewrite.
- **Modular monolith (chosen).** Single-transaction integrity for money, one deploy, low ops — with
  the discipline of hard module boundaries so extraction stays cheap.

## Consequences

- ✅ Money operations run in a single DB transaction — no distributed-transaction complexity.
- ✅ Fast delivery: one repo, one deploy, one CI pipeline.
- ✅ Low operational overhead at launch.
- ✅ Enforced boundaries make extracting a hot module (matching, realtime) into its own service a
  localized change — because it already only talks via service interface + events.
- ⚠️ Requires **discipline + tooling** (import-linter, CODEOWNERS, review) or boundaries erode.
- ⚠️ The whole backend scales as one unit until a module is extracted — acceptable at launch,
  monitored via per-module metrics so we know _when_ to extract.
- ⚠️ A bug can, in principle, cross module lines in-process; boundary tests mitigate this.
