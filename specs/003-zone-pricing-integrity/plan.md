# Implementation Plan: Zone Pricing, Promotion & Referral Integrity

**Branch**: `003-zone-pricing-integrity` · **Spec**: [spec.md](./spec.md)

**Created**: 2026-08-29 · **Last updated**: 2026-08-29

**Status**: **ALL SIX PHASES DELIVERED (2026-08-29).** BD-1 and BD-2 were approved as option **A** and option **A**, unblocking Phase 2.

| Phase                                | State    | Evidence                                                                                  |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| 1 — Bill what you quoted             | **Done** | `tests/integration/zone-fare-parity.test.ts` 15/15                                        |
| 2 — The fare splits correctly        | **Done** | `tests/unit/pricing/fare-split.test.ts` 15/15, `earnings-pipeline` 22/22                  |
| 3 — Limits enforced by the database  | **Done** | `tests/integration/promotion-limits.test.ts` 6/6, `admin-promotions` 6/6                  |
| 4 — Rewards paid once                | **Done** | `tests/integration/referral-rewards.test.ts` 10/10, `admin-referrals` 4/4                 |
| 5 — Zones and surge tell the truth   | **Done** | `tests/unit/pricing/peak-window.test.ts` 8/8; FR-039 asserted by counting spatial queries |
| 6 — The admin surface is trustworthy | **Done** | `tests/integration/admin-surface-integrity.test.ts` 19/19                                 |

**Input**: [spec.md](./spec.md) — 47 functional requirements, 10 success criteria, 8 pending business decisions, and a traceability table dispositioning all 46 review findings.

---

## Summary

Six independently shippable phases, ordered so that the cheapest verification lands first and every later phase can be tested against a system that already tells the truth about which rate card it used.

The through-line: **this feature moves invariants out of application code and into the database.** Almost every defect in the spec is the same shape — a check performed by reading a row, then acting on the value that was read, with nothing between the two. The constitution already names the remedy in §5.2 (conditional claim), §5.4 (uniqueness by index) and §7.3 (consumer safety from a database guarantee). Six of the seven critical findings are instances of a pattern the codebase has solved before, in `RideRepository.updateStatusIf` and `RideDispatchRepository.respondIfPending`.

## Technical Context

| Aspect              | Value                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Language / runtime  | TypeScript, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; Node pinned by `.nvmrc`                |
| Framework           | Fastify 5, Awilix `InjectionMode.CLASSIC`                                                                                |
| Persistence         | PostgreSQL + PostGIS via Prisma 7, `@prisma/adapter-pg`                                                                  |
| Events              | Transactional outbox → `OutboxRelay` → in-process `EventBus`; **at-least-once** (§7.3)                                   |
| Money type          | `Prisma.Decimal` at the boundary; **binary float inside `PricingService` today — this is what FR-010 fixes**             |
| Testing             | `node:test` through `tsx`; unit in `tests/unit/<domain>/`, integration against real Postgres + Redis                     |
| Modules touched     | `pricing`, `geographic`, `promotions`, `referrals`, `rides`, `admin/{pricing,geographic,promotions,referral}-management` |
| Modules NOT touched | `auth`, `payments` (ledger posting shape), `files`, `notifications`, `realtime`, `support`                               |
| Baseline            | `admin-folder` @ `703a76f`; `tsc --noEmit` clean; `tests/unit/pricing` 33/33                                             |

## Constitution Check

_Gate evaluated against ratified constitution v1.0.0._

| §         | REQUIRED rule                                               | Compliance in this plan                                                                                                                                                    |
| --------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.4       | A module owns mutation of its domain                        | `ReferralQualifyingRide` is written only by `referrals`; the audit writer lives in `admin/audit` and is called by admin services only                                      |
| 1.5       | Cross-module reaction goes through consumers                | No new direct service import across modules; the referral fix stays inside its existing consumer                                                                           |
| 2.1       | `exactOptionalPropertyTypes`                                | Conditional-spread idiom for every new optional field, including the new rate-card lookup options                                                                          |
| 2.5       | Comments explain the failure they prevent                   | Each conditional-claim helper carries a `///` block naming the race it closes                                                                                              |
| 3.2       | Migrations additive, forward-only                           | 9 additive migrations + 1 expand/contract rename; 2 drops deferred to a follow-up release per §16.2. **BD-3 recommendation A forbids any historical `ride_fares` rewrite** |
| 3.3       | Raw SQL for partial indexes and CHECKs                      | 3 GiST indexes, 2 partial unique indexes, 1 CHECK — all raw, precedent `20260821130000`                                                                                    |
| 3.4       | `CONCURRENTLY` before deploy on large tables                | The three GiST indexes carry `IF NOT EXISTS` and a header documenting the manual `CONCURRENTLY` step, per `20260822160000`                                                 |
| 3.5       | Verify a constraint against the target DB before deploy     | Pre-flight query specified in §Migration Plan for both partial unique indexes — existing duplicates would fail the migration                                               |
| 4.1       | Value-moving writes inside `TransactionManager.execute`     | `applyAtSignup`, `qualifyAndReward`, all three `AdminFareService` mutators, `createCity`, `createServiceZone`                                                              |
| 4.2       | No third-party call inside a transaction                    | None introduced                                                                                                                                                            |
| 4.3       | Balanced double-entry through `LedgerService`               | **This row was wrong.** The split changes the posting _shape_: see §Phase 2 deviations. The balance assertion held, which is how the error was caught                      |
| 5.1       | Row-lock contended rows                                     | `promotion` row locked before the conditional redemption in the completion transaction                                                                                     |
| 5.2       | Conditional claim for single-winner transitions             | Three new ones: `redeemIfUnderLimit`, `incrementUsesIfUnderCap`, `activateRuleIfSoleActive` — all `respondIfPending` shaped                                                |
| 5.3       | **Redis lock is never the correctness boundary**            | No new Redis lock. Every race in §Concurrency names a database boundary                                                                                                    |
| 5.4       | Uniqueness surviving a lost lock is a DB index              | `promotion_redemptions` partial unique, `referral_qualifying_rides` unique, `pricing_rules` one-active partial unique                                                      |
| 6.4       | No second idempotency mechanism                             | `ReferralQualifyingRide` is a **domain** uniqueness row, not a general idempotency store; the unused `IdempotencyKey` model stays unused                                   |
| 7.1       | `publish(input, tx)` in the same transaction                | No new events. FR-016's surge failure is a metric, not an event (§7.6 — it describes no state transition)                                                                  |
| 7.3       | Consumer safe to run twice, by a DB guarantee               | **FR-022 is precisely this rule being applied**                                                                                                                            |
| 9.1       | Server-authoritative amounts                                | FR-002 makes the billed rate card server-resolved and server-stored; no client field is added                                                                              |
| 10.1/10.2 | Deny-by-default; public routes justified                    | No new public route. `route-graph` allow-list untouched                                                                                                                    |
| 11.2      | UUID pattern on path params                                 | The surge routes already carry `uuidParams`; extended to the geographic and referral admin routes that lack it                                                             |
| 11.3      | A field the client must not control is removed, not ignored | FR-037 removes `nightStartTime`/`nightEndTime` rather than continuing to accept and drop them                                                                              |
| 12.1/12.2 | `numericEnv`, never bare `Number()`                         | 2 new knobs (BD-6 window, reward sweep interval) through `numericEnv`; `RIDE_FREE_WAIT_MIN` deleted                                                                        |
| 12.4      | Every knob documented in `.env.example`                     | Both new knobs added; the deleted one removed                                                                                                                              |
| 13.1–13.4 | Coded errors and the shared envelope                        | New errors extend the existing module base classes; no `setErrorHandler` changes                                                                                           |
| 14.1/14.2 | Genuinely concurrent tests, asserting the invariant         | 6 races, each with a `Promise.all` test asserting "exactly one winner"                                                                                                     |
| 15.3      | **A test is never weakened**                                | The 33 passing pricing assertions encode the _current_ split. Phase 2 rewrites them to the BD-1/BD-2 split — this is a spec change, recorded here, not a weakening         |
| 16.2      | Migrate-then-deploy compatibility                           | §Migration Plan proves each migration safe against the previous running application version                                                                                |
| 17.1      | Money-affecting operations emit a metric                    | New `PricingMetrics`; `SurgeService` failure counter; referral reward failure counter                                                                                      |
| 17.4      | Staff money movement records who and why                    | **FR-035 is this rule applied to the endpoints that set the terms of the movement**                                                                                        |

**Gate result: PASSED**, with one declared exception recorded under Complexity Tracking (§15.3 / the pricing test rewrite).

## Resolved by Code Inspection

Four questions that would otherwise be open, answered from committed code. Each materially shapes the plan.

1. **`RideRequest` has no pricing-rule column, but it does have `surgeMultiplier` persisted at booking and read back at completion** (`ride.prisma:17`, `lifecycle.service.ts:634`). FR-002 therefore follows an established precedent rather than introducing a new idea — add `pricingRuleId` alongside `surgeMultiplier` and read it back the same way. This is why FR-002 is cheap.

2. **`findGlobalRules` already contains the correct effective-window predicate** (`pricing-rule.repository.ts:104-112`). FR-003 is a copy, not a design. No research needed.

3. **`AdminFareService.update` creates a new row rather than mutating** (`fare.service.ts:250`), which means `PricingRule` rows are immutable version records. That makes FR-002 durable — a persisted `pricingRuleId` continues to resolve to the exact numbers used at booking even after an admin edits the rule, which is what US1 acceptance 4 requires. **This also means the one-active partial unique index in FR-034 must be `WHERE is_active`, not a plain unique index**, or every historical version would collide.

4. **`SurgeService` already clamps to `[1.0, 2.0]` and `createSurgeWindowSchema` already caps `multiplier` at 2.0.** FR-011's clamp inside `price()` is therefore defence in depth against a future caller, not a live fix — which is why it is Phase 1 filler rather than its own task.

## Existing Architecture Reused

| Need                                 | Reused from                                                                 | Rather than                |
| ------------------------------------ | --------------------------------------------------------------------------- | -------------------------- |
| Conditional single-winner claim      | `RideRepository.updateStatusIf`, `RideDispatchRepository.respondIfPending`  | A new locking abstraction  |
| Effective-window rule predicate      | `PricingRuleRepository.findGlobalRules`                                     | A new query builder        |
| Correct list pagination              | `AdminCouponService.listCoupons`                                            | A pagination helper        |
| Existence-then-mutate on admin PATCH | `AdminGeographicService.updateServiceZone`                                  | A generic 404 middleware   |
| Rule exclusivity on activate         | `AdminFareService.exclusivityWhere` (kept; gains a DB index behind it)      | Redesigning versioning     |
| Polygon validation                   | `geographic/utils/postgis.ts` `assertValidPolygon` / `assertZoneWithinCity` | New geometry helpers       |
| Spatial index migration shape        | `20260815000000_driver_locations_spatial_index`                             | Inventing a convention     |
| Metrics counter                      | `incrementCounter` from `@core/metrics`, as `RideMetrics` uses it           | A new metrics mechanism    |
| Decimal money type                   | `Prisma.Decimal`, already the type at every persistence boundary            | A money library dependency |

**Nothing in this plan adds a runtime dependency.**

---

## Implementation Strategy

Six phases. Each is independently deployable and independently revertable; each ends with the suite green.

| Phase | Theme                            | Requirements                                                                           | Blocked by                             | Rough size |
| ----- | -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- | ---------- |
| **1** | Bill what you quoted             | FR-001 · FR-002 · FR-003 · FR-004 · FR-011 · **FR-041**                                | —                                      | S          |
| **2** | The fare splits correctly        | FR-006 · FR-007 · FR-008 · FR-009 · FR-010 · FR-012                                    | **BD-1, BD-2**                         | M          |
| **3** | Limits enforced by the database  | FR-017 · FR-018 · FR-019 · FR-020 · FR-021 · **FR-043** · **FR-044**                   | —                                      | M          |
| **4** | Rewards paid once, or not at all | FR-022 · FR-023 · FR-024 · FR-025 · FR-026 · FR-027 · FR-028 · **FR-045** · **FR-046** | BD-6, BD-7, **BD-8** (defaults usable) | L          |
| **5** | Zones and surge tell the truth   | FR-005 · FR-013 · FR-014 · FR-015 · FR-016 · FR-038 · FR-039                           | BD-4, BD-5                             | M          |
| **6** | The admin surface is trustworthy | FR-029 – FR-037 · FR-040 · **FR-042** · **FR-047**                                     | —                                      | M          |

**Why this order.** Phase 1 is the smallest change that makes every later phase testable: until the bill and the quote use the same rate card, no assertion about fare arithmetic means anything, because you cannot tell a math bug from a wrong-card bug. Phase 2 then changes the numbers with confidence. Phases 3 and 4 are independent of both and could run in parallel with a second pair of hands. Phase 5 carries the schema decision (BD-4) and so is deliberately after the money work, not before it. Phase 6 is last because it is the only phase with no correctness consequence for a ride already in flight.

**What ships first if only one thing ships.** Phase 1 followed by Phase 2. Together they are the difference between an invoice that is right and one that is wrong on every ride.

---

## Database Migration Plan

Ten migrations in this order, plus one deliberately deferred to a follow-up release. Nine are additive; migration 10 is the only one that drops anything, and §Deferred drops explains why it is safe there and not earlier. Naming follows the existing `YYYYMMDDHHMMSS_snake_case` convention.

| #   | Migration                             | Phase | Contents                                                                                                                                                                                       | Safe against previous app version                                                                                                                               |
| --- | ------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `..._ride_request_pricing_rule`       | 1     | `ride_requests.pricing_rule_id UUID NULL` + FK `ON DELETE SET NULL` + index                                                                                                                    | Yes — nullable, unread by the old code                                                                                                                          |
| 2   | `..._pricing_rule_platform_fee_flat`  | 2     | `pricing_rules.platform_fee_flat DECIMAL(10,2) NULL`                                                                                                                                           | Yes — nullable; old code reads the env default, new code prefers the column when present                                                                        |
| 3   | `..._promotion_redemption_uniqueness` | 3     | Partial unique on `promotion_redemptions (promotion_id, user_id)`; `CHECK (usage_limit_per_user >= 1)`                                                                                         | **Requires pre-flight** — see below                                                                                                                             |
| 4   | `..._referral_qualifying_rides`       | 4     | New table `referral_qualifying_rides (referral_id, ride_id)`, `@@unique`, FKs, index on `referral_id`                                                                                          | Yes — new table                                                                                                                                                 |
| 5   | `..._service_zone_priority`           | **1** | `service_zones.priority SMALLINT NOT NULL DEFAULT 0` + index `(city_id, priority DESC, created_at)`                                                                                            | Yes — defaulted; old resolver's `created_at` order is the tie-break, so behaviour is unchanged until data is set                                                |
| 6   | `..._surge_window_service_zone`       | 5     | BD-4 A: `surge_windows.service_zone_id UUID NULL` + FK; **backfill from `surge_zones` by polygon equality**; drop of `surge_zones` deferred to a later migration once the backfill is verified | Yes — nullable, additive; the drop is deliberately not in this migration                                                                                        |
| 7   | `..._geo_boundary_spatial_indexes`    | 5     | GiST on `cities.boundary`, `service_zones.boundary`, `surge_zones.boundary`                                                                                                                    | Yes — index only                                                                                                                                                |
| 8   | `..._pricing_rule_one_active`         | 6     | **Delivered differently.** Two GiST **exclusion constraints** over `tsrange(effective_from, effective_to)`, not a partial unique index — see §Phase 6 deviations                               | **Requires pre-flight** — see below                                                                                                                             |
| 9   | `..._promo_code_lookup_index`         | 3     | FR-044: functional unique indexes on `upper(code)` for `promotions` and `coupons`, replacing the `ILIKE`-shaped lookup                                                                         | Yes — index only. The application switches to exact match in the same release; the old `ILIKE` path still works meanwhile                                       |
| 10  | `..._referral_reward_expiry_cleanup`  | 4     | BD-8 A: rename `referral_programs.reward_expiry_days` → `qualification_window_days`; drop `referral_rewards.expires_at` (FR-046)                                                               | **No — column rename is not backward compatible.** Ships as expand/contract: add the new column and backfill in this release, drop the old one in the follow-up |

### Deferred drops

Two removals are deliberately **not** in this feature's migrations, both for constitution §16.2 — the previous application version is still running during a rollout and still reads what would be dropped:

| Drop                                                                                                                                   | Blocked by                                       | Trigger to schedule it                                           |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `surge_zones` table (BD-4 A)                                                                                                           | Migration 6's backfill must be verified first    | One release after Phase 5 deploys and no code path references it |
| `toll_zones`, `tax_configs`, `pricing_rules.included_km`, `.night_multiplier`, `referral_programs.reward_expiry_days` (FR-047, FR-046) | Previous app version reads the rate-card columns | One release after Phase 6 deploys                                |

FR-047 requires this schedule to be named, not merely intended. **Delivered as `specs/003-zone-pricing-integrity/deferred/`** — three `.sql` files, each written in full with its trigger and its pre-flight query in the header, plus a README that says how to schedule one.

They are deliberately **not** stubs inside `prisma/migrations/`: a file in that directory is applied by the next `migrate deploy`, which is precisely what must not happen yet, so a stub there would have defeated its own purpose. Moving a file into `prisma/migrations/` under a fresh timestamp is the whole act of scheduling it.

**This is the one piece of the feature that does not complete within the feature**, and it is recorded here rather than left implicit.

### Phase 2 deviations from this plan

**The plan said the fare split changes only the amounts posted, not the ledger's posting shape. That was wrong, and the ledger is what proved it.**

Under BD-1 A the driver is paid out of ride revenue alone, so FR-006's identity is `driverEarning + platformCommission + platformFee + taxAmount = totalFare`. The trip-payment group debited `totalFare` and credited only the driver and the commission, so it was short by exactly the tax and the platform fee. `postGroup` threw `LedgerImbalanceError` and posted nothing — the balance assertion doing its job, and the reason nine earnings tests failed with _zero_ ledger entries rather than with wrong numbers.

Tax and the platform fee are two amounts that previously had no destination. Three consequences, all forced rather than chosen:

1. **Two new ledger accounts**, `TAX_PAYABLE` and `PLATFORM_FEE`. `account` is a plain string column, so no migration. `fareDestinationLegs` builds the credit side once and all three posting sites use it.
2. **The cash driver owes more than the commission.** They collected the whole fare, so they owe back everything that is not their earning — commission _plus_ tax _plus_ the platform fee. The settlement-wallet debit and `alreadyRecoveredCommission` both follow.
3. **`netPayable` is no longer `collectedFare − commission`.** That identity held only because commission was levied on the total and so absorbed the other two; keeping it would have overpaid every driver by the tax and the fee on every non-cash ride. `aggregateEarnings` now returns `earnedOnCollected` and `owedOnCash` directly.

A negative `platformCommission` is possible and intended: under BD-2 A a discount larger than the platform's margin means the platform really did pay out more than it collected. `signedLeg` posts it as a debit rather than dropping it, so the loss is on the books instead of missing from them.

**This exceeds the Phase 2 file list in the plan, and the "do not redesign the payments/ledger posting shape" instruction.** It is reported rather than hidden: BD-1 A and BD-2 A cannot be delivered inside the pricing module alone, and the alternative — leaving the ledger as it was — is a system where every ride completion throws.

### Phase 6 deviations from this plan

Four, each with the reason it was necessary:

1. **`AdminAuditService` + `AdminAuditRepository` were not built.** `AdminActivityLog` and `AuditFieldChange` already exist in the schema, and four admin modules (driver, rider, vehicle, application) already write to the first. FR-035's gap was that the geographic and pricing surfaces did not — not that there was nowhere to write. `modules/admin/audit/index.ts` is a single `recordAdminAction` function over the existing table, so the eight admin modules now share one shape instead of inlining five. `AuditFieldChange` stays unused: before/after go into `metadata`, because nothing in the product reads a field-level diff.

2. **FR-034 is enforced by exclusion constraints, not a partial unique index.** The planned index was built, applied, and then failed a regression: it forbade the one thing FR-003 exists to support — staging a future-dated rate change beside the card that is live today. "Active" in `pricing_rules` means "not retired", never "in force now", which is exactly why FR-003 had to add an `inForce(now)` predicate. The invariant is therefore about **overlapping effective windows**, which a unique index cannot express. Split in two because `NULL = NULL` never matches in a GiST exclusion constraint, and `service_type` is a nullable enum whose `::text` cast is STABLE and so illegal in an index expression.

3. **D5's premise was wrong.** The finding read `@default(uuid(7))` as a database default that `gen_random_uuid()` was overriding. It is generated by the Prisma client; `service_zones.id` and `surge_zones.id` have no column default at all, so removing the value made the insert fail on NOT NULL. The real defect — those two tables carrying v4 ids while every other row is v7 — is fixed by calling the codebase's existing `uuidV7()` from `@shared/crypto`.

4. **`createPricingRuleDirect` now supersedes.** `resetState` re-seeds one GLOBAL rule per catalog vehicle type, and the fixture inserted a second active rule on that key. Several tests were quietly depending on the very state FR-034 forbids. The fixture now deactivates the incumbent first, which is what `AdminFareService.create` does — the only path that creates rules in production.

### Pre-flight verification (constitution §3.5)

Migrations 3 and 8 add constraints that can fail against existing rows. Neither is assumed clean. Before deploy, run and resolve:

```sql
-- 3: existing duplicate redemptions per (promotion, user)
SELECT promotion_id, user_id, COUNT(*) FROM promotion_redemptions
GROUP BY 1,2 HAVING COUNT(*) > 1;

-- 3: rows that would violate the CHECK
SELECT id FROM promotions WHERE usage_limit_per_user < 1;

-- 8: keys whose live rules cover overlapping effective windows
SELECT a.id, b.id, a.vehicle_type_id, a.city_code
FROM pricing_rules a
JOIN pricing_rules b
  ON a.id < b.id
 AND a.vehicle_type_id = b.vehicle_type_id
 AND a.city_code = b.city_code
 AND a.service_type IS NOT DISTINCT FROM b.service_type
 AND a.service_zone_id IS NOT DISTINCT FROM b.service_zone_id
 AND tsrange(a.effective_from, a.effective_to) && tsrange(b.effective_from, b.effective_to)
WHERE a.is_active AND b.is_active;
```

Duplicates found by the third query are the concurrency defect of FR-034 having already occurred, and must be resolved by choosing a winner per key before the index is created — not by weakening the index.

### `CONCURRENTLY` note (constitution §3.4)

Migration 7's three GiST indexes cannot be built with `CONCURRENTLY` inside Prisma's migration transaction. On any environment where `cities` or `service_zones` is non-trivial, build them manually with `CREATE INDEX CONCURRENTLY` **before** `migrate deploy`; the migration carries `IF NOT EXISTS` so it degrades to a no-op. The migration file must carry this in its header comment, as `20260822160000_ride_dispatch_timeout_index` does.

### The `surge_zones` drop

Deliberately **not** in migration 6. Dropping a table in the same release that stops writing it violates §16.2 — the previous application version is still running during the rollout and still reads `surge_zones`. The drop is a follow-up migration once the backfill is verified and no code path references it. Recorded in Risks.

---

## Module and File Change Plan

### New components — and why existing code cannot be reused

| Component                                    | Home                                         | Why it must be new                                                                                                                           |
| -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PricingMetrics`                             | `modules/pricing/metrics/pricing.metrics.ts` | Every other money-affecting module has one (§17.1); pricing does not. Carries surge-resolution failure and rate-card fallback counters       |
| `ReferralQualifyingRideRepository`           | `modules/referrals/repositories/`            | The uniqueness of FR-022 is a new table; no existing repository owns it                                                                      |
| `AdminAuditService` + `AdminAuditRepository` | `modules/admin/audit/`                       | The directory exists and is empty. FR-035 has no existing writer anywhere                                                                    |
| `PeakWindow` evaluator                       | `modules/pricing/utils/peak-window.ts`       | Timezone-correct `HH:mm`-in-city-timezone comparison, including windows that cross midnight. Pure function, unit-testable without a database |
| `CityTimezoneResolver` (or a cached read)    | `modules/geographic/services/`               | FR-013 needs the pickup city's timezone in the surge path, which currently receives only coordinates                                         |

### Modified files, by phase

**Phase 1 — Bill what you quoted**

- `pricing/repositories/pricing-rule.repository.ts` — apply the effective window (FR-003); delete `resolveServiceZoneAtPoint` in favour of the coverage service (FR-004); add `findById`
- `pricing/services/pricing.service.ts` — accept a pre-resolved rule; clamp surge in `price()` (FR-011)
- `pricing/domain/pricing.types.ts` — `pricingRuleId` on `FinalFareParams`
- `rides/services/request/ride-request.service.ts` — persist the resolved rule id at booking (FR-002)
- `rides/repositories/ride-request.repository.ts` — `create` is a raw `$executeRaw` INSERT with an explicit column list (required for the PostGIS `pickup_location`), so the new column goes into the raw SQL **and** `CreateRideRequestInput` — not a Prisma `create`
- `rides/services/lifecycle/lifecycle.service.ts` — **three call sites, not two** (an earlier draft of this plan said two, and verification corrected it): `calculateFinalFare` at `:611` (the promo preview) and `:635` (the final fare) both need `request.pricingRuleId`. Fixing only `:635` evaluates promo eligibility and percentage discounts against a GLOBAL-priced subtotal while billing on the zone card
- `geographic/services/geographic-coverage.service.ts` — becomes the sole zone resolver (FR-004); zones ordered by explicit precedence (FR-005); BD-10 coverage gate (FR-048)
- `geo/metrics/geo.metrics.ts` — the unconfigured-coverage counter FR-048 requires
- `vehicles/controllers/vehicle-type.controller.ts` + `pricing/services/pricing.service.ts` — catalog rate figures resolved on the same basis as the quote, or withdrawn (FR-041). The stale doc comment on `rateCardsForTypeIds` asserting quote/catalog parity is corrected in the same change

**Phase 2 — The fare splits correctly** _(gated on BD-1, BD-2)_

- `pricing/services/pricing.service.ts` — `price()` reworked to `Prisma.Decimal` throughout (FR-010); commission base per BD-1 (FR-007); floor before discount (FR-008); rule-sourced platform fee (FR-009)
- `config/pricing/pricing.config.ts` — delete `freeWaitingMinutes` and `RIDE_FREE_WAIT_MIN` (FR-012)
- `admin/pricing-management/fare.{schemas,service}.ts` — `platformFeeFlat` in and out of the DTO
- `.env.example` — remove the deleted knob

**Phase 3 — Limits enforced by the database**

- `promotions/promotion.service.ts` — `redeemIfUnderLimit` conditional claim (FR-017); vehicle-type restriction denies on a missing context value (FR-018); `firstRideOnly` segment rule evaluated (FR-021)
- `promotions/errors.ts` — `PromoLimitReachedError`
- `admin/promotions-management/coupon.service.ts` — the `remaining || count` fix (FR-019)
- `admin/promotions-management/schemas.ts` — percentage bounds and required cap (FR-020); `usageLimitPerUser` semantics settled at the column (FR-043)
- `promotions/promotion.service.ts` — code lookup switched from `mode: 'insensitive'` to exact match against the normalised value, backed by migration 9 (FR-044)
- `referrals/referral-apply.service.ts` — the same `mode: 'insensitive'` lookup on `referralCode.code` (FR-044). Included here rather than in Phase 4 because it is the same one-line change against the same migration

**Phase 4 — Rewards paid once, or not at all**

- `referrals/referral-runtime.service.ts` — qualification writes a `ReferralQualifyingRide` first and derives the count from it (FR-022); `grantReward` throws rather than returning (FR-023); reward-failure metric
- `referrals/referral-apply.service.ts` — whole method in one transaction; `incrementUsesIfUnderCap` conditional claim (FR-027); BD-6 eligibility gate (FR-025); fraud signal evaluation (FR-028)
- `referrals/referral.errors.ts` — `RefereeNotEligibleError`, `ReferralUnderReviewError`
- `admin/referral-management/program.service.ts` — one active program per audience (FR-026)
- `jobs/` — a `PENDING` reward sweep (FR-024), registered alongside the existing maintenance handlers
- `referrals/referral-apply.service.ts` — the per-referrer cap read from the program rather than from the code row (FR-045). `ReferralCode.maxUses` becomes a display value only, and `referral-code.service.ts:84` stops snapshotting it as the enforcement source
- `referrals/referral-apply.service.ts` + `admin/referral-management/{schemas,program.service}.ts` — BD-8 A: `rewardExpiryDays` renamed to `qualificationWindowDays` end to end; `ReferralReward.expiresAt` writes removed (FR-046)

**Phase 5 — Zones and surge tell the truth** _(BD-4, BD-5)_

- `pricing/repositories/surge.repository.ts` — peak-hour and zone-source changes
- `pricing/services/surge.service.ts` — evaluate the peak window (FR-013); failure counter (FR-016)
- `admin/pricing-management/surge.{schema,service}.ts` — remove or wire the threshold columns (FR-014)
- `admin/pricing-management/fare.schemas.ts` — remove the three unreachable service types under BD-5 B
- `rides/services/request/ride-request.service.ts` — hoist city, zone, surge and promo resolution out of the category loop (FR-039)
- `geographic/services/geographic-coverage.service.ts` — priority-ordered zone resolution (FR-005); a batch entry point for the hoisted call

**Phase 6 — The admin surface is trustworthy**

- `admin/geographic-management/admin-geographic.service.ts` — fix the dead guard (FR-030); transactions (FR-031); immutable `code` (FR-029)
- `admin/pricing-management/fare.service.ts` — transactions (FR-034); DB pagination (FR-040); vehicle type by lookup (FR-036); drop the discarded night fields (FR-037)
- `admin/pricing-management/surge.service.ts` — existence check before mutate (FR-033); `assertValidPolygon` on create (FR-032); the raw inserts stop supplying `gen_random_uuid()` and let the `uuid(7)` column default apply (D5)
- `geographic/utils/postgis.ts` — `assertZoneWithinCity` throws when the city has no boundary instead of passing on an empty result set (FR-042)
- `prisma/schema/modules/pricing/pricing.prisma` + `pricing/services/pricing.service.ts` — dead schema removed and the follow-up drop migration stubbed (FR-047)
- All four admin route files — audit hook (FR-035)

### Files that must not change

`modules/auth/plugins/auth.plugin.ts` · `core/errors/envelope.ts` · every module's `setErrorHandler` · `payments/services/ledger/*` posting shape · `core/events/*` · `SurgeService`'s multiplier selection algorithm (only its filtering changes) · `tests/integration/helpers/harness.ts`.

---

## Concurrency and Race Protection Plan

Six contended paths. Each names a **database** boundary, never a lock (§5.3).

| #   | Race                                                    | Winner decided by                                                                                                                                   | Test                             |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| R1  | N rides complete against a promotion at its total limit | `UPDATE promotions SET used_count = used_count + 1 WHERE id = $1 AND (usage_limit_total IS NULL OR used_count < usage_limit_total)` — affected rows | `Promise.all` over N completions |
| R2  | One rider's two rides complete against a per-user limit | Partial unique index on `promotion_redemptions (promotion_id, user_id)`                                                                             | `Promise.all` over 2 completions |
| R3  | `ride.completed` delivered twice for one ride           | `@@unique([referralId, rideId])` on `referral_qualifying_rides`                                                                                     | Replay the envelope (§14.3)      |
| R4  | N users apply one referral code at its cap              | `UPDATE referral_codes SET uses_count = uses_count + 1 WHERE id = $1 AND (max_uses IS NULL OR uses_count < max_uses)` — affected rows               | `Promise.all` over N applies     |
| R5  | Two admins activate rules on the same key               | Partial unique index `WHERE is_active`                                                                                                              | `Promise.all` over 2 activations |
| R6  | Two coupon-generation requests on one batch             | Batch row locked `FOR UPDATE` before the allowance is read                                                                                          | `Promise.all` over 2 generations |

Each assertion is on the invariant — exactly one winner, cap never exceeded — never on which caller won (§14.2).

---

## Test Plan

### Unit — `tests/unit/pricing/`

- `fare-split.test.ts` **(new)** — the identity `driverEarning + platformCommission + platformFee + taxAmount === totalFare` across a matrix of cards, including zero tax, zero commission, floor-binding and discount-exceeds-subtotal. This is the test whose absence let B1 ship.
- `pricing-calculation.test.ts` **(rewritten, Phase 2)** — the existing 33 assertions encode the pre-BD-1 split and will fail by design. Recorded as a declared exception under Complexity Tracking, not a weakening.
- `rate-card-resolution.test.ts` **(new)** — effective window honoured; zone rule beats city rule beats GLOBAL; `RESTRICTED` never selected.
- `peak-window.test.ts` **(new)** — pure evaluator: inside, outside, crossing midnight, non-server timezone, DST boundary.

### Unit — `tests/unit/promotions/`, `tests/unit/referrals/`

- Eligibility denial on a missing vehicle type; percentage bounds; coupon allowance exhaustion.
- Reward grant throws — and therefore does not mark `REWARDED` — when the target wallet is absent.
- BD-6 eligibility gate; fraud-signal flagging.

### Integration — `tests/integration/`

- `zone-fare-parity.test.ts` — quote and completion produce the same rate card and the same total for a zone-scoped rule. **This is the SC-002 test.**
- `promotion-limits.test.ts` — R1, R2, R6.
- `referral-idempotency.test.ts` — R3 by driving `processBatch()` twice, per §7.2's pure-registration design.
- `referral-apply-concurrency.test.ts` — R4.
- `admin-fare-atomicity.test.ts` — R5, plus the mid-edit failure leaving the prior rule active.
- `admin-audit-coverage.test.ts` — every `canWrite` route produces an entry, written in the shape of the existing "webhook is the only public payment route" assertion so a new unaudited route cannot appear quietly.

### Performance baseline

Record quote latency and query count for six categories **before** Phase 5 and assert improvement after (SC-007). Without the recorded baseline the criterion is unfalsifiable.

---

## Risks and Deployment Plan

| Risk                                                     | Mitigation                                                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 2 changes what every driver is paid                | Ship behind no flag but **after** a read-only report quantifying the per-ride delta on recent completed rides; communicate before deploy                               |
| The Phase 2 test rewrite masks a regression              | `fare-split.test.ts` is written and passing **before** `pricing-calculation.test.ts` is touched, so the invariant is guarded during the edit                           |
| Migration 8 fails on existing duplicate active rules     | Pre-flight query is mandatory, not advisory; resolve by choosing a winner, never by weakening the index                                                                |
| GiST index build locks a large table                     | `CONCURRENTLY` manually before `migrate deploy`; migration is `IF NOT EXISTS`                                                                                          |
| BD-4 A orphans surge configuration during rollout        | Backfill and drop are separate releases; migration 6 is additive only and the old table is still read by the previous version                                          |
| Hoisting the quote loop changes serviceability semantics | The vehicle-restriction check stays per-category; only the city/zone/surge/promo resolution is hoisted. Covered by an existing-behaviour test written before the hoist |
| A `pricingRuleId` referencing a since-deleted rule       | FK is `ON DELETE SET NULL`, and rules are soft-deactivated rather than deleted; completion falls back to live resolution with a metric                                 |
| Audit writing adds latency to every admin write          | Same-transaction insert of one row; admin write volume is low. Measured, not assumed                                                                                   |

**Deploy order per phase**: migrate, then deploy (§16.2). Every migration in this plan is safe against the previous application version — that is the property the table above verifies, and the `surge_zones` drop is excluded from this feature precisely because it is not.

---

## Complexity Tracking

One declared exception, and three deliberate simplifications with stated ceilings.

**Declared exception to §15.3.** `tests/unit/pricing/pricing-calculation.test.ts` currently asserts the fare split this feature deliberately changes. Rewriting it is a specification change driven by BD-1 and BD-2, not a test weakened to make a suite pass. The distinction is protected procedurally: `fare-split.test.ts` must be written, passing and reviewed before that file is edited, so the invariant is never unguarded. No other existing test changes.

| Simplification                                                                | Ceiling                                                                                                                                          | Upgrade path                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Zone precedence as a `SMALLINT` operators set by hand                         | An operator can still create two zones at the same priority; tie-break is `created_at`                                                           | Derive precedence from `ST_Area` if manual ordering becomes a burden          |
| Fraud signal limited to device-id reuse between referrer and referee (FR-028) | Catches the naive case only; a determined actor changes devices                                                                                  | Add phone-prefix, payout-account and IP clustering as signals                 |
| `PENDING` reward sweep as a maintenance job rather than a retry queue         | Recovery latency is one sweep interval                                                                                                           | Move to a job queue if the interval proves too long                           |
| BD-5 B removes unreachable service types rather than wiring them              | `SCHEDULED`/`RENTAL`/`OUTSTATION` pricing remains unavailable                                                                                    | Its own feature, with the booking-flow decisions it requires                  |
| Milestone achievement checked per row inside the reward transaction (F8)      | A few extra queries per reward, against a milestone count in single digits; the `@@unique([milestoneId, userId])` already guarantees correctness | Batch the lookup if reward-transaction duration is ever measured as a problem |
| Two schema drops deferred to a follow-up release (§Deferred drops)            | Dead tables and columns survive one release past this feature                                                                                    | The named stub migration and its recorded execution date                      |

---

## Phase Status

- **Phase 0 (research)**: not required — §Resolved by Code Inspection answers the four open questions from committed code, and no external technology decision is involved.
- **Phase 1 (design)**: this document. `data-model.md` is not warranted; the schema deltas are eight additive migrations fully enumerated in §Database Migration Plan.
- **Phase 2 (tasks)**: not started. Generate `tasks.md` with `/speckit-tasks` once BD-1 and BD-2 are approved — the Phase 2 task breakdown depends on which commission base is chosen.

**Blocking on**: BD-1 and BD-2 (Phase 2 only). BD-4 through BD-8 have usable recommended defaults and are not blocking; BD-3's recommendation is assumed throughout.

**Coverage**: every one of the 46 review findings maps to a requirement, a decision or a recorded acceptance — see [spec.md §Finding Traceability](./spec.md#finding-traceability). One finding (F8) is accepted with no action; the reason is stated there and its ceiling is recorded in Complexity Tracking above. Nothing is silently dropped.
