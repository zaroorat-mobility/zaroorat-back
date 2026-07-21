# ADR-0007: Provider abstraction for payments/maps/SMS/storage

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** Architecture, Engineering
- **Related:** HLD §11 (ADR-7) · BR-11 · Architecture Reference §6

## Context
The platform depends on external vendors — payment gateway, maps/routing, SMS/OTP, object storage, push. These differ by market and change over time. If modules import vendor SDKs directly, swapping a provider (or supporting a second market) becomes a cross-cutting rewrite.

## Decision
We will place every third-party vendor **behind an interface** defined in `config/*` (`payment.ts`, `maps.ts`, `sms.ts`, `storage.ts`) with implementations in `integrations/`. **No module imports a vendor SDK directly.** Swapping a provider must be a one-adapter change.

## Consequences
- **Positive:** vendors are swappable per market or on cost/quality grounds; modules depend on stable interfaces; easier to mock in tests; supports multi-market expansion (BR-11).
- **Negative / trade-offs:** an abstraction layer to maintain; the interface must be the lowest common denominator or expose capability flags.
- **Follow-ups:** define each interface's contract before its module is built; capture provider choice in a follow-up ADR (payments/maps/SMS remain open — see PRD §5).

## Alternatives considered
- **Direct SDK use in modules** — rejected: couples domain logic to a vendor; painful to swap or multi-market.
- **A generic third-party gateway service** — rejected: over-engineered for current scale.
