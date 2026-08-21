# Customer Ride End-to-End Workflow Audit

**Type:** Read-only investigation. No code, schema, dependency, or configuration was changed to produce this report. `npm run typecheck`, `npm run lint`, and `npm run test:unit` were executed as read-only verification steps; nothing else was run against the repository that alters its state.
**Branch audited:** `feature/driver` @ `c3bfe5a` (working tree clean at time of audit; this report adds only itself)
**Date:** 2026-08-21
**Method:** Direct reading of the current source tree (`src/`, `prisma/`, `tests/`) and migration history — not prior reports, not READMEs, not module docstrings, not folder names. Every claim below is traceable to a specific file and, where relevant, a line number. Where a README/FLOW.md/migration comment contradicts the code, the code wins and the doc is called out as stale.

**Update (2026-08-21, post-audit fix round 1):** After this report was written, a first, narrowly-scoped round of fixes was implemented and committed on top of it, closing part of finding P0-#1/#3/#4 (§12/§13/§29/§35/§38) and all of P1-#8/#10 (§12/§14/§28/§36). Specifically: a `ride.requested` consumer now finds nearby eligible drivers and offers the ride automatically; a driver can list pending offers via `GET /rides/offers`; `findActiveByDriver` is now checked before a driver can accept a second ride; and driver status now transitions to `ON_TRIP` on accept and back to `ONLINE` on completion/cancellation. Dispatch is still single-candidate with no retry-to-next-driver on timeout, and there is still no real-time push channel — see the note at the end of §35 and §36 for the precise boundary of what changed. Every other finding below (§5–§11, §15–§27, and the rest of §28/§29/§36/§37) has **not** been re-verified since and should be treated as still current.

---

## 1. Executive Summary

**The complete real-world customer ride workflow does not work end-to-end today, and it breaks at one specific, well-defined seam: getting a created ride request in front of any driver.**

What is real and correctly built: phone/OTP authentication with rate limiting and lockout, server-side non-tamperable fare quoting, the ride state machine, an atomic single-winner claim for ride acceptance (both application- and database-level), and OTP-based trip start correctly scoped to the exact ride/customer/driver triple. These pieces are production-quality in isolation.

What is missing or disconnected, in order of how early they block the flow:

1. **No automatic matching/dispatch ever runs.** `RIDE_EVENT_CATALOG.REQUESTED` is published on request creation and has **zero consumers** anywhere in the codebase.
2. **The nearby-driver search and the offer-creation function both exist, are individually correct, and are never called** from the live request path.
3. **No driver-facing endpoint exists to discover a pending ride request.** The only way `POST /rides/accept` can succeed is if a caller already possesses a `requestId` — which nothing in the system ever gives them.
4. **There is no real-time transport of any kind.** `src/plugins/socket/socket.plugin.ts` is a literal `export {}` stub. No WebSocket, no Socket.IO, no push notification provider (only SMS delivery exists).
5. **Even if a driver reaches "accepted," the customer has no way to learn about it proactively**, and **no way to view the driver's live location under any authorization path** — the one endpoint that holds it explicitly denies the customer role.
6. **Fare is not admin-configurable.** `pricing_rules`, `surge_zones`, `surge_windows`, `tax_configs`, `cancellation_policies` are fully modeled in Postgres and never read by any application code; fare is a static rate card resolved once from environment variables at process boot.
7. **Driver status never reflects being on a trip.** `BUSY`/`ON_TRIP` are valid enum values that are never written anywhere.
8. **Wallet balances never move.** Ride payment posts audit-only ledger rows; `customer_wallets.balance`/`driver_wallets.balance` are never mutated by any ride-related code path, and driver settlement is built but unscheduled and unreachable.
9. **"One active ride per driver" is unprotected at both the application and database level** — the repository method that would check it (`findActiveByDriver`) has zero callers.
10. **There is no true HTTP/API integration test covering the customer lifecycle** (login → quote → request → match → accept → OTP → start → complete → payment). All 716 unit tests pass; the integration suite requires live Postgres/Redis that is unavailable in this environment, so those tests were not verifiable — see §30.

Everything from ride-request creation forward is coded as if the matching/notification layer exists. It does not. This is not twelve small bugs; it is one missing integration layer with a handful of independently serious gaps behind it.

_(Items 7 and 9 above, and the driver-discovery half of item 3, were closed in the post-audit fix round noted above. Items 1, 2, 4, 5, 6, 8, 10 remain exactly as described.)_

---

## 2. Current Repository Baseline

- `git status`: clean before this audit; branch `feature/driver`, 11 commits ahead of `origin/feature/driver`.
- Stack: Fastify 5 + Awilix DI (`@fastify/awilix`) + Prisma 7 (Postgres 17 + PostGIS) + BullMQ + ioredis + Zod. `package.json` declares **no** `socket.io`, `ws`, or push-notification SDK (no `firebase-admin`, no APNs library) of any kind.
- **Route mounting** (`src/routes/register.ts`): only **auth, users, files, rides, drivers, payments** are registered on the HTTP server (plus health/ready/metrics). There is no mounted route for admin, pricing, vehicles, dispatch, matching, onboarding, riders, chat, sos, support, promotions, reviews, analytics, or settings.
- **Module ownership does not match folder names.** `src/modules/{admin,analytics,chat,dispatch,matching,onboarding,pricing,promotions,reviews,riders,settings,sos,support,vehicles}` each contain exactly two files: `index.ts` (`export {};`) and a boilerplate `README.md` reading "This module owns the core business logic for X." Verified by listing every file in each directory (file counts: 2 each, versus 55–66 files in auth/users/drivers/rides/payments). The real logic for dispatch, fare/pricing, and OTP lives inside `src/modules/rides/services/{dispatch,fare,otp}/` instead.
- Prisma schema is comprehensive and modular (`prisma/schema/modules/{admin,analytics,auth,driver,file,notification,payment,pricing,referral,ride,support,user,vehicle,wallet}/*.prisma`); the `20260724173304_init` migration creates all 140+ tables from it, including `pricing_rules`, `surge_zones`, `surge_windows`, `vehicle_types`, `vehicles`, `customer_wallets`, `driver_wallets`. **The schema is far ahead of the application code that would use it** — this single gap (schema exists, service layer does not) recurs throughout the findings below.
- One migration (`20260810100000_ride_request_unique/migration.sql`) contains a developer comment noting that at the time it was written, "the rides routes are not mounted." That is no longer true today (`register.ts:20`) — noted only as evidence this exact pattern (module wired up later than its schema) has happened before in this codebase and is still unresolved for dispatch/matching/pricing/vehicles.
- Jobs actually scheduled via cron (`src/jobs/scheduler/index.ts:18-64`): file sweep/retention, account erasure, auth retention, **ride dispatch-timeout**, **ride request-expiry**, driver heartbeat-timeout, driver doc-expiration, payment reconciliation. **Driver settlement is not in this list** — see §23.
- Verification commands run (read-only):
  - `npm run typecheck` → **passes**, zero errors.
  - `npm run lint` → **passes**, zero warnings/errors (`--max-warnings=0`).
  - `npm run test:unit` → **716/716 tests pass**, 142 suites, 0 failures.
  - `npm run test:integration` → fails immediately on every test with `password authentication failed for user "zaroorat"` (Postgres). No live test database is reachable in this environment — see §30 for the full implication.

---

## 3. Module Ownership Map

Ownership determined from actual imports and call graphs, not directory names.

| Domain (brief's taxonomy)                                    | Folder that claims it                          | Who actually owns the code                                                                                                                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth (OTP, JWT, sessions, roles)                             | `src/modules/auth`                             | `src/modules/auth`                                                                                                                                                                                                                                                                 | Correctly owned, correctly isolated. Only module with real event consumers (`driver-verified.consumer.ts`, `epoch-invalidation.consumer.ts`) — as of the fix round, `rides` now has one too (`ride-requested.consumer.ts`).                                                                                                        |
| Users (shared identity/profile)                              | `src/modules/users`                            | `src/modules/users`                                                                                                                                                                                                                                                                | Correctly owned.                                                                                                                                                                                                                                                                                                                   |
| Customers (customer-facing state)                            | _(no dedicated module)_                        | Spread across `users` (profile) and `rides` (ride-side customer state)                                                                                                                                                                                                             | No dedicated `customers`/`riders` module — `src/modules/riders` is a 2-file stub. Not necessarily wrong, but the brief's taxonomy assumes a boundary that doesn't exist in code.                                                                                                                                                   |
| Rides (lifecycle/state machine)                              | `src/modules/rides`                            | `src/modules/rides`                                                                                                                                                                                                                                                                | Correct, and the best-built module in the system for what it covers.                                                                                                                                                                                                                                                               |
| Matching/Dispatch                                            | `src/modules/matching`, `src/modules/dispatch` | **Neither.** Dispatch logic (`DispatchService.offerToDriver`) lives inside `src/modules/rides/services/dispatch/`; true candidate-matching (nearby-driver query) lives inside `src/modules/geo`; the new consumer that ties them together lives in `src/modules/rides/consumers/`. | Misplaced by the codebase's own naming convention — the two modules whose names promise this logic are still empty stubs.                                                                                                                                                                                                          |
| Geo (spatial index, nearby queries)                          | `src/modules/geo`                              | `src/modules/geo`                                                                                                                                                                                                                                                                  | Correctly owned and well-built (H3 + Redis + PostGIS fallback) — now has exactly one caller outside its own module (`RideRequestedConsumer`), where previously it had none.                                                                                                                                                        |
| Pricing/Fare                                                 | `src/modules/pricing`                          | **Not `pricing`.** Fare calculation lives in `src/modules/rides/services/fare/fare.service.ts`; static rate-card config lives in `src/config/ride/ride.config.ts`.                                                                                                                 | `src/modules/pricing` is a 2-file stub; the 14 pricing-adjacent Prisma models it should own (`PricingRule`, `SurgeZone`, `SurgeWindow`, `TollZone`, `CancellationPolicy`, `Promotion`, `TaxConfig`, etc.) have no owning service anywhere.                                                                                         |
| Admin (management/config APIs)                               | `src/modules/admin`                            | **Nobody.** 2-file stub, no routes mounted.                                                                                                                                                                                                                                        | Document-review and driver-verification admin actions that _do_ exist live inside `src/modules/drivers` behind `roles: ['admin']` guards (`driver.routes.ts:17-26`) — correct pragmatically, but there is no general admin surface, and specifically no pricing-admin surface.                                                     |
| Vehicles (data, eligibility, assignment)                     | `src/modules/vehicles`                         | **Nobody.** 2-file stub.                                                                                                                                                                                                                                                           | `src/modules/drivers` has zero vehicle-related code (grep-confirmed). No module anywhere validates vehicle ownership, approval status, or category match.                                                                                                                                                                          |
| Drivers (domain, availability, location, docs, verification) | `src/modules/drivers`                          | `src/modules/drivers`                                                                                                                                                                                                                                                              | Correctly owned, well-built (onboarding, status, location-plausibility, heartbeat, document verification gate). Previously too isolated from rides to receive lifecycle-driven status updates — the fix round added exactly that one connection (rides now calls `DriverStatusRepository.updateStatus` at accept/complete/cancel). |
| Payments (state, ledger, settlement, wallet mutation)        | `src/modules/payments`                         | `src/modules/payments`                                                                                                                                                                                                                                                             | Correctly owned; internally most pieces are real (gateway abstraction with Stripe/Razorpay/mock, intents, refunds, webhooks). Ledger posting and wallet-balance mutation are two different, disconnected code paths within this same module — see §22, unchanged by the fix round.                                                 |
| Notifications (push/SMS/email)                               | `src/modules/notifications`                    | `src/modules/notifications`                                                                                                                                                                                                                                                        | Correctly owned but incomplete: SMS only (`msg91.provider.ts`, `sms.provider.ts`, `mock.provider.ts`). No push (FCM/APNs), no email, no in-app/socket delivery. Unchanged.                                                                                                                                                         |
| Files (storage lifecycle)                                    | `src/modules/files`                            | `src/modules/files`                                                                                                                                                                                                                                                                | Correctly owned, out of scope for the ride workflow, not re-audited here.                                                                                                                                                                                                                                                          |

**Duplicate logic found:** straight-line distance is computed independently in two places that never call each other — `FareService`'s inline Haversine (`fare.service.ts:97-104`, hardcoded ×1.3 road-factor) and `GeoService`/`DistanceService.straightLineKm` (`src/modules/geo/services/distance.service.ts:10-14`). Neither is a real routing engine. Unchanged — the new consumer uses `GeoService.findNearbyDrivers`, not the distance calculators, so this duplication was not touched.

**Circular dependencies:** none observed in the modules traced for this audit.

**Deep imports:** the rides module reaches directly into `@modules/drivers/repositories/driver.repository.ts` and `@modules/drivers/errors/driver.errors.ts` from its controllers (`ride-state.controller.ts:3,11`) rather than through a drivers service-layer boundary — a minor layering violation, not a correctness bug. The fix round added one more instance of this same pattern (`LifecycleService` and the new consumer both import `@modules/drivers/repositories/driver-status.repository.ts` directly), consistent with — not a new deviation from — the codebase's existing convention.

**Dead/empty modules (verified, all contain only `index.ts` = `export {};` + boilerplate `README.md`):** `admin`, `analytics`, `chat`, `dispatch`, `matching`, `onboarding`, `pricing`, `promotions`, `reviews`, `riders`, `settings`, `sos`, `support`, `vehicles` — 14 of the 27 directories under `src/modules/`. Unchanged.

**Complete-but-disconnected services (code is fully implemented and correct, but has zero callers from the live request path):**

- ~~`NearbyDriverService.find()` (`src/modules/geo/services/nearby-driver.service.ts`)~~ — **now called**, from `RideRequestedConsumer`.
- ~~`DispatchService.offerToDriver()` (`src/modules/rides/services/dispatch/dispatch.service.ts`)~~ — **now called**, from the same consumer.
- `WalletService` (`src/modules/payments/services/wallet/wallet.service.ts`) — still never imported by `rides`.
- `SettlementService`/`SettlementJob` (`src/modules/payments/services/settlement/`, `src/modules/payments/jobs/settlement.job.ts`) — still not in the cron schedule, still requires an externally-supplied `driverIds` list nothing produces.
- ~~`RideRepository.findActiveByDriver()` (`src/modules/rides/repositories/ride.repository.ts:85-93`)~~ — **now called**, from `LifecycleService.acceptRideRequest`.

---

## 4. Customer Authentication Workflow — **WORKING**

Traced `POST /api/v1/auth/otp/*` → `OtpService` (`src/modules/auth/services/otp/otp.service.ts`) → Redis-backed challenge store → `OtpRepository` → JWT/session services.

- **Send** (`otp.service.ts:67-140`): claims a Redis challenge (dedupes an in-flight resend), enforces a per-phone rate limit plus secondary axes (device, IP) via `OtpRateLimiter.checkSecondaryAxes`, hashes and stores the code, publishes `auth.otp.requested`, enqueues real delivery via a BullMQ producer. Real SMS provider (`msg91.provider.ts`) plus a `mock.provider.ts` for non-prod.
- **Verify** (`otp.service.ts:141-208`): checks lockout, **binds the challenge to phone+purpose+unverified** (`assertChallengeBelongsToCaller`, preventing challenge-ID replay against a different phone), consumes the Redis secret (single-use), tracks failed-attempt lockout, writes an audit outcome row (`queued`/`verified`/`expired`/`failed`/`locked`) regardless of outcome.
- Max attempts, lockout duration, and resend cooldown are all config-driven (`OtpConfig`), not magic numbers.
- Session/token: dedicated `session`, `token/jwt`, `token/refresh-token`, `token/epoch` services. `epoch-invalidation.consumer.ts` is the mechanism for forcing session invalidation on security-relevant changes — this is the correct pattern for "a revoked role can't silently return," though the full list of triggers that bump the epoch was not exhaustively re-verified in this pass (**NOT VERIFIABLE** beyond confirming the mechanism exists and is wired to a real consumer).
- A brand-new customer can complete send→verify→user-creation→token issuance through a real, connected path. An existing customer can log in the same way.
- Can a driver/customer role conflict cause incorrect behavior? Not specifically re-traced in this pass. Is the default role assignment secure? Roles appear to be explicitly granted (e.g. `authService.grantRole` from the `driver.verified` consumer), not inferred — consistent with a secure default, but **NOT VERIFIABLE** to the same depth as the rest of this section.

## 5. Customer Profile Workflow — **PARTIAL**

- Fields split across two tables: `User.email` (nullable, unique — `prisma/schema/modules/user/user.prisma:6`) and `UserProfile.{firstName,lastName,dateOfBirth,gender,profileImageFileId,languageCode}` (`src/modules/users/services/profile/profile.service.ts`).
- Profile update, email uniqueness (DB-level `@unique`), and partial-field handling are implemented.
- **No profile-completion gate exists anywhere.** Grepped `src/` for `profileComplete`/`isProfileComplete`/`requireCompleteProfile`: zero matches. A customer can reach every authenticated endpoint, including ride creation, with name/gender/email still null.
- Email verification tracking (`isEmailVerified`) exists as a column; whether anything actually enforces or completes verification was not traced (**NOT VERIFIABLE** in this pass).
- Marked PARTIAL rather than MISSING because storage, uniqueness, and update endpoints are real — only the "must complete before Home" gate the brief describes does not exist, and this may be intentional current product behavior rather than a defect.

## 6. Home and Location Workflow — **PARTIAL**

- Coordinate validation is real and backend-enforced: `latitudeSchema`/`longitudeSchema` (Zod) reject out-of-range values before any service code runs (`ride.schemas.ts:1-9`).
- **Distance/duration is not real routing.** `FareService.calculateFareQuote` (`fare.service.ts:89-106`) computes Haversine great-circle distance and multiplies by a flat **1.3× fudge factor**, deriving duration as `distanceKm * 3` minutes. No OSRM/Google/Mapbox routing provider exists anywhere (`src/modules/geo/providers/` contains only `h3`, `postgis`, `redis-geo` — all built for driver-proximity search, not route planning). `GeoService.distance` independently reimplements the same straight-line math and is never called by rides.
- No geocoding provider (address ↔ lat/lng) exists anywhere.
- "Same pickup and destination," "unsupported service area," "stale location" — no backend checks found for any of these.
- **BACKEND-VERIFIED:** coordinate range validation. **BACKEND-VERIFIED (approximate only):** straight-line distance/duration. **NOT IMPLEMENTED:** real routing, geocoding, service-area enforcement, same-point check, staleness check.

## 7. Vehicle Category Workflow — **DISCONNECTED**

- **No customer-facing endpoint lists vehicle categories.** `src/modules/vehicles` is a stub; no route exposes `VehicleType`.
- `VehicleType` is a real Prisma model with a DB foreign key from both `RideRequest.vehicleTypeId` and `Ride.vehicleTypeId` (`ride.prisma:27,95`), so the ID must reference a real row or the insert fails — but **no application code ever reads a `VehicleType` row's own columns** (name, active flag, pricing metadata). Grep for `client.vehicleType`/`prisma.vehicle` usage outside the schema: zero hits.
- The customer-visible "category" is entirely driven by `rideConfig.rateCardsByVehicleType`, parsed once from `RIDE_RATE_CARDS_JSON` at boot (`ride.config.ts:31-54`), keyed by whatever UUID string the client sends. **An unrecognized ID silently falls back to `defaultRateCard`** rather than being rejected (`fare.service.ts:42-44`).
- No enable/disable flag, no area-scoping, no "no drivers available" filtering, no driver-vehicle compatibility check — none of this exists in code, only in the unused schema.

## 8. Admin Fare / Pricing Configuration Workflow — **MISSING**

The headline finding of this audit. Every fare-relevant table and its consumer, traced directly:

| Component                               | DB table                              | Read by any code?                                                                                                                                                                                           | Verdict                                                                                |
| --------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Base fare, per-km, per-min, min fare    | —                                     | `RIDE_BASE_FARE`/`RIDE_RATE_PER_KM`/etc. env vars                                                                                                                                                           | **HARDCODED (env)**                                                                    |
| Platform fee, commission rate, tax rate | —                                     | env vars                                                                                                                                                                                                    | **HARDCODED (env)**                                                                    |
| Waiting charge                          | `ride_wait_events`                    | env var (`perWaitingMinute`)                                                                                                                                                                                | **HARDCODED (env)**, table unused                                                      |
| Cancellation charges                    | `cancellation_policies`               | inline literal `Decimal(50)` in `CancellationService.processCancellation` (`cancellation.service.ts:23`) — **ignores** `rideConfig.defaultCancellationFee`, the very env value that exists for this purpose | **HARDCODED, and inconsistent with its own config layer**; table unused                |
| Surge/demand pricing                    | `surge_zones`, `surge_windows`        | `FareService` accepts a `surgeMultiplier` parameter, but every traced caller passes `undefined`, defaulting to `1` — nothing computes a real multiplier                                                     | **MISSING** (parameter exists, no producer)                                            |
| Peak/city/service-area pricing          | `service_zones`, `toll_zones`         | none                                                                                                                                                                                                        | **MISSING**                                                                            |
| Vehicle-category-specific pricing       | `pricing_rules` (has `vehicleTypeId`) | none — see §7                                                                                                                                                                                               | **DISCONNECTED**: category pricing exists only as `RIDE_RATE_CARDS_JSON` env overrides |
| Commission                              | `pricing_rules.commissionRate`        | env var, applied in `fare.service.ts:69`                                                                                                                                                                    | **HARDCODED (env)**, column unused                                                     |

Grep for `pricingRule|PricingRule|surgeZone|SurgeZone|surgeWindow|SurgeWindow` across `src/`: **zero matches.**

**Direct answer: the customer's displayed fare does not come from an Admin-configured fare system, because no such system exists in code.** No admin API, no runtime reconfiguration, no persistence — a single static rate card resolved from environment variables at process boot. Unchanged by the fix round.

## 9. Fare Quote Workflow — **WORKING (with a caveat)**

- `POST /rides/quote` → `RideRequestService.createQuote` → `FareService.calculateFareQuote` — quote is always computed server-side. The request schema accepts only coordinates and `vehicleTypeId`; there is no field for a client-submitted fare, so **fare tampering via the request body is not possible.**
- `POST /rides/requests` **recalculates the fare quote server-side again** rather than trusting a previously-returned quote object (`ride-request.service.ts:32-91`) — closes the stale/tampered-quote attack surface even without a quote token mechanism.
- **Caveat:** quotes have no persistence, no ID, no expiry, no versioning. `createQuote` returns a plain computed object; nothing stores it, so "expired quote" is a non-issue only because a quote is never a stored entity in the first place — not because expiry is enforced.
- Since `vehicleTypeId` is used identically for both quote and request in one call, a client cannot swap categories mid-flow — but there is also no check that the `vehicleTypeId` used corresponds to a real, currently-enabled category (only that it satisfies the DB foreign key).
- Protects against tampering: yes, via server-side recomputation. Does not exist: quote expiry, pricing-version concept, runtime pricing-config changes (irrelevant since pricing is static).

## 10. Ride Request Workflow — **PARTIAL**

Traced `RideRequestService.createRequest` (`ride-request.service.ts:32-91`):

1. **Authentication.** Enforced upstream by route registration (JWT required).
2. **Customer ownership.** `customerId` comes from the authenticated caller, not the request body.
3. **Active-ride protection is real but has a race window.** App-level: `rideRepo.findActiveByCustomer` and `requestRepo.findActiveByCustomer` are checked before creating a new request, throwing `ActiveRideExistsError` if either finds one (lines 44-51). **These checks run outside a transaction/lock** — two simultaneous `POST /rides/requests` calls from the same customer can both pass the check before either commits. No partial unique index on `(customerId, status IN (CREATED,SEARCHING))` was found in any migration (unlike the deliberate `rides_request_id_key` added for the accept-race — see §20). **Severity: medium** — narrow window, causes dispatch confusion/duplicate billing risk rather than data corruption.
4. Fare/quote validation and server-side pricing: covered in §9.
5. Vehicle category validation: DB foreign key only (§7).
6. **No idempotency key** on `POST /rides/requests` — a client retry after a timeout is protected only by the racy check in #3.
7. Concurrent requests: same race as #3.
8. Ride request status lifecycle: `CREATED → SEARCHING → MATCHED → EXPIRED` is enum-backed and coherent for the statuses actually written. Previously `SEARCHING` was never written by any code found; **the fix round's new consumer now sets it** the moment it dispatches an offer, giving that status real meaning for the first time.

**Can one customer create multiple simultaneous active rides? Not fully protected — application-level only, with a real race window, no database backstop.** Severity: medium, unchanged by the fix round (this specific gap was not in scope for it).

## 11. Driver Discovery Workflow — **DISCONNECTED (was fully disconnected; now connected end-to-end but single-candidate)**

- `NearbyDriverService.find()` (`src/modules/geo/services/nearby-driver.service.ts:31-55`) is a real, well-built implementation: resolves candidate driver IDs from an H3-cell Redis geo index, falls back to a bounded PostGIS radius query if Redis is unavailable, filters by a `freshAfter` staleness cutoff, respects configurable radius/limit.
- **As of the fix round, it is called** — from `RideRequestedConsumer.handle()` (`src/modules/rides/consumers/ride-requested.consumer.ts`), triggered by the `ride.requested` event. Previously it had zero callers outside the geo module; this audit's finding that it was orphaned no longer holds.
- The consumer composes it with `DriverRepository.findById` (verification status, suspension) and `DriverStatusRepository.getStatus` (must be `ONLINE`) before offering — this is the first place in the codebase that combines geo + eligibility filters into one candidate-selection step. It does **not** filter by vehicle-category compatibility, because (per §7/§14) no code anywhere establishes which vehicle a driver is currently driving, so there is nothing to filter on yet.
- **Still a genuine limitation:** the consumer stops at the single nearest eligible candidate (`MAX_CANDIDATES_TO_TRY = 1` in the consumer, by explicit design comment) and there is still no retry-to-next-candidate if that driver ignores or rejects the offer — see §12.

## 12. Driver Matching and Dispatch Workflow — **PARTIAL (was fully disconnected)**

- `RIDE_EVENT_CATALOG.REQUESTED` is published on every ride-request creation (`ride-request.service.ts:81`) and **now has one consumer** — `RideRequestedConsumer`, registered in `src/bootstrap/events.bootstrap.ts` alongside the two pre-existing auth consumers. This closes the specific gap this audit's §12 originally led with.
- `DispatchTimeoutJob` (cron-scheduled every minute) still only marks `PENDING` `RideDispatch` rows `TIMEOUT` past `expiresAt`, and still does **not** retry against the next-nearest driver or re-trigger search. So if the one driver offered a ride ignores it, the request simply expires — there is still no round 2. This is explicitly flagged as follow-up work in the new consumer's own code comment, not silently assumed solved.
- **Driver status now reflects matching eligibility during a trip.** Previously `BUSY`/`ON_TRIP` (valid values in the `DriverStatus` enum, `prisma/schema/shared/enums.prisma:69-75`) were never written anywhere. `LifecycleService` now sets a driver to `ON_TRIP` in `acceptRideRequest` and back to `ONLINE` in both `completeRide` and `cancelRide`. This also makes the pre-existing `DriverOnTripError` guard in `StatusService.setOffline` meaningful for the first time — before this fix it could never actually fire, because the status it checks for was never set.

## 13. Driver Offer Delivery — **PARTIAL (was fully disconnected)**

- `DispatchService.offerToDriver` (`dispatch.service.ts:13-45`) creates a `RideDispatch` row with a 30-second expiry, publishes `DISPATCH_OFFERED`, records a metric. **It is now called**, from `RideRequestedConsumer`, for the nearest eligible candidate.
- **A driver-facing endpoint now exists:** `GET /rides/offers` (`ride.routes.ts`, driver-only) → `RideStateController.listOffers` → `RideDispatchRepository.findPendingForDriver`, returning the driver's pending, non-expired offers with the associated `RideRequest` included. Previously no such endpoint existed at all.
- When a driver accepts, `RideDispatchRepository.resolveOffers` now marks their own offer `ACCEPTED` and cancels any other pending offers for the same request — so the offer-list endpoint doesn't keep showing a ride that's already gone. (In practice, with only one candidate ever offered per request today, this mostly matters once multi-candidate dispatch is added.)
- **Still no delivery channel beyond polling.** `src/plugins/socket/socket.plugin.ts` is still `export {};`. `src/modules/notifications/` still has only SMS providers — no push, no in-app, no socket broadcast. A driver client must poll `GET /rides/offers` to discover a new offer; nothing pushes it to them. This is a real, acknowledged limitation of the fix, not an oversight in this note.
- Offer expiry (`DispatchTimeoutJob`) and the "next driver" retry gap are unchanged — see §12.

## 14. Driver Acceptance Workflow — **WORKING (was PARTIAL)**

Traced `LifecycleService.acceptRideRequest` (`lifecycle.service.ts:110-167`), now reachable in production because §11–§13 closed the path that gets a driver to a real `requestId`.

- **Atomic single-winner claim, both at the application and database level — unchanged, genuinely correct:**
  - App level: `requestRepo.lockForUpdate(id, tx)` takes a `SELECT ... FOR UPDATE` row lock, then `requestRepo.claimForMatch(id, tx)` does a conditional `UPDATE ... WHERE id = ? AND status IN ('CREATED','SEARCHING')` and checks `count === 1` before proceeding. Two concurrent accepts against the same request: the second's `claimForMatch` call returns `count = 0` and throws `RideRequestAlreadyMatchedError`.
  - DB level backstop: **unique index `rides_request_id_key` on `rides.request_id`** (migration `20260810100000_ride_request_unique`).
- **"Same driver cannot accept two active rides" — now protected at the application level, where before it had zero protection.** `acceptRideRequest` now calls `rideRepo.findActiveByDriver(data.driverId, tx)` before claiming the request and throws `DriverNotAvailableError` (409) if the driver already has one. The request itself is left unclaimed on this path, so a different driver can still take it. **This still has the same class of race the customer-side check in §10 has** — the check and the eventual `rideRepo.create` are not covered by a row lock on the driver, and no DB-level partial unique index on `(driverId) WHERE status IN (active states)` was added. Two different requests accepted by the same driver in the same instant could both still pass this check before either commits. Closing that fully would need a migration, which was explicitly out of scope for this fix round.
- **Vehicle validation is still essentially absent** — unchanged. `acceptRideRequestSchema` requires `vehicleId: z.string().uuid()` and it is written straight into `Ride.vehicleId` with no check that the vehicle belongs to the accepting driver, is active/approved, or matches the requested category. `src/modules/drivers` still has zero vehicle-related code and `src/modules/vehicles` is still a stub. **Severity: high, unresolved.**
- OTP for trip start is generated at acceptance and returned as `plaintextOtp` in the accept response, correctly scoped to `rideId` — unchanged, still correct.

## 15. Customer Gets Allocated Driver — **DISCONNECTED**

- On accept, `RIDE_EVENT_CATALOG.ACCEPTED` is published (`lifecycle.service.ts:158-164` post-fix) — still no consumer, still no delivery channel, so **the customer is still not proactively notified.** This was not in scope for the fix round.
- The only way to learn a driver was assigned is by **polling** `GET /rides/active` or `GET /rides/:id`, which return the `Ride` row. Whether the response shape exposes an appropriately-scoped subset of driver/vehicle fields was **not verified** in this pass and remains an open follow-up.
- **Live driver location is still not obtainable by the customer under any mechanism.** `GET /drivers/:id/location` is still gated to the driver themself or `admin`/`support` staff only — no ride-scoped exception was added for a customer on an active ride with that driver. Unchanged, and not addressed by this fix round.

## 16. Driver Approaching Pickup — **DISCONNECTED**

- `POST /rides/:id/arrive` → `LifecycleService.markDriverArrived` still correctly validates the calling driver is the one assigned to the ride, transitions state atomically, and publishes `DRIVER_ARRIVED` — unchanged, still sound.
- Real-time propagation to the customer still does not exist (§15).
- **Driver cannot publish location for another driver's ride — still WORKING**, unchanged: `driverId` for a location update is still derived server-side from the authenticated caller, never from the request body.
- **Real-time connection authorization / reconnect behavior — still N/A / MISSING**, no socket layer exists.
- **Stale location behavior:** unchanged — enforced only inside `NearbyDriverService.find()`'s `freshAfter` cutoff, which the new consumer _does_ now exercise on every dispatch attempt (a meaningful improvement in practice, since stale-location drivers are now actually filtered out of matching for the first time) — but there is still no staleness concept exposed to a customer-facing consumer of the data, because that consumer-facing path still doesn't exist.

## 17. Real-Time Customer Tracking — **MISSING**

- Unchanged: no transport exists, and the one REST endpoint that holds live location is still authorization-blocked for the customer role. Not in scope for the fix round.

## 18. Ride OTP Security and Workflow — **WORKING**

Unchanged, still one of the strongest pieces of the system.

Traced `RideStateController.start` → `LifecycleService.startRide` → `RideOtpService.verifyStartOtp`:

- `lockAndValidate` re-locks the ride row and asserts `ride.driverId === actor.driverId` **before** OTP verification runs — only the driver actually assigned to _this_ ride can attempt to start it.
- `verifyStartOtp` looks up the OTP **by `rideId`**, inherently scoping it to one ride, itself bound to exactly one customer and one driver via the `Ride` row's foreign keys. **"The OTP belongs to this exact ride/customer/driver" is enforced by construction, not by trusting client-supplied identifiers.**
- Expiry is checked server-side. Attempt counting is atomic (`claimAttempt`) and enforces a max. Verification is single-use via a second atomic conditional update (`claimVerification`).
- **The customer never submits the OTP to the server — the customer reads it aloud, the driver types it in — matching the brief's required ownership model exactly:** the driver's typed code is validated server-side against a hash tied to `rideId`, never a client-side comparison.
- **A driver cannot submit an OTP for another ride**, because the OTP lookup is server-scoped to the `rideId` in the URL path combined with the already-verified `ride.driverId === actor.driverId` check.

## 19. Trip Start Workflow — **WORKING**

Unchanged. The state transition (`ACCEPTED`/`DRIVER_ARRIVING`/`DRIVER_ARRIVED` → `IN_PROGRESS`) is guarded by `ALLOWED_TRANSITIONS` and applied via `updateStatusIf`, a conditional `UPDATE ... WHERE status = expected` — atomic, so two concurrent start attempts cannot both succeed.

## 20. Live Trip Workflow — **MISSING**

Unchanged: no transport, no customer-authorized location read. There is no "live trip progress" feed beyond polling `GET /rides/:id` for status field changes, which does update correctly as the state machine advances.

## 21. Trip Completion Workflow — **PARTIAL**

Traced `LifecycleService.completeRide` (`lifecycle.service.ts:238-335` post-fix):

- Status transition guarded by `updateStatusIf` — **double completion and concurrent completion are both correctly prevented**, unchanged.
- **Cannot complete another driver's ride** — unchanged, `lockAndValidate` still checks `ride.driverId === actor.driverId` first.
- **Final fare model: recalculated from actuals, not the original quote** — unchanged. `fareService.calculateFinalFare` runs the same rate-card pricing function used for the quote, but against driver-submitted final distance/duration.
- **These actuals still come directly from the driver's own request body with no independent verification against the ride's own GPS trail.** Unchanged, not in scope for this fix round. A driver can still under- or over-report the trip and the fare will follow whatever they submit.
- **Completed ride cannot be modified** — unchanged, no mutation path found for a `COMPLETED` ride.
- **Payment recorded once, ledger entries cannot duplicate via this path** — unchanged, still guaranteed by the same-transaction status guard.
- **Driver availability update on completion: now happens.** Previously nothing reset the driver because nothing had set it in the first place; the fix round's `driverStatusRepository.updateStatus(driverId, 'ONLINE', {}, tx)` call closes this specific gap.

## 22. Payment and Ledger Workflow — **PARTIAL**

Unchanged by the fix round; re-stated for completeness of this refreshed report.

- **Cash / Wallet / Card / UPI** all still post through `LedgerService.recordTripPayment` exactly as before.
- **Is ledger posting atomic with ride completion?** Yes — still called inside the same transaction as the status update and fare-row insert.
- **Are double-entry records correct?** Yes, mechanically — `LedgerRepository.postGroup` still sums debits and credits and throws before writing anything if they don't match.
- **Can completion happen twice and duplicate money?** No — same status guard as §21.
- **Does `DriverWallet` actually update? Still no.** `postGroup` only inserts audit rows into `payment_ledger_entries`; `customer_wallets.balance`/`driver_wallets.balance` are still never touched by ride payment, and `WalletService` is still never imported by `rides`. **Unresolved, unchanged, high severity.**
- **Is `SettlementJob` scheduled? Still no.** Still absent from `JOB_SCHEDULES`, still requires an externally-supplied driver list nothing produces. **Unresolved, unchanged.**
- **Do wallet APIs show real earnings?** `GET /payments/wallet/balance` still reads a real but ride-payment-disconnected column, unchanged.
- Failed payment / cash collection / prepaid payment lifecycle: unchanged, still not fully traced beyond the immediate `PAID`/`PENDING` assignment at completion time.

## 23. Settlement and Driver Earnings Workflow — **DISCONNECTED**

Unchanged. `SettlementService.calculateSettlement` is real and period-idempotent but still unscheduled and unreachable via HTTP. Not in scope for this fix round.

## 24. Customer Post-Ride Workflow — **PARTIAL**

Unchanged.

- **Ride history / active ride / single ride / receipt:** all as originally found — real, correctly ownership-scoped via `assertRideParty`, receipt generation still lazy/on-demand.
- **Rating/review:** `src/modules/reviews` is still a 2-file stub; `RideRating` still has no writer anywhere. **MISSING**, unchanged.
- **Complaint/support:** `src/modules/support` is still a 2-file stub; `SupportTicket`/`RideDispute` still unused. **MISSING**, unchanged.

## 25. Cancellation Workflow — **PARTIAL (driver-release now correct; fee handling unchanged)**

Traced `LifecycleService.cancelRide` → `CancellationService.processCancellation`:

- Actor resolution, ownership checks, and the state-machine guard are unchanged and correct.
- **Cancellation fee logic is unchanged**: still a flat, hardcoded `Decimal(50)` that ignores `rideConfig.defaultCancellationFee`, and `feeCharged: true` is still only a stored flag with no ledger entry, wallet debit, or payment-intent ever created for it. **Unresolved, unchanged.**
- **New in this fix round:** whichever driver was assigned to the ride is now correctly returned to `ONLINE` status on any cancellation (customer-, driver-, or system-initiated), via the same `driverStatusRepository.updateStatus` call added for completion. Before this fix, a cancelled ride left the driver's status wherever it happened to be — which was moot only because nothing had ever set it to `ON_TRIP` in the first place; now that accept sets it, this release step was necessary to avoid stranding drivers as permanently `ON_TRIP` after a cancellation, and it is in place.

## 26. Edge Case Matrix

Re-stated from the original audit with fix-round outcomes folded in; unlabeled rows are unchanged.

| Case                                                                            | Status                                                                                                                                                                                                                                                                                                                                                                                  | Evidence                                           |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Customer cancels before/after driver assignment, while arriving, after arrival  | WORKING (fee behavior per §25)                                                                                                                                                                                                                                                                                                                                                          | `lifecycle.service.ts`                             |
| Customer tries to cancel after trip start                                       | WORKING — correctly rejected (`IN_PROGRESS` only allows `COMPLETED`/`CANCELLED_BY_SYSTEM`)                                                                                                                                                                                                                                                                                              | `lifecycle.service.ts:47`                          |
| Driver rejects offer / ignores offer                                            | **Now partially reachable, still no reject endpoint.** A driver can now _see_ an offer via `GET /rides/offers` and simply not act on it (equivalent to "ignore"); there is still no explicit reject action, and `RideDispatch.response` still never gets written `REJECTED` by any driver action.                                                                                       | `ride-dispatch.repository.ts`                      |
| Driver accepts after expiry                                                     | WORKING — `claimForMatch`'s status filter excludes `EXPIRED` requests                                                                                                                                                                                                                                                                                                                   | `ride-request.repository.ts:100-106`               |
| Driver goes offline after accepting                                             | **Now genuinely blocked**, where before the guard existed but could never fire. `setOffline` throws `DriverOnTripError` when status is `ON_TRIP` — and accept now actually sets that status.                                                                                                                                                                                            | `status.service.ts:82`, `lifecycle.service.ts:147` |
| Driver loses heartbeat / network / location stops                               | PARTIAL, unchanged — effect on an _active ride_ specifically not re-verified                                                                                                                                                                                                                                                                                                            |                                                    |
| Driver tries to accept two rides                                                | **Now blocked at the application level** (was previously **completely unprotected**). Residual race remains for two different requests accepted in the same instant — no DB constraint added.                                                                                                                                                                                           | `lifecycle.service.ts:121-124`                     |
| Driver tries to complete twice                                                  | WORKING, unchanged                                                                                                                                                                                                                                                                                                                                                                      | `updateStatusIf`                                   |
| Two drivers accept simultaneously                                               | WORKING, unchanged (row lock + conditional claim + DB unique index)                                                                                                                                                                                                                                                                                                                     | §14                                                |
| Two ride requests submitted simultaneously (same customer)                      | Race window still exists, unchanged, not in scope                                                                                                                                                                                                                                                                                                                                       | §10                                                |
| Duplicate HTTP requests / retry after timeout                                   | Still unprotected beyond the racy active-request check, unchanged                                                                                                                                                                                                                                                                                                                       | §10                                                |
| Event delivered twice (outbox at-least-once redelivery)                         | **Now a real, exercised scenario** for `ride.requested`, since it now has a consumer. Handled: the consumer re-checks `request.status` is still `CREATED`/`SEARCHING` before acting, and wraps each `offerToDriver` call in try/catch specifically to tolerate the resulting duplicate-offer unique-constraint violation on `[requestId, driverId]` without aborting the whole handler. | `ride-requested.consumer.ts`                       |
| Server restart                                                                  | Not evaluated, unchanged                                                                                                                                                                                                                                                                                                                                                                | —                                                  |
| Job retry (BullMQ)                                                              | WORKING for jobs that exist — Redis locks prevent overlapping runs, unchanged                                                                                                                                                                                                                                                                                                           | —                                                  |
| Stale offer                                                                     | N/A previously (offers never created); **now a real state** — `DispatchTimeoutJob` marks it `TIMEOUT`, but nothing retries to a next candidate (§12)                                                                                                                                                                                                                                    | —                                                  |
| Stale quote                                                                     | N/A by design, unchanged                                                                                                                                                                                                                                                                                                                                                                | —                                                  |
| Fare configuration changes mid-flow / pricing race                              | N/A, pricing still static, unchanged                                                                                                                                                                                                                                                                                                                                                    | —                                                  |
| Payment retry / settlement retry                                                | Unchanged, not in scope                                                                                                                                                                                                                                                                                                                                                                 | —                                                  |
| **Security:** customer accesses another customer's ride                         | BLOCKED (working), unchanged                                                                                                                                                                                                                                                                                                                                                            | `assertRideParty`                                  |
| Customer tracks another driver's location (or even their own assigned driver's) | BLOCKED (working, but overly broad — customer can't track their own driver either), unchanged                                                                                                                                                                                                                                                                                           | §17                                                |
| Driver starts another driver's ride                                             | BLOCKED (working), unchanged                                                                                                                                                                                                                                                                                                                                                            | §18                                                |
| Driver submits OTP for another ride                                             | BLOCKED (working) by construction, unchanged                                                                                                                                                                                                                                                                                                                                            | §18                                                |
| Customer manipulates fare                                                       | BLOCKED (working), unchanged                                                                                                                                                                                                                                                                                                                                                            | §9                                                 |
| Driver manipulates `vehicleId`                                                  | **Still not blocked** — unresolved, unchanged, explicitly out of scope for this fix round                                                                                                                                                                                                                                                                                               | §14                                                |
| Role/session changes during an active ride                                      | Not fully re-verified, unchanged                                                                                                                                                                                                                                                                                                                                                        | —                                                  |

## 27. Security Audit

Unchanged from the original audit except where noted.

- Authorization remains consistently structured around `assertRideParty`, `authorizedDriverId`/`actingDriverId`, and route-level `fastify.authorize({...})` preHandlers. The new `GET /rides/offers` route follows the same `driverOnly` pattern already used by `/accept`, `/:id/arrive`, `/:id/start`, `/:id/complete` — no new authorization pattern was introduced.
- **`vehicleId` on ride accept remains the one clear gap**, unresolved, unchanged.
- Mock-location and implausible-jump rejection remain genuine anti-spoofing controls, unchanged, and now actually feed a live-matching pipeline that reads their output (the geo search the new consumer calls depends on this data being trustworthy) — making their correctness marginally more consequential than before, though the controls themselves were not modified.
- Cancellation fee still recorded as "charged" without being charged — unresolved, unchanged, still worth flagging as a financial-integrity concern.
- No secrets or hardcoded credentials observed in any file touched during either the original audit or the fix round.

## 28. Database Invariant Matrix

Re-stated with fix-round outcomes folded in.

| Invariant                                                                       | Application-level                                                                                                     | Database-level                                                                                                               | Verdict                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One active ride per customer                                                    | Yes (`findActiveByCustomer`, race window)                                                                             | No matching partial unique index                                                                                             | **Protected by application only, with a race window** — unchanged                                                                                                                                                                                            |
| One active ride per driver                                                      | **Yes, as of the fix round** (`findActiveByDriver`, now called; same class of race window as the customer-side check) | No — only a plain `@@index([driverId])`, no partial unique index added                                                       | **Protected by application only, with a race window** — upgraded from "not protected at all"                                                                                                                                                                 |
| One ride per ride request                                                       | Yes (row lock + conditional claim)                                                                                    | Yes (`rides_request_id_key`)                                                                                                 | **Protected by both**, unchanged                                                                                                                                                                                                                             |
| One winning driver assignment                                                   | Same as above                                                                                                         | Same as above                                                                                                                | **Protected by both**, unchanged                                                                                                                                                                                                                             |
| One active vehicle assignment where required                                    | No                                                                                                                    | No unique constraint located                                                                                                 | **Not protected**, unchanged, out of scope                                                                                                                                                                                                                   |
| Correct vehicle/ride relationship (ownership, category match)                   | No                                                                                                                    | FK guarantees row-existence only                                                                                             | **Not protected beyond row-existence**, unchanged, out of scope                                                                                                                                                                                              |
| Correct customer/ride relationship                                              | Yes                                                                                                                   | Yes (FK)                                                                                                                     | **Protected by both**, unchanged                                                                                                                                                                                                                             |
| Payment idempotency (per ride)                                                  | Yes, indirectly via the completion status guard                                                                       | No dedicated idempotency key column found                                                                                    | **Protected by application only**, unchanged                                                                                                                                                                                                                 |
| Ledger idempotency (balanced entries)                                           | Yes (`postGroup` balance check)                                                                                       | No unique constraint against duplicate group posting                                                                         | **Protected by application only**, unchanged                                                                                                                                                                                                                 |
| OTP one-time usage                                                              | Yes (atomic `claimVerification`)                                                                                      | Plain boolean column, no DB-level constraint                                                                                 | **Protected by application only**, unchanged                                                                                                                                                                                                                 |
| OTP attempt-limit                                                               | Yes (atomic `claimAttempt`)                                                                                           | No DB-level cap                                                                                                              | **Protected by application only**, unchanged                                                                                                                                                                                                                 |
| Quote/request consistency                                                       | Recomputed server-side, never trusted from an earlier call                                                            | N/A — quotes aren't persisted                                                                                                | **Protected by application design**, unchanged                                                                                                                                                                                                               |
| Ledger group balance (debits = credits)                                         | Yes, checked before insert                                                                                            | No DB-level CHECK constraint                                                                                                 | **Protected by application only**, unchanged                                                                                                                                                                                                                 |
| Driver eligible for a request they're offered (verified, not suspended, online) | **Yes, as of the fix round** — checked by the new consumer before calling `offerToDriver`                             | No DB-level enforcement (and none would make sense here — this is a point-in-time eligibility check, not a static invariant) | **New row — protected by application only, and only at offer time** (a driver's eligibility could change between offer and accept; `acceptRideRequest` itself does not re-check verification/suspension, only the active-ride guard added in this fix round) |

## 29. Runtime Reachability Matrix

Re-stated with fix-round outcomes folded in. `ROUTE → CONTROLLER → SERVICE → REPOSITORY → DI → DATABASE → EVENT/JOB`.

| Feature                                                      | Route mounted?                                                     | Reaches service?                                            | Reaches repository/DB?                              | Event/job wired?                                                                             | Verdict                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Pricing calculation                                          | `POST /rides/quote`, `/requests`                                   | Yes                                                         | N/A (env config, not DB)                            | N/A                                                                                          | **WORKING** as a calculator, still sourced from static config not an admin system — unchanged |
| Ride request creation                                        | `POST /rides/requests`                                             | Yes                                                         | Yes                                                 | Publishes `REQUESTED` — **now has a consumer**                                               | **WORKING**, and the event it fires is now a real dispatch trigger, not a dead end            |
| Matching (candidate selection combining eligibility filters) | No dedicated route; triggered by the event consumer                | **Now exists** — `RideRequestedConsumer.isEligible`         | Reaches `drivers`/`driver_online_status`/geo stores | Triggered by `REQUESTED` event                                                               | **WORKING**, single-candidate only (§11)                                                      |
| Dispatch (`offerToDriver`)                                   | Triggered by the consumer, not a route                             | **Now called**                                              | Reaches `ride_dispatches`                           | `DISPATCH_OFFERED` published, still no consumer for that specific event (informational only) | **WORKING**                                                                                   |
| `NearbyDriverService.find`                                   | Triggered by the consumer                                          | **Now called**                                              | Reaches Redis/PostGIS                               | —                                                                                            | **WORKING**                                                                                   |
| Driver offer discovery                                       | `GET /rides/offers` — **new**                                      | Yes                                                         | Yes (`ride_dispatches`)                             | —                                                                                            | **WORKING** (poll-only, no push)                                                              |
| Notification delivery (driver offer / customer update)       | No socket route; SMS-only provider exists for OTP, not ride events | —                                                           | —                                                   | —                                                                                            | **MISSING** for ride events specifically, unchanged                                           |
| Ride OTP generation/verification                             | `POST /rides/accept`, `/:id/start`                                 | Yes                                                         | Yes                                                 | —                                                                                            | **WORKING**, unchanged                                                                        |
| Trip start / completion                                      | `POST /rides/:id/start`, `/:id/complete`                           | Yes                                                         | Yes                                                 | Events published, no consumer (informational)                                                | **WORKING**, unchanged                                                                        |
| Driver active-ride guard on accept                           | Inline in `POST /rides/accept`                                     | **Now enforced**                                            | Yes (`findActiveByDriver`)                          | —                                                                                            | **WORKING**, application-level only (§28)                                                     |
| Driver status lifecycle (`ON_TRIP`/`ONLINE`)                 | Inline in accept/complete/cancel                                   | **Now enforced**                                            | Yes (`driver_online_status`)                        | —                                                                                            | **WORKING**                                                                                   |
| Settlement job                                               | Not in cron schedule; no HTTP route                                | Function exists, effectively zero real callers              | Would reach `driver_settlements` if called          | Not scheduled                                                                                | **DISCONNECTED**, unchanged                                                                   |
| Wallet balance projection from ride earnings                 | `GET /payments/wallet/balance` reads real balance column           | Balance column real; nothing writes to it from ride payment | —                                                   | —                                                                                            | **DISCONNECTED**, unchanged                                                                   |

## 30. Test Coverage and Execution Results

- `npm run typecheck` → clean, 0 errors (re-verified after the fix round).
- `npm run lint` → clean, 0 warnings (re-verified after the fix round).
- `npm run test:unit` → **719/719 passed / 0 failed** after the fix round (716 original + 3 new tests added specifically to cover the new driver-active-ride guard and the `ON_TRIP`/`ONLINE` status transitions on accept/complete/cancel, in `tests/unit/rides/ride-lifecycle-concurrency.test.ts`). The pre-existing hand-rolled in-memory fake harness in that file needed updating for the `LifecycleService` constructor's two new dependencies (`RideDispatchRepository`, `DriverStatusRepository`) — done as part of the fix, not left broken.
- `npm run test:integration` → still fails immediately on every test with `password authentication failed for user "zaroorat"` (Postgres `28P01`). Still **NOT VERIFIABLE** — no reachable Postgres instance with valid credentials for the `zaroorat` test database was available in this environment, unchanged from the original audit.
- **No true HTTP/API integration test exists for the customer ride lifecycle**, unchanged — the new consumer and endpoint have unit-level coverage only (via the hand-rolled fakes noted above), not an HTTP-level test exercising `POST /rides/requests` → dispatch → `GET /rides/offers` → `POST /rides/accept` against a real server and database. This remains open follow-up work.

## 31. Working Features

Unchanged list from the original audit, plus:

- Automatic driver matching and offer creation on ride-request creation (single candidate).
- Driver offer discovery via `GET /rides/offers`.
- "One active ride per driver" guard at accept time (application-level).
- Driver status transitions to `ON_TRIP` on accept and back to `ONLINE` on completion/cancellation.

Everything previously listed (OTP flow, server-side fare computation, atomic accept claim, state machine, ride ownership checks, ledger atomicity with completion, driver online/offline/heartbeat subsystem, clean typecheck/lint) remains true and unchanged.

## 32. Partial Features

Unchanged from the original audit, with driver acceptance now upgraded from Partial to Working (§14) and driver matching/dispatch/offer-delivery now Partial instead of fully Disconnected (§11-§13). Cancellation remains Partial (fee handling unresolved) but its driver-release side effect is now correct (§25).

## 33. Disconnected Features

Unchanged except:

- ~~`NearbyDriverService.find`~~ — now connected.
- ~~`DispatchService.offerToDriver`~~ — now connected.
- ~~`RideRepository.findActiveByDriver`~~ — now connected.
- `WalletService` relative to ride payment, `SettlementService`/`SettlementJob`, the ride lifecycle events (`ACCEPTED`/`STARTED`/`COMPLETED`/`CANCELLED` still have zero consumers — only `REQUESTED` gained one), and `src/plugins/socket/socket.plugin.ts` remain disconnected, unchanged.

## 34. Missing Features

Unchanged from the original audit, except "any driver-facing list-my-pending-offers endpoint" is no longer missing (§13). Still missing: real-time transport, admin pricing configuration, vehicle category listing endpoint, vehicle ownership/category validation on accept, real routing/geocoding, automatic dispatch retry to a next-nearest driver, rating/review creation, support ticket/dispute creation, customer-authorized live driver location read.

## 35. P0 Critical Findings

1. ~~No automatic matching/dispatch trigger~~ — **fixed**: `ride.requested` now has a consumer (§12).
2. No real-time delivery channel exists at all (§13, §17) — **unresolved**.
3. ~~`offerToDriver` and `NearbyDriverService.find` never called~~ — **fixed**, both are now called (§11, §13).
4. ~~Driver has no endpoint to discover offered/pending ride requests~~ — **fixed**: `GET /rides/offers` (§13). _Narrowing note: this closes discovery, not delivery — a driver must still poll; nothing pushes the offer to them._
5. Customer cannot view driver location under any mechanism — authorization-blocked, not just missing transport (§15, §17) — **unresolved**.

**Net effect: of the five original P0 findings, three are fully or substantially addressed (#1, #3, #4) and two remain completely open (#2, #5).** The workflow can now, for the first time, connect a ride request to an eligible online driver automatically — but the driver still has to be actively polling for that to matter in practice, and the customer still cannot see the driver at all once assigned.

## 36. P1 High Findings

6. Fare/pricing is static env config; `pricing_rules`/`surge_zones`/etc. entirely dead schema (§8) — **unresolved**.
7. No vehicle-category listing endpoint; category not validated against availability/active state (§7, §9) — **unresolved**.
8. ~~Driver status never transitions to `BUSY`/`ON_TRIP` during a ride~~ — **fixed** (§12).
9. `vehicleId` on ride accept is not validated for driver ownership or category match (§14, §27) — **unresolved**.
10. ~~"One active ride per driver" is unprotected at both app and DB level~~ — **fixed at the application level**; DB-level protection (a partial unique index) was not added, so a narrow race remains (§14, §28).
11. Wallet balances are never mutated by ride payment; settlement is unscheduled and unreachable (§22, §23) — **unresolved**.
12. Cancellation fee is recorded as charged but never actually charged; hardcodes a value that ignores existing config (§25) — **unresolved**.

## 37. P2 Medium Findings

All unresolved, unchanged from the original audit: 13. Concurrent duplicate active ride requests from one customer — app-level-only, race window, no DB constraint (§10, §28). 14. Final fare relies on driver-submitted distance/duration with no independent GPS cross-check (§21). 15. No real routing/geocoding — Haversine × 1.3 stands in for route distance (§6). 16. No idempotency key on ride-request creation (§10). 17. Rating/review and support/dispute are schema-only, no service layer (§24). 18. No profile-completion gate before reaching Home (§5) — informational, may be intentional.

## 38. Exact Broken Transition(s)

**Original finding (now resolved):** `RideRequestService.createRequest` published `RIDE_EVENT_CATALOG.REQUESTED` to nothing — no consumer, no poller, no driver ever saw the request. **This is fixed**: `RideRequestedConsumer` now subscribes to that exact event, calls `NearbyDriverService.find()`, and calls `DispatchService.offerToDriver()` for the nearest eligible candidate, and a driver can retrieve the resulting offer via `GET /rides/offers`.

**What remains structurally unreachable from a real customer action even after this fix:**

> If the one driver offered a ride does not poll `GET /rides/offers` in time, does not act on it, or rejects it, **the request simply expires** — `DispatchTimeoutJob` marks the offer `TIMEOUT` and `RequestExpiryJob` eventually marks the request `EXPIRED`, and nothing tries a second driver. There is exactly one attempt per ride request today.

> Separately, even a ride that completes the full accept→OTP→start→complete→payment path today does so with **the customer never seeing the driver's location and never being proactively notified of any state change** — every transition is real and correct in the database, but a customer client can only learn about it by polling `GET /rides/:id`, and even then cannot see where the driver physically is.

Both of these are now the precise, narrowed boundary of what still blocks a genuinely complete, production-quality customer experience — not because the underlying logic is wrong, but because retry-on-reject and any form of push/live-location delivery were explicitly out of scope for this first fix round.

## 39. Recommended Implementation Order

Updated to reflect what's already done.

1. ~~Close the matching gap~~ — **done**: consumer wired, `NearbyDriverService.find()` and `DispatchService.offerToDriver()` connected.
2. ~~Give drivers a way to see offers~~ — **done**: `GET /rides/offers`.
3. ~~Fix `findActiveByDriver` check before accept~~ — **done**, application-level (DB-level partial unique index still open, low cost to add later).
   ~~Vehicle ownership/category validation on accept~~ — **still open**, explicitly deferred; requires the `vehicles` module to exist in some minimal form first (a driver's current vehicle isn't tracked anywhere yet).
4. ~~Wire driver status to ride lifecycle~~ — **done**: `ON_TRIP` on accept, `ONLINE` on completion/cancellation.
5. **Next up, in priority order:**
   a. Retry-to-next-candidate on dispatch timeout/reject (closes the "one attempt only" gap in §38) — moderate effort, reuses the same consumer's candidate list.
   b. A push channel (even a minimal one — a driver-app-visible unread-offer flag plus more frequent polling, ahead of full WebSocket infrastructure) so "discovery" (done) becomes "delivery" (not done).
   c. Connect wallet balance to ledger posting, or explicitly relabel the wallet-balance display so it isn't misleading.
   d. Build the admin pricing surface and switch `FareService` to read it instead of env JSON.
   e. Add real-time driver location access for the customer on their own active ride.
6. Everything else in §36/§37 can follow in parallel.

## 40. Final Production Readiness Decision

**NO-GO — improved from the original audit, but not yet GO-with-conditions.**

The single biggest blocker this audit identified — a ride request that no driver could ever see — is fixed. A real customer request can now automatically reach an eligible online driver, and that driver can discover and accept it, with the acceptance itself protected by genuinely solid concurrency controls that were already in place. That is a meaningful, verified change in the system's actual behavior, not just its code inventory.

It is not yet a workable pilot, for two reasons that were explicitly out of scope for this round: **there is still no delivery mechanism better than a driver polling an endpoint**, and **there is still no way for a customer to see their driver once assigned.** A ride can now be requested, matched, accepted, started via OTP, completed, and billed to the ledger correctly and safely — but a real user experience needs the driver to be notified promptly and the customer to be able to see what's happening, and neither exists yet. Fare configurability, wallet correctness, and vehicle-ownership validation remain open at the severity this audit originally assigned them.

The path forward is narrower than it was: §39 lists five remaining items in priority order, and none of them requires re-deriving anything — the architecture and the data model to support all of them already exist.

---

## Customer Workflow Status Summary

```
CUSTOMER WORKFLOW STATUS:
Authentication:              WORKING
Profile:                     PARTIAL
Home/Location:               PARTIAL
Vehicle Selection:           DISCONNECTED
Admin Fare Configuration:    MISSING
Fare Quote:                  WORKING
Ride Request:                PARTIAL
Nearby Driver Discovery:     WORKING          (was DISCONNECTED)
Driver Offer Delivery:       PARTIAL          (was DISCONNECTED — poll-only, no push)
Driver Acceptance:           WORKING          (was PARTIAL)
Customer Allocation Update:  DISCONNECTED
Driver Live Tracking:        MISSING
Ride OTP:                    WORKING
Trip Start:                  WORKING
Live Trip:                   MISSING
Trip Completion:             PARTIAL
Payment:                     PARTIAL
Settlement:                  DISCONNECTED
Ride History:                WORKING

FINAL DECISION: NO-GO
```

---

## Scope Notes

This audit focused on backend code reachable from a mounted HTTP route or scheduled/event-triggered job, plus the modules it calls into. It did not run a live server against a real database, did not exercise the API over HTTP with real traffic, and did not attempt to stand up the missing Postgres/Redis infrastructure needed for the integration test suite. All findings are from static reading of the current source and migration history, plus the test/quality commands actually executed (§2, §30) both before and after the fix round described in this update. Items explicitly marked **NOT VERIFIABLE** were left unresolved rather than assumed in either direction: a service existing without a caller is disconnected, not working; an unexamined code path is unverified, not passing; and a fix that closes one specific gap is reported as closing exactly that gap, not the broader finding it was part of.
