# Development Environment

**Owner:** Engineering · **Last reviewed:** 2026-07-06

Goal: a new engineer clones the repo and has the full stack running locally within **30
minutes**. If setup takes longer than that, the setup is the bug — fix it and update this doc.

---

## Prerequisites

Install these once:

| Tool               | Version | Why                                                    |
| ------------------ | ------- | ------------------------------------------------------ |
| **Git**            | ≥ 2.40  | Version control                                        |
| **Docker Desktop** | latest  | Runs Postgres, Redis, and (optionally) the whole stack |
| **Python**         | 3.12.x  | Backend. Manage with `pyenv` (mac/linux) or `uv`       |
| **uv**             | latest  | Fast Python dependency & venv manager                  |
| **Node.js**        | 20 LTS  | Mobile & admin tooling. Manage with `nvm`/`fnm`        |
| **pnpm**           | ≥ 9     | JS package manager (workspaces)                        |
| **Expo Go** app    | latest  | Run the mobile app on a real device                    |
| **make**           | any     | Canonical task runner                                  |

Windows users: use **WSL2** for the backend/toolchain, or Git Bash + Docker Desktop.
The `make` targets assume a POSIX shell.

---

## First-time setup

```bash
git clone <repo-url> zaroorat-ride
cd zaroorat-ride
cp .env.example .env          # then fill in the blanks (see below)
make setup                    # installs backend + JS deps, sets up hooks
make up                       # starts Postgres + Redis + backend via Docker Compose
make migrate                  # applies DB migrations
make seed                     # loads demo data (test riders, drivers, zones)
```

At this point:

- Backend API → http://localhost:8000 (docs at `/docs`)
- Admin dashboard → http://localhost:5173
- Mobile → run `make mobile` and scan the QR code with Expo Go

`make setup` also installs the **pre-commit hooks** that run Ruff, Prettier, ESLint, and mypy
on staged files so you catch issues before pushing.

---

## Environment variables

Configuration is **never** hard-coded. It comes from environment variables, loaded from `.env`
locally and from secrets in CI/production. `.env` is **git-ignored** — only `.env.example`
(with placeholder values and comments) is committed.

Backend config is read through a single typed object (`core/config.py`, Pydantic
`BaseSettings`). If an env var is missing or malformed, the app **fails to start** with a clear
message — we never silently run with a bad config.

### `.env.example` (annotated)

```ini
# ─── Core ───────────────────────────────────────────────
ENV=local                       # local | staging | production
LOG_LEVEL=debug

# ─── Database ───────────────────────────────────────────
DATABASE_URL=postgresql+asyncpg://zaroorat:zaroorat@localhost:5432/zaroorat
# PostGIS extension is enabled by the init script in infra/docker

# ─── Redis ──────────────────────────────────────────────
REDIS_URL=redis://localhost:6379/0

# ─── Auth / Security ────────────────────────────────────
JWT_SECRET=change-me-in-every-real-environment
JWT_ACCESS_TTL_MINUTES=30
JWT_REFRESH_TTL_DAYS=30

# ─── Third-party (use sandbox keys locally) ─────────────
SMS_PROVIDER_KEY=             # OTP delivery
PAYMENT_GATEWAY_KEY=          # sandbox key locally
MAPS_API_KEY=                 # geocoding / routing

# ─── Mobile / Admin (public, VITE_/EXPO_PUBLIC_ prefixed) ─
EXPO_PUBLIC_API_URL=http://localhost:8000
VITE_API_URL=http://localhost:8000
```

> **Never** commit a real secret, even to a private repo. If a secret is exposed, rotate it —
> don't just delete the commit. See Volume 14 — Security.

---

## Running each app natively (without full Docker)

Docker Compose is the easy path, but you can run apps directly for faster iteration:

```bash
# Backend (needs Postgres + Redis running — `make deps-up` starts just those)
cd apps/backend
uv sync
uv run uvicorn zaroorat.main:app --reload --port 8000

# Admin
cd apps/admin && pnpm install && pnpm dev

# Mobile
cd apps/mobile && pnpm install && pnpm expo start
```

---

## The Makefile is the interface

You should rarely need to remember raw commands. The `Makefile` is the canonical entry point;
CI calls the same targets, so "works locally" means "works in CI".

| Target                  | Does                                  |
| ----------------------- | ------------------------------------- |
| `make setup`            | Install all deps + hooks              |
| `make up` / `make down` | Start / stop the Docker Compose stack |
| `make deps-up`          | Start only Postgres + Redis           |
| `make migrate`          | Apply DB migrations                   |
| `make seed`             | Load demo data                        |
| `make lint`             | Run all linters                       |
| `make fmt`              | Auto-format everything                |
| `make test`             | Run the full test suite               |
| `make mobile`           | Start Expo                            |

---

## Troubleshooting

| Symptom                           | Likely cause / fix                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Backend won't start, config error | A required var is missing from `.env` — read the error, it names the field                              |
| `port already in use`             | Something else on 8000/5432/6379 — `make down` or change the port                                       |
| Migrations fail                   | DB out of sync — `make db-reset` (drops & recreates the local DB)                                       |
| Expo can't reach API on device    | Phone and laptop must be on the same network; set `EXPO_PUBLIC_API_URL` to your LAN IP, not `localhost` |
| PostGIS functions missing         | The `postgis` extension didn't load — recreate the DB container                                         |
