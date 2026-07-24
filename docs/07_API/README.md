# Volume 7 — API Design

> The contract between the backend and its clients (mobile, admin, and any future integrator). If
> Volume 5 is _what the server does_ and Volume 6 is _how data is stored_, this volume is _how the
> outside world talks to it_ — the shape of every request, response, error, and realtime message.

**Owner:** Engineering (API) · **Last reviewed:** 2026-07-06

---

## Contents

| Doc                                                                        | Topic                                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [01_rest-conventions.md](01_rest-conventions.md)                           | Resource design, methods, status codes, JSON casing, versioning |
| [02_endpoint-catalog.md](02_endpoint-catalog.md)                           | Every REST endpoint, per module, with examples                  |
| [03_websocket-contracts.md](03_websocket-contracts.md)                     | Realtime channels & message contracts                           |
| [04_errors-pagination-idempotency.md](04_errors-pagination-idempotency.md) | Error model, pagination, filtering, the idempotency protocol    |
| [05_openapi-and-clients.md](05_openapi-and-clients.md)                     | OpenAPI as source of truth, generated clients, auth             |

---

## The five API rules

1. **The contract is generated, not hand-written.** FastAPI + Pydantic emit the **OpenAPI** spec;
   the TypeScript clients for mobile and admin are **generated** from it (Volume 1 rule). Hand-typed
   API models are forbidden — they drift.
2. **URLs are kebab-case & plural; JSON is camelCase.** `/api/v1/ride-requests` returns
   `{ "pickupLocation": … }`. Python/DB stay snake_case; Pydantic aliases map at the boundary
   (Volume 1 naming). This mapping is the _only_ place the two worlds meet.
3. **Every mutating call is idempotent.** Clients send an `Idempotency-Key`; retries after a
   connectivity drop are safe (A6.1, NFR-RESIL-02). This is not optional in this market.
4. **Errors have one shape.** Every error — validation, auth, conflict, server — returns the same
   envelope with a stable machine-readable `code`. Clients switch on `code`, never on prose.
5. **Versioned from day one.** The path carries a major version (`/api/v1`). Breaking changes go to
   `/api/v2`; additive changes don't bump it.

---

## Surfaces

| Surface            | Protocol                         | Used by              | Doc                                   |
| ------------------ | -------------------------------- | -------------------- | ------------------------------------- |
| REST API           | HTTPS/JSON                       | rider, driver, admin | [02](02_endpoint-catalog.md)          |
| Realtime           | WSS (WebSocket)                  | rider, driver        | [03](03_websocket-contracts.md)       |
| Webhooks (phase 2) | HTTPS (inbound from payment/UPI) | payment gateway      | noted in [02](02_endpoint-catalog.md) |

## Auth model (summary; detail in [05](05_openapi-and-clients.md))

- **Bearer JWT** access token on every authenticated request: `Authorization: Bearer <token>`.
- Short-lived access + tracked refresh (Volume 5 auth). `401` → refresh; refresh fails → re-auth.
- **Authorization is enforced server-side on every endpoint** (default-deny, NFR-SEC-04). RBAC scopes
  gate admin/ops actions.
