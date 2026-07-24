# Application Structure & Bootstrap

**Owner:** Engineering (Backend) · **Last reviewed:** 2026-07-06

How the FastAPI app is constructed and started. The layout was introduced in
[Volume 1](../00_Project/01_repository-structure.md); this page is the _runtime assembly_ — the app
factory, the lifespan, and how the per-module routers are wired into one application.

---

## The app factory

We build the app with a **factory function**, not a module-level global. A factory makes the app
configurable per environment and — critically — **testable** (a test can build an app with test
settings/overrides).

```python
# src/zaroorat/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI

from zaroorat.core.config import get_settings
from zaroorat.core.logging import configure_logging
from zaroorat.core.db import engine
from zaroorat.core.redis import redis_pool
from zaroorat.api import register_routers
from zaroorat.api.middleware import register_middleware
from zaroorat.api.errors import register_exception_handlers


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings)
    await redis_pool.connect(settings.redis_url)
    # DB engine is created lazily; verify connectivity fast-fail:
    await _check_db(engine)
    yield                                   # ---- app is serving ----
    await redis_pool.disconnect()
    await engine.dispose()


def create_app() -> FastAPI:
    settings = get_settings()               # validated; bad config → raises here (fail fast)
    app = FastAPI(
        title="Zaroorat Ride API",
        version=settings.api_version,
        lifespan=lifespan,
        docs_url="/docs", redoc_url="/redoc",   # OpenAPI (Volume 7)
    )
    register_middleware(app)                # order matters — see 04
    register_exception_handlers(app)        # domain error → envelope (Volume 7)
    register_routers(app)                   # mount every module's router under /api/v1
    return app


app = create_app()                          # uvicorn zaroorat.main:app
```

Key points:

- **`lifespan`** replaces deprecated startup/shutdown events: it opens pools on boot and disposes
  them on shutdown (graceful drain, Volume 4 zero-downtime).
- **Fail fast:** settings validate on `get_settings()`; DB/Redis connectivity is checked at
  startup — a broken environment never quietly serves 500s.
- **`create_app()` is the single assembly point.** Tests call it with overridden settings/deps.

---

## Mounting routers per module

Each module owns a `router.py` (Volume 5). A small registrar mounts them all under the versioned
prefix — adding a module is one line, and the version prefix lives in exactly one place (Volume 7).

```python
# src/zaroorat/api/__init__.py
from fastapi import FastAPI

from zaroorat.modules.auth.router import router as auth_router
from zaroorat.modules.rides.router import router as rides_router
from zaroorat.modules.wallet.router import router as wallet_router
# … one import per module

_ROUTERS = [auth_router, rides_router, wallet_router, ...]

def register_routers(app: FastAPI) -> None:
    for r in _ROUTERS:
        app.include_router(r, prefix="/api/v1")
```

A module's router declares its own sub-prefix and tags:

```python
# src/zaroorat/modules/rides/router.py
from fastapi import APIRouter, Depends
router = APIRouter(prefix="/rides", tags=["rides"])

@router.post("/estimate", response_model=FareEstimateOut)
async def estimate(body: FareEstimateIn, svc: PricingService = Depends(get_pricing_service)):
    return await svc.estimate(body)         # thin: parse → call service → return (Volume 1)
```

Note the router is **thin** — it validates input (Pydantic `FareEstimateIn`), calls a service
obtained via `Depends`, and returns a typed response. No business logic, no DB access (Volume 1/4).

---

## The `src/` layout (runtime view)

```
src/zaroorat/
├── main.py                 # app factory + lifespan (above)
├── worker.py               # worker entrypoint (see 05)
├── core/                   # cross-cutting singletons/helpers
│   ├── config.py           #   Settings (03)
│   ├── db.py               #   async engine, session factory, UoW (02)
│   ├── redis.py            #   redis pool + client
│   ├── logging.py          #   structured logging config (04)
│   ├── security.py         #   JWT, hashing, auth deps (04)
│   └── events.py           #   event bus + outbox helpers (05)
├── api/                    # HTTP wiring (not business logic)
│   ├── __init__.py         #   register_routers
│   ├── middleware.py       #   register_middleware (04)
│   ├── errors.py           #   exception handlers (04)
│   └── deps.py             #   shared FastAPI dependencies (02)
├── modules/                # the domains (Volume 5) — each: router/service/repository/…
└── shared/                 # base schemas, pagination, enums, domain-exception base
```

`core/` and `api/` are **infrastructure**; `modules/` is **domain**. The dependency direction is
always modules → core, never core → modules (core knows nothing about rides or wallet).

---

## Startup ordering & health

- **Boot sequence:** validate settings → configure logging → connect Redis → verify DB → mount app.
  Any failure aborts boot with a clear log line.
- **Health endpoints** (used by k8s probes, Volume 4/11):
  - `GET /healthz` — liveness: process is up (cheap, no deps).
  - `GET /readyz` — readiness: DB + Redis reachable; only then does the pod receive traffic.
- Readiness gating is what makes **rolling deploys safe** — a new pod takes traffic only once it can
  actually serve (NFR-AVAIL-03).
