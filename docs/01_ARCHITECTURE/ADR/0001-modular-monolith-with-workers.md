# ADR-0001: Modular monolith with detachable workers

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** Architecture, Engineering
- **Related:** HLD §1, §3 · Phase 0 §4

## Context
Ride-hailing's core loop — matching, dispatch, ride state, pricing, geo — is tightly coupled and latency-sensitive. We must scale async work (payments, notifications, dispatch timeouts) independently, but we are a small team optimizing for time-to-market and operability. Options were: (a) microservices from day one, (b) a single monolith, (c) a modular monolith with separate worker processes sharing the codebase.

## Decision
We will build a **modular monolith**: one API codebase decomposed into bounded-context modules with boundaries enforced in code, plus **separate worker process(es)** (`Dockerfile.worker`) that share the same code and database for async/scheduled work.

## Consequences
- **Positive:** the coupled core loop stays fast and transactional (no network hops); async work scales independently; clean module boundaries let us extract a service later *if it earns it*.
- **Negative / trade-offs:** boundary discipline must be enforced by convention + review (not the network); the whole API deploys as one unit.
- **Follow-ups:** enforce module isolation (import only via `index.ts`), one-writer-per-table.

## Alternatives considered
- **Microservices now** — rejected: distributed transactions, latency, and ops cost with no early benefit for a coupled domain.
- **Plain monolith (no workers)** — rejected: request path would carry timeouts and slow external calls; a crash could orphan trips.
