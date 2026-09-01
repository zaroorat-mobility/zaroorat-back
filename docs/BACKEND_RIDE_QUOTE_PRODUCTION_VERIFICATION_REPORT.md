# Backend Ride Quote — Production Verification Report

**Scope:** backend only (`backend_zaroorat`). No frontend, no mobile.
**Method:** source read → execution path traced → real server booted → real HTTP calls → Postgres and Redis inspected directly.
**Environment:** `APP_ENV=test`, server on `127.0.0.1:3001`, PostgreSQL 17 + PostGIS and Redis 7 in Docker, 41/41 migrations applied.
**Date:** 2026-08-31 · **Branch:** `admin-folder` @ `6e95c59`
**Code modified:** none. `git status` clean throughout. Test data was created via SQL and admin APIs, and removed afterwards.

**Runtime evidence:** 154 executed assertions across four scripted suites (`f3-quote`, `f4-provider`, `f4-quote-e2e`, `f4-part2`). 148 passed. The 6 failures reduce to **two** root causes.

---

## 1. Executive Summary

The pricing engine is correct. The number it is fed is not.

Every configurable input — base fare, per-km, per-minute, minimum, booking fee, waiting charge, platform fee, tax, commission, surge, zone overrides — is stored in the database, editable through the Admin API, and reaches the customer's next quote immediately. I changed a per-km rate from 6.00 to 99.00 through `PATCH /admin/fare-rules/:id` and the very next customer quote billed `1227.60` for distance (99 × 12.4). Zone pricing, surge windows, vehicle selection, service-area gating, tamper resistance and admin/customer separation all behave correctly under test.

**The defect is upstream of all of it.** `getDirections` in all three map providers returns a hard-coded `12400 m / 1860 s` before making any network call. So the distance and duration that drive the fare are constants. Every journey in the serviceable area — 2 km, 20 km, or pickup and drop at the identical coordinate — is quoted at **12.4 km / 31 min**, and a BIKE costs **₹146.67** in all cases.

Two consequences beyond the wrong number: the response advertises `"distanceSource": "ola"`, so the field that exists to make the fare auditable reports a false provenance; and `ZeroDistanceTripError` is unreachable, so a ride from a point to itself is quoted and billable.

One safety property is genuinely good: when no map provider can be resolved, the quote **fails closed** with `503 ROUTING_PROVIDER_UNAVAILABLE`. There is no silent haversine fallback — that branch is dead code in the running application.

**Verdict: NOT READY.** One defect, one file pattern, three copies.

---

## 2. Customer Creation — PASS

`POST /api/v1/auth/otp/send` → `POST /api/v1/auth/otp/verify` (both `config: { public: true }`; verify additionally **requires** an `Idempotency-Key` header).

Path: `auth.routes.ts` → `AuthController.verifyOtp` → `AuthService.verifyOtp` → `resolveAccount` (creates user, grants `customer`, provisions profile in one transaction) → `SessionService.create` → `TokenService.issuePair`.

Verified in the database for a freshly created customer:

| Check                       | Result             |
| --------------------------- | ------------------ |
| user row created, `status`  | `ACTIVE`           |
| roles granted               | exactly `customer` |
| `is_phone_verified`         | `true`             |
| `user_profiles` row         | 1                  |
| live `user_sessions` rows   | 1                  |
| `otp_verifications.outcome` | `verified`         |

No OTP, token or secret is reproduced in this report.

**Known defect carried from the auth verification:** the first access token issued at registration is invalidated ~1–2 s later, when the outbox delivers `account.role.granted` and `EpochInvalidationConsumer` bumps the auth epoch. The refresh token survives and one refresh yields a stable token. Every script in this report performs that refresh before proceeding.

## 3. Customer Profile — PASS

`GET /users/me` → `PATCH /users/me/profile` → `GET /users/me` round-trips correctly and persists to `user_profiles`. Identity fields (`phoneNumber`, `status`, `roles`, `referralCode`) are refused with `400 IMMUTABLE_FIELD`. Ownership is enforced; cross-account reads and writes return `404`.

## 4. Pickup Verification — PASS

Pickup enters the quote as **two plain numbers**, not an address, place id or entity:

```
POST /api/v1/rides/quote
{ "pickupLat": 12.9716, "pickupLng": 77.5946, "dropLat": …, "dropLng": … }
```

Validation is `quoteFareSchema` (`ride.schemas.ts`), using `latitudeSchema` / `longitudeSchema` from the location module (−90..90, −180..180). There is **no** address, `placeId` or autocomplete field anywhere on the quote contract — and no geocoding endpoint exists in the entire 218-endpoint surface, which is why every client in the workspace calls Nominatim directly.

Pickup coordinates are used for four separate purposes, by four different components:

| Purpose                         | Component                                            |
| ------------------------------- | ---------------------------------------------------- |
| coordinate validation           | `quoteFareSchema` (zod)                              |
| service-area / restriction      | `GeographicCoverageService` → PostGIS `ST_Contains`  |
| road distance and duration      | `MapProviderService` → active provider               |
| zone rate-card and surge lookup | `PricingRuleRepository`, `SurgeRepository` → PostGIS |

The quote itself persists nothing. Coordinates are written to PostGIS only at booking time (`ride_requests.pickup_location`, `geography(Point,4326)`).

## 5. Drop Verification — PASS

Identical handling. `dropLat`/`dropLng` are **required** on the quote — the schema comment records that they were once optional and produced a 500 deeper in.

| Case                      | Result                                 |
| ------------------------- | -------------------------------------- |
| valid pickup + valid drop | `200`                                  |
| latitude 91               | `400 VALIDATION`                       |
| longitude 181             | `400 VALIDATION`                       |
| missing drop              | `400 VALIDATION`                       |
| non-numeric coordinate    | `400 VALIDATION`                       |
| **same pickup and drop**  | **`200` — quoted 12.4 km, ₹146.67** ❌ |

The last row is a consequence of §9, not of validation.

## 6. Service Area Verification — PASS

Implementation: `GeographicCoverageService.resolvePickupContext` and `assertDropServiceable`, both raw PostGIS:

```sql
ST_Contains(boundary::geometry, ST_SetSRID(ST_MakePoint($lng, $lat), 4326))
```

The backend validates **pickup and drop independently**. It does not validate the route between them.

| Test | Pickup     | Drop       | Result                          |
| ---- | ---------- | ---------- | ------------------------------- |
| 1    | inside BLR | inside BLR | `200`                           |
| 2    | Mumbai     | inside BLR | `400 OUTSIDE_SERVICE_AREA`      |
| 3    | inside BLR | Mumbai     | `400 DROP_OUTSIDE_SERVICE_AREA` |
| 4    | Mumbai     | Mumbai     | `400 OUTSIDE_SERVICE_AREA`      |

Distinct codes for the two failures, and pickup is evaluated first.

## 7. Active Map Provider — PASS

```
ACTIVE PROVIDER:      ola
CONFIGURATION SOURCE: system_settings (category 'maps'), cached in Redis at geo:settings:maps (TTL 3600 s)
```

Resolution order in `MapProviderService.resolveProviderChain`: Redis cache → `SystemSettingService.getCategorySettings('maps')` → `process.env.MAP_PROVIDER` → static provider list. Live rows at time of test: `map.primary_provider = ola`, `map.ola.enabled = true`, `map.google.enabled = false`, `map.mappls.enabled = false`. No map environment variables are set in `.env.test`, so the database is the sole authority here.

## 8. Map Provider Routing — FAIL

The call path **is** wired end to end, and the runtime proves it: the quote returns `"distanceSource": "ola"`, a value that can only come from `provider.providerName`.

```
POST /rides/quote
  → RideRequestController.quote
  → RideRequestService.createQuote
  → PricingService.estimateTrip
  → MapProviderService.getDirections   (resolves the chain, picks chain[0])
  → OlaMapsProvider.getDirections      ← returns a constant, never reaches the network
```

**Experiment E1 (decisive).** I set `map.ola.base_url` to `http://127.0.0.1:9/blackhole` (an unroutable port), invalidated the Redis cache, and requested a quote:

```
quote with a dead provider URL: {"status":200,"src":"ola","km":12.4,"min":31}
```

A `200`, the same distance, and the same claimed provider. **No external HTTP request is made.** Restored afterwards.

## 9. Distance Calculation — FAIL

```
AUTHORITATIVE DISTANCE SOURCE: HARDCODED CONSTANT (test stub, production-reachable)
```

### Complete trace of the 12.4 km stub

| Item                      | Value                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Files                     | `src/modules/location/providers/ola-maps.provider.ts:143`, `google-maps.provider.ts:121`, `mappls.provider.ts:104`          |
| Function                  | `getDirections(origin, destination)`                                                                                        |
| Returned                  | `{ distanceMeters: 12400, durationSeconds: 1860, providerName }`                                                            |
| Position                  | first statement — **before** the HTTP call                                                                                  |
| Caller                    | `MapProviderService.getDirections` ← `PricingService.estimateTrip` ← `RideRequestService.createQuote` ← `POST /rides/quote` |
| Test-only?                | **No** — see trigger conditions                                                                                             |
| Production quote uses it? | **Yes, conditionally**                                                                                                      |

```ts
if (
  this.config.apiKey.startsWith('test_') || // NOT environment-gated
  this.config.apiKey.startsWith('mock_') || // NOT environment-gated
  process.env.NODE_ENV === 'test' ||
  process.env.APP_ENV === 'test'
) {
  return { distanceMeters: 12400, durationSeconds: 1860, providerName: this.providerName };
}
```

Two of the four conditions are properties of the **API key**, not the environment. A production deployment whose Ola/Google key begins with `test_` or `mock_` — a sandbox key left in place, a key that simply starts with those characters — prices every journey in the country at 12.4 km, silently, while reporting the real provider's name.

### Runtime evidence

| Requested drop      | Quoted km | BIKE total |
| ------------------- | --------: | ---------: |
| 2 km north          |      12.4 |    ₹146.67 |
| ~20 km north        |      12.4 |    ₹146.67 |
| ~21 km east         |      12.4 |    ₹146.67 |
| identical to pickup |      12.4 |    ₹146.67 |

Commercially this is not a uniform error: short trips are **overcharged** (a 2 km bike ride worth roughly ₹60 is quoted ₹146.67) and long trips are **undercharged** (a 20 km ride worth roughly ₹225 is quoted the same ₹146.67).

## 10. Distance Fallback — PASS

**Experiment E2.** I switched `map.primary_provider` to `mappls`, which has no credentials configured, and invalidated the cache:

```
quote with no usable provider: {"status":503,"code":"ROUTING_PROVIDER_UNAVAILABLE"}
```

The behaviour is **(A) fail the quote**. Not haversine, not another provider, not a hardcoded distance, not null.

`PricingService.estimateTrip` does contain a haversine branch (`roadDistanceFactor 1.3`, `minutesPerKm 3`), but it is guarded by `if (this.mapProviderService)` and `mapProviderService` is unconditionally registered in `registerLocationModule`. The branch is **UNUSED / DEAD CODE** in the running application — `distanceSource` never once reported `haversine` across every quote in this verification, and the string does not appear in the server log.

This is the right design: an inaccurate fallback is never silently used for a customer fare.

## 11. Duration Calculation — FAIL

Same origin as distance: `durationSeconds: 1860` from the same stub, converted by `Math.max(1, Math.round(result.durationSeconds / 60))` = **31 min**, constant for every journey. The configured `minutesPerKm` fallback lives only in the dead haversine branch.

## 12. Vehicle Catalogue — PASS

Source: the `vehicle_types` table, served by `GET /api/v1/vehicle-types` (authenticated, not public). Four active types, matching the database count exactly:

| Code        | Name        | Seats | Active |
| ----------- | ----------- | ----: | ------ |
| BIKE        | Bike        |     1 | ✅     |
| AUTO        | Auto        |     3 | ✅     |
| CAB_ECONOMY | Cab Economy |     4 | ✅     |
| CAB_PREMIUM | Cab Premium |     4 | ✅     |

## 13. Vehicle Selection — PASS

| Case                                       | Result                                   |
| ------------------------------------------ | ---------------------------------------- |
| omit `vehicleTypeId`                       | all active categories priced in one call |
| supply one `vehicleTypeId`                 | exactly that one option                  |
| unknown UUID                               | `404 VEHICLE_TYPE_NOT_FOUND`             |
| non-UUID                                   | `400 VALIDATION`                         |
| **deactivated type, explicitly requested** | `409 VEHICLE_TYPE_INACTIVE`              |
| **deactivated type, multi-category quote** | silently omitted (4 options → 3)         |

## 14. Admin Pricing — PASS

Path: `PATCH /api/v1/admin/fare-rules/:id` → `AdminFareController` → `AdminFareService` → `PricingRuleRepository` → `pricing_rules`.

Admin-configurable columns actually implemented: `base_fare`, `minimum_fare`, `per_km_rate`, `per_minute_rate`, `free_waiting_min`, `waiting_per_min`, `booking_fee`, `platform_fee_pct`, `platform_fee_flat`, `tax_rate_pct`, `commission_rate_pct`, plus scope (`city_code`, `service_zone_id`, `service_type`) and validity (`effective_from`, `effective_to`, `is_active`).

**Updates are immutable-versioned**: a `PATCH` deactivates the current row and inserts a new active one. Verified in the table — three BIKE/GLOBAL rows (6.00 inactive → 99.00 inactive → 6.00 active) with exactly one active at every point.

## 15. Hardcoded Pricing Audit

| Value                                                                              | File                                     | Function          | Source                        | Runtime used?                                          | Hardcoded?           | Result         |
| ---------------------------------------------------------------------------------- | ---------------------------------------- | ----------------- | ----------------------------- | ------------------------------------------------------ | -------------------- | -------------- |
| baseFare, minimumFare, perKm, perMinute, bookingFee, waitingPerMin, freeWaitingMin | `pricing_rules` table                    | `rateCardFor`     | DATABASE / ADMIN              | ✅                                                     | No                   | **PASS**       |
| platformFeePct, platformFeeFlat                                                    | `pricing_rules`                          | `rateCardFor`     | DATABASE / ADMIN              | ✅                                                     | No                   | **PASS**       |
| taxRatePct                                                                         | `pricing_rules.tax_rate_pct`             | `rateCardFor`     | DATABASE / ADMIN              | ✅                                                     | No                   | **PASS**       |
| commissionRatePct                                                                  | `pricing_rules.commission_rate_pct`      | `rateCardFor`     | DATABASE / ADMIN              | ✅                                                     | No                   | **PASS**       |
| tax 5%, platform fee ₹15, commission 20% **fallbacks**                             | `config/pricing/pricing.config.ts:33-45` | `defaultRateCard` | ENV VAR with constant default | ✅ **yes — the seeded rules leave these columns NULL** | Constant default     | **CAVEAT**     |
| MIN/MAX/DEFAULT surge (1.0 / 2.0 / 1.0)                                            | `services/surge.service.ts:11-13`        | clamp             | CONSTANT                      | ✅                                                     | Yes — a safety bound | **ACCEPTABLE** |
| roadDistanceFactor 1.3, minutesPerKm 3                                             | `config/pricing/pricing.config.ts:54-55` | haversine branch  | ENV VAR                       | ❌ unreachable                                         | —                    | **DEAD CODE**  |
| **distanceMeters 12400, durationSeconds 1860**                                     | 3 × `*.provider.ts`                      | `getDirections`   | **HARDCODED**                 | ✅                                                     | **Yes**              | **FAIL**       |

**The rate values are not hardcoded.** The caveat is that the seeded rules leave `tax_rate_pct`, `platform_fee_flat` and `commission_rate_pct` NULL, so three values applied to real customer fares (5% tax, ₹15 fee, 20% commission) came from code defaults rather than admin configuration. That is a fallback working as designed, but an operator editing only the Admin UI cannot see or change those three numbers for these rules.

## 16. Zone / Area Pricing — PASS

Lookup: pickup point → `resolvePickupContext` → containing `service_zones` (smallest polygon wins, `priority` overrides) → `rateCardsForPoint` prefers a rule whose `service_zone_id` matches, else the `city_code` rule, else `GLOBAL`.

Verified with two configured areas:

| Pickup              | Rule applied                | Base fare | BIKE total |
| ------------------- | --------------------------- | --------: | ---------: |
| MG Road (city only) | `BIKE · GLOBAL`             |        20 |    ₹146.67 |
| Airport Zone        | `BIKE · BLR · Airport Zone` |       500 |    ₹650.67 |

Created through the real Admin API (`POST /admin/fare-rules` with `serviceZoneId`), returned `201`, and the next customer quote from inside that polygon used it.

## 17. Surge — PASS

Stored in `surge_windows`: `multiplier`, `service_zone_id` (or legacy `zone_id`), optional `vehicle_type_id`, `starts_at` / `ends_at`, `is_active`, `source`, `reason`, plus `is_peak_hour_only` / `peak_hour_start` / `peak_hour_end` and `demand_threshold_pct` / `supply_threshold_pct`. It is **time-window and zone based**; the demand/supply columns exist but no runtime demand signal feeds them. Clamped to 1.0–2.0 in `SurgeService` and again in `PricingService.price`.

| Scenario                              | Multiplier |                          BIKE total |
| ------------------------------------- | ---------: | ----------------------------------: |
| no window                             |        1.0 |                             ₹650.67 |
| 2.0× window, active, in range         |    **2.0** | **₹1286.34** (surge amount ₹605.40) |
| same window, AUTO                     |        1.0 |                           unchanged |
| same window, pickup outside the zone  |        1.0 |                           unchanged |
| window deactivated                    |        1.0 |                            restored |
| window active but starting in 5 hours |        1.0 |                            restored |

Surge is correctly scoped by zone, vehicle type and time.

## 18. Fare Formula

Extracted verbatim from `PricingService.price` (`pricing.service.ts:195-300`), all arithmetic in `Prisma.Decimal`:

```
distanceFare       = perKm × billableDistanceKm
timeFare           = perMinute × billableDurationMin
waitingCharge      = perWaitingMinute × max(0, waitingMinutes − freeWaitingMin)
subtotalBeforeSurge= baseFare + distanceFare + timeFare + waitingCharge + bookingFee
surgeAmount        = subtotalBeforeSurge × (clamp(surge, 1.0, 2.0) − 1)
subtotal           = subtotalBeforeSurge + surgeAmount
flooredFare        = max(minimumFare, subtotal)          ← floor binds BEFORE discount
discount           = min(max(0, requestedDiscount), flooredFare)
netFare            = flooredFare − discount
taxAmount          = netFare × taxRatePct / 100
platformFee        = platformFeePct > 0 ? netFare × platformFeePct/100 : platformFeeFlat
totalFare          = netFare + taxAmount + platformFee
rideRevenue        = max(0, flooredFare − bookingFee)
driverEarning      = rideRevenue × (100 − commissionRatePct) / 100
platformCommission = totalFare − taxAmount − platformFee − driverEarning   ← residual
```

Component sources: distance and duration ← **hardcoded stub (§9)**; every rate ← `pricing_rules` with env fallback; surge ← `surge_windows`; discount ← `promotions`.

Worked example, BIKE, verified against the live response to the paise:

```
20.00 + (6.00 × 12.4 = 74.40) + (1.00 × 31 = 31.00) = 125.40
tax 125.40 × 5% = 6.27 · platform fee 15.00 (flat fallback)
total = 146.67 ✓
```

## 19. Quote API — PASS (mechanically)

`POST /api/v1/rides/quote`, authenticated (no anonymous price discovery — it does **not** declare `config: { public: true }`).

Response: `pickup`, `drop`, `estimatedDistanceKm`, `estimatedDurationMin`, `distanceSource`, `currency`, `nearbyDriverEtaMin`, `nearbyDriverEtaStatus`, `cityCode`, and `options[]` — each carrying `vehicleTypeId`, `vehicleTypeCode`, `displayName`, `estimatedFare`, `minimumFare`, a full `fareBreakdown`, `promoApplied`, `promoDiscountAmount`.

There is **no quote id, no expiry and no version** in the response. The quote is stateless: `ride_requests` and `ride_fares` row counts were unchanged and no outbox event was emitted. Re-pricing happens at booking.

## 20. Vehicle Fare Comparison

Identical route (12.9716,77.5946 → 13.06,77.5946), one request:

| Vehicle     | Dist km | Dur min | Base | Per KM | Surge |   Tax | Fee |      Total |
| ----------- | ------: | ------: | ---: | -----: | ----: | ----: | --: | ---------: |
| BIKE        |    12.4 |      31 |   20 |   6.00 |     1 |  6.27 |  15 | **146.67** |
| AUTO        |    12.4 |      31 |   30 |   9.00 |     1 |  9.41 |  15 | **212.51** |
| CAB_ECONOMY |    12.4 |      31 |   50 |  12.00 |     1 | 13.04 |  15 | **288.84** |
| CAB_PREMIUM |    12.4 |      31 |   80 |  18.00 |     1 | 19.81 |  15 | **431.01** |

Distance is identical across categories (correct — one journey), and every total is distinct and traceable to its own stored rate card. For all four, `driverEarning + platformCommission + taxAmount + platformFee = totalFare` to the paise.

## 21. Admin Price Change Test — PASS

1. Baseline BIKE `distanceFare` = **74.40** (6.00/km).
2. `PATCH /admin/fare-rules/{id}` with `perKmRate: 99` → `200`, response `version: 2`.
3. Database: new active row at `99.00`, previous row deactivated.
4. Cache: fare rules are read per request; no stale-cache step exists to invalidate.
5. Next customer quote: `distanceFare` = **1227.60** = 99 × 12.4 ✓
6. Restored to `6.00`; verified active row back at `6.00`.

The admin change reaches the customer quote immediately.

## 22. Surge Change Test — PASS

Covered in §17: configured, verified at 2.0×, fare recomputed, restored to 1.0.

## 23. Fare Tampering — PASS

Eight customer-supplied fields, identical route, compared against the clean baseline of ₹146.67:

| Injected                    | Result            |
| --------------------------- | ----------------- |
| `distanceKm: 999`           | ignored — ₹146.67 |
| `estimatedDistanceKm: 999`  | ignored — ₹146.67 |
| `estimatedDurationMin: 999` | ignored — ₹146.67 |
| `baseFare: 1`               | ignored — ₹146.67 |
| `perKmRate: 1`              | ignored — ₹146.67 |
| `surgeMultiplier: 5`        | ignored — ₹146.67 |
| `totalFare: 1`              | ignored — ₹146.67 |
| `discountAmount: 5000`      | ignored — ₹146.67 |

The customer controls **only** the coordinates, the vehicle type and the promo code. Every authoritative value is server-derived.

One weakness in how this is achieved: `quoteFareSchema` is a plain `z.object`, so unknown keys are **stripped silently** rather than rejected — while the users module uses `z.strictObject` and returns `NOT_ALLOWED`. The price is safe, but a client typo (`promocode` for `promoCode`) is discarded with no error, and the customer is quoted the undiscounted fare believing their code applied.

## 24. Redis — PASS (with a security finding)

| Key                                                      | Purpose                                | TTL    | Writer                                    | Reader               | Invalidation                     |
| -------------------------------------------------------- | -------------------------------------- | ------ | ----------------------------------------- | -------------------- | -------------------------------- |
| `geo:settings:maps`                                      | active map provider + keys + base URLs | 3600 s | `MapProviderService.resolveProviderChain` | same                 | admin map-settings update; `DEL` |
| `geo:driver:{driverId}`                                  | driver position                        | config | driver location update                    | nearby-driver search | overwrite / TTL                  |
| `geo:cell:{h3}`                                          | H3 cell membership                     | config | driver location update                    | nearby-driver search | `SREM` on move                   |
| `ratelimit:*`                                            | rate limiting                          | window | rate limiter                              | rate limiter         | TTL                              |
| `otp:*`, `auth:*`, `idem:*`, `lock:*`, `ride:distance:*` | not on the quote path                  | —      | —                                         | —                    | —                                |

**No quote, fare or pricing rule is cached** — confirmed by key scan. Every quote is computed from the database, which is why the admin price change took effect on the next request.

🔴 **Security finding.** `geo:settings:maps` stores the map provider API key **decrypted, in clear text**, for an hour:

```json
{"primaryProvider":"ola","keys":{"olaKey":"new_ola_key_999", …}}
```

The database keeps the same value encrypted (`enc:504e006e…`). Anyone with Redis read access — an operator, a backup, a compromised sidecar — reads the live key directly, defeating the encryption at rest.

## 25. Database Integrity — PASS

| Check                                            | Result |
| ------------------------------------------------ | ------ |
| `ride_requests` created by quoting               | 0      |
| `ride_fares` created by quoting                  | 0      |
| outbox events emitted by quoting                 | 0      |
| duplicate ACTIVE rules per (vehicle, city, zone) | 0      |
| superseded versions retained but inactive        | yes    |
| orphan pricing rules                             | 0      |
| orphan service zones                             | 0      |
| orphan sessions / devices / profiles             | 0      |

## 26. Security — PASS

All seven admin endpoints tested return `403 FORBIDDEN` to a customer token: `/admin/fare-rules`, `/admin/surge-windows`, `/admin/service-zones`, `/admin/settings/maps`, `/admin/riders`, `/admin/drivers`, `/admin/users`. A customer attempting `POST /admin/fare-rules` and `POST /admin/surge-windows` is refused, and **no row reached either table**. Authorization is deny-by-default: a global `onRequest` hook authenticates every route unless it declares `config: { public: true }`.

## 27. Runtime Evidence

| Suite                                                                   | Assertions |  Passed | Failed |
| ----------------------------------------------------------------------- | ---------: | ------: | -----: |
| `f3-quote` — catalogue, quote, arithmetic, coverage, promo              |         50 |      45 |      5 |
| `f4-provider` — active provider, E1/E2 experiments                      |          4 |       4 |      0 |
| `f4-quote-e2e` — customer, service area, vehicles, admin pricing, zones |         63 |      62 |      1 |
| `f4-part2` — surge, tampering, consistency, security, integrity, Redis  |         37 |      37 |      0 |
| **Total**                                                               |    **154** | **148** |  **6** |

The 6 failures are: 4 × distance/duration constant (§9, §11), 1 × zero-distance quote accepted (§5, same cause), 1 × unknown fields silently stripped (§23). The single failure in `f4-quote-e2e` was my own assertion reading a superseded rule row; the underlying behaviour is correct and is reported as PASS in §21.

## 28. Problems Found

| #       | Severity  | Finding                                                                                                                                                                                                                                                                                 |
| ------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q-1** | 🔴 **P0** | `getDirections` returns a hardcoded 12 400 m / 1 860 s in all three providers. Every quote is 12.4 km / 31 min regardless of the journey. Two of its four trigger conditions (`apiKey.startsWith('test_')`, `'mock_'`) are **not environment-gated**, so it is reachable in production. |
| **Q-2** | 🔴 **P0** | Consequence of Q-1: `ZeroDistanceTripError` is unreachable. A ride from a point to itself is quoted and billable at ₹146.67.                                                                                                                                                            |
| **Q-3** | 🟠 **P1** | The response reports `"distanceSource": "ola"` for a value that never came from Ola. The provenance field that makes fares auditable is false.                                                                                                                                          |
| **Q-4** | 🟠 **P1** | The decrypted map provider API key is cached in Redis in clear text for 1 hour while the database stores it encrypted.                                                                                                                                                                  |
| **Q-5** | 🟡 **P2** | `quoteFareSchema` silently strips unknown fields instead of rejecting them (`z.object`, not `z.strictObject`), so a mistyped `promoCode` is discarded with no error.                                                                                                                    |
| **Q-6** | 🟡 **P2** | Seeded pricing rules leave `tax_rate_pct`, `platform_fee_flat` and `commission_rate_pct` NULL, so 5% tax, ₹15 fee and 20% commission come from code defaults and are invisible to an operator using the Admin UI.                                                                       |
| **Q-7** | 🔵 **P3** | The haversine branch in `PricingService.estimateTrip` is unreachable dead code (`mapProviderService` is always registered). Harmless, but it advertises a fallback that does not exist.                                                                                                 |

**The fix for Q-1, Q-2 and Q-3 is one change in three files:** gate the stub on `APP_ENV === 'test'` alone, and make it a function of the coordinates so distance-sensitive tests are meaningful.

## 29. Production Readiness

The pricing system is well built — Decimal arithmetic, database-driven configuration, immutable rule versioning, correct zone and surge scoping, a fare split that balances by construction, tamper-proof inputs, and a fail-closed routing policy. Everything downstream of the distance is ready.

It cannot go to production while the distance itself is a constant. This is not a design problem; it is a test stub sitting in a production code path with two triggers that do not check the environment.

---

# FINAL VERDICT

```
Customer Creation:              PASS
Profile:                        PASS
Pickup:                         PASS
Drop:                           PASS
Coordinate Validation:          PASS
Service Area:                   PASS
Active Map Provider:            PASS   (ola, from system_settings + Redis)
Provider Routing:               FAIL   (path wired, external call never made)
Road Distance:                  FAIL   (hardcoded 12 400 m)
Distance Fallback:              PASS   (fails closed at 503, no silent haversine)
Duration:                       FAIL   (hardcoded 1 860 s)
Vehicle Catalogue:              PASS
Vehicle Selection:              PASS
Admin Pricing:                  PASS
No Hardcoded Pricing:           PASS   (rates are DB/admin-driven; see caveat Q-6)
Zone Pricing:                   PASS
Surge:                          PASS
Fare Calculation:               PASS
Fare Tampering Protection:      PASS
Redis:                          PASS   (with security finding Q-4)
Database Integrity:             PASS
Security:                       PASS
Runtime Quote:                  PASS   (mechanically correct, numerically wrong)
Full E2E:                       ISSUES FOUND

Overall Backend Ride Quote Logic:   ISSUES FOUND
Production Readiness:               NOT READY
```

**Blocking for production:** Q-1, Q-2, Q-3 (one root cause), and Q-4.

---

_Coordinate order was verified independently across all 11 `ST_MakePoint` call sites — every one passes `(longitude, latitude)` with SRID 4326, correct for PostGIS. Ola and Google receive `lat,lng`; Mappls receives `lng,lat`, each correct for that vendor's API. Confirmed empirically: a stored saved place reads back as `POINT(77.5946 12.9716)` and the Bengaluru containment test returns true for the MG Road point._
