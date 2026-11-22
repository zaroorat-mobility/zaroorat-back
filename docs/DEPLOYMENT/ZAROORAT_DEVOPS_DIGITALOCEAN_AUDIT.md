# Zaroorat Mobility — DevOps & DigitalOcean DEV Readiness Audit

|              |                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date         | 2026-11-22                                                                                                                                                      |
| Scope        | `zaroorat-back` backend: Docker, Compose, env config, PostgreSQL/PostGIS/PgBouncer, Valkey/BullMQ, deploy scripts, GitHub Actions, Caddy, DigitalOcean DEV plan |
| Code audited | `origin/develop` @ `a91f8a1` (tree identical to local `feat/multi-env-standardization` @ `5fff8f1`)                                                             |
| Mode         | **Read-only.** No repo file changed except this report. Nothing deployed, migrated or reset, and no GitHub setting touched.                                     |
| Supersedes   | The DEV parts of `COMPLETE_ENVIRONMENT_DOCKER_AUDIT.md` (A01–A43) and `FULL_MULTI_ENV_DOCKER_AUDIT.md`, where they differ                                       |

**Evidence labels.**

- `RUNTIME`: reproduced on this machine.
- `GH`: read from GitHub's public API.
- `CODE`: read from source.
- `MEMORY`: verified in an earlier audit, not re-run today.

Runtime checks used a throwaway image (`docker build --target prod`, removed afterwards) and `docker run --rm --network none` containers. They were fed only the placeholder template `deploy/env/.env.dev.example`. No real secret was used or printed.

---

## 1. Executive summary

**Verdict: DEV is NOT deployable today.** Even with a perfectly prepared droplet, the current `develop` cannot produce a running DEV API. Four independent faults stop it, and each was proven:

1. **The API and worker crash on boot in DEV** (`RUNTIME`).
   - The env loader requires a `.env.dev` _file_ when `APP_ENV=dev`.
   - The image contains no env files, and `compose.dev.yml` mounts none.
   - Result: `Error: Environment file ".env.dev" not found`.
2. **Fixing (1) exposes a second boot failure** (`RUNTIME`). `PAYMENT_WEBHOOK_SECRET` is empty in the DEV template and in the local `.env.dev`, but `PAYMENT_DEFAULT_GATEWAY=razorpay` makes it mandatory.
3. **The deploy scripts are not executable in git** (`100644`), so the SSH forced command fails with `Permission denied` (`CODE`).
4. **GitHub's `dev` environment is incomplete** (`GH`). Both deploy runs on `develop` today failed at the SSH step. The latest failure is the workflow's own "DEPLOY_HOST is not set" error.

There is also an **urgent security item that does not wait for DEV:**

- The committed, **public** guide `docs/DEPLOYMENT/DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md` contains the **live DEV Google Maps API key** and the **live DEV AWS access key ID**. It also contains the real Airtel account identifiers.
- `deploy/env/.env.dev.example` also carries the Airtel identifiers.
- These values are on `origin/develop` and `origin/feat/multi-env-standardization`.
- Treat them as harvested. Rotate first, then scrub the files. Deleting the files does not remove them from public history.

**What is already right:**

- Only ports 80/443 are published. PostgreSQL, Valkey and PgBouncer are internal-only.
- The runtime image is non-root (`node`), 208 MB, uses dumb-init, and has no env files baked in (`RUNTIME`).
- The app containers get the infra secrets blanked.
- The runtime DB role is DML-only, and the app refuses to boot as a privileged role in deployed environments.
- BullMQ connections use `maxRetriesPerRequest: null`, and Valkey runs with `noeviction` and AOF.
- Graceful-shutdown budgets fit inside the compose grace periods.
- CI builds and pushes images to GHCR, and the deploy pulls the API image **by digest**.

**Effort to DEV.** About 1 day of repo changes (§15/§D, mostly small diffs) plus about half a day of server setup (§18). The owner must supply credentials (§E) and GitHub settings (§A).

---

## 2. Existing repository structure (deployment-relevant, verified to exist)

| Area                                             | Files                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image                                            | `Dockerfile` (stages `deps`, `local`/`development`, `test`, `build`, `ops`, `prod-deps`, `prod`/`runner`/`production`), `.dockerignore`                                                                                                        |
| Compose                                          | `compose.local.yml`, `compose.dev.yml`, `compose.staging.yml`, `compose.prod.yml`, `compose.test.yml`                                                                                                                                          |
| Env templates (tracked)                          | `.env.example`, `.env.test`, `deploy/env/.env.{dev,staging,prod}.example`, `deploy/env/.env.{dev,staging,prod}.infra.example`                                                                                                                  |
| Env files on this laptop (gitignored, untracked) | `.env.local`, `.env.dev`, `.env.staging`, `.env.prod`. **No `.env.local.example`** on disk or in git, although the loader's error message tells developers to copy it.                                                                         |
| Env code                                         | `src/config/env/{environment,loader,schema,validator,validated-env,index}.ts`, `prisma.config.ts`                                                                                                                                              |
| DB                                               | `prisma/schema/`, `prisma/migrations/` (88 migrations), `scripts/db/create-app-login.sql`, `scripts/db/verify-*.sql`, `docker/postgres/init/*`, `scripts/db-backup.sh`, `scripts/db-restore.sh`, `docker/postgres/scripts/{backup,restore}.sh` |
| Admin                                            | `scripts/create-admin.ts` (+ `tests/integration/create-admin.test.ts`)                                                                                                                                                                         |
| Deploy                                           | `deploy/bin/{deploy,rollback,ssh-entry,status}.sh`, `deploy/caddy/Caddyfile`                                                                                                                                                                   |
| CI/CD                                            | `.github/workflows/{ci,security,prisma-check,deploy-dev,staging,production,release}.yml`, `.gitleaks.toml`, `.gitleaksignore`                                                                                                                  |
| Health                                           | `src/routes/health/{health,ready,metrics}.route.ts`, `src/core/health/readiness.ts`, `src/bootstrap/worker-health.bootstrap.ts`                                                                                                                |
| K8s (unused)                                     | `infrastructure/helm/**` (only `staging.yml`/`production.yml` reference it)                                                                                                                                                                    |
| Docs                                             | `docs/DEPLOYMENT/{DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE,DATABASE_MIGRATION_GUIDE,COMPLETE_ENVIRONMENT_DOCKER_AUDIT,FULL_MULTI_ENV_DOCKER_AUDIT}.md`                                                                                            |

**Branch state (`GH`/git).**

- `develop` = `a91f8a1` (PR #59).
- The previous merge was PR #58 (`5789588`), which brought in `5780d60`. That is a single 85-file commit mixing deployment work with pricing phases 1–7, and it deleted `CONTRIBUTING.md` and `EVENT_INFRASTRUCTURE.md`.
- `main` = `53d3cf1` (Nov 13). `main` is 3 commits ahead of `develop` and 31 behind.
- The local working tree has one uncommitted file, `.github/workflows/deploy-dev.yml`. It is **older than HEAD**: committing it would revert `5fff8f1` (see DO-21).

**Not present:** no "AI Analyzer" worker exists anywhere in this repository (see DO-30). Workers that do exist: 8 maintenance queues, `auth-otp` and `notifications` (`src/jobs/queues/index.ts`).

---

## 3. Existing Docker architecture

**Image (`Dockerfile`).**

- Multi-stage build on `node:22.21.0-trixie-slim`.
- The `prod` stage copies only production `node_modules`, `dist`, `prisma` and `prisma.config.ts`, and runs `USER node` behind `dumb-init`.
- It has a `HEALTHCHECK` on `/health`. Prisma engines are rebuilt so `prisma migrate deploy` works offline.
- `ops` = `FROM build`: full devDependencies (tsx) plus source, running as root. It is used for migrate, seed and create-admin.
- `.dockerignore` excludes `.env`, `.env.*`, `.git`, `.github`, `docs`, `infrastructure` and `src/generated`.
- `RUNTIME`: the built image contains **0** `.env*` files, runs as user `node`, and is 208 MB.

**DEV stack (`compose.dev.yml`, project `zaroorat-dev`).**

| Service   | Image                                             | Exposure              | Health       | Limits         | Notes                                  |
| --------- | ------------------------------------------------- | --------------------- | ------------ | -------------- | -------------------------------------- |
| caddy     | `caddy:2-alpine` (floating)                       | **80, 443 published** | none         | 0.5 CPU / 128M | waits for api healthy                  |
| api       | `${APP_IMAGE:-…/zaroorat-backend:dev}` + `build:` | expose 3000           | `/health`    | 1.5 / 1024M    | grace 30 s                             |
| worker    | same image, `node dist/worker.js`                 | expose 3001           | `/health`    | 1.0 / 768M     | grace 150 s                            |
| pgbouncer | `edoburu/pgbouncer:v1.23.1-p2` (pinned)           | internal 6432         | `pg_isready` | 0.25 / 64M     | transaction mode, pool 40+10           |
| postgres  | `postgis/postgis:17-3.5`                          | internal 5432         | `pg_isready` | 2.0 / 2048M    | volume `postgres_dev_data`             |
| valkey    | `valkey/valkey:8.1-alpine`                        | internal 6379         | ping         | 0.5 / 512M     | requirepass, AOF, 384mb, noeviction    |
| migrate   | `${OPS_IMAGE:-…:dev-ops}` + `build:`              | profile `ops`         | —            | —              | superuser direct to `postgres:5432`    |
| db-roles  | postgis image                                     | profile `ops`         | —            | —              | runs `scripts/db/create-app-login.sql` |
| ops       | ops image                                         | profile `ops`         | —            | —              | seed / create-admin                    |

- Network: one bridge network, `172.28.0.0/24`. `TRUSTED_PROXIES` is set to that subnet.
- Restart policy is `always`. No privileged containers, and no Docker socket mounts.
- **There is no log rotation** (DO-14).
- `RUNTIME`: `docker compose config` with the template publishes only 80 and 443.

**Fit for remote DEV.**

- `compose.dev.yml` is already a _server_ file: no bind-mounted source, no hot reload, no debug ports. LOCAL development lives in `compose.local.yml` (bind mounts, `develop.watch`, `127.0.0.1` ports only). No separate "remote DEV" compose file is needed. Do not create one (it would duplicate configuration).
- The two DEV-unsafe leftovers are `build:` keys combined with default tags (`:dev`, `:dev-ops`) that CI never pushes (DO-08).

---

## 4. Existing environment architecture

**Names (`src/config/env/environment.ts`).**

- `APP_ENV` must be one of `local|dev|test|staging|prod`. The legacy names `development|testing|production` map to `local|test|prod`.
- `isDeployed()` returns true for dev/staging/prod: restricted DB role, real payment/SMS/push providers, mandatory encryption keys.
- `servesRealUsers()` returns true for staging/prod: mandatory malware scanning.
- `NODE_ENV` is independent and defaults to `development`. The DEV template correctly sets `APP_ENV=dev` + `NODE_ENV=production`, and no code path uses `NODE_ENV` to decide security behaviour.
- **No APP_ENV/NODE_ENV conflict was found**, with one exception: the loader and `prisma.config.ts` fall back to `NODE_ENV` when `APP_ENV` is missing. They then still fail closed, because the schema requires `APP_ENV`.

**File loading (three different mechanisms).**

| Mechanism                             | `local`                   | `dev`                             | `staging` / `prod`                                     | Missing file                         |
| ------------------------------------- | ------------------------- | --------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| `src/config/env/loader.ts` (app)      | `.env.local`              | `.env.dev`, then **`.env.local`** | nothing (injected vars)                                | **throws** for local/dev/development |
| `prisma.config.ts` (CLI)              | `.env.local`              | `.env.dev`                        | `.env.staging` / `.env.prod`                           | silent                               |
| `package.json` scripts (`--env-file`) | `dev:local`, `worker:dev` | **`dev`** (the default!)          | **`start`, `worker`** (the defaults!) load `.env.prod` | Node exits 9                         |

Problems: DO-02 (dev throws in containers), DO-11 (the default npm scripts load DEV/PROD files) and DO-20 (`development` falls back to `.env.dev`).

**Validation (`schema.ts` + module configs).**

- `DATABASE_URL`, `REDIS_URL` and JWT secrets (≥32 characters) are always required.
- In deployed environments, `ENCRYPTION_KEY`, `RIDE_PIN_PEPPER`, `BANK_*`, and `FIREBASE_SERVICE_ACCOUNT_JSON` (when `PUSH_PROVIDER=fcm`) are also required.
- Payment config refuses `mock` and requires `PAYMENT_WEBHOOK_SECRET` for razorpay/stripe.
- SMS and push refuse `mock` when deployed.
- This fails safely. It is also why DEV needs **real** Airtel, FCM, Razorpay-test and S3 credentials. Mocks are refused by design.

**Isolation between environments (`.env.*` on this laptop, compared by equality only, values never printed).**

- DEV shares nothing with staging or prod: bucket, AWS key, Firebase service account, Maps key, Razorpay key, Airtel user, JWT and encryption key all differ.
- **Staging and prod share** the Firebase service account, the Google Maps key and the Airtel username (DO-16).
- Database and Valkey hostnames (`pgbouncer`, `valkey`, `postgres`) only resolve inside each stack's Docker network. A laptop process that accidentally loads `.env.dev` or `.env.prod` therefore fails at DB connect rather than reaching a real database.
- Third-party credentials (SMS, S3, FCM, Razorpay **live** in `.env.prod`) would still be live in that process (DO-11).

**CORS / Socket.IO.**

- `CORS_ALLOWED_ORIGINS` and `REALTIME_CORS_ORIGINS` come from env. DEV values: `https://dev-admin.zaroorat.com,https://dev.zaroorat.com`. Local gets allow-all.
- In deployed environments the realtime adapter defaults to `redis`.
- Socket tokens travel in `handshake.auth` or the `Authorization` header, never the query string, so Caddy's JSON access log does not record JWTs (`CODE`).

---

## 5. Existing database architecture

- **PostgreSQL 17 + PostGIS 3.5** (`postgis/postgis:17-3.5`; PostGIS 3.5.2 seen on 2026-11-19, `MEMORY`). The schema declares `extensions = [postgis, pgcrypto]`, so migrations create them. That requires the superuser, which is what `POSTGRES_USER` is.
- **Roles.**
  - `POSTGRES_USER` (`zaroorat`) is superuser and schema owner. It runs migrations directly against `postgres:5432` (`MIGRATION_DATABASE_URL`).
  - Migration `20261002130100` creates group `zaroorat_app_runtime` with CRUD on all tables and sequences, plus `ALTER DEFAULT PRIVILEGES` for future tables. It also revokes UPDATE/DELETE/TRUNCATE on the audit tables and everything on `_prisma_migrations`.
  - `scripts/db/create-app-login.sql` creates and refreshes login `zaroorat_app` as NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS inside that group. It is idempotent and refuses an empty password.
  - At boot, `assertRestrictedDatabaseRole` refuses to start a deployed environment as a role that can rewrite the audit trail.
  - Net effect: **the runtime role is least-privilege with no DDL** (`CODE`).
- **Pooling.**
  - The app uses `DATABASE_URL` → `pgbouncer:6432` (transaction mode, `scram-sha-256`, pool 40 + reserve 10 for DEV).
  - Prisma 7 runs through `@prisma/adapter-pg` (node-postgres), which sends unnamed statements, so transaction pooling is compatible. The full stack through PgBouncer was runtime-verified healthy on 2026-11-19 (`MEMORY`). It was not re-run today.
- **Migrations.**
  - `migrate` uses the ops image and calls `prisma migrate deploy` with `MIGRATION_DATABASE_URL`, which `prisma.config.ts` prefers over `DATABASE_URL`.
  - Concurrency is triple-guarded: GitHub `concurrency: deploy-dev`, `flock` in `deploy.sh`, and Prisma's own advisory lock.
- **Backups.**
  - Nothing is scheduled on any server.
  - `scripts/db-backup.sh` is laptop-oriented (it reads `.env.local`) and dumps with `--no-privileges`.
  - A restore loses the runtime grants **and** the default privileges, and has never been tested (DO-17).
- **Tuning.** PostgreSQL defaults: `max_connections=100`, `shared_buffers=128MB`. The data lives on the droplet's root disk. This is fine for DEV.

---

## 6. Existing Valkey / BullMQ architecture

- **Valkey 8.1** with `--requirepass`, `--appendonly yes`, `--maxmemory 384mb`, `--maxmemory-policy noeviction`, and a persistent volume. This is correct for BullMQ, because eviction would silently drop jobs.
- **One `REDIS_URL`** serves cache, rate limits, the Socket.IO adapter and BullMQ.
  - Queue and worker connections use `new Redis(url, { maxRetriesPerRequest: null })`, which BullMQ requires (`src/jobs/queues/index.ts:42`).
- **Queues:** `files-, users-, auth-, rides-, drivers-, payments-, subscriptions-, notifications-maintenance`, `auth-otp`, `notifications`.
- **Retries:**

  | Queue         | Attempts                | Backoff                               | Retention                      |
  | ------------- | ----------------------- | ------------------------------------- | ------------------------------ |
  | notifications | 4                       | exponential from 5 s                  | keep 1,000 done / 5,000 failed |
  | OTP           | `OTP_DELIVERY_ATTEMPTS` | exponential `OTP_DELIVERY_BACKOFF_MS` | failed kept 1 h                |
  | maintenance   | 1                       | —                                     | —                              |

  The maintenance jobs repeat on their cron schedules, so the next run covers a failure. Maintenance workers run with concurrency 1.

- **Durability.**
  - Notifications are produced through a Postgres outbox (`OutboxRelay`) plus reconciliation jobs. A Valkey loss of up to about 1 s (AOF `everysec`) cannot lose a ride or payment notification permanently.
  - Payment reconciliation, refund reconciliation and settlement are cron-driven and re-scan Postgres.
- **Shutdown.** The worker calls `worker.close()`, which waits for active jobs, with a 120 s budget inside the 150 s compose grace. The API drains for 10 s with a 25 s budget inside its 30 s grace (`CODE`).
- **CI vs servers.** CI tests against `redis:8`, but the servers run Valkey 8.1. The two are compatible at protocol level (`MEMORY`: verified 2026-11-19), but Valkey cannot read a Redis 8 RDB, so a DEV volume must start fresh.

---

## 7. Existing CI/CD architecture

| Workflow                         | Trigger                                    | What it does                                                                                                                                   | State on `develop` today (`GH`)                                                                                                    |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                         | push main/develop/feature…, PR             | format, lint, typecheck → tests (15 min cap) → build + boot smoke (with `APP_ENV=production` only)                                             | **failure**: format fails on `src/modules/payments/errors/payment.errors.ts`; tests **cancelled** at the 15 min cap; build skipped |
| `security.yml`                   | push, PR, weekly                           | gitleaks (`-v`), `npm audit --omit=dev --audit-level=high`, CodeQL, Trivy (report-only, `@master`)                                             | **failure**: dependency audit (3 high: `effect` ReDoS via `prisma` → `@prisma/config`, pinned `effect@3.20.0`; fixed in 3.22.1+)   |
| `deploy-dev.yml`                 | push develop, manual dispatch (any branch) | build+push `prod` & `ops` images (`sha-<sha>`, `dev-latest`, `sha-<sha>-ops`, `dev-ops-latest`) → SSH `deploy <sha> <digest>` → curl `/health` | **failure ×2**: build+push succeeded; SSH step failed: exit 255 (run 1), then "DEPLOY_HOST is not set" (run 2)                     |
| `prisma-check.yml`               | main only                                  | prisma format/validate                                                                                                                         | n/a                                                                                                                                |
| `staging.yml` / `production.yml` | main / release                             | **Helm + kubectl** (no cluster exists); `IMAGE_NAME=github.repository` (`zaroorat-back`) ≠ compose's `zaroorat-backend`                        | inert (`DEPLOY_STAGING` unset)                                                                                                     |
| `release.yml`                    | tag `v*.*.*`                               | lint/typecheck/test/build, GitHub release                                                                                                      | n/a                                                                                                                                |

**GitHub settings (`GH`, read-only API).**

- Repo **public**.
- `develop` and `main` **unprotected**. The ruleset "main" is active but was found inert on 2026-11-19 (`MEMORY`).
- Environments `dev` and `staging` exist with **no protection rules and no deployment-branch policy**.
- The GHCR package is **private**: the anonymous token request is refused (401/403), so the droplet needs registry credentials.
- `gh` is not installed on this machine, so environment secret _names_ could not be listed.

---

## 8. Security audit (summary)

| Control                                         | Status                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Public ports limited to 80/443                  | ✅ `RUNTIME` (compose config)                                                                           |
| PG / Valkey / PgBouncer private                 | ✅ (not published; DO Cloud Firewall still required because Docker bypasses UFW for any published port) |
| Non-root runtime, no privileged, no docker.sock | ✅ runtime image; ⚠️ ops image runs as root (DO-27)                                                     |
| No secrets in image                             | ✅ `RUNTIME` (0 env files)                                                                              |
| No secrets in git                               | ❌ **DO-01** (live DEV Google Maps key + AWS key id + Airtel identifiers in public files)               |
| Secret scanning effective                       | ❌ DO-12 (gitleaks passed on `a91f8a1` despite DO-01; `-v` would print findings into public logs)       |
| Least-privilege DB runtime role                 | ✅                                                                                                      |
| Deploy account least privilege                  | ❌ DO-07 (scripts run from a deploy-writable git tree; docker group = root; unvalidated args)           |
| SSH host key verification                       | ✅ known_hosts from secret (make `StrictHostKeyChecking=yes` explicit, DO-22)                           |
| Immutable images                                | ✅ API by digest; ❌ ops by mutable tag with `                                                          |     | true` (DO-08) |
| Branch / environment protection                 | ❌ DO-05                                                                                                |
| Supply chain                                    | ⚠️ actions on major tags, `trivy-action@master`, floating base tags (DO-18)                             |
| Public health endpoints leak nothing sensitive  | ⚠️ minor (DO-23)                                                                                        |

---

## 9–12. Findings

Severity scale:

- **Critical**: blocks DEV, or is an active exposure.
- **High**: breaks a deploy path or a security boundary.
- **Medium**: fix before relying on DEV daily.
- **Low**: hygiene, or a production-later item.

### Index

| ID    | Sev      | Title                                                                                              | Primary file                                                                                    |
| ----- | -------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| DO-01 | Critical | Live DEV credentials and identifiers committed to the public repo                                  | `docs/DEPLOYMENT/DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md:58-85`, `deploy/env/.env.dev.example` |
| DO-02 | Critical | DEV API and worker crash at boot: loader demands a `.env.dev` file                                 | `src/config/env/loader.ts:43-49`                                                                |
| DO-03 | Critical | DEV boot fails: `PAYMENT_WEBHOOK_SECRET` empty with razorpay                                       | `deploy/env/.env.dev.example`, server `.env.dev`                                                |
| DO-04 | Critical | Deploy scripts not executable in git                                                               | `deploy/bin/*.sh` (mode 100644)                                                                 |
| DO-05 | Critical | GitHub `dev` env missing `DEPLOY_HOST`; no env/branch protection                                   | GitHub settings                                                                                 |
| DO-06 | High     | Deploy has no quality gate; CI on develop is red                                                   | `.github/workflows/deploy-dev.yml`, `ci.yml:58`                                                 |
| DO-07 | High     | Deploy account model: writable scripts, docker-group root, unvalidated args                        | `deploy/bin/ssh-entry.sh:13`, `deploy/bin/deploy.sh`                                            |
| DO-08 | High     | Ops/migrate image by mutable tag + `                                                               |                                                                                                 | true`+`build:` → silent server build | `deploy/bin/deploy.sh:37-38`, `compose.dev.yml:46,86,214,258` |
| DO-09 | High     | `rollback.sh` / `status.sh` broken; auto-rollback incomplete                                       | `deploy/bin/rollback.sh:17`, `status.sh:8-14`, `deploy.sh:56-62`                                |
| DO-10 | High     | Deploy gating checks liveness only; no wait timeout; smoke doesn't verify target                   | `deploy.sh:56`, `deploy-dev.yml:102-107`                                                        |
| DO-11 | High     | Default npm scripts load `.env.prod` / `.env.dev`; LOCAL api breaks on next recreate               | `package.json:12,26,31`                                                                         |
| DO-12 | High     | Secret scan ineffective and log-unsafe in a public repo                                            | `.github/workflows/security.yml:49,120`, `.gitleaks.toml`                                       |
| DO-13 | High     | Unreviewed pricing WIP merged into develop in an 85-file commit                                    | `5780d60` / PR #58                                                                              |
| DO-14 | Medium   | No container log rotation                                                                          | `compose.dev.yml` / server `daemon.json`                                                        |
| DO-15 | Medium   | Env file layout fragile (inside git tree; infra example not wired; duplicated passwords)           | `deploy/env/.env.dev.infra.example`, `deploy.sh:48`                                             |
| DO-16 | Medium   | Staging and prod share credentials; prod/staging secrets live on a laptop                          | `.env.staging`, `.env.prod` (untracked)                                                         |
| DO-17 | Medium   | No server backups; backup drops grants; restore untested                                           | `scripts/db-backup.sh:47-48`                                                                    |
| DO-18 | Medium   | Floating image tags and action refs                                                                | `compose.dev.yml:22,158,186`, workflows                                                         |
| DO-19 | Medium   | Droplet guide is inaccurate and misleads the operator                                              | `docs/DEPLOYMENT/DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md`                                      |
| DO-20 | Medium   | Loader/test disagreement; `development` falls back to `.env.dev`; CI smoke tests `production` only | `loader.ts:45`, `tests/unit/config/env-loader.test.ts:43`, `ci.yml:194`                         |
| DO-21 | Medium   | Uncommitted `deploy-dev.yml` in working tree is older than HEAD                                    | working tree                                                                                    |
| DO-22 | Medium   | Workflow permissions/SSH handling looser than needed                                               | `deploy-dev.yml:13-15,83-100`                                                                   |
| DO-23 | Low      | Public `/health` and `/ready` disclose env name, uptime and check errors                           | `src/routes/health/*.ts`                                                                        |
| DO-24 | Low      | Caddy: no ACME email, no HSTS, waits on api health                                                 | `deploy/caddy/Caddyfile`, `compose.dev.yml:32-34`                                               |
| DO-25 | Low      | Migrations run as the PG superuser (no separate owner role)                                        | `compose.dev.yml:220`                                                                           |
| DO-26 | Low      | Valkey password in healthcheck argv; CI uses redis:8 vs Valkey on servers                          | `compose.dev.yml:198`, `ci.yml:76`                                                              |
| DO-27 | Low      | Ops image runs as root with full devDependencies and source                                        | `Dockerfile:95-96`                                                                              |
| DO-28 | Low      | staging/production workflows still Helm/K8s with a different image name                            | `staging.yml`, `production.yml`                                                                 |
| DO-29 | Low      | Deploy lock in world-writable `/tmp`; `flock -n` fails instead of waiting                          | `deploy.sh:13,19-23`                                                                            |
| DO-30 | Low      | "AI Analyzer" worker referenced by the brief does not exist in this repo                           | —                                                                                               |

### 9. Critical

**DO-01: Live DEV credentials and identifiers in the public repository**

- **Existing behaviour.**
  - `DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md` lines 58–85 list the DEV storage bucket names (which embed the AWS account id), the AWS access key ID (line 63), the Airtel customer id, username, entity id and template ids, the **full Google Maps API key** (line 80), and the Razorpay test key id (line 85).
  - `deploy/env/.env.dev.example` repeats the Airtel customer id, username and entity id.
  - By equality check, the Google key, AWS key id and Airtel ids are **identical to the live values in the local `.env.dev`**.
  - Pushed to `origin/develop` and `origin/feat/multi-env-standardization`.
- **Problem.**
  - The Google key is a complete credential, and public GitHub is scraped for `AIza…` keys within minutes.
  - The AWS key id alone does not grant access (its secret is not in the repo), but it ties the account and buckets together for targeted attacks.
  - The Airtel identifiers are half of the SMS login.
- **Correction.**
  1. **Owner, now:** delete or regenerate the Google Maps key, and restrict the new one to the required APIs and to the droplet's public IPv4. The _droplet_ IP, not the Reserved IP: outbound traffic leaves from the droplet's own address.
  2. Rotate the AWS access key pair for the DEV IAM user.
  3. Consider changing the Airtel password.
  4. Then replace the values in both files with `REPLACE_WITH_…` placeholders (§D-1).
  5. Do not rewrite history. The repo is public, so rotation is the fix.
  6. These values also passed through this audit session's transcript (unavoidable when reading the file), which is one more reason to rotate.
- **Risk if not fixed.** Billing abuse on the Maps key, targeted credential stuffing on AWS and Airtel.
- **Validation.** Re-run the pattern scan from §20 → 0 hits outside `tests/`. The Google Cloud console shows the old key deleted, and the AWS IAM console shows the old key inactive.

**DO-02: DEV API and worker crash at boot (`RUNTIME`)**

- **Existing behaviour.** `loader.ts` maps `dev: ['.env.dev', '.env.local']` and throws when neither file exists. The image has no env files (`.dockerignore`), and `compose.dev.yml` injects variables through `env_file:` but mounts no file.
- **Proof.**
  - `docker run --rm --network none --env-file deploy/env/.env.dev.example <prod image> node dist/server.js` → `Error: Environment file ".env.dev" not found`.
  - The same happens for `dist/worker.js`.
- **Problem.** No DEV container can ever start. It also contradicts the loader's own comment ("deployed environments rely on injected variables"), and the `.env.local` fallback would make a DEV process read a developer's local file.
- **Correction.** Remove the `dev` entry and the `.env.dev` fallback of `development` (§D-2). DEV then behaves like staging and prod, which `prisma.config.ts` already does without throwing. Add a test: "APP_ENV=dev without a file does not throw".
- **Risk if not fixed.** DEV never boots.
- **Validation.** The same `docker run` reaches `bootstrapDatabase` (`EAI_AGAIN pgbouncer` with `--network none`). The CI smoke runs with `APP_ENV=dev` (§D-6).

**DO-03: `PAYMENT_WEBHOOK_SECRET` missing in DEV (`RUNTIME`)**

- **Existing behaviour.** The DEV template and the local `.env.dev` set `PAYMENT_DEFAULT_GATEWAY=razorpay` and `PAYMENT_WEBHOOK_SECRET=` (empty). `payment.config.ts:88-99` throws for live gateways without it.
- **Proof.** With DO-02 bypassed (template mounted as `/app/.env.dev`): `Error: PAYMENT_WEBHOOK_SECRET is required when PAYMENT_DEFAULT_GATEWAY=razorpay`. With a dummy value as well, the API passes all config validation and stops at the absent database.
- **Problem.** This is a second boot blocker. The guide's claim that `.env.dev` "passed with 0 validation errors" is false, because that check covered only `EnvironmentSchema`.
- **Correction.**
  - Owner: create a Razorpay **test-mode** webhook pointing to `https://dev-api.zaroorat.com/webhooks/razorpay`, and put its secret in the server env file.
  - Template: `PAYMENT_WEBHOOK_SECRET=REPLACE_WITH_RAZORPAY_TEST_WEBHOOK_SECRET`.
- **Risk if not fixed.** DEV never boots.
- **Validation.** `ssh deploy status` shows `api: ready`, and a Razorpay test webhook returns 2xx.

**DO-04: Deploy scripts not executable**

- **Existing behaviour.** `git ls-tree origin/develop deploy/bin/` → all four files `100644`. `ssh-entry.sh` `exec`s `deploy.sh`, and the forced command `exec`s `ssh-entry.sh`.
- **Problem.**
  - Both execs fail with `Permission denied`.
  - A manual `chmod +x` on the server makes git see a mode change. The next `git checkout --detach <sha>` that touches those files then aborts with "local changes would be overwritten", so the manual fix breaks later deploys.
- **Correction.** `git update-index --chmod=+x deploy/bin/deploy.sh deploy/bin/ssh-entry.sh`. With §D-4, install root-owned copies into `/usr/local/sbin` rather than executing from the checkout.
- **Risk if not fixed.** No deploy can run.
- **Validation.** `git ls-files -s deploy/bin` shows `100755`. `ssh deploy@host status` returns output.

**DO-05: GitHub `dev` environment incomplete and unprotected (`GH`)**

- **Existing behaviour.**
  - Run 45008450561 failed with the workflow's own error "DEPLOY_HOST is not set!". Run 45003541192 exited 255 at SSH.
  - Environment `dev` has no required reviewers and no deployment-branch policy.
  - `develop` is unprotected.
  - Whether `SSH_PRIVATE_KEY` and `SSH_KNOWN_HOSTS` exist could not be checked (no `gh`).
- **Problem.**
  - Deploys cannot run.
  - Any branch's workflow can request environment `dev` and receive the SSH key.
  - Anyone with write access can push straight to `develop`, and `develop` is what runs on the server (see DO-07: **merge rights on `develop` = control of the DEV droplet**).
- **Correction (owner, GitHub UI).** See §A.
- **Risk if not fixed.** Deploys fail. Over-broad access to the deploy key.
- **Validation.** `GET /repos/…/environments` shows a branch policy on `dev`, `GET /branches/develop` shows `protected: true`, and the next push to `develop` reaches the SSH step and succeeds.

### 10. High

**DO-06: No quality gate before deploy; `develop` is red**

- **Existing behaviour.**
  - `deploy-dev.yml` builds and deploys on every push to `develop`, with no dependency on CI or Security.
  - On `a91f8a1`:
    - format fails (`src/modules/payments/errors/payment.errors.ts`);
    - tests are cancelled at the 15-minute cap, which has happened on every run since at least 2026-11-19 (`MEMORY`);
    - the build+smoke job is skipped;
    - the dependency audit fails (3 high).
- **Problem.** Code that fails lint, format and tests would be deployed. The test cap means a gate could never pass, even on good code.
- **Correction.**
  - Add `workflow_call:` to `ci.yml` and `security.yml`, then make `deploy-dev.yml` call both and `needs:` them (§D-5, §D-6).
  - Raise the test timeout to 40 minutes.
  - Run `npm run format` on that one file.
  - Resolve the `effect` advisory with an npm `overrides` entry pinning `effect` to `3.22.5` (lockfile change, so it needs approval: Q4). The vulnerable code is the Prisma CLI's config parser, not the request path, so the real-world risk is low.
- **Risk if not fixed.** Broken builds reach DEV, and red CI becomes normal.
- **Validation.** A push with a lint error stops before "Build & Push". A clean push deploys.

**DO-07: Deploy account security model**

- **Existing behaviour.**
  - `ssh-entry.sh` runs `exec …/deploy.sh ${ORIGINAL_CMD#deploy }`. The expansion is unquoted, so it undergoes word splitting and globbing.
  - `deploy.sh` accepts any `SHA` and `DIGEST` text. It runs `git checkout --detach "$SHA"`, which accepts branch names and option-like strings, and does no ancestry check.
  - Every script lives in `/opt/zaroorat/src`, the git checkout the deploy user must be able to write (it runs `git checkout`).
  - The guide adds only root to the docker group and never creates the `deploy` user.
- **Problem.**
  - A forced command is not least privilege when the account can rewrite the script it is forced into, or is in the `docker` group (docker group = root on the host).
  - Unvalidated arguments let the key holder deploy any ref present in the clone.
  - Note: even with a perfect wrapper, the compose file and Caddyfile come from `develop`. **Whoever can merge to `develop` effectively controls the DEV host.** Branch protection (DO-05) is the real boundary.
- **Correction (§D-4, §18).**
  - Dedicated `deploy` user, **not** in the docker group.
  - `authorized_keys` line: `restrict,command="/usr/local/sbin/zaroorat-ssh-entry" ssh-ed25519 …`.
  - Root-owned `/usr/local/sbin/zaroorat-ssh-entry` and `/usr/local/sbin/zaroorat-deploy` (0755 root:root), installed from the repo by an admin after review.
  - Strict regex validation:
    - `^[0-9a-f]{40}$` for the SHA;
    - `^sha256:[0-9a-f]{64}$` for each digest;
    - an exact argument count;
    - `git merge-base --is-ancestor <sha> origin/develop`;
    - the image's `org.opencontainers.image.revision` label must equal the SHA.
  - A single sudoers rule: `deploy ALL=(root) NOPASSWD: /usr/local/sbin/zaroorat-deploy`.
  - A root-owned checkout that only root writes.
- **Risk if not fixed.** A leaked deploy key or a malicious branch gets root on the droplet.
- **Validation.**
  - `ssh deploy@host 'id'` → denied.
  - `ssh deploy@host 'deploy main x y'` → "denied".
  - `sudo -l -U deploy` shows exactly one command.
  - `id deploy` shows no docker group.

**DO-08: Ops/migrate image is mutable, and server-side builds are possible**

- **Existing behaviour.**
  - `deploy.sh:37-38` pulls `…:sha-<sha>-ops` and ignores failure (`|| true`).
  - The CI ops build has no step id, so its digest is never exported.
  - Every app and ops service in `compose.dev.yml` keeps `build:`, with defaults `…:dev` / `…:dev-ops`. CI never pushes those tags; it pushes `dev-latest` / `dev-ops-latest`.
- **Problem.**
  - If the ops pull fails, `docker compose run migrate` finds no image and **builds one on the server** from the checkout, or runs a stale local image.
  - Any `docker compose up` without `APP_IMAGE` also tries `:dev` and then builds.
- **Correction.**
  - Export the ops digest from CI and pass it as a third argument.
  - The deploy script pulls both by digest (failure is fatal) and writes them to a release file used by every compose call.
  - `up` gets `--no-build`.
  - The `build:` keys can stay for `make build-dev` on laptops (§D-4/§D-5).
- **Risk if not fixed.** Migrations run with unreviewed or stale code, and image builds compete with the database for the droplet's RAM.
- **Validation.** `docker compose … config | grep image:` on the server shows only `@sha256:` references. Deleting the ops image makes the deploy fail loudly.

**DO-09: `rollback.sh` and `status.sh` are broken (`RUNTIME` for the first point)**

- **Existing behaviour and problems.**
  - Both call `docker compose -f compose.dev.yml` **without `--env-file`**. `RUNTIME`: `required variable POSTGRES_PASSWORD is missing a value`, so both abort before doing anything.
  - `status.sh` curls `127.0.0.1:3000` on the _host_, but the api port is only `expose`d, so it always reports failure.
  - `rollback.sh` reuses the _new_ compose file and git checkout, keeps only one previous image, and never swaps `previous`.
  - `deploy.sh`'s automatic rollback has the same compose problem, and does nothing on the first deploy.
- **Correction.** Fold deploy, rollback and status into one root-owned script that keeps `current.env` / `previous.env` release files (image digests + git SHA) and restores the matching checkout (§D-4). Delete `rollback.sh` and `status.sh`.
- **Risk if not fixed.** There is no working rollback during an incident.
- **Validation.** Deploy A, deploy B, `rollback` → A's digest and SHA are live and `/ready` is 200. A second `rollback` → "no previous release recorded".

**DO-10: Health gating is liveness-only**

- **Existing behaviour.**
  - The compose healthchecks and `up --wait` use `/health`, which never touches dependencies.
  - `--wait` has no `--wait-timeout`.
  - The workflow smoke curls `/health` only, and would pass against _any_ environment answering on `API_URL`.
- **Problem.** A deploy whose API cannot reach PostgreSQL or Valkey is reported green, and a hung start only ends at the 15-minute job timeout.
- **Correction.**
  - Keep `/health` as the container liveness check.
  - After `up`, the deploy script runs `/ready` _inside_ the api and worker containers (`docker compose exec -T … fetch('/ready')`), using `--wait-timeout 180`.
  - The workflow smoke checks `GET /ready` and asserts `/health` reports `"environment":"dev"` (§D-5).
- **Risk if not fixed.** False-green deploys.
- **Validation.** Stop `valkey`, run a deploy → it fails at the readiness step.

**DO-11: Default npm scripts load DEV/PROD config; LOCAL api breaks (`RUNTIME` for Node behaviour)**

- **Existing behaviour.** Since `5780d60`:
  - `"dev": "tsx watch --env-file=.env.dev …"`;
  - `"start"` and `"worker"` use `node --env-file=.env.prod …`;
  - plus `prod`, `staging`, `dev:prod`, `start:prod`, `admin:prod` and similar scripts.
  - `compose.local.yml` runs `npm run dev` inside the LOCAL api container, where only `.env.local` is mounted.
- **Problems.**
  - (a) `npm start` on this laptop boots with **production** config. `.env.prod` exists here with Razorpay `live`. DB and Valkey hostnames won't resolve, but live third-party credentials are loaded. This violates "local must never accidentally connect to production".
  - (b) `RUNTIME`: Node exits 9 (`.env.dev: not found`) when the file is missing. The LOCAL api container will fail the next time it is recreated. The current container predates the change (started 05:12 UTC, before the commit).
- **Correction.** `dev` → `--env-file=.env.local`. `start` / `worker` → `node dist/server.js` / `node dist/worker.js` (the loader picks `.env.local`) (§D-3). Removing the laptop-side `prod`/`staging` scripts is Q8.
- **Risk if not fixed.** Accidental use of production providers from a laptop. Broken LOCAL stack.
- **Validation.** `docker compose -f compose.local.yml up -d --force-recreate api` → healthy. `npm start` without env vars logs `environment: local`.

**DO-12: Secret scanning is ineffective, and unsafe in a public repo**

- **Existing behaviour.**
  - `gitleaks detect --source . -v` reported **success** on `a91f8a1`, although that commit contains a Google API key (DO-01). The root cause was not determined: gitleaks is not installed locally. The allowlist regex `test_[a-zA-Z0-9_]+` is broad, but the key does not contain `test_` (checked as a boolean only).
  - `-v` prints each finding, _including the secret_, into Actions logs, which are public for a public repo.
  - `trivy-action@master` is a moving branch.
- **Correction.**
  - Add `--redact`.
  - Run gitleaks locally on `a91f8a1` (with `--redact`) to learn why the key was missed, and narrow `.gitleaks.toml`.
  - Pin Trivy to a release tag or SHA.
- **Risk if not fixed.** The next leak is missed again, or the scanner itself publishes it.
- **Validation.** A test commit with a dummy `AIza…` string in a non-test path fails the job, and the log shows `REDACTED`.

**DO-13: Pricing WIP rides along into DEV**

- **Existing behaviour.**
  - `5780d60` (85 files) mixed deployment work with pricing governance, fiscal, surge and tax changes on top of pricing phases 1–7.
  - It deleted `CONTRIBUTING.md` and `EVENT_INFRASTRUCTURE.md`.
  - It was merged to `develop` via PR #58 while CI was red.
  - The 2026-11-17 pricing audit rated pricing NO-GO (`MEMORY`).
- **Problem.** The first DEV deploy will run, and migrate the DEV database with, code that has not passed CI. Migrations `20261118*` are included.
- **Correction.** An owner decision (Q3): accept that DEV runs this code (DEV is the place to find out), or deploy a pre-pricing commit first.
- **Risk.** A DEV schema that is hard to roll back if pricing migrations change.
- **Validation.** `git log origin/develop` matches the agreed baseline.

### 11. Medium

- **DO-14: No log rotation.**
  - Docker's default `json-file` driver is unbounded, and Caddy logs every request as JSON. The disk will fill.
  - **Fix (server-side, covers every container including ops):** `/etc/docker/daemon.json` → `{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"}}`, then recreate containers.
  - **Validate:** `docker inspect <c> --format '{{.HostConfig.LogConfig}}'`.
- **DO-15: Env file layout.**
  - The guide puts `.env.dev` inside the git checkout, where a `git clean -fdx` deletes it.
  - `deploy/env/.env.dev.infra.example` and its `APP_ENV_FILE` key are not wired: `deploy.sh` passes the _app_ file as the interpolation file.
  - `DATABASE_URL` and `REDIS_URL` repeat `APP_DB_PASSWORD` and `REDIS_PASSWORD`. The values must match exactly and be URL-encoded (use hex passwords: `openssl rand -hex 24`).
  - **Fix:** a single server file `/opt/zaroorat/env/dev.env` (root, 0600), passed as both `--env-file` and `APP_ENV_FILE` (§D-4). Delete `.env.dev.infra.example`, or document it as unused.
- **DO-16: Isolation and laptop secrets.**
  - Staging and prod share the Firebase service account, Google Maps key and Airtel username.
  - Full staging and prod env files (incl. Razorpay live) sit in the repo folder on this laptop.
  - **Fix:** separate staging credentials before staging goes live. Keep prod/staging env files only on their servers and in a password manager.
  - Not a DEV blocker.
- **DO-17: Backups.**
  - Nothing is scheduled.
  - `db-backup.sh` uses `--no-privileges`, so a restore loses the runtime grants and default privileges.
  - Pointed at the runtime URL, the dump would fail, because the runtime role has no access to `_prisma_migrations`.
  - **Fix for DEV:** a nightly `pg_dump -Fc` as the owner, run inside the postgres container (keeping privileges), 7-day retention, plus DO weekly droplet backups. Restore-test monthly (§18).
- **DO-18: Floating references.**
  - `caddy:2-alpine`, `valkey/valkey:8.1-alpine`, `postgis/postgis:17-3.5` (patch-floating), `dev-latest` tags, and every action at `@vN`.
  - **Fix:** pin the server images to exact versions or digests, recorded in the compose files (an upgrade then becomes a reviewed commit). Pin actions by SHA with Dependabot updates. Do not invent versions: pin what `docker image inspect` shows on the first successful deploy.
- **DO-19: Guide inaccuracies.**
  - DO-01 values, plus:
    - the clone URL names a non-existent `zaroorat-backend` repo (the real one is `zaroorat-back`);
    - it runs Docker as root with no deploy user;
    - it curls `127.0.0.1:3000`, which is not published;
    - it shows a fabricated "Expected output";
    - it claims "0 validation errors" (false);
    - it says "production-valid Firebase credentials" for DEV (the values differ from prod);
    - it claims MFA for prod admins (not verified);
    - it relies on UFW alone (Docker bypasses UFW).
  - **Fix:** replace §2–§5 of the guide with §18–§19 of this report.
- **DO-20: Loader and test drift.**
  - `tests/unit/config/env-loader.test.ts` expects a legacy `.env.development` fallback that the code no longer has. `RUNTIME`: 7/8 pass, "development still reads a legacy .env.development" fails.
  - `development` falls back to `.env.dev`.
  - The CI boot smoke only uses `APP_ENV=production` with hand-picked variables, so DO-02 and DO-03 slipped through.
  - **Fix:** §D-2 and §D-6. The smoke should also boot the image with `--env-file deploy/env/.env.dev.example`, which catches template drift.
- **DO-21: Stale working copy.** The uncommitted `.github/workflows/deploy-dev.yml` on this laptop is the pre-`5fff8f1` version. Discard it (`git checkout -- .github/workflows/deploy-dev.yml`) only after the owner confirms it is not someone's intended change (Q9).
- **DO-22: Workflow hygiene.**
  - `packages: write` is granted workflow-wide, so the deploy job gets it too.
  - Secrets are interpolated straight into `run:` scripts.
  - `known_hosts` is appended rather than replaced.
  - SSH runs without `BatchMode=yes` / `StrictHostKeyChecking=yes`.
  - **Fix:** §D-5.

### 12. Low

- **DO-23.** `/health` returns `environment` and `uptime`. `/ready` returns check names and a short error string. No credentials or connection strings are included (`CODE`). Acceptable for DEV. For prod, consider answering `/ready` details only on the internal network.
- **DO-24.** The Caddyfile has no global `email` (no expiry notices from Let's Encrypt) and no `Strict-Transport-Security` header. `depends_on: api: service_healthy` only matters on `up`. Add `{ email <ops address> }` and `header Strict-Transport-Security "max-age=31536000"`. Do not use `preload` on a dev host.
- **DO-25.** Migrations run as the superuser. That is needed for `CREATE EXTENSION postgis` and is fine for DEV. For prod: pre-create the extensions as superuser at init, then run migrations as a dedicated owner role.
- **DO-26.**
  - `valkey-cli -a "$REDIS_PASSWORD"` exposes the password in the container's process list. Use `REDISCLI_AUTH` instead.
  - CI uses `redis:8` while the servers run Valkey 8.1. Switch the CI service to `valkey/valkey:8.1-alpine`.
- **DO-27.** The ops image is root and carries full devDependencies and source. It is short-lived and private. Add `USER node` if the seed and admin paths allow it.
- **DO-28.** `staging.yml` and `production.yml` deploy with Helm to a cluster that does not exist, with `IMAGE_NAME=${{ github.repository }}`. `production.yml` fires on every published GitHub release. Disable or rewrite them before the first release.
- **DO-29.** `/tmp/zaroorat-deploy.lock` lives in a world-writable directory, so another user could pre-create it. Use `/run/lock/zaroorat-deploy.lock`, with `flock -w 600` so a manual deploy waits instead of failing.
- **DO-30.** No AI Analyzer code, queue or service exists in this repo. If it lives elsewhere, it needs its own audit (Q11).

---

## 13. Missing configurations

| Missing                                                                                                                               | Where it belongs                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Deploy user, sudoers rule, forced-command key, root-owned wrapper scripts                                                             | Server (§18) + `deploy/bin/*` (§D-4)                                                                                  |
| GHCR read credential on the droplet (the package is private)                                                                          | Server: `docker login ghcr.io` as root, using a **classic PAT with only `read:packages`** from a machine account (Q6) |
| `DEPLOY_HOST`, `API_URL` variables; `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS` secrets; branch policy on env `dev`; protection on `develop` | GitHub (§A)                                                                                                           |
| `PAYMENT_WEBHOOK_SECRET` (Razorpay test) for DEV                                                                                      | Server env file + Razorpay dashboard                                                                                  |
| Docker log rotation                                                                                                                   | Server `daemon.json`                                                                                                  |
| Scheduled DB backup + restore test                                                                                                    | Server cron (§18)                                                                                                     |
| DO Cloud Firewall, Reserved IP, monitoring/alerts                                                                                     | DigitalOcean (§18)                                                                                                    |
| DNS `dev-api.zaroorat.com`                                                                                                            | DNS (§D)                                                                                                              |
| `.env.local.example` (the loader's error message points to it; absent)                                                                | Repo (low priority; LOCAL)                                                                                            |
| ACME contact email                                                                                                                    | Caddyfile (owner gives the address)                                                                                   |

## 14. Exact affected file paths

See the index under §9–12. Each finding names its file and line.

## 15. Exact recommended corrections

See §D below for the code. Recommended order:

1. Owner rotates the DO-01 credentials.
2. Apply §D-1 to §D-4 (DEV blockers + deploy model).
3. Apply §D-5 and §D-6 (pipeline).
4. Do the server bootstrap (§18).
5. Push to `develop`.

## 16. Recommended Docker architecture (DEV)

**Keep the current single-droplet `compose.dev.yml` topology** (Caddy → api/worker → PgBouncer → PostGIS; Valkey). No new services are needed. Changes are limited to:

- Images referenced **only by digest**, through a release file written by the deploy script. `build:` is kept for laptops, and `up --no-build` is used on servers.
- Server-wide log rotation through `daemon.json`. There is no per-service YAML to maintain.
- Third-party images pinned (DO-18).
- Server env file outside the git tree: `/opt/zaroorat/env/dev.env`.
- Deferred, not needed for DEV: separate migration owner role, PgBouncer stats exporter, Valkey/PG exporters, read replicas.

## 17. Recommended GitHub Actions architecture (DEV)

```
push develop ──► ci.yml (workflow_call) ──┐
              └► security.yml (workflow_call)┴─► build (prod + ops, push sha-* tags, export both digests)
                                                     └─► deploy [environment: dev, branch policy develop]
                                                           ssh (pinned host key, restricted key)
                                                             → zaroorat-deploy deploy <sha> <app@digest> <ops@digest>
                                                               fetch+ancestry check → pull by digest → label==sha
                                                               → migrate → db-roles → up --wait (180 s) → /ready api+worker
                                                               → record current/previous release
                                                           → curl https://dev-api.zaroorat.com/ready + /health env==dev
```

- No image is built on the server.
- Failure in any step leaves the previous containers running (a migration failure stops before `up`), or restores the previous release.
- Public repo → Actions minutes are free, so the duplicate CI run on `develop` push (its own trigger + the call) is accepted for simplicity.

---

## 18. DigitalOcean setup instructions (DEV)

### A. GitHub (owner, UI)

1. **Settings → Environments → `dev`.**
   - Deployment branches: **Selected branches → `develop`**.
   - Variables: `DEPLOY_HOST` = the Reserved IP (or `dev-api.zaroorat.com` once DNS resolves); `API_URL` = `https://dev-api.zaroorat.com`.
   - Secrets: `SSH_PRIVATE_KEY` (the deploy key generated below, private half) and `SSH_KNOWN_HOSTS` (output of `ssh-keyscan -t ed25519 <reserved-ip>`, checked against the droplet console fingerprint).
   - Required reviewers are optional for DEV.
2. **Settings → Branches / Rulesets.** Protect `develop`: require a PR, require status checks **"Lint, format & types"**, **"Tests"** and **"Build & container"**, and block force-push. Fix the inert `main` ruleset at the same time.
3. **GHCR.** Keep the package `zaroorat-backend` private. Create a classic PAT on a machine/bot account with **only `read:packages`** for the droplet (Q7).

### B. Repository

All of §D.

### C. Server (Ubuntu 24.04 LTS, BLR1)

Droplet: Basic **2 vCPU / 4 GiB** (≈$24/mo + 20% weekly backups; DO prices read 2026-11-19, re-check) is the minimum, since images are pre-built and nothing compiles on the box. Use 4 vCPU / 8 GiB (≈$48) if DEV will also host load tests. Assign a **Reserved IP**, and enable **Monitoring** and **weekly Backups** at creation.

```bash
# ── 1. as root (DO console or your admin key), once ───────────────────────────
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl git ufw fail2ban unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# swap (4 GiB droplet)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Docker Engine + Compose plugin from Docker's apt repository
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }
EOF
systemctl restart docker

# ── 2. accounts ───────────────────────────────────────────────────────────────
# human admin (your personal key), sudo with password
adduser --gecos "" opsadmin && usermod -aG sudo opsadmin
install -d -m 700 -o opsadmin -g opsadmin /home/opsadmin/.ssh
cp /root/.ssh/authorized_keys /home/opsadmin/.ssh/ && chown opsadmin:opsadmin /home/opsadmin/.ssh/authorized_keys

# deploy account: NOT in the docker group; bash is required for the forced command to run
adduser --disabled-password --gecos "" --shell /bin/bash deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# Generate the key pair OFF the server (e.g. your laptop):  ssh-keygen -t ed25519 -N "" -C gha-dev-deploy -f gha-dev-deploy
# Put the PRIVATE half in GitHub secret SSH_PRIVATE_KEY, then delete it locally.
echo 'restrict,command="/usr/local/sbin/zaroorat-ssh-entry" <contents of gha-dev-deploy.pub>' > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/zaroorat-deploy' > /etc/sudoers.d/zaroorat-deploy
chmod 440 /etc/sudoers.d/zaroorat-deploy && visudo -cf /etc/sudoers.d/zaroorat-deploy

# ── 3. sshd + fail2ban + UFW (DO Cloud Firewall is the primary control) ──────
cat > /etc/ssh/sshd_config.d/10-zaroorat.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers opsadmin deploy
EOF
sshd -t && systemctl restart ssh        # keep a second session open until you have verified opsadmin login
printf '[sshd]\nenabled = true\nbackend = systemd\n' > /etc/fail2ban/jail.d/sshd.local
systemctl enable --now fail2ban
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
# NOTE: Docker-published ports bypass UFW. Only 80/443 are published by compose.dev.yml — never add ports: to postgres/valkey/pgbouncer.

# ── 4. layout (root-owned; deploy user cannot write any of it) ───────────────
install -d -m 755 /opt/zaroorat
install -d -m 700 /opt/zaroorat/env /opt/zaroorat/state /opt/zaroorat/backups
git clone https://github.com/zaroorat-mobility/zaroorat-back.git /opt/zaroorat/src
git -C /opt/zaroorat/src checkout --detach origin/develop
install -o root -g root -m 0755 /opt/zaroorat/src/deploy/bin/ssh-entry.sh /usr/local/sbin/zaroorat-ssh-entry
install -o root -g root -m 0755 /opt/zaroorat/src/deploy/bin/deploy.sh    /usr/local/sbin/zaroorat-deploy
# Re-run the two `install` lines (as opsadmin with sudo) whenever a reviewed change to deploy/bin lands.

# env file: start from the template, fill every REPLACE_WITH_* (secrets from the owner, never pasted into chat/CI logs)
install -m 600 /opt/zaroorat/src/deploy/env/.env.dev.example /opt/zaroorat/env/dev.env
#   generate: openssl rand -hex 24  (DB/Valkey passwords — hex avoids URL-encoding in DATABASE_URL/REDIS_URL)
#             openssl rand -base64 48 (JWT_*, ENCRYPTION_KEY, RIDE_PIN_PEPPER, BANK_*, OTP_PEPPER)
editor /opt/zaroorat/env/dev.env

# GHCR read-only login for root (deploys run as root via sudo)
docker login ghcr.io -u <bot-account> --password-stdin   # paste the read:packages PAT, then Ctrl-D

# ── 5. nightly logical backup (owner role, keeps privileges), 7-day retention ─
cat > /etc/cron.d/zaroorat-backup <<'EOF'
15 2 * * * root docker exec zaroorat-dev-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > /opt/zaroorat/backups/zaroorat_dev-$(date -u +\%F).dump && find /opt/zaroorat/backups -name '*.dump' -mtime +7 -delete
EOF
```

**DigitalOcean control panel.**

- **Cloud Firewall** attached to the droplet. Inbound: TCP 80 and 443 from all. TCP 22 from all (Q5: GitHub-hosted runners use thousands of changing IP ranges, so DEV keeps key-only SSH + fail2ban + forced commands; before staging, move CI SSH to a Tailscale tunnel and close 22). Outbound: all.
- **Monitoring alerts:** CPU > 80% for 10 min, memory > 85%, disk > 80%.
- **Uptime check** on `https://dev-api.zaroorat.com/ready`.

### D. DNS and domain

- `zaroorat.com` is on Cloudflare (`MEMORY`). Create **A `dev-api` → Reserved IP**, **DNS only (grey cloud)**, TTL 300.
- Keep it grey for DEV. With the orange proxy, every client appears as a Cloudflare IP: Caddy overwrites `X-Forwarded-For` with `{remote_host}`, which breaks per-IP rate limits until Caddy is taught Cloudflare's ranges.
- If CAA records exist, they must allow `letsencrypt.org`.
- The admin panel's DEV origins (`dev-admin.zaroorat.com`, `dev.zaroorat.com`) must match `CORS_ALLOWED_ORIGINS`.

### E. External services and credentials (owner)

| Service     | DEV item                                                                                               | Note                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Google Maps | New server key (old one leaked, DO-01)                                                                 | Restrict to the needed APIs + the droplet's public IPv4      |
| AWS S3      | Rotated DEV IAM key pair, scoped to the DEV buckets only                                               | DEV uses AWS S3 `ap-south-1`, not DO Spaces (Q7)             |
| Airtel IQ   | DEV credentials; consider a password change                                                            | Real SMS is sent from DEV: mock is refused when `isDeployed` |
| Firebase    | DEV service-account JSON (separate project recommended)                                                | Single-line JSON in the env file                             |
| Razorpay    | Test-mode keys + **test webhook secret**, webhook URL `https://dev-api.zaroorat.com/webhooks/razorpay` | Fixes DO-03                                                  |
| GHCR        | Bot PAT `read:packages`                                                                                | Droplet only                                                 |
| SSH         | ed25519 deploy key pair                                                                                | Private half only in GitHub env `dev`                        |

---

## 19. DEV deployment procedure

**One-time first deploy (opsadmin on the droplet, after §18 and the §D repo changes are on `develop`).**

```bash
sudo -i
# Let GitHub run the first deploy (push or "Run workflow" on develop), OR run it by hand with a digest pair from the build job:
/usr/local/sbin/zaroorat-deploy deploy <40-hex-sha> sha256:<app-digest> sha256:<ops-digest>
# this creates the DB on first start, migrates (88), creates zaroorat_app, starts api/worker/caddy, checks /ready

# reference data + first admin (once)
dc() { APP_ENV_FILE=/opt/zaroorat/env/dev.env docker compose --project-directory /opt/zaroorat/src \
  -f /opt/zaroorat/src/compose.dev.yml --env-file /opt/zaroorat/env/dev.env --env-file /opt/zaroorat/state/current.env "$@"; }
dc run --rm ops npx prisma db seed
read -rp 'Admin email: ' ADMIN_EMAIL; read -rp 'Admin phone (+91…): ' ADMIN_PHONE; read -rsp 'Admin password: ' ADMIN_PASSWORD; echo
export ADMIN_EMAIL ADMIN_PHONE ADMIN_PASSWORD ADMIN_FIRST_NAME=System ADMIN_LAST_NAME=Admin
dc run --rm -e ADMIN_EMAIL -e ADMIN_PHONE -e ADMIN_PASSWORD -e ADMIN_FIRST_NAME -e ADMIN_LAST_NAME ops npx tsx scripts/create-admin.ts
unset ADMIN_PASSWORD
```

**Every later deploy.** Merge a PR into `develop`. The workflow then runs CI + Security → build → SSH deploy → public `/ready` check. To watch it on the server: `sudo /usr/local/sbin/zaroorat-deploy status`.

**Migration rule for DEV.** Migrations must be backward-compatible with the previous image (expand → deploy → contract). A rollback swaps images only; it never reverses schema changes.

## 20. Verification checklist

| #   | Check                                      | Command / evidence                                                                                                                                                                                        | Expected                                   |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | No credentials in tracked files            | `git grep -nE 'AKIA[0-9A-Z]{16}\|AIza[0-9A-Za-z_-]{35}' origin/develop -- . ':!tests'`                                                                                                                    | no output                                  |
| 2   | Old Google/AWS keys dead                   | Cloud consoles                                                                                                                                                                                            | deleted / inactive                         |
| 3   | Image boots in DEV config                  | CI smoke with `--env-file deploy/env/.env.dev.example`                                                                                                                                                    | reaches `bootstrapDatabase`                |
| 4   | Scripts executable                         | `git ls-files -s deploy/bin`                                                                                                                                                                              | `100755`                                   |
| 5   | Deploy key restricted                      | `ssh deploy@host id`; `ssh deploy@host 'deploy main a b'`                                                                                                                                                 | both "denied"                              |
| 6   | Deploy user unprivileged                   | `id deploy`; `sudo -l -U deploy`                                                                                                                                                                          | no docker group; one sudo command          |
| 7   | Only 80/443 open                           | `nmap -Pn -p 1-65535 <reserved-ip>` from outside                                                                                                                                                          | 22, 80, 443 only                           |
| 8   | PG/Valkey/PgBouncer unreachable externally | `nc -vz <ip> 5432 6379 6432`                                                                                                                                                                              | refused / filtered                         |
| 9   | Images by digest                           | `sudo zaroorat-deploy status`                                                                                                                                                                             | `APP_IMAGE=…@sha256:…`, SHA = develop head |
| 10  | Readiness                                  | `curl -fsS https://dev-api.zaroorat.com/ready`                                                                                                                                                            | `"status":"ready"`, database+redis ok      |
| 11  | Right environment                          | `curl -fsS https://dev-api.zaroorat.com/health`                                                                                                                                                           | `"environment":"dev"`                      |
| 12  | HTTP→HTTPS                                 | `curl -sI http://dev-api.zaroorat.com/health`                                                                                                                                                             | 308 to https                               |
| 13  | Internal endpoints hidden                  | `curl -s -o /dev/null -w '%{http_code}' https://dev-api.zaroorat.com/metrics`                                                                                                                             | 404                                        |
| 14  | WebSocket                                  | `curl -si --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGVzdA==' 'https://dev-api.zaroorat.com/socket.io/?EIO=4&transport=websocket'` | `101 Switching Protocols`                  |
| 15  | Runtime role restricted                    | `dc exec -T postgres psql -U zaroorat -d zaroorat_dev -f /dev/stdin < scripts/db/verify-roles.sql`                                                                                                        | script's PASS lines                        |
| 16  | Worker alive                               | `dc exec -T worker node -e "fetch('http://127.0.0.1:3001/ready').then(r=>console.log(r.status))"`                                                                                                         | 200                                        |
| 17  | OTP end-to-end                             | login OTP to a test phone from the DEV app                                                                                                                                                                | SMS arrives; `auth-otp` job completes      |
| 18  | Log rotation                               | `docker inspect zaroorat-dev-api-1 --format '{{.HostConfig.LogConfig}}'`                                                                                                                                  | max-size 10m                               |
| 19  | Backup restorable                          | restore the newest dump into `zaroorat_restore_check`, run `verify-roles.sql`, drop it                                                                                                                    | succeeds                                   |
| 20  | Rollback works                             | deploy twice, `zaroorat-deploy rollback`                                                                                                                                                                  | previous digest live, `/ready` 200         |

## 21. Rollback procedure

1. **Application only** (the usual case). On the droplet: `sudo /usr/local/sbin/zaroorat-deploy rollback`. This restores the previous digests **and** the matching git checkout (compose/Caddyfile), then checks `/ready`. It goes back one step only, by design.
2. **Re-deploy a known-good commit.** Revert the bad commit on `develop` through a PR, and the pipeline deploys the revert. This is preferred over rolling forward by hand.
3. **Schema problem** (a migration broke data):
   1. `dc stop api worker`.
   2. Restore the pre-deploy dump: `docker exec -i zaroorat-dev-postgres-1 pg_restore -U zaroorat -d zaroorat_dev --clean --if-exists < /opt/zaroorat/backups/<file>.dump`.
   3. `zaroorat-deploy rollback`.
   4. For DEV, take a manual dump before deploying any risky migration: `docker exec zaroorat-dev-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > /opt/zaroorat/backups/pre-<sha>.dump`.
4. **Whole host lost.** Recreate from the DO weekly backup, or rebuild with §18 + the newest dump + `zaroorat-deploy deploy <last sha> …`.

## 22. Remaining production-readiness gaps (not needed for DEV)

**Capacity, for the stated target (10,000 concurrent drivers, GPS every 5 s, 24/7).** No benchmark exists, so nothing here claims a size works. The arithmetic says where the limits sit:

- **GPS ingress.** 10,000 / 5 s = **2,000 location frames/s**. `REALTIME_LOCATION_PERSIST_INTERVAL_MS=5000` allows up to 2,000 row writes/s plus PostGIS/H3 index maintenance.
- **Database load.** On 2026-11-15 a GPS frame cost about **12 PostgreSQL round trips** (`MEMORY`, from code reading; may have changed). That suggests on the order of **20,000+ queries/s**, which is beyond one PostgreSQL on an 8 GiB droplet until measured and reduced. Batching or coalescing location writes, and caching active-ride lookups in Valkey, are the obvious levers.
- **PgBouncer** is single-threaded (one core). At these rates it needs `so_reuseport` multi-process or a managed pooler.
- **Socket.IO.** 10k sockets (+ pings every 25 s = 400/s) are fine on memory. Fan-out through the Redis adapter scales with rooms × emits. Run ≥ 2 API nodes behind the DO Load Balancer with **sticky sessions** (or force websocket-only transport).
- **Worker placement.** The outbox relay and its consumers run in every API replica (`MEMORY`). Confirm they are safe to run concurrently, or move them to the worker.
- **Valkey.** Data volume is small (live locations ≈ a few MB, BullMQ modest), but it is a single point of failure. Production needs managed Valkey with HA, still with `noeviction`.

**Architecture.**

- Managed PostgreSQL with PostGIS and HA. **Time-sensitive** (`MEMORY`, re-verify): from **30 Nov 2026**, new DO Standard clusters cap at 4 GiB, and the Advanced edition has no PostGIS. Decide before that date if a managed cluster is wanted.
- Load balancer.
- Separate staging credentials (DO-16).
- Dedicated migration owner (DO-25).
- Pinned images (DO-18).
- Rewrite of the staging/production workflows for Compose + digest promotion (DO-28).

**Disaster recovery.**

- PITR (WAL archiving) or managed backups.
- Off-site copies (Spaces).
- Documented RPO/RTO.
- Quarterly restore drills.

**Observability.**

- Central logs.
- Prometheus scraping of the API `/metrics` (internal) and the worker `:3001/metrics`.
- Alerting on queue depth, failed jobs, DB connections, and Valkey memory against `maxmemory`.

**Security.**

- Repo visibility: the repo is public, while infrastructure docs and templates live in it.
- Admin MFA (claimed in the guide, not verified).
- WAF/rate limiting at the edge.
- SBOM and image signing.

---

## Appendix — Required end-of-audit answers

### A. Critical issues that must be fixed before DEV deployment

1. **DO-01.** Rotate the leaked DEV Google Maps key and AWS key pair (owner), then scrub both files.
2. **DO-02.** Loader: stop requiring `.env.dev` in containers.
3. **DO-03.** Add a Razorpay test webhook secret (template placeholder + server value).
4. **DO-04.** Make `deploy/bin` scripts executable (and install root-owned copies).
5. **DO-05.** GitHub env `dev`: `DEPLOY_HOST`, `API_URL`, `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS`, branch policy; protect `develop`.
6. Plus the server bootstrap (§18 C), DNS (§18 D) and GHCR credentials. Without them nothing can deploy.

Strongly recommended in the same change set, because they decide whether the first automated deploy is safe and observable: DO-06, DO-07, DO-08, DO-09, DO-10, DO-11, DO-12.

### B. Files that need modifications

| File                                                       | Change                                                                                         | Finding            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------ |
| `docs/DEPLOYMENT/DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md` | Replace credential values with placeholders; correct the walkthrough (or point to this report) | DO-01, DO-19       |
| `deploy/env/.env.dev.example`                              | Airtel ids → placeholders; `PAYMENT_WEBHOOK_SECRET` placeholder                                | DO-01, DO-03       |
| `src/config/env/loader.ts`                                 | Drop `dev` and the `.env.dev` fallback                                                         | DO-02, DO-20       |
| `tests/unit/config/env-loader.test.ts`                     | Add a dev-without-file case; resolve the legacy case (Q10)                                     | DO-20              |
| `package.json`                                             | `dev`, `start`, `worker` scripts → local-only; optional `overrides.effect` + lockfile (Q4)     | DO-11, DO-06       |
| `deploy/bin/deploy.sh`                                     | Rewrite: validated subcommands deploy/rollback/status, release files, readiness                | DO-07–DO-10, DO-29 |
| `deploy/bin/ssh-entry.sh`                                  | Rewrite: strict regex, `sudo -n`                                                               | DO-07              |
| `deploy/bin/rollback.sh`, `deploy/bin/status.sh`           | **Delete** (merged into `deploy.sh`)                                                           | DO-09              |
| `.github/workflows/deploy-dev.yml`                         | Gate, branch guard, digests, SSH hardening, smoke                                              | DO-05/06/08/10/22  |
| `.github/workflows/ci.yml`                                 | `workflow_call`, test timeout 40, smoke with the DEV template                                  | DO-06, DO-20       |
| `.github/workflows/security.yml`                           | `workflow_call`, gitleaks `--redact`, pin Trivy                                                | DO-12              |
| `src/modules/payments/errors/payment.errors.ts`            | `prettier --write` only                                                                        | DO-06              |
| _(optional)_ `deploy/caddy/Caddyfile`                      | ACME email, HSTS                                                                               | DO-24              |
| _(optional)_ `compose.dev.yml`                             | Pin caddy/valkey/postgis; `REDISCLI_AUTH`                                                      | DO-18, DO-26       |
| _(optional)_ `scripts/db-backup.sh`                        | Drop `--no-privileges`                                                                         | DO-17              |

### C. Files that should remain unchanged

`Dockerfile`, `.dockerignore`, `compose.local.yml`, `compose.test.yml`, `compose.staging.yml`, `compose.prod.yml` (until staging work), `prisma/**` (schema and all migrations), `prisma.config.ts`, `scripts/db/*.sql`, `scripts/create-admin.ts`, `docker/postgres/**`, all of `src/**` except `loader.ts` and the one Prettier fix, `.github/workflows/{prisma-check,release,staging,production}.yml` (for DEV), `infrastructure/helm/**`, `.gitignore`. No ride business logic, UI or API behaviour changes.

### D. Exact recommended code changes

**D-1. Scrub the public files** (after rotation).

- In `DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md` §2, replace every literal value on lines 58–85 with `REPLACE_WITH_<NAME>`, keeping the provider names.
- In `deploy/env/.env.dev.example`: `AIRTEL_CUSTOMER_ID=`, `AIRTEL_USERNAME=` and `AIRTEL_ENTITY_ID=` become `REPLACE_WITH_AIRTEL_…`, and set `PAYMENT_WEBHOOK_SECRET=REPLACE_WITH_RAZORPAY_TEST_WEBHOOK_SECRET`.
- Overwrite rather than leave diff trails with the old values in logs or tools (see the secret-handling note in DO-01).

**D-2. `src/config/env/loader.ts`.**

```diff
-// First match wins. Standard local environment loads from .env.local.
-// Deployed environments (dev, staging, production) rely on injected variables or explicit --env-file.
+// First match wins. Only developer machines and the test runner read a dotenv file.
+// Deployed environments (dev, staging, prod) get injected variables from Compose and
+// must never fall back to a developer's local file.
 const ENV_FILES: Record<string, readonly string[]> = {
   local: ['.env.local'],
-  development: ['.env.local', '.env.dev'],
-  dev: ['.env.dev', '.env.local'],
+  development: ['.env.local'],
   test: ['.env.test'],
   testing: ['.env.test'],
 };
```

Test to add in `tests/unit/config/env-loader.test.ts`: `APP_ENV=dev` with an empty root → `loadEnvironment()` does not throw and loads nothing.

**D-3. `package.json` scripts.**

```diff
-    "dev": "tsx watch --env-file=.env.dev src/server.ts",
+    "dev": "tsx watch --env-file=.env.local src/server.ts",
-    "start": "node --env-file=.env.prod dist/server.js",
+    "start": "node dist/server.js",
-    "worker": "node --env-file=.env.prod dist/worker.js",
+    "worker": "node dist/worker.js",
```

Optional (Q4), then `npm install` to refresh the lockfile, and verify `npx prisma generate` and `prisma migrate status`:

```json
  "overrides": { "effect": "3.22.5" }
```

**D-4. `deploy/bin/ssh-entry.sh`** (installed as `/usr/local/sbin/zaroorat-ssh-entry`, root:root 0755; git mode 100755).

```bash
#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key (authorized_keys: restrict,command="…").
set -euo pipefail
cmd=${SSH_ORIGINAL_COMMAND:-}
if [[ $cmd =~ ^deploy\ ([0-9a-f]{40})\ (sha256:[0-9a-f]{64})\ (sha256:[0-9a-f]{64})$ ]]; then
  exec sudo -n /usr/local/sbin/zaroorat-deploy deploy "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
elif [[ $cmd == status || $cmd == rollback ]]; then
  exec sudo -n /usr/local/sbin/zaroorat-deploy "$cmd"
fi
echo "denied: allowed are 'deploy <sha> <app-digest> <ops-digest>', 'status', 'rollback'" >&2
exit 1
```

**`deploy/bin/deploy.sh`** (installed as `/usr/local/sbin/zaroorat-deploy`, root:root 0755; git mode 100755; replaces `rollback.sh` and `status.sh`).

```bash
#!/usr/bin/env bash
# DEV deploy entry point. Runs as root via sudo from zaroorat-ssh-entry.
# Install after every reviewed change:
#   install -o root -g root -m 0755 /opt/zaroorat/src/deploy/bin/deploy.sh /usr/local/sbin/zaroorat-deploy
set -euo pipefail
umask 077

SRC=/opt/zaroorat/src
ENV_FILE=/opt/zaroorat/env/dev.env
STATE=/opt/zaroorat/state
REPO=ghcr.io/zaroorat-mobility/zaroorat-backend

die() { echo "error: $*" >&2; exit 1; }

# $1 = release file (APP_IMAGE, OPS_IMAGE, GIT_SHA); the rest goes to docker compose.
dc() {
  local release=$1; shift
  APP_ENV_FILE=$ENV_FILE docker compose --project-directory "$SRC" -f "$SRC/compose.dev.yml" \
    --env-file "$ENV_FILE" --env-file "$release" "$@"
}
ready() { # release service port
  dc "$1" exec -T "$2" node -e \
    "fetch('http://127.0.0.1:$3/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}
sha_of() { sed -n 's/^GIT_SHA=//p' "$1"; }
start() { # release: matching checkout, containers, then readiness of api and worker
  git -C "$SRC" checkout --quiet --detach "$(sha_of "$1")" &&
    dc "$1" up -d --no-build --wait --wait-timeout 180 api worker caddy &&
    ready "$1" api 3000 && ready "$1" worker 3001
}
lock() { exec 9>/run/lock/zaroorat-deploy.lock; flock -w 600 9 || die "another deploy is still running"; }

deploy() {
  local sha=$1 app=$2 ops=$3 next=$STATE/next.env rev
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "invalid commit sha"
  [[ $app =~ ^sha256:[0-9a-f]{64}$ && $ops =~ ^sha256:[0-9a-f]{64}$ ]] || die "invalid image digest"
  lock
  git -C "$SRC" fetch --quiet origin develop
  git -C "$SRC" merge-base --is-ancestor "$sha" origin/develop || die "$sha is not on origin/develop"
  docker pull --quiet "$REPO@$app" > /dev/null
  docker pull --quiet "$REPO@$ops" > /dev/null
  rev=$(docker image inspect "$REPO@$app" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  [[ $rev == "$sha" ]] || die "image was built from $rev, not $sha"
  printf 'APP_IMAGE=%s@%s\nOPS_IMAGE=%s@%s\nGIT_SHA=%s\n' "$REPO" "$app" "$REPO" "$ops" "$sha" > "$next"
  git -C "$SRC" checkout --quiet --detach "$sha"
  dc "$next" run --rm migrate    # a failed migration stops here; the running release is untouched
  dc "$next" run --rm db-roles
  if start "$next"; then
    if [[ -f $STATE/current.env ]]; then mv "$STATE/current.env" "$STATE/previous.env"; fi
    mv "$next" "$STATE/current.env"
    echo "deployed $sha"
  else
    echo "new release failed its health checks" >&2
    if [[ -f $STATE/current.env ]]; then start "$STATE/current.env" || echo "restoring the previous release ALSO failed" >&2; fi
    exit 1
  fi
}

rollback() {
  lock
  [[ -f $STATE/previous.env ]] || die "no previous release recorded"
  start "$STATE/previous.env" || die "previous release failed its health checks"
  mv "$STATE/current.env" "$STATE/rolled-back.env"
  mv "$STATE/previous.env" "$STATE/current.env"
  echo "rolled back to $(sha_of "$STATE/current.env"); database migrations are NOT reverted"
}

status() {
  [[ -f $STATE/current.env ]] || die "nothing deployed yet"
  cat "$STATE/current.env"
  dc "$STATE/current.env" ps
  if ready "$STATE/current.env" api 3000; then echo "api: ready"; else echo "api: NOT ready"; fi
  if ready "$STATE/current.env" worker 3001; then echo "worker: ready"; else echo "worker: NOT ready"; fi
}

case "${1:-}" in
  deploy)   [[ $# -eq 4 ]] || die "usage: deploy <sha> <app-digest> <ops-digest>"; deploy "$2" "$3" "$4" ;;
  rollback) [[ $# -eq 1 ]] || die "usage: rollback"; rollback ;;
  status)   [[ $# -eq 1 ]] || die "usage: status"; status ;;
  *)        die "usage: deploy <sha> <app-digest> <ops-digest> | rollback | status" ;;
esac
```

Then: `git rm deploy/bin/rollback.sh deploy/bin/status.sh && git update-index --chmod=+x deploy/bin/deploy.sh deploy/bin/ssh-entry.sh`.

**D-5. `.github/workflows/deploy-dev.yml`** (full replacement; pin the `uses:` lines to SHAs with Dependabot afterwards, DO-18).

```yaml
name: Deploy DEV (DigitalOcean)

on:
  push:
    branches: [develop]
  workflow_dispatch:

concurrency:
  group: deploy-dev
  cancel-in-progress: false

permissions:
  contents: read

env:
  REGISTRY: ghcr.io
  # Fixed, not github.repository (= zaroorat-mobility/zaroorat-back): the compose files and
  # deploy/bin/deploy.sh pull ghcr.io/zaroorat-mobility/zaroorat-backend.
  IMAGE_NAME: zaroorat-mobility/zaroorat-backend

jobs:
  ci:
    if: github.ref == 'refs/heads/develop'
    uses: ./.github/workflows/ci.yml

  security:
    if: github.ref == 'refs/heads/develop'
    uses: ./.github/workflows/security.yml
    permissions:
      contents: read
      security-events: write

  build:
    name: Build & Push Images
    needs: [ci, security]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      packages: write
    outputs:
      app_digest: ${{ steps.app.outputs.digest }}
      ops_digest: ${{ steps.ops.outputs.digest }}
    steps:
      - uses: actions/checkout@v5
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build & push runtime image
        id: app
        uses: docker/build-push-action@v6
        with:
          context: .
          target: prod
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }}
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:dev-latest
          labels: |
            org.opencontainers.image.revision=${{ github.sha }}
            org.opencontainers.image.source=https://github.com/${{ github.repository }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: Build & push ops image
        id: ops
        uses: docker/build-push-action@v6
        with:
          context: .
          target: ops
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }}-ops
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:dev-ops-latest
          labels: |
            org.opencontainers.image.revision=${{ github.sha }}
            org.opencontainers.image.source=https://github.com/${{ github.repository }}
          cache-from: type=gha

  deploy:
    name: Deploy to DigitalOcean DEV
    needs: [build]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment:
      name: dev
      url: https://dev-api.zaroorat.com
    steps:
      - name: Deploy over SSH (pinned host key, restricted key)
        env:
          DEPLOY_HOST: ${{ vars.DEPLOY_HOST || secrets.DEPLOY_HOST }}
          SSH_KEY: ${{ secrets.SSH_PRIVATE_KEY }}
          KNOWN_HOSTS: ${{ secrets.SSH_KNOWN_HOSTS }}
          APP_DIGEST: ${{ needs.build.outputs.app_digest }}
          OPS_DIGEST: ${{ needs.build.outputs.ops_digest }}
        run: |
          for v in DEPLOY_HOST SSH_KEY KNOWN_HOSTS APP_DIGEST OPS_DIGEST; do
            [ -n "${!v}" ] || { echo "::error::$v is empty (Settings → Environments → dev)"; exit 1; }
          done
          install -m 700 -d ~/.ssh
          printf '%s\n' "$SSH_KEY" > ~/.ssh/deploy_key && chmod 600 ~/.ssh/deploy_key
          printf '%s\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts
          ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
              -o ConnectTimeout=20 -o ServerAliveInterval=30 \
              "deploy@$DEPLOY_HOST" "deploy $GITHUB_SHA $APP_DIGEST $OPS_DIGEST"

      - name: Verify public HTTPS endpoint
        env:
          API_URL: ${{ vars.API_URL || 'https://dev-api.zaroorat.com' }}
        run: |
          curl -fsS --retry 10 --retry-delay 6 --retry-all-errors "$API_URL/ready"
          curl -fsS "$API_URL/health" | grep -q '"environment":"dev"' \
            || { echo "::error::$API_URL is not answering as the dev environment"; exit 1; }
```

**D-6. `.github/workflows/ci.yml` and `security.yml`.**

- Both: add `workflow_call:` under `on:`.
- `ci.yml` job `test`: `timeout-minutes: 15` → `40`.
- `ci.yml` "Smoke-test the image": after the existing run, add a second container started with `--env-file deploy/env/.env.dev.example -e PAYMENT_WEBHOOK_SECRET=ci_dummy_not_real -e DB_BOOT_RETRIES=1` instead of the hand-picked `-e` list, asserting the same `at async bootstrapDatabase` line. This catches loader and template drift (DO-02/DO-20). The `-e PAYMENT_WEBHOOK_SECRET` override is only needed until D-1 puts a non-empty placeholder in the template.
- `security.yml`: `gitleaks detect --source . -v` → `gitleaks detect --source . --redact -v`; `aquasecurity/trivy-action@master` → a pinned release tag or SHA.

**D-7. One-line fixes.** `npx prettier --write src/modules/payments/errors/payment.errors.ts`. Optional Caddyfile global block `{ email <ops address> }` plus `header Strict-Transport-Security "max-age=31536000"` inside the site block.

### E. Exact server-side commands

§18 C (bootstrap), §19 (first deploy, seed, admin), §21 (rollback/restore). Every command is idempotent or one-time, as marked.

### F. DEV deployment checklist

- [ ] Owner rotated the Google Maps key and AWS key pair (DO-01); new Maps key restricted
- [ ] D-1 … D-7 merged to `develop` via PR, with CI and Security green
- [ ] Droplet created (BLR1, Ubuntu 24.04, Reserved IP, Monitoring, Backups) and Cloud Firewall attached (22/80/443)
- [ ] §18 C run: Docker, log rotation, opsadmin, deploy user + forced command + sudoers, sshd hardening, fail2ban, UFW
- [ ] `/opt/zaroorat/src` cloned (root-owned); wrapper scripts installed to `/usr/local/sbin`
- [ ] `/opt/zaroorat/env/dev.env` complete: no `REPLACE_WITH_` left (`grep -c REPLACE_WITH_` = 0), mode 0600
- [ ] `docker login ghcr.io` with the read-only PAT as root
- [ ] DNS `dev-api` A record (grey cloud) resolves to the Reserved IP
- [ ] GitHub env `dev`: branch policy `develop`; `DEPLOY_HOST`, `API_URL`, `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS` set; `develop` protected
- [ ] Razorpay test webhook created → secret in `dev.env`
- [ ] First deploy green; seed + first admin done (§19)
- [ ] Verification checklist §20 rows 1–20 pass
- [ ] Backup cron present; first dump restored once successfully

### G. Questions requiring your approval

1. **Approve the change set §D-1 … §D-7?** (These are all the repo edits; nothing is applied until you say so.) DO-01 rotation is yours to do in the Google and AWS consoles first.
2. **Deploy account model:** sudo-wrapped `deploy` user without the docker group (recommended), or the simpler docker-group user (root-equivalent; forced command only)?
3. **Pricing code on DEV (DO-13):** `develop` now carries pricing phases 1–7 and their migrations, merged while CI was red. Deploy that to DEV (recommended: DEV exists to surface it), or deploy an earlier commit first?
4. **Security gate:** block DEV deploys on high `npm audit` findings? If yes, approve the `effect` override in `package.json` + lockfile (D-3), or accept a documented exception for this CLI-only advisory.
5. **SSH exposure:** keep port 22 open to the internet for DEV (key-only + fail2ban + forced command), and move to a Tailscale tunnel before staging?
6. **GHCR access:** read-only PAT on the droplet (recommended; keeps images private), or make the package public (the source is already public)?
7. **DEV integrations:** confirm DEV may send **real SMS** (Airtel), use AWS S3 `ap-south-1` (not DO Spaces), a DEV Firebase project, and Razorpay **test** mode. Deployed environments refuse mocks by design.
8. **Laptop scripts and secrets (DO-11/16):** remove the `prod`/`staging` npm scripts that run deployed configs from a laptop, and move `.env.prod` / `.env.staging` off this machine?
9. **Working-tree file (DO-21):** discard the uncommitted, older `.github/workflows/deploy-dev.yml` on this laptop?
10. **Loader legacy test (DO-20):** delete the obsolete `.env.development` fallback test (recommended), or restore that fallback?
11. **AI Analyzer (DO-30):** where does it live? It is not in `zaroorat-back`.
12. **Droplet size:** 2 vCPU / 4 GiB (≈$24/mo) or 4 vCPU / 8 GiB (≈$48/mo)?
13. **ACME contact email** for the Caddyfile.
14. **Time-sensitive production item:** a decision on DO Managed PostgreSQL (PostGIS, HA) before the 30 Nov 2026 plan change. Re-verify the date first.

_End of audit. No corrections have been implemented._
