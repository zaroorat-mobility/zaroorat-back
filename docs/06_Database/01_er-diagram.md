# Entity-Relationship Diagram

**Owner:** Engineering (Data) · **Last reviewed:** 2026-07-06

The map of entities and how they relate. Detail (columns, types, constraints) is in
[02_schema-postgres.md](02_schema-postgres.md); this page is the shape and the relationships.

---

## Core marketplace

```mermaid
erDiagram
    users ||--o| drivers : "may be a"
    users ||--o{ trips : "requests (as rider)"
    drivers ||--o{ trips : "drives"
    drivers ||--o{ kyc_documents : "submits"
    drivers ||--o{ driver_vehicle_assignments : "assigned"
    vehicles ||--o{ driver_vehicle_assignments : "assigned to"
    vehicles ||--o{ trips : "used in"
    users ||--o{ refresh_tokens : "has sessions"

    ride_requests ||--o| trips : "becomes"
    trips ||--o{ trip_locations : "route pings"
    trips ||--o{ trip_events : "state history"
    trips ||--o{ ratings : "rated in"

    users {
        bigint id PK
        text phone UK
        text status
    }
    drivers {
        bigint id PK
        bigint user_id FK
        text state
        numeric rating
    }
    vehicles {
        bigint id PK
        text registration_no UK
        text vehicle_type
    }
    trips {
        bigint id PK
        bigint rider_id FK
        bigint driver_id FK
        bigint vehicle_id FK
        text state
        bigint final_fare_paisa
    }
```

## Money (double-entry ledger)

```mermaid
erDiagram
    accounts ||--o{ ledger_entries : "posts"
    ledger_transactions ||--|{ ledger_entries : "groups (balanced)"
    accounts ||--o| account_balances : "cached"
    trips ||--o{ ledger_transactions : "settles"
    drivers ||--o{ payouts : "receives"

    accounts {
        bigint id PK
        text owner_type
        bigint owner_id
        text currency
    }
    ledger_transactions {
        bigint id PK
        text type
        bigint trip_id FK
        text idempotency_key UK
    }
    ledger_entries {
        bigint id PK
        bigint transaction_id FK
        bigint account_id FK
        text direction
        bigint amount_paisa
    }
```

## Pricing & geo

```mermaid
erDiagram
    zones ||--o{ surge_states : "has current surge"
    pricing_configs {
        bigint id PK
        text city
        text vehicle_type
        int version
        timestamptz effective_from
    }
    zones {
        bigint id PK
        text city
        text kind
        geometry geom
    }
    surge_states {
        bigint id PK
        bigint zone_id FK
        numeric multiplier
        timestamptz computed_at
    }
```

## Cross-cutting

```mermaid
erDiagram
    users ||--o{ device_tokens : "registers"
    users ||--o{ notification_log : "receives"
    users ||--o{ audit_log : "acts (as ops)"
    outbox {
        bigint id PK
        text event_id UK
        text type
        bigint aggregate_id
        timestamptz published_at
    }
    audit_log {
        bigint id PK
        bigint actor_id FK
        text action
        text entity_type
        jsonb before
        jsonb after
    }
```

---

## Key relationship notes (the non-obvious ones)

- **`users` ↔ `drivers` is 1-to-(0 or 1).** A user _may_ also be a driver (R-ACCOUNT-3). Driver-only
  data lives in `drivers`, keyed by `user_id`. Rider identity is just the `users` row.
- **`ride_requests` → `trips` is 1-to-(0 or 1).** A request that matches becomes a trip; a request
  that expires never produces a trip. (Implementation may collapse these into one `trips` table with
  a `state`; the ER shows the conceptual split — see [02](02_schema-postgres.md) for the decision.)
- **`driver_vehicle_assignments` is a join with validity**, not a direct `vehicle.driver_id`. This
  is deliberate — a driver changes vehicles and a fleet owner shares vehicles over time (Volume 5,
  D-3, fleet persona). A trip records the `vehicle_id` resolved at match time.
- **`ledger_entries` belong to a `ledger_transaction`** that must be **balanced** (Σ debits =
  Σ credits, W-1). The DB can't fully enforce "sum to zero across rows" cheaply, so it's enforced in
  the posting function + a reconciliation check; the schema makes it _representable and auditable_.
- **`account_balances` is a cache** of the derived balance for fast reads; the entries are the truth.
- **`outbox` and `audit_log`** are cross-cutting infra tables written by many modules.
