# Full Multi-Environment Docker Audit: Zaroorat Mobility Backend

| | |
|---|---|
| Date | 2026-11-20 (Re-verified & Extended) |
| Scope | `zaroorat-back`: LOCAL and DEV now; STAGING and PRODUCTION prepared only |
| Audited code | `origin/main` @ `53d3cf1` (2026-11-13), exported to a scratch folder with `git archive` and built there. The working folder (`pricing/phase0-integration` + uncommitted pricing WIP) was **not** used for builds and was not modified. |
| Status | **Audit only.** No application or config file changed. No commit, push, cloud resource, DNS change or deployment. This report is the only new file, and it is untracked. |
| Companion reports | `C:\dev\Zaroorat_production\DIGITALOCEAN_DEPLOYMENT_AUDIT_2026-11-19\` (same day, staging-first design, environment inventory with 311 names). This report re-prioritises to LOCAL → DEV and adds runtime test evidence. |

## How the runtime checks were run

- Docker Desktop was started with the owner's approval.
- Three pre-existing containers auto-started (`zaroorat-dev-redis-1`, `zaroorat-dev-postgres-1`, `zaroorat-backend-postgres-1`). They were stopped right away, restoring their prior state. Their volumes were not touched.
- All tests ran under the separate compose projects `zaroorat-audit-prod` and `zaroorat-audit-local`, with throwaway generated values (random hex secrets and a throwaway RSA key in a fake Firebase service-account JSON) and **no published ports** except one bound to 127.0.0.1.
- No real SMS, payment, push, storage or maps call was made: real-provider modes only booted, and OTP traffic used the mock SMS provider.
- Both audit projects, their volumes and the audit images were removed afterwards. End state: 0 running containers, and the owner's 6 original volumes intact.

Result labels: **PASS** / **FAIL** = executed. **BLOCKED** = executed but cannot complete. **NOT RUN** = not executed (reason given). Findings marked *(code reading)* were not executed.

---

## 1. Repository scan summary

| Area | Files | Notes |
|---|---|---|
| Runtime entrypoints | `src/server.ts` → `bootstrap/startup.bootstrap.ts`; `src/worker.ts` → `bootstrap/worker.bootstrap.ts` | `npm start` = `node dist/server.js`, `npm run worker` = `node dist/worker.js` (verified in the image, H6) |
| Environment loading | `src/config/env/{loader,schema,validator}.ts`, `prisma.config.ts` | Zod schema, fail-fast (verified A6) |
| Docker | `Dockerfile` (6 stages), `.dockerignore`, `compose.dev.yml` (LOCAL stack today), `compose.test.yml`, `compose.prod.yml` (single-host stack), `docker/postgres/{init,scripts}/*` | No other Compose files exist. No Caddy or Nginx config. |
| Database | `prisma/schema/**` (multi-file), 76 migrations on `origin/main` (87 on the pricing branch), `prisma/seed/{production,development,testing,shared}` | `scripts/db/create-app-login.sql` creates the restricted runtime login |
| Queues | `src/jobs/{queues,scheduler,workers,consumers}`, BullMQ 6.0.7, ioredis 5.11.1 | 10 queues, 19 cron schedules, worker-only |
| Realtime | `src/modules/realtime/*`, `@socket.io/redis-adapter` 8.3.0 | JWT handshake. Redis adapter by default in staging/production. |
| CI/CD | `.github/workflows/{ci,prisma-check,release,staging,production,security}.yml` | Six workflows. `staging.yml` and `production.yml` deploy with **Kubernetes/Helm**. No other workflows. |
| Kubernetes | `infrastructure/helm/**` (~700 lines), Kubernetes docs under `docs/04_Architecture`, `docs/11_Infrastructure` | Kept. Removal needs approval. |
| Ops scripts | `scripts/db-backup.sh`, `scripts/db-restore.sh`, `scripts/release/verify-otp-job-browser.js`, `scripts/*.ts` (tsx), `Makefile` | The `.ts` scripts need tsx, which is **not in the runtime image** |
| Repo state | Public repository. `main` and `develop` unprotected. The `main` ruleset targets no branch. | See the companion EXISTING_CICD_AUDIT.md |

## 2. Current architecture (as built today)

```
LOCAL (compose.dev.yml, project "zaroorat-dev")         SERVER (compose.prod.yml, project "zaroorat-prod") — never deployed
  migrate (dev image, one-shot) ─┐                         migrate (runner image, owner, profile) ─┐
  api  (tsx watch, :3000 published)                        db-roles (psql, profile) ───────────────┤
  worker (tsx watch, :3001 published)                      api (runner, npm run start, :3000 published on 0.0.0.0)
  postgres PostGIS 17-3.5 (:5432 published)                worker (runner, npm run worker)
  redis 8 (:6379 published)                                pgbouncer (transaction) → postgres PostGIS 17-3.5
                                                           redis 8 (AOF, noeviction, password)
CI: GitHub Actions (lint/types, tests, image build + boot smoke) · CD: Helm to Kubernetes (no cluster exists)
```

## 3. Existing Dockerfile audit

| Check | Result | Evidence |
|---|---|---|
| Base image / Node version | `node:22.21.0-trixie-slim`, matching `.nvmrc` `v22.21.0`. **PASS** | H5: `node v22.21.0`, npm 10.9.4 |
| Lockfile install | `npm ci` in `deps` and `prod-deps`. **PASS** | build log |
| Multi-stage | deps, development, test, build, prod-deps, runner. `runner` is last, so an untargeted build gives production. **PASS** | `Dockerfile` |
| Build | `npm run build` (tsc + tsc-alias + copy-generated). **PASS** | T2 build OK |
| Runtime size | **198 MB.** **PASS** | H1 |
| Prod versus dev dependencies | `npm ci --omit=dev` in prod-deps. **PASS** | H8: tsx and pino-pretty absent |
| Prisma client | Generated in build, shipped in `dist/generated/prisma`. **PASS** | H12 |
| Prisma CLI for migrations | Present and works **offline** (`--network none`), schema-engine bundled. **PASS** | H10, A2 |
| Seed / admin bootstrap | **FAIL:** no tsx in the runner, so `prisma db seed` cannot run (F03) | A14 |
| Non-root | `USER node` (uid 1000), `/app` not writable by node. **PASS** | H2, H5, H11 |
| Entrypoint / signals | `dumb-init --` then `node dist/server.js`. **PASS** with the image CMD (A17b). **FAIL** when compose overrides it with `npm run …` (F08). | A17, A17b |
| Health check | `HEALTHCHECK` on `/health` (liveness). **PASS** | H4 |
| Secrets in layers / build args | No env files in the image, no secret ARG or ENV (only `NODE_VERSION`, `YARN_VERSION`, `PATH`). **PASS** | H3, H9, H13 |
| `.dockerignore` | Excludes `.env*`, `.git`, `dist`, `src/generated`, docs, infrastructure. **PASS** | file |
| Reproducibility | Base pinned by tag, not digest. Infra images are tag-pinned. *(P3)* | — |
| Vulnerability scan | **NOT RUN** locally (no Trivy installed). CI runs Trivy weekly, non-blocking. | `security.yml` |
| Separate targets needed? | **One runner image is enough for the API, the worker and migrations** (different commands). **One extra `ops` target** is needed for the seed and admin bootstrap. The existing `build` stage already works for this (A15 PASS). | A2, A7, A15 |

## 4. Existing Compose audit

| Check | compose.dev.yml (LOCAL) | compose.test.yml | compose.prod.yml (server) |
|---|---|---|---|
| `config` validation | **PASS** (T1a) | **PASS** (T1b) | Fails loudly without its required variables, which is intended (T1c) |
| Build/target | `development` | `test` | `runner` (local build). No registry or digest reference. |
| Env handling | `environment:` + mounted `.env.development` | `environment:` + `.env.test` | Interpolation allow-list only. **The 4 boot-mandatory keys are missing (F01).** |
| depends_on | `service_healthy` / `service_completed_successfully`. **PASS** (not mere start order) | `service_healthy` | `service_healthy`. PgBouncer reports healthy before the runtime login exists (F26). |
| Health checks | postgres, redis, worker. **No API health check (F22).** | postgres, redis | API (image), worker, pgbouncer, postgres, redis |
| Ports | **5432, 6379, 3000, 3001 published on all interfaces (F13)** | none | API on `${API_PORT:-3000}` on all interfaces (F13) |
| Volumes | named `postgres_data`, `redis_data` | tmpfs (ephemeral) | named `postgres_data`, `redis_data`. **Survive `down` (P1 PASS).** |
| Resource limits / logging | none | none | **none (F14)** (config output: `limits None`, `logging None`) |
| Networks | default | default | default (no fixed subnet) |
| Restart | `unless-stopped` | none | `always` (does not act on unhealthy, F28) |
| Graceful stop | npm wrapper (dev, acceptable) | — | **npm wrapper kills the drain (F08)** |
| Security | no privileged, docker.sock, cap_add or user overrides. **PASS** | same | same |
| Duplication / conflicts | dev and prod duplicate the postgres and redis definitions, which is acceptable. **Naming conflict:** the requested `compose.dev.yml` = DEV server, but today it is the LOCAL stack (F39). | | |

## 5. Docker networking audit

| Path | Result | Evidence |
|---|---|---|
| API → PgBouncer → Postgres (`pgbouncer:6432`, runtime login) | **PASS** | A7/A8 `/ready` database ok; the restricted-role boot check passed |
| Worker → PgBouncer / Valkey | **PASS** | A11 worker `/ready`, V7 jobs processed |
| API → Redis/Valkey (`redis:6379`, password) | **PASS** | A8, V4 |
| migrate → Postgres direct (`postgres:5432`, owner) | **PASS** | A2 |
| db-roles → Postgres | **PASS** | A3 |
| seed (build-stage image) → PgBouncer | **PASS** | A15 |
| Caddy → API (`api:3000`), HTTPS, WebSocket | **PASS** (proposed design validated with `tls internal`) | C1–C5 |
| Hard-coded `localhost` in app runtime paths | None that break containers. The Swagger `servers` URL is `http://localhost:${PORT}` (`src/plugins/swagger/swagger.plugin.ts:24`, cosmetic, P3). The admin monitoring probe calls the worker on `127.0.0.1:3001` (`src/modules/admin/monitoring-management/monitoring.service.ts:92`), which is **always unreachable from the API container**, so the admin panel's worker-health tile will read down (F40). | code reading |
| Host-run LOCAL against Docker infra | `localhost` may resolve to `::1` through `wslrelay` on this Windows machine and wedge (known). Use `127.0.0.1` in `.env.local`. | prior incident notes |

## 6. Database and PostGIS audit

| Check | Result | Evidence |
|---|---|---|
| Version | PostgreSQL 17 + **PostGIS 3.5.2**. **PASS** | A4 |
| Extensions | `postgis`, `pgcrypto`, `btree_gist` (from migrations) + image defaults. **PASS** | A4 |
| Fresh init | Migrations create the extensions themselves, so no init script is needed on the server. **PASS** | A2 (76/76 in 12 s) |
| Migration idempotency | Second run: "No pending migrations". **PASS** | P3 |
| Roles | Owner for migrations. `zaroorat_app` (member of `zaroorat_app_runtime`) for the app. The app **refuses** owner or superuser in staging/production. **PASS** | A3, A7 |
| Seed (production seeder) | Works only from an image with tsx: 6 roles, 8 vehicle types, **0 users** | A14 FAIL, A15 PASS, A16 |
| Seed (development seeder) | **FAIL** on `origin/main`: it looks up vehicle type `CAB_ECONOMY`, which the catalog now replaces with `_AC` / `_NON_AC` variants. Partial, non-transactional insert. A fix exists on `origin/devops/do-cicd-hardening` (unverified). | L5a (F09) |
| Admin bootstrap | None. The dev seeder has a **default admin password in source** (`prisma/seed/development/index.ts:310`, F34). | code reading |
| Persistence | Named volume survives `down` and recreation. **PASS** | P1, P2 |
| Backup/restore | `scripts/db-backup.sh` drops privileges, so a restore loses runtime grants (F17) *(code reading)*. Restore **NOT RUN**. | — |
| Connection limits | PgBouncer `DEFAULT_POOL_SIZE 40` against Postgres `max_connections 100`. App pool `DB_POOL_MAX` 10. Fine for DEV *(not load-tested)*. | config |

## 7. Valkey and BullMQ audit

| Check | Result | Evidence |
|---|---|---|
| Client compatibility | ioredis 5.11.1 + BullMQ 6.0.7 + socket.io redis-adapter 8.3.0 against **Valkey 8.1.12**. **PASS** | V2–V7 |
| Image | `valkey/valkey:8.1-alpine` (17 MB) ships `redis-server`/`redis-cli` names, so the existing command and health check work unchanged. **PASS** | V0 |
| Auth / policy / persistence | `requirepass`, `noeviction`, `appendonly yes` all applied. **PASS** | V3 |
| Job schedulers (Lua) | 8 queues with repeat keys, "Job schedules registered", 0 errors. **PASS** | V6 |
| Job processing | rides-maintenance 3 → 6 completed, 0 failed. **PASS** | V7, V9 |
| Restart recovery | Valkey restart: API `/ready` back to 200, worker and API **0 container restarts**, jobs continue, AOF kept data. **PASS** | V8, V9 |
| Outage logging | About 66 error lines during a short outage (noisy, harmless) *(P3)* | V10 |
| **Data migration Redis 8 → Valkey** | **FAIL:** Valkey cannot load the Redis 8 AOF/RDB ("Can't handle RDB format version 15") and crash-loops. A switch needs a **fresh volume**. | V1 (F11) |
| OTP queue end-to-end (mock SMS) | `POST /otp/send` returned 200 and the worker delivered through MockSMS. **PASS** | L5b, L5c |
| Retries / stalled | OTP: attempts and exponential backoff from `otpConfig`. Notifications: 4 attempts. Maintenance: 1 attempt. Stalled-job settings are BullMQ defaults *(code reading)*. | `src/jobs/queues/index.ts` |
| Recommendation | LOCAL: Valkey after a volume reset (or keep Redis 8 locally; both work). DEV: Valkey 8.1 on a fresh volume, 256–512 MB `maxmemory`, `noeviction`, AOF. | — |

## 8. Multi-environment configuration audit

**How the environment is chosen today** *(code reading, confirmed at runtime)*:

- `APP_ENV` (zod enum `development | test | staging | production`, `src/config/env/schema.ts:4`) drives behaviour. `NODE_ENV` (`development | test | production`) is used in a few places, mostly test detection. The two are already distinct variables, but **the values `local` and `dev` do not exist**, and `APP_ENV=dev` would fail validation.
- `src/config/env/loader.ts` reads `.env.development` (APP_ENV=development) or `.env.test` (test) and **requires** them. For staging and production it reads **no file**, because variables are injected. `.env` itself is never loaded. This is deterministic.
- `prisma.config.ts:8-14` maps `production` → `.env.production`, `test` → `.env.test`, and **everything else → `.env.development`**. Under `APP_ENV=staging` (or a future `dev`), the Prisma CLI would load a `.env.development` if one exists in the working directory (F18).
- In staging/production, the guards in 14 places force real SMS, push, storage, payments, the restricted DB role, the Redis adapter, and the bank/crypto keys.

**Can the DEV server run as `APP_ENV=development`? No.**

- The logger loads `pino-pretty` in development (`src/shared/logger/transport.ts:3`), and pino-pretty is not in the runtime image (H8). A crash is expected *(inferred, not executed)*.
- The loader requires a `.env.development` file.
- Mock storage is in-memory, with URLs at `https://mock-storage.local`, so phones cannot upload.
- See F19.

**Recommended mapping (decision D1):**

| Environment | File (requested) | `APP_ENV` | `NODE_ENV` | Where the file lives | Loaded by |
|---|---|---|---|---|---|
| LOCAL | `.env.local` | `development` (kept, so 9 existing checks keep working) | `development` | Developer machine, gitignored | `loader.ts` (rename the mapping `.env.development` → `.env.local`, with a one-release fallback to the old name) |
| CI | `.env.test` (committed, dummy values) | `test` | `test` | Repo | `loader.ts` (unchanged) |
| DEV | `.env.dev` (+ `.env.dev.infra`) | **`dev` (new value)**, behaving like staging except DEV may use Spaces storage without GuardDuty | `production` | `/etc/zaroorat/dev/`, mode 600 | Compose `env_file:`. The app reads no file. |
| STAGING | `.env.staging` (+ `.infra`) | `staging` | `production` | Its own server | Compose `env_file:` |
| PRODUCTION | `.env.production` (+ `.infra`) | `production` | `production` | Its own servers | Compose `env_file:` |

The alternative to D1 is to run DEV as `APP_ENV=staging`. That needs no code change, but health checks report "staging", the AWS storage guard applies to DEV, and relaxing it for DEV would also relax real staging.

**Rules check:**

| Rule | Status |
|---|---|
| `.env*` gitignored (except `.env.example`, `.env.test`) | PASS |
| Docker-ignored | PASS |
| Required variables fail fast | PASS (A6) |
| Compose interpolation versus app config | Confused in `compose.prod.yml`: the app only sees what the compose file lists (F01). The fix splits `.env.<env>` (app, `env_file`) from `.env.<env>.infra` (compose interpolation, which includes the DB owner password the app must never receive). |
| `.env.example` | **Unsafe for LOCAL (F02).** It selects real providers. Stale names: `FCM_PROJECT_ID`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `MAP_FALLBACK_ENABLED`. Missing: `RIDE_PIN_PEPPER`, `BANK_DATA_ENCRYPTION_KEY`, `BANK_ACCOUNT_HASH_KEY` (F31). |
| No production secrets needed in development | PASS for code. `ENCRYPTION_KEY` / `RIDE_PIN_PEPPER` / `BANK_*` are optional locally (derived fallbacks, F35). |

## 9. LOCAL setup findings

| Test | Result | Evidence |
|---|---|---|
| L0 Build the `development` image | **PASS** (69 s) | — |
| L1 Fresh clone: `.env.development` = copy of `.env.example` (what `make up-dev` does) | **FAIL:** API and worker crash with `PAYMENT_WEBHOOK_SECRET is required when PAYMENT_DEFAULT_GATEWAY=razorpay`. Storage `s3` and SMS `airtel` would throw next. Containers still show "running" (tsx watch). | F02, F22 |
| Migrations (local) | **PASS** (76 applied) | L1 |
| L2 Same, with `SMS_PROVIDER/PUSH_PROVIDER/STORAGE_PROVIDER/PAYMENT_DEFAULT_GATEWAY=mock` | **PASS:** API `/health` 200, `/ready` 200, worker `/ready` 200, no errors | — |
| Development seed | **FAIL** (F09) | L5a |
| OTP send → queue → worker → MockSMS | **PASS** | L5b, L5c |
| OTP verify (local login) | **BLOCKED:** the mock SMS body is **redacted even in development** (`devSmsBody: "[Redacted]"`), so the code cannot be read. Local login today needs real Airtel SMS. | F10 |
| Hot reload (`compose watch`) | **NOT RUN** (interactive foreground mode) | — |
| `npm test` locally | **NOT RUN** (the CI Tests job is the gate. It currently times out, F07.) | — |

**Recommended LOCAL arrangement:** PostGIS and Valkey in Docker, with the **API and worker on the host** (`npm run dev`, `npm run worker:dev`). Native `tsx watch` reloads instantly and the debugger attaches directly. The fully containerised stack (`compose.local.yml` + `compose watch`) stays available for anyone who prefers it.

Trade-offs:

- Host mode needs Node 22.21.0 locally.
- Docker mode is slower to reload on Windows, but needs nothing except Docker.

## 10. DEV DigitalOcean deployment findings

| Test | Result |
|---|---|
| Server stack in production mode, unmodified `compose.prod.yml` | **FAIL** (A6, F01: crash-loop) |
| Same stack + only the 4 missing keys | **PASS:** API, worker, PgBouncer, Postgres and Redis healthy in 13 s. `/health`, `/ready`, Socket.IO handshake and worker `/ready` all OK. |
| Same stack on Valkey 8.1 (fresh volume) | **PASS** (V2–V9) |
| Graceful shutdown via `npm run start` / `npm run worker` | **FAIL:** API killed after 1 s (exit 143) mid-drain. Worker killed before closing queues and DB (exit 143). |
| Graceful shutdown with `node dist/*.js` directly | **PASS:** API 10 s drain → gateway, Fastify, outbox, Redis closed, exit 0. Worker exit 0. |
| Caddy in front: HTTPS, `/metrics` and `/docs` blocked, Socket.IO polling, WebSocket 101 | **PASS** (C1–C5, `tls internal`) |
| Client-IP trust | Caddy ignores a spoofed `X-Forwarded-For` (records the real peer): **PASS.** App-side `request.ip`: **NOT RUN**, because request logs contain no IP (F37). |
| `/metrics`, `/docs` on the bare API port | **FAIL (security):** both return 200 (A10). Fixed by Caddy (C3). |
| DEV on DigitalOcean (GHCR pull, real certificate, real OTP, storage, rollback) | **NOT RUN:** no server exists, which is correct for this phase |

## 11. GitHub Actions and CI/CD audit

Carried from the companion EXISTING_CICD_AUDIT.md; the workflow files have not changed since.

| Workflow | Finding | Severity |
|---|---|---|
| `ci.yml` | Tests job **cancelled at 15 min on every `main` run**, so no gate. Build & container (including the boot smoke test) is green. No `workflow_call`, so a deploy cannot reuse it. | P0 for DEV CD |
| `staging.yml` | Builds to GHCR (`sha-<full>`, digest output: reusable). Deploys with **kubectl/Helm** to a cluster that does not exist. Triggers on `main`. Skipped while `vars.DEPLOY_STAGING` is unset. | P0 (no DEV path) |
| `production.yml` | **Rebuilds** instead of promoting. Kubernetes. Liveness-only smoke test. | P2 (future) |
| `release.yml` | `npm test` with no DB or Redis, so it always fails and production never triggers | P2 |
| `prisma-check.yml` | Only on `main` PRs | P2 |
| `security.yml` | `aquasecurity/trivy-action@master` unpinned. Gitleaks output not redacted in a **public** repo. | P1 |
| Permissions | Mostly `contents: read`. `packages: write` set at workflow level in staging and production (narrow it to the build job). | P2 |
| SSH / deploy credentials | None exist. New design: forced-command key in GitHub Environment `dev`, pinned `known_hosts`, `GITHUB_TOKEN` passed through stdin for the GHCR pull. **No DigitalOcean token or root credential in GitHub.** | — |
| Concurrency | Present on all workflows | PASS |
| Branch protection / required checks | Ruleset `main` targets no branch and requires a non-existent check `setup`. `develop` is unprotected. | P1 |
| Colleague branch `devops/do-cicd-hardening` | Moves to **DOKS + DOCR** (contrary to the no-Kubernetes decision). It also carries the CI timeout fix, gitleaks redaction, the **dev-seed catalog fix**, and `post-deploy-check.sh`. | P1 (reconcile) |

**DEV flow (approved shape):** a feature branch opens a PR into `develop` (CI). Merging to `develop` starts `deploy-dev.yml`: CI via `workflow_call`, then build once (`sha-<full commit>`, plus `-ops`), push to GHCR, SSH forced-command `deploy <sha> <digest>`, migrate under lock, `up --wait`, then the smoke test. **Feature branches never deploy.**

## 12. Application configuration blockers

| Item | Status | File |
|---|---|---|
| HTTP CORS | Hard-coded to `https://zaroorat.com`, `https://admin.zaroorat.com` outside development. Blocks an admin panel on a DEV domain. | `src/plugins/cors/cors.plugin.ts:7-10` (F15) |
| Socket.IO CORS | `REALTIME_CORS_ORIGINS`. Unset in staging means **any origin**. | `src/config/realtime/realtime.config.ts:19-29` |
| Trusted proxy | Declared through `TRUSTED_PROXIES`. Must be set to Caddy's fixed IP (validated at Caddy, C6). | `src/app/trust-proxy.ts` |
| JWT | HMAC, at least 32 characters, separate per environment | `src/config/env/schema.ts` |
| Rate limiting | Redis-backed. Bypass only honoured in development. | `src/core/cache/stores/RateLimitStore.ts:13-15` |
| Health / readiness | API and worker both PASS. The admin panel's worker probe hits `127.0.0.1` (F40). | — |
| Outbox and consumers | Start in every API process (13 consumers on `main`). The relay stops cleanly on shutdown (A17b). | `src/bootstrap/events.bootstrap.ts` |
| Logging | JSON in non-development. The level is fixed (`info`). One message mentions `LOG_LEVEL`, which no code reads (F33). | `src/shared/logger/*` |
| File storage / S3 / KMS | Staging/production force S3 + GuardDuty + `aws:kms` + a KMS key. No code reads the scan results. | `src/modules/files/config/storage.config.ts` (F06) |
| SMS | Real Airtel in staging/production. No test-number mechanism. The mock is unusable for login (F10). | `src/modules/notifications/notification.config.ts` |
| Payments | Razorpay required outside dev/test, with `PAYMENT_WEBHOOK_SECRET`. Use test-mode keys on DEV. | `src/config/payment/payment.config.ts` |
| Google Maps | Server key from environment or admin settings. A fallback router calls **public OSRM demo servers** (`router.project-osrm.org`, `routing.openstreetmap.de`) with trip coordinates (F30). | `src/modules/location/providers/google-maps.provider.ts:313-314` |
| FCM | Single-line service-account JSON in the env file works (verified with a throwaway key). Boot does not contact Google. | A7 |
| PostGIS | PASS | A4 |
| API and worker start independently | **PASS:** separate containers with separate health checks. The worker needs only the database and Redis. | A7, A11 |

## 13. Security issues

| ID | Issue | Severity |
|---|---|---|
| F12 | `/metrics` and `/docs` public on the API port (verified). Caddy blocks them (verified). | P1 |
| F13 | `compose.prod.yml` publishes the API on all interfaces. `compose.dev.yml` publishes Postgres and Redis with fixed dev passwords on all interfaces (reachable on the LAN). Docker-published ports bypass UFW. | P1 (server) / P2 (local) |
| F16 | Public repo with no effective branch protection | P1 |
| F24 | Unpinned `trivy-action@master`. Unredacted gitleaks logs. | P1 |
| F34 | Default admin password fallback in the dev seeder source. Must never run on a shared server. | P2 |
| F30 | Trip coordinates may be sent to public OSRM demo servers (privacy, and those services' usage policies) | P2 |
| F17 | Backups lose grants, so a restore breaks the runtime-role model | P1 |
| F36 | `edoburu/pgbouncer` is a community image. Pin it by digest. | P3 |
| F35 | Dev/test-only fallback key literal in `src/shared/crypto/bank-account-crypto.ts:34` (guarded: throws in staging/production) | P3 |
| — | No privileged containers, no docker.sock mounts, no `cap_add`. Image is non-root with no baked secrets. | PASS |

## 14. Missing files

`compose.local.yml` (rename), `compose.server.yml` (rename), DEV overlay `compose.dev.yml`, `compose.staging.yml`, `compose.production.yml`, `deploy/caddy/Caddyfile`, `deploy/env/*.example`, `deploy/bin/{ssh-entry,deploy,backup,restore-test,status}.sh`, `deploy/systemd/*`, `.github/workflows/deploy-dev.yml`, `scripts/release/post-deploy-check.sh`, `scripts/create-admin.ts` (if approved), `docs/DEPLOYMENT/{LOCAL_SETUP,DEV_SERVER_RUNBOOK}.md`.

## 15. Existing files that can be reused

- `Dockerfile`: unchanged apart from adding an `ops` target.
- `compose.prod.yml`: becomes `compose.server.yml`. Keep its two-role DB design, the `migrate` and `db-roles` one-shots, PgBouncer, and the `noeviction` and AOF settings.
- `compose.test.yml`: as is.
- `compose.dev.yml`: becomes `compose.local.yml`.
- `scripts/db/create-app-login.sql`.
- The image boot smoke test in `ci.yml`.
- `scripts/release/verify-otp-job-browser.js`.
- The GHCR, metadata and digest steps from `staging.yml`.
- `post-deploy-check.sh` and the seed fix from the colleague's branch.
- The `Makefile` structure.

## 16. Exact file-by-file fixes

| # | File | Change | Finding | Phase |
|---|---|---|---|---|
| 1 | `.env.example` | Rewrite for LOCAL: `APP_ENV=development`, mock SMS, push, storage and payment, `127.0.0.1` URLs, a one-line description per variable, safe placeholders. Remove stale names. Server variables move to `deploy/env/*`. | F02, F31 | A |
| 2 | `src/config/env/loader.ts` | `development` → `.env.local` (fall back to `.env.development` for one release, logging a deprecation line) | D1 | A |
| 3 | `prisma.config.ts` | Same mapping. Load **no** file outside development and test, so the CLI uses injected variables only. | F18 | A |
| 4 | `compose.dev.yml` → `compose.local.yml` (git mv) | Mount `.env.local`. Bind ports to `127.0.0.1`. Add an API health check. Optional Valkey image (documented volume reset). | F13, F22, F11, F39 | A |
| 5 | `Makefile` | `*-local` targets. `stop-local` keeps data. `reset-local` explicitly deletes volumes after a confirmation prompt (`down-dev -v` today deletes the DB). `migrate-local`, `seed-local`. | F21 | A |
| 6 | `prisma/seed/development/index.ts`, `prisma/seed/shared/vehicle-types.ts` | Take the catalog fix from `devops/do-cicd-hardening` after review. Wrap the dev seed in a transaction or make it idempotent per entity. | F09 | A |
| 7 | `src/modules/notifications/providers/mock.provider.ts` (+ redact paths) | **Decision D3.** Either log the OTP body unredacted **only when `APP_ENV=development` and `SMS_PROVIDER=mock`**, or add a dev-only fixed-code allow-list. Never in deployed environments. | F10 | A |
| 8 | `Dockerfile` | Add `FROM build AS ops` before `prod-deps` / `runner` | F03 | A/B |
| 9 | `compose.prod.yml` → `compose.server.yml` (git mv) | `env_file: ${APP_ENV_FILE}` for api and worker. Separate infra interpolation file. `image: ${APP_IMAGE}` (GHCR digest). `APP_ENV: ${APP_ENV}`. Node commands (`node dist/server.js` / `node dist/worker.js`). `logging` rotation. `deploy.resources.limits`. Named network with a fixed subnet. Valkey 8.1. API not published (or `127.0.0.1` only). `seed` one-shot (profile, ops image). | F01, F08, F13, F14, F11 | B |
| 10 | `compose.dev.yml` (new: DEV overlay) | Caddy service (80/443), `APP_ENV=dev`, `TRUSTED_PROXIES=<caddy ip>`, `ports: !reset []` on api, resource limits for the chosen Droplet | — | B |
| 11 | `deploy/caddy/Caddyfile` | TLS, `reverse_proxy api:3000`, 404 for `/metrics` and `/docs`, JSON log (validated C1–C5) | F12 | B |
| 12 | `deploy/env/dev.env.example`, `dev.infra.env.example` (+ staging, production) | Names only, with descriptions | — | B/C |
| 13 | `deploy/bin/*.sh`, `deploy/systemd/*` | Forced-command entry, deploy (checkout, pull digest, verify revision label, backup if migrations pending, migrate under `flock`, db-roles, `up --wait`, record, revert app on failure), backup **with privileges** + roles, restore-test, status (queue depths, Valkey memory, DB connections) | F17, F26, F28 | B |
| 14 | `src/config/env/schema.ts` + the 14 environment guards | **Decision D1:** add `dev` through one helper (`isDeployedEnvironment`) used by all guards, so DEV behaves like staging. The storage guard allows `STORAGE_MALWARE_SCANNER=disabled` + `AES256` when `APP_ENV=dev` only. Unit tests per guard. | F18, F06 | B |
| 15 | `src/plugins/cors/cors.plugin.ts` | Allowed origins from configuration (reuse `REALTIME_CORS_ORIGINS`, or a new `CORS_ORIGINS` after approval) | F15 | B |
| 16 | `scripts/create-admin.ts` | Idempotent first admin. Email and password from environment only. Refuses if an admin exists. No defaults in source. | F04 | B |
| 17 | `.github/workflows/ci.yml` | `timeout-minutes: 40` + `test:ci` (per-test timeout), `workflow_call`, PRs into `release/**`, Valkey service | F07 | B |
| 18 | `.github/workflows/deploy-dev.yml` (new) | §20 | F05 | B |
| 19 | `.github/workflows/security.yml` | `--redact`; pin trivy-action by SHA | F24 | B |
| 20 | `.github/CODEOWNERS` | Real owners; `prisma/migrations/**` to a DB owner | — | B |
| 21 | `src/modules/admin/monitoring-management/monitoring.service.ts` | Worker probe host from configuration (`WORKER_HEALTH_URL`, new, approval needed) | F40 | B (optional) |
| 22 | `staging.yml`, `production.yml`, `release.yml`, `prisma-check.yml`, `compose.staging.yml`, `compose.production.yml` | Rewrite for SSH + Compose with digest promotion. Kill-switched. | F23 | C |
| 23 | `infrastructure/helm/**`, Kubernetes docs | Keep. Mark superseded. Remove only after approval. | — | C |

## 17. Recommended final folder structure

```
zaroorat-back/
├── Dockerfile                    # + ops target
├── .env.example                  # LOCAL template (safe mocks)
├── compose.local.yml             # LOCAL (was compose.dev.yml)
├── compose.test.yml              # CI / make test-docker (unchanged)
├── compose.server.yml            # single-host base (was compose.prod.yml), environment-neutral
├── compose.dev.yml               # DEV server overlay (Caddy, APP_ENV=dev)
├── compose.staging.yml           # prepared
├── compose.production.yml        # prepared (app-only, external managed DB and Valkey)
├── deploy/
│   ├── caddy/Caddyfile
│   ├── env/{dev,staging,production}.env.example + *.infra.env.example
│   ├── bin/{ssh-entry,deploy,backup,restore-test,status}.sh
│   └── systemd/zaroorat-{backup,restore-test}.{service,timer}
├── scripts/release/post-deploy-check.sh
├── scripts/create-admin.ts       # if approved
├── .github/workflows/{ci,security,prisma-check,deploy-dev,release,production}.yml
├── docs/DEPLOYMENT/{FULL_MULTI_ENV_DOCKER_AUDIT,LOCAL_SETUP,DEV_SERVER_RUNBOOK}.md
└── infrastructure/helm/          # retained until removal is approved
```

On the DEV server: `/opt/zaroorat/src` (read-only clone of the public repo, checked out at the deployed commit), and `/etc/zaroorat/dev/.env.dev` + `.env.dev.infra` (mode 600, owner `deploy`).

## 18. Exact local development commands

**Today, without any change.** This is a verified workaround: L2 PASS. The seed still fails and login needs real SMS.

```bash
npm ci
cp .env.example .env.development
# edit .env.development: SMS_PROVIDER=mock  PUSH_PROVIDER=mock  STORAGE_PROVIDER=mock  PAYMENT_DEFAULT_GATEWAY=mock
make up-dev            # builds and starts migrate, api, worker, postgres, redis
make logs-dev          # API logs
make stop-dev          # stop and KEEP data   (never `make down-dev` unless you want the DB deleted)
```

**After Phase A (target):**

```bash
git clone https://github.com/zaroorat-mobility/zaroorat-back.git && cd zaroorat-back
nvm use                                    # Node 22.21.0 from .nvmrc
npm ci
cp .env.example .env.local                 # safe mocks by default; uses 127.0.0.1, not localhost
docker compose -f compose.local.yml up -d --wait postgres valkey
npx cross-env APP_ENV=development prisma migrate deploy
npx cross-env APP_ENV=development prisma db seed
npm run dev                                # terminal 1: API on :3000 (hot reload)
npm run worker:dev                         # terminal 2: worker (OTP and notifications)
curl -s http://127.0.0.1:3000/ready
npx cross-env APP_ENV=test tsx --test --test-force-exit "tests/unit/**/*.test.ts"   # unit tests
make test-docker                           # full suite in an isolated PostGIS + Valkey stack
docker compose -f compose.local.yml stop   # stop, keep data
docker compose -f compose.local.yml up -d --build   # rebuild (Docker mode)
make reset-local                           # explicit, confirmed DB wipe
```

## 19. DEV server setup instructions (owner runs these; nothing was created)

The full beginner walkthrough is in the companion DIGITALOCEAN_DEPLOYMENT_PLAN.md §8; substitute `dev` for `staging`. Condensed:

1. Create a DO project `zaroorat-dev`, region **BLR1**, and a VPC `zaroorat-dev-blr1`.
2. On your PC, run `ssh-keygen -t ed25519 -f ~/.ssh/zaroorat_dev_admin` and upload the **.pub** key only.
3. Create the Droplet:
   - Ubuntu 24.04 LTS, Basic Regular **2 vCPU / 4 GiB ($24)** or 4 / 8 ($48) (D7);
   - enable monitoring and weekly backups;
   - tag `dev`;
   - assign a reserved IP.
4. Create a Cloud Firewall on tag `dev`: inbound 22 (key-only), 80 and 443 only. Never 5432, 6379, 6432, 3000 or 3001.
5. Create users `ops` (sudo) and `deploy` (no password). In sshd, set `PermitRootLogin no` and `PasswordAuthentication no`. Install `unattended-upgrades` and `fail2ban`.
6. Install Docker Engine and the Compose plugin from Docker's apt repository. In `/etc/docker/daemon.json`, set log rotation `max-size 20m`, `max-file 5`, and `live-restore`. Add `deploy` to the `docker` group (root-equivalent; the forced command limits the CI key).
7. In Cloudflare, add an **A record `dev-api` → the reserved IP, DNS only**.
8. `git clone https://github.com/zaroorat-mobility/zaroorat-back.git /opt/zaroorat/src` (as `deploy`).
9. Create `/etc/zaroorat/dev/.env.dev` and `.env.dev.infra` from the templates:
   - generate each secret with `openssl rand -hex 32`;
   - type them into the file, **never paste them into chat**;
   - `chmod 600`, owner `deploy`.
10. Install `deploy/bin/ssh-entry.sh` as root-owned `/usr/local/bin/zaroorat-ssh-entry`.
11. Create a CI key pair. Put its `.pub` into `~deploy/.ssh/authorized_keys` with the `command=…,no-pty,no-port-forwarding,…` prefix. Put the private key in GitHub Environment `dev` secret `SSH_PRIVATE_KEY`, and the `ssh-keyscan` output (checked against the console) in `SSH_KNOWN_HOSTS`.
12. Set GitHub `dev` environment variables `DEPLOY_HOST` and `API_URL=https://dev-api.zaroorat.com`, and limit the environment's deployment branches to `develop`.
13. First deploy: run `deploy-dev.yml` (manual). Then, one time only, seed through the ops image and create the first admin (after D4).
14. Install the systemd timers for backup and restore-test. Create DO alert policies for CPU, memory and disk, and an uptime check on `/ready`.

## 20. DEV deployment and rollback design

- **Trigger:** push to `develop` (after a reviewed PR) or a manual dispatch. `concurrency: deploy-dev`.
- **Jobs:**
  1. `ci` (reused `ci.yml` via `workflow_call`).
  2. `build`: `packages: write`. Tags `ghcr.io/zaroorat-mobility/zaroorat-back:sha-<full>` and `…-ops`. OCI revision label. Outputs the digest.
  3. `deploy`: environment `dev`, `packages: read`. Plain OpenSSH with the pinned host key, then `deploy <sha> <digest>` with `GITHUB_TOKEN` passed through stdin.
  4. `post-deploy-check.sh` (`/health`, `/ready`, Socket.IO handshake).
- **Never `latest`.** The digest is the deployment identifier, and the tag is for humans.
- **Server `deploy.sh`** (`flock`):
  1. `git checkout --detach <sha>`.
  2. Pull by digest, verify that `org.opencontainers.image.revision` equals `<sha>`, and log out of GHCR.
  3. `prisma migrate status`; if migrations are pending, back up first.
  4. `migrate`, then `db-roles`, then `up -d --wait api worker caddy`.
  5. On failure, bring the previous digest back up and exit non-zero.
  6. Record `current` and `previous`; prune images older than 7 days.
- **Rollback:** `ssh deploy@<host> rollback` (previous digest and previous commit), or re-run the workflow on an earlier `develop` commit.
- **Database migrations are never rolled back automatically.**
  - Migrations are expand-only, so the previous image runs on the new schema.
  - If a migration fails: read `_prisma_migrations.logs`, fix it, run `prisma migrate resolve --rolled-back|--applied <name>` from the ops image, then redeploy.
  - If data is damaged: stop api and worker, restore the pre-migration backup, run `db-roles`, and start the previous digest.

## 21. Testing checklist

### 21.1 Executed in this audit

| ID | Test | Result |
|---|---|---|
| T1a/b | `compose.dev.yml` / `compose.test.yml` config | PASS / PASS |
| T1c | `compose.prod.yml` refuses to render without required variables | PASS |
| T2 | Runtime image build (origin/main) | PASS (198 MB) |
| H1–H13 | Image: non-root, dumb-init, no env files, Prisma CLI offline, entrypoints present, no secret layers | PASS (tsx and pino-pretty absent, by design) |
| A1 | Postgres, PgBouncer, Redis healthy | PASS |
| A2 | `npx prisma migrate deploy` in runtime image | PASS (76/76, 12 s) |
| A3 | Runtime login creation (`db-roles`) | PASS |
| A4 | PostGIS extension | PASS (3.5.2) |
| A6 | API/worker on unmodified `compose.prod.yml` | **FAIL** (missing 4 keys) |
| A7–A11 | API/worker boot, `/health`, `/ready`, Socket.IO, worker health | PASS (with 4 keys added) |
| A10 | `/metrics`, `/docs` not public | **FAIL** (200 on API port) |
| A14 | Seed in runtime image | **FAIL** (no tsx) |
| A15 | Seed via build-stage (ops) image | PASS |
| A17/A18 | Graceful shutdown via npm | **FAIL** (exit 143, drain cut) |
| A17b/A18b | Graceful shutdown via node | PASS (10 s drain, exit 0) |
| V1 | Valkey on existing Redis 8 volume | **FAIL** (RDB v15 unreadable) |
| V2–V9 | Valkey 8.1: auth, noeviction, AOF, app ready, Socket.IO, schedulers, job processing, restart recovery | PASS |
| P1–P3 | Persistence across `down`/`up`; idempotent migrate | PASS |
| C1–C5 | Caddy HTTPS, path blocking, Socket.IO polling, WebSocket 101 | PASS |
| C6 | Client IP through proxy | PASS at Caddy; app side NOT RUN |
| L0 | Development image build | PASS |
| L1 | Fresh-clone local boot | **FAIL** (real-provider defaults) |
| L2 | Local boot with mock selectors | PASS |
| L5a | Development seed | **FAIL** (catalog mismatch) |
| L5b/c | OTP send → BullMQ → worker → MockSMS | PASS |
| L5e | Local OTP login | **BLOCKED** (code redacted) |
| — | Hot reload, `npm test`, image CVE scan, backup restore | NOT RUN |

### 21.2 DEV deployment tests (all NOT RUN until the server exists)

1. GHCR pull by digest, including the revision-label check.
2. A real Let's Encrypt certificate.
3. `/health`, `/ready` and worker health.
4. DB and Valkey connectivity (`status.sh`).
5. Migrations on deploy, with a second deploy being a no-op.
6. OTP login with real Airtel credentials, or the approved DEV mechanism (D3).
7. Socket.IO from the dev app builds.
8. File upload and download through presigned URLs (Spaces or S3, D2).
9. Queue processing (OTP, notifications, crons).
10. Restart: Droplet reboot, `docker compose restart`, Valkey restart.
11. A rollback drill (deploy a bad digest → automatic revert, then a manual `rollback`).
12. Backup, then a restore-test PASS.

The functional checklist (rides, PIN, fares, wallet, webhooks, FCM, PostGIS zones, rate limits, authorisation) is in the companion DIGITALOCEAN_DEPLOYMENT_PLAN.md §9. Every item there starts at NOT VERIFIED.

## 22. Findings register

L = blocks LOCAL, D = blocks DEV, S/P = affects future staging/production.

| ID | Sev | File | Problem | Why it matters | Correction | L | D | S/P |
|---|---|---|---|---|---|---|---|---|
| F01 | P0 | `compose.prod.yml:30-117` | Allow-list omits `ENCRYPTION_KEY`, `RIDE_PIN_PEPPER`, `BANK_DATA_ENCRYPTION_KEY`, `BANK_ACCOUNT_HASH_KEY` (and many optional variables) | API and worker crash-loop (A6) | `env_file` app file + infra interpolation file | – | ✔ | ✔ |
| F02 | P0 | `.env.example`, `Makefile` (`env-dev`) | Template selects airtel, s3 and razorpay, and `make up-dev` copies it | A fresh clone cannot boot (L1) | Local-safe `.env.example` with mocks | ✔ | – | – |
| F03 | P0 | `Dockerfile`, `package.json` (`prisma.seed` uses tsx) | No tsx in the runtime image | A fresh deployed DB has no roles, so every login fails (A14/A16) | `ops` target (A15 proves it) | – | ✔ | ✔ |
| F04 | P0 | `prisma/seed/production/index.ts` | No first-admin path outside dev | No one can use the admin panel on DEV | `scripts/create-admin.ts` (D4) | – | ✔ | ✔ |
| F05 | P0 | `.github/workflows/staging.yml`, `production.yml` | Kubernetes-only; no DEV workflow | No automated DEV deploy | `deploy-dev.yml` | – | ✔ | ✔ |
| F06 | P0 | `src/modules/files/config/storage.config.ts:37-115` | Staging and production force S3 + GuardDuty + KMS | DEV run as staging needs AWS | D1/D2 (`dev` + Spaces) | – | ✔ | ✔ |
| F07 | P0 | `.github/workflows/ci.yml:58` | Tests job times out | No CI gate before deploying | Timeout 40 + per-test timeout | – | ✔ | ✔ |
| F08 | P1 | `compose.prod.yml:173,192` | `npm run start` / `npm run worker` | SIGTERM kills mid-drain (A17 exit 143) | `node dist/*.js` (A17b PASS) | – | ✔ | ✔ |
| F09 | P1 | `prisma/seed/development/index.ts:192` | Looks up the removed `CAB_ECONOMY` | No local demo data (L5a) | Take the colleague's catalog fix | ✔ | – | – |
| F10 | P1 | `src/modules/notifications/providers/mock.provider.ts:15-19` + logger redact | OTP body redacted even in development | Local login needs real SMS (L5e) | D3 | ✔ | – | – |
| F11 | P1 | compose Redis → Valkey | Valkey cannot read Redis 8 RDB v15 | Switching breaks existing volumes (V1) | Fresh volume; documented reset | ✔* | – | ✔ |
| F12 | P1 | `src/routes/health/metrics.route.ts`, `src/plugins/swagger/swagger.plugin.ts:78` | `/metrics`, `/docs` public | Internal data exposure | Caddy 404 (C3) | – | ✔ | ✔ |
| F13 | P1/P2 | `compose.prod.yml:178`, `compose.dev.yml` ports | Published on 0.0.0.0 | Bypasses UFW; LAN exposure locally | Unpublished on servers; `127.0.0.1` locally | – | ✔ | ✔ |
| F14 | P1 | `compose.prod.yml` | No log rotation or limits | Disk fill; noisy neighbours | `logging` + `deploy.resources` | – | ✔ | ✔ |
| F15 | P1 | `src/plugins/cors/cors.plugin.ts:7-10` | CORS hard-coded | Admin panel blocked on DEV | Configurable origins | – | ✔ | ✔ |
| F16 | P1 | GitHub settings | No effective protection on a public repo | Unreviewed pushes deploy | Fix rulesets (owner) | – | ✔ | ✔ |
| F17 | P1 | `scripts/db-backup.sh:43-49` | `--no-privileges` | Restore breaks the runtime role | Server backup with privileges + roles | – | ✔ | ✔ |
| F18 | P1 | `src/config/env/schema.ts:4`, `loader.ts`, `prisma.config.ts:8-14` | No `dev`/`local` values; Prisma loads `.env.development` for any other environment | Requested model not expressible; footgun | D1 + mapping fix | ✔ | ✔ | ✔ |
| F19 | P1 | `src/shared/logger/transport.ts:3` | `development` needs pino-pretty (absent in the runner) | DEV cannot run as development | Use `dev` (D1) | – | ✔ | – |
| F20 | P1 | `origin/devops/do-cicd-hardening` | DOKS direction + needed fixes | Duplicate, conflicting work | Reconcile (D6) | ✔ | ✔ | ✔ |
| F21 | P2 | `Makefile` `down-dev` | `down -v` deletes the DB | Accidental data loss | `stop-local` / confirmed `reset-local` | ✔ | – | – |
| F22 | P2 | `compose.dev.yml` api | No health check; crashed app shows "running" | Misleading (L1) | Add a health check | ✔ | – | – |
| F23 | P2 | `release.yml`, `production.yml` | Cannot pass; rebuilds | No promotion path | Phase C rewrite | – | – | ✔ |
| F24 | P1 | `.github/workflows/security.yml:49,120` | Unpinned trivy; unredacted gitleaks | Supply chain; secret echo | Pin; `--redact` | – | ✔ | ✔ |
| F26 | P3 | `compose.prod.yml` PgBouncer health check | Healthy before the runtime login exists | API restarts until `db-roles` | Deploy script orders the steps | – | – | – |
| F27 | P3 | — | Noisy logs during a Valkey outage (V10) | Log volume | Accept | – | – | – |
| F28 | P2 | compose `restart: always` | Does not act on unhealthy | A hung worker stops OTP | `status.sh` + uptime alert | – | – | ✔ |
| F29 | P2 | `src/config/payment/payment.config.ts:131-145` | `PAYMENT_LEDGER_CUTOVER_AT` defaults to process start | Moves on every restart | Set explicitly (confirm meaning) | – | – | ✔ |
| F30 | P2 | `src/modules/location/providers/google-maps.provider.ts:313-314` | Public OSRM demo routers in the fallback | Privacy and policy | Disable in deployed environments, or use our own router | – | – | ✔ |
| F31 | P2 | `.env.example` | Stale and missing names | Confusion | Rewrite (#1) | ✔ | – | – |
| F32 | P3 | Fastify `maxParamLength` | Deprecation FSTDEP022 (A12b) | Future major upgrade | Move to `routerOptions` | – | – | – |
| F33 | P3 | DB slow-query log text | Mentions `LOG_LEVEL`, which no code reads | Misleading | Fix the text, or add the variable | – | – | – |
| F34 | P2 | `prisma/seed/development/index.ts:309-310` | Default admin email and password fallback in source | Default credential | Require environment values; dev only | – | – | – |
| F35 | P3 | `src/shared/crypto/bank-account-crypto.ts:29-34` | Dev/test fallback literal (guarded) | — | Accept | – | – | – |
| F36 | P3 | `compose.prod.yml` PgBouncer image | Community image | Supply chain | Pin digest | – | – | ✔ |
| F37 | P3 | request-log hooks | No client IP in request logs | Cannot audit proxy trust | Add the IP field | – | – | ✔ |
| F39 | P2 | `compose.dev.yml` name | LOCAL file named "dev"; DEV overlay requested under the same name | Confusion | Rename to `compose.local.yml` first (D5) | ✔ | ✔ | – |
| F40 | P2 | `src/modules/admin/monitoring-management/monitoring.service.ts:92` | Probes the worker at `127.0.0.1` from the API container | Admin health tile always "down" in Docker | Configurable worker URL | – | – | ✔ |

\* F11 blocks LOCAL only if the local stack is switched to Valkey without resetting the Redis volume.

## 23. Risks and unresolved decisions

| ID | Decision | Recommendation |
|---|---|---|
| D1 | `APP_ENV` for DEV | Add `dev` (staging-equivalent guards, Spaces allowed). The alternative is to run DEV as `staging` with no code change. |
| D2 | DEV file storage | DO Spaces BLR1 ($5/mo) with the scanner disabled (needs D1 = `dev`). Otherwise AWS S3 + KMS + GuardDuty. |
| D3 | OTP on LOCAL and DEV | LOCAL: show the mock OTP in development logs only. DEV: real Airtel SMS initially. |
| D4 | First-admin script | Approve `scripts/create-admin.ts` |
| D5 | Compose renames | `compose.dev.yml` → `compose.local.yml`, `compose.prod.yml` → `compose.server.yml`, new DEV overlay `compose.dev.yml` |
| D6 | Colleague's branch | Cherry-pick the CI, seed and check-script fixes; drop DOKS/DOCR (agree with the author) |
| D7 | DEV Droplet size | 2 vCPU / 4 GiB ($24) for a handful of testers. 4 / 8 ($48) if load tests run on DEV. *(Memory per service not measured; estimates in the companion plan §1.1.)* |
| D8 | GHCR visibility | Private; pulled with the job's `GITHUB_TOKEN` |
| D9 | DEV domain | `dev-api.zaroorat.com`, Cloudflare DNS-only |
| D10 | Where to implement | The main folder holds others' uncommitted pricing WIP. Either the owner of that WIP commits it first, or approve a temporary separate checkout. |
| D11 | Branch protection | 1 approval; required checks = real job names; `develop` and `main` protected |
| D12 | Valkey locally | Optional; requires each developer to reset the local Redis volume |
| D13 | Production database (Managed PG Standard change, 30 Nov 2026, from the 2026-11-15 audit, not re-verified) | Decide before 30 Nov; not needed for DEV |

**Costs (DigitalOcean list prices read 2026-11-19, USD/month, before tax).**

Confirmed:

- Droplet Basic 2/4: $24. Basic 4/8: $48.
- Weekly backups: 20% of the Droplet.
- Spaces: $5.
- Transfer overage: $0.01/GiB.
- **DEV total:** $33.80 (2/4) or $62.60 (4/8). About ₹3.5k / ₹6.5k including GST, assuming ₹88/USD and 18% GST.

Unresolved: Airtel per-SMS pricing, Google Maps usage, AWS (only if D2 = AWS), and the GHCR/Actions costs (expected $0 for a public repo; not re-verified). STAGING and PRODUCTION are separate future costs (companion plan §2 and §11).

---

## 24. Final execution plan

### Phase A — LOCAL
**Objective:** Make `.env.local`, local Docker setup, database, and worker work reliably with zero friction.

1. **Local Configuration Template (`.env.example`):**
   - Provide safe development defaults: `APP_ENV=development`, `NODE_ENV=development`.
   - Set mock providers: `SMS_PROVIDER=mock`, `PUSH_PROVIDER=mock`, `STORAGE_PROVIDER=mock`, `PAYMENT_DEFAULT_GATEWAY=mock`.
   - Use `127.0.0.1` instead of `localhost` to avoid Windows/WSL2 IPv6 (`::1`) loopback wedges.
   - Clean up stale variable names and add safe placeholders for required keys.
2. **Deterministic Environment Loading:**
   - Commit and verify the update to `src/config/env/loader.ts` to map `development` -> `.env.local` (with a temporary 1-release fallback to legacy `.env.development`).
   - Keep `prisma.config.ts` in sync so `npx prisma` CLI loads `.env.local` for development and never falls back to development credentials in staging/production.
3. **Local Docker Compose (`compose.local.yml`):**
   - Rename/move `compose.dev.yml` to `compose.local.yml`.
   - Bind ports exclusively to `127.0.0.1` (`127.0.0.1:5432:5432`, `127.0.0.1:6379:6379`, `127.0.0.1:3000:3000`, `127.0.0.1:3001:3001`).
   - Add explicit API container healthcheck.
   - Support running datastores in Docker with API/worker on host, or full-container stack with `compose watch`.
4. **Development Seeder & Catalog Fix:**
   - Update `prisma/seed/development/index.ts` to use active vehicle type `CAB_ECONOMY_NON_AC` instead of deleted `CAB_ECONOMY`.
   - Remove hardcoded admin password in source; use `ADMIN_SEED_PASSWORD` from `.env.local`.
5. **Local OTP Verification Visibility:**
   - Enable OTP code visibility in development logs only when `APP_ENV=development` and `SMS_PROVIDER=mock` so developers can log into local apps without real Airtel SMS credits.
6. **Local Developer Workflow & Safety:**
   - Update `Makefile` targets to `*-local` (`up-local`, `stop-local`, `logs-local`, `migrate-local`).
   - Remove automatic `-v` volume deletion from stop commands. Provide an explicit `reset-local` with confirmation.

### Phase B — DEV (DigitalOcean Deployment)
**Objective:** Prepare dedicated DEV Docker Compose stack, DigitalOcean server setup, Caddy reverse proxy, and automated GitHub Actions deployment.

1. **DigitalOcean DEV Droplet Setup:**
   - 1x Droplet: Ubuntu 24.04 LTS, Basic Regular (2 vCPU / 4 GiB, $24/mo or 4 vCPU / 8 GiB, $48/mo), BLR1 (Bangalore) region.
   - Docker Engine + Docker Compose plugin installed.
   - Configure Docker daemon log rotation (`max-size 20m`, `max-file 5`).
   - Cloud Firewall: Inbound only ports 22 (SSH, key-only), 80 (HTTP), 443 (HTTPS). Internal ports (5432, 6379, 6432, 3000, 3001) are NEVER publicly exposed.
   - DNS: Point `dev-api.zaroorat.com` -> Droplet Reserved IP (Cloudflare DNS-only / grey-clouded).
2. **DEV Architecture & Reverse Proxy:**
   - Deploy Caddy container handling automated Let's Encrypt SSL/TLS.
   - Reverse proxy `dev-api.zaroorat.com` -> `api:3000` (Fastify HTTP + Socket.IO WebSockets).
   - Block public access to internal endpoints (`/metrics`, `/docs`) at Caddy level.
   - Set fixed internal subnet and configure `TRUSTED_PROXIES` so client IPs are accurately preserved.
3. **Application Multi-Environment Support (`APP_ENV=dev`):**
   - Add `dev` to `APP_ENV` enum in `src/config/env/schema.ts`.
   - Treat `dev` as a deployed environment (enforcing restricted DB role, real JWT keys, pino JSON logging) but permit `STORAGE_MALWARE_SCANNER=disabled` with S3-compatible DigitalOcean Spaces ($5/mo).
   - Make CORS allowed origins configurable via `CORS_ALLOWED_ORIGINS` to support dev admin panel.
4. **Ops Target & Initial Admin Script:**
   - Add `FROM build AS ops` target to `Dockerfile` so administrative and seed scripts can run with `tsx` inside the container image.
   - Add idempotent `scripts/create-admin.ts` using environment variables (`ADMIN_EMAIL`, `ADMIN_PASSWORD`) with no fallback defaults.
5. **Automated CI/CD Workflow (`deploy-dev.yml`):**
   - Trigger: Push/merge to `develop` branch or manual dispatch.
   - Run CI checks (lint, types, tests with extended 40-minute timeout).
   - Build container image tagged with commit SHA (`ghcr.io/zaroorat-mobility/zaroorat-back:sha-<commit>`), push to GHCR.
   - SSH to DEV Droplet using restricted `deploy` user with forced command (`zaroorat-ssh-entry`).
   - Safe locked migration (`flock` + `npx prisma migrate deploy` via owner login).
   - Provision/verify runtime DB login (`scripts/db/create-app-login.sql`).
   - Deploy new containers (`docker compose up -d --wait api worker caddy`).
   - Run post-deploy smoke tests (`/health`, `/ready`, Socket.IO handshake). Revert to previous image on failure.

### Phase C — FUTURE STAGING/PRODUCTION (Prepared Only, Not Deployed)
**Objective:** Architecture and configuration design prepared for isolated STAGING and PRODUCTION environments.

1. **Dedicated Compose Configurations:**
   - `compose.staging.yml`: Mirrors production topology, isolated staging database, staging Firebase project, Razorpay sandbox keys.
   - `compose.production.yml`: Production topology, external managed PostgreSQL/PostGIS, managed Valkey/Redis, AWS S3 + KMS + GuardDuty, Razorpay live keys, Airtel production DLT templates.
2. **Promotion Workflow (No Rebuilds):**
   - Rewrite `release.yml` and `production.yml` to promote immutable image digests from GHCR rather than rebuilding from source tags.
   - Enforce mandatory manual approvals via GitHub Environment protection rules.
3. **Audit & Backup Resilience:**
   - Ensure database backup scripts preserve user privileges and role assignments (`--no-privileges` removed for administrative backups).
   - Retire legacy Kubernetes/Helm manifests cleanly only after explicit sign-off.

