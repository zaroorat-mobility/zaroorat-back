# Production Readiness Gate

**Date**: 2026-08-12
**Branch**: `feature/auth`
**Verified against**: real PostgreSQL 17 + PostGIS 3.5 and real Redis, via the mounted Fastify application.

---

## Gate summary

| Gate                    | Status   | Evidence                                                                                                                 |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Authentication          | **PASS** | Deny-by-default gate; 401 `TOKEN_INVALID` on every business route, asserted exhaustively over the real route table       |
| Authorization / BOLA    | **PASS** | 30 HTTP tests across rides/drivers/payments; identity always from `request.auth`                                         |
| Roles / permissions     | **PASS** | 5 roles + 8 permissions seeded idempotently; `finance` exists and is separated from `admin`                              |
| Financial authorization | **PASS** | Payout bounded by a settlement **derived from real fares**; refund bounded by stored capture; 35 payout + pipeline tests |
| Earnings ledger         | **PASS** | Ride completion posts a balanced double-entry group in the same transaction as the fare                                  |
| Webhook security        | **PASS** | HMAC over preserved raw bytes; replay window; event-id dedupe; public-but-signed asserted                                |
| HTTP integration        | **PASS** | **492 / 492**                                                                                                            |
| Unit tests              | **PASS** | **640 / 640**                                                                                                            |
| TypeScript              | **PASS** | Both projects, exit 0                                                                                                    |
| Lint                    | **PASS** | **0 errors** (`eslint . --max-warnings=0`), from 115                                                                     |
| Build                   | **PASS** | `npm run build` → `dist/server.js` present                                                                               |
| Database / Prisma       | **PASS** | Schema valid; migrations applied; "Database schema is up to date"                                                        |
| Regression protection   | **PASS** | Identity scan, DI-wiring scan, route-graph guard                                                                         |

**All thirteen gates PASS.**

> **R-1 and R-2 are now closed.** Settlements are derived from `ride_fares`, and
> ride completion posts to the double-entry ledger. See §5.

---

## 1. Lint gate — 115 → 0

### What was wrong

115 errors, all pre-existing in the `rides`/`drivers`/`payments` prototype code and their original unit tests. None came from the security work — that code was already clean. Breakdown:

| Rule                                 | Count | Nature                                                                |
| ------------------------------------ | ----: | --------------------------------------------------------------------- |
| `@typescript-eslint/no-explicit-any` |    86 | Untyped Prisma input builders, `catch (err: any)`, untyped test stubs |
| `@typescript-eslint/no-unused-vars`  |    29 | Dead imports, unused gateway-stub parameters                          |

### What changed

No rule was disabled, no `eslint-disable` was added, no path was excluded, and the config is untouched. Each error was fixed at the source:

- **`const data: any = {…}` → inline conditional spreads** (13 sites). These were mutable builders handed to Prisma, so nothing checked the field names. Rewritten as `{ …, ...(x !== undefined ? { x } : {}) }`, which Prisma type-checks at the call site. This is a real strengthening, not a silencing: a misspelled column is now a compile error.
- **`catch (err: any)` → `catch (err)`** (7 sites), with `err instanceof Error ? err.message : String(err)` where the message was used.
- **`payload: any` / `snapshotJson: any` → `Prisma.InputJsonValue`** — the correct type for a JSON column.
- **`profile?: any`, `fare?: any` → `unknown`** in response view types.
- **`(client as any).driver.create` → `client.driver.create`** — the cast was hiding nothing; it just suppressed inference.
- **Unused gateway-stub parameters → `_`-prefixed**, matching the configured `argsIgnorePattern: '^_'`. These implement `PaymentGatewayProvider` and must keep their signatures.
- **Test stubs `as any` → `as never`** — stricter, and lint-clean. Where removing a `: any` annotation broke assignability, the cast moved to the call site rather than being widened back.

`npx eslint . --max-warnings=0` → **exit 0**.

---

## 2. F-1 — `executePayout` amount was unbounded

### What was wrong

`executePayout` wrote whatever `amount` the request supplied. The route is operator-only, and that was treated as sufficient. It is not: an operator-only endpoint that trusts its own input turns one compromised staff token — or one bad ops script — into unbounded outbound payments, with no server-side record that could have refused.

### Establishing the source of truth (not guessed)

I traced every candidate before choosing:

| Candidate                         | Verdict                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger `DRIVER_PAYABLE` balance   | **Unusable.** `LedgerService.recordTripPayment` — the only thing that _credits_ driver earnings — has **zero callers**. The account is debited by payouts and never credited, so its balance is ≤ 0 for every driver. Bounding on it would reject every legitimate payout. |
| `DriverWallet.balance`            | **Unusable.** `DriverWalletViewService` only reads it; nothing writes it.                                                                                                                                                                                                  |
| **`DriverSettlement.netPayable`** | **Authoritative.** Written by `SettlementService.calculateSettlement`, never by the payout caller. `DriverPayout.settlementId` already links a payout to it, and `(driverId, periodStart, periodEnd)` is unique.                                                           |

No schema was invented: `settlementId`, `netPayable`, and `status` all already existed.

### The invariant

```
requested  ≤  settlement.netPayable  −  SUM(non-FAILED payouts against that settlement)
```

- A payout with **no settlement is refused** (`PAYOUT_UNBACKED`, 422) — without one there is no server-side figure to check against.
- A settlement **belonging to a different driver is refused** — otherwise any driver's settlement could unlock a balance for a driver owed nothing.
- `FAILED` payouts are excluded from the committed sum (money that never left does not consume balance); `INITIATED` **is** counted, because an in-flight payout is money the gateway may still take.
- Non-positive and non-finite amounts are refused before anything else — a negative payout would otherwise _increase_ the available balance while sending money out.
- The settlement is only marked `PAID` when nothing remains. Previously a partial payout flipped the whole settlement to `PAID`, which both misreports the driver as settled and would have stranded the remainder behind a terminal status.

### Concurrency and idempotency

The settlement row is locked `SELECT … FOR UPDATE` before the balance is read, so concurrent payouts against one settlement serialise. Idempotency behaviour is preserved: a repeated key returns the original payout. The pre-transaction lookup is a fast path; the unique constraint on `idempotency_key` is what makes it correct under concurrency, and a violation now resolves to the winner's row instead of surfacing a raw database error.

### Tests — 20/20, all over real HTTP

Within balance · exactly equal to balance · over balance rejected · remainder after partial spend rejected · no settlement rejected · another driver's settlement rejected · zero rejected · negative rejected · **decimal precision** (33.35 × 3 = 100.05 exactly, then 0.01 more rejected) · partial payout leaves settlement `PENDING`, final one marks it `PAID` · same key replays without paying twice · **new key against a consumed balance rejected** · concurrent same-key → one payout · **concurrent distinct keys cannot double-spend** · 6 concurrent × 400 against 1000 → exactly 2 admitted · unauthenticated 401 · customer 403 · the driver being paid 403 · admin allowed · missing `Idempotency-Key` 400.

> One test initially failed on `100.05000000000001`. That was my **assertion helper** summing with JS floats — the production path was correct. The helper now sums as `Decimal`; the float trap is exactly what the test exists to catch, so the test must not commit it either.

---

## 3. Mounted route graph

`rides`, `drivers`, and `payments` are mounted and stay mounted — the integration suite now exercises the real production route graph.

### Sanctioned public routes — exactly 9

| Route                                     | Why                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `POST /api/v1/auth/otp/send`              | Pre-authentication: the caller has no token yet                                 |
| `POST /api/v1/auth/otp/verify`            | This is what mints the token                                                    |
| `POST /api/v1/auth/token/refresh`         | The access token is expired by definition                                       |
| `POST /api/v1/payments/webhooks/:gateway` | A gateway holds no bearer token; authenticated by HMAC                          |
| `GET /health`, `GET /api/v1/health`       | Load-balancer probes                                                            |
| `GET /ready`, `GET /api/v1/ready`         | Kubernetes probes                                                               |
| `GET /metrics`                            | Prometheus scrape — **must be restricted to the monitoring network at ingress** |

### The guard

`tests/integration/route-graph.test.ts` walks Fastify's **own route table** and probes every route unauthenticated. It fails in both directions: a new unsanctioned public route, or a sanctioned one that stopped being reachable. A route added tomorrow is covered without anyone remembering to update the test.

Two subtleties it had to get right, both of which produced false results first:

- **`printRoutes` is a prefix tree**, even with `commonPrefix: false`. Reading each line in isolation yields paths like `/arrive` instead of `/api/v1/rides/:id/arrive`, which probe as 404 and would have reported half the API as unauthenticated. The parser tracks a prefix stack by indentation depth.
- **A missing webhook signature also answers 401.** Keying "is this route protected?" on the status code alone reported the webhook as gate-protected and hid the day it stopped being public. The probe keys on the error **code** (`TOKEN_INVALID` = the auth gate; `WEBHOOK_SIGNATURE_INVALID` = the route's own credential check).

Verified: no route became public as a side effect of mounting.

---

## 5. The driver earnings pipeline (closes R-1 and R-2)

Ride completion → ledger → settlement → payout is now a real chain. Previously
the first two links did not exist.

### What was wrong

- **Nothing posted to the ledger.** `LedgerService.recordTripPayment` had zero
  callers. Completing a ride wrote `ride_fares` and no accounting at all, so
  `DRIVER_PAYABLE` was debited by payouts and never credited — the account drifted
  negative and the double-entry ledger was not a usable record of driver earnings.
- **Settlements were a constant.** `SettlementJob` passed
  `grossEarnings: new Decimal(1000)` with a 20 % rate, so every driver settled at
  the same figure regardless of how much they drove. The payout ceiling built on
  top of it was enforcing a placeholder.

### Ledger posting on completion

`LifecycleService.completeRide` now calls `recordTripPayment` **inside the same
transaction** as the fare row. A fare that commits without its ledger group is
money earned that the books do not know about, and nothing afterwards can tell
you which rides were missed.

Two entry shapes, because two different things happen:

| Payment                                      | Entries                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Card / UPI / wallet — **platform collected** | `DEBIT CUSTOMER_WALLET totalFare` · `CREDIT DRIVER_PAYABLE driverEarning` · `CREDIT PLATFORM_COMMISSION commission` |
| **Cash** — driver collected                  | `DEBIT DRIVER_PAYABLE commission` · `CREDIT PLATFORM_COMMISSION commission`                                         |

The cash case is the one worth stating plainly: the driver already holds the
whole fare, so the platform owes them nothing for that ride and is instead _owed_
its commission. Crediting `DRIVER_PAYABLE` with the earning would be the platform
promising to pay again money the driver took at the kerb — a double payment
dressed up as bookkeeping.

Both groups balance, which `LedgerRepository.postGroup` enforces:
`driverEarning + platformCommission == totalFare` by construction in
`FareService`, where the earning is derived by subtraction and never rounded
independently.

### Settlement derived from the ride record

```
grossEarnings = SUM(total_fare)          over non-cash completed rides in the period
commission    = SUM(platform_commission) over ALL completed rides in the period
netPayable    = grossEarnings − commission + adjustments
```

- Every figure comes from `ride_fares` rows. `calculateSettlement` no longer
  accepts an amount at all — there is no parameter left for a caller to
  hardcode.
- The **commission rate is not re-applied**. `FareService` already computed the
  commission per ride and stored it; re-deriving it from a rate would let the
  settlement disagree with the receipt the customer and driver were shown.
- For an all-non-cash period this reduces to `SUM(driver_earning)` exactly. For
  a cash-only period it is negative by the commission owed — and the payout
  invariant then correctly refuses any payout.
- The window is half-open `[periodStart, periodEnd)`, so consecutive periods can
  neither double-count a ride nor drop one landing on a boundary.
- Idempotent on `(driverId, periodStart, periodEnd)`, which is unique.

### Two bugs found while building the tests

Both were only reachable once a ride could actually be driven end to end over
HTTP, which nothing had done before:

- **A customer could book exactly one ride, ever.** `findActiveByCustomer` on
  ride _requests_ counted `MATCHED` as active. `MATCHED` is the request's
  terminal state — a ride was created from it — and nothing ever moves a request
  out of it, so every subsequent request was refused `ACTIVE_RIDE_EXISTS`
  forever. The active set is now `CREATED`/`SEARCHING`; the ride's own lifecycle
  governs from `MATCHED`, which `RideRepository.findActiveByCustomer` already
  checks.
- **A ride could never be started over HTTP.** `startRideSchema` required a
  4-digit `otpCode` while the hardened generator emits 6, so every real start
  code was rejected by validation before reaching the verifier. The schema now
  pins to `RIDE_OTP_LENGTH`.

### Tests — 15, all over real HTTP

The ride is driven through the actual routes (`requests` → `accept` → `arrive` →
`start` → `complete`), so fare, ledger, and settlement all come from the path
production uses.

_Ledger_: balanced 3-entry group matching the fare · `DRIVER_PAYABLE` equals the
earning · longer ride bills more and the books follow · **cash ride credits
nothing and leaves the driver owing commission** · fare and ledger share one
transaction and one entry group.

_Settlement_: sums real fares, not 1000 · a driver with no rides settles at zero
· cash nets to the commission owed · rides outside the period excluded ·
idempotent across runs · **settlement `netPayable` equals the `DRIVER_PAYABLE`
balance to the paise** (two modules, same fare — if they disagree neither can be
trusted).

_Payout on real numbers_: pays out exactly what the rides earned · refuses one
paise over · refuses any payout to a driver whose cash rides left them owing ·
concurrent payouts cannot double-spend the earned balance · repeated
idempotency key replays without paying twice.

### One harness bug worth recording

`payment_ledger_entries` and `gateway_events` hold no foreign key to `users`, so
the `TRUNCATE … CASCADE` in `resetState` never reached them and ledger rows
accumulated across the whole run. A balance assertion was measuring the suite's
history rather than the ride under test. Both tables are now truncated
explicitly, and the pipeline suite also resets in `before` — `afterEach` alone
leaves the first test in a file inheriting the previous run.

---

## 4. Verification results

Every command below was executed in this session against live services.

| Check                    | Command                                                   | Result                                                    |
| ------------------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| HTTP integration         | `npm run test:integration`                                | **492 passed, 0 failed**                                  |
| Unit                     | `npm run test:unit`                                       | **640 passed, 0 failed**                                  |
| TypeScript (app)         | `npx tsc -p tsconfig.json --noEmit`                       | exit 0                                                    |
| TypeScript (tools)       | `npx tsc -p tsconfig.tools.json`                          | exit 0                                                    |
| Lint                     | `npx eslint . --max-warnings=0`                           | exit 0, **0 errors**                                      |
| Build                    | `npm run build`                                           | `dist/server.js` present                                  |
| Prisma schema            | `npm run prisma:validate`                                 | valid                                                     |
| Migrations               | `prisma migrate status`                                   | "Database schema is up to date"                           |
| Seed                     | `prisma/seed/index.ts` ×2                                 | 5 roles / 8 permissions / 14 grants, stable across runs   |
| Identity regression scan | `tests/unit/core/caller-identity.test.ts`                 | no `req.user`, no payload-id fallback, no hardcoded actor |
| DI wiring scan           | `tests/unit/di-wiring.test.ts`                            | every `asClass` service resolves                          |
| Webhook signature        | `tests/integration/payment-webhook.test.ts` + route-graph | valid / invalid / tampered / missing / replay / duplicate |
| Payout                   | `tests/integration/payout-authorization.test.ts`          | **20 passed**                                             |
| Earnings pipeline        | `tests/integration/earnings-pipeline.test.ts`             | **15 passed**                                             |

No test was deleted, skipped, or weakened to obtain these results.

### Role & permission seeding

| Role                 | Permissions                                                         |
| -------------------- | ------------------------------------------------------------------- |
| `admin`              | 8 — all                                                             |
| `finance`            | 3 — `payouts:execute`, `refunds:process_any`, `rides:read_any`      |
| `support`            | 3 — `rides:read_any`, `safety:read`, `support:read`                 |
| `customer`, `driver` | 0 — ordinary principals; access is by **ownership**, not capability |

`finance` deliberately holds neither `drivers:verify` nor `drivers:suspend`: finance moves money, it does not decide who may carry passengers. Asserted in both directions by integration tests.

The seed converges rather than only adding — grants no longer in the declared map are revoked, so a capability can actually be taken away.

---

## Remaining Production Risks

Genuinely unresolved. Each is real, none is hypothetical.

### R-1 · Settlement periods are not scheduled — **MEDIUM**

_(Supersedes the closed "placeholder settlement" risk — see §5.)_

Settlement amounts are now derived from real fares, but `SettlementJob.run`
takes `(driverIds, periodStart, periodEnd)` and is **not on the schedule**: a
cron trigger cannot supply those inputs, so nothing settles a period
automatically. Settlements exist only when something calls the service — today
that is operator tooling or a test.

Closing it needs a business decision this repository cannot make: the period
length and boundary (weekly? daily? which timezone?), and how the driver set is
enumerated. Once decided it is a small job change, and the derivation behind it
is already correct and tested.

### R-2 · `DriverWallet.balance` is still never written — **LOW**

_(Reduced from the closed "earnings never reach the ledger" risk.)_

Earnings now reach the **ledger**, which is the authoritative record and what
settlement and payout read. The separate `DriverWallet` projection in the
drivers module remains read-only — `DriverWalletViewService` only reads it and
nothing credits it, so `GET /drivers/:id/wallet` reports a zero balance.

It is a display surface, not an authority, so no money decision depends on it.
Either populate it from ledger entries or drop the endpoint; leaving it showing
zero while the driver has earnings is the worst of the three.

### R-3 · Redis is a single point of failure with no HA — **HIGH**

Authenticated traffic fails **closed** on Redis loss by deliberate design (epoch + session denylist). Production has one un-replicated instance; `values-production.yaml` declares no Sentinel, Cluster, or managed Redis. Any Redis blip is a total authenticated outage. Infrastructure work, not code.

### R-4 · `/metrics` is unauthenticated by necessity — **MEDIUM**

A Prometheus scraper carries no token, so the endpoint is public and network placement is the access control. It must not be reachable from the internet. The payload is aggregate counters with a bounded label set — no PII, no per-user detail — but it does expose traffic volumes and failure rates. **Ingress rule required; nothing in this repository can enforce it.**

### R-5 · Payout gateway call sits inside the database transaction — **MEDIUM**

`executePayout` calls `gateway.createPayout` while the settlement row lock is held. A slow gateway holds a Postgres connection and blocks every other payout against that settlement for the duration. Correct, but it will not scale; the standard fix is to record the intent, commit, then call the gateway and reconcile asynchronously.

Related: the inner `catch` marks the payout `FAILED` and rethrows — which rolls back that write too, so no `FAILED` row survives. Harmless for the invariant (a rolled-back payout consumes no balance) but it means gateway failures leave no trace in `driver_payouts`.

### R-6 · Permission model is declared but not enforced — **LOW**

`app.authorize({ roles: [...] })` checks **role slugs**. The `permissions` / `role_permissions` tables are now seeded and correct, but `PermissionRepository` still has no callers — the capability map is documentation, not enforcement. Seeding it was deliberate: an empty table makes `findAllowedCodesForUser` return `[]` for everyone, which is a trap for the first feature that reads it. Moving the guard to permission codes is a separate change.

### R-7 · Self-service driver withdrawal is not implemented — **LOW**

`POST /payouts` is operator-only and pays whichever `driverId` the body names. That is correct for an operator. If drivers are ever to withdraw their own earnings, the driver id must be resolved from the token first — opening this route as-is would let any driver pay themselves from another's settlement.

### R-8 · PostgreSQL HA, backups, and PITR are unverified — **HIGH**

Nothing in `infrastructure/` configures them; `infrastructure/terraform/` is an empty directory. Outside this repository's control and not verifiable here.

---

## Verdict

**The backend security and readiness gate PASSES.** All thirteen gates are green,
verified against real Postgres and Redis through the mounted application, with
**1132 tests passing** (492 integration + 640 unit) and zero lint errors.

**The financial pipeline is now real, end to end.** A ride completed over HTTP
bills its actual distance, posts a balanced double-entry group in the same
transaction, settles from those fares, and caps the payout at what the driver
actually earned — asserted to the paise, under concurrency, and with cash rides
correctly leaving the driver owing commission rather than being paid twice. The
two HIGH risks that qualified the previous verdict (placeholder settlements, no
ledger posting) are closed.

**What remains before real money moves** is narrower and mostly not code:
settlement periods are not yet scheduled (R-1 — a business decision about period
length and boundaries), and the infrastructure gates (R-3 Redis HA, R-8
PostgreSQL HA/backups) remain outside this repository and unverified.

S3 and infrastructure were deliberately not touched.
