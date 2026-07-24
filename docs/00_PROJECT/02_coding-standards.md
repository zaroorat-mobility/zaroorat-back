# Coding Standards

**Owner:** Engineering · **Last reviewed:** 2026-07-06

Standards exist so that code written by ten people reads like it was written by one. They are
**enforced by tooling**, not by opinion in review — if a rule can be automated, it is, so that
review time is spent on design and correctness, not on formatting nits.

> **The golden rule:** CI runs the linters and formatters. If CI is green, the style is
> correct by definition. Do not argue style in review; change the config instead (via PR).

---

## Python (backend)

### Toolchain

| Concern       | Tool               | Config location   |
| ------------- | ------------------ | ----------------- |
| Formatting    | **Ruff formatter** | `pyproject.toml`  |
| Linting       | **Ruff**           | `pyproject.toml`  |
| Type checking | **mypy** (strict)  | `pyproject.toml`  |
| Import order  | Ruff (isort rules) | `pyproject.toml`  |
| Runtime       | Python **3.12**    | `.python-version` |

Run everything with `make lint` and `make fmt`. Pre-commit hooks run these on staged files.

### Rules that matter

- **Line length: 100.** Not 79, not 120.
- **Type hints are mandatory** on all function signatures. mypy runs in strict mode; `Any` is
  a smell that needs a comment justifying it.
- **Pydantic v2 for all I/O boundaries.** Data entering or leaving the service is validated by
  a Pydantic model. No hand-rolled dict validation.
- **No business logic in `router.py`.** Routers are thin. (See repository-structure.)
- **Async by default.** Endpoints and DB/Redis calls are `async`. Never block the event loop
  with sync I/O; if you must call sync code, use `run_in_threadpool`.
- **Explicit is better than implicit.** No `from x import *`. No magic `__getattr__` tricks.
- **Exceptions are typed.** Raise domain exceptions (from `<domain>/exceptions.py`); a single
  handler maps them to HTTP responses. Never `raise HTTPException` from a service.
- **No print debugging.** Use the structured logger (`core.logging`); logs are JSON in prod.

### Example — the shape we want

```python
# modules/wallet/service.py
from decimal import Decimal

from zaroorat.modules.wallet.repository import WalletRepository
from zaroorat.modules.wallet.exceptions import InsufficientFundsError


class WalletService:
    def __init__(self, repo: WalletRepository) -> None:
        self._repo = repo

    async def debit(self, wallet_id: int, amount: Decimal) -> "WalletBalance":
        """Deduct `amount` from a wallet. Raises InsufficientFundsError if too low."""
        wallet = await self._repo.get_for_update(wallet_id)
        if wallet.balance < amount:
            raise InsufficientFundsError(wallet_id=wallet_id, requested=amount)
        return await self._repo.adjust_balance(wallet_id, -amount)
```

Note: money is `Decimal`, never `float`. Locking is explicit. The service raises a domain
error, not an `HTTPException`. Dependencies are injected, so it's unit-testable without a DB.

---

## TypeScript (mobile & admin)

### Toolchain

| Concern    | Tool                                                   |
| ---------- | ------------------------------------------------------ |
| Formatting | **Prettier**                                           |
| Linting    | **ESLint** (shared config in `packages/eslint-config`) |
| Types      | **TypeScript** `strict: true`                          |
| Runtime    | Node 20 (tooling) · Expo SDK for mobile                |

### Rules that matter

- **`strict: true` is non-negotiable.** No implicit `any`, no unchecked null.
- **No `any`.** Use `unknown` and narrow, or define the type. `any` in a PR needs justification.
- **Function components + hooks only.** No class components.
- **Server state ≠ client state.** Server data lives in **React Query**; local UI state lives in
  component state or **Zustand**. Never cache server data manually in a global store.
- **Types come from the contract.** Request/response types are **generated** from
  `packages/api-contracts`. Do not hand-write API types — they drift.
- **Named exports** for components and utilities (default exports only where a framework, e.g.
  Expo Router routes, requires them).
- **No inline styles for anything reusable.** Use Tailwind (admin) / design tokens (mobile).

### Example

```tsx
// features/rides/useActiveRide.ts
import { useQuery } from '@tanstack/react-query';
import { getActiveRide } from '@/api/rides';
import type { Ride } from '@/api/types'; // generated from the contract

export function useActiveRide(riderId: string) {
  return useQuery<Ride | null>({
    queryKey: ['rides', 'active', riderId],
    queryFn: () => getActiveRide(riderId),
    refetchInterval: 5_000, // poll while a ride is live
  });
}
```

---

## Universal rules (every language)

- **Small functions, single responsibility.** If you need "and" to describe what a function
  does, split it.
- **Comment the _why_, not the _what_.** The code says what; comments explain intent, trade-offs,
  and non-obvious constraints ("we lock here because two drivers can accept the same ride").
- **No dead code, no commented-out blocks.** Git remembers; delete it.
- **No secrets in code.** Ever. Config comes from environment (`core/config.py` /
  `app.config.ts`). See [`05_development-environment.md`](05_development-environment.md).
- **Fail loudly in dev, gracefully in prod.** Validate early; return typed errors.
- **Every non-trivial change ships with tests.** See Volume 12.

---

## Editor setup

Commit-time hooks catch violations, but a fast feedback loop is better. Configure your editor to:

- Format on save (Ruff / Prettier).
- Show ESLint & mypy diagnostics inline.
- Use the workspace TypeScript & Python interpreter (not a global one).

A shared `.vscode/settings.json` and recommended-extensions list live at the repo root.
