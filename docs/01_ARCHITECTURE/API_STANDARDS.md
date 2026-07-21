# API Standards

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **See also:** [System Architecture](./SYSTEM_ARCHITECTURE.md), [Security](./SECURITY_GUIDE.md)

The API is a **contract** with the mobile clients. It is schema-first (Fastify + JSON Schema), versioned, and published via Swagger/OpenAPI.

---

## 1. Conventions
- **Base path & versioning:** `/api/v1`. Breaking changes bump the version; never break `v1` in place.
- **Resources are nouns, plural:** `/rides`, `/payments`, `/documents`.
- **HTTP verbs:** `GET` (read, safe), `POST` (create/action), `PATCH` (partial update), `DELETE` (remove). No verbs in paths (`/rides/:id/cancel` is an accepted action-sub-resource exception for state transitions).
- **IDs** are opaque strings (cuid); clients never parse them.
- **Time** is ISO-8601 UTC. **Money** is an integer-minor-unit or decimal string + currency code — never a float.

## 2. Request/response
- **Every route declares request + response JSON Schemas.** Invalid input is rejected at the boundary before any service runs — 400 with details.
- **Every response uses the same envelope** (below) — success and error alike. One contract, so clients parse every endpoint identically.
- Pagination: cursor-based (`?cursor=&limit=`) for lists; never offset for large sets.
- Field naming: `camelCase` in JSON.

## 3. The response envelope (one shape for everything)
Every response — success or failure — has these five fields. This is a hard contract; do not deviate per endpoint.
```json
{
  "success": true,
  "message": "Ride booked successfully",
  "data": {},
  "meta": {},
  "error": null
}
```
| Field | Type | Meaning |
|---|---|---|
| `success` | boolean | `true` on 2xx, `false` otherwise |
| `message` | string | human-readable, safe to show a user |
| `data` | object \| array \| null | the payload on success; `null` on error |
| `meta` | object \| null | pagination, counts, cursors; `null` when unused |
| `error` | object \| null | `null` on success; on failure `{ code, requestId, details? }` |

**Success example**
```json
{ "success": true, "message": "Ride booked", "data": { "tripId": "trp_...", "status": "MATCHING" }, "meta": null, "error": null }
```
**Paginated success**
```json
{ "success": true, "message": "OK", "data": [ /* items */ ], "meta": { "cursor": "abc", "limit": 20, "hasMore": true }, "error": null }
```
**Error example** (produced centrally by `middleware/error.ts`)
```json
{ "success": false, "message": "This ride cannot be cancelled once it has started.", "data": null, "meta": null, "error": { "code": "INVALID_TRIP_TRANSITION", "requestId": "req_..." } }
```
- `error.code` is a stable `UPPER_SNAKE` enum — clients switch on it, never on `message`.
- `requestId` correlates with logs/traces. **Never** leak stack traces, SQL, provider payloads, or PII.
- Build envelopes with shared helpers (`ok(data, message?, meta?)` / the error mapper), never by hand in a controller. See [Error Handling](../02_ENGINEERING/ERROR_HANDLING.md).
- **204 No Content** carries no body (the one exception to the envelope).

## 4. Status codes
| Code | Use |
|---|---|
| 200 | OK (read/action with body) |
| 201 | Created |
| 202 | Accepted (async started, e.g. OTP sent) |
| 204 | Success, no body |
| 400 | Validation error |
| 401 | Unauthenticated |
| 403 | Authenticated but not authorized |
| 404 | Not found (or not visible to this user) |
| 409 | Conflict / illegal state transition |
| 422 | Semantically invalid |
| 429 | Rate limited |
| 5xx | Server error (never on client mistakes) |

## 5. Idempotency
- Money-mutating and non-idempotent `POST`s **require** an `Idempotency-Key` header (ADR-0008). A repeated key returns the stored response without re-executing.
- Endpoints requiring it are marked in the contract (see the API surface in [System Architecture](./SYSTEM_ARCHITECTURE.md)).

## 6. Auth
- Every endpoint declares its required auth + role; **deny by default** ([Security](./SECURITY_GUIDE.md)).
- `Authorization: Bearer <accessToken>`. 401 vs 403 are distinct and correct.

## 7. Representative endpoints
Full list lives in the module `*.routes.ts` and Swagger. Highlights:

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/otp/request` | public | rate-limited |
| POST | `/auth/otp/verify` | public | returns tokens |
| POST | `/rides/estimate` | RIDER | fare quote |
| POST | `/rides` | RIDER | **Idempotency-Key** |
| GET | `/rides/:id` | RIDER/DRIVER | reconcile source of truth |
| POST | `/dispatch/offers/:id/accept` | DRIVER | **Idempotency-Key** |
| POST | `/payments/:tripId/charge` | RIDER/SYSTEM | **Idempotency-Key** |
| POST | `/admin/documents/:id/review` | ADMIN | audited |

## 8. Realtime (Socket.io)
- Socket events are part of the API contract too — see [Events](./EVENT_CATALOG.md).
- Server-authoritative: on reconnect, clients reconcile via `GET /rides/:id`.

## 9. Documentation
- Swagger is generated from route schemas and is the **live contract** for clients. Keep schemas accurate — they are the docs.
- Any endpoint change updates its schema in the same PR.
