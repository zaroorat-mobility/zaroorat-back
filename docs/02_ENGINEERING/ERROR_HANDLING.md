# Error Handling

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **See also:** [API Standards](../01_ARCHITECTURE/API_STANDARDS.md), `middleware/error.ts`, `core/errors`

One way to fail. Services **throw typed domain errors**; a single central handler maps them to the standard HTTP response. No layer invents its own error format.

---

## 1. The rule
- **Throw, don't return, errors.** Services throw typed errors; they never build `{ statusCode }` or an HTTP body.
- **One mapper:** `middleware/error.ts` converts any thrown error into the [standard error envelope](../01_ARCHITECTURE/API_STANDARDS.md).
- **Fail fast, fail loud, fail safe:** validate early, surface real failures, never leak internals.

## 2. Error taxonomy (`core/errors`)
All domain errors extend a common `AppError` carrying a stable `code`, an HTTP `status`, and a safe `message`.

| Error class | HTTP | `code` | When |
|---|---|---|---|
| `ValidationError` | 400 | `VALIDATION_ERROR` | bad input (usually raised by schema layer) |
| `UnauthenticatedError` | 401 | `UNAUTHENTICATED` | missing/invalid token |
| `ForbiddenError` | 403 | `FORBIDDEN` | authenticated but not allowed |
| `NotFoundError` | 404 | `NOT_FOUND` | entity missing or not visible to caller |
| `ConflictError` | 409 | `CONFLICT` | e.g. `INVALID_TRIP_TRANSITION`, duplicate |
| `UnprocessableError` | 422 | `UNPROCESSABLE` | semantically invalid |
| `RateLimitedError` | 429 | `RATE_LIMITED` | throttled |
| `DomainError` (base) | 400/409 | specific | catch-all business-rule violation |
| `InternalError` | 500 | `INTERNAL` | unexpected; details logged, not returned |

Specific business codes (e.g. `INVALID_TRIP_TRANSITION`, `DRIVER_NOT_OPERABLE`, `PAYMENT_ALREADY_CAPTURED`) extend the right base class and set a precise `code`.

## 3. The response envelope (error form)
Matches the [API Standards](../01_ARCHITECTURE/API_STANDARDS.md) envelope. Clients switch on `error.code`, never the message text.
```json
{
  "success": false,
  "message": "This ride cannot be cancelled once it has started.",
  "data": null,
  "meta": null,
  "error": { "code": "INVALID_TRIP_TRANSITION", "requestId": "req_..." }
}
```
- `message` is human-readable and safe to show a user.
- `error.code` is a stable `UPPER_SNAKE` enum.
- `requestId` correlates with logs/traces ([Logging](./LOGGING_GUIDE.md)).
- **Never** include stack traces, SQL, provider payloads, or PII.

## 4. Where errors are handled
- **Throw** in the service (or repository, for genuine data faults) with a typed error.
- **Do not catch** just to re-throw or to log at every layer — let it bubble to `middleware/error.ts`, which logs once and maps.
- Catch **only** to add context or to translate a foreign error (e.g. a Prisma unique-constraint violation → `ConflictError` with a clear code) — then re-throw the typed error.

## 5. Foreign errors (translate at the boundary)
- **Prisma:** map known errors (unique violation `P2002` → `ConflictError`, not-found `P2025` → `NotFoundError`) in the repository; never surface raw Prisma errors.
- **Providers (payment/SMS/maps):** wrap SDK errors into domain errors at the `integrations/` boundary; classify transient (retryable) vs permanent.
- **Unknown/unexpected:** become `InternalError` (500). The real cause is logged with `requestId`; the client gets a generic message.

## 6. Async & workers
- A worker job that throws is **retried with backoff**; on exhaustion it dead-letters ([Queue Guide](../01_ARCHITECTURE/QUEUE_GUIDE.md)). Money jobs never silently drop.
- Distinguish **retryable** (transient: gateway timeout) from **permanent** (bad data) failures — permanent failures should stop retrying and alert.

## 7. Realtime (sockets)
- Socket handlers emit an `error` event with the same shape (`{ code, message, requestId }`) and never crash the connection ([Socket Guide](../01_ARCHITECTURE/SOCKET_GUIDE.md)).

## 8. Anti-patterns (rejected in review)
- ❌ Returning `null`/`false` to signal an error instead of throwing.
- ❌ `catch (e) {}` — swallowing errors.
- ❌ Building HTTP status codes/bodies inside a service.
- ❌ Leaking stack traces or internal messages to clients.
- ❌ Logging the same error at every layer.
- ❌ A bare `throw new Error('...')` for a domain rule — use a typed error with a `code`.
