# Naming Conventions

**Owner:** Engineering · **Last reviewed:** 2026-07-06

Names are the cheapest documentation we have. A consistent name lets you predict what
something is and where it lives without opening it. This page is the canonical reference for
naming _anything_ in Zaroorat Ride.

---

## Quick reference table

| Thing                      | Convention                 | Example                              |
| -------------------------- | -------------------------- | ------------------------------------ |
| Python module / file       | `snake_case`               | `ride_matching.py`                   |
| Python class               | `PascalCase`               | `RideMatchingService`                |
| Python function / variable | `snake_case`               | `assign_nearest_driver`              |
| Python constant            | `UPPER_SNAKE_CASE`         | `MAX_SEARCH_RADIUS_KM`               |
| TS/JS file (component)     | `PascalCase.tsx`           | `RideCard.tsx`                       |
| TS/JS file (non-component) | `camelCase.ts`             | `useActiveRide.ts`, `formatMoney.ts` |
| React component            | `PascalCase`               | `<RideCard />`                       |
| TS function / variable     | `camelCase`                | `estimateFare`                       |
| TS type / interface        | `PascalCase`               | `RideRequest`                        |
| TS enum value              | `PascalCase`               | `RideStatus.InProgress`              |
| Boolean variable           | `is/has/can/should` prefix | `isDriverOnline`, `canCancel`        |
| Database table             | `snake_case`, **plural**   | `ride_requests`                      |
| Database column            | `snake_case`, **singular** | `driver_id`, `created_at`            |
| Primary key                | `id`                       | `id`                                 |
| Foreign key                | `<singular_table>_id`      | `rider_id`, `vehicle_id`             |
| DB index                   | `ix_<table>_<cols>`        | `ix_rides_status_created_at`         |
| DB unique constraint       | `uq_<table>_<cols>`        | `uq_users_phone`                     |
| Alembic migration          | `<seq>_<verb>_<subject>`   | `0007_add_driver_rating`             |
| REST resource path         | `kebab-case`, plural       | `/api/v1/ride-requests`              |
| JSON field (API)           | `camelCase`                | `estimatedFare`, `pickupLocation`    |
| Env variable               | `UPPER_SNAKE_CASE`         | `DATABASE_URL`, `REDIS_URL`          |
| Git branch                 | `type/scope-summary`       | `feat/rides-surge-pricing`           |
| Docker image               | `zaroorat/<app>`           | `zaroorat/backend`                   |
| Redis key                  | `colon:namespaced`         | `ride:active:{riderId}`              |

---

## The important nuances

### Database: tables plural, columns singular

A table holds many rows, so it is **plural** (`drivers`). A column holds one value per row,
so it is **singular** (`driver.rating`). Foreign keys name the singular of the target table
plus `_id`: a column pointing at `drivers` is `driver_id`. This makes joins read naturally.

Every table has these audit columns unless there's a documented reason not to:
`id`, `created_at`, `updated_at`, and (for soft-deletable entities) `deleted_at`.

### API paths are kebab-case and plural; JSON bodies are camelCase

The _URL_ is a resource collection → `/api/v1/ride-requests` (kebab, plural). The _payload_
is consumed by JS clients → its fields are `camelCase` (`pickupLocation`). The backend maps
between snake_case (Python/DB) and camelCase (JSON) at the schema boundary via Pydantic
aliases — this mapping is the **only** place the two worlds meet. Full rules in Volume 7.

### Redis keys are namespaced with colons

Format: `<domain>:<entity>:<qualifier>`. Examples:
`driver:location:{driverId}`, `ride:offer:{rideId}`, `ratelimit:otp:{phone}`.
Always include a TTL policy in the key's documentation (see Volume 6, Redis usage).

### Booleans read as questions

`isOnline`, `hasActiveRide`, `canAcceptRides`, `shouldNotify`. Never a bare noun
(`online`) or a negative (`isNotVerified` → prefer `isVerified` and invert at the callsite).

### No abbreviations except an approved allowlist

Write `driver`, not `drvr`; `request`, not `req` (outside of framework-conventional
`req`/`res` handler params). Approved short forms: `id`, `db`, `url`, `api`, `otp`, `kyc`,
`eta`, `gps`, `sms`, `jwt`, `utc`, `min`/`max`. Anything else, spell it out.

---

## Domain vocabulary (use these exact words)

Consistency of _domain_ terms prevents "same concept, three names" drift. Canonical terms:

| Concept                             | Use this word    | Not…                                        |
| ----------------------------------- | ---------------- | ------------------------------------------- |
| Person requesting a ride            | **rider**        | passenger, customer, user                   |
| Person driving                      | **driver**       | captain, partner                            |
| A single rider journey              | **trip**         | journey, booking (after it starts)          |
| The request before a driver accepts | **ride request** | booking, order                              |
| Driver assignment                   | **matching**     | dispatch, allocation                        |
| Surge multiplier                    | **surge**        | peak pricing, boost                         |
| In-app money balance                | **wallet**       | credits, balance (the _field_ is `balance`) |
| A single money movement             | **transaction**  | payment (payment = external gateway event)  |

When in doubt, this table wins. Add new terms here via PR so the glossary stays authoritative.
