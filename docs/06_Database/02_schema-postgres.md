# PostgreSQL Schema

**Owner:** Engineering (Data) · **Last reviewed:** 2026-07-06

The concrete DDL, per module. This is illustrative-but-precise: the real tables live in Alembic
migrations ([06](06_audit-softdelete-migrations.md)) and SQLAlchemy models, which **must match**
this. Types, constraints, and defaults here are intentional — a `CHECK` or `NOT NULL` shown below is
part of the design, not decoration.

> Conventions (money = `BIGINT` paisa, `TIMESTAMPTZ` UTC, plural tables, indexed FKs) are defined in
> the [Volume 6 README](README.md). Indexes are summarized per table and detailed in [05](05_indexing-partitioning.md).

---

## users

```sql
CREATE TABLE users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phone       TEXT        NOT NULL,                       -- E.164, +91…
    name        TEXT,
    locale      TEXT        NOT NULL DEFAULT 'en',          -- i18n (A6.4)
    roles       TEXT[]      NOT NULL DEFAULT '{rider}',     -- {'rider'} | {'rider','driver'}
    status      TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended')),   -- R-ACCOUNT-4
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    CONSTRAINT uq_users_phone UNIQUE (phone)                -- R-ACCOUNT-2
);
```

## refresh_tokens (auth — OTP is in Redis, not here)

```sql
CREATE TABLE refresh_tokens (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users(id),
    token_hash   TEXT        NOT NULL,                      -- store hash, never the token
    rotated_from BIGINT      REFERENCES refresh_tokens(id), -- rotation chain (theft detection)
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,                               -- logout / suspension
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_refresh_token_hash UNIQUE (token_hash)
);
CREATE INDEX ix_refresh_tokens_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
```

## drivers

```sql
CREATE TABLE drivers (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      NOT NULL REFERENCES users(id),
    state            TEXT        NOT NULL DEFAULT 'registered'
                     CHECK (state IN ('registered','docs_submitted','under_review',
                                      'approved','rejected','docs_required')),  -- V5 FSM
    is_online        BOOLEAN     NOT NULL DEFAULT false,
    rating           NUMERIC(3,2) NOT NULL DEFAULT 5.00,
    active_trip_id   BIGINT,                                 -- fast "on trip?" (R-AVAIL-1)
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    CONSTRAINT uq_drivers_user UNIQUE (user_id)
);
CREATE INDEX ix_drivers_matchable ON drivers (vehicle_type_hint)  -- see note
    WHERE state = 'approved' AND is_online = true AND active_trip_id IS NULL;
```

## kyc_documents

```sql
CREATE TABLE kyc_documents (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    driver_id     BIGINT      NOT NULL REFERENCES drivers(id),
    doc_type      TEXT        NOT NULL
                  CHECK (doc_type IN ('aadhaar','pan','driving_licence','rc','permit','fitness')),
    object_key    TEXT        NOT NULL,                      -- pointer into object storage
    status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected')),
    expires_at    TIMESTAMPTZ,                               -- expiry tracking (R-KYC-3)
    reviewed_by   BIGINT      REFERENCES users(id),
    review_reason TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ                                -- soft delete (retention, R-DATA-1)
);
CREATE INDEX ix_kyc_documents_driver ON kyc_documents (driver_id);
CREATE INDEX ix_kyc_documents_expiry ON kyc_documents (expires_at)
    WHERE status = 'approved';                               -- expiry sweep
```

## vehicles & assignments

```sql
CREATE TABLE vehicles (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    registration_no  TEXT        NOT NULL,                   -- RC number
    vehicle_type     TEXT        NOT NULL
                     CHECK (vehicle_type IN ('car','auto','bike','taxi')),
    approval_state   TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (approval_state IN ('pending','approved','rejected')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    CONSTRAINT uq_vehicles_registration UNIQUE (registration_no)
);

CREATE TABLE driver_vehicle_assignments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    driver_id   BIGINT      NOT NULL REFERENCES drivers(id),
    vehicle_id  BIGINT      NOT NULL REFERENCES vehicles(id),
    valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to    TIMESTAMPTZ,                                 -- NULL = current (FR-KYC-05)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- at most one active vehicle per driver at a time:
CREATE UNIQUE INDEX uq_active_assignment_per_driver
    ON driver_vehicle_assignments (driver_id) WHERE valid_to IS NULL;
```

## trips (+ ride request lifecycle)

We use **one `trips` table carrying the full FSM state** (Volume 5) rather than separate
`ride_requests`/`trips` tables — the lifecycle is one continuous aggregate and a single row with a
`state` column avoids a hand-off/copy between tables. (Decision recorded here; the ER shows the
conceptual split.)

```sql
CREATE TABLE trips (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rider_id           BIGINT      NOT NULL REFERENCES users(id),
    driver_id          BIGINT      REFERENCES drivers(id),   -- NULL until matched
    vehicle_id         BIGINT      REFERENCES vehicles(id),
    vehicle_type       TEXT        NOT NULL,
    state              TEXT        NOT NULL DEFAULT 'searching'
                       CHECK (state IN ('searching','accepted','arrived',
                                        'in_progress','completed','expired','cancelled')),
    -- geo (see 03_postgis-geo.md)
    pickup             geography(Point,4326) NOT NULL,
    dropoff            geography(Point,4326) NOT NULL,
    pickup_address     TEXT,
    dropoff_address    TEXT,
    -- pricing snapshot (fare lock, R-PRICE-5)
    quoted_fare_paisa  BIGINT,
    surge_at_booking   NUMERIC(4,2) NOT NULL DEFAULT 1.00,
    pricing_version    INT,                                  -- which pricing_config version
    final_fare_paisa   BIGINT,                               -- set on completion
    distance_m         INT,                                  -- actual (FR-TRIP-04)
    duration_s         INT,
    -- safety / lifecycle
    pickup_otp_hash    TEXT,                                 -- R-TRIP-2 (hash, not plaintext)
    cancelled_by       TEXT CHECK (cancelled_by IN ('rider','driver','system')),
    cancel_reason      TEXT,
    requested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at        TIMESTAMPTZ,
    arrived_at         TIMESTAMPTZ,
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_trips_rider_active   ON trips (rider_id)  WHERE state NOT IN ('completed','expired','cancelled');
CREATE INDEX ix_trips_driver_active  ON trips (driver_id) WHERE state NOT IN ('completed','expired','cancelled');
CREATE INDEX ix_trips_state_created  ON trips (state, created_at);
-- one active trip per rider / per driver (partial unique):
CREATE UNIQUE INDEX uq_rider_one_active_trip
    ON trips (rider_id) WHERE state IN ('searching','accepted','arrived','in_progress');
```

That last **partial unique index enforces Invariant "one active trip per rider" at the database
level** — the app can't accidentally create two. (A matching per-driver one is also created.)

## trip_locations (route history — partitioned, see [05])

```sql
CREATE TABLE trip_locations (
    id         BIGINT GENERATED ALWAYS AS IDENTITY,
    trip_id    BIGINT NOT NULL,
    point      geography(Point,4326) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (recorded_at);                          -- high volume (R-SAFE-4)
```

## trip_events (state-transition audit trail)

```sql
CREATE TABLE trip_events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id     BIGINT      NOT NULL REFERENCES trips(id),
    from_state  TEXT,
    to_state    TEXT        NOT NULL,
    event_type  TEXT        NOT NULL,
    actor_type  TEXT,                                        -- rider|driver|system
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_trip_events_trip ON trip_events (trip_id, created_at);
```

## pricing

```sql
CREATE TABLE pricing_configs (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city                   TEXT    NOT NULL,
    vehicle_type           TEXT    NOT NULL,
    base_fare_paisa        BIGINT  NOT NULL,
    per_km_paisa           BIGINT  NOT NULL,
    per_min_paisa          BIGINT  NOT NULL,
    booking_fee_paisa      BIGINT  NOT NULL DEFAULT 0,
    minimum_fare_paisa     BIGINT  NOT NULL,
    surge_cap              NUMERIC(4,2) NOT NULL DEFAULT 3.00,   -- R-PRICE-3
    cancellation_fee_paisa BIGINT  NOT NULL DEFAULT 0,
    cancellation_grace_sec INT     NOT NULL DEFAULT 120,
    commission_bps         INT     NOT NULL,                     -- basis points (e.g. 1500 = 15%)
    gst_bps                INT     NOT NULL DEFAULT 0,
    version                INT     NOT NULL,
    effective_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by             BIGINT  REFERENCES users(id),         -- audited (R-DATA-2)
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_pricing_city_type_version UNIQUE (city, vehicle_type, version)
);
```

`zones` and `surge_states` are in [03_postgis-geo.md](03_postgis-geo.md).

## wallet (double-entry — Volume 5)

```sql
CREATE TABLE accounts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_type  TEXT NOT NULL CHECK (owner_type IN
                ('rider','driver','platform','tax','cash_clearing','payout_clearing')),
    owner_id    BIGINT,                                       -- NULL for singleton platform/tax accts
    currency    TEXT NOT NULL DEFAULT 'INR',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_account_owner UNIQUE (owner_type, owner_id, currency)
);

CREATE TABLE ledger_transactions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type            TEXT NOT NULL CHECK (type IN
                    ('trip_settlement','topup','payout','refund','cancellation_fee','adjustment')),
    trip_id         BIGINT REFERENCES trips(id),
    idempotency_key TEXT NOT NULL,                            -- exactly-once (Volume 5)
    actor_id        BIGINT REFERENCES users(id),              -- for refunds/adjustments
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_ledger_txn_idem UNIQUE (idempotency_key)    -- dedupe retries
);

CREATE TABLE ledger_entries (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id  BIGINT NOT NULL REFERENCES ledger_transactions(id),
    account_id      BIGINT NOT NULL REFERENCES accounts(id),
    direction       TEXT   NOT NULL CHECK (direction IN ('debit','credit')),
    amount_paisa    BIGINT NOT NULL CHECK (amount_paisa > 0), -- always positive; direction carries sign
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    -- NO updated_at / deleted_at: ledger is APPEND-ONLY (W-2, R-DATA-1)
);
CREATE INDEX ix_ledger_entries_account ON ledger_entries (account_id, created_at);
CREATE INDEX ix_ledger_entries_txn     ON ledger_entries (transaction_id);

CREATE TABLE account_balances (            -- cache of derived balance (fast reads)
    account_id      BIGINT PRIMARY KEY REFERENCES accounts(id),
    balance_paisa   BIGINT NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()        -- kept in sync inside the txn
);

CREATE TABLE payouts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    driver_id   BIGINT NOT NULL REFERENCES drivers(id),
    amount_paisa BIGINT NOT NULL CHECK (amount_paisa > 0),
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','paid','failed')),
    transaction_id BIGINT REFERENCES ledger_transactions(id), -- traceable (R-PAY-4)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The `CHECK (amount_paisa > 0)` + `direction` column is how we keep amounts unsigned and let the
double-entry direction carry the sign — a small design choice that makes "sum of debits vs credits"
queries clean.

## ratings

```sql
CREATE TABLE ratings (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id     BIGINT NOT NULL REFERENCES trips(id),
    rater_type  TEXT   NOT NULL CHECK (rater_type IN ('rider','driver')),
    rater_id    BIGINT NOT NULL REFERENCES users(id),
    stars       SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),  -- R-RATE-1
    comment     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_rating_once UNIQUE (trip_id, rater_type)        -- one rating each way (R-RATE-3)
);
```

## notifications

```sql
CREATE TABLE device_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id),
    token       TEXT   NOT NULL,
    platform    TEXT   NOT NULL CHECK (platform IN ('android','ios')),
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_device_token UNIQUE (token)
);

CREATE TABLE notification_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    user_id     BIGINT NOT NULL,
    type        TEXT   NOT NULL,
    channel     TEXT   NOT NULL CHECK (channel IN ('push','sms','voice')),
    status      TEXT   NOT NULL CHECK (status IN ('sent','failed','delivered')),
    event_key   TEXT,                                        -- idempotency (N-2)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);                           -- high volume
```

## cross-cutting: outbox & audit_log

```sql
CREATE TABLE outbox (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id      TEXT NOT NULL,                             -- envelope id (Volume 5, §08)
    type          TEXT NOT NULL,
    aggregate_id  BIGINT,                                    -- e.g. trip_id
    payload       JSONB NOT NULL,
    published_at  TIMESTAMPTZ,                               -- NULL = not yet relayed
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_outbox_event UNIQUE (event_id)
);
CREATE INDEX ix_outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE audit_log (
    id           BIGINT GENERATED ALWAYS AS IDENTITY,
    actor_id     BIGINT REFERENCES users(id),
    action       TEXT NOT NULL,                              -- e.g. 'pricing.update','refund.issue'
    entity_type  TEXT NOT NULL,
    entity_id    BIGINT,
    before       JSONB,
    after        JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()          -- append-only (R-DATA-2)
) PARTITION BY RANGE (created_at);
```

---

## A note on the `drivers.vehicle_type_hint` index

The matchability partial index references a driver's current vehicle type. Because that lives in the
`driver_vehicle_assignments`/`vehicles` join, we either (a) denormalize a `vehicle_type_hint` onto
`drivers` (kept in sync when the active assignment changes) for a fast partial index, or (b) rely on
Redis GEO sets keyed by type for candidate search (Volume 4) and use Postgres only to verify. We do
**(b) as primary** (matching reads Redis), with (a) as an optional optimization — noted so the index
above isn't mistaken for the hot path. See [03](03_postgis-geo.md) and [05](05_indexing-partitioning.md).
