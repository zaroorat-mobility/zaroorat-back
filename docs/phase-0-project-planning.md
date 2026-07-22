# Phase 0 — Project Planning

> **Status:** Foundational. Read this before writing a line of code.
> **Owner:** Backend Engineering
> **Last updated:** 2026-07-20

The goal of Phase 0 is a single one: **everyone understands what we are building, why, and the rules we build it under — before the first migration is written.** Every decision below is a commitment. Changing one later is expensive, so we spend the cheap hours here.

---

## 1. Project Vision

**Zaroorat is a ride-hailing and mobility platform** connecting riders who need a trip with drivers who can provide it, in real time.

The name _Zaroorat_ ("necessity") is the product thesis: transport is not a luxury, it is a daily need. We win by being **reliable, safe, and fairly priced** in markets where existing options are expensive, unsafe, or unavailable.

**What the backend must be:**

- **Real-time first.** A rider requesting a ride, a driver's location on a map, a trip's state, and a chat message are all live. Latency and correctness of state are the product.
- **Trustworthy with money.** Fares, payouts, promotions, and refunds must be exactly right, auditable, and idempotent. A double charge is worse than a slow response.
- **Safe by design.** SOS, trip sharing, document verification, and ride history are safety features, not add-ons.
- **Operable at 3 a.m.** The team can observe, debug, and recover the system under load without heroics.

**North-star outcome:** A rider opens the app, is matched to a nearby verified driver in seconds, sees the car approach live, completes the trip, is charged the exact quoted fare, and both parties can rate each other and get help if something goes wrong.

**Explicit non-goals (for now):**

- Not a food-delivery or logistics marketplace (the module boundaries leave room, but it is not the mission).
- Not a multi-tenant white-label SaaS. One brand, one platform.
- No native mobile code lives here — this repo is the **backend and real-time services** only.

---

## 2. Business Requirements

### 2.1 Actors

| Actor                | Description                                                                      |
| -------------------- | -------------------------------------------------------------------------------- |
| **Rider**            | Requests, takes, pays for, and rates trips.                                      |
| **Driver**           | Onboards, gets verified, goes online, accepts trips, drives, gets paid.          |
| **Admin / Ops**      | Verifies documents, manages fares/promos, resolves disputes, monitors the fleet. |
| **Support agent**    | Handles tickets, trip issues, and SOS follow-up.                                 |
| **System (workers)** | Async actors: dispatch timeouts, payment capture, notifications, cleanup.        |

### 2.2 Core business rules (non-negotiable invariants)

These are the rules the code must enforce everywhere, not just in the happy path.

1. **A driver can be assigned to at most one active trip at a time.**
2. **A trip's state only moves forward** through its lifecycle; illegal transitions are rejected, not silently ignored.
3. **The fare quoted at request time is honored** unless a rider-visible event (waiting time, route change, tolls) legitimately changes it — and every change is recorded.
4. **Money operations are idempotent.** Retrying a charge, payout, or refund never doubles it.
5. **Only verified drivers with a valid, non-expired document set and an approved vehicle can go online.**
6. **Location and trip data are private.** A user sees only their own trips; ops access is role-gated and audited.
7. **SOS is always available during an active trip** and cannot be blocked by rate limits or feature flags.

### 2.3 Success metrics

- **Match rate** — % of ride requests matched to a driver.
- **Time-to-match** — p50 / p95 seconds from request to acceptance.
- **Trip completion rate** — completed ÷ accepted.
- **Payment success rate** and **fare dispute rate**.
- **API availability** and **p95 latency** per critical endpoint.

### 2.4 Constraints & assumptions

- **Regulatory:** driver/vehicle document verification and retention are legally required; PII must be protected.
- **Payments:** at least one local gateway plus cash; the platform must reconcile both.
- **Connectivity:** riders and drivers are on mobile networks with variable quality — the API and socket layer must tolerate reconnects and duplicate messages.
- **Geography:** single-country launch first; currency, language, and pricing must not be hard-coded to make later expansion painful.

---

## 3. Features (scoped to the module map)

The domain is already decomposed into 23 modules under `src/modules`. Each is an owned bounded context. This is the authoritative feature list.

### Identity & accounts

- **`auth`** — phone/OTP login, sessions, JWT issuance & refresh, role assignment.
- **`users`** — the shared account record; profile, status, role membership.
- **`riders`** — rider profile, saved places, payment preferences, trip history view.
- **`drivers`** — driver profile, online/offline state, earnings summary, availability.

### Driver supply & compliance

- **`onboarding`** — the driver signup funnel and verification state machine.
- **`documents`** — upload, review, expiry tracking of licenses, CNIC, insurance, etc.
- **`vehicles`** — vehicle registration, category (bike/car/etc.), approval status.

### The trip (the core loop)

- **`rides`** — the trip aggregate and its lifecycle state machine (the heart of the system).
- **`dispatch`** — offering a request to drivers, accept/decline, timeouts, re-offer.
- **`matching`** — selecting candidate drivers for a request (proximity, category, ETA, fairness).
- **`geo`** — location ingestion, live driver positions, geospatial queries, ETA/distance.
- **`pricing`** — fare estimation and finalization, surge, per-category rates, tolls/waiting.

### Money

- **`payments`** — charges, cash reconciliation, driver payouts, refunds, wallet/ledger.
- **`promotions`** — promo codes, discounts, referral credits, campaign rules.

### Engagement & safety

- **`notifications`** — push / SMS / in-app, templated and async.
- **`chat`** — rider↔driver in-trip messaging.
- **`sos`** — emergency trigger, trip sharing, alert escalation.
- **`reviews`** — bidirectional ratings and feedback.
- **`support`** — tickets, trip disputes, agent workflows.

### Platform & operations

- **`admin`** — ops/back-office operations across all domains.
- **`analytics`** — metrics, reporting, and event aggregation.
- **`settings`** — platform configuration, feature flags, service areas, fare config.
- **`files`** — object storage abstraction (uploads, signed URLs) used by `documents` and others.

### Feature phasing (build order, not scope order)

- **MVP (must ship the core loop):** `auth`, `users`, `riders`, `drivers`, `vehicles`, `onboarding`, `documents`, `geo`, `matching`, `dispatch`, `rides`, `pricing`, `payments` (cash first), `notifications`, `files`, `settings`.
- **Fast-follow:** `chat`, `reviews`, `sos`, `promotions`, card `payments`.
- **Operate & scale:** `support`, `admin`, `analytics`.

Modules may exist as empty scaffolds before their phase; that is intentional and keeps boundaries stable.

---

## 4. Architecture

### 4.1 Shape

A **modular monolith with detachable async workers**, not microservices. One deployable API process plus separate worker process(es) that share the same codebase and database. This gives us clean module boundaries _and_ independent scaling of async work, without the operational cost of a service mesh on day one.

```
                     ┌─────────────────────────────────────┐
   Mobile / Web ───► │  API process (Fastify)              │
   (REST + WS)       │  - HTTP routes per module           │
                     │  - Socket.io gateway (live trip/geo)│
                     │  - plugins: jwt, prisma, redis, ... │
                     └───────┬───────────────┬─────────────┘
                             │               │
                       ┌─────▼─────┐   ┌──────▼──────┐
                       │ PostgreSQL │   │    Redis     │
                       │  (Prisma)  │   │ cache/pubsub │
                       │            │   │ queues/geo   │
                       └─────▲─────┘   └──────▲──────┘
                             │               │
                     ┌───────┴───────────────┴─────────────┐
                     │  Worker process(es) (BullMQ)         │
                     │  rides · payments · notifications ·  │
                     │  cleanup                             │
                     └─────────────────────────────────────┘
```

### 4.2 Key architectural decisions (ADR-lite)

- **Modular monolith over microservices.** Boundaries are enforced in code (module isolation), not by the network. We can extract a service later if a module genuinely needs it; we do not pay that tax upfront.
- **Fastify** as the HTTP framework — schema-first (JSON Schema), fast, first-class plugin encapsulation, native Swagger generation.
- **Prisma + PostgreSQL** as the system of record. Postgres also gives us geospatial capability. All money and trip state lives here; it is the source of truth.
- **Redis** is multi-purpose: caching, BullMQ queue backing, Socket.io pub/sub adapter (for horizontal scale), rate-limit counters, and hot geo/driver-presence data. Redis is **never** the source of truth for money or trip state.
- **Socket.io** for the real-time layer (driver locations, trip state pushes, chat). Backed by the Redis adapter so multiple API instances share rooms.
- **BullMQ workers** for everything that must not block a request or must survive a crash: payment capture/payout, dispatch timeouts, notification fan-out, and periodic cleanup. Workers run from `Dockerfile.worker`, separate from the API.
- **Idempotency middleware** (`src/middleware/idempotency.ts`) guards all money-mutating and non-idempotent POSTs via client-supplied keys.
- **Request-scoped context** — every request carries a `request-id` for tracing across the API, workers, and logs.

### 4.3 The trip lifecycle (the spine of the system)

Everything in the core loop is a state machine. The canonical, minimal states:

```
REQUESTED → MATCHING → DRIVER_ASSIGNED → ARRIVING → ARRIVED
   → IN_PROGRESS → COMPLETED → PAID
   (any pre-progress state) → CANCELLED / NO_DRIVERS
```

- Transitions are **explicit and validated** in `rides`; other modules request transitions, they do not mutate trip state directly.
- Each transition emits a domain event that `dispatch`, `payments`, `notifications`, and `analytics` react to.
- Timeouts (no driver accepts, driver doesn't arrive) are driven by **workers**, not by hoping a client fires an event.

### 4.4 Cross-cutting concerns

- **AuthN/AuthZ:** JWT via the `jwt` plugin; `middleware/auth.ts` authenticates, `middleware/role.ts` authorizes by role. Deny by default.
- **Validation:** request/response JSON Schemas at the route boundary — invalid data never reaches a service.
- **Error handling:** one central error handler (`middleware/error.ts`) maps domain errors → consistent HTTP responses; no leaking stack traces.
- **Observability:** structured logging (`config/logger.ts`), the `observability/` stack, request IDs correlate API ↔ worker.
- **Config:** all runtime config is validated at boot against `config/env.schema.ts`; the app refuses to start with an invalid environment.
- **Graceful lifecycle:** `app/bootstrap.ts` → `app/server.ts`, and `app/shutdown.ts` drains connections and closes DB/Redis/queues cleanly.

---

## 5. Tech Stack

Inferred from the scaffold and committed to here.

| Layer                   | Choice                              | Why                                                                        |
| ----------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| Language                | **TypeScript** (strict)             | Type safety across a large domain; shared types between API and workers.   |
| Runtime                 | **Node.js**                         | Ecosystem fit for Fastify/Prisma/BullMQ/Socket.io.                         |
| HTTP framework          | **Fastify**                         | Schema-first, fast, plugin encapsulation, native Swagger.                  |
| Real-time               | **Socket.io** (+ Redis adapter)     | Rooms, reconnection, horizontal scale.                                     |
| ORM / DB                | **Prisma + PostgreSQL**             | Type-safe queries, migrations, geospatial, transactional integrity.        |
| Cache / queues / pubsub | **Redis**                           | Cache, BullMQ backing, socket adapter, rate limiting, geo/presence.        |
| Background jobs         | **BullMQ**                          | Reliable, retryable, scheduled async work on Redis.                        |
| Auth                    | **JWT**                             | Stateless auth for mobile clients; refresh flow in `auth`.                 |
| API docs                | **Swagger / OpenAPI**               | Generated from route schemas; contract for the mobile team.                |
| Integrations            | SMS, payments, maps, storage        | Abstracted behind `config/*` + `integrations/` so providers are swappable. |
| Containerization        | **Docker + docker-compose**         | Reproducible local + prod parity; separate API and worker images.          |
| Quality gates           | **ESLint + Prettier + Husky**       | Enforced style and pre-commit checks.                                      |
| Infra / observability   | `infrastructure/`, `observability/` | IaC and metrics/logs/traces as first-class.                                |

**Provider abstraction rule:** SMS, payment gateway, maps, and object storage are **behind interfaces** (`config/sms.ts`, `config/payment.ts`, `config/maps.ts`, `config/storage.ts` + `integrations/`). No module imports a vendor SDK directly. Swapping a provider must be a one-file change.

---

## 6. Folder Structure

The layout is already established. This is the contract for where things live.

```
backend_zaroorat/
├── src/
│   ├── app/              # boot, server wiring, graceful shutdown
│   │   ├── app.ts        # build the Fastify instance (register plugins/routes)
│   │   ├── bootstrap.ts  # load & validate config, init connections
│   │   ├── server.ts     # start listening
│   │   └── shutdown.ts   # drain & close on SIGTERM
│   ├── config/           # validated config + provider adapters
│   │   ├── env.schema.ts # single source of truth for env vars
│   │   ├── database.ts · redis.ts · logger.ts
│   │   └── payment.ts · storage.ts · sms.ts · maps.ts
│   ├── plugins/          # Fastify plugins (encapsulated capabilities)
│   │   ├── prisma · jwt · redis · socket
│   │   └── helmet · cors · rate-limit · swagger
│   ├── middleware/       # auth, role, error, request-id, idempotency
│   ├── routes/           # route registration (index.ts wires modules)
│   ├── modules/          # ★ the domain — one folder per bounded context
│   │   └── <module>/     # (auth, rides, payments, ... 23 total)
│   │       ├── index.ts  # public surface of the module
│   │       └── README.md # what this module owns
│   ├── workers/          # BullMQ processors (run as a separate process)
│   │   └── rides · payments · notifications · cleanup .worker.ts
│   ├── integrations/     # third-party clients (behind config interfaces)
│   ├── core/             # framework-agnostic building blocks (errors, base types, utils)
│   └── shared/           # cross-module shared types/helpers (no domain logic)
├── prisma/
│   ├── schema.prisma     # data model — the DB source of truth
│   ├── migrations/       # versioned, committed, never edited by hand
│   └── seed/             # deterministic seed data
├── tests/                # unit + integration tests
├── docker/ · Dockerfile · Dockerfile.worker · docker-compose.yml
├── infrastructure/       # IaC
├── observability/        # logging/metrics/tracing config
├── scripts/ · Makefile   # dev & ops commands
└── docs/                 # this document lives here
```

### Module internal convention

Each module in `src/modules/<name>` should, as it is implemented, follow a consistent internal shape so any engineer can navigate an unfamiliar module instantly:

```
modules/rides/
├── index.ts          # public exports only — the module's API to the rest of the app
├── rides.routes.ts   # HTTP routes + JSON schemas
├── rides.controller.ts   # HTTP ↔ service translation, no business logic
├── rides.service.ts  # business logic & invariants (the real work)
├── rides.repository.ts   # Prisma data access (the only place that touches the DB for this domain)
├── rides.events.ts   # domain events emitted/consumed
├── rides.types.ts    # module-local types
└── README.md
```

**Layering rule:** `routes → controller → service → repository → (Prisma)`. A layer may only call the layer directly below it. Business rules live in **services**; DB access lives in **repositories**. Controllers and routes hold no domain logic.

---

## 7. Development Rules

These are enforced, not aspirational. CI and pre-commit hooks back them up.

### 7.1 Module boundaries

1. **A module is only reachable through its `index.ts`.** No deep-importing another module's internal files.
2. **No cross-module DB writes.** `payments` does not write a `rides` row — it asks `rides` (via its public API or a domain event). One writer per table.
3. **Shared logic goes in `core`/`shared`**, never copied between modules. `shared` holds no domain rules.

### 7.2 Data & migrations

4. **`prisma/schema.prisma` is the single DB source of truth.** All changes go through committed migrations. Never hand-edit a generated migration or the DB directly.
5. **Repositories are the only DB-access layer.** Services never call Prisma directly.
6. **Every migration is reviewed** for indexes, nullability, and backfill impact before merge.

### 7.3 Correctness & safety

7. **Money and trip-state operations run in transactions and are idempotent.** No exceptions.
8. **Validate at the boundary.** Every route has request & response schemas; nothing untrusted reaches a service.
9. **Deny by default.** Every endpoint declares its required auth and role explicitly.
10. **No secrets in code.** All config comes through `config/env.schema.ts`; the app fails fast on a bad env.
11. **State machines are explicit.** Trip/onboarding/document/payment transitions are validated in one place; no ad-hoc status flipping.

### 7.4 Async & real-time

12. **Anything slow, external, or must-survive-a-crash goes to a worker**, not into the request path.
13. **Assume duplicate delivery.** Socket messages and queue jobs must be safe to process more than once.
14. **Emit domain events for side effects.** `notifications`, `analytics`, and `payments` react to events; they are not called inline from unrelated services.

### 7.5 Quality

15. **Every module change ships with tests.** Services (business rules) require unit tests; critical flows require integration tests.
16. **Lint & format are non-negotiable.** ESLint + Prettier pass via Husky pre-commit; CI re-checks.
17. **TypeScript strict mode; no `any`** without a written reason.
18. **Errors are typed and centralized.** Throw domain errors; let `middleware/error.ts` shape the response. Never leak internals to clients.
19. **Log with structure and a request ID.** No `console.log`; correlate API ↔ worker via request/trace IDs.

### 7.6 Process

20. **Branch → PR → review → CI green → merge.** No direct pushes to the main branch.
21. **Keep this document current.** If an architectural decision changes, the change lands _with_ the doc update, not after.

---

## Appendix — Open decisions to resolve before Phase 1

These are known unknowns to nail down before implementation, so they don't become silent assumptions:

- **Payment gateway(s)** and cash-reconciliation model — which provider, capture timing, payout schedule.
- **Maps/geo provider** — routing/ETA source, and whether we use PostGIS or Redis geo (or both) for proximity queries.
- **OTP/SMS provider** and OTP rate-limiting / anti-fraud policy.
- **Surge pricing policy** — algorithmic vs. zone-based, and rider transparency rules.
- **Data retention & PII** — how long documents and trip location traces are kept, per regulation.
- **Multi-language / multi-currency** boundaries — what must be configurable now vs. later.

Resolve each with a short ADR in `docs/` before the corresponding module is built.
