# Environment & Configuration

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **Source of truth:** [`src/config/env.schema.ts`](../../src/config/env.schema.ts) · **Template:** [`.env.example`](../../.env.example)

Config is validated at boot. **The app refuses to start with an invalid or missing environment** — no silent defaults for anything that matters.

---

## 1. Rules
- Every env var is declared and validated in `config/env.schema.ts`. Undeclared vars are ignored; invalid ones **fail fast** at boot.
- `.env` is **git-ignored**; `.env.example` lists every key with a placeholder (no real values) and stays in sync.
- Secrets never live in code, images, or Git — they come from the platform secret store.
- **Runtime business config** (fares, surge, feature flags, service areas) is **not** env — it lives in the `Setting` table, versioned and audited.

## 2. Config domains (adapters in `src/config/`)
| Concern | File | Notes |
|---|---|---|
| Database | `database.ts` | `DATABASE_URL` (Postgres) |
| Redis | `redis.ts` | cache / queues / socket adapter |
| Payments | `payment.ts` | provider behind interface (ADR-0007) |
| SMS/OTP | `sms.ts` | provider behind interface |
| Maps/routing | `maps.ts` | provider behind interface |
| Storage | `storage.ts` | object storage + signed URLs |
| Logger | `logger.ts` | level, format |

## 3. Typical variables
> Authoritative list is `env.schema.ts`; this is an orientation map.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` / `staging` / `production` |
| `PORT` | API listen port |
| `DATABASE_URL` | Postgres connection |
| `REDIS_URL` | Redis connection |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | token signing |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | token lifetimes |
| `PAYMENT_*` | gateway credentials (per provider) |
| `SMS_*` | OTP provider credentials |
| `MAPS_*` | maps/routing key |
| `STORAGE_*` | object-storage bucket + credentials |
| `LOG_LEVEL` | logger verbosity |
| `RATE_LIMIT_*` | limiter tuning |

## 4. Per-environment
- **development:** docker-compose Postgres/Redis; verbose logging; test provider sandboxes.
- **staging:** prod-like; real provider sandboxes; safe to load-test.
- **production:** real credentials from the secret store; `LOG_LEVEL=info`; strict limits.

## 5. Adding a variable
1. Add it to `config/env.schema.ts` with type + validation (and a default only if truly safe).
2. Add a placeholder to `.env.example`.
3. Consume it via the typed config object — never read `process.env` directly in a module.
4. Document non-obvious vars here.

## 6. Precedence
`process env (secret store)` → validated by `env.schema.ts` → typed config object consumed by the app. Business toggles that change at runtime belong in `Setting`, not here.
