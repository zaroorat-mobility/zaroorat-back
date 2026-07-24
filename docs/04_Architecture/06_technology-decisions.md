# Technology Decisions

**Owner:** Architecture · **Last reviewed:** 2026-07-06

The stack, and the _why_ behind each choice. A technology is only in the system because it earns
its place against a real requirement. Significant/expensive-to-reverse choices are captured as
ADRs (in [`00_Project/adr/`](../00_Project/adr/)); this page is the consolidated rationale.

---

## The stack at a glance

| Layer                    | Choice                           | Primary reason                                                                           |
| ------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Backend language         | **Python 3.12**                  | Team fluency, ecosystem, async maturity                                                  |
| Backend framework        | **FastAPI**                      | Async-first, Pydantic validation, auto OpenAPI                                           |
| Async runtime            | **ASGI (uvicorn)**               | Non-blocking I/O for realtime + high concurrency                                         |
| ORM                      | **SQLAlchemy 2.x (async)**       | Mature, typed, migration story via Alembic                                               |
| Validation/serialization | **Pydantic v2**                  | One model = contract + validation; fast                                                  |
| Primary DB               | **PostgreSQL 16**                | ACID system of record; rich features                                                     |
| Geospatial               | **PostGIS**                      | Zones/polygons, spatial indexing ([ADR-0003](../00_Project/adr/0003-postgis-for-geo.md)) |
| Cache/geo/queue/bus      | **Redis 7**                      | Live geo, pub/sub, queues, rate limits, idempotency                                      |
| Realtime                 | **WebSockets + Redis pub/sub**   | Live location/offers, horizontally scalable                                              |
| Mobile                   | **Expo / React Native (TS)**     | One codebase for rider+driver, OTA updates, native access                                |
| Admin                    | **React + Vite + Tailwind (TS)** | Fast SPA, component reuse with mobile via `ui-kit`                                       |
| Contracts                | **OpenAPI + generated clients**  | Single source of truth, no hand-written API types                                        |
| Containerization         | **Docker**                       | Env parity ([V1](../00_Project/06_docker-setup.md))                                      |
| Orchestration            | **Kubernetes**                   | Autoscaling stateless tiers, rolling deploys                                             |
| Edge                     | **Nginx**                        | TLS, routing REST/WSS, edge rate limiting                                                |
| CI/CD                    | **GitHub Actions**               | Repo-native, path-scoped pipelines                                                       |

---

## Why FastAPI (backend framework)

A ride-hailing backend is **I/O-bound and concurrency-heavy** (many simultaneous location pings,
offers, DB/Redis calls). We need:

- **Async-first** — FastAPI on ASGI handles thousands of concurrent connections without a thread
  per request. Critical for realtime + the connection volume of a live marketplace.
- **Validation as contract** — Pydantic v2 models _are_ the request/response schema and the
  validation, in one place, and auto-generate **OpenAPI** → which generates the TS clients
  (no drift, Volume 1 rule).
- **Typed + fast** — good editor/mypy support; performance competitive with Node/Go for our shape.

Rejected: Django (sync-first, heavier for an API-only service), Node/Nest (team is stronger in
Python; Pydantic/OpenAPI ergonomics preferred), Go (raw performance edge not worth the slower
delivery for a small team at this stage).

## Why PostgreSQL + PostGIS + Redis (not one, not many)

Covered in depth by [ADR-0003](../00_Project/adr/0003-postgis-for-geo.md) and
[04_data-and-state.md](04_data-and-state.md). Summary: **Postgres for durable/transactional truth
(incl. geo polygons), Redis for the hot ephemeral path (live locations, pub/sub, queues).** Two
stores with a crisp responsibility split beats one store doing everything badly, and beats many
stores adding operational surface.

## Why Expo / React Native (mobile)

- **One codebase, two apps** — rider and driver share components, navigation, and the generated
  API client (via `packages/ui-kit` and `api-contracts`).
- **OTA updates** — push JS fixes without a full app-store cycle. Valuable for a fast-iterating
  launch and for reaching users on flaky update paths.
- **Native access when needed** — background location, push, maps via Expo's native modules.
- **Mid-range Android reach** — the launch-market baseline device (NFR-USE-03).

Rejected: fully native (2× the code and team for launch), Flutter (team is TS/React; sharing code
with the React admin via a shared kit is a real advantage).

## Why a modular monolith (not microservices)

Full rationale in [ADR-0004](../00_Project/adr/0004-modular-monolith.md) and
[02_component-architecture.md](02_component-architecture.md). Short version: at a small team size,
a modular monolith gives us **transactional integrity for money**, **fast delivery**, and **low
ops overhead**, while enforced module boundaries keep the door open to extract hot modules
(matching, realtime) into services when scale — not speculation — demands it.

---

## Decisions deliberately deferred

We are **not** deciding these yet; committing early would be guessing. Each becomes an ADR when a
real requirement forces it:

| Deferred                                    | Trigger to decide                                     |
| ------------------------------------------- | ----------------------------------------------------- |
| Payment/UPI gateway (Razorpay/PhonePe/etc.) | M2/M4 — when wallet→UPI is scoped                     |
| SMS provider(s) for Kashmir                 | M0 — reliability testing in-region (PRD Q1)           |
| Maps/routing provider                       | M1 — coverage validation in-region (PRD Q2)           |
| Extracting matching/realtime into a service | When a module's scale or team boundary justifies it   |
| Analytics/warehouse stack                   | Volume 17, when reporting needs exceed operational DB |
| Search/feature-store, ML matching           | Post-MVP; rules-based matching first (Volume 5)       |

---

## Reversibility scorecard

We prefer choices that are **cheap to reverse** where the future is uncertain, and accept lock-in
only where the benefit is large and stable.

| Choice           | Reversibility    | Note                                                    |
| ---------------- | ---------------- | ------------------------------------------------------- |
| FastAPI          | Medium           | Contained behind our module layering                    |
| Postgres         | Low (deliberate) | System of record; a considered long-term bet            |
| Redis usage      | Medium           | Behind repository/client abstractions                   |
| Expo/RN          | Medium           | UX code is portable; native modules are the sticky part |
| Modular monolith | **High**         | The whole point — extract modules later cheaply         |
| K8s              | Medium           | Standard manifests; portable across providers           |
