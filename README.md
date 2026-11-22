# Zaroorat Mobility Backend

[![Node.js Version](https://img.shields.io/badge/node-v22.21.0-339933?logo=node.js&logoColor=white)](.nvmrc)
[![TypeScript](https://img.shields.io/badge/typescript-v5.8-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Fastify](https://img.shields.io/badge/fastify-v5.10-000000?logo=fastify&logoColor=white)](package.json)
[![PostgreSQL / PostGIS](https://img.shields.io/badge/postgis-17--3.5-336791?logo=postgresql&logoColor=white)](docker-compose.yml)
[![Prisma ORM](https://img.shields.io/badge/prisma-v7.9-2D3748?logo=prisma&logoColor=white)](prisma.config.ts)
[![Valkey](https://img.shields.io/badge/valkey-v8.1-CC0000?logo=redis&logoColor=white)](compose.local.yml)
[![Docker](https://img.shields.io/badge/docker-multi--stage-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![License](https://img.shields.io/badge/license-ISC-green)](package.json)

Production-grade real-time ride-hailing backend, pricing calculation engine, intelligent matching dispatcher, and automated driver payout settlement system powering **Zaroorat Mobility**.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Multi-Environment Architecture](#multi-environment-architecture)
- [Quick Start: Local Development](#quick-start-local-development)
  - [Option A: Host-Native Hot Reload (Recommended)](#option-a-host-native-hot-reload-recommended)
  - [Option B: Containerized Local Stack](#option-b-containerized-local-stack)
- [Environment Configuration & Secrets](#environment-configuration--secrets)
- [Database Management & Migrations](#database-management--migrations)
  - [Dual-Role Security Model](#dual-role-security-model)
  - [Running Migrations](#running-migrations)
  - [Database Seeding & Admin Provisioning](#database-seeding--admin-provisioning)
- [Quality Gates & Testing](#quality-gates--testing)
- [Docker & Container Strategy](#docker--container-strategy)
  - [Multi-Stage Build Targets](#multi-stage-build-targets)
  - [Container Security & Health Checks](#container-security--health-checks)
- [Deployment & CI/CD Pipeline](#deployment--cicd-pipeline)
  - [DigitalOcean DEV Deployment Flow](#digitalocean-dev-deployment-flow)
  - [Zero-Downtime Rolling Deploys & Rollback](#zero-downtime-rolling-deploys--rollback)
- [NPM Script Reference](#npm-script-reference)
- [Project Directory Layout](#project-directory-layout)

---

## Architecture Overview

```
                                      [ Internet / Clients ]
                                                │
                                                ▼
                             ┌───────────────────────────────────────┐
                             │       Caddy Reverse Proxy (HTTPS)     │
                             │   TLS Termination / Reverse Proxy     │
                             └──────────────────┬────────────────────┘
                                                │
                                                ▼
                             ┌───────────────────────────────────────┐
                             │    Zaroorat Fastify API (Port 3000)   │
                             │  REST Endpoints + Socket.IO Realtime  │
                             └──────┬─────────────────────────┬──────┘
                                    │                         │
                                    ▼                         ▼
                  ┌───────────────────────────┐   ┌───────────────────────────┐
                  │ PgBouncer Connection Pool │   │   Valkey 8.1 (In-Memory)  │
                  │   Transaction-Level Pool  │   │  Pub/Sub, Caches & BullMQ │
                  └─────────────┬─────────────┘   └─────────────┬─────────────┘
                                │                               │
                                ▼                               ▼
                  ┌───────────────────────────┐   ┌───────────────────────────┐
                  │ PostgreSQL 17 + PostGIS   │   │  Background Queue Worker  │
                  │ Spatial Geospatial Data   │◄──┤  Asynchronous BullMQ Jobs │
                  └───────────────────────────┘   └───────────────────────────┘
```

The system is engineered as a high-throughput, low-latency distributed platform:

- **Fastify 5 Framework**: Highly optimized HTTP server with Awilix dependency injection, strict Zod request validation, and OpenAPI documentation.
- **Socket.IO Real-Time Engine**: Bidirectional geospatial telemetry streaming with Valkey Pub/Sub adapter.
- **BullMQ Distributed Worker**: Asynchronous queue processor handling OTP generation, push notifications, driver document verification, and fiscal invoices.
- **PostgreSQL 17 + PostGIS 3.5**: Geospatial indexing (H3 hexagons and spatial queries) for location-based driver matching and geofenced pricing zones.
- **PgBouncer**: High-performance transaction pooling shielding the PostgreSQL engine from connection starvation during traffic spikes.

---

## Prerequisites

Before starting, ensure you have the following installed on your workstation:

- **Node.js**: `v22.21.0` (matching [.nvmrc](.nvmrc)). We recommend using `nvm` or `fnm`:
  ```bash
  nvm use
  ```
- **npm**: `v10.x` or higher
- **Docker & Docker Compose**: Docker Engine `v26+` / Docker Compose `v2.20+`
- **PostgreSQL Client Tools** (Optional for local CLI access): `psql` v17

---

## Multi-Environment Architecture

The codebase enforces strict, unified naming conventions across code, schemas, and configurations:

| Environment | `APP_ENV` | `NODE_ENV`    | Compose Stack         | Env File       | Database           | Purpose                                                        |
| :---------- | :-------- | :------------ | :-------------------- | :------------- | :----------------- | :------------------------------------------------------------- |
| **LOCAL**   | `local`   | `development` | `compose.local.yml`   | `.env.local`   | `zaroorat_local`   | Workstation development with hot-reload                        |
| **DEV**     | `dev`     | `production`  | `compose.dev.yml`     | `.env.dev`     | `zaroorat_dev`     | Continuous integration & cloud testing on DigitalOcean         |
| **TEST**    | `test`    | `test`        | `compose.test.yml`    | `.env.test`    | `zaroorat_test`    | Ephemeral automated testing (Jest / node:test)                 |
| **STAGING** | `staging` | `production`  | `compose.staging.yml` | `.env.staging` | `zaroorat_staging` | Pre-production staging replica with sandboxed third-parties    |
| **PROD**    | `prod`    | `production`  | `compose.prod.yml`    | `.env.prod`    | `zaroorat_prod`    | High-availability production environment on AWS / DigitalOcean |

> **Environment Loading Rule**: In deployed environments (`dev`, `staging`, `prod`), `src/config/env/loader.ts` bypasses reading `.env` files from disk, as all variables are securely injected by Docker Compose or secret managers. In `local`, it reads `.env.local`. In `test`, it requires `.env.test`.

---

## Quick Start: Local Development

### Option A: Host-Native Hot Reload (Recommended)

This mode runs the Node.js/TypeScript code directly on your workstation with instant file-watching and hot reload via `tsx watch`, while PostgreSQL and Valkey run in lightweight Docker containers.

```bash
# 1. Clone repository and navigate to backend directory
cd zaroorat-back

# 2. Install dependencies (Husky git hooks are auto-configured)
npm install

# 3. Start local infrastructure containers (PostgreSQL + PostGIS & Valkey)
docker compose --env-file .env.local -f compose.local.yml up -d postgres valkey

# 4. Run database migrations and seed default platform roles
npm run migrate:local
npm run seed:local

# 5. (Optional) Provision local super-admin credentials
npm run admin:local

# 6. Start the API server in watch mode (Port 3000)
npm run dev:local        # or: npm run local

# 7. In a separate terminal, start the background BullMQ worker (Port 3001)
npm run worker:local
```

API Server will be live at: [http://localhost:3000](http://localhost:3000)  
Swagger API Documentation: [http://localhost:3000/docs](http://localhost:3000/docs)  
Health Endpoint: [http://localhost:3000/health](http://localhost:3000/health)

---

### Option B: Containerized Local Stack

Run the entire application stack (PostgreSQL, Valkey, Database Migration, API, and Worker) inside Docker with Compose file-watch synchronization:

```bash
# Start all services with automated migrations and live source code sync
npm run docker:local:up

# Tail live application and worker logs
npm run docker:local:logs

# Stop all local containers (preserves database volumes)
npm run docker:local:stop

# Teardown stack and purge database volumes (clean slate)
npm run docker:local:reset
```

---

## Environment Configuration & Secrets

Environment variables are validated on startup using **Zod** (`src/config/env/schema.ts`). Missing or invalid configuration immediately terminates the process with explicit error diagnostics.

- **Local Development**: `.env.local`
- **Committed Environment Blueprints**: Available in [`deploy/env/`](deploy/env/):
  - `deploy/env/.env.dev.example`
  - `deploy/env/.env.staging.example`
  - `deploy/env/.env.prod.example`

### Core Cryptographic Keys (Required in Deployed Environments)

- `JWT_ACCESS_SECRET` & `JWT_REFRESH_SECRET`: Minimum 32-character high-entropy secret keys for HMAC-SHA256 tokens.
- `ENCRYPTION_KEY`: 64-character hex key for symmetric AES-256-GCM encryption of third-party credentials.
- `BANK_DATA_ENCRYPTION_KEY` & `BANK_ACCOUNT_HASH_KEY`: Isolated encryption keys protecting driver bank account numbers.
- `RIDE_PIN_PEPPER`: Standalone 32+ byte secret for hashing 4-digit ride authentication PINs.

---

## Database Management & Migrations

### Dual-Role Security Model

Zaroorat implements a strict privilege-separation architecture for database security:

1. **`zaroorat` (Schema Owner & Migration Role)**:
   - Holds full DDL permissions (`CREATE`, `ALTER`, `DROP`, `REFERENCES`).
   - Used exclusively during CI/CD migration runs via `MIGRATION_DATABASE_URL`.
   - Never exposed to the running application container.
2. **`zaroorat_app` (Runtime Application Role)**:
   - Holds least-privilege DML permissions (`SELECT`, `INSERT`, `UPDATE`, `DELETE`).
   - Explicitly denied DDL execution (`CREATE TABLE`, `DROP TABLE`, `ALTER SCHEMA`).
   - Connects via PgBouncer using `DATABASE_URL`.

### Running Migrations

Laptop commands only ever use LOCAL configuration (`.env.local`). Deployed environments
migrate, seed and provision admins on their own server (see
[docs/DEPLOYMENT/DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT/DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md));
no npm script loads a DEV, staging or production env file.

```bash
# Check / apply migrations on the local database
npm run migrate:status:local
npm run migrate:local

# Generate Prisma Client after schema modifications
npm run prisma:generate
```

### Database Seeding & Admin Provisioning

```bash
# Seed base platform roles, system settings, and default lookup data
npm run seed:local

# Provision a Super-Admin user (ADMIN_EMAIL, ADMIN_PHONE, ADMIN_PASSWORD in the environment)
npm run admin:local
```

---

## Quality Gates & Testing

Before creating a pull request or deploying, ensure all quality gates pass:

```bash
# 1. TypeScript compilation (Project + Tools configs)
npm run typecheck

# 2. ESLint (Zero warnings allowed)
npm run lint

# 3. Prettier formatting check
npm run format:check

# 4. Unit Test Suite (Node.js native test runner with tsx)
npm run test:unit

# 5. Integration Test Suite
npm run test:integration

# 6. Containerized Ephemeral Test Harness (Isolated Postgres + Redis)
npm run docker:test:run
npm run docker:test:down
```

---

## Docker & Container Strategy

### Multi-Stage Build Targets

The project utilizes a single, optimized, multi-stage [`Dockerfile`](Dockerfile) pinned to Debian Trixie Slim:

```
  deps ──┬── local / development  (tsx watch, bind-mounted source sync)
         ├── test                 (Self-contained test execution environment)
         ├── build ── ops         (Prisma CLI, migration status, seeder tools)
         └── build ── prod-deps ── prod / runner (Lean production runtime, non-root)
```

1. **`deps`**: Resolves and installs complete `node_modules` with `npm ci --ignore-scripts`.
2. **`local` / `development`**: Configured for development container hot-reload.
3. **`test`**: Encapsulates test suites for CI pipelines.
4. **`build`**: Compiles TypeScript into JavaScript (`dist/`) and resolves path aliases via `tsc-alias`.
5. **`ops`**: Administrative image containing deployment and migration tools.
6. **`prod-deps`**: Strips devDependencies and rebuilds `@prisma/engines` schema engine binaries.
7. **`prod` / `runner`**: Minimal, hardened production image running under non-root `USER node` (UID 1000) wrapped by `dumb-init`.

### Container Security & Health Checks

- **Read-Only / Least Privilege**: Container runs as unprivileged user `node`.
- **Signal Handling**: `dumb-init` traps `SIGTERM` and `SIGINT`, initiating graceful drainage of active HTTP connections and BullMQ jobs.
- **Native Liveness Probes**:
  ```dockerfile
  HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  ```

---

## Deployment & CI/CD Pipeline

### DigitalOcean DEV Deployment Flow

Continuous deployment to the DEV environment is managed through GitHub Actions ([`.github/workflows/deploy-dev.yml`](.github/workflows/deploy-dev.yml)):

```
  [ push to develop ]
          │
          ▼
  1. CI (format, lint, types, tests, image boot smoke) + Security (gitleaks, npm audit,
     CodeQL, Trivy) — both called from deploy-dev.yml; any failure stops the deploy
          │
          ▼
  2. Build `prod` + `ops` images, push to GHCR as `sha-<commit>` / `sha-<commit>-ops`,
     export both image digests
          │
          ▼
  3. SSH to the droplet (pinned host key, restricted key, forced command):
     `deploy <40-hex commit> <app sha256 digest> <ops sha256 digest>`
          │
          ▼
  4. /usr/local/sbin/zaroorat-deploy (root, via one sudo rule; source: deploy/bin/deploy.sh):
     ├─ validate arguments; commit must be on origin/develop
     ├─ pull both images by digest; image revision label must equal the commit
     ├─ migrate (`run --rm migrate`) → runtime DB login (`run --rm db-roles`)
     ├─ `up -d --no-build --wait --wait-timeout 180 api worker caddy`
     ├─ /ready inside api and worker
     └─ on failure: restore the previous release (digests + matching checkout)
          │
          ▼
  5. Public check: `https://dev-api.zaroorat.com/ready` and `/health` reports `dev`
```

### Manual DEV Deployment

Images are never built on the server or pushed from a workstation. To redeploy, re-run
**Deploy DEV (DigitalOcean)** on `develop` from the GitHub Actions tab. Server-side
operations (`status`, `rollback`) are in
[docs/DEPLOYMENT/DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT/DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md).

---

## NPM Script Reference

| Script                                    | Purpose                                             |
| :---------------------------------------- | :-------------------------------------------------- |
| `npm run dev:local` / `npm run local`     | Start API server in watch mode with `.env.local`    |
| `npm run worker:local`                    | Start BullMQ worker in watch mode with `.env.local` |
| `npm run migrate:local`                   | Run Prisma migrations against local database        |
| `npm run seed:local`                      | Seed default platform roles into local database     |
| `npm run admin:local`                     | Provision super-admin account on local database     |
| `npm run build`                           | Clean `dist/` and compile TypeScript                |
| `npm run typecheck`                       | Run complete TypeScript typechecking without emit   |
| `npm run lint` / `npm run lint:fix`       | Lint codebase with ESLint                           |
| `npm run format` / `npm run format:check` | Format code with Prettier                           |
| `npm run test:unit`                       | Run all unit tests with Node test runner            |
| `npm run test:integration`                | Run integration test suite                          |
| `npm run docker:local:up`                 | Boot full containerized local stack with hot-reload |
| `npm run docker:local:down`               | Stop local container stack (data preserved)         |
| `npm run docker:local:reset`              | Teardown local stack and delete database volumes    |

---

## Project Directory Layout

```
zaroorat-back/
├── .github/
│   └── workflows/              # GitHub Actions CI/CD workflows
├── deploy/
│   ├── bin/                    # Production deployment and rollback shell scripts
│   ├── caddy/                  # Reverse proxy Caddyfile configurations
│   └── env/                    # Environment blueprint templates (.example)
├── docker/
│   └── postgres/init/          # PostgreSQL database & PostGIS extension init scripts
├── docs/                       # Project documentation & architectural runbooks
│   └── DEPLOYMENT/             # Multi-environment audit & migration guides
├── prisma/
│   ├── migrations/             # Timestamped SQL migration history
│   ├── schema/                 # Domain-driven Prisma schema modules
│   └── seed/                   # Database seeders (development, staging, production)
├── scripts/                    # Operational automation, admin creation, and utilities
├── src/
│   ├── app/                    # Fastify application factory & route registration
│   ├── bootstrap/              # Database, Redis, and infrastructure bootstrap loaders
│   ├── config/                 # Environment validation (Zod) and service configurations
│   ├── core/                   # Shared kernel (caching, logging, events, rate limiting)
│   ├── integrations/           # Third-party clients (Airtel SMS, Maps, S3/Spaces)
│   ├── modules/                # Feature modules (auth, drivers, rides, pricing, etc.)
│   ├── plugins/                # Fastify plugins (CORS, Swagger, Awilix DI, Helmet)
│   ├── server.ts               # HTTP API server entry point
│   └── worker.ts               # Asynchronous queue worker entry point
├── tests/
│   ├── integration/            # End-to-end integration test suites
│   └── unit/                   # Fast, isolated unit tests
├── compose.local.yml           # Docker Compose stack for Local development
├── compose.dev.yml             # Docker Compose stack for DigitalOcean DEV
├── compose.staging.yml         # Docker Compose stack for Staging
├── compose.prod.yml            # Docker Compose stack for Production
├── compose.test.yml            # Docker Compose ephemeral test harness
├── Dockerfile                  # Hardened multi-stage container specification
├── Makefile                    # Developer shortcut command wrappers
├── package.json                # Project dependencies, scripts, and engine constraints
└── tsconfig.json               # TypeScript compiler configuration
```

---

## License

Copyright &copy; 2026 Zaroorat Mobility. All rights reserved.  
Licensed under the [ISC License](package.json).
