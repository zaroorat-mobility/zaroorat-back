# ADR-0003: PostgreSQL + PostGIS for geospatial data

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Engineering

## Context

A ride-hailing platform is geospatial at its core: "find the nearest available drivers to a
pickup point", "is this location inside a surge zone", "compute trip distance". We need to store
points and polygons and run fast proximity and containment queries. We also need a primary
transactional store for users, rides, wallets, and payments with strong consistency.

## Decision

We will use **PostgreSQL 16 as the primary datastore, with the PostGIS extension** for all
geospatial data and queries. Driver live locations, which are high-write and ephemeral, are held
in **Redis** (geo commands) and only periodically snapshotted to Postgres.

## Alternatives considered

- **Postgres + PostGIS (chosen for storage & analytical geo).** One database for transactional
  and geo data, mature spatial indexing (GiST), rich functions (`ST_DWithin`, `ST_Contains`).
  Avoids a second system for zones/geofences.
- **A dedicated geo database (e.g. a specialized spatial store).** More moving parts and another
  consistency boundary for marginal benefit at our scale.
- **Redis geo only.** Great for fast, ephemeral "nearby drivers" lookups, but not a durable
  store and no polygon/containment support for surge zones. We use it _alongside_ Postgres, not
  instead of it.

## Consequences

- ✅ One durable store for both relational and spatial data; transactional integrity across both.
- ✅ Mature spatial indexing and a huge function library.
- ✅ Surge-zone polygons and geofencing handled natively.
- ⚠️ High-frequency driver location updates must **not** hammer Postgres — they live in Redis,
  with periodic snapshots. This split is a deliberate design point (see Volume 6).
- ⚠️ Team must learn PostGIS query patterns and spatial index tuning.
