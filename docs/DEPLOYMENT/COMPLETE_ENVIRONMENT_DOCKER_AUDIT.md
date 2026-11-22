# Zaroorat Backend — Complete Environment, Docker, Migration & Admin Setup Audit

|                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date             | 2026-11-21 (working tree read 23:15–23:32 IST)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Repository       | `zaroorat-back`, branch `pricing/phase0-integration` @ `1fcd166` (27 ahead / 3 behind `origin/main` `53d3cf1`)                                                                                                                                                                                                                                                                                                                                                                                             |
| Working tree     | **All deployment work is uncommitted**: 48 modified tracked files, including `Dockerfile`, `compose.dev.yml`, `compose.prod.yml`, `Makefile`, `package.json`, `src/config/env/*`; `.env.example` deleted. Untracked: `compose.local.yml`, `compose.staging.yml`, `deploy/`, `.github/workflows/deploy-dev.yml`, `scripts/create-admin.ts`, `docs/DEPLOYMENT/`, one migration (`20261118174500_relax_tax_config_direct_activation`). About 23 of the modified files are unrelated pricing work in progress. |
| Remote           | `origin/develop` = `4355299` (October). It does **not** contain `deploy-dev.yml`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Mode             | Read-only. No source, Compose, env, package or migration file was changed. Nothing was migrated, seeded, started, deployed, committed or pushed. This report is the only file written.                                                                                                                                                                                                                                                                                                                     |
| Concurrent edits | Another session rewrote `README.md` at 23:19 during the audit. A hash check at 23:32 showed that no audited configuration file changed.                                                                                                                                                                                                                                                                                                                                                                    |
| Supersedes       | The DEV/LOCAL parts of `docs/DEPLOYMENT/FULL_MULTI_ENV_DOCKER_AUDIT.md` (2026-11-19, F01–F40). Section 13 maps those findings to their current status.                                                                                                                                                                                                                                                                                                                                                     |

### Status update — 2026-11-22 (uncommitted fixes; the findings below are kept as written on 2026-11-21)

| Finding                             | Status                                                                                                                                                                                                                                                                                                   | By                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A02 `TRUSTED_PROXIES="false"`       | Fixed in `.env.local` (`loopback`)                                                                                                                                                                                                                                                                       | other session          |
| A04 container env file / loader     | `compose.local.yml` now mounts `.env.local` read-only                                                                                                                                                                                                                                                    | other session          |
| A05 migrate container loopback URL  | `compose.local.yml` overrides `MIGRATION_DATABASE_URL`                                                                                                                                                                                                                                                   | other session          |
| A01, A24 environment names          | **Fixed.** `src/config/env/environment.ts` (`normalizeEnvironment`, `isDeployed`, `servesRealUsers`, `isLocal`); `APP_ENV` required and normalised in `schema.ts`; every guard uses a helper. Deviation: the malware scanner stays optional on `dev`, because DEV uses DigitalOcean Spaces (D2 is open). | this audit's follow-up |
| A03 local OTP log, CORS, debug logs | **Fixed** through `isLocal`; `REALTIME_CORS_ORIGINS="*"` now means any origin                                                                                                                                                                                                                            | this audit's follow-up |
| A06 Postgres init                   | **Fixed** for new volumes (idempotent, local and test only). Confirmed at runtime: today's local volume hit the error and has no `zaroorat_test`.                                                                                                                                                        | this audit's follow-up |
| A07 local template                  | **Fixed**: `.env.local.example` (no secret values) and the loader hint                                                                                                                                                                                                                                   | this audit's follow-up |
| A38 `JWT_*_EXPIRES_IN`              | `jwt.config.ts` now reads them                                                                                                                                                                                                                                                                           | other session          |

Verification: new `tests/unit/config/environment-names.test.ts` (75 cases) and 2 cases added to `resubmission-backfill.test.ts`, all passing. `typecheck` and `eslint` are clean. The full unit suite has 2276 tests with 14 failing, none caused by these changes:

- 8 are known baseline failures;
- 2 in `deployment-push-config` come from the `compose.prod.yml` rewrite and the deleted `.env.example`;
- 4 in `deny-by-default` and `error-handler` are caused by the missing `zaroorat_test` database (A06 on the existing volume).

Backup and patch: `_wip-backups/2026-11-22-env-names/`.

#### Later on 2026-11-22: test database, local runtime check, DEV blockers

**Test database.** `zaroorat_test` was created in the running local Postgres. All 87 migrations then applied to it cleanly (the first fresh-database run of the 11 newest migrations), followed by the test seed. The 4 database-dependent unit failures now pass: the unit suite is 2276 tests, 10 failing, all pre-existing.

**Local runtime check** (API and worker rebuilt, both healthy):

| Check                          | Result                   |
| ------------------------------ | ------------------------ |
| `/health` environment          | `local`                  |
| HTTP CORS for a browser origin | allowed                  |
| Socket.IO CORS                 | allowed                  |
| OTP with mock SMS              | printed in the debug log |

**DEV blockers:**

| Finding                             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A08 deploy commit id                | **Fixed.** `deploy-dev.yml` sends the raw SHA.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A09 image name                      | **Fixed.** The workflow publishes `zaroorat-mobility/zaroorat-backend`, with an `org.opencontainers.image.source` label. GitHub-side package permissions: BLOCKED.                                                                                                                                                                                                                                                                                              |
| A10 first-admin bootstrap           | **Fixed.** `scripts/create-admin.ts` refuses if a `system_admin` exists (unless `--additional`) or if the email or phone matches any account; it has no defaults, requires a password of 12+ characters, and writes the user, role and audit row in one locked transaction. The Makefile, npm scripts and guide pass `-e ADMIN_*` through. `tests/integration/create-admin.test.ts`: 13 cases. A mutation check confirmed the race test fails without the lock. |
| A14 infra secrets in app containers | **Fixed.** An `x-no-infra-secrets` anchor blanks `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `REDIS_PASSWORD` and `MIGRATION_DATABASE_URL` in `api`, `worker` and `ops` (`ops` keeps its explicit owner URL). Verified with `docker compose config`. No env file changed.                                                                                                                                                                                           |

One unexplained integration failure: on the first combined run with `admin-staff.test.ts`, one create-admin case stalled for 138 s and then hit a `user_profiles_user_id_fkey` violation. Three later runs passed, including the same order. The likely cause is contention on the shared test database, but it was not proven.

Backup and patch: `_wip-backups/2026-11-22-dev-blockers/`.

### Status legend

| Mark             | Meaning                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**         | Verified in this audit, by code reading plus a non-mutating check where one was possible.                                                                                                           |
| **PASS (11-19)** | Verified at runtime on 2026-11-19 against a structurally identical stage or service, and not re-run today. The Dockerfile diff since then only renames stages and adds aliases and the `ops` stage. |
| **FAIL**         | A confirmed problem. The evidence is cited.                                                                                                                                                         |
| **BLOCKED**      | Could not be verified because a dependency is unavailable: GitHub settings (no `gh` CLI), the droplet, DNS, or real third-party credentials.                                                        |
| **NOT RUN**      | Would require running the stack, a migration, a seed or the tests, which this audit does not do.                                                                                                    |

### Non-mutating checks executed

- `docker compose --env-file .env.<env> -f compose.<env>.yml --profile ops config -q` and `config --images` for all five stacks. These parse and interpolate only; no daemon calls and no containers are created.
- A key-name-only dump of each service's resolved environment. No values were printed.
- Env files were read through a masking script: key names, emptiness, length and placeholder detection only. Cross-file equality of secret values was checked without printing them.
- `node --env-file=<missing>` and `tsx --env-file=<missing>` were run in a scratch directory.
- `resolveTrustProxy()` and `shouldLogDevOtp()` (both pure functions) were called directly through `tsx`.
- `git ls-remote`, `git diff`, `git log`. No `git fetch`.

**No secret value appears in this report.**

---

## 1. Executive summary

### Verdict per environment

| Environment    | Verdict                                                                                                                                                                                         | Blocking findings                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **LOCAL**      | **NOT READY.** Neither the host-run API nor the Docker stack can start, and nobody could log in even if they did.                                                                               | A02, A03, A04, A05, A06, A07                                  |
| **DEV**        | **NOT READY.** The CI → droplet deploy fails on its first two commands. The database superuser password is handed to the app containers. The admin bootstrap can take over an existing account. | A01, A08, A09, A10, A14, A15 (plus real credentials: BLOCKED) |
| **TEST**       | **Configuration PASS. Suite NOT RUN.** The CI test job is still capped at 15 minutes.                                                                                                           | A21                                                           |
| **STAGING**    | **NOT READY.** There is no working build/deploy path for Compose, and file uploads would fail under the current storage settings.                                                               | A11, A12, A17, A18                                            |
| **PRODUCTION** | **NOT READY.** `APP_ENV=prod` silently switches off five production safety guards. There is also no deploy path, no usable backup and no safe first-admin procedure.                            | A01, A10, A11, A13, A17, A22, A25                             |

### The ten most important problems, in plain language

1. **The production name `prod` is not recognised by most of the safety checks** (A01). The code was written for `production`. With the new name `prod`:
   - the app no longer refuses to start with an over-privileged database user;
   - it would accept a fake ("mock") payment gateway that reports every charge as paid;
   - it would accept SMS and push providers that deliver nothing;
   - it would skip the mandatory virus scanning of uploads;
   - if `STORAGE_PROVIDER` is ever unset, it would store files in memory only.

   The env files happen to set the right providers today, but the safety net is gone. `dev` has the same gaps for payments, notifications and scanning.

2. **LOCAL cannot start at all** (A02–A07):
   - `.env.local` sets `TRUSTED_PROXIES="false"`, a value the code rejects, so the API crashes on every start (verified).
   - The Docker version of LOCAL breaks in four separate ways (missing env file inside the container, migration pointed at the wrong host, a duplicate database in the Postgres init script, no template for new developers).
3. **Local login is impossible** (A03). Local SMS is fake, so the code is meant to print the OTP to the log, but it only does that when the environment is called `development`, not `local`. Browser CORS is also closed, so the admin panel cannot call the API.
4. **The automatic DEV deployment fails immediately** (A08, A09). The workflow sends `sha-<commit>` where the server script expects a raw commit id. It also pushes the image under the repository name `zaroorat-back`, while the server pulls `zaroorat-backend`.
5. **The first-admin script is dangerous** (A10). If the email or phone you give matches any existing user (a customer, a driver, or an old deleted account), the script overwrites that person's login and makes them **system admin**. If `ADMIN_PHONE` is not given, it binds the admin to `+919999999999`, a real-format number whose owner could then log in as admin via SMS OTP. The documented `make`/`npm` commands also never pass the password into the container, so as written they always fail.
6. **The database superuser password is inside the API and worker containers** (A14, verified). The design separates a restricted "runtime" database user from the owner, but the same env file feeds both Compose and the app, so the app also receives the owner and superuser credentials.
7. **There is no working path to staging or production** (A11). The production stack refuses to start without an `IMAGE_TAG` that nothing supplies (verified). No workflow builds the images the staging/production Compose files expect, and the staging/production workflows still target Kubernetes.
8. **Backups would not restore a working system** (A17). The backup script dumps without permissions, only knows the local env file, and on a server would connect as a user that is forbidden to read the migration table. Backups are not scheduled and stay on the same machine.
9. **Re-running the seed on a live database resets real data** (A18): fares, role permissions, app themes and fonts revert to built-in defaults.
10. **Payment and refund background jobs run far less often than the code intends** (A26). Every env file overrides the schedules, and refund reconciliation drops from every 5 minutes to once a day.

### What is already good (verified)

- **Migrations:** no API or worker code path runs them, so they never run once per replica. They connect directly to Postgres, bypassing PgBouncer. Prisma's advisory lock plus `deploy.sh`'s `flock` serialise them. **PASS**
- **Database roles:**
  - the restricted runtime role model is well designed: a NOLOGIN group, audit-table triggers, and verification SQL (`scripts/db/verify-*.sql`). **PASS** (design)
  - the PgBouncer transaction-pooling setup is compatible with the code: only `pg_advisory_xact_lock` and `set_config(..., true)` are used. **PASS**
- **Runtime image:** non-root, `dumb-init` as PID 1, separate production dependencies, Prisma engines baked in so `migrate deploy` works offline, Node version matching `.nvmrc`. **PASS / PASS (11-19)**
- **Network exposure:** server stacks publish only Caddy's ports 80/443; Postgres, Valkey, PgBouncer, API and worker are internal. LOCAL binds to `127.0.0.1`. Caddy blocks `/metrics` and `/docs`. **PASS**
- **Secret separation:** no real secret value is shared between LOCAL/DEV/STAGING/PROD files (masked equality scan). Only SMS template text and one cron string repeat. **PASS**
- **Graceful shutdown:** the API drains for 10 s and the worker drains jobs. Compose `stop_grace_period` (30 s / 150 s) exceeds the app deadlines. **PASS (11-19)**

### Findings count

| Severity                            | Count | IDs     |
| ----------------------------------- | ----- | ------- |
| P0 (blocks the environment)         | 12    | A01–A12 |
| P1 (must fix before the gate shown) | 14    | A13–A26 |
| P2                                  | 11    | A27–A37 |
| P3                                  | 5     | A38–A42 |
| BLOCKED items                       | —     | A43     |

---

## 2. Backend architecture (traced execution flow)

### 2.1 Process topology on a server (DEV/STAGING/PROD Compose)

```
Internet ─► Caddy :80/:443 (TLS, gzip, blocks /metrics,/docs)  deploy/caddy/Caddyfile
              │ reverse_proxy api:3000  (HTTP + Socket.IO websocket on the same port)
              ▼
   ┌──────────── api  (node dist/server.js) ────────────┐      ┌──── worker (node dist/worker.js) ────┐
   │ Fastify routes, auth, RBAC, Socket.IO gateway      │      │ BullMQ workers + job schedulers      │
   │ OutboxRelay polling + 14 in-process consumers      │      │ health server :3001 (/health,/ready, │
   │ /health /ready /metrics /docs                      │      │ /metrics) — internal only            │
   └───────┬───────────────────────────┬────────────────┘      └──────┬───────────────────┬───────────┘
           │ DATABASE_URL              │ REDIS_URL                     │                   │
           ▼                           ▼                               ▼                   ▼
   pgbouncer:6432 (transaction pool) ─► postgres:5432 (PostGIS 17-3.5)        valkey:6379 (AOF, noeviction)
                                          ▲
   migrate (ops image) ── MIGRATION_DATABASE_URL (schema owner, direct, bypasses PgBouncer)
   db-roles (postgis image, psql) ── scripts/db/create-app-login.sql
   ops (ops image: tsx, full source) ── seed / create-admin / ad-hoc prisma
```

### 2.2 API boot (`src/server.ts` → `src/bootstrap/startup.bootstrap.ts:10-33`)

1. Importing `@config` runs `src/config/env/validated-env.ts:3-4`. The loader reads a dotenv file only for `local/development/test/testing` (`loader.ts:7-12`); zod validation then exits the process on failure (`validator.ts:3-12`).
2. `bootstrapDatabase()` (`database.bootstrap.ts:51-75`):
   - retries the connection 10× with backoff;
   - calls `assertRestrictedDatabaseRole` (`:38-49`), which refuses to boot if `DATABASE_URL` can rewrite the audit trail;
   - registers the `database` readiness check.
3. `bootstrapRedis()` → `bootstrapEvents()` (`events.bootstrap.ts`): subscribes 14 consumers and starts the **OutboxRelay in every API replica**.
4. `bootstrapStorage()` is a **no-op** (`storage.bootstrap.ts:1`). Storage, SMS and push providers are lazy awilix singletons (`src/modules/files/index.ts:29-30`, `src/modules/notifications/index.ts:58-59`), so their config errors surface on first use, not at boot (A29).
5. `createApp()` (`src/app/app.ts:8-46`):
   - `resolveTrustProxy()`;
   - plugins in order: swagger (`/docs`), helmet, CORS, sensible, rate-limit, auth (JWT verify plus the `authorize` decorator);
   - hooks, then routes.
6. `bootstrapShutdown()` installs the SIGTERM/SIGINT drain. `app.listen()` follows, then the Socket.IO gateway attaches to the same HTTP server (Redis adapter in deployed environments, `realtime.gateway.ts:133`).

### 2.3 Worker boot (`src/worker.ts` → `worker.bootstrap.ts:20-41`)

1. Database bootstrap (including the restricted-role check), then Redis.
2. `bootstrapQueue()` upserts BullMQ job schedulers. The timezone is **`Etc/UTC`** (`src/jobs/scheduler/index.ts:11,151`).
3. Starts the maintenance workers, the OTP worker and the notification worker. Queues are defined in `src/jobs/queues/index.ts:5-16`, and the BullMQ connection uses `maxRetriesPerRequest: null` (`:43`).
4. Health server on `WORKER_HEALTH_HOST:WORKER_HEALTH_PORT` (default `0.0.0.0:3001`, `src/config/worker/worker.config.ts`).
5. Shutdown drains workers, then queues, Prisma, Redis and the health server. The grace period is `WORKER_SHUTDOWN_GRACE_MS` (default 120 s; env files set 30 s).

### 2.4 Configuration flow

`process.env`, filled by Compose `env_file` + `environment` or by `node --env-file`, goes through `loader.ts` (dotenv, `override: false`) and `schema.ts`, and ends in `validatedEnv`. Many modules then read `process.env` **directly** instead of `validatedEnv`; 306 distinct variable names are read. As a result:

- only 4 variables are schema-required: `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`;
- 4–5 more are required in deployed environments (`schema.ts:55-102`);
- everything else has an in-code default.

### 2.5 Data layer

- **Client:** Prisma 7 with the `@prisma/adapter-pg` driver adapter over a `pg.Pool`. Sizing comes from `DB_POOL_*`; `keepAlive` is on, and idle-client errors are swallowed and logged (`PrismaClientFactory.ts:56-103`). The URL is `DATABASE_URL` only (`DatabaseConfiguration.ts:31-34`); TLS comes from `DB_SSL_MODE` / `DB_SSL_ROOT_CERT` / `DB_SSL_CA`.
- **Migrations:** `prisma.config.ts:43-46` uses `MIGRATION_DATABASE_URL`, falling back to `DATABASE_URL`. The schema is multi-file (`prisma/schema/**`) and declares `extensions = [postgis, pgcrypto]`.
- **Roles:**
  - the group role `zaroorat_app_runtime` (NOLOGIN), CRUD grants and **default privileges** come from migration `20261002130100_admin_audit_truncate_guard_runtime_role` (`:58-74`);
  - the login user (`APP_DB_USER`, default `zaroorat_app`) comes from `scripts/db/create-app-login.sql`, which reads the password through `\getenv APP_DB_PASSWORD`, so it never appears in a process list.
- **Extensions:** created by migrations: `postgis`, `pgcrypto` (init), `btree_gist` (m06, m03/m04). `uuid-ossp` is created only by the local/test init script and is not needed by any migration.

### 2.6 Redis / Valkey

The ioredis client (`src/core/cache/client.ts`) serves cache, rate limits, OTP challenges, session denylist and auth epochs. BullMQ uses its own connections. Socket.IO uses separate pub and sub clients. Server stacks run Valkey 8.1 with AOF and `noeviction`, inside a 512 MB container limit with `maxmemory 384mb` (DEV/STAGING) or 1 GB / 1024 MB (PROD).

### 2.7 Authentication & RBAC

- **Riders and drivers:** phone OTP sent through the SMS provider (`mock` or `airtel`), then JWT access and refresh tokens plus DB sessions.
- **Staff:**
  - email + password (`auth.service.ts:661-676`, scrypt N=16384 r=8 p=1 in `src/modules/auth/utils/password.ts:3-16`), **or** admin phone OTP (`auth.service.ts:640-660`);
  - **no MFA**: `requireMfa` exists only as a settings field (`security.schemas.ts:38`).
- **Authorisation** (`src/modules/auth/plugins/auth.plugin.ts:66-93`):
  - `system_admin` in the JWT `roles` claim **bypasses every role and permission check**;
  - every other staff role is checked against permission codes loaded per request from `role_permissions`, failing closed;
  - admin routes use `authorize({ permissions: [...] })`, e.g. `staff:write` for staff management and `rbac:manage` for RBAC.
  - The comment at `prisma/seed/shared/roles.ts:43-54` claiming permission codes are not enforced is **stale**.

### 2.8 Events, jobs and notifications

1. Domain writes go into an outbox table in the same transaction.
2. `OutboxRelay` (in the API) claims rows and publishes them on the in-process bus.
3. Consumers handle ride, payment, referral, fiscal, realtime and SMS-decision events. Some enqueue BullMQ jobs.
4. The worker delivers SMS (Airtel), push (FCM) and email (SMTP).
5. Scheduled maintenance jobs (dispatch timeout, request expiry, payment and refund reconciliation, settlement, retention) run only in the worker.

### 2.9 Payments, storage, maps (configuration boundary only)

- **Payments:** `mock`, `razorpay` or `stripe` (`payment.config.ts`). Webhook secrets are resolved per provider, falling back to `PAYMENT_WEBHOOK_SECRET`.
- **Storage:** S3-compatible (AWS or DigitalOcean Spaces) with a quarantine bucket and a GuardDuty scanner mode; `mock` locally (`storage.config.ts`).
- **Maps:** `MAP_PROVIDER` (google, mappls, ola or mock) with an offline-routing fallback (`map-policy-resolver.ts:23`).
- **Scope:** business logic in these modules was not re-audited here.

### 2.10 Health, logging and metrics

- **Endpoints:**
  - `/health` is liveness only; it answers 200 with no dependency check (`health.route.ts:25-31`);
  - `/ready` runs the database and Redis checks and answers 503 while draining;
  - `/metrics` and `/docs` are public on the API port, which is safe only because the port is unpublished and Caddy blocks both paths.
- **Logging:** pino JSON with a redaction list. Pretty-printing and `debug` level apply only when `APP_ENV=development` (`logger.ts:7-15`, `transport.ts:3`).

---

## 3. Environment-file audit

### 3.1 Intended mapping vs actual code

| Env     | APP_ENV accepted by schema  | App loader reads a file                                                                          | Prisma config reads                                      | Compose file / env_file                         | Deployed guards recognise the name              | Result                                        |
| ------- | --------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| LOCAL   | `local` ✔ (`schema.ts:4-6`) | `.env.local`, then legacy `.env.development`; **throws if neither exists** (`loader.ts:8,32-34`) | `.env.local`, `.env.development` (`prisma.config.ts:12`) | `compose.local.yml` / `.env.local`              | Dev affordances check only `development` (§3.4) | **FAIL** (A03)                                |
| DEV     | `dev` ✔                     | none (expects injection) ✔                                                                       | `.env.dev` (`:14`)                                       | `compose.dev.yml` / `${APP_ENV_FILE:-.env.dev}` | Partially; see §3.4                             | **FAIL** (A01)                                |
| TEST    | `test` ✔                    | `.env.test`, throws if missing                                                                   | `.env.test`                                              | `compose.test.yml` mounts `.env.test` read-only | ✔                                               | **PASS**                                      |
| STAGING | `staging` ✔                 | none ✔                                                                                           | `.env.staging`                                           | `compose.staging.yml` / `.env.staging`          | ✔                                               | **PASS** for the mapping (configuration: A12) |
| PROD    | `prod` ✔                    | none ✔                                                                                           | `.env.production`, then `.env.prod` (`:18-19`)           | `compose.prod.yml` / `.env.prod`                | **Mostly not** (§3.4)                           | **FAIL** (A01)                                |

`NODE_ENV` (`development` / `test` / `production`) matches the intended table in every env file. It is read in only two places (`core/cache/client.ts:18`, `vehicles/schemas/error-response.ts:53`). **PASS**

### 3.2 How the environment is selected

1. **npm scripts** pass `node --env-file=.env.<x>` or `tsx --env-file=...`. These are hard flags: Node 22.21 exits with code 9 if the file is missing (verified).
2. **The app loader** (`loader.ts:16`) computes `APP_ENV ?? NODE_ENV ?? 'development'`. It loads a file only for `local`, `development`, `test` and `testing`, with `override: false`, so variables already injected win. **PASS**
3. **The Prisma config** (`prisma.config.ts:21-29`) uses the same key to pick a file for **every** name, loads it if present (`override: false`), and never throws.
4. **Compose** reads `--env-file` for `${VAR}` interpolation and `env_file:` for the container environment. `environment:` overrides `env_file:`. **PASS**
5. **If `APP_ENV` is missing**, the schema defaults it to `development` (`schema.ts:6`). That is fail-open (A24).

### 3.3 Required checks

| #   | Check                                                    | Result                                                                                                                                                                                                               | Evidence                                                                         |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | How the environment is selected                          | PASS                                                                                                                                                                                                                 | §3.2                                                                             |
| 2   | Which file is loaded                                     | PASS (documented above)                                                                                                                                                                                              | `loader.ts:7-12`, `prisma.config.ts:11-20`                                       |
| 3   | Automatic vs explicit                                    | Mixed: automatic for local/test, explicit `--env-file` in npm scripts, injected in Compose                                                                                                                           | `package.json:11-51`                                                             |
| 4   | Docker-injected variables override file values           | PASS                                                                                                                                                                                                                 | dotenv `override:false` (`loader.ts:29`); Compose `environment` beats `env_file` |
| 5   | Required variables validated                             | PARTIAL. 4 schema-required plus 4–5 deployed-required. Provider credentials are validated lazily at first use (A29).                                                                                                 | `schema.ts:11-14,55-102`                                                         |
| 6   | App variables mixed with Compose interpolation variables | **FAIL.** The same `.env.<env>` file is used for both, so `POSTGRES_PASSWORD`, `MIGRATION_DATABASE_URL`, `APP_DB_PASSWORD` and `REDIS_PASSWORD` reach `api`, `worker` and `ops` (verified from the resolved config). | A14                                                                              |
| 7   | Conflicting defaults                                     | **FAIL** for job schedules (§3.7). Minor: `WORKER_SHUTDOWN_GRACE_MS` is 120 s in code and 30 s in the env files.                                                                                                     | A26                                                                              |
| 8   | localhost inside containers                              | **FAIL** (LOCAL). `.env.local` `MIGRATION_DATABASE_URL=127.0.0.1:5432` is not overridden in `compose.local.yml`, and the Prisma config prefers it.                                                                   | A05                                                                              |
| 9   | Production secrets usable in DEV                         | PASS: no shared secret values (masked equality scan). Custody risk remains: A22.                                                                                                                                     | §3.6                                                                             |
| 10  | Missing or unsupported names                             | 8 accepted names (`development, local, dev, test, testing, staging, production, prod`), with guards handling them inconsistently. The legacy `.env.development` is still auto-loaded.                                | A01, A22                                                                         |

### 3.4 Environment-name consistency matrix (root cause of A01 and A03)

The uncommitted `schema.ts` change added `local`, `dev` and `prod` to the accepted names, but the guards below were never updated. In this table ✔ means the guard treats the name as intended, ✘ means it does not, and "–" means not applicable.

| Guard                                             | File:line                                                                           | production | **prod**                               | staging                  | **dev**           | development | **local**        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- | -------------------------------------- | ------------------------ | ----------------- | ----------- | ---------------- |
| Refuse a DB role that can rewrite the audit trail | `src/bootstrap/database.bootstrap.ts:39`                                            | ✔          | **✘**                                  | ✔                        | ✔                 | –           | –                |
| Forbid the mock payment gateway                   | `src/config/payment/payment.config.ts:18`                                           | ✔          | **✘**                                  | ✔                        | **✘**             | –           | –                |
| Default gateway = razorpay                        | `payment.config.ts:77-78`                                                           | ✔          | **✘ (mock)**                           | ✔                        | **✘ (mock)**      | –           | –                |
| SMS/push must really deliver                      | `src/modules/notifications/notification.config.ts:13,69,73,119`                     | ✔          | **✘**                                  | ✔                        | **✘**             | –           | –                |
| Malware scanner mandatory                         | `src/modules/files/config/storage.config.ts:39,50-55`                               | ✔          | **✘**                                  | ✔                        | **✘**             | –           | –                |
| Default storage = s3                              | `storage.config.ts:66-69`                                                           | ✔          | **✘ (mock)**                           | ✔                        | ✔                 | –           | –                |
| Bank keys mandatory (crypto module)               | `src/shared/crypto/bank-account-crypto.ts:29-31`                                    | ✔          | ✘ (mitigated by `schema.ts:56-71`)     | ✔                        | ✘ (mitigated)     | –           | –                |
| Deployed-secret validation                        | `src/config/env/schema.ts:56-60`                                                    | ✔          | ✔                                      | ✔                        | ✔                 | –           | –                |
| Realtime Redis adapter default                    | `src/config/realtime/realtime.config.ts:54-63`                                      | ✔          | ✔                                      | ✔                        | ✔                 | –           | –                |
| Realtime CORS default (closed list)               | `realtime.config.ts:26-28`                                                          | ✔          | ✔                                      | ✘ (open `true` if unset) | ✘ (open if unset) | –           | –                |
| HTTP CORS allow-all                               | `src/plugins/cors/cors.plugin.ts:6`                                                 | –          | –                                      | –                        | –                 | ✔           | **✘**            |
| Debug logs / pino-pretty                          | `src/shared/logger/logger.ts:7,11`, `transport.ts:3`                                | –          | –                                      | –                        | –                 | ✔           | **✘**            |
| OTP printed to the log (mock SMS only)            | `src/modules/auth/services/otp/dev-otp-log.ts:6`                                    | –          | –                                      | –                        | –                 | ✔           | **✘** (verified) |
| Mock SMS payload debug                            | `src/modules/notifications/providers/mock.provider.ts:14`                           | –          | –                                      | –                        | –                 | ✔           | **✘**            |
| Rate-limit bypass permitted                       | `src/core/cache/stores/RateLimitStore.ts:15`                                        | –          | –                                      | –                        | –                 | ✔           | ✔                |
| Zero shutdown drain                               | `src/config/server/server.config.ts:11-13`                                          | –          | –                                      | –                        | –                 | ✔           | ✔                |
| Trust-proxy warning                               | `src/app/app.ts:12`                                                                 | ✔          | ✔                                      | ✘                        | ✘                 | –           | –                |
| Backfill script "treat as production"             | `src/modules/admin/driver-management/applications/resubmission-backfill.ts:737-744` | ✔          | ✘ (mitigated by the non-loopback rule) | –                        | –                 | ✔           | ✘                |
| Seed branch                                       | `prisma/seed/index.ts:20-40`                                                        | ✔          | ✔                                      | ✔                        | ✔                 | ✔           | ✔                |
| CI smoke boot                                     | `.github/workflows/ci.yml:194`                                                      | tested     | **untested**                           | untested                 | untested          | –           | –                |

### 3.5 Variable inventory (important variables)

**Columns:**

- **Req:** R = schema-required everywhere; D = required when APP_ENV ∈ {dev, staging, prod, production}; C = required only when another setting selects it; O = optional with an in-code default; X = Compose-only (interpolation).
- **To:** which containers receive the variable today. On server stacks, `api`, `worker` and `ops` receive **every** key in `.env.<env>` through `env_file`; `migrate` receives only `APP_ENV`, `NODE_ENV` and `MIGRATION_DATABASE_URL`.

| Variable                                                                        | Purpose                                            | Req                                    | Envs that need it                                  | Loaded at                                             | To                                                    | Sensitive             |
| ------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | --------------------- |
| `APP_ENV`                                                                       | Environment identity                               | O (defaults to `development`, A24)     | all                                                | `schema.ts:4`                                         | api, worker, ops, migrate                             | no                    |
| `NODE_ENV`                                                                      | Node/runtime mode                                  | O                                      | all                                                | `schema.ts:7`                                         | all                                                   | no                    |
| `HOST`, `PORT`                                                                  | API bind                                           | O                                      | all                                                | `schema.ts:9-10`                                      | api                                                   | no                    |
| `DATABASE_URL`                                                                  | Runtime DB login (via PgBouncer on servers)        | R                                      | all                                                | `DatabaseConfiguration.ts:31`                         | api, worker, ops                                      | **yes** (password)    |
| `MIGRATION_DATABASE_URL`                                                        | Schema owner, for migrations                       | C (servers)                            | dev, staging, prod                                 | `prisma.config.ts:44`                                 | migrate, **and also api/worker/ops (A14)**            | **yes**               |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`                           | Postgres superuser bootstrap                       | X                                      | servers                                            | `compose.*.yml`                                       | postgres, db-roles, **and also api/worker/ops (A14)** | **yes**               |
| `APP_DB_USER` / `APP_DB_PASSWORD`                                               | Runtime login user/password                        | X                                      | servers                                            | `compose.*.yml`, `create-app-login.sql`               | pgbouncer, db-roles, api/worker/ops                   | **yes**               |
| `DB_SSL_MODE`, `DB_SSL_ROOT_CERT`, `DB_SSL_CA`                                  | DB TLS                                             | O                                      | managed DB only                                    | `DatabaseConfiguration.ts`                            | api, worker                                           | CA is not secret      |
| `DB_POOL_MIN/MAX/...`, `DB_BOOT_RETRIES`, `DB_SLOW_QUERY_MS`                    | Pool and boot tuning                               | O                                      | all                                                | `PoolConfiguration.ts`, `database.bootstrap.ts:62-63` | api, worker                                           | no                    |
| `REDIS_URL`                                                                     | Valkey/Redis (password inline on servers)          | R                                      | all                                                | `config/redis`                                        | api, worker, ops                                      | **yes**               |
| `REDIS_PASSWORD`                                                                | Valkey `requirepass`                               | X                                      | servers                                            | `compose.*.yml`                                       | valkey, **and also api/worker/ops**                   | **yes**               |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`                                       | Token signing (min 32 chars)                       | R                                      | all                                                | `schema.ts:13-14`                                     | api, worker, ops                                      | **yes**               |
| `JWT_OLD_ACCESS_SECRET`, `JWT_OLD_KID`, `JWT_ACCESS_SECRETS_JSON`               | Key rotation                                       | O                                      | when rotating                                      | jwt config                                            | api                                                   | **yes**               |
| `ENCRYPTION_KEY`                                                                | Encrypts provider credentials in `system_settings` | D                                      | dev, staging, prod                                 | `schema.ts:19,72-81`                                  | api, worker                                           | **yes**               |
| `RIDE_PIN_PEPPER`                                                               | Ride PIN verifier pepper                           | D                                      | dev, staging, prod                                 | `schema.ts:23,82-91`                                  | api                                                   | **yes**               |
| `BANK_DATA_ENCRYPTION_KEY`, `BANK_ACCOUNT_HASH_KEY`                             | Driver bank data                                   | D                                      | dev, staging, prod                                 | `schema.ts:33-34,61-71`                               | api, worker                                           | **yes**               |
| `OTP_PEPPER`                                                                    | OTP hashing                                        | O                                      | all                                                | `config/otp/otp.config.ts`                            | api, worker                                           | **yes**               |
| `TRUSTED_PROXIES` / `TRUSTED_PROXY_HOPS`                                        | Client-IP trust                                    | C (behind Caddy)                       | servers                                            | `app/trust-proxy.ts:31-53`                            | api                                                   | no                    |
| `CORS_ALLOWED_ORIGINS`, `REALTIME_CORS_ORIGINS`                                 | Browser origins                                    | C                                      | servers (local: A03)                               | `cors.plugin.ts:9-17`, `realtime.config.ts:19-29`     | api                                                   | no                    |
| `REALTIME_ADAPTER`                                                              | Socket.IO fan-out                                  | O                                      | servers = redis                                    | `realtime.config.ts:54-63`                            | api                                                   | no                    |
| `RATE_LIMIT_BYPASS`                                                             | Dev-only bypass                                    | O                                      | local only                                         | `RateLimitStore.ts:13-18`                             | api                                                   | no                    |
| `STORAGE_PROVIDER`                                                              | `mock` or `s3`                                     | O (default depends on name, A01)       | all                                                | `storage.config.ts:63-69`                             | api, worker                                           | no                    |
| `STORAGE_BUCKET`, `STORAGE_QUARANTINE_BUCKET`                                   | Buckets (must differ)                              | C (s3)                                 | servers                                            | `storage.config.ts:91-107`                            | api, worker                                           | no                    |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_FORCE_PATH_STYLE`                | S3 or Spaces endpoint                              | C                                      | servers                                            | `storage.config.ts:77-79`                             | api, worker                                           | no                    |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`                            | S3 credentials                                     | C (no IAM role on a droplet)           | servers                                            | `storage.config.ts:70-80`                             | api, worker                                           | **yes**               |
| `STORAGE_MALWARE_SCANNER`, `STORAGE_SSE`, `STORAGE_KMS_KEY_ID`                  | Scanning and encryption                            | C                                      | staging/prod                                       | `storage.config.ts:8-15,37-57,108-116`                | api, worker                                           | key id is not secret  |
| `SMS_PROVIDER`, `AIRTEL_*` (credentials, sender, entity, DLT templates)         | OTP and driver SMS                                 | C (airtel)                             | servers                                            | `notification.config.ts:124-200`                      | api, worker                                           | **yes** (credentials) |
| `PUSH_PROVIDER`, `FIREBASE_SERVICE_ACCOUNT_JSON`                                | FCM push                                           | D (fcm)                                | servers                                            | `schema.ts:26-29,92-101`, `fcm-app.ts:20-30`          | api, worker                                           | **yes**               |
| `EMAIL_PROVIDER`, `SMTP_*`, `EMAIL_FROM`                                        | Email                                              | C                                      | servers                                            | admin email settings                                  | worker                                                | **yes** (password)    |
| `MAP_PROVIDER`, `GOOGLE_MAPS_*`, `MAPPLS_*`, `OLA_MAPS_*`, `MAPS_API_KEY`       | Maps                                               | C                                      | servers                                            | `map-policy-resolver.ts`                              | api                                                   | **yes** (keys)        |
| `ALLOW_OFFLINE_ROUTING`, `ENABLE_OFFLINE_ROUTING`                               | Fallback routing                                   | O                                      | —                                                  | `schema.ts:52-53`                                     | api                                                   | no                    |
| `PAYMENT_DEFAULT_GATEWAY`, `PAYMENT_WEBHOOK_SECRET`, `RAZORPAY_*`, `STRIPE_*`   | Payments                                           | C                                      | servers                                            | `payment.config.ts`                                   | api, worker                                           | **yes**               |
| `PAYMENT_LEDGER_CUTOVER_AT`                                                     | Ledger cut-over instant                            | O (defaults to process start, F29)     | servers                                            | `payment.config.ts:127-140`                           | api, worker                                           | no                    |
| `*_CRON` (about 20)                                                             | Job schedules (UTC)                                | O                                      | —                                                  | `src/jobs/scheduler/index.ts`                         | worker                                                | no                    |
| `WORKER_HEALTH_HOST/PORT`, `WORKER_SHUTDOWN_GRACE_MS`, `OTP_WORKER_CONCURRENCY` | Worker                                             | O                                      | all                                                | `worker.config.ts`                                    | worker                                                | no                    |
| `API_SHUTDOWN_DRAIN_MS`, `API_SHUTDOWN_GRACE_MS`                                | API drain                                          | O                                      | servers                                            | `server.config.ts`                                    | api                                                   | no                    |
| `RIDE_*` (fares, commission, tax, dispatch, geofences, about 50)                | Business defaults                                  | O (**no env file declares them**, A38) | —                                                  | ride/pricing config                                   | api, worker                                           | no                    |
| `ADMIN_EMAIL/PASSWORD/PHONE/FIRST_NAME/LAST_NAME`                               | `create-admin.ts` input                            | C (one-off)                            | when bootstrapping                                 | `scripts/create-admin.ts:8-12`                        | ops (**not passed by the documented commands**, A10)  | **yes**               |
| `ADMIN_SEED_EMAIL/PASSWORD`                                                     | Local dev seed admin                               | O                                      | local                                              | `prisma/seed/development/index.ts:298-320`            | host / migrate                                        | **yes**               |
| `CADDY_DOMAIN`                                                                  | Caddy site address                                 | X                                      | servers                                            | `Caddyfile:1`                                         | caddy (also api via env_file)                         | no                    |
| `APP_IMAGE`, `OPS_IMAGE`, `IMAGE_TAG`, `APP_ENV_FILE`                           | Compose image and env-file selection               | X                                      | servers (prod requires `IMAGE_TAG` or `APP_IMAGE`) | `compose.*.yml`                                       | —                                                     | no                    |

### 3.6 Unused, duplicate, missing and misnamed variables

| Kind                                                     | Variables                                                                                                                                                                                                                          | Notes                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Misnamed (dead)**                                      | `FILE_PEEK_BYTES`, `FILE_IMAGE_PEEK_BYTES` (every env file)                                                                                                                                                                        | The code reads `STORAGE_PEEK_BYTES` and `STORAGE_IMAGE_PEEK_BYTES` (`storage.config.ts:84-85`). The env value `24` is ignored, harmlessly. |
| **Dead**                                                 | `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` (`.env.test`, `.env.development`)                                                                                                                                                | The code uses `JWT_ACCESS_TTL_SECONDS` / `JWT_REFRESH_TTL_SECONDS`.                                                                        |
| **Compose-only, but injected into the app**              | `POSTGRES_*`, `APP_DB_*`, `REDIS_PASSWORD`, `CADDY_DOMAIN`                                                                                                                                                                         | A14                                                                                                                                        |
| **Duplicated secrets**                                   | `POSTGRES_PASSWORD` plus inside `MIGRATION_DATABASE_URL`; `APP_DB_PASSWORD` plus inside `DATABASE_URL`; `REDIS_PASSWORD` plus inside `REDIS_URL`                                                                                   | Rotating one copy without the others breaks the stack. Special characters also need URL-encoding (A30).                                    |
| **Read by code, absent from every env file**             | `RIDE_COMMISSION_RATE`, `RIDE_TAX_RATE`, `RIDE_PLATFORM_FEE(_PCT)`, `RIDE_BASE_FARE`, `RIDE_MINIMUM_FARE`, `RIDE_RATE_PER_KM/MIN`, about 40 more `RIDE_*`, `PAYMENT_*` tuning, `RAZORPAY_WEBHOOK_SECRET`, `STRIPE_*`, `REFERRAL_*` | All have in-code defaults. Commission and tax defaults are business decisions hidden in code (A38).                                        |
| **Legacy file still auto-loaded**                        | `.env.development`                                                                                                                                                                                                                 | `loader.ts:8-9` and `prisma.config.ts:12-13` fall back to it. On this machine it holds **live** third-party credentials (A22).             |
| **Missing template**                                     | `.env.example` (deleted) and `.env.local.example` (never created)                                                                                                                                                                  | A07                                                                                                                                        |
| **Placeholders still present** (expected before go-live) | `.env.dev` / `.env.staging`: storage keys, Airtel credentials, Firebase JSON, map keys, Razorpay keys, SMTP password, `PAYMENT_WEBHOOK_SECRET`. `.env.prod`: also all three infra passwords and the KMS key id.                    | BLOCKED (owner to supply)                                                                                                                  |

### 3.7 Job schedules: env files override the code defaults (all UTC)

| Variable                             | Code default (`scheduler/index.ts`) | All env files (local, dev, staging, prod) | Effect                                           |
| ------------------------------------ | ----------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `REFUND_RECONCILIATION_CRON`         | `*/5 * * * *` (every 5 min)         | `0 5 * * *` (daily 10:30 IST)             | Stuck refunds wait up to 24 h                    |
| `PAYMENT_COLLECTION_SWEEP_CRON`      | `*/5 * * * *`                       | `0 3 * * *` (daily)                       | Failed collections retried once a day            |
| `PAYMENT_RECONCILIATION_CRON`        | `15 * * * *` (hourly)               | `0 2 * * *` (daily)                       |                                                  |
| `PAYMENT_RECEIVABLE_WRITEOFF_CRON`   | `45 3 * * *` (daily)                | `0 4 1 * *` (monthly)                     |                                                  |
| `PAYMENT_INTENT_RECONCILIATION_CRON` | `*/10`                              | `*/15`                                    |                                                  |
| `RIDE_REQUEST_EXPIRY_CRON`           | every minute                        | `*/2`                                     | Requests can outlive their expiry by up to 2 min |
| `SCHEDULED_RIDE_REMINDER_CRON`       | every minute                        | `*/5`                                     | Reminders up to 5 min late                       |
| `DRIVER_DOC_EXPIRATION_CRON`         | `0 2 * * *`                         | `0 0 * * *`                               |                                                  |

---

## 4. Dockerfile audit

### 4.1 Stages actually present

| Stage                  | Line    | Base / FROM                | Purpose                                                                                   | Used by                                       |
| ---------------------- | ------- | -------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| `deps`                 | 16      | `node:22.21.0-trixie-slim` | `npm ci --ignore-scripts` (all dependencies)                                              | local, test, build                            |
| `local`                | 33      | node slim                  | Source baked in, `prisma generate`, `CMD npm run dev`                                     | `compose.local.yml`                           |
| `development`          | 49      | `local` (alias)            | Compatibility alias                                                                       | —                                             |
| `test`                 | 56      | node slim                  | Source plus tests, `prisma generate`, `CMD npm run test`                                  | `compose.test.yml`                            |
| `build`                | 76      | node slim                  | `prisma generate`, `npm run build` (tsc + tsc-alias + copy-generated)                     | ops, prod                                     |
| `ops`                  | 95      | `build`                    | tsx and full source, `CMD prisma migrate status`; runs as **root**                        | migrate, ops services; `deploy-dev.yml:57-66` |
| `prod-deps`            | 101     | node slim                  | `npm ci --omit=dev --ignore-scripts`, then `npm rebuild @prisma/engines`                  | prod                                          |
| `prod`                 | 117     | node slim                  | dumb-init, `dist`, prod `node_modules`, `prisma/`, `USER node`, HEALTHCHECK               | api, worker                                   |
| `runner`, `production` | 139-140 | `prod` (aliases)           | The last stage, so an untargeted `docker build` produces the runtime image (`ci.yml:171`) | CI                                            |

### 4.2 Checks

| Check                                        | Result                                                                                                                            | Evidence                                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Node version matches `.nvmrc`                | **PASS**                                                                                                                          | `Dockerfile:4` `22.21.0` = `.nvmrc` `v22.21.0`                                                                                             |
| npm and lockfile compatibility               | **PASS**                                                                                                                          | npm 10.9.4 ships with Node 22.21.0 (verified on host); `package-lock.json` is lockfileVersion 3 and `npm ls` is clean                      |
| Dependency install                           | **PASS**                                                                                                                          | `npm ci --ignore-scripts` (`:28,:110`)                                                                                                     |
| Production dependency separation             | **PASS**                                                                                                                          | `prod-deps` with `--omit=dev`; tsx is a devDependency and absent from the runtime                                                          |
| Prisma Client generation                     | **PASS**                                                                                                                          | Explicit `npx prisma generate` in local, test and build (`:44,:68,:87`); `src/generated` is excluded from the context (`.dockerignore:30`) |
| Prisma engine availability (offline migrate) | **PASS (11-19)**                                                                                                                  | `npm rebuild @prisma/engines` (`:111`)                                                                                                     |
| Prisma version consistency                   | **FAIL (P2)**                                                                                                                     | CLI and engines 7.10.1 vs `@prisma/client` 7.9.0 in the lockfile; `allowScripts` pins 7.9.0 (A32)                                          |
| TypeScript compilation                       | NOT RUN (CI build job compiles)                                                                                                   | `:90`                                                                                                                                      |
| Generated source copied into `dist`          | PASS (11-19)                                                                                                                      | `scripts/copy-generated.js`                                                                                                                |
| Runtime files                                | PASS                                                                                                                              | `dist`, prod `node_modules`, `package.json`, `prisma.config.ts`, `prisma/` (`:124-127`). `scripts/` is not shipped, by design.             |
| API startup `node dist/server.js`            | PASS (11-19)                                                                                                                      | `:137`, Compose `command`                                                                                                                  |
| Worker startup `node dist/worker.js`         | PASS (11-19)                                                                                                                      | Compose `command`                                                                                                                          |
| Migration execution                          | PASS (11-19) in prod; NOT RUN in ops                                                                                              | Compose uses the **ops** image for `migrate`                                                                                               |
| Seed execution                               | PASS (11-19) from the `build` stage, which `ops` is identical to; NOT RUN today                                                   | `package.json:170` uses tsx                                                                                                                |
| Admin bootstrap                              | NOT RUN. The files are present in ops (`scripts/`, `src/`, `prisma/`, `tsconfig.json`, tsx). It exits 1 without `ADMIN_PASSWORD`. | A10                                                                                                                                        |
| Non-root user                                | PASS for prod (`USER node`, `:129`); **ops and build run as root**                                                                | A34                                                                                                                                        |
| dumb-init, PID 1                             | **PASS**                                                                                                                          | `:120-122,:136`                                                                                                                            |
| Graceful shutdown                            | PASS (11-19) for `node dist/*.js`: drained 10 s, exit 0                                                                           | `shutdown.bootstrap.ts`, `worker.bootstrap.ts:42-69`                                                                                       |
| Health check                                 | PARTIAL. The image HEALTHCHECK probes `/health`, which is liveness only. Compose overrides it for the worker.                     | A27                                                                                                                                        |
| Image security                               | PARTIAL. Base image not pinned by digest. Trivy scan runs but is non-blocking and the action is unpinned.                         | A34, A21                                                                                                                                   |
| Build caching                                | **PASS**                                                                                                                          | Lockfile layer before source; GHA cache in workflows                                                                                       |
| Image size                                   | PASS (11-19) runtime 198 MB; ops not measured                                                                                     | —                                                                                                                                          |

### 4.3 Can each image run the required commands?

| Command                                       | `prod` runtime image                                                                                                                                  | `ops` image                                                 | Evidence                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run start:prod`                          | **FAIL**: `node --env-file=.env.prod` exits 9 because `.env.*` is excluded from the image. Running node under npm also breaks SIGTERM handling (F08). | FAIL (same)                                                 | Verified: Node 22.21 exits 9 on a missing env file; `.dockerignore:17-18`; `package.json:30` |
| `npm run worker:start:prod`                   | **FAIL** (same reason)                                                                                                                                | FAIL                                                        | `package.json:35`                                                                            |
| `node dist/server.js` / `node dist/worker.js` | PASS (11-19)                                                                                                                                          | works, but not intended                                     | —                                                                                            |
| `npx prisma migrate deploy`                   | PASS (11-19)                                                                                                                                          | NOT RUN (expected PASS)                                     | `prisma` is a prod dependency                                                                |
| `npx prisma db seed`                          | FAIL by design (no tsx)                                                                                                                               | NOT RUN (expected PASS, as the build stage passed on 11-19) | —                                                                                            |
| `npx tsx scripts/create-admin.ts`             | FAIL by design (no tsx, no scripts)                                                                                                                   | NOT RUN (starts; behaviour per A10)                         | —                                                                                            |

**Missing artifacts:** none for the intended commands. The npm `start*`/`worker*` scripts are simply not usable in containers; Compose correctly bypasses them.

---

## 5. Docker Compose audit

### 5.1 Files and responsibilities

| File                              | Project name       | Responsibility (actual)                                                                                                                         | Matches intent?                           |
| --------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `compose.local.yml` (untracked)   | `zaroorat-local`   | postgres, valkey, migrate, api, worker built from the `local` target; ports on `127.0.0.1`; `develop.watch`                                     | Yes, but it cannot start (A04–A06)        |
| `compose.dev.yml` (modified)      | `zaroorat-dev`     | caddy, api, worker, pgbouncer, postgres, valkey, plus `ops` profile (migrate, db-roles, ops); images from GHCR, but still has `build:` sections | Yes (A09, A14, A33)                       |
| `compose.test.yml` (modified)     | `zaroorat-test`    | test runner, ephemeral postgres (tmpfs), redis; no api or worker, by design                                                                     | Yes                                       |
| `compose.staging.yml` (untracked) | `zaroorat-staging` | Same shape as DEV, no `build:`, image `:${IMAGE_TAG:-staging}`                                                                                  | Yes, but its images are never built (A11) |
| `compose.prod.yml` (modified)     | `zaroorat-prod`    | Same shape; `IMAGE_TAG` or `APP_IMAGE` **required**                                                                                             | Yes, but nothing supplies the tag (A11)   |

### 5.2 Per-service review (DEV, STAGING and PROD share the shape)

| Service                | Image / target                             | Env                                                                    | Network / ports  | Health                                             | Volumes                    | Restart / limits / grace                                          | Findings                     |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------- | ---------------- | -------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- | ---------------------------- |
| caddy                  | `caddy:2-alpine` (not pinned)              | `CADDY_DOMAIN`                                                         | 80/443 published | none                                               | `caddy_*_data`, `_config`  | always; 0.5 CPU / 128 MB (prod 1 / 256)                           | depends on api healthy (A35) |
| api                    | GHCR `:dev` / `:staging` / `:${IMAGE_TAG}` | env_file `.env.<env>` + HOST/PORT/TRUSTED_PROXIES                      | expose 3000      | node fetch `/health`                               | —                          | always; 1.5 CPU / 1 GB (prod 2 / 2 GB); grace 30 s                | A14, A27, A28                |
| worker                 | same image                                 | env_file + `WORKER_HEALTH_PORT`                                        | expose 3001      | `/health`                                          | —                          | always; grace 150 s                                               | A14, A27                     |
| pgbouncer              | `edoburu/pgbouncer:v1.23.1-p2`             | DB_*, transaction mode, scram                                          | internal         | `pg_isready` (passes before the login exists, F26) | —                          | always                                                            | A39                          |
| postgres               | `postgis/postgis:17-3.5`, amd64            | `POSTGRES_*` with `:?required`                                         | internal         | `pg_isready`                                       | `postgres_<env>_data`      | always; 2 CPU / 2 GB (prod 4 / 4 GB); **default 10 s stop grace** | A36                          |
| valkey                 | `valkey/valkey:8.1-alpine`                 | `REDIS_PASSWORD :?required`                                            | internal         | `valkey-cli ping`                                  | `valkey_<env>_data` (AOF)  | always                                                            | —                            |
| migrate (profile ops)  | ops image                                  | APP_ENV, NODE_ENV, MIGRATION_DATABASE_URL (built from `${POSTGRES_*}`) | internal         | —                                                  | —                          | `no`                                                              | correct isolation            |
| db-roles (profile ops) | postgis image                              | PGPASSWORD, APP_DB_PASSWORD                                            | internal         | —                                                  | `./scripts/db:/scripts:ro` | `no`                                                              | PASS                         |
| ops (profile ops)      | ops image                                  | env_file + DATABASE_URL via pgbouncer + MIGRATION_DATABASE_URL         | internal         | —                                                  | —                          | `no`                                                              | A14                          |

No server stack sets a `logging:` option (A28). Subnets are fixed per environment (`172.28/.29/.30.0.0/24`) and match `TRUSTED_PROXIES`. **PASS**

### 5.3 Issues found in the Compose files

| Area                                   | Result                                                                                                                                                            | Detail                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Service hostnames                      | PASS on servers (pgbouncer, postgres, valkey). **FAIL** in LOCAL `migrate` (A05).                                                                                 | resolved config: `MIGRATION_DATABASE_URL host=127.0.0.1:5432` |
| Ports                                  | PASS. Servers publish only 80/443; LOCAL binds to 127.0.0.1. Worker host port 3001 in LOCAL is unusable (A39).                                                    | —                                                             |
| Health checks                          | PARTIAL. All app services have them, but they probe `/health` instead of `/ready` (A27); caddy has none.                                                          | —                                                             |
| Persistent volumes                     | PASS for postgres, valkey and caddy. Postgres in TEST uses tmpfs, by design.                                                                                      | —                                                             |
| Accidentally exposed internal services | PASS                                                                                                                                                              | —                                                             |
| Env-file paths                         | `${APP_ENV_FILE:-.env.<env>}` is relative to the project directory. The infra examples point it at `/etc/zaroorat/<env>/.env.<env>`, a second, competing pattern. | A14                                                           |
| Interpolation                          | PASS with `--env-file`. **FAIL** without it (rollback.sh, status.sh, the docs) and for prod without `IMAGE_TAG` (verified).                                       | A15, A11                                                      |
| Unsafe volume deletion                 | `down -v` only in LOCAL reset and TEST teardown, where it is labelled. PASS.                                                                                      | `package.json:73,100`; `Makefile:86,180,188`                  |
| Startup ordering                       | PASS: `service_healthy` / `service_completed_successfully`. On a first boot, the API restarts until `db-roles` has run (F26), which `deploy.sh` orders correctly. | `deploy.sh:48-56`                                             |
| Duplication                            | `compose.dev.yml`, `compose.staging.yml` and `compose.prod.yml` are about 95% identical (names, limits, subnet, `build:` in DEV only).                            | Optional consolidation (§14)                                  |
| LOCAL Postgres init                    | **FAIL** (A06)                                                                                                                                                    | `docker/postgres/init/01-create-databases.sql:1`              |
| LOCAL app commands                     | **FAIL** (A04)                                                                                                                                                    | `compose.local.yml:77,114`                                    |

### 5.4 Which file per environment

| Env     | Command prefix (today)                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------- |
| LOCAL   | `docker compose --env-file .env.local -f compose.local.yml` (blocked until A04–A07 are fixed)                 |
| DEV     | `docker compose --env-file .env.dev -f compose.dev.yml [--profile ops]`                                       |
| TEST    | `docker compose --env-file .env.test -f compose.test.yml`                                                     |
| STAGING | `docker compose --env-file .env.staging -f compose.staging.yml` (and set `APP_IMAGE`/`OPS_IMAGE`)             |
| PROD    | `IMAGE_TAG=<tag>` or `APP_IMAGE=<ref@digest>`, plus `docker compose --env-file .env.prod -f compose.prod.yml` |

### 5.5 Static validation results (`config -q`, `--profile ops`)

| Stack                                                            | Result                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| local                                                            | PASS                                                                                                |
| dev                                                              | PASS. Images resolve to `…/zaroorat-backend:dev` and `:dev-ops`, **tags no workflow pushes** (A33). |
| staging                                                          | PASS. Images resolve to `:staging` and `:staging-ops`, **never built** (A11).                       |
| prod                                                             | **FAIL**: `required variable IMAGE_TAG is missing a value`                                          |
| test                                                             | PASS                                                                                                |
| dev without `--env-file` (the `rollback.sh`/`status.sh` pattern) | **FAIL**: `required variable APP_DB_PASSWORD is missing a value`                                    |

---

## 6. NPM / Make command inventory

Each verdict is a static check unless marked otherwise.

### 6.1 LOCAL

| Task                             | npm                                            | make                                                                | Env file                           | Verdict                                                                     |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| Start API (host)                 | `local`, `dev`, `dev:local` (three duplicates) | `dev`                                                               | `.env.local`                       | **FAIL**: crashes in `createApp` (A02); no OTP or CORS (A03)                |
| Start worker (host)              | `worker:local`, `worker:dev`                   | —                                                                   | `.env.local`                       | OK (NOT RUN)                                                                |
| Build                            | `build`                                        | `build`                                                             | —                                  | NOT RUN                                                                     |
| Typecheck / lint                 | `typecheck`, `lint`                            | `typecheck`, `lint`                                                 | —                                  | NOT RUN                                                                     |
| Migration status / deploy (host) | `migrate:status:local`, `migrate:local`        | —                                                                   | `.env.local` via the Prisma config | OK                                                                          |
| Migration (Docker)               | `docker:local:migrate`                         | `migrate-local`                                                     | `.env.local`                       | **FAIL** (A05)                                                              |
| Seed (host)                      | `seed:local`                                   | —                                                                   | `.env.local`                       | OK                                                                          |
| Seed (Docker)                    | `docker:local:seed`                            | `seed-local`                                                        | —                                  | **FAIL**: the loader throws because there is no `/app/.env.local` (A04)     |
| Admin                            | `admin:local`                                  | —                                                                   | `.env.local`                       | Needs `ADMIN_PASSWORD` exported (A10). Prefer the seed admin.               |
| Docker up / down / stop / logs   | `docker:local:up/down/stop/logs`               | `up-local`, `down-local`, `stop-local`, `logs-local`, `watch-local` | `.env.local`                       | **FAIL**: `up-local` copies a non-existent template (A07), then A04/A05/A06 |
| Reset (destructive)              | `docker:local:reset`                           | `reset-local`                                                       | —                                  | OK (deletes LOCAL volumes, labelled)                                        |

### 6.2 DEV

| Task                              | npm                                                             | make                               | Verdict                                                                                               |
| --------------------------------- | --------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| API / worker (server)             | Compose `node dist/*.js`                                        | `up-dev`                           | OK (static). Manual `up-dev` pulls a `:dev` tag that does not exist, then builds on the server (A33). |
| API / worker (laptop against DEV) | `dev:dev`, `start:dev`, `worker:dev:remote`, `worker:start:dev` | —                                  | RISK: runs local code with DEV secrets (A22). Service hostnames are unresolvable from a laptop.       |
| Up / down / logs                  | `docker:dev:up/down/logs`                                       | `up-dev`, `down-dev`, `logs-dev`   | OK (config verified)                                                                                  |
| Migrations                        | `docker:dev:migrate`                                            | `migrate-dev` (also runs db-roles) | OK, but the ops tag is missing (A33)                                                                  |
| DB roles                          | `docker:dev:roles`                                              | (in `migrate-dev`)                 | OK                                                                                                    |
| Seed                              | `docker:dev:seed`                                               | `seed-dev`                         | OK on a fresh DB; RISK on re-run (A18)                                                                |
| Admin                             | `docker:dev:admin`                                              | `admin-dev`                        | **FAIL**: `ADMIN_PASSWORD` never reaches the container; unsafe matching (A10)                         |
| Config check                      | —                                                               | `config-dev`                       | OK                                                                                                    |
| Deploy                            | CI `deploy-dev.yml` → `deploy/bin/deploy.sh`                    | —                                  | **FAIL** (A08, A09)                                                                                   |

### 6.3 TEST

| Task               | npm                                                 | make                                                                 | Verdict                                                                       |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Unit               | `test:unit`                                         | —                                                                    | RISK: no `--test-force-exit`, so it hangs (known); run the glob with the flag |
| Integration        | `test:integration`                                  | —                                                                    | NOT RUN (needs `zaroorat_test` on 127.0.0.1)                                  |
| Full suite         | `test`                                              | `test`, `verify`                                                     | NOT RUN                                                                       |
| Docker             | `docker:test:run`, `docker:test:down`               | `test-docker` (runs, then always tears down), `up-test`, `down-test` | Config PASS; NOT RUN                                                          |
| DB init / teardown | compose.test tmpfs plus `migrate deploy && db seed` | —                                                                    | PASS (design)                                                                 |

### 6.4 STAGING

| Task                           | Command                                                                                      | Verdict                          |
| ------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------- |
| Build / pull                   | none for Compose (`staging.yml` is Helm and pushes `zaroorat-back:staging`, no ops image)    | **FAIL** (A11)                   |
| Config validation              | `docker compose --env-file .env.staging -f compose.staging.yml --profile ops config -q`      | PASS (no make target)            |
| Migrate / roles / seed / admin | `docker:staging:migrate/roles/seed/admin`, `make migrate-staging/seed-staging/admin-staging` | Images missing; admin FAIL (A10) |
| Deploy / health                | none (`deploy.sh` is hard-coded to DEV)                                                      | **FAIL** (A11, A15)              |

### 6.5 PRODUCTION

| Task                       | Command                                                                                | Verdict                                  |
| -------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| Build and release          | `release.yml` (tag) → `production.yml` (Helm, **rebuilds** the image)                  | **FAIL** for Compose (A11, A21)          |
| Image pull                 | none                                                                                   | FAIL                                     |
| Config validation          | `make config-prod`                                                                     | **FAIL**: `IMAGE_TAG` missing (verified) |
| Database backup            | `make db-backup` → `scripts/db-backup.sh` (reads `.env.local`, uses `--no-privileges`) | **FAIL** (A17)                           |
| Migrate / roles            | `make migrate-prod`, `docker:prod:migrate/roles`                                       | FAIL without `IMAGE_TAG`; OK with it     |
| Seed                       | `make seed-prod`, `docker:prod:seed`, `seed:prod`                                      | **RISK** on a live DB (A18)              |
| Admin                      | `make admin-prod`, `docker:prod:admin`, `admin:prod`                                   | **FAIL / BLOCKER** (A10)                 |
| Deploy / health / rollback | none                                                                                   | **FAIL** (A11, A15)                      |
| Logs                       | `make logs-prod`, `docker:prod:logs`                                                   | FAIL without `IMAGE_TAG`                 |

### 6.6 Conflicting and dangerous commands

| Command                                                                        | Danger                                                                                                                              | Finding  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `npm run prisma:reset` (`scripts/reset-db.js`: `prisma migrate reset --force`) | Wipes whichever DB the current `APP_ENV` resolves to. Inside an ops container that is the server DB. There is no environment guard. | A23      |
| `npm start`, `npm run worker`                                                  | Default to **`.env.prod`** (`package.json:26,31`)                                                                                   | A23      |
| `prod`, `dev:prod`, `worker:prod`, `staging`, `dev:staging`, `worker:staging`  | `tsx watch` of working-tree code against server secrets                                                                             | A22, A23 |
| `seed:prod`, `docker:prod:seed`, `make seed-prod`                              | Overwrite pricing, RBAC and themes on a live DB                                                                                     | A18      |
| `docker:local:reset`, `reset-local`, `docker:test:down`, `down-test`           | `down -v`, acceptable for LOCAL/TEST                                                                                                | —        |
| `scripts/db-restore.sh`                                                        | `--clean`; the production guard matches only `*prod*`/`*production*` in the URL; asks for an interactive `yes`                      | A17      |
| Naming conflict                                                                | `dev` / `worker:dev` mean **LOCAL**, while `start:dev`, `migrate:dev`, `docker:dev:*` and `admin:dev` mean **DEV**                  | A31      |
| `make db-shell`                                                                | Labelled "local development database" but opens the **DEV** stack (`Makefile:261-262`)                                              | A31      |

### 6.7 Recommended naming convention (minimal)

- Environment suffix only, `:<env>` with env ∈ `local | dev | staging | prod`. **No suffix means `local`. Nothing defaults to `prod`.**
- Host loop: `dev`, `worker`, `build`, `typecheck`, `lint`, `test`, `test:unit`, `test:integration`.
- Database: `db:status:<env>`, `db:migrate:<env>`, `db:roles:<env>`, `db:seed:<env>`, `db:admin:<env>`.
- Stacks: `stack:<env>:up|down|logs|ps|config`. Server-only deploys go through `deploy/bin/deploy.sh <env> <sha> <digest>`.
- Delete `start`, `worker`, `prod`, `staging`, `dev:prod`, `dev:staging`, `worker:prod`, `worker:staging`, `start:*`, `worker:start:*` (containers run `node dist/*.js` directly), and keep the Makefile as a thin mirror or drop the duplicates.

---

## 7. Prisma database and migration audit

### 7.1 Connection trace

| #   | Question                         | Answer                                                                                                                                                                                                                                                                          | Result                                    |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | How the app connects             | `pg.Pool(DATABASE_URL)` → `PrismaPg` adapter → `PrismaClient` with five `$extends` (`PrismaClientFactory.ts:58-103`); on servers via `pgbouncer:6432`                                                                                                                           | PASS (11-19)                              |
| 2   | How Prisma selects the URL       | Runtime: `DATABASE_URL` only. CLI: `MIGRATION_DATABASE_URL`, falling back to `DATABASE_URL` (`prisma.config.ts:43-46`)                                                                                                                                                          | PASS                                      |
| 3   | Migration-owner URL              | `migrate` service builds it from `${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432` (`compose.dev.yml:209`)                                                                                                                                                                  | PASS                                      |
| 4   | Runtime vs migration credentials | Runtime = `zaroorat_app` (member of `zaroorat_app_runtime`); owner = `POSTGRES_USER` (superuser in self-hosted Postgres). The boot check refuses the owner in dev/staging/production, **but not in `prod`** (A01).                                                              | PARTIAL                                   |
| 5   | PostGIS / pgcrypto               | Created by migration `20260724173304_init` (`CREATE EXTENSION IF NOT EXISTS`); `btree_gist` by later migrations. On a managed DB the owner must be allowed to create them.                                                                                                      | PASS                                      |
| 6   | Roles and permissions            | Migration `20261002130100` creates the group, CRUD grants and `ALTER DEFAULT PRIVILEGES` (without `FOR ROLE`, so it relies on every migration running as the same owner). `create-app-login.sql` creates the login. `verify-roles.sql` / `verify-runtime-login.sql` check both. | PASS (design); NOT RUN today              |
| 7   | PgBouncer                        | Transaction mode with scram. Compatible because only transaction-scoped locks and settings are used. Migrations bypass it.                                                                                                                                                      | PASS                                      |
| 8   | Migrations during deployment     | `deploy.sh:48` runs `migrate`, then `db-roles`, then `up --wait`. Exactly one run per deploy, serialised by `flock` (`:19-23`) and Prisma's advisory lock.                                                                                                                      | PASS (design); broken upstream by A08/A09 |
| —   | Never run by API/worker replicas | No `migrate`/`execSync` in `src/`; Compose commands are `node dist/*.js`                                                                                                                                                                                                        | **PASS**                                  |

### 7.2 Migration inventory

87 migration folders on disk; 86 are tracked in git. `20261118174500_relax_tax_config_direct_activation` is **untracked** pricing work. The risk scan below covers all of them.

| Risk                                 | Migrations                                                                                                                                                                                                          | Assessment                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Destructive (DROP TABLE / COLUMN)    | `20260804090000_drop_profile_image_url`, `20260828120000_promo_banner_image_file_id` (DELETE + DROP COLUMN), `20260828160000_geographic_management` (DROP + RENAME), `20260920000000_remove_ride_otps` (DROP TABLE) | Already applied to existing DBs; no effect on a fresh DB. Not reversible.                |
| Column type changes                  | `20260828100000_referral_audience…`, `20260912120000_payout_settlement_status_enums`                                                                                                                                | Applied; rewrites under ACCESS EXCLUSIVE lock on large tables                            |
| Data rewrites (UPDATE)               | about 15 migrations, including `m07`, `m08`, `m06`                                                                                                                                                                  | Run in the deploy window; size depends on data                                           |
| `SET NOT NULL`                       | `outbox_claim_and_retry`, `promo_banner…`, `geographic_management`, `promotion_usage_limits`, **`m06` (`:31`)**                                                                                                     | m06 breaks the old app's INSERTs (A19)                                                   |
| Non-concurrent `CREATE INDEX`        | many                                                                                                                                                                                                                | Lock writes during the build; fine at today's sizes, review before production data grows |
| Triggers (immutability, append-only) | `m02` (rides, ride_requests), `m05`, `m06`, audit migrations                                                                                                                                                        | Old code that updates snapshot columns would be rejected (A19)                           |
| Ordering dependency                  | `20261002130100` must precede `create-app-login.sql`; `btree_gist` is created where needed                                                                                                                          | PASS                                                                                     |
| Permissions                          | Tables created later inherit grants through default privileges                                                                                                                                                      | PASS, if every migration runs as the same owner                                          |

Prior runtime evidence: on 2026-11-19, 76 migrations applied cleanly to a fresh database in 12 s. The 11 migrations added since (10 pricing, 1 untracked) are **NOT RUN on a fresh database** in this audit.

### 7.3 Is application rollback safe after a migration?

**Not guaranteed.**

- `m06` says "Expand-only and backward-compatible" (`20261118110000_…/migration.sql:2`), yet sets `family_id` NOT NULL with no default (`:31`). An app image from before m06 cannot create cancellation policies.
- `deploy.sh:56-61` automatically starts the **previous image after the new migrations have been applied**.
- **Policy to adopt:** forward-fix by default. Roll back the image only when the release added no migration, or every migration in it is verified expand-only. Otherwise restore the pre-deploy backup and accept losing the data written since (§19).

### 7.4 Procedures (full runbooks in §16 and §17)

- **A. Fresh database:** start postgres and valkey, then `migrate`, `db-roles`, `verify-roles.sql`, start pgbouncer, `verify-runtime-login.sql`, seed **once**, first admin, start api/worker/caddy, check `/ready`, take a baseline backup.
- **B. Existing database:** CI green, then `migrate status` (review pending SQL), **backup**, `migrate`, `db-roles`, `up --wait api worker`, check `/ready` and smoke tests, record the digest. **No seed.**

### 7.5 Failed migration recovery and concurrency

Prisma records the failure in `_prisma_migrations` (`finished_at IS NULL`). Inspect it with the owner, never the runtime login, which cannot read that table (`verify-roles.sql:108-110`).

- If nothing was applied: fix the SQL in a **new** commit, run `prisma migrate resolve --rolled-back <name>`, then redeploy.
- If the change was completed manually: `resolve --applied <name>`.
- Concurrency: Prisma takes an advisory lock and `deploy.sh` uses `flock` on `/tmp/zaroorat-deploy.lock`. PASS (design).

---

## 8. Database seeding audit

`prisma/seed/index.ts` imports the full DI container. That triggers env validation and connects with **`DATABASE_URL`**, the runtime login through PgBouncer in the `ops` service. It branches on `APP_ENV`:

- `local` / `development` → `seedDevelopment`
- `test` / `testing` → `seedTesting`
- `dev` / `staging` / `production` / `prod` → `seedProduction`
- **any unknown value** → `seedProduction` (`:35-39`)

| Seed module                        | Data                                                                                                                         | Mandatory on a fresh DB                                                                | Idempotent            | Overwrites existing data                                                                                                                                | Environments                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `shared/roles.ts`                  | 6 roles, about 40 permission codes, role→permission grants                                                                   | **Yes.** No staff login works without it; `create-admin` needs the `system_admin` row. | Yes (upserts)         | **Yes:** removes grants not in the seed (`:417-420`) and deletes obsolete permissions (`:423-429`)                                                      | all                                             |
| `shared/vehicle-types.ts`          | Vehicle catalogue plus one `GLOBAL` pricing rule per type                                                                    | Yes (no booking without vehicle types)                                                 | Yes (find-then-write) | **Yes:** re-applies names and icons (`:164-173`) and **resets the GLOBAL rate card** (`:180-185`)                                                       | all                                             |
| `shared/geography.ts`              | India plus 28 states and 8 UTs (LGD codes)                                                                                   | Yes for admin geography                                                                | Yes                   | Updates names                                                                                                                                           | all                                             |
| `shared/app-config.ts`             | Locales, themes, fonts, driver EN strings, `app_config.version`                                                              | Yes for app-config                                                                     | Mostly                | **Yes:** theme tokens and components overwritten; fonts `deleteMany` + `createMany` (`:763-764`); translations overwritten; version bumped on every run | all                                             |
| `shared/notification-templates.ts` | 6 SMS/push templates                                                                                                         | No (only admin communications read them)                                               | Yes                   | Updates                                                                                                                                                 | **test only**; not in the production seed (A41) |
| `development/index.ts`             | Demo users, drivers, vehicles, cities, zones, fares, surge, promos; admin from `ADMIN_SEED_*` (no default password any more) | —                                                                                      | Mostly                | Yes                                                                                                                                                     | local only                                      |

| #   | Question                       | Answer                                                                                                                                                                           |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mandatory for a fresh startup  | roles, vehicle types (+ GLOBAL pricing), geography, app-config. Cities and service zones are **not** seeded in production: an admin must create them before rides can be booked. |
| 2   | Idempotent                     | All production seed modules (safe to re-run without duplicating)                                                                                                                 |
| 3   | Can overwrite existing records | roles/grants, vehicle-type presentation, **GLOBAL pricing rules**, themes/fonts/translations                                                                                     |
| 4   | Must run only once             | The production seed on a live DB: treat it as **once at creation**. Later reference-data changes belong in migrations or the admin panel (A18).                                  |
| 5   | Environment-specific           | development (demo data), testing (adds templates)                                                                                                                                |
| 6   | Production seed safe?          | Safe on a **fresh** DB. **Not safe** to re-run on a live DB without review.                                                                                                      |
| 7   | Can the ops image seed?        | Yes by design (tsx and full source; PASS (11-19) on the identical build stage); NOT RUN today                                                                                    |

**Commands (fresh DB only):**

- LOCAL host: `npm run seed:local`
- DEV: `docker compose --env-file .env.dev -f compose.dev.yml --profile ops run --rm ops npx prisma db seed`
- STAGING and PROD: the same with their files. PROD also needs `IMAGE_TAG` or `OPS_IMAGE`.

---

## 9. Admin creation and RBAC audit

### 9.1 First-admin flow (`scripts/create-admin.ts`)

1. Reads `ADMIN_EMAIL` (default `admin@zaroorat.com`), `ADMIN_PASSWORD` (required, ≥ 8 chars, trimmed), `ADMIN_PHONE` (**default `+919999999999`**), `ADMIN_FIRST_NAME` and `ADMIN_LAST_NAME` (`:8-17`).
2. Resolves the DI container. The connection is `DATABASE_URL`, i.e. the runtime login in the ops service.
3. Runs `users.findFirst({ OR: [{ email }, { phoneNumber: phone }] })` (`:25-31`). Phone uniqueness is only _partial_ (`user.prisma:3`), so this can match an old or deleted account.
4. **If a user matches:** overwrites that user's email, phone, **password hash**, `status = ACTIVE`, both verification flags and profile name (`:32-58`).
5. **Otherwise:** creates the user (`:59-78`).
6. Calls `assignRole(..., 'system_admin')`, adding a `user_roles` row if no active one exists (`:80`). `system_admin` bypasses all authorisation (`auth.plugin.ts:74-75`).

### 9.2 Verification

| #   | Check                                  | Result                                                                                                                                                                                                                                               | Evidence                  |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | How the first admin is created         | One-off script in the ops image                                                                                                                                                                                                                      | above                     |
| 2   | Checks whether an admin already exists | **FAIL**: no check for any existing `system_admin`                                                                                                                                                                                                   | `:19-80`                  |
| 3   | Duplicate creation prevented           | PARTIAL: it never creates two users for the same email or phone, but it **re-targets and escalates whatever user matches**                                                                                                                           | `:25-58`                  |
| 4   | Password hashed securely               | PASS: scrypt with a random salt and a timing-safe compare. Policy is only 8 characters minimum; the password is trimmed.                                                                                                                             | `password.ts:8-16`        |
| 5   | Permissions assigned correctly         | PASS: the role row must be seeded first (`findUniqueOrThrow`); the role grants everything                                                                                                                                                            | `roles.ts:436-450`        |
| 6   | Correct DB connection                  | PASS: runtime login (CRUD only), not the owner                                                                                                                                                                                                       | `compose.dev.yml:254`     |
| 7   | Credentials from env or secure input   | Env vars only. **The documented commands never pass them into the container** (`Makefile:141,172,227`; `package.json:84,91,98`). The guide's example puts the password inline (`DATABASE_MIGRATION_GUIDE.md:120-127`), so it lands in shell history. | **FAIL**                  |
| 8   | Password in logs or history            | Not printed by the script (PASS). The documented usage puts it in history (FAIL).                                                                                                                                                                    | —                         |
| 9   | Safe per environment                   | LOCAL: acceptable. DEV: only with a pre-check. **STAGING/PROD: unsafe (BLOCKER)**.                                                                                                                                                                   | §18                       |
| 10  | Production bootstrap protected         | **FAIL**: no one-time guard, no audit row (`admin_activity_logs`), no transaction, no MFA (A25), and the default phone opens admin-OTP access to whoever owns `+919999999999`                                                                        | `auth.service.ts:640-660` |

**Blocker:** the script exists, but it is **incomplete and unsafe for STAGING and PRODUCTION** (A10).

### 9.3 RBAC model

- **Roles:** `customer`, `driver`, `system_admin`, `admin`, `support`, `finance`.
- **Permissions:** `rbac:manage` and `staff:write` are LOCKED to `system_admin` (`roles.ts:324-333`).
- **Admin creation:** further admins are created through `staff:write` routes (`staff.routes.ts:7`, `staff.service.ts:124`) with the same 8-character minimum.
- **Revocation:** role revocation is a timestamp (`user_roles.revoked_at`). Role changes take effect when the token's `roles` claim is refreshed.

### 9.4 Commands

The safe procedures are in §18.

| Env     | Today                                                                                                                                                                                                                                              | Status                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| LOCAL   | Set `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` in `.env.local`, then `npm run seed:local`; or `read -rs ADMIN_PASSWORD; export ADMIN_PASSWORD; npm run admin:local`                                                                                | OK (host)                                  |
| DEV     | `docker compose --env-file .env.dev -f compose.dev.yml --profile ops run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_PHONE -e ADMIN_FIRST_NAME -e ADMIN_LAST_NAME ops npx tsx scripts/create-admin.ts`, **only after the SQL pre-check in §18** | Conditional                                |
| STAGING | Same pattern with `.env.staging`                                                                                                                                                                                                                   | **BLOCKED** until A10 is fixed             |
| PROD    | Same pattern with `.env.prod` and `OPS_IMAGE`                                                                                                                                                                                                      | **BLOCKED** until A10 and the A25 decision |

---

## 10. Backup, restore and recovery audit

| Check                                          | Result                                                                                                                                                                                                                                         | Evidence        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Backup script exists                           | Yes, `scripts/db-backup.sh` (`make db-backup`)                                                                                                                                                                                                 | —               |
| Targets the right DB on servers                | **FAIL**: reads `DATABASE_URL` from `.env.local` only (`:17-20`). On servers `DATABASE_URL` is the runtime login through PgBouncer, which cannot read `_prisma_migrations` (`verify-roles.sql:108-110`), so the dump fails. Inferred; NOT RUN. | A17             |
| Preserves data                                 | Yes (custom format, `.partial` then rename)                                                                                                                                                                                                    | `:39-51`        |
| Preserves grants and default privileges        | **FAIL**: `--no-owner --no-privileges` (`:47-48`); restore uses the same flags (`db-restore.sh:72-73`)                                                                                                                                         | F17, still open |
| Preserves roles                                | **FAIL**: roles are cluster-level and need `pg_dumpall --roles-only`                                                                                                                                                                           | —               |
| Preserves migration history                    | Yes, when dumped as the owner (`_prisma_migrations` is a table)                                                                                                                                                                                | —               |
| After restore, are runtime grants restored?    | **FAIL**: migration `20261002130100` is recorded as applied, so it never re-grants. `db-roles` only fixes the login and membership.                                                                                                            | A17             |
| Schedule, off-host copy, encryption, retention | No schedule. Stored in the repo's `backups/` on the same droplet, unencrypted. 14-day local pruning only.                                                                                                                                      | A17             |
| Client version                                 | Needs `pg_dump` ≥ 17 on the host; the droplet has none. Run it inside the postgres container.                                                                                                                                                  | —               |
| Valkey persistence                             | AOF on a named volume. Not backed up. Loss drops queued jobs, OTP challenges, rate limits and Redis-only auth epochs.                                                                                                                          | —               |
| Caddy volume                                   | Holds TLS certificates; loss means re-issuance (ACME rate limits)                                                                                                                                                                              | —               |
| Object storage                                 | Bucket versioning and replication are not configured by this repo (owner/infra)                                                                                                                                                                | BLOCKED         |
| Documented procedure                           | `DATABASE_MIGRATION_GUIDE.md` §6 contradicts the script (`pg_dump` without `--no-privileges`) and its compose commands lack `--env-file`                                                                                                       | A42             |

The documented recovery procedure is in §19.

---

## 11. Deployment and CI/CD audit

| Workflow                                                  | Trigger                                                  | What it does                                                                                                                              | Findings                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ci.yml`                                                  | push to main, develop, feature/**, …; PR to main/develop | quality; tests (Postgres + Redis services, **15-minute timeout**, `:58`); build + boot smoke as `APP_ENV=production`                      | Tests were cancelled at 15 min on every run (11-19); `prod` / `dev` names untested |
| `deploy-dev.yml` (untracked; **not on `origin/develop`**) | push to develop, manual                                  | builds and pushes prod and ops images to `ghcr.io/${{ github.repository }}`, then SSHes `deploy sha-<sha> <digest>`, then curls `/health` | **A08, A09**; no test gate (A21); smoke is liveness only (A27)                     |
| `prisma-check.yml`                                        | push/PR to main (schema paths)                           | format and validate                                                                                                                       | Not run for develop                                                                |
| `security.yml`                                            | push, PR, weekly                                         | gitleaks (no `--redact`, `:49`), `npm audit` (prod, high), dependency review, CodeQL, Trivy (`@master`, non-blocking, `:120,128`)         | A21                                                                                |
| `staging.yml`                                             | push to main, gated by `vars.DEPLOY_STAGING`             | builds `:staging` and `sha-*`, then Helm/K8s (no chart)                                                                                   | Wrong platform for Compose (A11)                                                   |
| `release.yml`                                             | tag `v*.*.*`                                             | lint, typecheck, **`npm test` with no database** (`:39`), build, release                                                                  | Cannot pass                                                                        |
| `production.yml`                                          | release published / manual                               | re-verifies, **rebuilds** the image, Helm deploy, `/health` smoke                                                                         | Not the tested digest (A21); Helm (A11)                                            |
| `deploy/bin/deploy.sh`                                    | SSH forced command                                       | flock, `git fetch origin develop` + checkout, pull digest, migrate, db-roles, `up --wait`, auto-rollback                                  | DEV-only constants (`:12-15`); A08; A19                                            |
| `deploy/bin/rollback.sh`, `status.sh`                     | SSH                                                      | —                                                                                                                                         | **FAIL** without `--env-file` (verified); status curls an unpublished port (A15)   |
| `deploy/bin/ssh-entry.sh`                                 | `authorized_keys command=`                               | Whitelist: deploy, status, rollback                                                                                                       | Unquoted argument expansion (`:13`), no SHA/digest validation (A16)                |
| `Makefile`                                                | manual                                                   | Compose wrappers                                                                                                                          | prod targets fail without `IMAGE_TAG`; no staging config target                    |

| Check                                               | Result                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Correct branch triggers                             | DEV = develop (PASS). STAGING = main, Helm. PROD = release, Helm. No Compose path for staging or prod.                                                                                                                         |
| Build and test gates before deploy                  | **FAIL** (DEV deploy is independent of CI; CI tests time out)                                                                                                                                                                  |
| Immutable GHCR images and digests                   | PARTIAL: DEV pulls by digest (good) but under the wrong name (A09). Production rebuilds instead of promoting.                                                                                                                  |
| Secret management                                   | GitHub environment `dev` secrets `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS`, vars `DEPLOY_HOST`, `API_URL`: **BLOCKED** (cannot verify). Server env files are plaintext on the droplet (owner decision).                             |
| Remote deploy permissions                           | Forced command (good); server provisioning not in the repo (BLOCKED)                                                                                                                                                           |
| Correct Compose env file                            | `deploy.sh` PASS; `rollback.sh` / `status.sh` FAIL                                                                                                                                                                             |
| Migration order                                     | PASS (migrate → roles → up)                                                                                                                                                                                                    |
| Health checks                                       | Liveness only (A27)                                                                                                                                                                                                            |
| Rollback                                            | Automatic rollback to the previous image after migrations (A19); manual rollback broken (A15)                                                                                                                                  |
| Workflow concurrency                                | PASS (`deploy-dev`, `deploy-staging`, `deploy-production` groups)                                                                                                                                                              |
| Production approval                                 | Requires a protected GitHub `production` environment: **BLOCKED** (on 11-19 it did not exist)                                                                                                                                  |
| **Can one tested image move DEV → STAGING → PROD?** | **No, not today.** Fix: build once on `develop` → push `zaroorat-backend@sha256:…` plus the ops image → test against it → staging/prod deploy the **same digest** with `deploy.sh <env> <sha> <digest>` after manual approval. |

---

## 12. Security findings (summary)

| ID  | Severity | Issue                                                                                                              |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| A01 | P0       | `prod` / `dev` bypass the production guards (restricted DB role, mock payment/SMS/push, scanner, default storage)  |
| A10 | P0       | First-admin script can take over and escalate any existing account; default phone opens admin-OTP access           |
| A14 | P1       | Postgres superuser and owner credentials inside the api/worker/ops containers                                      |
| A16 | P1       | Deploy forced command does not validate its arguments                                                              |
| A22 | P1       | Production and live third-party secrets on a developer laptop, inside the repo folder; npm scripts default to prod |
| A23 | P1       | `prisma:reset` has no environment guard                                                                            |
| A24 | P1       | `APP_ENV` defaults to `development` (fail-open)                                                                    |
| A25 | P1       | Staff login is single-factor; no MFA                                                                               |
| A34 | P2       | ops image runs as root; base images and the community PgBouncer image are not digest-pinned                        |
| A35 | P2       | Client-IP trust if Cloudflare proxies the API                                                                      |

Carried over from 11-19, not re-verified (BLOCKED):

- the repository is **public** with no effective branch protection (F16);
- gitleaks logs are unredacted (F24);
- public OSRM fallback routing is enabled in DEV and STAGING (`ALLOW_OFFLINE_ROUTING=true`, F30).

> Because the repository is public, this report and the untracked deployment files describe exploitable weaknesses. Fix the P0 security items before committing this report to a public branch.

---

## 13. File-by-file correction matrix

### 13.1 Summary and gates

| ID  | Sev | Primary file(s)                                                                                                                                                                                                                                  | Env                         | Blocks deploy                     | Fix before               |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------------- | ------------------------ |
| A01 | P0  | `src/bootstrap/database.bootstrap.ts:39`, `src/config/payment/payment.config.ts:18,78`, `src/modules/notifications/notification.config.ts:13`, `src/modules/files/config/storage.config.ts:39,67`, `src/shared/crypto/bank-account-crypto.ts:30` | PROD (P0), DEV (P1)         | Yes                               | DEV (dev part), PROD     |
| A02 | P0  | `.env.local:69` (with `src/app/trust-proxy.ts:36-40`)                                                                                                                                                                                            | LOCAL                       | Yes                               | LOCAL                    |
| A03 | P0  | `dev-otp-log.ts:6`, `logger.ts:7,11`, `transport.ts:3`, `cors.plugin.ts:6`, `mock.provider.ts:14`, `.env.local:39,70`                                                                                                                            | LOCAL                       | Yes (login)                       | LOCAL                    |
| A04 | P0  | `compose.local.yml:77,114`, `package.json:14,19`, `src/config/env/loader.ts:32-34`                                                                                                                                                               | LOCAL (Docker)              | Yes                               | LOCAL                    |
| A05 | P0  | `compose.local.yml:65-68,80-86,117-122`, `.env.local:22`, `prisma.config.ts:44`                                                                                                                                                                  | LOCAL (Docker)              | Yes                               | LOCAL                    |
| A06 | P0  | `docker/postgres/init/01-create-databases.sql:1` with `compose.local.yml:30`                                                                                                                                                                     | LOCAL                       | Yes (fresh volume)                | LOCAL                    |
| A07 | P0  | `.env.example` (deleted), `Makefile:66`, `loader.ts:33`                                                                                                                                                                                          | LOCAL                       | Yes (fresh clone)                 | LOCAL                    |
| A08 | P0  | `.github/workflows/deploy-dev.yml:86`, `deploy/bin/deploy.sh:29,37`                                                                                                                                                                              | DEV                         | Yes                               | DEV                      |
| A09 | P0  | `deploy-dev.yml:19`, `deploy.sh:15`, `compose.{dev,staging,prod}.yml` images, `deploy/env/*.infra.example`                                                                                                                                       | DEV/STAGING/PROD            | Yes                               | DEV                      |
| A10 | P0  | `scripts/create-admin.ts:8-80`, `Makefile:141,172,227`, `package.json:84,91,98`, `docs/DEPLOYMENT/DATABASE_MIGRATION_GUIDE.md:115-128`                                                                                                           | STAGING/PROD (P0), DEV (P1) | Yes (first admin)                 | DEV (pre-check), STAGING |
| A11 | P0  | `compose.prod.yml:28,66,192,235`, `.github/workflows/staging.yml`, `production.yml`, `deploy/bin/*.sh`                                                                                                                                           | STAGING/PROD                | Yes                               | STAGING                  |
| A12 | P0  | `.env.staging:84-86`, `storage.config.ts:37-57,108-116`, `storage.bootstrap.ts:1`                                                                                                                                                                | STAGING                     | Yes (files)                       | STAGING                  |
| A13 | P1  | `.env.prod:77-86`                                                                                                                                                                                                                                | PROD                        | Yes (files)                       | PROD                     |
| A14 | P1  | `compose.{dev,staging,prod}.yml` api/worker/ops `env_file`; `deploy/env/.env.*.example`                                                                                                                                                          | DEV/STAGING/PROD            | No (security)                     | DEV                      |
| A15 | P1  | `deploy/bin/rollback.sh:17`, `status.sh:8,11,14`, `deploy.sh:12-15,28`                                                                                                                                                                           | DEV and up                  | Rollback                          | DEV                      |
| A16 | P1  | `deploy/bin/ssh-entry.sh:13`, `deploy.sh:4-10`                                                                                                                                                                                                   | DEV and up                  | No (security)                     | DEV                      |
| A17 | P1  | `scripts/db-backup.sh:17-20,43-49`, `scripts/db-restore.sh:27-29,42-50,68-76`, `Makefile:266`                                                                                                                                                    | DEV and up                  | Restore                           | STAGING                  |
| A18 | P1  | `prisma/seed/shared/vehicle-types.ts:164-185`, `roles.ts:417-429`, `app-config.ts:742-810`, `prisma/seed/index.ts:35-39`                                                                                                                         | STAGING/PROD                | Re-seed                           | STAGING                  |
| A19 | P1  | `prisma/migrations/20261118110000_m06…/migration.sql:2,31`, `deploy.sh:56-61`                                                                                                                                                                    | DEV and up                  | Rollback                          | STAGING                  |
| A20 | P1  | working tree / branch state                                                                                                                                                                                                                      | all                         | Yes (nothing deployable from git) | DEV                      |
| A21 | P1  | `ci.yml:58`, `deploy-dev.yml` (no `needs`), `production.yml:115-123`, `release.yml:39`, `security.yml:49,120,128`                                                                                                                                | DEV and up                  | Promotion                         | STAGING                  |
| A22 | P1  | `.env.prod` / `.env.development` on the dev machine; `loader.ts:8`; `package.json:12-13,17-18,22-23,26,31`                                                                                                                                       | PROD                        | No                                | PROD                     |
| A23 | P1  | `package.json:66` (`scripts/reset-db.js`), `package.json:26,31,47,51`                                                                                                                                                                            | all servers                 | No                                | DEV                      |
| A24 | P1  | `src/config/env/schema.ts:4-6`                                                                                                                                                                                                                   | all                         | No                                | STAGING                  |
| A25 | P1  | `src/modules/auth/services/auth.service.ts:640-676`                                                                                                                                                                                              | PROD                        | Owner decision                    | PROD                     |
| A26 | P1  | all `.env.*` `*_CRON` lines vs `src/jobs/scheduler/index.ts`                                                                                                                                                                                     | DEV and up                  | No                                | STAGING                  |
| A27 | P2  | `compose.*.yml` healthchecks, `Dockerfile:133-134`, `deploy-dev.yml:91`, `status.sh`                                                                                                                                                             | servers                     | No                                | DEV                      |
| A28 | P2  | `compose.{dev,staging,prod}.yml` (no `logging:`)                                                                                                                                                                                                 | servers                     | No                                | DEV                      |
| A29 | P2  | `storage.bootstrap.ts:1`, `files/index.ts:29-30`, `notifications/index.ts:58-59`                                                                                                                                                                 | servers                     | No                                | DEV                      |
| A30 | P2  | `.env.*` lines 19-25, 38-39                                                                                                                                                                                                                      | servers                     | No                                | STAGING                  |
| A31 | P2  | `package.json:10-55`, `Makefile:243-262`                                                                                                                                                                                                         | all                         | No                                | DEV                      |
| A32 | P2  | `package.json:115-127,164-168`, `package-lock.json`                                                                                                                                                                                              | all                         | No                                | STAGING                  |
| A33 | P2  | `compose.dev.yml:3-9,36,75,202,246`, `deploy/env/.env.dev.infra.example:8-9`                                                                                                                                                                     | DEV                         | No                                | DEV                      |
| A34 | P2  | `Dockerfile:16,95-96,117`, `compose.*.yml` images                                                                                                                                                                                                | servers                     | No                                | PROD                     |
| A35 | P2  | `deploy/caddy/Caddyfile:7-10`, caddy `depends_on`                                                                                                                                                                                                | servers                     | No                                | PROD                     |
| A36 | P2  | `compose.{dev,staging,prod}.yml` postgres                                                                                                                                                                                                        | servers                     | No                                | PROD                     |
| A37 | P2  | `.env.*` `PAYMENT_LEDGER_CUTOVER_AT=` (F29); `ALLOW_OFFLINE_ROUTING=true` in dev/staging (F30)                                                                                                                                                   | servers                     | No                                | STAGING                  |
| A38 | P3  | `.env.*` (`FILE_*_PEEK_BYTES`), `.env.test:15-16`; undeclared `RIDE_*` business defaults                                                                                                                                                         | all                         | No                                | —                        |
| A39 | P3  | `.env.local:13` with `compose.local.yml`; pgbouncer health (F26)                                                                                                                                                                                 | LOCAL/servers               | No                                | —                        |
| A40 | P3  | `compose.test.yml:74`, `ci.yml:76,135`                                                                                                                                                                                                           | TEST                        | No                                | —                        |
| A41 | P3  | `prisma/seed/production/index.ts:7-19`                                                                                                                                                                                                           | servers                     | No                                | —                        |
| A42 | P3  | `prisma/seed/shared/roles.ts:43-54`, `DATABASE_MIGRATION_GUIDE.md`, `README.md` (concurrently edited), `loader.ts:33`, `Makefile:261`                                                                                                            | docs                        | No                                | —                        |

### 13.2 Details

**A01 — P0 — The new environment names bypass the production guards**

- **Current:** the guards in §3.4 compare against `'production'` / `'staging'` only. With `APP_ENV=prod`:
  - no restricted-role refusal;
  - mock gateway allowed, and the default when unset;
  - mock SMS/push allowed;
  - scanner may be disabled;
  - storage defaults to mock.

  `dev` has the payment, notification and scanner gaps.

- **Expected:** every guard treats `prod` exactly like `production`, and `dev` as deployed.
- **Why it matters:** these are fail-closed protections for money, delivery, audit integrity and uploads. They are currently held up only by the right values happening to be set.
- **Fix:** normalise once in `schema.ts`, either with a zod transform mapping `production`→`prod`, `development`→`local`, `testing`→`test`, or with two exported helpers (`isDeployed(env)`, `servesRealUsers(env)`) that every guard uses. Add one table-driven unit test over all names × guards. Extend the CI smoke to `APP_ENV=prod`.
- **Risk if not fixed:** a production config typo silently runs fake payments or SMS, or runs as the DB owner.

**A02 — P0 — `TRUSTED_PROXIES="false"` crashes the LOCAL API**

- **Current:** `resolveTrustProxy` throws `TRUSTED_PROXIES has invalid entries: false` (verified). `startup()` catches it and exits 1.
- **Fix:** set `TRUSTED_PROXIES=` (empty) in `.env.local` and the template. Optionally accept `false` as "trust none".
- **Risk:** no local API at all.

**A03 — P0 — `APP_ENV=local` loses the development behaviour, so nobody can log in locally**

- **Current:**
  - the OTP is logged only when `APP_ENV=development` and SMS is mock (verified `false` for `local`), and the logger level is `info` outside `development`;
  - HTTP CORS allow-all applies only to `development`;
  - `CORS_ALLOWED_ORIGINS="*"` becomes `['*']`, which `@fastify/cors` and `cors` match literally (`node_modules/@fastify/cors/index.js:289-299`, `node_modules/cors/lib/index.js:19-31`), so every browser origin is rejected.
- **Fix:** treat `local` as `development` everywhere (part of A01). Make a single `*` mean allow-all, or drop it from `.env.local`.
- **Risk:** local login impossible with mock SMS; the admin panel is blocked unless its dev server proxies the API.

**A04 — P0 — The LOCAL Docker API and worker require an env file the image does not contain**

- **Current:**
  - `npm run dev` / `worker:dev` pass `--env-file=.env.local`, but `.dockerignore:18` excludes it and nothing mounts it. Node exits 9 (verified);
  - under `tsx watch` the container then idles with nothing listening;
  - `loader.ts:32-34` also throws for `APP_ENV=local` without a file, which breaks `docker:local:seed` and `make seed-local`.
- **Fix:** in `compose.local.yml`, use `command: ['npx','tsx','watch','src/server.ts']` (and `src/worker.ts`) and mount `./.env.local:/app/.env.local:ro` the way `compose.test.yml:43` does. Or make the loader not throw when `DATABASE_URL` is already set.
- **Risk:** the LOCAL Docker stack never serves.

**A05 — P0 — LOCAL migration points at the container's own loopback**

- **Current:** `.env.local` `MIGRATION_DATABASE_URL=…127.0.0.1:5432` reaches the `migrate` container (verified), and `prisma.config.ts:44` prefers it. api and worker wait on `migrate` completing successfully.
- **Fix:** add `MIGRATION_DATABASE_URL: postgresql://zaroorat:zaroorat@postgres:5432/zaroorat_local` to the `migrate` environment, or remove the key from `.env.local`.
- **Risk:** `make up-local` fails.

**A06 — P0 — The LOCAL Postgres init script collides with `POSTGRES_DB`**

- **Current:** the entrypoint creates `zaroorat_local` from `POSTGRES_DB` before running the init files. `CREATE DATABASE zaroorat_local;` then fails with `ON_ERROR_STOP`, so `02-create-extensions.sh` and `zaroorat_test` are never created. The file also creates `zaroorat_dev`, `zaroorat_staging` and `zaroorat_prod` on a laptop. (NOT RUN; based on the official image's entrypoint behaviour.)
- **Fix:** keep only `CREATE DATABASE zaroorat_test;` and loop the extension script over `zaroorat_local` and `zaroorat_test`.
- **Risk:** the first boot on a fresh volume fails or flaps, and integration tests have no database.

**A07 — P0 — There is no committed local env template**

- **Current:** `.env.example` is deleted. `Makefile:66` copies `.env.local.example`, which does not exist. The loader's error message still points to `.env.example`.
- **Fix:** commit `.env.local.example` with mock providers, `APP_ENV=local`, `127.0.0.1` URLs, empty `TRUSTED_PROXIES` and no real keys. Update the message.
- **Risk:** a fresh clone cannot start.

**A08 — P0 — The DEV deploy passes a commit id that the server script cannot use**

- **Current:** `deploy-dev.yml:86` sends `sha-<sha>`, so `deploy.sh:29` runs `git checkout --detach sha-…` and aborts. `deploy.sh:37` would also pull `:sha-sha-…-ops`.
- **Fix:** send `${{ github.sha }}` raw.
- **Risk:** every DEV deploy fails.

**A09 — P0 — The image name differs between CI and the server**

- **Current:** CI pushes `ghcr.io/zaroorat-mobility/zaroorat-back` (`github.repository`), while `deploy.sh:15`, every Compose default and the infra examples use `…/zaroorat-backend`.
- **Fix:** set `IMAGE_NAME: zaroorat-mobility/zaroorat-backend` explicitly in the workflows (owner decision D3), or rename everywhere else.
- **Risk:** the digest pull fails.

**A10 — P0 — The first-admin bootstrap is unsafe**

- **Current:** see §9.1–9.2.
- **Expected:**
  - refuse to run if any active `system_admin` exists, unless `--force-additional` is given;
  - require explicit `ADMIN_EMAIL` and `ADMIN_PHONE` (no defaults);
  - refuse if the email or phone belongs to any existing user;
  - create the user and the role in one transaction;
  - write an `admin_activity_logs` row;
  - read the password from stdin with no echo (or a file descriptor), with at least 12 characters required.
- **Fix:** change the script. Change the Makefile and npm commands to `run --rm -e ADMIN_EMAIL -e ADMIN_PHONE -e ADMIN_PASSWORD ops …` (pass-through, no values). Fix the guide.
- **Risk:** account takeover and privilege escalation; admin-OTP access for the owner of the default number.

**A11 — P0 — No Compose build/deploy path exists for STAGING and PROD**

- **Current:**
  - `compose.prod.yml` requires `IMAGE_TAG` (verified failure), and no workflow builds the expected `:staging`, `:staging-ops` or `:${tag}-ops` images;
  - `staging.yml` and `production.yml` deploy with Helm;
  - `deploy/bin/*.sh` are hard-coded to `compose.dev.yml` and `develop`.
- **Fix:** parameterise `deploy.sh <env> <sha> <digest>` with the env-specific compose file, branch and env file. Make staging and production workflows _promote_ the DEV-tested digest over SSH behind GitHub environment approval. Delete the Helm workflows once that works.
- **Risk:** no reproducible staging or production deploy.

**A12 — P0 — STAGING storage configuration**

- **Current:** `.env.staging` sets `STORAGE_MALWARE_SCANNER=disabled`, which `storage.config.ts:50-55` forbids for `staging`. The provider is created lazily, so the API boots and **every upload or file read fails**. GuardDuty plus KMS (the code's requirement) is AWS-only, while staging points at DO Spaces.
- **Fix:** owner decision D2: AWS S3 for staging, or an explicit code-level policy allowing Spaces with a different scanner.
- **Risk:** document and photo flows broken in staging.

**A13 — P1 — PROD storage targets AWS with no credentials**

- **Current:** empty endpoint (so AWS), guardduty plus `aws:kms`, and empty access keys. A droplet has no IAM role.
- **Fix:** an IAM user with least-privilege keys, or a different storage decision (D2).
- **Risk:** uploads fail in production.

**A14 — P1 — Infrastructure secrets leak into the app containers**

- **Current:** `.env.<env>` is both the interpolation file and `env_file`, so api, worker and ops hold `POSTGRES_PASSWORD`, `MIGRATION_DATABASE_URL`, `APP_DB_PASSWORD` and `REDIS_PASSWORD` (verified).
- **Fix:**
  - use `.env.<env>.infra` (templates already in `deploy/env/`) **only** with `--env-file`;
  - remove the owner, superuser and infra keys from the app file;
  - build `DATABASE_URL` and `REDIS_URL` in Compose for api and worker, as `ops` already does;
  - keep `MIGRATION_DATABASE_URL` only on `migrate` and `ops`.
- **Risk:** any env disclosure (RCE, debug endpoint, crash dump) yields DB superuser access, defeating the audit-trail protection.

**A15 — P1 — The rollback and status scripts are broken; the deploy scripts are DEV-only**

- **Current:** no `--env-file`, so interpolation fails (verified). `status.sh` curls `127.0.0.1:3000`, which is not published.
- **Fix:** shared `env` arguments, `docker compose exec api node -e "fetch(...)"` for probes, and parameterise as in A11.
- **Risk:** no rollback in an incident.

**A16 — P1 — Deploy command arguments are not validated**

- **Current:** `${ORIGINAL_CMD#deploy }` is passed unquoted and the SHA and digest are never checked.
- **Fix:** `[[ $SHA =~ ^[0-9a-f]{40}$ && $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1`, quote the expansion, and document the `authorized_keys` `command=…,no-pty,no-port-forwarding` line and the deploy user's docker access.
- **Risk:** argument injection by anyone holding the key.

**A17 — P1 — Backups would not restore a working system**

- **Current:** see §10.
- **Fix:** add `deploy/bin/backup.sh <env>` that runs, inside the postgres container as the owner, `pg_dump -Fc` (**with** privileges) plus `pg_dumpall --roles-only --no-role-passwords`. Schedule it with cron/systemd, copy it off-host encrypted (D9), and run a monthly restore drill (§19).
- **Risk:** an unrecoverable or unusable database after an incident.

**A18 — P1 — Re-seeding a live database resets admin-managed data**

- **Fix:** split the production seed into "create if missing" for live databases (skip existing pricing rules, themes and fonts; never delete grants) and "converge" behind an explicit flag. Make the unknown-`APP_ENV` default throw instead of seeding production.
- **Risk:** silent fare and RBAC resets.

**A19 — P1 — Migration rollback compatibility**

- **Fix:**
  - correct the m06 header or relax the constraint;
  - add a "backward compatible: yes/no" line to every new migration;
  - make `deploy.sh` skip the automatic image rollback when the release applied a migration;
  - take a pre-migrate backup.
- **Risk:** a crash loop or broken admin features after a rollback.

**A20 — P1 — Nothing deployable exists in git**

- **Current:** the deployment work is uncommitted and mixed with pricing work in progress, including an untracked migration. `origin/develop` is from October.
- **Fix:** commit the deployment files by explicit path on their own branch, keep the pricing migration with its feature, and merge to develop through a PR. Build images only in CI.
- **Risk:** deploying an image built from a dirty tree introduces schema drift.

**A21 — P1 — CI/CD gates are weak**

- **Fix:**
  - `deploy-dev` waits for CI (or runs tests itself);
  - test timeout of 40 minutes plus per-test timeouts;
  - `release.yml` gets DB services or drops `npm test`;
  - production promotes a digest instead of rebuilding;
  - pin Trivy (blocking on fixable CRITICAL) and every third-party action by full commit SHA. This matters most in `deploy-dev.yml`: `docker/setup-buildx-action@v3`, `docker/login-action@v3` (which receives `GITHUB_TOKEN` with `packages: write`) and `docker/build-push-action@v6` build and push the very image the droplet deploys, so a hijacked tag would ship attacker code to DEV;
  - `gitleaks --redact`.
- **Risk:** untested or unscanned code reaches servers.

**A22 — P1 — Production secrets custody**

- **Current:** `.env.prod` with real JWT, encryption and pepper secrets sits in a developer working directory (gitignored), next to scripts that run code against it. The legacy `.env.development` holds live AWS, Firebase, Airtel, Google and Razorpay credentials and is still auto-loaded. Rotation of those was already pending (2026-10-21).
- **Fix:** keep production and staging secrets only on the server (`/etc/zaroorat/<env>/`, mode 0600) or in a secret manager (D7). Delete `.env.development` after migrating to `.env.local`, and rotate.
- **Risk:** laptop compromise means production compromise.

**A23 — P1 — Dangerous commands have no guard**

- **Fix:** guard `prisma:reset` so it refuses unless `APP_ENV` is `local` or `test` and the host is loopback. Remove the defaults to prod.
- **Risk:** a wiped server database.

**A24 — P1 — `APP_ENV` defaults to `development`**

- **Fix:** require `APP_ENV`, with no default, at least when `NODE_ENV=production`.
- **Risk:** a container missing `APP_ENV` runs with development behaviour: open CORS, mock providers allowed, OTP logged.

**A25 — P1 — No MFA for staff**

- **Fix:** owner decision D4: TOTP for `system_admin` and `finance` before production, or IP allow-listing of the admin API.
- **Risk:** single-factor control over the whole platform.

**A26 — P1 — Job schedule drift**

- **Fix:** delete the `*_CRON` overrides from the env templates unless deliberately chosen (D5). Document that all schedules run in UTC.
- **Risk:** refunds and collections delayed by up to a day.

**A27–A42 — P2/P3.** See the summary table above. Concrete fixes:

- **Health checks:** probe `/ready` in Compose and in the post-deploy smoke test, and add an alert on unhealthy status.
- **Logging:** `logging: {driver: json-file, options: {max-size: 10m, max-file: '5'}}` on every service.
- **Fail-fast config:** resolve `storageProvider`, `smsProvider` and `pushProvider` in `startup()` and `startWorker()`.
- **Secrets in URLs:** compose `DATABASE_URL` and `REDIS_URL` from the infra variables in Compose, and URL-encode passwords.
- **npm/Make:** clean-up per §6.7.
- **Prisma:** pin `prisma` and `@prisma/client` to the same exact version.
- **DEV images:** align tags (`dev-latest` vs `:dev`) and remove `build:` from `compose.dev.yml`.
- **Image hardening:** run ops as `USER node` and pin base and community images by digest.
- **Caddy / Cloudflare:** decide the Cloudflare proxy mode (D6); if proxied, use Caddy `trusted_proxies` with Cloudflare ranges and `client_ip_headers CF-Connecting-IP`.
- **Postgres container:** `stop_grace_period: 60s`, `shm_size: 256mb`, `shared_buffers` ≈ 25% of the limit.
- **Ledger cut-over:** set `PAYMENT_LEDGER_CUTOVER_AT` explicitly (D11) and disable public OSRM in deployed envs.
- **Dead variables:** rename or remove them, and declare `RIDE_COMMISSION_RATE` / `RIDE_TAX_RATE` explicitly or document their defaults.
- **LOCAL worker:** override `WORKER_HEALTH_HOST=0.0.0.0` in `compose.local.yml`.
- **Test stack:** switch it to Valkey 8.1.
- **Templates:** seed notification templates in production, if the admin should start with them.
- **Docs:** fix the stale comment, the guide commands (add `--env-file`), the README claims and the Makefile label.

### 13.3 Owner decisions needed

| #   | Decision                             | Recommendation                                                                                                   |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| D1  | Canonical environment names          | Keep `local, dev, test, staging, prod`; accept the old names as aliases normalised in the schema for one release |
| D2  | Staging/prod object storage          | AWS S3 + GuardDuty + KMS (code as designed) **or** DO Spaces with an explicit "no GuardDuty" policy change       |
| D3  | GHCR image name                      | `zaroorat-mobility/zaroorat-backend` (fewer edits)                                                               |
| D4  | Staff MFA before production          | Yes, for `system_admin` and `finance`                                                                            |
| D5  | Job frequencies                      | Restore the code defaults unless a deliberate choice was made                                                    |
| D6  | Cloudflare proxy for API domains     | Decide; it affects client-IP trust and WebSocket timeouts                                                        |
| D7  | Secret custody                       | Server-only files at 0600 now; a secret manager later                                                            |
| D8  | Staging/prod deploy mechanism        | Compose over SSH, promoting the DEV digest; retire Helm workflows                                                |
| D9  | Backup target and retention          | Encrypted off-host copy (Spaces or S3), 30 daily + 12 monthly, plus DO droplet backups                           |
| D10 | Re-seeding policy for live databases | Never automatically; only a reviewed "create-missing" mode                                                       |
| D11 | `PAYMENT_LEDGER_CUTOVER_AT` value    | An explicit timestamp per environment                                                                            |

---

## 14. Final recommended folder structure

Minimal change from today. No new layers.

```
zaroorat-back/
├── Dockerfile                    # keep: deps, local, test, build, ops (USER node), prod-deps, prod (last)
├── .dockerignore
├── .env.local.example            # NEW, committed: mock providers, 127.0.0.1, APP_ENV=local
├── .env.test                     # committed (throwaway values)
├── compose.local.yml             # A04-A06 fixed
├── compose.test.yml
├── compose.dev.yml               # no build:, logging, /ready health, app env without infra secrets
├── compose.staging.yml           # optional later: one compose.server.yml + .env.<env>.infra
├── compose.prod.yml
├── deploy/
│   ├── bin/{deploy.sh,rollback.sh,status.sh,backup.sh,ssh-entry.sh}   # all take <env>
│   ├── caddy/Caddyfile
│   ├── env/.env.{dev,staging,prod}.example         # APP variables only
│   ├── env/.env.{dev,staging,prod}.infra.example   # Compose interpolation only
│   └── README.md                 # droplet bootstrap: user, docker, authorized_keys, GHCR login, cron
├── docker/postgres/init/         # LOCAL/TEST only
├── scripts/{create-admin.ts,db/*.sql,…}
└── docs/DEPLOYMENT/
```

On each server:

- `/opt/zaroorat/<env>/src` (detached git checkout)
- `/etc/zaroorat/<env>/.env.<env>` and `/etc/zaroorat/<env>/.env.<env>.infra` (both `root:deploy 0640`)
- `/var/backups/zaroorat/<env>/`

---

## 15. Environment-specific command reference (as of today)

Commands marked ✘ fail until the cited finding is fixed.

```bash
# ── LOCAL (host-run API, Docker infra) ─────────────────────────────
docker compose --env-file .env.local -f compose.local.yml up -d --wait postgres valkey   # ✘ fresh volume: A06
npm run migrate:status:local && npm run migrate:local
npm run seed:local                      # set ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD first
npm run dev:local                       # ✘ A02 (TRUSTED_PROXIES), A03 (OTP/CORS)
npm run worker:local
# full Docker LOCAL:  make up-local     # ✘ A04, A05, A06, A07

# ── TEST ──────────────────────────────────────────────────────────
make test-docker                        # migrate + seed + full suite in containers, then down -v
npx cross-env APP_ENV=test tsx --test --test-force-exit "tests/unit/**/*.test.ts"

# ── DEV (on the droplet, in /opt/zaroorat/src) ─────────────────────
DC="docker compose --env-file .env.dev -f compose.dev.yml --profile ops"
export APP_IMAGE=ghcr.io/zaroorat-mobility/<image>@sha256:<digest>      # ✘ A09 name
export OPS_IMAGE=ghcr.io/zaroorat-mobility/<image>:sha-<sha>-ops
$DC config -q
$DC run --rm ops npx prisma migrate status
$DC run --rm migrate && $DC run --rm db-roles
$DC up -d --wait api worker caddy
$DC logs -f api worker
$DC exec api node -e "fetch('http://127.0.0.1:3000/ready').then(r=>r.text()).then(console.log)"

# ── STAGING ───────────────────────────────────────────────────────
DC="docker compose --env-file .env.staging -f compose.staging.yml --profile ops"   # ✘ A11 (no images), A12

# ── PROD ──────────────────────────────────────────────────────────
export IMAGE_TAG=<tag>   # or APP_IMAGE / OPS_IMAGE by digest
DC="docker compose --env-file .env.prod -f compose.prod.yml --profile ops"         # ✘ A01, A10, A11, A13, A17
```

---

## 16. Runbook — fresh database initialisation (DEV; same for STAGING and PROD with their files)

**Preconditions:**

- A08, A09, A14 and A20 are fixed.
- DNS for the domain points at the droplet. Docker and Compose are installed. The deploy user exists. The server is logged in to GHCR with a read-only token.
- The env files are on the server at mode 0600 with **real** values, and no placeholders remain (BLOCKED today).

```bash
cd /opt/zaroorat/src && git fetch origin && git checkout --detach <40-char-sha>
DC="docker compose --env-file .env.dev -f compose.dev.yml --profile ops"
export APP_IMAGE=ghcr.io/zaroorat-mobility/zaroorat-backend@sha256:<digest>
export OPS_IMAGE=ghcr.io/zaroorat-mobility/zaroorat-backend:sha-<sha>-ops
docker pull "$APP_IMAGE" && docker pull "$OPS_IMAGE"
$DC config -q                                   # must print nothing

$DC up -d --wait postgres valkey                # 1. data services
$DC run --rm migrate                            # 2. schema, extensions, runtime group, grants
$DC run --rm db-roles                           # 3. runtime login (password via \getenv)
$DC run --rm db-roles psql -h postgres -U zaroorat -d zaroorat_dev \
    -v app_user=zaroorat_app -f /scripts/verify-roles.sql      # 4. expect: ALL ROLE CHECKS PASSED
$DC up -d --wait pgbouncer                      # 5. pooler
export PGPASSWORD="$(grep -E '^APP_DB_PASSWORD=' .env.dev | cut -d= -f2-)"
$DC run --rm -e PGPASSWORD db-roles psql -h pgbouncer -p 6432 -U zaroorat_app \
    -d zaroorat_dev -f /scripts/verify-runtime-login.sql        # 6. expect: ALL RUNTIME-LOGIN CHECKS PASSED
unset PGPASSWORD
$DC run --rm ops npx prisma migrate status      # 7. expect: Database schema is up to date
$DC run --rm ops npx prisma db seed             # 8. ONCE, fresh DB only
#                                                 9. first admin: §18
$DC up -d --wait api worker caddy               # 10. application
curl -fsS https://dev-api.zaroorat.com/ready    # 11. expect status ready (database, redis ok)
#                                                 12. baseline backup: §19.1
```

---

## 17. Runbook — normal deployment to an existing database

**Automated path (after A08, A09 and A21 are fixed):** merge to `develop`, CI passes, the image is built once, then `ssh deploy@host "deploy <sha> <digest>"`. Manual equivalent:

1. **Pre-flight:**
   - CI is green for `<sha>`;
   - `$DC run --rm ops npx prisma migrate status` lists the pending migrations;
   - read each pending `migration.sql` and confirm it is expand-only, noting any NOT NULL, DROP, RENAME, type change or trigger.
2. **Backup:** §19.1. This is mandatory when any migration is pending.
3. **Migrate:** `$DC run --rm migrate`, then `$DC run --rm db-roles` (idempotent).
4. **Roll the application:** `$DC up -d --wait api worker`. Caddy only restarts when its config changes.
5. **Verify:**
   - `/ready` returns 200;
   - `$DC logs --since 5m api worker` shows no errors;
   - smoke tests: OTP request on DEV, quote, admin login.
6. **Record** the digest as current (`/opt/zaroorat/current-image.txt`) and the old one as previous.
7. **Never** run the seed as part of a deploy (A18).

---

## 18. Runbook — first-admin creation

**STAGING and PRODUCTION: do not run until A10 is fixed and D4 is decided (BLOCKER).**

For DEV, only with every step below. LOCAL should use the dev seed admin (§9.4).

```bash
DC="docker compose --env-file .env.dev -f compose.dev.yml --profile ops"
# 1. Roles must be seeded
$DC exec -T postgres psql -U zaroorat -d zaroorat_dev -tAc \
  "SELECT count(*) FROM roles WHERE slug='system_admin';"          # expect 1
# 2. The email and phone must belong to NO existing user (the script would take that user over)
$DC exec -T postgres psql -U zaroorat -d zaroorat_dev -tAc \
  "SELECT count(*) FROM users WHERE lower(email)=lower('<admin-email>') OR phone_number='<+91owner-phone>';"  # expect 0
# 3. Provide the values without echoing or storing the password
export ADMIN_EMAIL='<admin-email>' ADMIN_PHONE='<+91owner-phone>' ADMIN_FIRST_NAME='Platform' ADMIN_LAST_NAME='Admin'
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD         # 12+ characters; typed, not pasted into history
$DC run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_PHONE -e ADMIN_FIRST_NAME -e ADMIN_LAST_NAME \
  ops npx tsx scripts/create-admin.ts
unset ADMIN_PASSWORD
# 4. Exactly one active system_admin must exist
$DC exec -T postgres psql -U zaroorat -d zaroorat_dev -tAc \
  "SELECT u.id, u.status FROM users u JOIN user_roles ur ON ur.user_id=u.id AND ur.revoked_at IS NULL
     JOIN roles r ON r.id=ur.role_id WHERE r.slug='system_admin';"
# 5. Log in to the admin panel; create named staff accounts via Staff Management; record the bootstrap manually
```

`ADMIN_PHONE` must be a number the platform owner controls: admin OTP login works by phone.

---

## 19. Runbook — rollback and recovery

### 19.1 Backup, as recommended until A17 is fixed

Run on the server as the owner, inside the container. Never use `scripts/db-backup.sh` there.

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ); B=/var/backups/zaroorat/dev; mkdir -p "$B"
$DC exec -T postgres pg_dump -U zaroorat -d zaroorat_dev -Fc > "$B/db-$TS.dump"                     # keeps grants and default ACLs
$DC exec -T postgres pg_dumpall -U zaroorat --roles-only --no-role-passwords > "$B/roles-$TS.sql"
# copy off-host, encrypted (D9); verify with: pg_restore --list "$B/db-$TS.dump" | head
```

### 19.2 Application rollback

| Situation                                             | Action                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The release applied **no** migration                  | `APP_IMAGE=<previous digest> $DC up -d --wait api worker` (the env file is mandatory)                                                                                                                                                                                                                    |
| Migrations applied and all verified expand-only       | Same as above                                                                                                                                                                                                                                                                                            |
| A migration is **not** backward compatible (e.g. m06) | **Forward-fix** with a new release. Restore (19.3) only if the data loss since the backup is acceptable.                                                                                                                                                                                                 |
| A migration **failed**                                | `$DC run --rm ops npx prisma migrate status`; inspect `_prisma_migrations` as the owner. If the failed migration left no objects behind: `$DC run --rm ops npx prisma migrate resolve --rolled-back <name>`, fix it in a new commit, redeploy. If it was completed manually: `resolve --applied <name>`. |

### 19.3 Database restore (recovery)

1. `$DC stop api worker` (take traffic down; Caddy then answers 502).
2. On a **new** cluster, recreate the roles first: `psql -f roles-<ts>.sql` (or `CREATE ROLE zaroorat_app_runtime NOLOGIN;`).
3. Restore into an empty database as the owner: `pg_restore -U zaroorat -d zaroorat_dev --exit-on-error -j 4 db-<ts>.dump`. Keep privileges (no `--no-privileges`).
4. `$DC run --rm db-roles` to reset the login password and membership.
5. Run `verify-roles.sql` and `verify-runtime-login.sql` (§16, steps 4 and 6); both must PASS.
6. `migrate status` must show up to date.
7. `$DC up -d --wait api worker`, then check `/ready`.
8. **If Valkey was lost:** restarting the worker re-registers the schedulers. Queued jobs, OTP challenges, rate limits and Redis-only auth epochs are gone, so expect users to re-login.
9. Write an incident note covering the data window lost between the backup and the incident.

---

## 20. Production readiness checklist

**Configuration**

- [ ] A01: `prod` and `dev` recognised by every guard; table-driven test; CI smoke under `APP_ENV=prod`
- [ ] A24: `APP_ENV` required
- [ ] A14, A30: app and infra env split; no owner or superuser credentials in app containers
- [ ] A22: production secrets only on the server or in a secret manager; laptop copies removed; Razorpay, Google, AWS, Firebase and Airtel keys rotated
- [ ] A26, A37: job schedules and `PAYMENT_LEDGER_CUTOVER_AT` confirmed; public OSRM off
- [ ] All placeholders replaced (storage, Airtel, Firebase, maps, Razorpay live, SMTP, webhook secret); `config -q` passes

**Images and CI/CD**

- [ ] A20: deployment work committed and reviewed; images built only in CI
- [ ] A09, A11, A21, A33: one image name; build once; promote the same digest DEV → STAGING → PROD; GitHub `production` environment with required reviewers
- [ ] A21: CI tests pass within the timeout; Trivy blocking on fixable CRITICAL; actions pinned; gitleaks redacted
- [ ] A34: base images and PgBouncer pinned by digest; ops image non-root

**Database**

- [ ] All 87 (or the committed set of) migrations applied to a fresh staging DB; `verify-roles.sql` and `verify-runtime-login.sql` PASS
- [ ] A19: migration compatibility policy in place; automatic rollback disabled after migrations
- [ ] A17: scheduled, off-host, encrypted backups; **one restore drill completed**
- [ ] A18: production seed run once; re-seed guarded

**Access**

- [ ] A10: hardened first-admin script; exactly one bootstrap admin; owner-controlled phone
- [ ] A25: staff MFA (or a documented compensating control)
- [ ] A16: deploy key forced-command and argument validation; droplet hardening documented (UFW 22/80/443, SSH keys only, unattended upgrades)
- [ ] F16: branch protection on `main` and `develop` (public repository)

**Operations**

- [ ] A27, A28: `/ready` health checks, log rotation, an uptime alert on `/ready`, worker `/ready` monitored
- [ ] A12, A13: storage working end-to-end (upload → scan → read)
- [ ] A35: Cloudflare/Caddy client-IP decision applied
- [ ] A36: Postgres container tuned; disk-space alert
- [ ] Rollback rehearsed on staging (image rollback and restore)

---

## 21. Recommended implementation sequence

Each phase is small and reviewable, and ends with its own verification. Nothing starts without owner approval.

| Phase                                 | Scope                                                                                                                                                                                                                      | Findings                                              | Exit check                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **0. Decisions and hygiene**          | Owner answers D1–D11. Separate the deployment files from the pricing work in progress into their own commit or PR.                                                                                                         | A20                                                   | A clean branch with only deployment files                                                            |
| **1. LOCAL unblocked**                | `.env.local.example`; `TRUSTED_PROXIES` empty; local treated as development (OTP log, CORS); container commands without `--env-file` plus mounted env; `MIGRATION_DATABASE_URL` override; init SQL fix; worker health host | A02–A07, A39                                          | `make up-local` healthy; OTP visible in the log; admin panel works locally; `make test-docker` green |
| **2. Environment-name normalisation** | One normalisation point plus helpers; replace every comparison in §3.4; required `APP_ENV`; table-driven test; CI smoke with `prod`                                                                                        | A01, A24                                              | The unit test covers every guard × every name                                                        |
| **3. DEV deploy pipeline**            | SHA argument, image name, test gate, env/infra split, rollback/status, argument validation, `/ready` health, log rotation, eager providers, tags, `prisma:reset` guard, Prisma version pin                                 | A08, A09, A14–A16, A21 (part), A23, A27–A29, A32, A33 | A push to develop deploys a digest; `/ready` passes over HTTPS; rollback rehearsed                   |
| **4. Safe bootstrap and data**        | Hardened `create-admin.ts` plus commands; server backup script plus cron plus a restore drill; seed live-DB mode; migration compatibility note                                                                             | A10, A17, A18, A19                                    | First admin created on DEV per §18; restore drill passes `verify-*.sql`                              |
| **5. STAGING**                        | Parameterised `deploy.sh`; staging promotion workflow; storage decision applied; cron and ledger values; URL-composition clean-up                                                                                          | A11, A12, A26, A30, A37                               | The DEV-tested digest runs on staging; end-to-end ride, payment sandbox and upload pass              |
| **6. PRODUCTION**                     | Production storage credentials, secret custody, MFA, approval environment, pinning, Cloudflare/Caddy, Postgres tuning, monitoring; full checklist in §20                                                                   | A13, A22, A25, A34–A36 (+F16)                         | §20 fully ticked; owner sign-off                                                                     |

---

_This report is the only file the audit created. It changes nothing else. Re-check branch heads and the working tree before starting Phase 0, because other sessions edit this repository concurrently._
