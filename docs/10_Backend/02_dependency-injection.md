# Dependency Injection & the Unit of Work

**Owner:** Engineering (Backend) · **Last reviewed:** 2026-07-06

FastAPI's `Depends` is how we assemble the `router → service → repository → session` chain per
request. Done well, DI is what makes the layering from Volume 1/4 **real and testable** rather than a
convention people forget. This page defines the wiring and the per-request transaction boundary.

---

## The dependency chain

```mermaid
flowchart LR
    REQ["HTTP request"] --> ROUTE["router endpoint"]
    ROUTE -->|Depends| SVC["service"]
    SVC -->|constructed with| REPO["repository"]
    REPO -->|constructed with| SESS["AsyncSession (per request)"]
    SESS --> PG[(Postgres)]
```

Each layer is injected the one below it. Nothing reaches around the chain (a router never gets a
session; a service never gets a raw connection).

```python
# api/deps.py — the wiring
from collections.abc import AsyncIterator
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from zaroorat.core.db import session_factory

async def get_session() -> AsyncIterator[AsyncSession]:
    async with session_factory() as session:      # one session per request
        yield session

def get_ride_repository(session: AsyncSession = Depends(get_session)) -> RideRepository:
    return RideRepository(session)

def get_ride_service(repo: RideRepository = Depends(get_ride_repository)) -> RideService:
    return RideService(repo)
```

```python
# modules/rides/router.py
@router.post("", status_code=201, response_model=RideOut)
async def create_ride(
    body: RideCreateIn,
    svc: RideService = Depends(get_ride_service),
    caller: AuthContext = Depends(require_rider),     # auth (04)
    idem: str = Depends(idempotency_key),             # Volume 7 ⏱
):
    return await svc.create_ride(caller.user_id, body, idempotency_key=idem)
```

The endpoint reads almost like a sentence: _given a validated body, a ride service, an authenticated
rider, and an idempotency key — create the ride._ All plumbing is in `Depends`.

---

## The Unit of Work (transaction boundary)

Business operations that change state must be **atomic** (Volume 5: FSM transitions, ledger
postings). We model this with a **Unit of Work (UoW)** that owns the transaction, so a service method
either fully commits or fully rolls back — including the **outbox** write (Volume 5 §08).

```python
# core/db.py
class UnitOfWork:
    def __init__(self, session: AsyncSession):
        self.session = session

    @asynccontextmanager
    async def transaction(self):
        async with self.session.begin():      # BEGIN … COMMIT/ROLLBACK
            yield
```

```python
# modules/rides/trip_service.py (Volume 5 §02, wired here)
class TripService:
    def __init__(self, uow: UnitOfWork, repo: TripRepository, events: EventOutbox):
        self._uow, self._repo, self._events = uow, repo, events

    async def transition(self, trip_id, event, ctx):
        async with self._uow.transaction():           # atomic
            trip = await self._repo.get_for_update(trip_id)   # row lock (Volume 5)
            ...                                                # apply FSM rule
            await self._repo.save(trip)
            await self._events.enqueue(rule.emit(trip, ctx))  # outbox, same txn
            return trip
```

**Why UoW and not per-repository commits:** a settlement touches multiple rows and writes an outbox
event; they must commit together or not at all (Volume 5, W-1/I-3). The UoW makes the transaction
boundary explicit and owned by the _service_ (the use-case), which is where atomicity belongs.

---

## Injecting cross-cutting dependencies

| Dependency                                                | Provided by                   | Used for                        |
| --------------------------------------------------------- | ----------------------------- | ------------------------------- |
| `get_session`                                             | request-scoped `AsyncSession` | DB access                       |
| `require_rider` / `require_driver` / `require_scope(...)` | auth deps (04)                | authn/authz (default-deny)      |
| `idempotency_key`                                         | header extractor              | idempotent mutations (Volume 7) |
| `get_redis`                                               | redis client                  | cache, geo, rate limits         |
| `get_settings`                                            | cached Settings               | config (03)                     |
| `request_context`                                         | request-id/logger             | tracing/logging (04)            |

Redis-backed repositories (e.g. driver geo, idempotency store) are wired the same way — injected, not
imported as globals — so they're swappable in tests.

---

## Why this is testable (the payoff)

Because every dependency is injected, a unit test constructs a service with **fakes/stubs** and no
network:

```python
async def test_debit_rejects_overdraw():
    repo = FakeWalletRepository(balance=100_00)          # paisa
    svc = WalletService(FakeUoW(), repo)
    with pytest.raises(InsufficientFundsError):
        await svc.debit(account_id=1, amount=200_00)      # no DB, no Redis
```

- **Services test without a database** (fake repository) — fast, deterministic.
- **Repositories test against a real (test) Postgres** — they're the only layer that knows SQL, so
  that's the layer where a DB integration test earns its keep (Volume 12).
- **Routers test via the app + overridden deps** (`app.dependency_overrides`) — HTTP-level tests
  without real services.

This three-tier testing split falls directly out of the DI design — see
[Volume 12](../13_Testing/README.md).
