# Geo Module

Geo answers geographic questions. It does not decide anything about rides,
drivers or money.

**Owns:** coordinate validation, geographic distance, radius search, nearby-driver
discovery, PostGIS queries, H3 cell generation and neighbour lookup, the spatial
index, geo types and constants.

**Does not own:** driver eligibility or ranking (Matching), ride offers and
assignment (Dispatch), ride lifecycle (Rides), driver identity, availability or
the GPS endpoint (Drivers).

`findNearbyDrivers` returns _who is geographically near and recently seen_. It
deliberately does not filter on verification, suspension, vehicle type or
busy-ness — those are Matching's questions, and answering them here would make
Geo depend on modules it must not know about.

## The three stores

|             | Role                                                                                                                                                                                            | Loss tolerable?                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **PostGIS** | Durable source of truth. Every distance and containment answer comes from `ST_Distance` / `ST_DWithin` on `driver_locations.location`, a `geography(Point,4326)` column backed by a GiST index. | No                                                  |
| **H3**      | Index only. Buckets a coordinate into a cell so a search reads a handful of cells instead of the whole fleet.                                                                                   | Yes — recomputable from any coordinate              |
| **Redis**   | Live state only. A short-TTL mirror of each driver's latest position plus per-cell membership sets, so candidate narrowing does not hit the database.                                           | Yes — PostGIS still answers, just over a wider scan |

**Why PostGIS is the source of truth.** It is the only one of the three that is
durable, transactional and geodesically exact. H3 cells are an approximation by
construction — a cell is a hexagon, not a circle — so a cell hit means "probably
near", never "within 3 km". Redis is a cache with a TTL.

**Why H3 is only indexing.** A cell answers "which bucket" and nothing else.
Cell membership is derived from a coordinate, so it can always be rebuilt and is
never worth trusting over the coordinate itself.

**Why Redis is live state only.** It holds `{lat, lng, h3, at}` per driver and
nothing more — no identity, ride or payment data. If it is flushed, searches
narrow to nothing until drivers ping again; the durable history is untouched.

## Driver → Geo

```
Driver app → POST /api/v1/drivers/location
           → Drivers: authenticate, resolve driverId from the JWT,
                      validate coordinates, plausibility-check the fix
           → DriverLocationRepository  (PostGIS: durable upsert)   ← source of truth
           → GeoService.recordDriverPosition (H3 cell + Redis mirror)
```

Drivers owns the endpoint and the durable write; Geo owns the cell and the live
mirror. A live-store failure is logged inside Geo and does not fail the request —
the durable row is already committed.

Going offline calls `GeoService.forgetDriverPosition` so the driver leaves the
candidate set immediately instead of waiting out the TTL.

## Customer → Geo → Matching

```
Rides → GeoService.findNearbyDrivers({ origin, radiusMeters })
      → H3: pickup cell + the rings covering the radius
      → Redis: driver ids in those cells                (narrow)
      → PostGIS: ST_DWithin + ST_Distance + freshness   (verify, order)
      → candidate drivers → Matching → Dispatch
```

### Result semantics

`findNearbyDrivers` returns a union, not an array, because "the live index is
empty" and "no driver exists" are different facts and a bare `[]` conflates them.

| Outcome              | Meaning                                                                                                                                                                                   | Database hit      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `ok`                 | The live index answered and PostGIS verified it. `drivers` is complete for the radius — an empty list here is authoritative.                                                              | one bounded query |
| `degraded`           | The live index **errored**. PostGIS answered the radius query alone. Still complete, but it cost a wider scan. Logged at `error`, counted in `geo.postgis_fallback_total`.                | one bounded query |
| `no-live-candidates` | The live index is reachable and holds nobody in range. **No query was issued.** Not evidence that no driver exists — the index may have been flushed, or drivers may not have pinged yet. | none              |

A fourth outcome — an invalid request — is thrown rather than returned:
`InvalidCoordinateError`, `InvalidSearchRadiusError`.

Only `ok` and `degraded` carry `drivers`, so the compiler forces a caller to
handle `no-live-candidates` deliberately instead of reading a misleading empty
array.

**Cache emptiness never becomes a database scan.** A flushed Redis would
otherwise turn every ride request into a fleet-wide query at the worst possible
moment. The fallback fires only on an actual Redis _error_, and even then it is
bounded by `ST_DWithin` on the requested radius against the GiST index — never a
full table scan, and never distance arithmetic in JavaScript.

### Metrics

`geo.nearby_requests_total`, `geo.nearby_candidates_total`,
`geo.no_live_candidates_total`, `geo.postgis_fallback_total`,
`geo.redis_errors_total`, `geo.position_recorded_total`,
`geo.position_rejected_stale_total`.

## Configuration

`src/config/geo/geo.config.ts` — `GEO_H3_RESOLUTION` (default 8, ≈530 m edge),
`GEO_SEARCH_RADIUS_M`, `GEO_MAX_SEARCH_RADIUS_M`, `GEO_LIVE_LOCATION_TTL_SEC`,
`GEO_CANDIDATE_STALENESS_SEC`, `GEO_MAX_CANDIDATES`.

The resolution is read from config in one place (`H3Provider.resolution`); it is
not hard-coded at call sites.

## Ordering guarantee

`RedisGeoProvider.setPosition` runs a Lua script that compares the incoming
timestamp against the stored one and writes only if it is newer, then re-points
cell membership in the same atomic step. Out-of-order GPS packets cannot
overwrite a fresher fix, and two concurrent updates for one driver cannot
interleave their read and write.
