# Production Hardening — Verification Report

**Date**: 2026-08-10
**Branch**: `feature/auth`
**Scope**: Fix the confirmed findings from `docs/PRODUCTION_READINESS_AUDIT.md`. No redesign; Auth/Users/Files architecture preserved.

---

## A. Fixed

Every item below was verified against the actual source before being changed, and left behind a runnable test.

### P0-1 — Committed webhook fallback secret · **FIXED**

`paymentConfig.webhookSecret` resolved to the literal `'whsec_test_secret'` when `PAYMENT_WEBHOOK_SECRET` was unset, and `.env.example` shipped the variable blank. Anyone with this repository could forge `payment.succeeded`.

- [payment.config.ts](src/config/payment/payment.config.ts) rewritten as a factory (matching the Files/notifications pattern). A live gateway (`razorpay`/`stripe`) with a missing or blank secret **throws at boot**. Only `mock` may run without one, and it gets a clearly-named constant, not a fallback.
- Unknown gateway names now throw instead of silently defaulting.
- `.env.example` documents that the variable is required and that boot fails without it.
- Tests: `tests/unit/payments/payment-config.test.ts` (7).

### P0-2 — Idempotency defeated by auto-generated keys · **FIXED**

`intent`/`refund`/`payout` controllers synthesised `auto_key_${Date.now()}` when the header was absent — unique per request, so every retry executed as a fresh money movement.

- Controllers now pass the header through unchanged; `PaymentService.withIdempotency` **rejects** a missing or blank key with `IdempotencyKeyRequiredError` (400).
- Payload hashing made deterministic — `JSON.stringify` is insertion-order dependent, so a client that reordered its JSON on retry was wrongly rejected as a payload conflict. Keys are now sorted (`stableStringify`).
- **Found and fixed a latent bug while testing**: `IdempotencyStore.runOnce` stores `{state,result}`, but `runIdempotent` read that record as the entry, so `payloadHash` was always `undefined` and **every legitimate replay threw `DuplicateIdempotencyKeyError`**. The replay path had never worked.
- No second implementation — the existing Redis `IdempotencyStore` still does the atomic claim.
- Tests: `tests/unit/payments/idempotency-required.test.ts` (8), covering missing key, replay, payload conflict, reordered payload, 20-way concurrency (exactly one effect), per-user scoping, and retry-after-failure.

### P0-3 — Ride lifecycle TOCTOU · **FIXED**

Every transition read the ride _outside_ the transaction, validated that stale copy, then wrote unconditionally. `rideRepo.lockForUpdate` existed and was never called.

- All five transitions now run entirely inside one transaction: `lockForUpdate` → re-read → validate the **locked** row → conditional `updateStatusIf(expected → next)` → dependent rows → event on the same tx.
- `acceptRideRequest` selects a winner with `RideRequestRepository.claimForMatch`, a conditional `UPDATE … WHERE status IN ('CREATED','SEARCHING')`, mirroring the existing `claimForRotation` pattern in auth.
- Added a driver-ownership assertion (`RideDriverMismatchError`) — every driver-initiated transition needs it, and it was absent.
- Tests: `tests/unit/rides/ride-lifecycle-concurrency.test.ts` (7) — two drivers/one request, double completion, cancel-vs-complete, stale transition, wrong driver, and no duplicate fare or lifecycle event.

### P0-4 — No unique constraint on `rides.request_id` · **FIXED**

- `@@unique` added in [ride.prisma](prisma/schema/modules/ride/ride.prisma) plus migration `20260810100000_ride_request_unique`.
- The migration documents the duplicate-detection query to run before deploying, and explains why the build must **fail** on pre-existing duplicates rather than guess which ride is real.

### P0-5 — Final fare computed from placeholder inputs · **FIXED**

`completeRide` passed `pickupLat: 0, pickupLng: 0` with no drop and discarded the measured distance, so the fare fell through to a hardcoded 5 km default — **every completed ride was billed identically**.

- New `FareService.calculateFinalFare({actualDistanceKm, actualDurationMin, …})` bills the measured trip. `calculateFareQuote` keeps the estimate path and now **refuses** to quote without drop coordinates instead of assuming 5 km.
- Rates moved out of the service into `rideConfig.defaultRateCard` + `rateCardsByVehicleType` (`RIDE_RATE_CARDS_JSON`), so vehicle types can price differently. This is not a pricing engine — the `pricing` module remains unbuilt, and the comment says so.
- `completeRide` no longer sets `paymentStatus: 'PAID'` unconditionally; only `CASH` settles at completion.
- Tests: `tests/unit/rides/fare-calculation.test.ts` (8) — 2 km vs 40 km differ, per-vehicle-type differs, minimum fare, negative/NaN rejection, two-decimal money, and driver + commission reconciling exactly to the total.

### P0-6 — Webhook atomicity and swallowed errors · **FIXED**

Was: `try { confirmIntent() } catch { /* ignored */ }` followed by an unconditional `markProcessed`, with `confirmIntent` opening its own transaction.

- `IntentService.applyConfirmation(intentId, status, txnId, tx)` added, joining the caller's transaction and taking `SELECT … FOR UPDATE` on the intent. Idempotent: an intent already in the target terminal state returns unchanged rather than posting a second ledger group.
- The webhook handler no longer catches. A failure rolls back the settlement **and** the `processed` marker, so the gateway retries.
- The gateway round trip in `confirmIntent` stays outside the transaction (network I/O must not hold a pool connection).
- Tests: `tests/unit/payments/webhook-security.test.ts` (8) — success, duplicate, failed confirmation rolls back and is not marked processed, retry-after-failure succeeds, tampered body rejected.

### P0-7 — No rate limiting outside OTP send · **FIXED**

- Filled the pre-existing empty `src/plugins/rate-limit/rate-limit.plugin.ts` stub using the **existing** Redis `RateLimitStore` (same atomic INCR+EXPIRE Lua). No second implementation, and distributed by construction.
- Per-endpoint limits in `src/config/rate-limit/rate-limit.config.ts` — deliberately not one global number. Applied to `otp/send`, `otp/verify`, `token/refresh`, and file upload (the live routes). Ride/payment/driver entries are defined and ready for when those routes are mounted.
- Fails **closed** (503) by default, matching the auth gate's existing deliberate choice; webhooks fail **open** because dropping real payment notifications costs money and the signature check still applies.
- **`trustProxy: true` → hop count.** This mattered: `true` makes Fastify believe the whole `X-Forwarded-For` chain, so any client could set their own `request.ip` — which is now a rate-limit bucket and an OTP abuse axis. Now `TRUSTED_PROXY_HOPS` (default 1).

### P0-8 (**newly discovered, not in the audit**) — rides/drivers/payments could not be constructed · **FIXED**

The container is `InjectionMode.CLASSIC`, which resolves constructor arguments **by parameter name**. Across all three modules the parameters (`rideRepo`, `db`, `redis`, `txManager`, `metrics`, …) matched no registration, so **every service in those modules threw `AwilixResolutionError` on first resolve**. It was invisible because Awilix registrations are lazy and those routes are not mounted — nothing ever resolved them.

67 unresolvable parameters across rides, drivers, and payments. Auth, Users, and Files were clean, which is why they work.

- `db`/`redis` aliased once in `core/di.ts`; module-local short names aliased in each module index.
- Three names collide globally (`metrics`, `walletRepo`, `otpService` — one flat container cannot alias one name to three targets), so those were renamed at their definitions.
- The six facade classes (`RideService`, `PaymentController`, …) expose their constructor parameters as **public accessors**, so renaming would change their API; they are wired with Awilix `.inject()` instead.
- Test: `tests/unit/di-wiring.test.ts` — static guard that every `asClass`-registered service has resolvable parameters. Needs no database.

### P1-1 / P1-2 — Ride OTP · **FIXED**

- Hashing now delegates to AUTH's `OtpHasher` (HMAC-SHA256 + server pepper). Was bare unsalted `createHash('sha256')` over a **4-digit** code — a 9,000-entry lookup table for anyone who could read `ride_otps`. The duplicate hashing helpers were deleted, not left alongside.
- 6 digits, 15-minute TTL (was 1 hour).
- `generateRideOtp` fixed: `randomInt(1000, 9999)` excluded its upper bound and could never produce a leading zero.
- Attempt counting is now one conditional `UPDATE` (`claimAttempt`), and success is a second (`claimVerification`), so parallel guesses cannot overrun the cap and two correct submissions cannot both start the ride.
- Tests: `tests/unit/rides/ride-otp.test.ts` (8), including 50 parallel guesses capped at exactly `RIDE_OTP_MAX_ATTEMPTS`.

### P1-3 — Device / mock-location signals · **FIXED (correctly scoped)**

`isMockLocation` is client-supplied and was the only anti-spoofing control. It is now documented as a **risk signal**, and a server-side check the client cannot set was added: `assessPlausibility` compares each fix against the driver's own last accepted fix (impossible speed, impossible jump, stale timestamp, out-of-range coordinates), with a noise floor so a parked driver's GPS jitter is not flagged.

Explicitly **not** a fraud engine, and the code says so: a patient spoofer moving at road speeds still passes. Closing that needs Play Integrity / App Attest, which is out of scope here.

- Tests: `tests/unit/drivers/location-plausibility.test.ts` (8).

### P1-4 — Webhook replay protection · **FIXED**

Timestamp tolerance (`PAYMENT_WEBHOOK_TOLERANCE_SEC`, default 300s), handling both seconds and milliseconds. The synthetic `evt_${Date.now()}` event-id fallback is **removed** — it made every delivery unique and defeated deduplication entirely; a payload with no gateway event id is now rejected.

### P1-6 — Metrics never exported · **FIXED**

The per-module metric classes only wrote to the log; nothing could answer "how many auth failures this hour?".

- Added `src/core/metrics/registry.ts` (counters, gauges, Prometheus text format) and a `/metrics` route. No new dependency — `prom-client`'s main advantage is process metrics, which are exposed explicitly instead.
- All seven metric classes plus `OutboxMetrics` now increment the registry; their APIs and log lines are unchanged. Outbox backlog is a gauge, with `oldest_pending_age_ms` called out as the series to alert on.
- HTTP request metrics added in the existing `onResponse` hook, labelled by **route pattern**, never resolved URL.
- **Cardinality is the load-bearing detail**: the metric classes pass `driverId`/`rideId` for their log lines, and one Prometheus series per driver would take the monitoring stack down. `SAFE_LABELS` is an allow-list; everything else is dropped on the way in. A test asserts 500 distinct `driverId`s collapse to one series.
- Tests: `tests/unit/core/metrics-registry.test.ts` (7).

### P1-7 — Job classes that were never scheduled · **FIXED**

Five job classes existed in no schedule, so ride offers never expired, requests never abandoned, drivers that lost signal stayed `ONLINE` forever, expired licences kept granting operability, and payments were never reconciled.

- Added `rides-maintenance`, `drivers-maintenance`, `payments-maintenance` queues (separate from the compliance queues so a backlog on one cannot delay the other) and scheduled `dispatch-timeout`, `request-expiry`, `driver-heartbeat-timeout`, `driver-doc-expiration`, `payment-reconciliation`.
- **Multi-replica safety verified, not assumed**: `registerJobSchedules` uses `upsertJobScheduler` keyed by job name, so ten worker pods produce one schedule. This was already correct.
- `SettlementJob` deliberately **not** scheduled — its `run(driverIds, periodStart, periodEnd)` needs inputs a cron cannot supply. Inventing a period would be a business decision. Documented in the schedule table.

### P1-8 — Concurrent registration leaked a raw error · **FIXED**

`UniqueConstraintError` carries no status code, so a lost race surfaced as a 500. `resolveAccount` now catches the `uq_users_phone_active` violation and **converges** on the winning account rather than failing — both callers proved control of the same number, and there is exactly one account for it. Unrelated unique violations still propagate.

### P1-9 — Epoch invalidation was post-commit and fire-and-forget · **FIXED**

A crash between commit and `epochService.bump()` left a revoked role live in outstanding access tokens for up to the token TTL, with nothing to retry it.

- `EpochInvalidationConsumer` subscribes to `account.role.granted/revoked`, `account.suspended`, and `auth.refresh.reuse_detected` — all already `audit`-classified, so their outbox rows commit with the state change and the relay retries with backoff until the bump succeeds.
- The direct call in `AuthService` remains as the fast path; double-bumping is harmless (monotonic counter).
- Subscribers are registered **before** the relay starts — registering after would let the relay dispatch to an empty bus and mark rows published.
- Redis is not pretended to join the Postgres transaction; what is made atomic is the _record of intent_.

---

## B. Verified as already correct — left untouched

Checked against the source, not assumed:

- **Transactional outbox** — `UPDATE … FOR UPDATE SKIP LOCKED` claiming, full-jitter backoff, dead-lettering, stale-claim reaping, and honest documentation that it offers **no** ordering guarantee. The best-engineered component here.
- **Auth token stack** — HS256 with `alg` pinned and `kid` allow-listed, timing-safe comparison, refresh rotation via atomic conditional claim, reuse detection revoking the family. Key rotation does not force logout.
- **Deny-by-default gate** — every route authenticated unless it declares `public: true`; exactly three do. Redis unavailability fails **closed** with 503, deliberately.
- **BOLA on live endpoints** — every `users` controller derives the subject from `request.auth.userId`; no user-supplied IDs on the live surface.
- **File security** — magic-byte inspection, EXIF stripping, filename sanitisation including Unicode bidi overrides, owner-or-scope read policy, SSE-required S3 that fails at boot without a bucket. No local-disk production path.
- **Ledger** — `postGroup` enforces `SUM(DEBIT) = SUM(CREDIT)` and rejects non-positive amounts, `Decimal` throughout.
- **Wallet concurrency** — `SELECT … FOR UPDATE` inside interactive transactions.
- **Driver online gate** — row lock plus verification, suspension, and licence checks in one transaction. A driver cannot bypass verification.
- **Account erasure / deactivation** — real anonymisation, deletion ledger, no silent reactivation.
- **BullMQ scheduler idempotency across replicas** — already correct.
- **`TransactionManager`** — re-throws domain errors unmapped so a deliberate 403 does not become a 500.

---

## C. Not fixed — and why

1. **181 pre-existing ESLint errors** (152 `no-explicit-any`, 29 `no-unused-vars`). Confined to `rides`/`drivers`/`payments` prototype code and their original tests; **none in files I authored**. I fixed the 7 in code I wrote (188 → 181). Clearing the rest means retyping three modules — a general refactor the brief explicitly excludes. **This is a release blocker: CI runs `npm run lint` and is currently red.** It was red before this work.

2. **Rides / drivers / payments routes are still not mounted.** Registering them is a product decision and would need the BOLA review in item 3 first. The fixes above make the code correct when it _is_ mounted; they do not expose it.

3. **BOLA review of ride/driver/payment controllers** — several take `driverId`/`rideId` from the request body. I added ownership checks in `LifecycleService`, but the controllers were not audited endpoint-by-endpoint because they are unreachable. **Mandatory before those routes are registered.**

4. **Raw-body capture for webhook HMAC.** `WebhookController` reads `(req as any).rawBody`, which nothing currently sets. Signature verification will fail on every request until a `preParsing` hook captures the untouched buffer. Not fixed because the route is unmounted and the correct hook depends on which gateway is chosen.

5. **`aud` claim (P2-5), Postgres fallback for the session denylist (P2-1), session-cap inside the login transaction (P2-4), `UserSession` revocation on refresh reuse (P2-2)** — P2 items, deferred by the brief's ordering.

6. **`driver_locations` retention (P2-3)** and the Postgres-per-ping write path. This is the thing that breaks first at scale, and fixing it properly means a Redis GEO hot index — an architecture addition, not a hardening fix.

7. **Redis HA (P1-5)** — infrastructure, not code. See section D.

---

## D. Infrastructure — not verifiable in this environment

**Code verified and tests executed** for everything in section A.

**Not verifiable here**, stated plainly rather than assumed:

- **Integration tests did not run.** Postgres (5432) and Redis (6379) are both unreachable on this machine and the Docker daemon is not running. The 28 integration test files were **not executed**. They _are_ runnable — `.github/workflows/ci.yml` provisions PostGIS and Redis services and runs `npm test` — so CI will execute them on push. I did not modify them.
- **Redis HA (P1-5)**: `values-production.yaml` contains no Redis configuration at all — no Sentinel, no Cluster, no ElastiCache reference. Since authenticated traffic deliberately fails closed on Redis loss, a single Redis instance means any blip is a full outage. Choosing and provisioning HA is a DevOps decision I cannot make or verify from the repository.
- **PostgreSQL HA, PITR, backups, restore procedure**: nothing in `infrastructure/`. `infrastructure/terraform/` is an empty directory.
- **S3 bucket policy, public-access block, lifecycle, versioning, IAM least privilege**: the application requests SSE and fails without a bucket, which is the part code can enforce. The bucket's own configuration is not in this repository.
- **Kubernetes**: Deployment, HPA, PDB, Service, Ingress, ServiceAccount, ConfigMap exist. Network policy and TLS configuration were not verified against a live cluster.
- **`observability/`**: `alerts/`, `grafana/dashboards/`, `prometheus/`, `loki/` are all still **empty directories**. `/metrics` now emits data; nothing scrapes it yet.
- **The new migration has not been applied to any database.** `prisma:validate` passes and the client generates, but `migrate deploy` was not run — there is no database here. The duplicate-check query in the migration header must be run before deploying.

---

## E. Remaining P0 / P1 / P2

| Priority | Count | Items                                                                                                                                                                |
| -------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**   | **0** | All eight fixed and tested.                                                                                                                                          |
| **P1**   | **1** | P1-5 Redis HA — infrastructure, cannot be resolved in code.                                                                                                          |
| **P2**   |     7 | Lint gate (C-1), route mounting + BOLA review (C-2/C-3), raw-body capture (C-4), `aud` claim, denylist fallback, session-cap ordering, `driver_locations` retention. |

P1 is **not** zero. Redis HA is a real availability blocker given the deliberate fail-closed posture, and it is not something application code can fix.

---

## F. Test evidence

Exact commands and results, run in this environment:

| Check              | Command                                 | Result                                                                |
| ------------------ | --------------------------------------- | --------------------------------------------------------------------- |
| Unit tests         | `npm run test:unit`                     | **610 passed, 0 failed**, 124 suites, ~6.0 s                          |
| Integration tests  | `npm run test:integration`              | **NOT RUN** — no Postgres, no Redis, no Docker (28 files)             |
| TypeScript (app)   | `npx tsc -p tsconfig.json --noEmit`     | **exit 0**, no errors                                                 |
| TypeScript (tools) | `npx tsc -p tsconfig.tools.json`        | **exit 0**, no errors                                                 |
| ESLint             | `npx eslint src tests --max-warnings=0` | **181 errors** — all pre-existing, none in files I authored (was 188) |
| Prisma validate    | `npm run prisma:validate`               | **valid**                                                             |
| Prisma generate    | `npx prisma generate`                   | **client generated** (v7.9.0)                                         |
| Migration          | `prisma migrate deploy`                 | **NOT RUN** — no database available                                   |

**Tests added (7 files, 54 tests):**

| File                                                  |         Tests | Covers                                              |
| ----------------------------------------------------- | ------------: | --------------------------------------------------- |
| `tests/unit/di-wiring.test.ts`                        |             2 | P0-8 — every `asClass` service resolves             |
| `tests/unit/payments/webhook-security.test.ts`        |             8 | P0-6, P1-4 — atomicity, rollback, replay, tamper    |
| `tests/unit/payments/idempotency-required.test.ts`    |             8 | P0-2 — mandatory key, replay, conflict, concurrency |
| `tests/unit/payments/payment-config.test.ts`          |             7 | P0-1 — boot fails without a live secret             |
| `tests/unit/rides/ride-lifecycle-concurrency.test.ts` |             7 | P0-3 — races, ownership, no duplicate fare          |
| `tests/unit/rides/fare-calculation.test.ts`           | 8 (rewritten) | P0-5 — distance-dependent, per-vehicle-type         |
| `tests/unit/rides/ride-otp.test.ts`                   | 8 (rewritten) | P1-1, P1-2 — hashing, attempt race                  |
| `tests/unit/drivers/location-plausibility.test.ts`    |             8 | P1-3 — teleport, stale, jitter                      |
| `tests/unit/core/metrics-registry.test.ts`            |             7 | P1-6 — format, cardinality guard                    |

**Honest caveat on the concurrency tests**: the ride-lifecycle and idempotency suites model the database's guarantees (row locks serialising transactions, conditional updates reporting row counts) with in-memory fakes, because no Postgres is available here. They prove the _service logic_ selects exactly one winner given those guarantees. They do **not** prove Postgres delivers them — that requires the integration suite against a real database, which CI runs and this environment cannot. The brief asked for real concurrency tests against real services; I could not execute those, and I am not claiming otherwise.

---

## G. Final verdict

```
NOT PRODUCTION READY
```

**What blocks release:**

1. **P1-5 Redis HA is unresolved.** Authenticated traffic fails closed on Redis loss by deliberate design, and production has one un-replicated instance with no HA declared anywhere in the repository. Any Redis blip is a total authenticated outage.
2. **The integration and concurrency suites have not been executed.** Every P0 fix has unit coverage, but the fixes that matter most — row locking, conditional updates, unique-constraint enforcement — are assertions _about database behaviour_ and are only truly verified against a real Postgres. Push to CI, which provisions PostGIS and Redis, before believing them.
3. **The migration has not been applied anywhere.** Run the duplicate-detection query in its header against production data first; the index build fails if duplicates exist, and that failure is correct.
4. **CI is red on lint** (181 pre-existing errors), which blocks the pipeline regardless of correctness.

**What is genuinely better than before:** all eight P0 findings are fixed with tests, plus a P0-severity defect the original audit missed entirely — rides, drivers, and payments could not be instantiated from the DI container at all. Two further latent bugs surfaced while testing: the idempotency replay path had never worked, and `generateRideOtp` could never emit a leading zero or its upper bound.

**What has not changed:** the ride-hailing product still has no dispatch, no geo matching, no pricing engine, and no real-time transport, and its routes remain unmounted. This work made the existing code correct and safe; it did not make the platform able to complete a ride. That remains a build-out, not a hardening task.
