# Complete Database Migration & Security Guide — Zaroorat Mobility

This guide explains the architecture, security model, and execution procedures for PostgreSQL/PostGIS database migrations across **LOCAL**, **DEV**, **STAGING**, and **PRODUCTION** environments.

---

## 1. Migration Architecture Overview

Zaroorat Mobility uses **Prisma ORM** with a multi-file schema (`prisma/schema/*.prisma`) configured via `prisma.config.ts`.

### Strict Command Discipline

| Command | Allowed Environments | Purpose | Why Never in Production / Dev |
|---|---|---|---|
| `npx prisma migrate dev` | **LOCAL only** | Creates new migration files from schema diffs and applies them to local DB. | Prompts interactively and can reset databases with data loss. |
| `npx prisma db push` | **Prohibited** (except throwaway prototypes) | Pushes schema directly without migration files. | Bypasses migration history; destroys production schema tracking. |
| `npx prisma migrate deploy` | **All (LOCAL, DEV, STAGING, PROD)** | Applies all pending committed migrations in order. | **Safe, non-interactive, and deterministic.** |
| `npx prisma migrate status` | **All** | Checks if the database schema is up-to-date with migrations. | Read-only verification check. |

---

## 2. Dual-Role Database Security Model

The system enforces a strict separation of database privileges:

```
               ┌────────────────────────────────────────────────────────┐
               │              PostgreSQL / PostGIS Database             │
               └───────────────────────────┬────────────────────────────┘
                                           │
                    ┌──────────────────────┴──────────────────────┐
                    │                                             │
         [Schema Owner: zaroorat]               [Runtime Login: zaroorat_app]
                    │                                             │
     • DDL (CREATE, ALTER, DROP)                  • DML (SELECT, INSERT, UPDATE, DELETE)
     • Manages extensions & triggers              • Member of `zaroorat_app_runtime`
     • Used ONLY during migration                 • NO schema modification rights
                    │                             • NO audit trigger bypass rights
                    ▼                                             │
      `npx prisma migrate deploy`                                 ▼
       via MIGRATION_DATABASE_URL                   API & Background Worker
                                                    via PgBouncer :6432 (DATABASE_URL)
```

### Why This Separation Exists
1. **Audit Trail Integrity:** The runtime application cannot drop tables, alter schema, or disable audit triggers even if an application SQL injection vulnerability occurs.
2. **Boot Protection:** On startup in non-development environments (`APP_ENV=dev`, `staging`, `production`), the application runs `assertRestrictedDatabaseRole()`. If `DATABASE_URL` connects as superuser or schema owner, **the app strictly refuses to boot**.
3. **Connection Pooling:** The app connects through **PgBouncer** (port `6432`) in transaction pooling mode. Migrations bypass PgBouncer and connect directly to PostgreSQL (port `5432`) as the schema owner.

---

## 3. Migration Execution per Environment

### A. LOCAL Environment
When developing features or testing locally:

```bash
# 1. Start local Postgres and Valkey
docker compose -f compose.local.yml up -d --wait postgres valkey

# 2. Apply existing migrations
npx cross-env APP_ENV=local prisma migrate deploy
# Or via Makefile:
make migrate-local

# 3. Create a new migration after editing prisma/schema/*.prisma
npx cross-env APP_ENV=local prisma migrate dev --name describe_your_change

# 4. Seed development data (test drivers, rides, pricing rules)
npx cross-env APP_ENV=local prisma db seed
# Or via Makefile:
make seed-local
```

### B. DEV Server (DigitalOcean Droplet)
Migrations are run **automatically by the CI/CD pipeline** before application containers restart:

```bash
# Executed by deploy.sh on the server under flock lock:
APP_IMAGE="ghcr.io/zaroorat-mobility/zaroorat-backend@<digest>" \
  docker compose -f compose.dev.yml run --rm migrate

# Grants runtime role permissions to newly created tables:
APP_IMAGE="ghcr.io/zaroorat-mobility/zaroorat-backend@<digest>" \
  docker compose -f compose.dev.yml run --rm db-roles
```

### C. Manual Execution on DEV Server (If Needed)
If you need to manually apply migrations on the DEV server via SSH:

```bash
cd /opt/zaroorat/src

# 1. Check migration status
docker compose -f compose.dev.yml run --rm ops npx prisma migrate status

# 2. Deploy pending migrations
docker compose -f compose.dev.yml run --rm migrate

# 3. Re-assert runtime login permissions
docker compose -f compose.dev.yml run --rm db-roles
```

---

## 4. Seeding & Initial Admin Provisioning

### Reference Seed vs Development Seed

| Seeder | Target Environments | What it Seeds |
|---|---|---|
| `seedProduction` | **DEV, STAGING, PROD** | Canonical RBAC roles (`system_admin`, `admin`, `support`, `finance`, `customer`, `driver`), vehicle types catalog, geographic reference (India 28 states + 8 UTs), app configs. **Zero users, zero dummy data.** |
| `seedDevelopment` | **LOCAL only** | All reference data plus test users, mock rides, simulated wallets, driver KYC fixtures. |

### How to Provision the First Admin on DEV / STAGING / PROD
Because `seedProduction` creates no users, run the bootstrap script once, after the seed. It refuses if a `system_admin` already exists (`--additional` overrides that on purpose), and if the email or phone belongs to any existing account.

```bash
# On the server. The password is typed, never echoed and never on a command line.
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD        # 12+ characters
export ADMIN_EMAIL='<admin email>' ADMIN_PHONE='<+91 number the owner controls>'
export ADMIN_FIRST_NAME='Platform' ADMIN_LAST_NAME='Admin'
make admin-dev        # or: docker compose --env-file .env.dev -f compose.dev.yml run --rm \
                      #       -e ADMIN_EMAIL -e ADMIN_PHONE -e ADMIN_PASSWORD \
                      #       -e ADMIN_FIRST_NAME -e ADMIN_LAST_NAME ops npx tsx scripts/create-admin.ts
unset ADMIN_PASSWORD
```

`ADMIN_PHONE` must belong to the platform owner: staff can log in with an OTP sent to it.

---

## 5. Migration Failure & Rollback Procedures

### Important Principle: Forward-Only Migrations
**Never roll back a database migration automatically when rolling back an application image.**

Application deployments follow the **Expand and Contract Pattern**:
1. **Expand (Database):** Add new columns as `NULLABLE` or with defaults; add new tables. Old application code continues to function seamlessly with the new schema.
2. **Deploy (Application):** Roll out the new application container image.
3. **Contract (Cleanup):** In a later release, remove deprecated columns or tables once old code is no longer running anywhere.

### What to Do If a Migration Fails on DEV / Production

If a migration fails during deployment (e.g. syntax error or lock timeout):
1. **Check status:**
   ```bash
   docker compose -f compose.dev.yml run --rm ops npx prisma migrate status
   ```
   Prisma records failed migrations in the `_prisma_migrations` table with `finished_at = NULL`.

2. **Inspect the error logs:**
   ```sql
   SELECT migration_name, started_at, finished_at, rolled_back_at, logs 
   FROM _prisma_migrations 
   ORDER BY started_at DESC LIMIT 5;
   ```

3. **Resolve the state:**
   - **Case 1 (Changes were reverted or failed completely):**
     Mark the migration as rolled back:
     ```bash
     docker compose -f compose.dev.yml run --rm ops \
       npx prisma migrate resolve --rolled-back "20261120_migration_name"
     ```
     Fix the SQL in the migration file, push to git, and redeploy.
   - **Case 2 (Changes were completed manually by DBA):**
     Mark the migration as applied:
     ```bash
     docker compose -f compose.dev.yml run --rm ops \
       npx prisma migrate resolve --applied "20261120_migration_name"
     ```

---

## 6. Database Backup & Restore with Roles

### Backup
Backups must preserve roles and table privileges:

```bash
# Dump custom archive format (-Fc)
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  -h 127.0.0.1 -p 5432 -U zaroorat -d zaroorat_dev \
  --format=custom \
  --compress=9 \
  --file=/var/backups/zaroorat-$(date +%Y%m%d%H%M%S).dump
```

### Restore
When restoring to a fresh database:

```bash
# 1. Create runtime role group first
psql -h 127.0.0.1 -U zaroorat -d zaroorat_dev -c "CREATE ROLE zaroorat_app_runtime;"

# 2. Restore schema and data
pg_restore -h 127.0.0.1 -U zaroorat -d zaroorat_dev --clean --if-exists /path/to/dumpfile.dump

# 3. Refresh app login and grant permissions
APP_DB_PASSWORD="<app_password>" psql -h 127.0.0.1 -U zaroorat -d zaroorat_dev \
  -v app_user=zaroorat_app -f scripts/db/create-app-login.sql
```
