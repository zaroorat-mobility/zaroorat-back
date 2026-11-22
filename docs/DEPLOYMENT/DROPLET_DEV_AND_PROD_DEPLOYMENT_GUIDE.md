# DigitalOcean DEV Droplet — Setup and Operations

Operator guide for the **DEV** environment: one DigitalOcean Droplet running `compose.dev.yml`
(Caddy → API + worker → PgBouncer → PostgreSQL 17/PostGIS 3.5, Valkey 8.1), deployed by
`.github/workflows/deploy-dev.yml`.

STAGING and PRODUCTION are **not** covered: `compose.staging.yml` / `compose.prod.yml` exist, but
`staging.yml` / `production.yml` still target Helm/Kubernetes and must not be used for Droplets.

> **No credential belongs in this file, or in any tracked file.** Values live only in
> `/opt/zaroorat/env/dev.env` on the server, in GitHub environment secrets and in the team's
> password manager.

---

## 1. How a deploy works

```
push to develop
  └─ deploy-dev.yml
       ├─ ci.yml        format, lint, types, tests, image boot smoke (incl. the DEV env template)
       ├─ security.yml  gitleaks, npm audit (high blocks), CodeQL, Trivy
       ├─ build         prod + ops images → GHCR sha-<commit>[-ops]; both digests exported
       └─ deploy        ssh deploy@<droplet>  "deploy <commit> <app digest> <ops digest>"
                          └─ forced command /usr/local/sbin/zaroorat-ssh-entry   (strict regex)
                               └─ sudo -n /usr/local/sbin/zaroorat-deploy deploy …  (root)
                                    ├─ commit must be on origin/develop
                                    ├─ pull both images by digest; revision label == commit
                                    ├─ checkout commit → migrate → db-roles
                                    ├─ up -d --no-build --wait --wait-timeout 180 api worker caddy
                                    ├─ /ready inside api and worker
                                    └─ failure → previous release restored (digests + checkout)
       └─ public check: https://dev-api.zaroorat.com/ready, /health reports "dev"
```

- Images are **never built on the server**.
- The deploy user is not in the `docker` group, has no shell, and can run exactly one program as root.
- Migrations are **forward-only**: a rollback swaps images and checkout, never the schema. Write
  migrations that the previous image can still run against (expand → deploy → contract).
- Whoever can merge to `develop` controls what runs on this host (the compose file and Caddyfile
  come from the repository). Protect `develop` (§3).

## 2. Server layout

| Path                                 | Owner / mode | Content                                                                |
| ------------------------------------ | ------------ | ---------------------------------------------------------------------- |
| `/opt/zaroorat/src`                  | root         | git checkout of `zaroorat-back`, detached at the deployed commit       |
| `/opt/zaroorat/env/dev.env`          | root, `0600` | the single DEV env file (Compose interpolation **and** app `env_file`) |
| `/opt/zaroorat/state/`               | root, `0700` | `current.env`, `previous.env`: image digests + commit of each release  |
| `/opt/zaroorat/backups/`             | root, `0700` | nightly `pg_dump -Fc`                                                  |
| `/usr/local/sbin/zaroorat-ssh-entry` | root, `0755` | installed copy of `deploy/bin/ssh-entry.sh`                            |
| `/usr/local/sbin/zaroorat-deploy`    | root, `0755` | installed copy of `deploy/bin/deploy.sh`                               |

The two wrappers are **copies**: a change to `deploy/bin/*` takes effect only after an admin reviews it
and re-runs the `install` lines in §4.4.

## 3. GitHub (owner, in the UI)

1. **Settings → Environments → `dev`**
   - Deployment branches and tags: **Selected branches → `develop`**.
   - Variables: `DEPLOY_HOST` = the Droplet's Reserved IP; `API_URL` = `https://dev-api.zaroorat.com`.
   - Secrets:
     - `SSH_PRIVATE_KEY`: private half of the deploy key (§4.2).
     - `SSH_KNOWN_HOSTS`: output of `ssh-keyscan -t ed25519 <reserved-ip>`. Compare its
       fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, read in the Droplet console.
2. **Settings → Branches / Rulesets:** protect `develop`. Require a pull request, require the checks
   _Lint, format & types_, _Tests_, _Build & container_ and _Secret scan_, and block force-pushes.
3. **GHCR stays private.** On a dedicated machine/bot account, create a **classic** personal access
   token with only `read:packages`, for the Droplet (§4.4).

## 4. One-time Droplet bootstrap

Droplet:

- Ubuntu 24.04 LTS (x86_64), region **BLR1**, **4 vCPU / 8 GiB**.
- Enable Monitoring and weekly Backups at creation.
- Assign a **Reserved IP**.
- Attach a **Cloud Firewall**:
  - Inbound TCP 22, 80 and 443 from anywhere.
  - Outbound all.

Port 22 stays open for DEV because GitHub-hosted runners have no fixed IP. It is protected by
key-only auth, forced commands, fail2ban and pinned host keys. Move CI to a Tailscale tunnel and
close 22 before STAGING.

Run everything below as root (Droplet console or your admin key).

### 4.1 Base system, Docker, log rotation

```bash
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl git ufw fail2ban unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Bounded container logs for every container (Docker's default json-file log is unbounded).
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }
EOF
systemctl restart docker
```

### 4.2 Accounts

```bash
# Human admin: your personal key, sudo with a password.
adduser --gecos "" opsadmin && usermod -aG sudo opsadmin
install -d -m 700 -o opsadmin -g opsadmin /home/opsadmin/.ssh
install -m 600 -o opsadmin -g opsadmin /root/.ssh/authorized_keys /home/opsadmin/.ssh/authorized_keys

# Deploy account: NOT in the docker group. bash is needed so sshd can run the forced command.
adduser --disabled-password --gecos "" --shell /bin/bash deploy
# Generate the key pair OFF the server:  ssh-keygen -t ed25519 -N "" -C gha-dev-deploy -f gha-dev-deploy
# Store gha-dev-deploy (private) as the GitHub secret SSH_PRIVATE_KEY, then delete the local copy.
# authorized_keys is root-owned, so the deploy account cannot edit its own restriction.
install -d -m 755 -o root -g root /home/deploy/.ssh
printf 'restrict,command="/usr/local/sbin/zaroorat-ssh-entry" %s\n' "$(cat gha-dev-deploy.pub)" \
  > /home/deploy/.ssh/authorized_keys
chown root:root /home/deploy/.ssh/authorized_keys && chmod 644 /home/deploy/.ssh/authorized_keys

echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/zaroorat-deploy' > /etc/sudoers.d/zaroorat-deploy
chmod 440 /etc/sudoers.d/zaroorat-deploy && visudo -cf /etc/sudoers.d/zaroorat-deploy
```

### 4.3 SSH, fail2ban, UFW

```bash
cat > /etc/ssh/sshd_config.d/10-zaroorat.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers opsadmin deploy
EOF
sshd -t && systemctl restart ssh   # keep this session open until an opsadmin login works

printf '[sshd]\nenabled = true\nbackend = systemd\n' > /etc/fail2ban/jail.d/sshd.local
systemctl enable --now fail2ban

ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

Docker-published ports bypass UFW. `compose.dev.yml` publishes only 80 and 443, so never add
`ports:` to postgres, valkey or pgbouncer. The DigitalOcean Cloud Firewall is the primary control.

### 4.4 Checkout, wrappers, env file, registry login

```bash
install -d -m 755 /opt/zaroorat
install -d -m 700 /opt/zaroorat/env /opt/zaroorat/state /opt/zaroorat/backups
git clone https://github.com/zaroorat-mobility/zaroorat-back.git /opt/zaroorat/src
git -C /opt/zaroorat/src checkout --detach origin/develop

# (Re-)install the reviewed wrappers. Repeat after every reviewed change to deploy/bin/.
install -o root -g root -m 0755 /opt/zaroorat/src/deploy/bin/ssh-entry.sh /usr/local/sbin/zaroorat-ssh-entry
install -o root -g root -m 0755 /opt/zaroorat/src/deploy/bin/deploy.sh    /usr/local/sbin/zaroorat-deploy

# The env file: start from the template and replace every REPLACE_WITH_* value.
install -m 600 /opt/zaroorat/src/deploy/env/.env.dev.example /opt/zaroorat/env/dev.env
editor /opt/zaroorat/env/dev.env
grep -c REPLACE_WITH_ /opt/zaroorat/env/dev.env   # must print 0
```

Filling `dev.env`:

- Passwords (`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `REDIS_PASSWORD`): use `openssl rand -hex 24`.
  Hex needs no URL-encoding, and the same values are repeated inside `DATABASE_URL`,
  `MIGRATION_DATABASE_URL` and `REDIS_URL`, which must match exactly.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `RIDE_PIN_PEPPER`, `BANK_DATA_ENCRYPTION_KEY`,
  `BANK_ACCOUNT_HASH_KEY`, `OTP_PEPPER`: use `openssl rand -base64 48`. Use a different value for each,
  and never reuse staging or production values.
- Providers: DEV runs with real providers, because deployed environments refuse mocks:
  - Airtel IQ SMS with DEV credentials;
  - the DEV S3 bucket in `ap-south-1`;
  - a **separate DEV Firebase project** (single-line service-account JSON);
  - Razorpay **test mode** only, with a test webhook pointed at
    `https://dev-api.zaroorat.com/webhooks/razorpay` and its secret in `PAYMENT_WEBHOOK_SECRET`.
  - No production payment credentials, ever.
- Never paste these values into chat, CI logs, issues or tracked files.

```bash
# GHCR read-only login for root (deploys run as root through sudo).
docker login ghcr.io -u <bot-account> --password-stdin   # paste the read:packages token, then Ctrl-D
```

### 4.5 Backups

```bash
cat > /etc/cron.d/zaroorat-backup <<'EOF'
15 2 * * * root docker exec zaroorat-dev-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > /opt/zaroorat/backups/zaroorat_dev-$(date -u +\%F).dump && find /opt/zaroorat/backups -name '*.dump' -mtime +7 -delete
EOF
```

The dump runs as the schema owner and keeps privileges, so a restore keeps the runtime role's grants.
Restore one dump into a scratch database once a month to prove backups work (§7).

### 4.6 DNS

Create **A `dev-api.zaroorat.com` → Reserved IP**, set to **DNS only** (no proxy), TTL 300. With a
proxy in front, every client appears as the proxy's IP to the API's per-IP rate limits. Caddy obtains
and renews the Let's Encrypt certificate itself. Its contact email is not configured yet and is
pending an address from the owner.

## 5. First deploy

After §3 and §4, push to `develop` (or run **Deploy DEV (DigitalOcean)** on `develop` from the Actions
tab). The first run creates the database, applies all migrations, creates the `zaroorat_app` runtime
login and starts the stack. Then, once only:

```bash
sudo -i
dc() { APP_ENV_FILE=/opt/zaroorat/env/dev.env docker compose --project-directory /opt/zaroorat/src \
  -f /opt/zaroorat/src/compose.dev.yml --env-file /opt/zaroorat/env/dev.env \
  --env-file /opt/zaroorat/state/current.env "$@"; }

dc run --rm ops npx prisma db seed          # reference data only (APP_ENV=dev → seedProduction)

read -rp 'Admin email: ' ADMIN_EMAIL; read -rp 'Admin phone (+91…): ' ADMIN_PHONE
read -rsp 'Admin password: ' ADMIN_PASSWORD; echo
export ADMIN_EMAIL ADMIN_PHONE ADMIN_PASSWORD ADMIN_FIRST_NAME=System ADMIN_LAST_NAME=Admin
dc run --rm -e ADMIN_EMAIL -e ADMIN_PHONE -e ADMIN_PASSWORD -e ADMIN_FIRST_NAME -e ADMIN_LAST_NAME \
  ops npx tsx scripts/create-admin.ts
unset ADMIN_PASSWORD
```

## 6. Day-to-day operations

| Task                           | Command (on the Droplet, as opsadmin)                                            |
| ------------------------------ | -------------------------------------------------------------------------------- |
| What is deployed, is it ready? | `sudo /usr/local/sbin/zaroorat-deploy status`                                    |
| Roll back one release          | `sudo /usr/local/sbin/zaroorat-deploy rollback`                                  |
| Logs                           | `sudo docker logs --tail 200 -f zaroorat-dev-api-1` (or `-worker-1`, `-caddy-1`) |
| Redeploy the current `develop` | re-run _Deploy DEV (DigitalOcean)_ in GitHub Actions                             |

- `rollback` restores the previous release's digests **and** its checkout, then checks `/ready`. It goes
  back one step only. A second `rollback` reports `no previous release recorded`.
- The GitHub key can run exactly `deploy <40-hex commit> <sha256 digest> <sha256 digest>`, `status` and
  `rollback`. Everything else, including an interactive login, is refused.

## 7. Restore and disaster recovery

```bash
sudo -i                          # dc() as in §5
dc stop api worker
docker exec -i zaroorat-dev-postgres-1 sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < /opt/zaroorat/backups/<file>.dump
/usr/local/sbin/zaroorat-deploy rollback   # or redeploy the release that matches the restored schema
```

Before a risky migration, take a manual dump:

```bash
docker exec zaroorat-dev-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > /opt/zaroorat/backups/pre-<commit>.dump
```

Host lost: restore the weekly Droplet backup, or rebuild with §4 plus the newest dump, then redeploy.

## 8. Verification after setup

| Check                                                                              | Expected                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `curl -fsS https://dev-api.zaroorat.com/ready`                                     | `"status":"ready"`, database and redis ok             |
| `curl -fsS https://dev-api.zaroorat.com/health`                                    | `"environment":"dev"`                                 |
| `curl -sI http://dev-api.zaroorat.com/health`                                      | redirect to https                                     |
| `curl -s -o /dev/null -w '%{http_code}' https://dev-api.zaroorat.com/metrics`      | `404`                                                 |
| `ssh deploy@<ip> id` and `ssh deploy@<ip> 'deploy main a b'` (with the deploy key) | both refused                                          |
| `id deploy`; `sudo -l -U deploy`                                                   | no `docker` group; exactly one sudo command           |
| `nc -vz <ip> 5432 6379 6432` from outside                                          | refused / filtered                                    |
| `sudo /usr/local/sbin/zaroorat-deploy status`                                      | `APP_IMAGE=…@sha256:…`, `api: ready`, `worker: ready` |
