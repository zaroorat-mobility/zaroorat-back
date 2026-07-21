# Architecture Decision Records (ADRs)

An **ADR** captures one architecturally significant decision: the context that forced it, the decision made, and the consequences we accept. ADRs are short, immutable once accepted, and superseded (never edited) when a decision changes.

## Rules

1. **One decision per file.** Name: `NNNN-kebab-title.md` (e.g. `0005-bullmq-workers-own-timing.md`).
2. **Immutable once `Accepted`.** To change a decision, write a new ADR that supersedes the old one; mark the old one `Superseded by ADR-NNNN`.
3. **Status:** `Proposed` → `Accepted` → (`Superseded` / `Deprecated`).
4. **Keep it short** — context, decision, consequences. Link to HLD/LLD for detail.
5. An ADR lands in the **same PR** as the change it justifies.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-modular-monolith-with-workers.md) | Modular monolith with detachable workers | 🟢 Accepted |
| [0002](./0002-fastify-http-framework.md) | Fastify as the HTTP framework | 🟢 Accepted |
| [0003](./0003-postgres-prisma-source-of-truth.md) | PostgreSQL + Prisma as the source of truth | 🟢 Accepted |
| [0004](./0004-redis-roles-not-source-of-truth.md) | Redis for cache/queues/pubsub/geo, never source of truth | 🟢 Accepted |
| [0005](./0005-bullmq-workers-own-timing.md) | BullMQ workers own all timing & async | 🟢 Accepted |
| [0006](./0006-socketio-redis-adapter-realtime.md) | Socket.io + Redis adapter for realtime | 🟢 Accepted |
| [0007](./0007-provider-abstraction-integrations.md) | Provider abstraction for payments/maps/SMS/storage | 🟢 Accepted |
| [0008](./0008-idempotency-on-money-writes.md) | Idempotency on all money/critical writes | 🟢 Accepted |

### Open decisions awaiting an ADR 🔴
These are flagged in the [PRD §5](../../00_PROJECT/FEATURE_CATALOG.md) and [Phase 0 appendix](../../phase-0-project-planning.md). Write the ADR before building the module.

- Payment gateway choice, capture timing, payout schedule → before `payments`
- Maps/geo provider & PostGIS vs. Redis geo → before `geo`
- OTP/SMS provider & anti-fraud policy → before `auth`
- Surge pricing model (algorithmic vs. zone) → before `pricing`
- Data retention & PII policy → before `documents`
- Cancellation-fee policy → before `dispatch`

## Template

Copy [`_template.md`](./_template.md) to start a new ADR.
