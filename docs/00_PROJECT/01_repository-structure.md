# Repository Structure

**Owner:** Engineering · **Last reviewed:** 2026-07-06

Zaroorat Ride is a **monorepo**. One repository holds every deployable app, the shared code
between them, and the infrastructure that runs them. We chose a monorepo (see
[`adr/0001-monorepo.md`](adr/0001-monorepo.md)) because a ride-hailing platform shares
contracts constantly — an API change on the backend must land atomically with the mobile and
admin clients that consume it. Separate repos make that a multi-PR coordination problem;
a monorepo makes it one atomic PR.

---

## Top-level layout

```
zaroorat-ride/
├── README.md                  # Handbook root (you are in the docs tree now)
├── 00_Project/ … 15_Security/ # The engineering handbook (this documentation)
│
├── apps/                      # Deployable applications
│   ├── backend/               #   FastAPI service (the API + realtime + workers)
│   ├── mobile/                #   Expo / React Native (rider + driver)
│   └── admin/                 #   React + Vite dashboard
│
├── packages/                  # Shared, versioned code used by >1 app
│   ├── api-contracts/         #   OpenAPI spec + generated TS/py clients & types
│   ├── ui-kit/                #   Shared RN/React components & design tokens
│   └── eslint-config/         #   Shared lint/tsconfig presets
│
├── infra/                     # Everything that runs the software
│   ├── docker/                #   Dockerfiles + docker-compose.*.yml
│   ├── k8s/                   #   Kubernetes manifests / Helm charts
│   ├── nginx/                 #   Reverse proxy config
│   └── terraform/             #   Cloud infrastructure as code
│
├── scripts/                   # Dev & CI helper scripts (setup, seed, migrate)
├── .github/                   # CI/CD workflows, PR/issue templates, CODEOWNERS
├── .env.example               # Template for local environment variables
└── Makefile                   # Canonical entry points: make up / test / lint / fmt
```

> **Rule:** if a piece of code is used by more than one app, it belongs in `packages/`,
> never copy-pasted. If it's used by one app, it stays inside that app.

---

## Inside `apps/backend/` (FastAPI)

We organize the backend by **domain module**, not by technical layer. All the code for
"wallet" lives under `wallet/`, rather than being scattered across global `models/`,
`routers/`, `services/` folders. This keeps a feature's blast radius small and makes
ownership obvious. Full rationale in Volume 10.

```
apps/backend/
├── pyproject.toml             # Deps (managed by uv/poetry), Ruff & mypy config
├── alembic/                   # Database migrations (versioned SQL history)
├── src/zaroorat/
│   ├── main.py                # FastAPI app factory & startup/shutdown
│   ├── core/                  # Cross-cutting: config, logging, security, deps
│   │   ├── config.py          #   Pydantic Settings (reads env)
│   │   ├── db.py              #   Engine, session, base
│   │   ├── redis.py          #   Redis client & pools
│   │   └── security.py       #   JWT, password hashing, auth deps
│   ├── modules/               # ← the domains (one folder each)
│   │   ├── auth/
│   │   ├── users/
│   │   ├── drivers/
│   │   ├── vehicles/
│   │   ├── rides/            #   request + matching + trip lifecycle
│   │   ├── pricing/
│   │   ├── wallet/
│   │   ├── payments/
│   │   ├── notifications/
│   │   ├── chat/
│   │   └── admin/
│   └── shared/                # Base schemas, pagination, errors, enums
├── tests/                     # Mirrors src/ structure
└── Dockerfile
```

Each `modules/<domain>/` folder follows the **same internal shape**:

```
modules/rides/
├── router.py      # HTTP/WebSocket endpoints (thin — no business logic here)
├── service.py     # Business logic / use cases
├── repository.py  # Data access (SQLAlchemy queries) — the only layer that touches the DB
├── models.py      # SQLAlchemy ORM models (DB tables)
├── schemas.py     # Pydantic request/response models (the API contract)
├── events.py      # Domain events published to Redis (e.g. ride.matched)
└── exceptions.py  # Domain-specific errors
```

The dependency direction is strict and one-way:
`router → service → repository → database`. A router never queries the DB directly; a
repository never imports a router. This is enforced in review and, where possible, by
import-linter rules in CI.

---

## Inside `apps/mobile/` (Expo)

```
apps/mobile/
├── app.json / app.config.ts   # Expo config (env-driven)
├── app/                       # Expo Router — file-based routes (screens)
│   ├── (auth)/                #   Login/OTP stack
│   ├── (rider)/               #   Rider tab navigator
│   └── (driver)/              #   Driver tab navigator
├── src/
│   ├── features/              # Feature-sliced (rides, wallet, profile…)
│   ├── components/            # Shared UI (or imported from packages/ui-kit)
│   ├── api/                   # Generated client from packages/api-contracts
│   ├── store/                 # State management (Zustand + React Query)
│   ├── hooks/                 # Reusable hooks
│   └── lib/                   # Maps, location, push, storage adapters
└── assets/
```

Full mobile architecture is Volume 7.

---

## Inside `apps/admin/` (React + Vite)

```
apps/admin/
├── vite.config.ts
├── index.html
└── src/
    ├── routes/                # Route-based pages
    ├── features/              # rides, drivers, finance, reports…
    ├── components/            # Shared UI + design system
    ├── api/                   # Generated client
    ├── store/                 # React Query + minimal global state
    └── lib/                   # rbac, formatting, charts
```

Full admin architecture is Volume 8.

---

## Where does my code go? — a decision table

| I'm writing…                              | It goes in…                                            |
| ----------------------------------------- | ------------------------------------------------------ |
| A new API endpoint                        | `apps/backend/src/zaroorat/modules/<domain>/router.py` |
| Business logic for that endpoint          | `…/<domain>/service.py`                                |
| A new DB table                            | `…/<domain>/models.py` + an Alembic migration          |
| A request/response shape                  | `…/<domain>/schemas.py`                                |
| A new mobile screen                       | `apps/mobile/app/…` (route) + `src/features/`          |
| A component used by both mobile and admin | `packages/ui-kit/`                                     |
| A change to the API contract              | `packages/api-contracts/` (regenerate clients)         |
| A Docker/K8s/Nginx change                 | `infra/`                                               |
| A one-off dev helper                      | `scripts/`                                             |

---

## Anti-patterns we reject

- ❌ **Layer-first backend folders** (`models/`, `services/`, `routers/` at the top level).
  They force you to touch four distant folders to add one feature.
- ❌ **Business logic in routers.** Routers parse input, call a service, format output. Nothing else.
- ❌ **Direct DB access from services.** Go through the repository so queries are testable and swappable.
- ❌ **Copy-pasted shared code.** Promote it to `packages/`.
- ❌ **Deep relative imports** (`../../../../core/db`). Use the package root import path.
