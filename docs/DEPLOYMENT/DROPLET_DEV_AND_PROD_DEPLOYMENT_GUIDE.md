# DigitalOcean Droplet Deployment Guide: DEV & PROD Environments

This document provides the definitive, production-grade deployment and operations guide for running the **Zaroorat Mobility Backend** on DigitalOcean Droplets using Docker Compose, Caddy (automated Let's Encrypt SSL), PostGIS 17, PgBouncer, and Valkey 8.1.

---

## 1. Architecture Overview

```mermaid
flowchart TD
    subgraph Internet["Public Traffic"]
        Client["Admin Panel / Mobile Apps / Webhook Callers"]
    end

    subgraph Droplet["DigitalOcean Droplet (/opt/zaroorat)"]
        subgraph Edge["Reverse Proxy & SSL"]
            Caddy["Caddy 2 (Ports 80 & 443)\nAutomated Let's Encrypt SSL\nDomain: dev-api.zaroorat.com / api.zaroorat.com"]
        end

        subgraph Containers["Application Services (Bridge Network: 172.28.0.0/24)"]
            API["Fastify API (Port 3000)\nLeast-Privilege Runtime User\nNode.js 22 LTS"]
            Worker["BullMQ Worker (Port 3001)\nBackground Queues & Scheduled Crons"]
        end

        subgraph DataTier["Data & Cache Tier"]
            PgBouncer["PgBouncer 1.23 (Port 6432)\nTransaction Pooling (Max 1000 conns)\nRole: zaroorat_app (DML Only)"]
            PostgreSQL["PostgreSQL 17 + PostGIS 3.5 (Port 5432)\nVolume: postgres_data\nRole: zaroorat (DDL Owner)"]
            Valkey["Valkey 8.1 / Redis (Port 6379)\nVolume: valkey_data\nPassword Protected + AOF Enabled"]
        end

        subgraph OpsProfile["Ops & Migration Lifecycle (Profile: ops)"]
            Migrator["migrate container\nPrisma Migrate Deploy"]
            RoleInit["db-roles container\npsql grant least-privilege DML"]
            OpsExec["ops container\nPrisma db seed / Admin registration script"]
        end
    end

    Client -->|HTTPS / WSS| Caddy
    Caddy -->|Reverse Proxy / HTTP 3000| API
    API -->|DML Queries| PgBouncer
    Worker -->|DML Queries| PgBouncer
    PgBouncer -->|Pooled Connections| PostgreSQL
    API -->|Pub/Sub & Sessions| Valkey
    Worker -->|Queue State| Valkey

    Migrator -.->|Direct DDL Migrations| PostgreSQL
    RoleInit -.->|DML Role Granting| PostgreSQL
    OpsExec -.->|Reference Seeding & Admin Creation| PostgreSQL
```

---

## 2. Environment Configuration Synchronized (.env.dev)

All active cloud and third-party integration settings from `.env.development` have been verified and synchronized into `.env.dev`.

### Validated Integrations:
1. **Object Storage (AWS S3)**:
   - `STORAGE_PROVIDER=s3`
   - `STORAGE_REGION=ap-south-1`
   - `STORAGE_BUCKET=zaroorat-bucket-india-2026-918897410838-ap-south-1-an`
   - `STORAGE_QUARANTINE_BUCKET=zaroorat-quarantine-918897410838-ap-south-1-an`
   - `STORAGE_ACCESS_KEY_ID=AKIA5L4UNYMLFHI6D3OA`
2. **SMS & DLT Gateway (Airtel)**:
   - `SMS_PROVIDER=airtel`
   - `AIRTEL_CUSTOMER_ID=1c9335a2-5a62-4936-8f4c-cf865494cc17`
   - `AIRTEL_USERNAME=8b4ec1d1_fbd3_47d7_84aa_a32fe2d2b709`
   - `AIRTEL_SENDER_ID=ZARPTL`
   - `AIRTEL_ENTITY_ID=1001107627347978995`
   - `AIRTEL_OTP_TEMPLATE_ID=1077033120052032357`
   - `AIRTEL_CUSTOMER_OTP_TEMPLATE_ID=1077033120052032357`
   - `AIRTEL_DRIVER_OTP_TEMPLATE_ID=1077444430041455112`
   - `AIRTEL_DRIVER_ACTIVATED_TEMPLATE_ID=1077274830024341486`
   - `AIRTEL_DRIVER_DOC_REJECTED_TEMPLATE_ID=1077480170024471191`
3. **Push Notifications (Firebase Cloud Messaging)**:
   - `PUSH_PROVIDER=fcm`
   - `FIREBASE_SERVICE_ACCOUNT_JSON` loaded with production-valid Firebase credentials.
4. **Geolocation & Navigation (Google Maps)**:
   - `MAP_PROVIDER=google`
   - `GOOGLE_MAPS_API_KEY=AIzaSyBvjVsFGePiqPxWbpBcZQEyB1_yjmzfUDo`
   - `ALLOW_OFFLINE_ROUTING=true`
5. **Payment Gateway (Razorpay Sandbox)**:
   - `PAYMENT_DEFAULT_GATEWAY=razorpay`
   - `RAZORPAY_ENVIRONMENT=sandbox`
   - `RAZORPAY_KEY_ID=rzp_test_TlH5EJtx0bxALy`

> [!NOTE]
> `.env.dev` has been schema-tested against `EnvironmentSchema` in `src/config/env/schema.ts` and passed with **0 validation errors across all 253 variables**.

---

## 3. Strict Anti-Hardcoding & Admin Provisioning Policy

> [!IMPORTANT]
> **No admin email, password, or register keys are hardcoded in `.env.dev` or `.env.prod`.**
> 
> Admin provisioning is handled exclusively through an out-of-band CLI execution script: `scripts/create-admin.ts`.

### Why this architecture is strictly enforced:
- **No Stale or Compromised Credentials in Git**: Static env files can be read by local developers, CI agents, or file system leaks. Passwords should never live in static configuration files on disk.
- **Cryptographic Password Salting**: Passwords are run through Node's native `scrypt` hashing with a random salt before writing to the `users` table.
- **Role Isolation**: The script assigns the user directly to `system_admin` in `user_roles` with verified email and phone flags set to `true`.

---

## 4. DEV Droplet Deployment Walkthrough

### Step 1: Droplet Provisioning & OS Setup
- **Recommended Droplet**: DigitalOcean Basic (Regular with SSD) or General Purpose:
  - **RAM**: Minimum 4 GB (8 GB recommended for build & concurrent queue spikes)
  - **CPUs**: 2 vCPUs
  - **OS**: Ubuntu 24.04 LTS (x86_64 / amd64)
  - **Datacenter Region**: `BLR1` (Bengaluru, India) for lowest latency to Indian riders & drivers

### Step 2: Configure DNS Records
In your DNS provider (Cloudflare, DigitalOcean DNS, GoDaddy, etc.):
- Create an **A Record**:
  - **Type**: `A`
  - **Name**: `dev-api`
  - **Value**: `<YOUR_DROPLET_PUBLIC_IP>`
  - **TTL**: Auto / 300s
  - *(Optional)* If using Cloudflare proxy, set to **DNS Only** initially so Caddy can perform ACME HTTP-01 challenge verification.

### Step 3: Server Preparation & Firewall
SSH into the droplet as `root`:
```bash
ssh root@<DROPLET_IP>

# 1. Update OS and install prerequisites
apt update && apt upgrade -y
apt install -y curl git ufw fail2ban jq

# 2. Add 4GB Swap Space (prevents out-of-memory during heavy ops)
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 3. Configure UFW Firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# 4. Install Docker Engine & Compose Plugin
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
usermod -aG docker root

# 5. Create deployment directory
mkdir -p /opt/zaroorat/src
cd /opt/zaroorat/src
```

### Step 4: Clone Code & Place `.env.dev`
```bash
# Clone the repository
git clone https://github.com/<your-org>/zaroorat-backend.git /opt/zaroorat/src
cd /opt/zaroorat/src
git checkout develop

# Copy your sanitized .env.dev onto the server
# (e.g. using scp from local machine or pasting via nano)
nano .env.dev

# Enforce secure permissions (owner read/write only)
chmod 600 .env.dev
```

### Step 5: Execute Database Migrations
Run the isolated migration container to apply all 87 Prisma DDL migrations using the schema owner (`zaroorat`):
```bash
docker compose --env-file .env.dev -f compose.dev.yml run --rm migrate
```
*Expected output: `87 migrations applied successfully. Database is now in sync with schema.`*

### Step 6: Grant Runtime Application Privileges
Run the `db-roles` service to initialize `zaroorat_app` with least-privilege DML (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) grants:
```bash
docker compose --env-file .env.dev -f compose.dev.yml run --rm db-roles
```

### Step 7: Seed Platform Reference Data
Run the database seed via the `ops` container. In `APP_ENV=dev`, this strictly executes `seedProduction(prisma)`, seeding:
- Roles & RBAC matrices
- Vehicle types & requirements
- 36 Indian states & union territories with LGD census codes
- Base app configuration
*(Zero mock rides, zero fake riders, zero demo drivers)*:
```bash
docker compose --env-file .env.dev -f compose.dev.yml run --rm ops npx prisma db seed
```

### Step 8: Provision the Super-Admin Out-of-Band
Run the admin registration script by passing credentials as execution environment arguments:
```bash
ADMIN_EMAIL="admin@zaroorat.com" \
ADMIN_PASSWORD="YourStrongDevAdminSecret123!" \
ADMIN_PHONE="+919999999999" \
ADMIN_FIRST_NAME="System" \
ADMIN_LAST_NAME="Admin" \
docker compose --env-file .env.dev -f compose.dev.yml run --rm ops npx tsx scripts/create-admin.ts
```
*Expected output: `Admin user successfully configured: admin@zaroorat.com`*

### Step 9: Launch Application Stack
Start Fastify API, BullMQ Worker, and Caddy reverse proxy in detached mode:
```bash
docker compose --env-file .env.dev -f compose.dev.yml up -d api worker caddy
```

### Step 10: Verify Deployment Health
```bash
# Check container status
docker compose --env-file .env.dev -f compose.dev.yml ps

# Check API health endpoint locally on the droplet
curl -i http://127.0.0.1:3000/health

# Check public SSL endpoint via Caddy
curl -i https://dev-api.zaroorat.com/health

# Tail live application logs
docker compose --env-file .env.dev -f compose.dev.yml logs -f api worker
```

---

## 5. Automated Deployment via GitHub Actions (CI/CD)

The repo includes `deploy/bin/deploy.sh` for immutable zero-downtime CD:

```bash
# Triggered via SSH deploy key:
ssh deploy@<DROPLET_IP> "deploy <git-commit-sha> <image-digest>"
```

### Execution Flow:
1. Acquires deployment file lock (`/tmp/zaroorat-deploy.lock`).
2. Pulls immutable image digest from GHCR (`ghcr.io/zaroorat-mobility/zaroorat-backend@sha256:...`).
3. Runs `compose.dev.yml run --rm migrate`.
4. Runs `compose.dev.yml run --rm db-roles`.
5. Starts new containers with `--wait` ensuring healthcheck passes before completing.
6. Automatic rollback to previous working digest if healthcheck fails.

---

## 6. PRODUCTION Deployment Plan

```mermaid
sequenceDiagram
    autonumber
    actor DevOps as Release Lead
    participant CI as GitHub Actions
    participant GHCR as GitHub Container Registry
    participant ProdDroplet as Production Server
    participant PostGIS as PostgreSQL 17
    participant Caddy as Caddy (api.zaroorat.com)

    DevOps->>CI: Tag Release (v1.0.0 / commit SHA)
    CI->>GHCR: Build & Push prod image (sha-<commit>)
    CI->>GHCR: Build & Push ops image (sha-<commit>-ops)
    CI->>ProdDroplet: SSH Trigger deploy.sh sha-<commit> <digest>
    ProdDroplet->>GHCR: Pull images by immutable digest
    ProdDroplet->>PostGIS: Run migrations (DDL owner)
    ProdDroplet->>PostGIS: Verify db roles (DML grants)
    ProdDroplet->>PostGIS: Seed reference data (zero mock data)
    ProdDroplet->>Caddy: Rolling restart API & Worker
    Caddy->>ProdDroplet: Health probe /ready
    ProdDroplet-->>CI: 200 OK - Deployment Finalized
```

### Key Differences Between DEV and PROD:

| Feature | DEV Environment | PRODUCTION Environment |
| :--- | :--- | :--- |
| **Compose File** | `compose.dev.yml` | `compose.prod.yml` |
| **Domain** | `dev-api.zaroorat.com` | `api.zaroorat.com` |
| **Allowed CORS** | `https://dev-admin.zaroorat.com` | `https://admin.zaroorat.com` |
| **Docker Images** | Can build locally or pull `dev` tag | **Must** pull immutable tags: `${IMAGE_TAG:?}` required (no `latest`, no in-place builds) |
| **Data Seeding** | Runs `seedProduction` (Reference only) | Runs `seedProduction` (Reference only) |
| **Worker Shutdown** | 30s grace period | **150s grace period** (completes active financial payouts & notifications) |
| **PostgreSQL RAM** | 2048 MB | 4096 MB |
| **PgBouncer Conns** | 1000 max clients / 40 pool | 2000 max clients / 80 pool |
| **Admin Accounts** | Provisioned via CLI script | Provisioned via CLI script with multi-factor authentication (MFA) |

### Production Pre-Flight Checklist:
1. **Secrets Isolation**: Verify `.env.prod` has high-entropy, 32+ character secrets generated with `openssl rand -base64 32` for `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `BANK_DATA_ENCRYPTION_KEY`, and `RIDE_PIN_PEPPER`.
2. **Database Snapshot**: Create an automated DigitalOcean volume snapshot or manual `pg_dump` before applying new schema migrations:
   ```bash
   docker exec zaroorat-prod-postgres-1 pg_dump -U zaroorat zaroorat_prod | gzip > /opt/backups/zaroorat_prod_$(date +%Y%m%d_%H%M%S).sql.gz
   ```
3. **Rollback Readiness**:
   If an issue occurs in production, roll back to the previous tag immediately:
   ```bash
   /opt/zaroorat/src/deploy/bin/rollback.sh
   ```
