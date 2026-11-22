# Feature Specification: Zone Pricing, Promotion & Referral Integrity

**Feature Branch**: `003-zone-pricing-integrity`

**Created**: 2026-08-29 · **Last updated**: 2026-08-29 (initial draft from code review of `admin-folder` @ `703a76f`)

**Status**: **ALL SIX PHASES DELIVERED (2026-08-29) — 47 of 47 requirements complete.** BD-1 and BD-2 were approved on 2026-08-29 as option **A** (commission on ride revenue only) and option **A** (the platform bears a promotional discount), unblocking Phase 2. See §Business Decisions.

**Amendment (Phase 6).** FR-034 says "one active rule per key MUST be enforced by a database index". Building it proved the requirement was written one word short: enforcing it on the key alone forbids a future-dated rate change from existing beside the card that is live today, which FR-003 exists to permit. The requirement is read, and delivered, as **one rule _in force_ per key at any instant** — no two live rules on a key may cover overlapping effective windows. That is an exclusion constraint, not a unique index. FR-003 and FR-034 are otherwise unchanged.

**Input**: Code review of the geographic management, zone-based pricing, promotions and referral work merged onto `admin-folder` (PRs #17, #18, #19). **All 46 findings are dispositioned in [§Finding Traceability](#finding-traceability)** — 45 become requirements, 1 is accepted with a stated reason, none is left silent. The Current State sections below detail the 26 that change behaviour, money or integrity; the remainder are one line each in the traceability table.

---

## Current State _(traced against committed code, 2026-08-29)_

This is a brownfield remediation. Every finding below was read out of the committed source on `admin-folder` at `703a76f`.

**Baseline, corrected by execution on 2026-08-29.** An earlier draft of this section claimed _"none of the defects below are caught by an existing test"_. **That was wrong**, and it was wrong because it was written from the unit suite alone. Measured against a test database migrated to head:

| Suite                                       | Result at HEAD        | Cause                                                      |
| ------------------------------------------- | --------------------- | ---------------------------------------------------------- |
| `tsc --noEmit`                              | clean                 | —                                                          |
| `tests/unit/pricing`                        | 33 / 33               | —                                                          |
| `tests/integration/vehicle-catalog`         | **12 pass / 12 fail** | every failure is `OUTSIDE_SERVICE_AREA` 400 — see FR-048   |
| `tests/integration/pricing-rule-resolution` | **1 pass / 1 fail**   | nested-zone resolution returns the outer zone — see FR-005 |

Two defects therefore ship with red committed tests, and one defect below (FR-048) was not in the original review at all because the review read the code without executing the quote path.

### What is broken — money

- **The final bill is computed against a different rate card than the quote.** `RideLifecycleService` calls `PricingService.calculateFinalFare` with no `cityCode`, no `pickupLat/Lng` and no `serviceType` (`lifecycle.service.ts:611`, `:635`). `rateCardForTypeId` therefore builds `cityCodes = ['GLOBAL']` and never runs the zone resolver. Every zone-scoped and city-scoped fare rule an operator creates applies to the quote and is discarded at the moment the customer is charged. The zone-based fare feature does not reach the invoice.

- **Commission is levied on tax and on the platform's own fee, and the driver is credited with both.** `pricing.service.ts:126-128`: `totalFare` already contains `taxAmount + platformFee`; `platformCommission = totalFare × rate`; `driverEarning = totalFare − platformCommission`. At the default card (5% tax, 20% commission, ₹15 flat platform fee) a ₹300 subtotal settles as commission ₹66.00 / driver ₹264.00 where the intended split is commission ₹60.00 / driver ₹240.00, with ₹15 tax and ₹15 platform fee belonging to neither party. These figures are written to `ride_fares` and drive the settlement ledger on every completed ride.

- **The minimum-fare floor is applied after the discount, so a valid promotion can reduce the bill by nothing while still being consumed.** `pricing.service.ts:126` computes `Math.max(card.minimumFare, taxable + tax + platformFee)` on the post-discount total. On a short trip the floor wins, the customer pays full price, and `promotionRedemption` is still written, `usedCount` still incremented and the coupon still burned.

- **A rule with `platformFeePct = 0` silently charges the environment's flat fee.** `PricingRule` has no `platformFeeFlat` column, so `rateCardFor` always takes `platformFeeFlat` from `pricingConfig` (`pricing.service.ts:54`). Since `platform_fee_pct` defaults to `0`, an admin who leaves the field blank sees "0" in the form and the customer is charged `RIDE_PLATFORM_FEE` (₹15 default).

- **Fare arithmetic is IEEE-754 across a `Decimal(10,2)` boundary.** `decimal()` converts every rule field to `number`, `price()` computes in floats with a per-leg `Math.round(x*100)/100`, and `new Decimal(...)` converts back. `rawSubtotal` (`:109`) is summed unrounded. The per-leg rounded parts are not guaranteed to sum to the rounded total — the invariant an invoice and the ledger both depend on.

### What is broken — rewards

- **Referral ride qualification is not idempotent and the event that drives it is at-least-once.** `processRideForReferee` does `qualifyingRides + 1` with no record of which ride caused the increment (`referral-runtime.service.ts:108`). Constitution §7.3 states delivery is at-least-once and consumer safety must come from a database guarantee; there is none here. One redelivered `ride.completed` counts twice toward `qualifyingThreshold`; on a threshold-5 program, five redeliveries of one ride pay out the full referrer and referee reward.

- **A reward whose target wallet is missing is recorded as paid and never retried.** `grantReward` creates the `ReferralReward` row `PENDING`, then `return`s without crediting when the driver row is absent (`referral-runtime.service.ts:213`). `qualifyAndReward` continues and sets the referral to `REWARDED` (`:182`). The status guard at the top of `qualifyAndReward` then short-circuits forever, and no job sweeps `PENDING` rewards. Money is owed, booked as paid, and unrecoverable without manual intervention. This is reachable on the new driver program whenever a `DRIVER`-wallet program's referrer has no `Driver` row.

- **Coupon batch caps can be exceeded indefinitely.** `coupon.service.ts:198`: `Math.min(body.count, remaining || body.count)`. When the batch is exhausted `remaining` is `0` — falsy — so the guard collapses to `Math.min(count, count)`, and line 221 rewrites `totalCount` upward to match. Repeated `POST /coupon-batches/:id/generate` mints unlimited coupons against a promotion.

- **Every promotion usage limit is check-then-act with nothing in the database behind it.** `assertPromotionEligible` reads `usedCount` and counts redemptions (`promotion.service.ts:244`, `:262`); `redeem` performs an unconditional `increment` (`:289`) in a different transaction, minutes later at ride completion. Constitution §5.4 requires uniqueness that must survive a lost lock to be enforced by a database index. There is no unique index on `promotion_redemptions` and no conditional update on `promotions.used_count`.

- **`applyAtSignup` is reachable long after signup and pays once per active program.** `POST /rider/apply` and `POST /driver/apply` are ordinary authenticated routes (`referral.routes.ts:11`, `:22`). The service checks the code, the program window, self-referral and the per-code cap — never that the referee is new. The only backstop is `@@unique([programId, refereeId])`, and `resolveActiveProgram` is a `findFirst` over an unbounded set of overlapping active programs, so each additional active program is another payout to the same user.

- **The per-code usage cap is check-then-increment and the whole apply path is untransacted.** `referral-apply.service.ts:56` reads `usesCount`, `:89` increments it, and when no `tx` is supplied — which is what the controller does — the referral create, the increment and `onReferralApplied` (which opens its own transaction) are three independent units.

- **There is no fraud control.** `ReferralFraudFlag`, its `ReferralFraudStatus` enum, its reviewer relation and its index exist in the schema and have **zero references** anywhere in `src/`. The complete anti-abuse surface is `if (referralCode.userId === input.refereeUserId) throw`. The device registry (`DeviceRepository`, already tracking `isRooted`/`isJailbroken`) and phone history are available and unconsulted.

### What is broken — configuration that does not reach behaviour

- **Peak-hour and demand/supply surge thresholds are stored, validated, returned by the API and never evaluated.** Migration `20260828190000` adds `peak_hour_start`, `peak_hour_end`, `is_peak_hour_only`, `demand_threshold_pct`, `supply_threshold_pct`. `createSurgeWindowSchema` even refines that peak hours are present when `isPeakHourOnly` is set. `SurgeService.resolveSurgeMultiplier` reads only `multiplier`. A window configured as 1.8× for 08:00–10:00 applies at 03:00 every day until `endsAt` passes.

- **Nothing anywhere passes `serviceType`.** A grep across `src/modules/rides` returns no occurrence. `findBestActiveRule` defaults to `'INSTANT'`, so `SCHEDULED`, `RENTAL` and `OUTSTATION` fare rules are creatable, listable, activatable and unreachable. `includedKm` — the field a rental rule needs — is read nowhere.

- **Night charges are dead and three admin fields are discarded.** `isNightTrip` is a parameter no caller sets, so `nightMultiplier` never applies. `fareRuleFieldsSchema` accepts `nightStartTime` and `nightEndTime`, which have no column and are silently dropped.

- **`freeWaitingMinutes` and `freeWaitingMin` are duplicate rate-card fields fed by different environment variables.** `price()` reads only `freeWaitingMin`. `RIDE_FREE_WAIT_MIN` has no reader in `src/` — setting it changes nothing and warns about nothing. Constitution §12.4 requires every knob to be documented with its bounds; a knob with no reader fails the spirit of that rule.

- **`TollZone` and `TaxConfig` have zero references in `src/`.** Tax comes solely from `PricingRule.taxRatePct`.

### What is broken — integration and data integrity

- **Surge does not use the geographic zones.** `SurgeZone` is a standalone table with its own `boundary geography(Polygon,4326)` and a free-text `cityCode` carrying no foreign key to `City` and no relation to `ServiceZone`. `SurgeRepository.findActiveZonesForLocation` runs its own `ST_Intersects` against `surge_zones` and never touches `service_zones`. Operators draw every polygon twice and the two drift silently; a surge zone can sit entirely outside every city boundary and still apply.

- **`findBestActiveRule` ignores `effectiveFrom` and `effectiveTo`.** It filters on `isActive` alone and merely orders by `effectiveFrom: 'desc'` (`pricing-rule.repository.ts:61-68`), so a rate card scheduled for next month takes effect on save and sorts first, and an expired one prices rides until someone deactivates it by hand. `findGlobalRules`, twenty lines below, applies the window correctly — the catalog and the quote can therefore disagree about which rule is live.

- **Two zone resolvers disagree on what "the zone this point is in" means.** `PricingRuleRepository.resolveServiceZoneAtPoint` takes the oldest zone of any type including `RESTRICTED`; `GeographicCoverageService.resolveServiceZoneIdAtPoint` filters to `SERVICE`/`AIRPORT`. Pricing can bind a fare to a zone the coverage check already rejected for pickup.

- **`city.code` is an editable free-text join key across five tables.** `PricingRule.cityCode`, `CancellationPolicy.cityCode`, `TaxConfig.cityCode`, `SurgeZone.cityCode` and `Promotion.applicableCity` are matched against `City.code` with no foreign key, and `updateCity` permits changing `code`. One rename orphans every fare rule, cancellation policy and promotion for that city — silently, because `findBestActiveRule` falls through to `GLOBAL` and rides keep being priced at the wrong price.

- **The "active cities require a boundary" guard is unreachable.** `admin-geographic.service.ts:327` requires `body.boundary === null` and `:331` requires `body.boundary === undefined`; the conditions are mutually exclusive, so the throw is dead code. `PATCH /cities/:id {"isActive": true}` activates a city with no boundary, and `resolveCityAtPoint` filters on `boundary IS NOT NULL` — the city is active, visible in admin, and matches no pickup anywhere.

- **The vehicle-type promotion restriction is skipped when the context lacks a vehicle type.** `promotion.service.ts:238`: the city branch treats a missing context value as a rejection, the vehicle-type branch treats it as a pass. A restriction that cannot be evaluated admits rather than denies.

- **Overlapping service zones resolve by `created_at ASC`.** Whichever polygon was drawn first wins, so a tighter airport zone added inside an existing city zone has no effect.

### What is broken — performance

- **No GiST index exists on any boundary column.** `cities.boundary`, `service_zones.boundary` and `surge_zones.boundary` are unindexed, so every `ST_Contains`/`ST_Intersects` is a sequential scan with a polygon test per row. The repository already establishes this pattern twice — `20260801000000` for `saved_places.location` and `20260815000000` for `driver_locations.location`, the latter with a comment explaining precisely why.

- **The multi-category quote re-resolves the city, the zones, the surge and the promotion once per vehicle type.** `ride-request.service.ts:107-190` loops over active vehicle types and per iteration runs `assertPickupServiceable` (city `ST_Contains`, zone `ST_Contains`, a zone `count`, up to two vehicle-restriction queries), `rateCardForTypeId` (another zone `ST_Contains`, up to two `pricingRule.findMany`), `resolveSurgeMultiplier` (a surge-zone `ST_Intersects`, a window query) and `quotePromo` (coupon lookup, ride count, redemption count, `campaignTarget.findMany`). With six categories that is roughly 50–70 round trips per quote, about 24 of them unindexed spatial scans, on the first screen the customer app opens. The loop's own comment records that the haversine was hoisted out; the database work was left in.

- **Fare rules are paginated in memory.** `AdminFareService.list` issues `findMany` with no `skip`/`take`, maps every row, filters by search string in JavaScript, then slices. Because `update` inserts a new version row rather than mutating, this table grows monotonically and every edit adds a row every subsequent list request loads. `AdminCouponService.listCoupons` does it correctly — the pattern is already in the codebase.

### What is broken — admin surface

- **No audit trail on any new admin write endpoint.** `src/modules/admin/audit/index.ts` is an empty file. Nothing in pricing, geographic, promotions or referral management records who changed what. `PricingRule.createdBy` is the only actor field the new code writes; there is no equivalent for a city boundary, a surge multiplier, a promotion's discount value or a referral program's reward amount. Constitution §17.4 requires staff-initiated money movement to record who performed it and why; these endpoints set the terms of every subsequent money movement.

- **Editing a fare rule is three untransacted writes that can leave a key with no active rule.** `AdminFareService.update` deactivates the row, deactivates siblings on the key, then inserts the new version — outside a transaction. A failure after the first two statements leaves zero active rules for that `(vehicleType, city, serviceType, zone)` and nothing alerts: `findBestActiveRule` falls through to `GLOBAL` and the city is mispriced until someone reads a revenue report. `create` and `activate` share the shape.

- **"One active rule per key" is enforced in application code only.** `exclusivityWhere` expresses the invariant; the database has no constraint behind it, so two concurrent creates both act on a pre-insert snapshot and both insert active rows. Constitution §5.4 requires the index.

- **`PATCH`/`DELETE` on a non-existent surge zone return success.** `updateSurgeZone` issues bare `$executeRaw` updates and discards the affected-row count; `deleteSurgeZone` delegates to it. An admin deactivating a zone by a stale id gets a 200 and believes surge is off there. `updateServiceZone` does this correctly on the adjacent path.

- **City and zone creation are multi-statement without a transaction.** `createCity` inserts through Prisma then issues two `$executeRaw` boundary/centre updates; `createServiceZone` inserts then calls `syncZoneVehicleTypes`, itself an untransacted `deleteMany` + `createMany` during which `assertPickupServiceable` sees zero restrictions and admits every vehicle type into the zone.

- **Vehicle types are hardcoded in the fare schema.** `vehicleTypeCodeSchema` is a fixed enum while `VehicleType` is a table. `CAB_PREMIUM` appears in `CODE_TO_UI` but not in `UI_TO_CODE` nor the enum, so no fare rule can be created for it; a rule for an unmapped type is displayed to the admin as `"cab"` because of the `?? 'cab'` fallback.

### What is correct and MUST NOT be redesigned

Authorization end to end — `authPlugin` denies by default in its `onRequest` hook, every new admin route carries an explicit `permissions` pair, every dependency lookup (epoch, revocation, permission, device, driver operability) fails closed, and the permission codes are seeded in `prisma/seed/shared/roles.ts` · the per-module `setErrorHandler` shape, which separates `ZodError`, coded domain errors below 500 and logged `INTERNAL` 500s, applied consistently across all four new route files · parameterised SQL throughout, including the GeoJSON paths — there is no `$queryRawUnsafe` anywhere in the new code · `SurgeService`'s coordinate validation, highest-of-overlaps selection, hard clamp to `[1.0, 2.0]` and fail-open `catch` · the `ZeroDistanceTripError` placement in the shared pricing path with its deliberate non-application to completed rides · `PricingRuleRepository.findGlobalRules`, which batches correctly and applies the effective window · `AdminCouponService.listCoupons`, the correct pagination reference · `GeographicCoverageService`'s `assertPickupServiceable`/`assertDropServiceable` decomposition, which is the right seam even though its callers over-invoke it.

---

## Business Decisions — PENDING

Ten decisions change what money moves and to whom. BD-9 and BD-10 were approved on 2026-08-29 after verification; Each carries a recommended default so planning is not blocked, but **BD-1 and BD-2 must be approved before US2 ships** — either choice is defensible and neither can be picked silently in a pull request.

| ID    | Decision                                                                | Options                                                                                                                                                                                                    | Recommended                                                                                                                                                                                                                        |
| ----- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BD-1  | What is the commission base?                                            | **A** — ride revenue `(subtotal − discount)`, excluding tax, platform fee and booking fee · **B** — as A but including the booking fee · **C** — keep `totalFare`                                          | **A.** Tax is remitted, not earned; the platform fee is already the platform's. Commission on either is not defensible to a driver or an auditor.                                                                                  |
| BD-2  | Who bears a promotional discount?                                       | **A** — the platform: the driver earns on the pre-discount base · **B** — shared pro rata · **C** — the driver, as today                                                                                   | **A.** A driver has no control over a marketing campaign and today silently funds ~80% of every one.                                                                                                                               |
| BD-3  | Are historical `ride_fares` rows corrected?                             | **A** — prospective only, no historical row touched · **B** — recompute and post correcting ledger groups                                                                                                  | **A.** Matches BD-7 of feature 002 and constitution §3.2 / §17.2. Quantify the exposure in a read-only report instead.                                                                                                             |
| BD-4  | Surge zones and service zones                                           | **A** — delete `SurgeZone`; put `serviceZoneId` on `SurgeWindow` · **B** — keep `SurgeZone`, add a real `cityId` FK and a containment check                                                                | **A.** Smaller schema, removes the duplicate-polygon workflow, and is what the feature summary already claims is true.                                                                                                             |
| BD-5  | The three unreachable service types                                     | **A** — thread `serviceType` through the ride paths now · **B** — remove them from the admin schema until the ride side supports them                                                                      | **B for this feature.** Shipping an admin form that writes rows the runtime cannot read is worse than not offering it; A is its own feature.                                                                                       |
| BD-6  | When may a referral code be applied?                                    | **A** — only if the referee has no completed ride · **B** — within N days of `user.createdAt` · **C** — both, whichever is stricter                                                                        | **C**, with N configurable through `numericEnv`. A alone lets a year-old dormant account claim; B alone lets a new account that already rode claim.                                                                                |
| BD-7  | May more than one referral program be active per audience?              | **A** — no; activating one deactivates the incumbent · **B** — yes, but a referee may be referred at most once across all programs                                                                         | **A.** Mirrors `AdminFareService`'s existing rule-exclusivity pattern and removes the multiplied-payout path outright.                                                                                                             |
| BD-9  | How does the vehicle-type catalog publish rate figures?                 | **A** — drop them; the quote is the only price source · **B** — accept optional `lat`/`lng` and resolve exactly as the quote does · **C** — city-level only, documenting that zone rules are not reflected | **APPROVED: B.** The endpoint takes only `cityId` today, so zone rules cannot be resolved there at all — see FR-041. Additive to the contract; the client already holds the pickup point on that screen.                           |
| BD-10 | What happens when a pickup falls outside every configured city polygon? | **A** — always fail closed · **B** — fail closed only when coverage is configured, otherwise fall back to GLOBAL · **C** — always fall back to GLOBAL                                                      | **APPROVED: B.** If any active city has a boundary, coverage is real and an uncovered pickup is refused. If none does, coverage is unconfigured and the platform must still sell — with a loud metric, never silently. See FR-048. |
| BD-8  | Do granted referral rewards expire?                                     | **A** — no; `rewardExpiryDays` is renamed to what it actually does and `ReferralReward.expiresAt` is dropped · **B** — yes; the column is written and swept                                                | **A.** No product requirement for it has been stated, and an unwritten expiry column reads as an implemented feature. See F7 in §Finding Traceability.                                                                             |

---

## User Scenarios & Testing _(mandatory)_

### User Story 1 — A completed ride is billed on the rate card it was quoted on (Priority: P1)

An operator sets an airport-zone rate card for Bengaluru. A customer is quoted at that card and completes the ride. The invoice, the `ride_fares` row and the settlement all reflect that same card.

**Why P1**: without it, every zone-scoped and city-scoped rate card an operator creates is decoration. It is also the smallest of the money fixes and unblocks confidence in the rest.

**Acceptance**

1. Given an active zone rule for a pickup inside that zone, when the ride completes, then the persisted fare is computed from that rule and not from `pricingConfig.defaultRateCard`.
2. Given a rule scheduled with `effectiveFrom` in the future, when a ride is quoted or completed, then that rule is not selected.
3. Given a rule whose `effectiveTo` has passed, when a ride is quoted or completed, then that rule is not selected.
4. Given an admin edits the rule while a ride is in progress, when that ride completes, then it is billed on the rule resolved at booking, not the edited one.

### User Story 2 — The fare splits correctly between driver, platform and tax (Priority: P2)

A completed ride's fare divides into exactly four parts that sum to the amount charged: driver earnings, platform commission, platform fee and tax.

**Why P2**: the largest single mis-statement of money in the system, and it touches every completed ride. Gated on BD-1 and BD-2.

**Acceptance**

1. For any fare, `driverEarning + platformCommission + platformFee + taxAmount == totalFare`, exactly, with no rounding residue.
2. Commission is computed on the base BD-1 selects and on no larger base.
3. Given a promotion applies and the minimum-fare floor would otherwise win, when the fare is computed, then the customer's bill is reduced by the discount and the recorded `discountAmount` equals the reduction actually granted.
4. Given a rule with `platformFeePct = 0` and no flat fee configured on the rule, when the fare is computed, then no platform fee is charged.
5. Every monetary output is derived without an intermediate binary-float rounding step.

### User Story 3 — A promotion cannot be used beyond its limits (Priority: P3)

A promotion capped at 1,000 total uses and one per rider is redeemed at most 1,000 times, at most once per rider, under concurrency.

**Why P3**: unbounded marketing liability with a documented concurrent path, and one sub-part is exploitable from a single admin endpoint.

**Acceptance**

1. Given a promotion at `usedCount = usageLimitTotal − 1`, when N rides complete concurrently, then exactly one redemption succeeds and the rest fail with a coded error.
2. Given a rider with a `usageLimitPerUser = 1` promotion, when two of their rides complete concurrently, then exactly one redemption is recorded.
3. Given a coupon batch whose `totalCount` is fully generated, when generation is requested again, then it is refused and `totalCount` is unchanged.
4. Given a promotion restricted to one vehicle type, when eligibility is evaluated without a vehicle type in context, then the promotion is refused.
5. Given a percentage promotion, when it is created without a maximum discount, then creation is refused.

### User Story 4 — A referral reward is paid exactly once, or is not marked paid (Priority: P4)

A referral qualifies once per genuine qualifying ride, pays once, and is never marked `REWARDED` unless the money actually moved.

**Why P4**: the driver program is new, pays into the settlement wallet, and has both a replay path and a silent-loss path.

**Acceptance**

1. Given a `ride.completed` event delivered twice for the same ride, when both are processed, then `qualifyingRides` advances by exactly one.
2. Given a program whose reward wallet does not exist for the beneficiary, when qualification occurs, then the transaction rolls back, the referral is not `REWARDED`, and the failure is visible in metrics.
3. Given a referral code applied concurrently by N users against a code at its cap, when all are processed, then the cap is not exceeded.
4. Given a rider ineligible under BD-6, when they apply a referral code, then it is refused.
5. Given the referrer and referee share a device identifier, when the code is applied, then a `ReferralFraudFlag` is recorded and the reward is withheld pending review.

### User Story 5 — Surge applies only when the operator said it should (Priority: P5)

A surge window configured as peak-hour-only for 08:00–10:00 multiplies fares during those hours in the city's timezone and at no other time.

**Why P5**: the admin UI currently asserts a constraint the pricing path ignores, which is worse than the feature being absent.

**Acceptance**

1. Given `isPeakHourOnly` with a window of 08:00–10:00, when a fare is quoted at 03:00 local, then the multiplier is 1.0.
2. Peak hours are evaluated in the pickup city's `timezone`, not the server's.
3. Given a surge zone and a service zone describing the same area, when either is edited, then there is exactly one polygon of record (BD-4).
4. Given surge resolution fails, when a fare is quoted, then the multiplier is 1.0 **and** a failure counter increments.

### User Story 6 — Serviceability and pricing resolve a pickup point once, from an index (Priority: P6)

A multi-category quote resolves the city, the zones and the surge state once and answers within a budget that does not grow with the number of categories.

**Why P6**: it is the customer app's first screen and it currently scales linearly in unindexed spatial scans.

**Acceptance**

1. A quote across N vehicle types performs a constant number of spatial queries, independent of N.
2. Every spatial predicate used in a request path is answerable from an index.
3. Given overlapping service zones, when a point falls in both, then the resolved zone is deterministic and documented — not creation order.
4. The 95th-percentile quote latency for six categories improves measurably against a recorded baseline.

### User Story 7 — An admin change is atomic and attributable (Priority: P7)

Every change to a fare rule, a boundary, a surge window, a promotion or a referral program either fully applies or does not, and records who made it.

**Why P7**: these endpoints set the terms of every subsequent money movement and currently leave no trace.

**Acceptance**

1. Given a failure part-way through a fare-rule edit, when the request returns, then the previously active rule is still active.
2. Two concurrent activations for the same rule key leave exactly one active rule.
3. Every `canWrite` route records actor, action, entity, entity id and before/after state.
4. `PATCH`/`DELETE` against a non-existent surge zone returns `404`, not `200`.
5. Activating a city with no boundary is refused.

### Edge Cases

- A ride quoted before an admin edit and completed after it — US1 acceptance 4 requires the booked rule, which implies persisting the resolved rule id.
- A promotion whose discount exceeds the subtotal — already clamped; must remain clamped after BD-2 moves the discount off the driver's base.
- A referral program deactivated between qualification and reward — a reward already granted must not be reversed; a not-yet-qualified referral must stop.
- A city whose `code` an admin attempts to change while fare rules reference it.
- A service zone polygon edited so that an in-progress ride's pickup is no longer inside it.
- A surge window whose `endsAt` passes mid-ride.
- Referee and referrer are the same human with two accounts — BD-6 and fraud flagging bound but do not eliminate this.
- A coupon batch generation request for a count larger than the remaining allowance.

---

## Requirements _(mandatory)_

### Fare resolution

- **FR-001** The rate card used to compute a ride's final fare MUST be the one resolved for that ride's pickup city, service zone and service type.
- **FR-002** The resolved pricing rule identifier MUST be persisted on the ride request at booking, and the final fare MUST be computed from that rule.
- **FR-003** Active-rule selection MUST honour `effectiveFrom` and `effectiveTo` on every path, matching `findGlobalRules`.
- **FR-004** Exactly one resolver MUST determine which service zone a point falls in, and it MUST NOT return a `RESTRICTED` zone for pricing.
- **FR-005** Overlapping-zone resolution MUST be deterministic by an explicit, stored precedence rather than by creation order. **Verified broken**: `pricing-rule.repository.ts:33` orders by `created_at ASC LIMIT 1`, so a point inside a citywide zone _and_ a nested airport zone resolves to the citywide one and the airport rule is never probed. `tests/integration/pricing-rule-resolution.test.ts:62` fails at HEAD (expected 120, got 50). **Moved into Phase 1**: FR-001 and FR-004 cannot be proven while this holds.
- **FR-048** Pickup serviceability MUST distinguish _configured and uncovered_ from _not configured at all_, per BD-10. When at least one active city has a boundary, a pickup outside every polygon MUST be refused. When no active city has a boundary, coverage is unconfigured: the request MUST proceed on GLOBAL pricing and MUST emit a metric so the unconfigured state is observable. **Verified**: `cities` is empty in the test database, `prisma/seed/**` creates none, and the `ensureCity` fixture cannot write a boundary because Prisma models it as `Unsupported(...)` — so 12 of 24 `vehicle-catalog` tests fail with `OUTSIDE_SERVICE_AREA` and no ride can be quoted or booked in any environment. _(Closes the 47th finding, absent from the original review.)_
- **FR-041** Per BD-9 B, the vehicle-type catalog MUST accept optional pickup coordinates and, when given them, resolve rate figures on the same city, zone and service-type basis as the quote. When coordinates are absent it MUST NOT publish a rate figure. **Verified**: `vehicle-type.controller.ts:63` reads only `cityId`, so zone resolution is impossible there without this contract change. _(Closes A6.)_

### Fare computation

- **FR-006** `driverEarning + platformCommission + platformFee + taxAmount` MUST equal `totalFare` exactly for every computed fare.
- **FR-007** Commission MUST be computed on the base selected by BD-1 and MUST NOT include tax or the platform fee.
- **FR-008** A promotional discount MUST reduce the amount the customer pays; where the minimum-fare floor binds, the recorded discount MUST equal the reduction actually granted.
- **FR-009** The platform fee MUST come from the resolved rule; the environment default MUST apply only when no rule matched.
- **FR-010** Monetary arithmetic MUST be performed without intermediate binary-float rounding.
- **FR-011** `price()` MUST clamp the surge multiplier to the configured bounds regardless of caller.
- **FR-012** The duplicated free-waiting field MUST be reduced to one, and any environment variable with no reader MUST be removed.
- **FR-047** Schema that no code path reads MUST be removed rather than left in place: `TollZone`, `TaxConfig`, `PricingRule.includedKm` and `PricingRule.nightMultiplier` together with the surrounding night-charge parameters. Where a table cannot be dropped in this release for §16.2 reasons, its removal MUST be scheduled in a named follow-up migration. _(Closes B7.)_

### Surge

- **FR-013** Peak-hour restrictions MUST be evaluated, in the pickup city's timezone, before a window contributes a multiplier.
- **FR-014** Demand and supply threshold columns MUST either be evaluated or removed; they MUST NOT remain writable and inert.
- **FR-015** Surge geography MUST have exactly one polygon of record per area, per BD-4.
- **FR-016** Surge resolution failure MUST increment a metric in addition to returning the safe default.

### Promotions

- **FR-017** Total and per-user usage limits MUST be enforced by a database constraint or by a conditional update whose affected-row count decides the outcome — not by a prior read.
- **FR-018** An eligibility restriction that cannot be evaluated from the supplied context MUST deny.
- **FR-019** Coupon generation MUST refuse once a batch's allowance is exhausted and MUST NOT widen `totalCount`.
- **FR-020** A percentage promotion MUST have a bounded value and a required maximum discount.
- **FR-021** Segment rule fields accepted by the admin schema MUST be evaluated by the matcher, or removed from the schema.
- **FR-043** `usageLimitPerUser` MUST have one unambiguous meaning enforced at the column: either nullable with `null` meaning unlimited, matching `usageLimitTotal`'s convention, or `CHECK (usage_limit_per_user >= 1)`. It MUST NOT remain a value whose zero case silently denies every user. _(Closes E7.)_
- **FR-044** Promotion and coupon code lookup MUST be answerable from an index. _(Closes E8.)_

### Referrals

- **FR-022** Ride qualification MUST be idempotent per `(referral, ride)`, enforced by a database uniqueness guarantee.
- **FR-023** A referral MUST NOT be marked `REWARDED` unless every due reward was actually credited in the same transaction.
- **FR-024** `PENDING` rewards MUST be observable and recoverable.
- **FR-025** Referral code application MUST verify referee eligibility per BD-6.
- **FR-026** At most one referral program per audience MUST be active, per BD-7.
- **FR-027** The per-code usage cap MUST be enforced by a conditional update, and the whole apply path MUST be one transaction.
- **FR-028** A referral matching a defined fraud signal MUST record a `ReferralFraudFlag` and withhold the reward pending review.
- **FR-045** The per-referrer cap MUST be read from the program at the moment a code is applied, so that an administrator's change to `maxReferralsPerUser` takes effect for codes already issued. _(Closes F6.)_
- **FR-046** Reward expiry MUST be resolved per BD-8: either `rewardExpiryDays` is renamed to name the qualification window it actually bounds and `ReferralReward.expiresAt` is dropped, or the column is written and swept. A field named for behaviour it does not have MUST NOT survive this feature. _(Closes F7.)_

### Geographic and admin integrity

- **FR-029** A city's `code` MUST NOT be mutable while any row references it, or the referencing columns MUST become foreign keys.
- **FR-030** A city MUST NOT be activatable without a boundary.
- **FR-031** City and service-zone creation, and vehicle-type synchronisation, MUST be transactional.
- **FR-032** Polygon validity MUST be asserted on create as well as on update, on every geometry-accepting endpoint.
- **FR-042** A containment assertion that cannot be evaluated MUST fail rather than pass. A service zone MUST NOT be creatable against a city that has no boundary to contain it. _(Closes C7; compounds with FR-030.)_
- **FR-033** An admin mutation against a non-existent entity MUST return `404`.
- **FR-034** Fare-rule create, update and activate MUST be transactional, and "one active rule per key" MUST be enforced by a database index.
- **FR-035** Every admin write route MUST record actor, action, entity, entity id and before/after state.
- **FR-036** Vehicle types accepted by the fare schema MUST be validated against the `vehicle_types` table, not a hardcoded enum.
- **FR-037** Admin fields with no persistent destination MUST be removed from their schemas.

### Performance

- **FR-038** Every boundary column used in a request-path spatial predicate MUST have an index the predicate can use.
- **FR-039** A multi-category quote MUST resolve city, zone, surge and promotion state a constant number of times.
- **FR-040** Admin list endpoints MUST paginate and filter in the database.

### Key Entities

- **PricingRule** — gains a flat platform fee; loses nothing. Its selection becomes window-aware and its uniqueness becomes an index.
- **RideRequest** — gains the resolved pricing rule reference so the bill can reproduce the quote.
- **ServiceZone** — gains an explicit precedence; becomes the single geography of record if BD-4 chooses A.
- **SurgeWindow** — gains timezone-correct peak-hour evaluation; gains `serviceZoneId` under BD-4 A.
- **PromotionRedemption** — gains a uniqueness guarantee.
- **ReferralQualifyingRide** _(new)_ — the `(referralId, rideId)` uniqueness that makes qualification idempotent.
- **ReferralFraudFlag** — gains its first writer.
- **AdminAuditEntry** _(new or activated)_ — the actor record for every admin write.

---

## Finding Traceability

All 46 review findings, with the disposition of each. **No finding is unaccounted for.** Four dispositions are used:

- **Requirement** — covered by the named FR, in scope, will be built.
- **Decision** — the disposition depends on a pending BD; the BD names both branches.
- **Deferred** — a real defect, deliberately not built in this feature, with the reason and the trigger that would bring it forward.
- **Accepted** — acknowledged, no action planned; the cost of the fix exceeds the cost of the defect.

`Sev` is the severity from the review.

| ID  | Sev      | Finding                                                  | Disposition                                                                                                                                                                                                                                |
| --- | -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Critical | Final bill ignores city and zone                         | **Requirement** — FR-001, FR-002 (Phase 1)                                                                                                                                                                                                 |
| A2  | Critical | `SurgeZone` unlinked from geographic zones               | **Decision** — BD-4 → FR-015 (Phase 5)                                                                                                                                                                                                     |
| A3  | High     | `serviceType` never passed by any caller                 | **Decision** — BD-5. Recommendation B removes the unreachable values; wiring them is out of scope                                                                                                                                          |
| A4  | High     | Effective window ignored in rule selection               | **Requirement** — FR-003 (Phase 1)                                                                                                                                                                                                         |
| A5  | Medium   | Two disagreeing zone resolvers                           | **Requirement** — FR-004 (Phase 1)                                                                                                                                                                                                         |
| A6  | Medium   | Catalog advertises GLOBAL, quote charges zone            | **Requirement** — FR-041 (Phase 1)                                                                                                                                                                                                         |
| B1  | Critical | Commission on tax and platform fee                       | **Decision → Requirement** — BD-1, BD-2 → FR-006, FR-007 (Phase 2)                                                                                                                                                                         |
| B2  | High     | Minimum-fare floor applied after discount                | **Requirement** — FR-008 (Phase 2)                                                                                                                                                                                                         |
| B3  | High     | Duplicate free-waiting field, dead env var               | **Requirement** — FR-012 (Phase 2)                                                                                                                                                                                                         |
| B4  | Medium   | Binary-float money arithmetic                            | **Requirement** — FR-010 (Phase 2)                                                                                                                                                                                                         |
| B5  | Medium   | `platformFeePct = 0` inherits the env flat fee           | **Requirement** — FR-009 (Phase 2)                                                                                                                                                                                                         |
| B6  | Medium   | Surge multiplier unclamped in `price()`                  | **Requirement** — FR-011 (Phase 1)                                                                                                                                                                                                         |
| B7  | Note     | Night charge, `TollZone`, `TaxConfig`, `includedKm` dead | **Requirement** — FR-047 (Phase 6). Removal only; building these is out of scope                                                                                                                                                           |
| C1  | Critical | No GiST index on any boundary column                     | **Requirement** — FR-038 (Phase 5)                                                                                                                                                                                                         |
| C2  | Critical | Quote loop re-resolves everything per category           | **Requirement** — FR-039 (Phase 5)                                                                                                                                                                                                         |
| C3  | High     | `updateCity` boundary guard is dead code                 | **Requirement** — FR-030 (Phase 6)                                                                                                                                                                                                         |
| C4  | High     | `city.code` mutable across five join tables              | **Requirement** — FR-029 (Phase 6)                                                                                                                                                                                                         |
| C5  | Medium   | City and zone creation untransacted                      | **Requirement** — FR-031 (Phase 6)                                                                                                                                                                                                         |
| C6  | Medium   | Overlapping zones resolve by creation order              | **Requirement** — FR-005 (Phase 5)                                                                                                                                                                                                         |
| C7  | Note     | Containment check passes when city has no boundary       | **Requirement** — FR-042 (Phase 6)                                                                                                                                                                                                         |
| D1  | High     | Peak-hour and threshold fields never evaluated           | **Requirement** — FR-013, FR-014 (Phase 5)                                                                                                                                                                                                 |
| D2  | Medium   | `createSurgeZone` skips polygon validation               | **Requirement** — FR-032 (Phase 6)                                                                                                                                                                                                         |
| D3  | Medium   | Mutating a non-existent surge zone returns 200           | **Requirement** — FR-033 (Phase 6)                                                                                                                                                                                                         |
| D4  | Medium   | Blanket `catch` hides surge failure                      | **Requirement** — FR-016 (Phase 5)                                                                                                                                                                                                         |
| D5  | Note     | `gen_random_uuid()` where the schema uses `uuid(7)`      | **Requirement** — folded into FR-032's Phase 6 work on the same two raw inserts. No separate FR; the fix is to omit the id column and let the default apply                                                                                |
| E1  | Critical | Usage limits are check-then-act                          | **Requirement** — FR-017 (Phase 3)                                                                                                                                                                                                         |
| E2  | High     | Vehicle-type restriction admits on missing context       | **Requirement** — FR-018 (Phase 3)                                                                                                                                                                                                         |
| E3  | High     | Coupon cap bypass via falsy `remaining`                  | **Requirement** — FR-019 (Phase 3)                                                                                                                                                                                                         |
| E4  | Medium   | Segment `firstRideOnly` accepted and ignored             | **Requirement** — FR-021 (Phase 3)                                                                                                                                                                                                         |
| E5  | Medium   | Percentage discount unbounded and uncapped               | **Requirement** — FR-020 (Phase 3)                                                                                                                                                                                                         |
| E6  | Medium   | Campaign targets re-fetched per category                 | **Requirement** — FR-039 (Phase 5)                                                                                                                                                                                                         |
| E7  | Note     | `usageLimitPerUser = 0` means "never", not "unlimited"   | **Requirement** — FR-043 (Phase 3)                                                                                                                                                                                                         |
| E8  | Note     | Case-insensitive code lookup cannot use the index        | **Requirement** — FR-044 (Phase 3)                                                                                                                                                                                                         |
| F1  | Critical | Ride qualification not idempotent                        | **Requirement** — FR-022 (Phase 4)                                                                                                                                                                                                         |
| F2  | Critical | Missing wallet loses the reward silently                 | **Requirement** — FR-023, FR-024 (Phase 4)                                                                                                                                                                                                 |
| F3  | Critical | `applyAtSignup` reachable post-signup; multi-program     | **Decision → Requirement** — BD-6, BD-7 → FR-025, FR-026 (Phase 4)                                                                                                                                                                         |
| F4  | High     | Code cap check-then-increment; untransacted apply        | **Requirement** — FR-027 (Phase 4)                                                                                                                                                                                                         |
| F5  | High     | `ReferralFraudFlag` has no writer                        | **Requirement** — FR-028 (Phase 4), bounded by the ceiling in the plan's Complexity Tracking                                                                                                                                               |
| F6  | Medium   | `maxReferralsPerUser` snapshotted at code creation       | **Requirement** — FR-045 (Phase 4)                                                                                                                                                                                                         |
| F7  | Medium   | `rewardExpiryDays` misnamed; reward expiry unbuilt       | **Decision** — BD-8 → FR-046 (Phase 4)                                                                                                                                                                                                     |
| F8  | Note     | Milestone loop queries inside the reward transaction     | **Accepted** — the `@@unique([milestoneId, userId])` already guarantees correctness; the cost is a few queries per reward against a milestone count in single digits. Revisit if reward-transaction duration is ever measured as a problem |
| G1  | High     | No audit trail on new admin write endpoints              | **Requirement** — FR-035 (Phase 6)                                                                                                                                                                                                         |
| G2  | High     | Fare-rule edit is three untransacted writes              | **Requirement** — FR-034 (Phase 6)                                                                                                                                                                                                         |
| G3  | High     | One-active-rule enforced in app code only                | **Requirement** — FR-034 (Phase 6)                                                                                                                                                                                                         |
| G4  | Medium   | Fare rules paginated in memory                           | **Requirement** — FR-040 (Phase 6)                                                                                                                                                                                                         |
| G5  | Medium   | Hardcoded vehicle enum; three dropped night fields       | **Requirement** — FR-036, FR-037 (Phase 6)                                                                                                                                                                                                 |

### Reconciliation

| Disposition                | Count  |
| -------------------------- | ------ |
| Requirement                | 41     |
| Decision (→ a requirement) | 4      |
| Accepted, no action        | 1      |
| Deferred                   | 0      |
| **Total**                  | **46** |

Two exclusions are recorded as scope boundaries rather than dispositions, because they are decisions about what to _build_, not about whether a defect is addressed: **A3** (BD-5 B removes the unreachable service types; wiring them is a separate feature) and **B7** (FR-047 removes the dead schema; implementing night charging, tolls and `TaxConfig` is separate). In both cases the defect — configuration that does not reach behaviour — is closed by this feature. The absent capability is what is deferred.

---

## Success Criteria _(mandatory)_

- **SC-001** For 100% of completed rides, the persisted fare's four parts sum exactly to the charged total.
- **SC-002** For 100% of completed rides where a zone or city rule matched at quote time, the same rule identifier is recorded on the fare.
- **SC-003** No promotion's recorded redemption count exceeds its configured total limit and no rider exceeds their per-user limit, under a concurrency test that runs the contended paths with `Promise.all`.
- **SC-004** Replaying a `ride.completed` event advances no referral counter and grants no second reward.
- **SC-005** No `ReferralReward` remains `PENDING` beyond the configured sweep interval without being surfaced.
- **SC-006** A peak-hour-only surge window contributes no multiplier outside its hours, verified in a non-server timezone.
- **SC-007** Quote latency for six vehicle categories improves against the recorded pre-change baseline, and the spatial query count per quote is constant in the number of categories.
- **SC-008** Every `canWrite` admin route produces an audit entry, asserted by a route-graph test in the shape of the existing public-route assertion.
- **SC-009** No configuration knob remains that has no reader.
- **SC-010** `eslint --max-warnings=0`, `tsc --noEmit` and the full suite pass; no existing test is weakened (constitution §15.3).

---

## Assumptions

- The zone, promotion and referral features are live in a pre-production or limited-production capacity. If they are fully live, BD-3 needs re-examination and an exposure report becomes a prerequisite rather than a nicety.
- `ride.completed` redelivery is possible but has not been observed producing a duplicate reward in production. FR-022 is preventive.
- `PricingRule` row volume is currently small enough that FR-040's absence has not been felt; the fix is preventive and cheap.
- Cities operate in a single timezone each, as `City.timezone` models.
- The device identifier available through `DeviceRepository` is a usable fraud signal for FR-028. If it is not stable across reinstalls, FR-028's signal set needs revisiting.

## Out of Scope

- Threading `serviceType` through the ride request, quote and completion paths — BD-5 recommends removing the unreachable enum values instead; wiring them is its own feature with its own product decisions about scheduled and rental booking flows.
- Implementing night-hour charging, toll zones or `TaxConfig`. This feature removes or documents them as dead; building them is separate.
- Any redesign of authorization, the error envelope, `SurgeService`'s selection algorithm, or the `GeographicCoverageService` decomposition.
- Historical fare correction and any ledger rewrite — excluded by BD-3 recommendation A.
- Demand-responsive (algorithmic) surge. FR-014 disposes of the inert columns; it does not build the signal.
- The admin frontend under `frontend/`.
