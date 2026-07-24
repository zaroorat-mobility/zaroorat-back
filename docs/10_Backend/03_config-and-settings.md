# Configuration & Settings

**Owner:** Engineering (Backend) · **Last reviewed:** 2026-07-06
**Realizes:** Volume 1 config principle, NFR-SEC-01, NFR-MAINT-03

All configuration flows through **one typed, validated `Settings` object**. Config comes from the
environment (Volume 1); this page is how the backend reads, validates, and uses it — and how
tunable behavior (feature flags, pricing) differs from static config.

---

## One Settings object (Pydantic)

```python
# core/config.py
from functools import lru_cache
from pydantic import PostgresDsn, RedisDsn, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)

    env: str = Field("local", pattern="^(local|staging|production)$")
    log_level: str = "info"
    api_version: str = "1"

    database_url: PostgresDsn
    redis_url: RedisDsn

    jwt_secret: str                              # REQUIRED — no default (fail fast)
    jwt_access_ttl_minutes: int = 30
    jwt_refresh_ttl_days: int = 30

    otp_ttl_seconds: int = 300
    otp_max_attempts: int = 5

    sms_provider_key: str | None = None          # optional locally, required in prod (validated)
    maps_api_key: str | None = None

    @property
    def is_production(self) -> bool:
        return self.env == "production"

@lru_cache
def get_settings() -> Settings:
    return Settings()                            # constructs once; raises on missing/invalid
```

Properties of this design:

- **Typed & validated:** `database_url` must be a valid DSN; `env` must match the pattern. Bad input
  → a clear `ValidationError` **at startup**, not a mystery 500 later (Volume 1 "fail fast").
- **Required vs optional is explicit:** `jwt_secret` has no default → the app won't boot without it.
  Local-optional keys (`sms_provider_key`) are `None` locally but **enforced in production** (below).
- **Cached** (`lru_cache`): one instance, injected via `Depends(get_settings)`.

---

## Environment-specific validation

Some values are optional in dev but **mandatory in production**. We assert that at boot rather than
discovering it when an OTP fails in prod:

```python
def validate_for_environment(s: Settings) -> None:
    if s.is_production:
        missing = [k for k in ("sms_provider_key", "maps_api_key") if getattr(s, k) is None]
        if missing:
            raise RuntimeError(f"Missing required production config: {missing}")
        if s.jwt_secret == "change-me":
            raise RuntimeError("Refusing to boot production with the default JWT secret.")
```

Called during `create_app()` (Volume 10 §01). This is a **guardrail against shipping a misconfigured
prod** — a class of outage that's entirely preventable.

---

## Secrets

- **Secrets are never in code or git** (Volume 1). Locally they're in `.env` (git-ignored); in
  staging/production they're injected as environment variables from the platform secret store
  (Volume 11/14) — the app doesn't care _where_ env came from, only that it's present.
- **Only `EXPO_PUBLIC_*`/`VITE_*` values are client-safe** (Volume 8/9); backend secrets
  (`jwt_secret`, provider keys) are server-only and must never leak to a client build.
- Rotating a secret is a config change + restart, not a code change — because config is external.

---

## Static config vs. dynamic (tunable) config

Two different things people conflate:

| Kind               | Lives in         | Changed by                    | Example                                   |
| ------------------ | ---------------- | ----------------------------- | ----------------------------------------- |
| **Static config**  | env / `Settings` | ops + **restart/redeploy**    | DB URL, JWT TTL, provider keys            |
| **Dynamic config** | database / Redis | ops **at runtime, no deploy** | pricing params, surge caps, feature flags |

- **Static** rarely changes and is environmental — it's fine that changing it needs a restart.
- **Dynamic** is business-tunable and must change **without a deploy** (R-PRICE-6): pricing configs
  live in Postgres and are edited via the admin (Volume 9); surge lives in Redis (Volume 6).

Don't put business-tunable values in `Settings` (they'd need a deploy to change) and don't put
environmental wiring in the database (it belongs with the environment). This split is deliberate.

---

## Feature flags

- Simple flags (enable a feature per environment / gradually) are **dynamic config**: stored and
  read at runtime, changeable by ops. Used to merge incomplete work safely under trunk-based
  development (Volume 1, ADR-0002) and to gate rollouts (Volume 13).
- A flag check is a cheap, cached lookup; flags default to **off/safe** if the store is unreachable.

---

## Accessing config in code

- **Injected** via `Depends(get_settings)` in request paths (testable, Volume 10 §02).
- **Imported** via `get_settings()` in bootstrap/worker code where DI isn't available.
- **Never** read `os.environ` scattered around the codebase — that bypasses validation and typing.
  All env reading happens in `Settings`. This is enforced in review.
