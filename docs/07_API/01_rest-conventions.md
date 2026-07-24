# REST Conventions

**Owner:** Engineering (API) · **Last reviewed:** 2026-07-06

The rules every endpoint follows so the API is predictable. A client developer who learns one
endpoint should be able to guess the others. Consistency here is worth more than cleverness.

---

## Resource URLs

- **Nouns, not verbs.** `POST /rides`, not `/createRide`. The HTTP method is the verb.
- **kebab-case, plural collections.** `/api/v1/ride-requests`, `/api/v1/drivers`.
- **Hierarchy for sub-resources.** `/api/v1/trips/{tripId}/locations`.
- **IDs are opaque** to the client — don't assume they're sequential integers even if they are.

```
/api/v1/{collection}                 # collection
/api/v1/{collection}/{id}            # a resource
/api/v1/{collection}/{id}/{sub}      # sub-collection
/api/v1/{collection}/{id}:{action}   # a non-CRUD action (see below)
```

## Methods & semantics

| Method   | Use                            | Idempotent?           | Body                      |
| -------- | ------------------------------ | --------------------- | ------------------------- |
| `GET`    | read                           | yes (no side-effects) | none                      |
| `POST`   | create / non-idempotent action | no*                   | yes                       |
| `PATCH`  | partial update                 | yes                   | yes (only changed fields) |
| `PUT`    | full replace (rare)            | yes                   | yes                       |
| `DELETE` | soft-delete                    | yes                   | none                      |

\* `POST` is made **effectively idempotent via `Idempotency-Key`** for our mutating flows
([04](04_errors-pagination-idempotency.md)) — critical for retry safety (A6.1).

### Actions that aren't CRUD

Some operations are verbs on a resource (accept a ride, start a trip). We model these as a POST to a
sub-path, reading as an action:

```
POST /api/v1/trips/{tripId}/accept
POST /api/v1/trips/{tripId}/start
POST /api/v1/trips/{tripId}/complete
POST /api/v1/trips/{tripId}/cancel
```

These map directly to the trip FSM transitions (Volume 5, §02). The server enforces legality; an
illegal transition returns `409 Conflict` with a `code` the client reconciles against.

## Status codes (the set we use)

| Code                    | Meaning                                  | When                                             |
| ----------------------- | ---------------------------------------- | ------------------------------------------------ |
| `200 OK`                | success with body                        | GET, successful action                           |
| `201 Created`           | resource created                         | POST create                                      |
| `202 Accepted`          | accepted, async                          | OTP requested, matching started                  |
| `204 No Content`        | success, no body                         | DELETE                                           |
| `400 Bad Request`       | malformed / validation                   | bad input shape/values                           |
| `401 Unauthorized`      | missing/invalid token                    | expired access token → refresh                   |
| `403 Forbidden`         | authenticated but not allowed            | RBAC denial                                      |
| `404 Not Found`         | no such resource (or not visible to you) |                                                  |
| `409 Conflict`          | state conflict                           | illegal FSM transition, double-accept, duplicate |
| `422 Unprocessable`     | semantically invalid                     | business-rule violation                          |
| `429 Too Many Requests` | rate limited                             | OTP abuse, throttling                            |
| `500 / 503`             | server / unavailable                     | unexpected; client may retry idempotently        |

We **do not** overload `200` with an error field. HTTP status carries success/failure; the body
carries detail. A failed request never returns `200`.

## JSON conventions

- **camelCase field names** (`estimatedFare`, `pickupLocation`) — mapped from snake_case Python via
  Pydantic aliases (Volume 1).
- **Money as an object**, never a bare number, to avoid float/precision ambiguity:
  ```json
  { "amount": 20000, "currency": "INR", "display": "₹200.00" }
  ```
  `amount` is integer **paisa** (matches the DB, Volume 6). Clients format from `amount`/`currency`;
  `display` is a convenience.
- **Timestamps are ISO-8601 UTC** (`"2026-07-06T10:12:00Z"`) — never epoch-ambiguous or local.
- **Enums are lowercase strings** matching the domain (`"in_progress"`, `"auto"`).
- **Locations** are `{ "lat": 34.0837, "lng": 74.7973 }` (WGS84, matches SRID 4326).
- **Nullable vs absent:** omit a field that doesn't apply; use `null` only when "explicitly empty" is
  meaningful.

## Versioning

- **Major version in the path:** `/api/v1`. A breaking change (removed field, changed type/meaning,
  new required input) ships as `/api/v2`, run side-by-side during migration.
- **Additive changes don't bump the version** — new optional fields, new endpoints. Clients ignore
  unknown fields (forward-compatible), so additions are safe.
- **Deprecation:** an endpoint/field marked deprecated in OpenAPI, announced, and removed only in a
  major bump after clients migrate.

## Request conventions

| Header                        | Purpose                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `Authorization: Bearer <jwt>` | auth on protected endpoints                                            |
| `Idempotency-Key: <uuid>`     | required on mutating flows ([04](04_errors-pagination-idempotency.md)) |
| `Accept-Language: <locale>`   | localized messages (A6.4)                                              |
| `X-Request-ID`                | optional client trace id; echoed in logs (NFR-OBS-01)                  |
