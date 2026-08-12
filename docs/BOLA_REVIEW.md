# BOLA / Object-Level Authorization Review — rides, drivers, payments

**Date**: 2026-08-11
**Branch**: `feature/auth`
**Scope**: The three unmounted modules, reviewed endpoint-by-endpoint before their routes are ever registered.
**Prerequisite for**: mounting `rides`, `drivers`, `payments` in `src/routes/register.ts`.

---

## Executive summary

**Every endpoint in all three modules authenticated as whoever the caller claimed to be.** Not some — every one. 27 identity reads across 11 controllers, all broken by the same root cause.

The auth plugin decorates `request.auth` (declared in [fastify.d.ts](src/types/fastify.d.ts)). **`request.user` is not a property this application ever sets.** Every controller read some variant of:

```ts
const userId = (req as any).user?.id ?? (req.body as any)?.userId;
```

The left side is always `undefined`, so the `??` always fired and the caller's identity came from the request body, path, or query. Three endpoints fell back to a literal (`?? 'driver'`, `?? 'system'`) — the same bug wearing a constant.

The `as any` casts are what hid it. Without them TypeScript would have rejected `req.user` outright, and the compiler would have caught this the day it was written.

Two further findings surfaced that are not identity bugs but sit in the same trust boundary: the refund ceiling was taken from the request body, and the refund path never checked who owned the transaction being refunded.

**Severity: CRITICAL.** Had these routes been mounted, the platform would have had no object-level authorization at all.

---

## Findings

Severity assumes the routes are mounted. All are now fixed.

### F-1 · CRITICAL · Identity taken from the request payload — 27 sites, 11 controllers

| Module   | Endpoint                                      | Identity source before                | Impact                                                              |
| -------- | --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| rides    | `POST /requests`                              | `req.body.customerId`                 | Raise a ride request as any customer                                |
| rides    | `POST /accept`                                | `req.body.driverId`                   | Accept a ride as any driver                                         |
| rides    | `POST /:id/arrive`,`/start`,`/complete`       | literal `'driver'`                    | Act on any ride; ownership check compared against a constant        |
| rides    | `POST /:id/cancel`                            | `req.auth` absent → role always false | Every cancel recorded as `CANCELLED_BY_CUSTOMER`                    |
| rides    | `GET /active`, `GET /history`                 | `req.params.userId`                   | Read any user's rides                                               |
| drivers  | `GET /me`                                     | `req.query.userId`                    | Provision **and read** a driver profile for any user                |
| drivers  | `PATCH /:driverId/profile`                    | `req.params.driverId`                 | Rewrite another driver's legal name, address, identity docs         |
| drivers  | `POST /:driverId/documents`                   | `req.params.driverId`                 | Submit documents against another driver                             |
| drivers  | `POST /status/online`,`/offline`,`/heartbeat` | `req.body.driverId`                   | Put a rival online, take them offline mid-trip, forge heartbeats    |
| drivers  | `POST /location`                              | `req.body.driverId`                   | Write arbitrary positions for any driver — enough to steer dispatch |
| drivers  | `GET /:driverId/wallet`, `/transactions`      | `req.params.driverId`                 | Read any driver's balance and full earnings history                 |
| payments | `POST /intents`                               | `req.body.userId`                     | Create a payment intent as any user                                 |
| payments | `GET /wallet/balance`, `POST /topup`, `/hold` | `req.params/body.userId`              | Read and move any user's wallet                                     |
| payments | `GET /methods`                                | `req.params.userId`                   | Read any user's saved payment methods                               |
| payments | `POST /refunds`                               | literal `'system'`                    | Every refund attributed to a non-existent actor                     |
| payments | `POST /payouts`                               | `req.body.driverId`                   | Trigger a payout naming any driver                                  |

**Fix**: [`src/core/auth/caller.ts`](src/core/auth/caller.ts) — `requireCaller` / `callerId` / `callerHasRole` / `assertOwnerOrStaff` / `assertRideParty`. There is deliberately **no fallback parameter**, so a controller cannot express "identity, or else whatever the client sent". All 27 sites now read the token.

### F-2 · CRITICAL · Reads with no ownership check

`GET /rides/:id` and `GET /rides/:id/receipt` returned any ride to any authenticated caller — both parties, pickup and drop addresses, and the fare. `GET /drivers/:id/location` let anyone track any driver in real time.

**Fix**: `assertRideParty` against the **stored** row (customer, or the assigned driver's user, or staff). `findById` now selects `driver.userId` — `rides.driver_id` is the Driver PK and never equals a user id, so without it there was nothing to compare the driver side against. Driver location reads are self-or-staff.

> A customer on an active ride does legitimately need their driver's position. That is **not** served here — it belongs on a ride-scoped route authorized against the ride's parties, so the grant ends when the ride does. Keying it on driver id would reintroduce exactly this hole. Noted, not built.

### F-3 · CRITICAL · Customer cancellation skipped authorization entirely

`LifecycleService.cancelRide` passed the actor to `lockAndValidate` only when `cancelledBy === 'DRIVER'`; a `CUSTOMER` cancel passed `null`, which skipped the check. Any authenticated caller could cancel any ride by id — and incur that customer's cancellation fee.

**Fix**: the actor is now a discriminated union (`driver` / `customer` / `system`). Both parties are checked against the locked row; the two live in different columns (`driverId` is a Driver PK, `customerId` is a user id), which is why a single nullable string was the wrong shape and made the omission easy to miss. `system` remains unchecked — it is the timeout sweep, not a request — and a party-initiated cancel with no actor now raises `RideActorRequiredError` rather than falling through to the unchecked path.

### F-4 · CRITICAL · Refund ceiling supplied by the caller

`processRefund` took `transactionCapturedAmount` **from the request body** and used it as the maximum refundable. A caller could declare a capture of any size and withdraw it.

**Fix**: the captured amount is read from the stored `payment_transactions` row. `transactionCapturedAmount` is no longer accepted from the request at all.

### F-5 · CRITICAL · Refunds never checked transaction ownership

Nothing verified that the `transactionId` in the body belonged to the caller. Any guessed id could be refunded.

**Fix**: ownership checked against the stored transaction; staff may act on a customer's behalf via an explicit `actorIsStaff` flag derived from the token. A foreign transaction and a missing one return the **same** error, so the endpoint is not an id oracle (tested).

### F-6 · HIGH · `POST /intents/:intentId/confirm` had no ownership check

Any caller could settle any intent by id, forcing someone else's payment through and posting its ledger group.

**Fix**: `assertOwnerOrStaff` against the stored intent before confirming.

### F-7 · HIGH · No route carried a role guard

`POST /drivers/:id/verify` — the gate deciding who may carry passengers — and `POST /drivers/:id/suspend` had no role check. Neither did payouts.

**Fix**: `authorize({ roles: ['admin'] })` on verification and suspension; `['admin','finance']` on payouts. Driver-side ride transitions and going online carry `requireOperableDriver`, so a suspended driver or one with expired documents is refused at the auth layer before any ride state is touched.

### F-8 · HIGH · Webhook route would never have worked

`POST /payments/webhooks/:gateway` was not marked `public`, so the deny-by-default gate would have rejected every gateway callback (a gateway has no bearer token).

**Fix**: marked `public` — the HMAC signature is its credential — with a rate limit that fails **open**, because dropping real payment notifications during a Redis outage costs money and the signature check still applies.

### F-9 · MEDIUM · Driver-side `GET /rides/active` never worked

`(req as any).user?.role === 'DRIVER'` was always false, so a driver asking for their active ride was queried as a customer and always got `null`. A correctness bug from the same root cause.

**Fix**: role read from the token claim; new `findActiveByDriverUserId` queries through the relation rather than passing a user id where a driver id is expected.

---

## What changed

| File                                                         | Change                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `src/core/auth/caller.ts` _(new)_                            | Caller identity + ownership assertions, no fallback parameter     |
| `src/modules/drivers/controllers/driver-identity.ts` _(new)_ | `actingDriverId` / `authorizedDriverId` — user→driver translation |
| 11 controllers across 3 modules                              | All 27 identity reads now from `request.auth`                     |
| 3 route files                                                | Role guards, operability gates, rate limits, webhook `public`     |
| `LifecycleService`                                           | Discriminated actor; customer cancel now authorized               |
| `RefundService` + `RefundRepository`                         | Captured amount and owner read from storage                       |
| `IntentService` / `IntentController`                         | `findById` + ownership check before confirm                       |
| `RideRepository`                                             | `driver.userId` on `findById`; `findActiveByDriverUserId`         |

**Not touched**: Auth, Users, Files, and the outbox — all previously verified to derive identity correctly from `request.auth`, with no client-supplied ids on the live surface.

---

## Test evidence

| Check                                  | Command                             | Result                                                     |
| -------------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| Unit tests                             | `npm run test:unit`                 | **638 passed, 0 failed** (129 suites), was 610             |
| TypeScript (app)                       | `npx tsc -p tsconfig.json --noEmit` | exit 0                                                     |
| TypeScript (tools)                     | `npx tsc -p tsconfig.tools.json`    | exit 0                                                     |
| ESLint — files authored/rewritten here | `eslint <those paths>`              | **0 errors**                                               |
| ESLint — whole repo                    | `eslint src tests --max-warnings=0` | 123 errors, all pre-existing (was 181)                     |
| Integration tests                      | `npm run test:integration`          | **NOT RUN** — no Postgres/Redis/Docker in this environment |

**Tests added (28):**

- `tests/unit/core/caller-identity.test.ts` (17) — helper semantics, plus a **regression scan** over every `*.controller.ts` that fails if `req.user`, a `?? req.body/params/query` identity fallback, or a hardcoded actor reappears. It strips comments first (these files quote the old pattern when explaining the fix) and asserts that stripping still works, so it cannot pass vacuously.
- `tests/unit/payments/refund-ownership.test.ts` (6) — foreign transaction refused, indistinguishable from missing, staff override, stored-amount ceiling.
- `tests/unit/rides/ride-lifecycle-concurrency.test.ts` (+5) — customer cancel ownership, driver cancel ownership, actor required, `SYSTEM` still exempt.

Lint dropped 181 → 123 as a side effect: rewriting these controllers removed 58 `any` usages.

---

## Honest limitations

1. **No integration test exercised a real HTTP request.** Postgres, Redis, and Docker are all unavailable here. These are unit tests against the controller and service logic; they prove the authorization decisions are correct given the inputs, not that Fastify wires the guards as expected end to end. CI provisions PostGIS and Redis — run it there before mounting.

2. **The route guards are unexercised.** `authorize({ roles: [...] })` and `requireOperableDriver` are now declared, but no test boots the app and asserts a 403. That needs the integration harness.

3. **`finance` is not a seeded role.** The payout guard names `['admin', 'finance']`; if `finance` does not exist in the role seed, only admins pass. Verify against `prisma/seed` before relying on it.

4. **Webhook raw-body capture is still missing** (F-8 fixes the gate, not this). `WebhookController` reads `req.rawBody`, which nothing sets, so it falls back to re-serialising the parsed body — that will not match the gateway's signature. It fails **closed**, which is the safe direction, but the route cannot work until a `preParsing` hook captures the untouched buffer. The correct hook depends on which gateway is chosen.

5. **I did not review `chat`, `sos`, `support`, `reviews`** — those modules are still `export {}` stubs with no endpoints to review.

---

## Verdict on the original prerequisite

The BOLA review is **complete and its findings are fixed**. That removes the blocker I flagged against mounting these routes.

It does **not** by itself make mounting safe. Before registering them in `src/routes/register.ts`:

- [ ] Run the integration suite in CI (real Postgres + Redis) — none of this has been exercised over HTTP
- [ ] Add integration tests asserting 403 on cross-tenant access for at least one endpoint per module
- [ ] Confirm the `finance` role is seeded, or drop it from the payout guard
- [ ] Add the webhook `preParsing` raw-body hook, or leave the webhook route unmounted
- [ ] Apply `20260810100000_ride_request_unique` after running its duplicate-detection query

The wider release blockers from the hardening report are unchanged: Redis has no HA, and CI is red on 123 pre-existing lint errors.
