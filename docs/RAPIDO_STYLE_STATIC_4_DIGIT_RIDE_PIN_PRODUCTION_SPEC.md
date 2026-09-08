# Rapido-Style Static 4-Digit Ride PIN — Production Specification

**Status:** Design proposal. **No code, schema, migration, or dependency in this repository was changed to produce this document.**
**Repository:** `backend_zaroorat` — branch `admin-folder`
**Date:** 2026-09-08
**Scope:** Analysis of the current ride-start verification implementation, and the target architecture that replaces it with a customer-owned static 4-digit Ride PIN.

### Evidence labelling used throughout

| Tag                | Meaning                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| **[VERIFIED]**     | Read directly from source in this repository. File and line cited.                      |
| **[INFERRED]**     | Follows from verified code plus documented library/platform semantics. Reasoning shown. |
| **[TARGET]**       | Recommended design. Does not exist today.                                               |
| **[NOT VERIFIED]** | Could not be established from the repository. Not guessed.                              |

> "Rapido-style static 4-digit customer PIN experience" describes the **product behaviour** only. We have no access to Rapido's backend. Every mechanism below is designed independently for this codebase.

---

## 1. Executive Summary

Today the platform issues a **fresh 6-digit, ride-scoped OTP** at driver acceptance, stores it as a peppered HMAC in `ride_otps`, SMSes it to the customer — **and also returns it in plaintext to the driver in the accept response**. The passenger-presence control it exists to enforce is therefore void. Separately, the 5-attempt brute-force counter is incremented inside the ride-start transaction and is rolled back by the very exception that a wrong guess raises, so the cap never engages, and the route carries no HTTP rate limit.

The target replaces this with a **static 4-digit PIN owned by the customer account**, stored as a **salted scrypt verifier** (not the existing HMAC — see §8.3, this is the single most consequential design decision in this document), verified against `ride.customerId` at ride start, and protected by **layered Redis throttling that persists independently of the ride transaction**.

The good news is how much survives: the entire authorization chain, the ride state machine, the row-locking and conditional-update concurrency model, the trip meter, and the audit/outbox/realtime pipeline are all **credential-model independent and need no change**. The migration is concentrated in three places — where the credential is stored, where it is verified, and where attempts are counted.

---

## 2. Current Architecture **[VERIFIED]**

```
Customer  POST /api/v1/rides/quote      -> RideRequestController.quote        -> RideRequestService.createQuote -> PricingService
Customer  POST /api/v1/rides/requests   -> RideRequestController.createRequest -> RideRequestService.createRequest
                                        -> RideRequestRepository.create (ride_requests)
                                        -> EventPublisher.publish(ride.requested) [outbox row, inside tx]
OutboxRelay -> EventBus -> RideRequestedConsumer.handle -> DispatchService.dispatchNextBatch
                                        -> MatchingService.findEligibleCandidates (geo -> SQL -> vehicle documents)
                                        -> DispatchService.offerToDriver xN (ride_dispatches) + ride.dispatch.offered
Driver    POST /api/v1/rides/accept     -> RideStateController.accept -> LifecycleService.acceptRideRequest
                                        -> [ONE TX] lock request, assert offer actionable, self-ride guard,
                                           active-ride guard, ONLINE guard, vehicle eligibility, claimForMatch,
                                           RideRepository.create (status ACCEPTED),
                                           RideOtpService.generateStartOtp   <-- credential minted here
                                           resolveOffers, driver -> ON_TRIP, ride_status_events, ride.accepted
                                        -> [AFTER COMMIT] deliverStartOtpToCustomer (SMS)
                                        -> RESPONSE: { data: { ride, plaintextOtp } }   <-- LEAK
Driver    POST /api/v1/rides/:id/arriving -> LifecycleService.markDriverArriving  (ACCEPTED -> DRIVER_ARRIVING)
Driver    POST /api/v1/rides/:id/arrive   -> LifecycleService.markDriverArrived   (-> DRIVER_ARRIVED)
Driver    POST /api/v1/rides/:id/start    -> LifecycleService.startRide
                                        -> [ONE TX] lockForUpdate + driver ownership + transition check
                                           -> RideOtpService.verifyStartOtp
                                           -> updateStatusIf(DRIVER_ARRIVED -> IN_PROGRESS, startedAt)
                                           -> ride_status_events, ride.started (outbox)
                                        -> [AFTER COMMIT] resetTripMeter(driverId)
OutboxRelay -> EventBus -> RideRealtimeConsumer (socket) + RideNotificationConsumer (push)
```

### 2.1 Booking flow detail **[VERIFIED]**

| Item                 | Value                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint             | `POST /api/v1/rides/requests` — `src/routes/register.ts:27`, `src/modules/rides/routes/ride.routes.ts:33`                                                   |
| Controller           | `RideRequestController.createRequest` — `src/modules/rides/controllers/ride-request.controller.ts:30`                                                       |
| Service              | `RideRequestService.createRequest` — `src/modules/rides/services/request/ride-request.service.ts:290`                                                       |
| Request DTO          | `createRideRequestSchema` (zod) — `src/modules/rides/schemas/ride.schemas.ts`                                                                               |
| Response DTO         | None attached. Raw `{ data: RideRequest }`                                                                                                                  |
| Table                | `ride_requests`                                                                                                                                             |
| Transaction boundary | `txManager.execute` at `ride-request.service.ts:413`. All validation runs **before** it                                                                     |
| Authorization        | Deny-by-default `onRequest` hook — `src/modules/auth/plugins/auth.plugin.ts:142-148`; customer from `callerId(req)`, never the body                         |
| Validation           | Profile completeness (`:311`), rider debt cap (`:322`), one-active-ride (`:325-331`), vehicle type active (`:339`), pickup/drop serviceability (`:341-353`) |
| Idempotency          | Optional `Idempotency-Key` header -> `redisService.idempotency.runOnce` — `ride-request.controller.ts:50-58`                                                |
| Rate limit           | `rateLimits.rideWrite` — 60/hour/user — `src/config/rate-limit/rate-limit.config.ts:40-45`                                                                  |
| Concurrency backstop | `ride_requests_active_customer_key` partial unique index -> `UniqueConstraintError` -> `ActiveRideExistsError` (`:451-456`)                                 |
| Events               | `ride.requested` (durable, outbox, in tx)                                                                                                                   |
| Realtime             | `RideRealtimeConsumer.onRideRequested` -> `SOCKET_EVENT.RIDE_REQUESTED` to the customer's user room                                                         |

### 2.2 Dispatch and matching **[VERIFIED]**

- `DispatchService.dispatchNextBatch` — `dispatch.service.ts:106` — holds a Redis lock `dispatch:request:<id>` (10s) so two rounds cannot interleave, then delegates to `runDispatchRound` (`:122`).
- Candidate selection: `MatchingService.findEligibleCandidates` — `src/modules/matching/services/matching.service.ts:29`. Geo shortlist, then one indexed SQL pass (`operableDriverIds`, `:69`) for VERIFIED / not suspended / ONLINE / no active ride / active assignment on an active+verified vehicle of the right category, then per-candidate document eligibility.
- Offers: `offerToDriver` (`:59`) writes `ride_dispatches` and publishes `ride.dispatch.offered` to that driver's room only.
- Batch semantics: `batchSize` is how many drivers may **hold** an offer at once, not how many to add per round (`:134-141`).

### 2.3 Arrival flow **[VERIFIED]**

| Transition                                    | Endpoint                   | Service                                           | Authorization                                                             | Audit                              | Realtime                                                 |
| --------------------------------------------- | -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `ACCEPTED -> DRIVER_ARRIVING`                 | `POST /rides/:id/arriving` | `markDriverArriving` — `lifecycle.service.ts:421` | `authorize({requireOperableDriver})` + `lockAndValidate` driver-ownership | `ride_status_events`               | `ride.driver_arriving` -> `SOCKET_EVENT.DRIVER_ARRIVING` |
| `ACCEPTED\|DRIVER_ARRIVING -> DRIVER_ARRIVED` | `POST /rides/:id/arrive`   | `markDriverArrived` — `lifecycle.service.ts:450`  | same                                                                      | `ride_status_events` + `arrivedAt` | `ride.driver_arrived`                                    |

**Can a driver skip arrival and call start directly? NO. [VERIFIED]** `ALLOWED_TRANSITIONS` (`lifecycle.service.ts:78-96`) lists `IN_PROGRESS` only under `DRIVER_ARRIVED`. From `ACCEPTED` or `DRIVER_ARRIVING`, `validateTransition` throws before the credential is even consulted. `DRIVER_ARRIVING` is skippable (`ACCEPTED -> DRIVER_ARRIVED` is permitted) — intentional, and not a bypass of the credential gate.

---

## 3. Current OTP Flow

### 3.1 Generation at acceptance **[VERIFIED]**

`LifecycleService.acceptRideRequest` — `src/modules/rides/services/lifecycle/lifecycle.service.ts:308`

| Question                 | Answer                                                                                                                                                                                 | Evidence                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Controller               | `RideStateController.accept`                                                                                                                                                           | `ride-state.controller.ts:36-45`                                    |
| Service                  | `LifecycleService.acceptRideRequest`                                                                                                                                                   | `lifecycle.service.ts:308`                                          |
| Transaction              | One `txManager.execute` (`:316`), default isolation (no `isolationLevel` is ever passed — `TransactionManager.ts:25-29`), i.e. Postgres READ COMMITTED                                 | `TransactionManager.ts:15-34`                                       |
| Driver assignment        | Atomic — `driverId` written in the same `INSERT` that creates the ride                                                                                                                 | `ride.repository.ts:36-68`                                          |
| Ride state               | New `rides` row, schema default `ACCEPTED`. There is no `REQUESTED -> ACCEPTED` transition on `rides`; the pre-ride phase lives on `ride_requests` (`CREATED -> SEARCHING -> MATCHED`) | `ride.prisma:77`                                                    |
| Credential generated?    | **Yes**                                                                                                                                                                                | `lifecycle.service.ts:367`                                          |
| Where                    | `RideOtpService.generateStartOtp`                                                                                                                                                      | `src/modules/rides/services/otp/ride-otp.service.ts:13`             |
| Randomness               | `crypto.randomInt(0,10)` per digit — CSPRNG, uniform, leading zeros preserved                                                                                                          | `src/modules/rides/utils/otp.util.ts:3-9`                           |
| Length                   | 6 (`RIDE_OTP_LENGTH`)                                                                                                                                                                  | `src/modules/rides/constants/ride.constants.ts:15`                  |
| Storage                  | `ride_otps.otp_hash` — HMAC-SHA256 with server-side pepper                                                                                                                             | `ride-otp.repository.ts:6-26`, `otp.hasher.ts:8-10`                 |
| Scope                    | **Ride-scoped.** `ride_otps.ride_id`, no customer column                                                                                                                               | `ride.prisma:231-246`                                               |
| Plaintext returned?      | **YES — to the driver**                                                                                                                                                                | `lifecycle.service.ts:312-315,387` -> `ride-state.controller.ts:44` |
| SMS sent?                | Yes, after commit, best-effort                                                                                                                                                         | `lifecycle.service.ts:390-394`, `:401-419`                          |
| Socket events?           | Yes — `ride.accepted`, payload `{ rideId, driverId }`, **no credential**                                                                                                               | `lifecycle.service.ts:382-385`                                      |
| Credential in any event? | **No**                                                                                                                                                                                 | verified across catalog, consumers, outbox                          |

### 3.2 Verification at start **[VERIFIED]**

`RideOtpService.verifyStartOtp` — `ride-otp.service.ts:33-55`

1. `otpRepo.findLatestByRideId(rideId, tx)` — newest row for the ride **filtered `verified: false`** (`ride-otp.repository.ts:27-33`). Ride-scoped.
2. Expiry: `latestOtp.expiresAt.getTime() <= Date.now()` -> `OtpVerificationError('OTP has expired')` (`:42-44`).
3. Attempts: `otpRepo.claimAttempt(id, 5, tx)` — conditional `updateMany ... WHERE verified=false AND attempts < max` returning `count === 1` (`ride-otp.repository.ts:53-60`). **Atomic in form — but see §4 CRITICAL-2.**
4. Comparison: `this.otpHasher.hash(plaintextOtp) !== latestOtp.otpHash` — plain `!==` on 64-char hex digests (`:48`).
5. Consumption: `otpRepo.claimVerification(id, tx)` — conditional `updateMany ... WHERE verified=false` returning `count === 1` (`ride-otp.repository.ts:61-68`).

### 3.3 Current credential properties **[VERIFIED]**

| Property          | Current implementation                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Credential        | 6-digit numeric OTP, minted per ride at acceptance                                                                       |
| Length            | 6 (`RIDE_OTP_LENGTH = 6`)                                                                                                |
| Owner             | **The ride** (`ride_otps.ride_id` FK -> `rides.id`)                                                                      |
| Scope             | Per-ride, single-use                                                                                                     |
| Generation        | `crypto.randomInt` per digit, CSPRNG, full 10^6 keyspace incl. leading zeros                                             |
| Storage           | Postgres `ride_otps.otp_hash`; plaintext never persisted                                                                 |
| Hashing           | HMAC-SHA256, **unsalted**, single pass (`otp.hasher.ts:9`)                                                               |
| Pepper            | `OTP_PEPPER` env, else derived `HMAC(JWT_REFRESH_SECRET, 'zaroorat:otp:pepper:v1')` (`src/config/otp/otp.config.ts:3-9`) |
| Expiration        | 15 minutes (`RIDE_OTP_TTL_MINUTES = 15`)                                                                                 |
| Attempts          | Nominally 5 — **ineffective, see CRITICAL-2**                                                                            |
| Replay protection | Strong: `claimVerification` conditional UPDATE + `verified:false` read filter + `updateStatusIf`                         |
| Customer access   | SMS only (`lifecycle.service.ts:406-413`). No REST/socket/push path                                                      |
| Driver access     | **Full plaintext, in the accept response body**                                                                          |

### 3.4 Current customer experience **[VERIFIED]**

- **REST:** not exposed. `Ride` has no OTP column; `ride.repository.ts` `findById`/`findActiveForUser`/`listCustomerRides` never `include` the `otps` relation.
- **SMS:** the only channel — `deliverStartOtpToCustomer` (`lifecycle.service.ts:401-419`), after commit, wrapped in a `try/catch` that only `logger.warn`s, and returns silently if the user row is missing.
- **Push:** not exposed. `RideNotificationConsumer` sends fixed title/body strings.
- **Socket:** not exposed. `RideRealtimeConsumer` re-resolves participants from the ride row and forwards `{ rideId, driverId }`.
- **Resend:** **does not exist.** `generateStartOtp` has exactly one production caller; there is no resend/regenerate route, service method, or job anywhere in `src/modules/rides`.
- Frontend display behaviour: **[NOT VERIFIED]** — mobile client code is not in this repository.

### 3.5 Current driver experience **[VERIFIED]**

> **Does the driver receive the plaintext credential? YES.**

- `acceptRideRequest` return type is `Promise<{ ride: Ride; plaintextOtp: string }>` — `lifecycle.service.ts:312-315`, returned at `:387`.
- `RideStateController.accept` does `reply.send({ data: result })` — `ride-state.controller.ts:44`.
- `POST /accept` has **no response schema** — `ride.routes.ts:47` attaches only a `preHandler`. `ride.responses.ts` exists but is wired to no route.
- There is **no** `setSerializerCompiler`, `setReplySerializer`, or `onSend` hook anywhere in `src/` (exhaustive grep, zero hits). Nothing strips the field.
- The repository's own tests consume it: `tests/integration/helpers/ride-flow.ts:106` and `tests/integration/earnings-pipeline.test.ts:734` read `accepted.json().data.plaintextOtp` and then successfully start the ride with it.

Not exposed anywhere else: ride detail, active-ride, socket, push, dispatch payloads, logs, errors, admin, analytics, outbox, Swagger.

---

## 4. Current Security Findings

### CRITICAL-1 — Plaintext OTP returned to the driver

- **File / Function:** `lifecycle.service.ts:308-390` (`acceptRideRequest`) -> `ride-state.controller.ts:36-45` (`accept`)
- **Evidence:** as §3.5. Confirmed by two passing integration tests that depend on the leak.
- **Why it matters:** the credential's sole purpose is to prove the passenger is present and consenting. Handing it to the driver at acceptance voids that control entirely.
- **Current behaviour:** a driver can start, complete and bill a ride with no passenger present. Fare, driver earnings, and commission ledger entries are all created for a journey nobody took.

### CRITICAL-2 — Failed attempts are rolled back; the brute-force cap never engages

- **File / Function:** `ride-otp.service.ts:45-50`, called at `lifecycle.service.ts:495` inside `txManager.execute`
- **Evidence [VERIFIED + INFERRED]:** `claimAttempt(id, MAX, tx)` increments `attempts` **on the transaction client `tx`** (`ride-otp.repository.ts:53-60`). On a wrong code the next statement throws (`ride-otp.service.ts:49`), the exception propagates out of the `$transaction` callback (`TransactionManager.ts:29`), and a Prisma interactive transaction rolls back when its callback throws — discarding the increment along with everything else. `attempts` can therefore only ever persist on the success path.
- The unit test that appears to prove the cap (`tests/unit/rides/ride-otp.test.ts:86-123`) uses an in-memory fake repo with no transaction, so it mutates a plain object that is never rolled back. It passes while production does not hold.
- No HTTP rate limit backs it up: `ride.routes.ts:52` uses `driverOnlyById` = `byId + authorize` only. `rateLimits.rideWrite` is applied to `/requests` and the cancel routes, never to `/accept` or `/:id/start`.
- **Current behaviour:** the assigned driver can guess unlimited times within the 15-minute window. Not reachable by a third party (`lockAndValidate` refuses non-assigned drivers first), but it removes the only anti-guessing control — precisely the control that would otherwise be the last line of defence behind CRITICAL-1.
- **Classification:** the rollback is **[INFERRED]** from verified code plus documented Prisma semantics. It was not executed. One integration test against a real database settles it definitively; that test is specified in §24.

### HIGH-1 — Expired OTP permanently bricks the ride

- **File / Function:** `ride-otp.service.ts:42-44`; `generateStartOtp` has one caller (`lifecycle.service.ts:367`)
- **Evidence:** 15-minute TTL from acceptance, no regeneration path anywhere.
- **Current behaviour:** a pickup slower than 15 minutes leaves a ride that can never legally reach `IN_PROGRESS`. The only exit is cancellation.

### HIGH-2 — Customer delivery is best-effort and silently swallowed

- **File / Function:** `deliverStartOtpToCustomer` — `lifecycle.service.ts:401-419`
- **Evidence:** `try/catch` -> `logger.warn` only (`:414-416`); silent return if the user row is missing (`:410`). SMS is the only channel; no resend exists.
- **Current behaviour:** masked today by CRITICAL-1 — the driver already has the code, so rides still start. Fixing CRITICAL-1 alone converts every dropped SMS into a dead ride.

### MEDIUM-1 — `otpCode` is length-validated, not digit-validated

`src/modules/rides/schemas/ride.schemas.ts:48` — `z.string().length(RIDE_OTP_LENGTH)`. `"abcdef"` passes and reaches `verifyStartOtp`.

### MEDIUM-2 — Non-constant-time comparison

`ride-otp.service.ts:48` — plain `!==`, not `crypto.timingSafeEqual`. Both operands are hex HMAC digests; without the pepper an attacker cannot steer the digest, so the channel yields nothing usable. Noted for completeness; not exploitable as written. **It becomes materially more relevant under a long-lived PIN** — see §8.3.

### MEDIUM-3 — `RideRepository.updateStatus` is an unguarded status writer

`ride.repository.ts:121-141` — plain `update` with no expected-status predicate. **No current caller** writes a ride status through it (verified by grep). A latent footgun beside `updateStatusIf`.

### MEDIUM-4 — Trip meter reset is outside the transaction and swallows errors

`lifecycle.service.ts:519-534`. The ordering is deliberate and correct; the swallow means a failed Redis `DEL` silently carries pre-trip mileage into the fare, bounded only by `assertPlausibleTripData`.

### MEDIUM-5 — OTP verification failures are not observable

`RideMetrics.otpFailure` is defined at `src/modules/rides/metrics/ride.metrics.ts:32` and has **zero callers** (verified by grep across `src` and `tests`). Nothing counts failed start attempts today, so a brute-force run would raise no signal.

### LOW-1 — `plaintextOtp` is not in the log-redaction list

`src/shared/logger/redact.ts:1-27` covers `otp`, `otpCode`, `body`, `variables` — not `plaintextOtp`. No current log statement emits it; the gap is latent.

### LOW-2 — Credentials in development logs

`src/modules/notifications/providers/mock.provider.ts:14-19` logs `devSmsBody` at debug in `development`; `src/shared/logger/logger.ts:10-15` strips all `otp`/`phone` redaction paths in `development`; `src/modules/auth/services/otp/otp.service.ts:106` logs `{ otp: code }` at debug. Environment-gated and evidently deliberate. Note only.

### Verified negatives (no leakage)

| Channel                                             | Result                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /rides/active`, `/rides/:id`, `/rides/history` | Not exposed — no OTP column, no `include` of the relation         |
| Socket events                                       | Not exposed — payload `{ rideId, driverId }`                      |
| Push notifications                                  | Not exposed — fixed strings                                       |
| Outbox rows                                         | Not exposed                                                       |
| `ride_status_events`                                | Not exposed — `fromStatus/toStatus/actorType/actorId/reason`      |
| Admin / analytics / support                         | Not exposed — grep for `rideOtp\|ride_otps\|otpHash` returns zero |
| Error messages                                      | Not exposed — `OtpVerificationError` messages are generic         |
| Swagger                                             | Not exposed                                                       |

---

## 5. Current Code / File Map **[VERIFIED]**

| Responsibility             | File                                                             | Function / line                                                                            |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Booking (quote)            | `src/modules/rides/services/request/ride-request.service.ts`     | `createQuote:96`                                                                           |
| Booking (request)          | same                                                             | `createRequest:290`                                                                        |
| Booking controller         | `src/modules/rides/controllers/ride-request.controller.ts`       | `createRequest:30`                                                                         |
| Pricing                    | `src/modules/pricing/services/pricing.service.ts`                | `resolveRateCard`, `calculateFareQuote`                                                    |
| Surge                      | `src/modules/pricing/services/surge.service.ts`                  | `resolveSurgeMultiplier`                                                                   |
| Dispatch                   | `src/modules/rides/services/dispatch/dispatch.service.ts`        | `dispatchNextBatch:106`, `runDispatchRound:122`, `offerToDriver:59`                        |
| Matching                   | `src/modules/matching/services/matching.service.ts`              | `findEligibleCandidates:29`                                                                |
| Acceptance                 | `src/modules/rides/services/lifecycle/lifecycle.service.ts`      | `acceptRideRequest:308`                                                                    |
| Credential generation      | `src/modules/rides/services/otp/ride-otp.service.ts`             | `generateStartOtp:13`                                                                      |
| Credential randomness      | `src/modules/rides/utils/otp.util.ts`                            | `generateRideOtp:3`                                                                        |
| Credential hashing         | `src/modules/auth/services/otp/otp.hasher.ts`                    | `OtpHasher.hash:8`                                                                         |
| Credential storage         | `src/modules/rides/repositories/ride-otp.repository.ts`          | `create:6` -> `ride_otps`                                                                  |
| Customer delivery          | `src/modules/rides/services/lifecycle/lifecycle.service.ts`      | `deliverStartOtpToCustomer:401`                                                            |
| Driver arrival             | same                                                             | `markDriverArriving:421`, `markDriverArrived:450`                                          |
| Credential verification    | `src/modules/rides/services/otp/ride-otp.service.ts`             | `verifyStartOtp:33`                                                                        |
| Ride start                 | `src/modules/rides/services/lifecycle/lifecycle.service.ts`      | `startRide:487`                                                                            |
| Ride lock + party check    | same                                                             | `lockAndValidate:111`                                                                      |
| Transition table           | same                                                             | `ALLOWED_TRANSITIONS:78-96`, `validateTransition:105`                                      |
| Conditional status claim   | `src/modules/rides/repositories/ride.repository.ts`              | `updateStatusIf:142`, `lockForUpdate:25`                                                   |
| Trip meter                 | `src/core/cache/stores/TripDistanceStore.ts`                     | `add`/`read`/`reset`; reset at `lifecycle.service.ts:530`                                  |
| Trip meter accrual         | `src/modules/drivers/services/location/location.service.ts`      | `accrueTripDistance:92`                                                                    |
| Audit                      | `src/modules/rides/repositories/ride-status-event.repository.ts` | `record:6` -> `ride_status_events`                                                         |
| Outbox                     | `src/core/events/EventPublisher.ts`, `OutboxRelay.ts`            | `publish:16`, `processBatch:32`                                                            |
| Realtime                   | `src/modules/rides/consumers/ride-realtime.consumer.ts`          | `onRideEvent` -> `RealtimeGateway.emitToRoom`                                              |
| Push                       | `src/modules/rides/consumers/ride-notification.consumer.ts`      | `onRideEvent`                                                                              |
| Rate limiting primitive    | `src/core/cache/stores/RateLimitStore.ts`                        | `hit:19`, `enforceMinInterval:39`                                                          |
| Password/PIN-grade hashing | `src/modules/auth/utils/password.ts`                             | `hashPassword:8`, `verifyPassword:18` (scrypt N=16384, per-record salt, `timingSafeEqual`) |
| Step-up OTP challenge      | `src/modules/auth/services/otp/otp.service.ts`                   | `send:67`, `verify:141`                                                                    |
| Step-up precedent          | `src/modules/users/services/phone/phone-change.service.ts`       | `requestPhoneChange:61`, `verifyPhoneChange`                                               |
| Auth gate                  | `src/modules/auth/plugins/auth.plugin.ts`                        | `authenticate:37`, `authorize:66`, `denyByDefault:142`                                     |
| Ride party helper          | `src/core/auth/caller.ts`                                        | `assertRideParty:45`, `callerId:28`                                                        |

---

## 6. Target Business Requirements **[TARGET]**

1. Each customer account holds **one standing 4-digit Ride PIN**.
2. The PIN does **not** change per ride. Customer A uses `4827` on ride 1, ride 2 and ride 3.
3. The PIN changes only when the customer explicitly changes or resets it.
4. The PIN is **not globally unique**. Customer A = `4827` and Customer B = `4827` is valid and expected.
5. No credential is generated at acceptance. No SMS is sent at acceptance.
6. The driver **never** receives the PIN through any channel.
7. The customer recites the PIN to the driver at the pickup point.
8. The backend verifies the tuple, and only that tuple:

```
Authenticated Driver + Assigned Ride + Ride's Customer + Customer's PIN
                     + Valid Ride State + Attempt/Rate Protection
```

The backend must never answer _"is 4827 a valid PIN?"_ — only _"is 4827 the PIN of the customer who owns this ride, and is this authenticated driver authorized to start it?"_

---

## 7. Target Static PIN Architecture **[TARGET]**

```
CUSTOMER ACCOUNT
      |
      +-- ride_pin_verifier (scrypt, salted, per-record)
                |
                v
        Customer books ride            <- gated: PIN must be configured
                |
                v
        Driver accepts ride
                |
       +--------+---------+
       |                  |
  NO PIN generation    NO SMS
       |                  |
       +--------+---------+
                v
        Driver marks arrived           <- DRIVER_ARRIVED required
                |
                v
        Customer recites PIN
                |
                v
        Driver submits PIN
                |
                v
   RidePinVerificationService
      |         |          |
   Driver     Ride      Customer
    Auth     Binding      PIN
      |         |          |
      +---------+----------+
                |
     Redis throttle / lockout          <- OUTSIDE the ride transaction
                |
     Ride state validation             <- unchanged: ALLOWED_TRANSITIONS
                |
     Atomic transition                 <- unchanged: lockForUpdate + updateStatusIf
                |
                v
            IN_PROGRESS
```

### 7.1 Ownership model

```
ride.customerId -> users.id -> users.ride_pin_verifier
```

Not `ride -> ride_otps`. Verification resolves the customer **from the ride row**, never from anything the driver's client sends.

---

## 8. Target Database Model **[TARGET]**

### 8.1 Placement — `users`, not `user_profiles`, not a new table

**Recommendation: three columns on `users`.**

| Reasoning                                                                                                                                                                                                                                                                                                                   | Evidence       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `users` already carries the platform's only other credential, `password_hash` (`prisma/schema/modules/user/user.prisma:5`), hashed with the same scrypt helper (`admin/staff-management/staff.service.ts:110`). A second credential belongs beside the first.                                                               | **[VERIFIED]** |
| `user_profiles` is **display data and is projected wholesale into API responses** (`profileResponse` on `GET /users/me`, `PATCH /users/me/profile` — `user.routes.ts:43-71`). A credential there is one careless `select` away from a response body. `users` is never wholesale-serialized; it is projected field by field. | **[VERIFIED]** |
| A separate `customer_pins` table buys nothing: the relationship is strictly 1:1 with `users`, there is no history requirement beyond `updated_at`, and a join on every ride start is pure cost.                                                                                                                             | **[TARGET]**   |
| A customer is a `User` with the default `customer` role — there is no `customers` table (`ensureDefaultRole`, `auth.service.ts:480`). Placing it on `users` covers every rider automatically.                                                                                                                               | **[VERIFIED]** |

### 8.2 Proposed columns (design only — **no migration is authored by this document**)

| Column                | Type                          | Null     | Purpose                                                                                                                      |
| --------------------- | ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ride_pin_verifier`   | `TEXT`                        | NULL     | scrypt string `scrypt$N$r$p$salt$derived`. NULL = not yet configured                                                         |
| `ride_pin_updated_at` | `TIMESTAMP(3)`                | NULL     | Last set/change/reset. Feeds audit and the "recently changed" support answer                                                 |
| `ride_pin_version`    | `SMALLINT NOT NULL DEFAULT 0` | NOT NULL | Increments on every change. Logged (never the PIN) so an audit trail can say _which_ PIN generation a start verified against |

No index. The column is only ever read by primary key (`users.id`, already the PK) — an index on a credential would be useless and mildly harmful.

No unique constraint. §6.4 requires PINs **not** be unique; a unique index would both break the product and leak "this PIN is taken".

### 8.3 Hashing — scrypt, **not** the existing `OtpHasher`

This is the most consequential decision in the document, and "it is hashed" is not a sufficient argument either way.

A 4-digit PIN has **10,000 possible values**. Against that keyspace the current `OtpHasher` — `createHmac('sha256', pepper).update(code).digest('hex')`, `otp.hasher.ts:9` — has two independent failures:

**(a) It is unsalted, so identical PINs produce identical verifiers.** Every customer whose PIN is `4827` stores the _same 64-character string_. An attacker with read access to a database dump needs **no pepper at all**: they group rows by verifier, and the largest bucket is almost certainly the most common human-chosen 4-digit PIN. Published studies of PIN choice put `1234` alone near 10% of all user-chosen 4-digit PINs; the top 20 values cover roughly a quarter of them. One frequency histogram deanonymises a large fraction of the customer base's PINs without inverting a single hash. Salting removes this entirely — same PIN, different salt, different verifier.

**(b) It is a single fast hash, so with the pepper the whole keyspace falls instantly.** HMAC-SHA256 runs at millions of operations per second on commodity hardware. If the pepper leaks alongside the database — and both are server-side secrets that a single compromised host may hold together — every PIN in the system is recovered in the time it takes to compute 10,000 HMACs per user, which is microseconds. Note the pepper's default is _derived from_ `JWT_REFRESH_SECRET` (`src/config/otp/otp.config.ts:3-9`), so a leak of the JWT signing secret is also a leak of the OTP pepper. Two secrets that look independent are not.

Neither problem matters much for the current 6-digit single-use 15-minute OTP: the value is worthless 15 minutes later. Both matter enormously for a credential that is valid for years.

**Recommendation: reuse `hashPassword` / `verifyPassword` from `src/modules/auth/utils/password.ts`.** **[VERIFIED]** they already provide exactly what is needed, with zero new dependencies:

- **scrypt, N=16384, r=8, p=1** (`password.ts:4-6`) — memory-hard, roughly 50-100ms per derivation. 10,000 candidates per user becomes minutes of CPU _per user_, not microseconds for everyone.
- **A fresh 16-byte random salt per record** (`password.ts:9`) — kills the frequency-analysis attack in (a) outright.
- **`timingSafeEqual`** (`password.ts:39`) — closes MEDIUM-2, which matters far more for a long-lived credential than it did for a single-use one.
- **A dummy-hash path when the stored value is absent or malformed** (`password.ts:19-26, 42`) — equalises timing between "no PIN configured" and "wrong PIN", so the endpoint cannot be used to enumerate which customers have PINs.
- Already in production use for staff login; already unit-tested (`tests/unit/auth/password-hasher.test.ts`).

**Add a pepper on top.** scrypt as written takes no server-side secret. Recommendation: **[TARGET]** derive the stored verifier from `HMAC(pin_pepper, pin)` before handing it to `hashPassword`, i.e. `hashPassword(hmac(pepper, pin))`, using a **dedicated** `RIDE_PIN_PEPPER` env var that does **not** fall back to `JWT_REFRESH_SECRET`. That gives defence in depth: a database-only compromise (the common case — backup exfiltration, read replica, SQL injection) yields nothing offline-attackable, because the attacker lacks the pepper; a database-plus-secrets compromise still faces scrypt's cost. The two controls fail independently, which is the entire point.

The ~50-100ms verification cost is not a problem on a path executed once per ride. It is a mild benefit: it is itself a throttle, capping online guessing at roughly 10-20/second per core even before Redis is consulted.

> **Explicitly rejected: reusing `OtpHasher` for the static PIN.** It remains correct and appropriate for the auth OTP and (while it exists) the ride OTP — short-lived, single-use, high-entropy-relative-to-lifetime credentials. It is the wrong primitive for a long-lived low-entropy secret.

---

## 9. PIN Lifecycle **[TARGET]**

```
Account created (UNVERIFIED)
       |
   phone verified -> ACTIVE, customer role granted
       |
   PIN not yet set: ride_pin_verifier IS NULL, ride_pin_version = 0
       |
   Customer sets PIN  --------------------------------> version 1, updated_at stamped
       |
   Customer is ride-ready (booking gate passes)
       |
   +-- Change PIN  (knows current PIN)  ------------> version+1
   +-- Reset PIN   (forgot; phone-OTP step-up) -----> version+1
       |
   Account deactivated / erased -> verifier cleared with the rest of the account
```

**The PIN never expires and is never consumed.** There is no TTL, no `verified` flag, no single-use semantics.

---

## 10. PIN Setup / Provisioning **[TARGET]**

### 10.1 Who chooses the PIN — customer-chosen, with a weak-value blocklist

**Recommendation: Option A, the customer chooses**, subject to a blocklist.

The product requirement is a _static, recited-from-memory_ PIN. A server-generated value the customer must look up in the app before every ride is a worse OTP, not a better PIN — it reintroduces exactly the "customer must consult a channel" dependency that HIGH-2 shows is fragile, while dropping the OTP's freshness benefit. Customer-chosen is the only option that delivers the requested experience.

The cost of customer choice is predictable PINs. Mitigate at the source rather than by generating: **[TARGET]** reject a small blocklist at set/change time — all four-of-a-kind values (`0000`, `1111` … `9999`), `1234`, `4321`, `0123`, and ascending/descending runs. That removes the fattest buckets of the human PIN distribution at negligible UX cost. Do **not** extend the blocklist to date-of-birth-derived values: the check would require reading `user_profiles.dateOfBirth` on a credential path, and the correlation is weak enough not to justify it.

### 10.2 Provisioning point — the existing booking gate

**[VERIFIED]** `RideRequestService.createRequest` already refuses to book when onboarding is incomplete:

```ts
const profile = await this.userProfileRepository.findByUserId(input.customerId);
if (!profile?.firstName || !profile.lastName) {
  throw new IncompleteProfileError(); // 422 INCOMPLETE_PROFILE
}
```

`ride-request.service.ts:311-313`, error at `ride.errors.ts:115-120`.

**[TARGET]** Add a sibling check in the same block — a `RidePinNotConfiguredError` (422 `RIDE_PIN_NOT_CONFIGURED`) when `users.ride_pin_verifier IS NULL`.

Gating at **booking** rather than at **start** is deliberate and important: it makes "customer has no PIN" impossible to reach at the kerb, where a driver and a passenger are already face to face and there is no good outcome. The failure lands at the moment of booking, where the customer is holding their phone and can set a PIN in ten seconds. This is the same shape as the existing profile gate, in the same function, throwing the same class of error — no new pattern.

---

## 11. PIN Verification **[TARGET]**

### 11.1 Order of operations

```
POST /api/v1/rides/:id/start   { "pin": "4827" }
  1. Authenticate                 -> auth.plugin.ts denyByDefault (unchanged)
  2. Authorize driver             -> authorize({ requireOperableDriver: true }) (unchanged)
  3. Resolve acting driver        -> RideStateController.actingDriverId (unchanged)
  4. Validate body                -> startRideSchema: /^[0-9]{4}$/ (changed)
  5. THROTTLE PRE-CHECK           -> RidePinThrottle.assertAllowed(rideId, driverId, customerId)   [NEW, pre-transaction]
  6. [TX] lockForUpdate(rideId)   -> unchanged
  7. [TX] driver owns ride        -> lockAndValidate (unchanged)
  8. [TX] state DRIVER_ARRIVED    -> validateTransition (unchanged)
  9. [TX] load customer verifier  -> by ride.customerId                                            [NEW]
 10. [TX] verifyPin               -> verifyPassword(hmac(pepper, pin), verifier)                   [NEW]
 11. [TX] updateStatusIf          -> DRIVER_ARRIVED -> IN_PROGRESS, startedAt (unchanged)
 12. [TX] ride_status_events      -> unchanged
 13. [TX] outbox ride.started     -> unchanged
 14. COMMIT
 15. THROTTLE SETTLE (success)    -> RidePinThrottle.clear(...)                                    [NEW, post-transaction]
 16. resetTripMeter(driverId)     -> unchanged
```

On a wrong PIN, step 10 throws. **Before it throws, the failure must be recorded outside the transaction** — see §14.2. The transaction rolls back; the Redis counter does not.

### 11.2 Ordering rationale

The throttle is checked **before** the transaction opens (step 5) and settled **after** it closes (steps 15 / failure path). Nothing that must survive a rollback may live inside the transaction — that is the entire lesson of CRITICAL-2, and the target design must not repeat it in a new place.

The customer verifier is loaded **inside** the transaction, under the ride row lock, so the PIN version verified against and the state transition are consistent with one another.

### 11.3 Replay — the security trade being made, stated plainly

|                     | Current                                           | Target                       |
| ------------------- | ------------------------------------------------- | ---------------------------- |
| Credential lifetime | 15 minutes                                        | Indefinite                   |
| Uses                | Exactly one, DB-enforced (`claimVerification`)    | Unlimited by nature          |
| Replay prevented by | Single-use consumption **and** ride state machine | **Ride state machine alone** |

A static PIN is by definition a reusable credential; single-use consumption cannot be preserved and there is no point pretending otherwise. Replay protection therefore rests entirely on:

1. `lockForUpdate` — `SELECT ... FOR UPDATE` serialises concurrent starts (`ride.repository.ts:25-35`) **[VERIFIED]**
2. `validateTransition` — `IN_PROGRESS` is reachable only from `DRIVER_ARRIVED` (`lifecycle.service.ts:92-97`) **[VERIFIED]**
3. `updateStatusIf` — conditional `UPDATE ... WHERE status = expected`, `count === 1` (`ride.repository.ts:142-163`) **[VERIFIED]**
4. `lockAndValidate` — the ride's assigned driver and nobody else (`lifecycle.service.ts:126-128`) **[VERIFIED]**

These four are already sufficient: a correct PIN replayed against the same ride finds it in `IN_PROGRESS` and is refused by (2) and independently by (3). A correct PIN replayed against a _different_ ride is refused by (4) unless that driver is genuinely assigned to it — and if they are, they were entitled to start it anyway.

**What is genuinely lost:** an intercepted PIN today is worthless after one use or 15 minutes. An intercepted static PIN is valid until the customer changes it, and is valid across _every future ride that customer takes_. That is the real cost of the model, it is inherent to the product requirement, and §14 exists because of it. Layered throttling is not optional hardening here — it is the compensating control for a deliberately weakened credential.

---

## 12. Driver Authorization **[TARGET — preserved unchanged]**

| Check                            | Today  | Target  | Mechanism                                                                                                 |
| -------------------------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------- |
| Authenticated                    | Yes    | Yes     | `denyByDefault` -> `authenticate`, fails closed on the revocation store (`auth.plugin.ts:142-148, 46-61`) |
| Is an operable driver            | Yes    | Yes     | `authorize({ requireOperableDriver: true })` (`auth.plugin.ts:118-135`)                                   |
| Driver id from token, not body   | Yes    | Yes     | `RideStateController.actingDriverId:25-30`                                                                |
| Assigned to _this_ ride          | Yes    | Yes     | `lockAndValidate:126-128`, under the row lock                                                             |
| Ride in the correct state        | Yes    | Yes     | `validateTransition` + `updateStatusIf`                                                                   |
| **Bound to the ride's customer** | **No** | **Yes** | **[NEW]** verifier resolved via `ride.customerId`                                                         |

The last row is the substantive change. Today nothing ties the credential presenter to the customer; the OTP's ride-scoping is the only link, and CRITICAL-1 severs it. In the target, the credential _is_ the customer's, so the binding is structural rather than incidental.

**Driver must never receive the PIN — enforcement points [TARGET]:**

| Surface                            | Requirement                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /rides/accept` response      | Return `{ data: ride }`. Remove `plaintextOtp` from the `acceptRideRequest` return type so it cannot be reintroduced by a careless `send` |
| Ride detail / active ride          | Already clean — no PIN column on `Ride`, no `include`                                                                                     |
| Socket                             | Already clean — `{ rideId, driverId }`                                                                                                    |
| Push                               | Already clean — fixed strings                                                                                                             |
| Dispatch payload                   | Already clean — `{ dispatchId, requestId, driverId, expiresAt }`                                                                          |
| Logs / errors / outbox / analytics | Already clean; add `pin`, `ridePin`, `pinCode`, `plaintextOtp` to `redact.ts` as a standing guard                                         |

**Structural guard [TARGET]:** attach a `response` schema to `POST /rides/accept` in `ride.routes.ts`. Fastify serialises strictly against a response schema, so an unlisted property is dropped even if a future refactor puts it back on the object. `ride.responses.ts` already exists and is wired to nothing — this is the reason to wire it. Belt _and_ braces, because CRITICAL-1 is the finding that a single careless `reply.send({ data: result })` produced.

---

## 13. Customer Authorization **[TARGET]**

### 13.1 The customer cannot be shown their PIN back — and that is correct

§26 of the request asks that the customer be able to see their own static PIN. **This is incompatible with storing an irreversible verifier, and the conflict must be resolved in favour of the verifier.** Displaying the PIN back requires storing it reversibly (plaintext or decryptable), which reintroduces the single worst property of the current design at far greater blast radius — a database dump would expose every customer's standing PIN in usable form.

**Resolution [TARGET]:** the customer knows their PIN because they chose it. If they forget it, they **reset** it (§19.3). The app may show _whether_ a PIN is configured and when it last changed — never its value.

This is the same contract as every password in the system, including this codebase's own staff passwords (`users.password_hash`, scrypt, never returned). Consistency here is a feature.

### 13.2 Ownership enforcement

- All PIN endpoints are `/users/me/...` and resolve the subject from `callerId(req)` (`src/core/auth/caller.ts:28`). No user id is ever accepted from a path, query, or body — mirroring the existing `/users/me/*` surface (`user.routes.ts`).
- `GET /rides/:id` must **never** grow a PIN field. Knowing a ride id must never yield a credential. The existing `assertRideParty` (`caller.ts:45-58`) governs ride reads and needs no change, because there will be nothing sensitive to read.

---

## 14. Rate Limiting / Lockout **[TARGET]**

### 14.1 Why the current control is insufficient

10,000 combinations, a credential valid for years, an attacker (the assigned driver) who is authenticated and legitimately at the endpoint, no HTTP rate limit on the route, and a DB counter that rolls back. Every layer needs to change.

### 14.2 Attempt accounting — Redis `RateLimitStore`, outside the ride transaction

**Recommendation: `src/core/cache/stores/RateLimitStore.ts`.** **[VERIFIED]** it already provides exactly the primitive needed:

```
hit(scope, id, limit, windowSeconds) -> { allowed, current, remaining, retryAfterSeconds }
```

implemented as an atomic Lua `INCR` + `EXPIRE` (`RateLimitStore.ts:12-15`), so concurrent guesses cannot overrun the window — the same class of atomicity `claimAttempt` intended but loses to rollback. `enforceMinInterval` (`:39`) additionally gives a per-attempt cooldown.

Alternatives considered and rejected:

| Option                             | Verdict                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep a DB counter, own transaction | Works, but costs a second transaction on the hot path and reintroduces the rollback footgun the moment someone nests it. Rejected.                     |
| A new dedicated security store     | Duplicates `RateLimitStore`. Rejected — the existing store is already used for exactly this by `PhoneChangeService` (`phone-change.service.ts:63-72`). |
| **Redis `RateLimitStore`**         | **Recommended.** Existing, atomic, TTL-native, already the codebase's throttling idiom.                                                                |

### 14.3 Layered limits

| Layer        | Scope key                                    | Suggested limit               | Rationale                                                                                                          |
| ------------ | -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Per ride     | `ride:pin:ride` / `<rideId>`                 | 5 per ride, TTL 2h            | Direct replacement for today's intended 5-attempt cap                                                              |
| Per customer | `ride:pin:cust` / `<customerId>`             | 10 / 24h                      | The value being protected is the customer's. Caps attempts across _colluding_ drivers, which a per-ride cap cannot |
| Per driver   | `ride:pin:drv` / `<driverId>`                | 20 / 24h                      | Catches the farming pattern: one driver, many customers, a few guesses each — invisible to both limits above       |
| Cooldown     | `enforceMinInterval('ride:pin', rideId, 2s)` | 1 per 2s                      | Removes rapid-fire scripting; imperceptible to a human typing                                                      |
| Lockout      | `ride:pin:lock` / `<rideId>`                 | 15 min after the per-ride cap | A hard stop rather than a silently exhausted counter                                                               |

All values belong in a config module beside `rate-limit.config.ts` so operations can tune them without a deploy. **These numbers are a starting recommendation, not a measurement — they should be revisited against real failure-rate telemetry (§25) after rollout.**

**Combined effect:** worst case ~20 guesses/day against a 10,000 keyspace = a ~0.2% daily chance per targeted customer, with every attempt counted, alerted on, and attributable to a named driver. Compare with today: unbounded.

### 14.4 Where the check sits

- **Pre-check before the transaction** (step 5) — refuse a locked-out ride before doing any database work.
- **Failure recorded outside the transaction.** The verification failure must increment Redis on a path the rollback cannot touch. Concretely: catch the verification failure at the `startRide` level _outside_ `txManager.execute`, record the attempt, then rethrow. **[TARGET]** This inversion is the whole fix for CRITICAL-2 and must be covered by the dedicated test in §24.
- **Success clears the per-ride counter** after commit.

### 14.5 Redis unavailability — fail closed

**Recommendation: fail closed** (503 `SERVICE_UNAVAILABLE`), consistent with existing precedent: `auth.plugin.ts` fails closed on the revocation store (`:53-61`), the permission lookup (`:83-91`), the device check (`:108-116`) and the driver-operability check (`:123-134`).

The trade is real and should be stated: failing closed strands a legitimate driver and passenger at the kerb. Failing open removes brute-force protection precisely when monitoring is already degraded. Closed wins because (a) the codebase is uniformly fail-closed on security stores and a lone exception is how inconsistencies become incidents, and (b) a Redis outage is already a platform-wide outage — dispatch locks (`dispatch.service.ts:113`), the trip meter, idempotency and every rate limit depend on it, so rides are not starting cleanly anyway.

---

## 15. Concurrency Protection **[VERIFIED — reuse unchanged]**

### 15.1 Driver acceptance — already correct

Driver A and Driver B accepting simultaneously: **exactly one wins.** Four independent mechanisms:

1. `requestRepo.lockForUpdate(requestId, tx)` — `SELECT ... FOR UPDATE` (`lifecycle.service.ts:317`)
2. `dispatchRepo.lockActionableOffer` — locks the offer, refuses non-`PENDING` and expired-but-unswept (`lifecycle.service.ts:186-211`)
3. `requestRepo.claimForMatch` — conditional `updateMany ... WHERE status IN ('CREATED','SEARCHING')`, `count === 1` (`ride-request.repository.ts:107-113`)
4. Partial unique indexes `rides_active_driver_key`, `rides_active_customer_key`, `ride_requests_active_customer_key` (`prisma/migrations/20260821130000_ride_active_uniqueness/migration.sql`)

### 15.2 Ride start — already correct, unchanged by the PIN model

`Correct PIN + Request A -> SUCCESS`, `Correct PIN + Request B -> FAIL`. Guaranteed by:

1. `lockForUpdate` serialises the two transactions (`ride.repository.ts:25-35`)
2. `validateTransition` — the loser sees `IN_PROGRESS` and is refused (`lifecycle.service.ts:105-110`)
3. `updateStatusIf` — `WHERE status = 'DRIVER_ARRIVED'` returns `count === 0` for the loser (`ride.repository.ts:142-163`)

Isolation is default READ COMMITTED (no `isolationLevel` is passed anywhere). Correctness rests on explicit row locks and conditional UPDATEs rather than on isolation level — which is the right way round, and needs no change.

**Do not add new locking.** The loss of single-use consumption (§11.3) does not weaken this: (2) and (3) each independently refuse the second start.

---

## 16. Ride State Machine **[VERIFIED — reuse unchanged]**

Enum (`prisma/schema/shared/enums.prisma:82-94`): `REQUESTED, SEARCHING, ACCEPTED, DRIVER_ARRIVING, DRIVER_ARRIVED, IN_PROGRESS, COMPLETED, CANCELLED_BY_CUSTOMER, CANCELLED_BY_DRIVER, CANCELLED_BY_SYSTEM, NO_DRIVERS_FOUND`.

> **Note [VERIFIED]:** `REQUESTED` and `SEARCHING` are declared on `RideStatus` but are **unreachable** — no `rides` row is ever created in them (the default is `ACCEPTED`). They duplicate `RideRequestStatus`. Out of scope here; worth a separate cleanup ticket.

| Current State         | Action                  | Next State        | Allowed?                      | Enforcement                                    |
| --------------------- | ----------------------- | ----------------- | ----------------------------- | ---------------------------------------------- |
| (none)                | accept                  | `ACCEPTED`        | Yes                           | `rideRepo.create`, schema default              |
| `ACCEPTED`            | arriving                | `DRIVER_ARRIVING` | Yes                           | `ALLOWED_TRANSITIONS:79-84` + `updateStatusIf` |
| `ACCEPTED`            | arrive                  | `DRIVER_ARRIVED`  | Yes                           | same                                           |
| **`ACCEPTED`**        | **start + correct PIN** | `IN_PROGRESS`     | **NO — correctly refused**    | `ALLOWED_TRANSITIONS:79-84`                    |
| `DRIVER_ARRIVING`     | arrive                  | `DRIVER_ARRIVED`  | Yes                           | `:85-91`                                       |
| **`DRIVER_ARRIVING`** | **start + correct PIN** | `IN_PROGRESS`     | **NO — correctly refused**    | `:85-91`                                       |
| **`DRIVER_ARRIVED`**  | **start + correct PIN** | `IN_PROGRESS`     | **YES — the only valid path** | `:92-97`                                       |
| `IN_PROGRESS`         | complete                | `COMPLETED`       | Yes                           | `:68`                                          |
| **`COMPLETED`**       | **start + correct PIN** | `IN_PROGRESS`     | **NO — correctly refused**    | `COMPLETED: []` (`:69`)                        |
| **`CANCELLED_*`**     | **start + correct PIN** | `IN_PROGRESS`     | **NO — correctly refused**    | all `[]` (`:70-72`)                            |

**No change required.** Enforcement is already doubled — the in-memory table _and_ the database predicate in `updateStatusIf` — so a transition that slips past the table still fails at the database.

---

## 17. Trip Meter Integration **[VERIFIED — reuse unchanged]**

| Question                  | Answer                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When does it reset?       | After the successful start transaction commits — `lifecycle.service.ts:523`; again after completion — `:794`                                                                          |
| Before or after start?    | **After.** Deliberate: a reset for a start that rolled back would only discard pre-trip distance                                                                                      |
| Key scope                 | **Driver** — `ride:distance:<driverId>` (`src/core/cache/keys.ts:21`)                                                                                                                 |
| Is driver-scoping safe?   | **Yes** — `rides_active_driver_key` makes one active ride per driver a _database_ fact, not an application convention (`TripDistanceStore.ts:11-19` documents exactly this reasoning) |
| Multiple resets?          | Idempotent `DEL`                                                                                                                                                                      |
| Another ride overwriting? | Prevented by the same partial unique index                                                                                                                                            |
| Concurrent starts?        | Only one start commits, so only one reset runs                                                                                                                                        |
| If start fails?           | Reset never runs (it is after `execute`); counter retains its prior value                                                                                                             |
| If reset fails?           | Swallowed with `logger.warn` (`:531-533`); degrades to over-measurement, bounded by `assertPlausibleTripData`                                                                         |

**Reusable as-is. Do not change the key to ride-scoped.** Driver-scoping is what lets `POST /drivers/location` stay ignorant of rides — and a client-supplied `rideId` on that endpoint would put the fare under client control, which is the exact attack `accrueTripDistance` was written to close (`location.service.ts:74-85`). The PIN model does not touch any of this.

MEDIUM-4 (silent reset failure) remains open and is **not** in scope for this migration.

---

## 18. Audit / Outbox / Realtime **[VERIFIED — reuse unchanged]**

`updateStatusIf` -> `statusEventRepo.record` -> `eventPublisher.publish(..., tx)` — all three inside one transaction (`lifecycle.service.ts:498-517`). The outbox row commits atomically with the state change; `OutboxRelay.processBatch` claims and dispatches only **after** commit, so a rolled-back start cannot emit `RIDE_STARTED`. Delivery is at-least-once with a claim token, retries, backoff and dead-lettering (`OutboxRelay.ts:32-90`).

| Check                            | Today                       | Target                                                                               |
| -------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Credential in audit payload      | No                          | No — `ride_status_events` columns are `fromStatus/toStatus/actorType/actorId/reason` |
| Credential in outbox payload     | No                          | No                                                                                   |
| Credential in realtime event     | No                          | No — `{ rideId, driverId }`                                                          |
| False `RIDE_STARTED` on rollback | Impossible                  | Impossible — outbox-after-commit                                                     |
| Events causing a double start    | No — consumers only fan out | No                                                                                   |

**These three components are entirely credential-model independent and require no change.** The one addition is `ride_pin_version` in the _audit_ row's reason/metadata — never the PIN, never the verifier.

---

## 19. API Contracts **[TARGET — design only, not implemented]**

All PIN endpoints live in the **users** module beside the existing `/users/me/*` surface (`src/modules/users/routes/user.routes.ts`), reusing its `commonErrors` map and response-schema convention.

### 19.1 PIN status — `GET /api/v1/users/me/ride-pin`

Never returns the PIN.

```json
{ "data": { "configured": true, "updatedAt": "2026-09-01T10:12:00.000Z", "version": 3 } }
```

### 19.2 Set / change PIN — `PUT /api/v1/users/me/ride-pin`

`preHandler: [app.authorize({ requireUntamperedDevice: true })]` — matching the existing phone-change precedent (`user.routes.ts:75, 96`).

```json
{ "currentPin": "4827", "newPin": "1938" }
```

- `currentPin` **required** when a PIN is already configured; **omitted** on first set.
- On success: `204 No Content`. Never echo the new PIN.
- Wrong `currentPin` -> `400 RIDE_PIN_INVALID`, throttled on the same `ride:pin:cust` scope.

### 19.3 Reset PIN (forgotten) — two-step, phone-OTP step-up

Reuses the auth OTP challenge machinery verbatim (`OtpService.send` / `verify`, `otp.service.ts:67,141`), exactly as `PhoneChangeService` does (`phone-change.service.ts:79-85`). **[TARGET]** requires a new `OtpPurpose` enum value `RIDE_PIN_RESET` (current values: `LOGIN`, `REGISTER`, `PHONE_CHANGE` — `prisma/schema/modules/auth/auth.enums.prisma:1-6`).

```
POST /api/v1/users/me/ride-pin/reset          -> 202 { data: { challengeId, expiresAt } }   (OTP to the registered number)
POST /api/v1/users/me/ride-pin/reset/verify   -> 204                                        { challengeId, code, newPin }
```

The reset endpoint **never returns the PIN**, old or new. It only accepts a replacement. That is the whole point of §13.1.

### 19.4 Driver starts ride — `POST /api/v1/rides/:id/start`

Route, auth and params unchanged. Body changes:

```json
{ "pin": "4827" }
```

|                 | Current                | Target                                           |
| --------------- | ---------------------- | ------------------------------------------------ |
| Field           | `otpCode`              | `pin`                                            |
| Validation      | `z.string().length(6)` | `z.string().regex(/^[0-9]{4}$/)`                 |
| Digits enforced | No (MEDIUM-1)          | Yes                                              |
| Leading zeros   | Supported (string)     | Supported (string — **never** parse to a number) |

Success response unchanged: `{ data: Ride }`. **Never** includes PIN, verifier, or version.

> **Migration note:** §22 Phase 4 discusses accepting `otpCode` as a deprecated alias for one release to avoid a hard client cutover. The decision depends on mobile release cadence — **[NOT VERIFIED]**, see §28.

---

## 20. Error Handling **[TARGET]**

New errors extend `RideError` (`src/modules/rides/errors/ride.errors.ts:1-9`) and flow through the existing `handleRideError` (`src/modules/rides/schemas/error-response.ts`), which already maps coded errors to their status and Zod errors to 400.

| Condition                        | Code                            | Status | Message (client-safe)                                 |
| -------------------------------- | ------------------------------- | ------ | ----------------------------------------------------- |
| Wrong PIN                        | `RIDE_PIN_INVALID`              | 400    | `The PIN entered is not correct`                      |
| Attempts exhausted / locked      | `RIDE_PIN_LOCKED`               | 429    | `Too many incorrect attempts. Try again in N minutes` |
| Cooldown between attempts        | `RIDE_PIN_THROTTLED`            | 429    | `Please wait a moment before trying again`            |
| Customer has no PIN (at start)   | `RIDE_PIN_INVALID`              | 400    | _deliberately identical to "wrong PIN"_               |
| Customer has no PIN (at booking) | `RIDE_PIN_NOT_CONFIGURED`       | 422    | `Set your Ride PIN before booking`                    |
| Ride not found                   | `RIDE_NOT_FOUND`                | 404    | existing (`ride.errors.ts:33-38`)                     |
| Driver not assigned              | `RIDE_DRIVER_MISMATCH`          | 403    | existing                                              |
| Wrong state                      | `INVALID_RIDE_STATE_TRANSITION` | 409    | existing (`ride.errors.ts:10-19`)                     |
| Throttle store down              | `SERVICE_UNAVAILABLE`           | 503    | `Ride start is temporarily unavailable`               |

**Two rules the implementation must not relax:**

1. **"No PIN configured" and "wrong PIN" are indistinguishable to the driver** — same code, same message, and the same scrypt work performed either way via `verifyPassword`'s dummy-hash path (`password.ts:19-26`). Otherwise the start endpoint becomes an oracle telling a driver which customers have no PIN.
2. **Never echo the submitted or stored value.** No `"Customer PIN is 4827"`, no `"expected 4827, got 1234"`, no PIN in `details`. The generic-message discipline the current `OtpVerificationError` already follows (`ride.errors.ts:27-32`) is the standard to keep.

---

## 21. Logging / Security **[TARGET]**

**Allowed security events** (structured, no credential material):

| Event                          | Fields                                                                 |
| ------------------------------ | ---------------------------------------------------------------------- |
| `RIDE_PIN_VERIFICATION_FAILED` | `rideId`, `driverId`, `customerId`, `attemptNumber`, `remaining`       |
| `RIDE_PIN_LOCKED`              | `rideId`, `driverId`, `customerId`, `lockedForSeconds`, `scope`        |
| `RIDE_PIN_CHANGED`             | `userId`, `version`, `method` (`set` \| `change` \| `reset`)           |
| `RIDE_STARTED`                 | `rideId`, `driverId` — already exists (`lifecycle.service.ts:514-517`) |

**Never logged, at any level, in any environment:** the submitted PIN, the stored PIN, the verifier string, the salt, the pepper, `JWT_REFRESH_SECRET`.

**Redaction [TARGET]:** add `pin`, `ridePin`, `pinCode`, `plaintextOtp`, `newPin`, `currentPin`, `devSmsBody` to `SENSITIVE_FIELDS` in `src/shared/logger/redact.ts:1-21`. Note that `logger.ts:10-15` **disables** `otp`/`phone` redaction in `development` — that carve-out must not be extended to the PIN fields, because a static PIN is a standing credential even on a developer's machine.

---

## 22. Migration Strategy **[TARGET]**

Staged, additive-first, with the OTP system left running until the PIN path is proven. **The current OTP system is not deleted first.**

### Phase 0 — Audit _(this document — no code changes)_

Complete.

### Phase 1 — PIN data model

Add `ride_pin_verifier`, `ride_pin_updated_at`, `ride_pin_version` to `users`. Additive, all nullable/defaulted, zero backfill, zero read path yet. **Independently deployable and reversible.**

### Phase 2 — PIN setup / provisioning

`RidePinService` (set / change / reset), the three `/users/me/ride-pin*` endpoints, the `RIDE_PIN_RESET` OTP purpose, the weak-PIN blocklist. Customers can set a PIN; nothing consumes it yet. **Ship and let adoption accumulate before Phase 4.**

### Phase 3 — Verification infrastructure

`RidePinVerificationService` + `RidePinThrottle` on `RateLimitStore`, plus metrics. Fully unit-tested, **not yet wired to `/start`.**

### Phase 4 — Driver start migration

Point `startRide` at PIN verification. Add the booking-time `RIDE_PIN_NOT_CONFIGURED` gate (§10.2) **in the same release** — otherwise customers without a PIN reach the kerb and cannot start. Behind a config flag if the deployment supports one. **The riskiest phase; see §27.**

### Phase 5 — Acceptance cleanup

Remove `generateStartOtp` and `deliverStartOtpToCustomer` from `acceptRideRequest`. Only after Phase 4 is stable in production.

### Phase 6 — Response security

Remove `plaintextOtp` from the `acceptRideRequest` return type; attach the response schema to `POST /rides/accept`.

> **If, and only if, the Phase 4-6 sequence cannot ship promptly, do Phase 6 first as an emergency patch.** CRITICAL-1 is live today. But note the interaction: removing the leak _without_ the PIN model in place promotes HIGH-2 (silent SMS failure, no resend) into a live availability failure, and leaves CRITICAL-2 as the only remaining guard. Whoever ships Phase 6 early must also fix HIGH-1/HIGH-2 or accept dead rides on dropped SMS. **This trade is an operational decision, not a technical one, and should be made explicitly rather than by default.**

### Phase 7 — Tests

See §24.

### Phase 8 — Observability / security verification

Confirm no credential leakage across responses, sockets, logs, outbox and metrics. Confirm throttle counters actually persist across failed starts — the direct regression test for CRITICAL-2.

### Phase 9 — Legacy cleanup

Only after Phases 4-8 are stable: deprecate `ride_otps`, `RideOtpRepository`, `RideOtpService`, `generateRideOtp`, `RIDE_OTP_TTL_MINUTES`, `RIDE_OTP_MAX_ATTEMPTS`, `RIDE_OTP_LENGTH`, `deliverStartOtpToCustomer`. Drop the table last, in its own migration, after a retention window.

---

## 23. File-Level Change Plan **[TARGET]**

### NO CHANGE REQUIRED

| File                                                                                       | Current responsibility                   | Why unchanged                              |
| ------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------ |
| `src/modules/rides/repositories/ride.repository.ts`                                        | `lockForUpdate:25`, `updateStatusIf:142` | Credential-independent concurrency control |
| `src/modules/rides/repositories/ride-status-event.repository.ts`                           | Audit rows                               | Credential-independent                     |
| `src/core/events/EventPublisher.ts`, `OutboxRelay.ts`, `EventBus.ts`                       | Durable events                           | Credential-independent                     |
| `src/modules/rides/consumers/ride-realtime.consumer.ts`                                    | Socket bridge                            | Carries no credential                      |
| `src/modules/rides/consumers/ride-notification.consumer.ts`                                | Push                                     | Carries no credential                      |
| `src/core/cache/stores/TripDistanceStore.ts`                                               | Trip meter                               | §17                                        |
| `src/modules/drivers/services/location/location.service.ts`                                | Meter accrual                            | §17                                        |
| `src/modules/rides/services/dispatch/*`, `src/modules/matching/*`, `src/modules/pricing/*` | Dispatch / matching / pricing            | Untouched by the credential model          |
| `src/modules/auth/plugins/auth.plugin.ts`                                                  | Auth gate                                | §12                                        |
| `src/core/auth/caller.ts`                                                                  | `assertRideParty`                        | §13.2                                      |
| `src/core/cache/stores/RateLimitStore.ts`                                                  | Throttle primitive                       | Reused as-is                               |
| `src/modules/auth/utils/password.ts`                                                       | scrypt hash/verify                       | Reused as-is                               |

### SMALL CHANGE

| File                                                                 | Change                                                                       | Risk                                                 | Phase |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | ----- |
| `src/modules/rides/schemas/ride.schemas.ts:47-49`                    | `startRideSchema`: `otpCode` -> `pin`, `/^[0-9]{4}$/`                        | Low — breaking API change, needs client coordination | 4     |
| `src/modules/rides/controllers/ride-state.controller.ts:77-85`       | Pass `body.pin`                                                              | Low                                                  | 4     |
| `src/modules/rides/controllers/ride-state.controller.ts:44`          | `reply.send({ data: result.ride })`                                          | Low — **fixes CRITICAL-1**                           | 6     |
| `src/modules/rides/routes/ride.routes.ts:47`                         | Attach response schema to `/accept`                                          | Low — structural guard                               | 6     |
| `src/modules/rides/services/request/ride-request.service.ts:311-313` | Add PIN-configured gate                                                      | Low — mirrors the profile gate                       | 4     |
| `src/modules/rides/errors/ride.errors.ts`                            | Add `RidePinInvalidError`, `RidePinLockedError`, `RidePinNotConfiguredError` | Low                                                  | 3-4   |
| `src/shared/logger/redact.ts:1-21`                                   | Add PIN field names                                                          | Low                                                  | 3     |
| `src/modules/rides/metrics/ride.metrics.ts`                          | Add PIN metrics; **wire the orphaned `otpFailure:32`** or replace it         | Low — **fixes MEDIUM-5**                             | 3     |
| `prisma/schema/modules/auth/auth.enums.prisma:1-6`                   | Add `RIDE_PIN_RESET` to `OtpPurpose`                                         | Low — additive enum                                  | 2     |
| `src/modules/rides/index.ts`                                         | DI registration for new services                                             | Low                                                  | 3     |

### MAJOR CHANGE

| File                                                                | Change                                                                                     | Risk                                                        | Dependencies                                    | Phase |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------- | ----- |
| `src/modules/rides/services/lifecycle/lifecycle.service.ts:487-524` | `startRide` verifies the customer PIN; throttle recorded **outside** the transaction       | **High** — the security-critical path; **fixes CRITICAL-2** | `RidePinVerificationService`, `RidePinThrottle` | 4     |
| `src/modules/rides/services/lifecycle/lifecycle.service.ts:308-394` | `acceptRideRequest` stops minting and delivering the OTP; return type loses `plaintextOtp` | Medium — touches the accept transaction                     | Phase 4 stable                                  | 5-6   |
| `prisma/schema/modules/user/user.prisma:1-12`                       | Three new columns on `User`                                                                | Medium — schema change, additive                            | —                                               | 1     |

### NEW COMPONENT

| Component                                                         | Responsibility                                                         | Phase |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ----- |
| `src/modules/users/services/ride-pin/ride-pin.service.ts`         | Set / change / reset, blocklist, versioning, `RIDE_PIN_CHANGED` events | 2     |
| `src/modules/users/controllers/` (extend `user.controller.ts`)    | Three `/users/me/ride-pin*` handlers                                   | 2     |
| `src/modules/users/schemas/`                                      | PIN request/response schemas                                           | 2     |
| `src/modules/rides/services/pin/ride-pin-verification.service.ts` | Resolve customer from ride, verify, no leakage                         | 3     |
| `src/modules/rides/services/pin/ride-pin-throttle.service.ts`     | Layered `RateLimitStore` throttling + lockout                          | 3     |
| `src/config/ride-pin/ride-pin.config.ts`                          | Limits, windows, lockout, `RIDE_PIN_PEPPER`                            | 3     |
| Migration: add three columns to `users`                           | Additive, nullable                                                     | 1     |

### REMOVE / DEPRECATE — **Phase 9 only**

| Component                                                          | File                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| `RideOtpService`                                                   | `src/modules/rides/services/otp/ride-otp.service.ts`    |
| `RideOtpRepository`                                                | `src/modules/rides/repositories/ride-otp.repository.ts` |
| `generateRideOtp`                                                  | `src/modules/rides/utils/otp.util.ts`                   |
| `RIDE_OTP_TTL_MINUTES`, `RIDE_OTP_MAX_ATTEMPTS`, `RIDE_OTP_LENGTH` | `src/modules/rides/constants/ride.constants.ts:13-15`   |
| `deliverStartOtpToCustomer`                                        | `lifecycle.service.ts:401-419`                          |
| `OtpVerificationError`                                             | `ride.errors.ts:27-32`                                  |
| `RideOtp` model + `ride_otps` table                                | `prisma/schema/modules/ride/ride.prisma:231-246`        |
| `tests/unit/rides/ride-otp.test.ts`                                | Replaced by the §24 suite                               |

> `OtpHasher` (`src/modules/auth/services/otp/otp.hasher.ts`) is **KEPT** — it remains correct for the auth OTP. It is simply not used for the PIN.

---

## 24. Test Migration Plan **[TARGET]**

### Tests that depend on the current model and must change

| Test                                                                  | Dependency                                         | Action                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `tests/integration/helpers/ride-flow.ts:106`                          | Reads `data.plaintextOtp` from accept              | **Rewrite** — set a PIN in `RideWorld` setup, submit it at start |
| `tests/integration/earnings-pipeline.test.ts:734`                     | Same                                               | Rewrite via the helper                                           |
| `tests/unit/rides/ride-otp.test.ts`                                   | 6-digit, TTL, single-use, attempts                 | **Replace** with the PIN suite                                   |
| `tests/unit/rides/ride-lifecycle-concurrency.test.ts:223-224,421-437` | Stubs `generateStartOtp`; asserts the OTP SMS body | **Update** — remove the OTP stub and the SMS assertion           |
| `tests/unit/rides/ride-state-machine.test.ts:9-31`                    | 21 positional stub constructor args                | **Update** arity if `LifecycleService` dependencies change       |

### New coverage required

**Customer PIN lifecycle**

- set on first configuration; `currentPin` not required
- change with correct `currentPin`; rejected with wrong `currentPin`
- reset via OTP step-up; wrong OTP rejected
- 4-digit validation: `"123"`, `"12345"`, `"abcd"`, `"12 4"`, `""` all rejected
- **leading zeros: `"0000"`, `"0001"`, `"0827"` all accepted and verify correctly** (regression guard against numeric parsing)
- blocklisted values rejected
- `ride_pin_version` increments on every change
- **the PIN is never present in any response body from any PIN endpoint**

**Authorization**

- wrong driver -> 403 `RIDE_DRIVER_MISMATCH`
- correct PIN, wrong ride -> refused
- customer B's PIN on customer A's ride -> refused
- unauthenticated -> 401
- a driver cannot read another user's PIN status

**Verification**

- correct PIN -> `IN_PROGRESS`
- wrong PIN -> refused, ride stays `DRIVER_ARRIVED`
- malformed PIN -> 400 before verification
- locked -> 429
- **customer with no PIN produces the same code, message, and comparable timing as a wrong PIN**
- **two different customers with the identical PIN `4827`: each starts only their own ride** (the §3/§6 non-uniqueness requirement, stated as an executable test)

**State machine** — for each of `ACCEPTED`, `DRIVER_ARRIVING`, `CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_DRIVER`, `COMPLETED` + correct PIN -> refused with `INVALID_RIDE_STATE_TRANSITION`; `DRIVER_ARRIVED` + correct PIN -> `IN_PROGRESS`.

**Security / leakage**

- accept response contains no `pin`, `plaintextOtp`, `otp`, or verifier
- ride detail, active ride, history contain none
- socket payloads contain none
- outbox rows contain none
- captured log output for a full ride contains none
- driver ride-detail response contains none

**Concurrency**

- two simultaneous starts, both with the correct PIN -> exactly one 200, one 409
- **N simultaneous wrong PINs -> the persisted attempt count equals N (capped at the limit), against a real database** — the direct regression test for CRITICAL-2, and the one that would have caught it. This must be an **integration** test; a unit test with an in-memory fake is exactly what hid the bug.
- many correct starts on the same ride -> one success, the rest 409

---

## 25. Failure Scenarios **[TARGET]**

| #   | Scenario                                             | Desired production behaviour                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Customer has no PIN                                  | Blocked at **booking** with 422 `RIDE_PIN_NOT_CONFIGURED` (§10.2), so it cannot occur at the kerb. If it somehow does, `/start` returns the generic `RIDE_PIN_INVALID` with identical timing — never an oracle                                                                                                                                                                                          |
| 2   | Customer changes PIN while a ride is active          | Allowed. Verification reads the verifier at start time, so the new PIN takes effect immediately. **Do not block changes during an active ride** — a customer who believes their PIN is compromised must always be able to rotate it, and the failure mode is self-correcting (driver sees "invalid", customer reads the new one). `ride_pin_version` in the audit row records which generation was used |
| 3   | Driver enters wrong PIN                              | 400 `RIDE_PIN_INVALID`. Attempt persisted in Redis. Ride stays `DRIVER_ARRIVED`. `ride_pin_verification_failure` incremented                                                                                                                                                                                                                                                                            |
| 4   | Driver repeatedly guesses                            | Per-ride cap -> lockout -> 429 `RIDE_PIN_LOCKED`. Per-customer and per-driver caps also accrue. `RIDE_PIN_LOCKED` security event; alert on the per-driver counter, which is the collusion/farming signal                                                                                                                                                                                                |
| 5   | Driver enters the correct PIN twice                  | First: 200, `IN_PROGRESS`. Second: 409 `INVALID_RIDE_STATE_TRANSITION` — refused by the state machine, not by credential consumption (§11.3)                                                                                                                                                                                                                                                            |
| 6   | Two simultaneous start requests                      | `lockForUpdate` serialises; `updateStatusIf` gives exactly one winner; loser 409. Unchanged from today                                                                                                                                                                                                                                                                                                  |
| 7   | Customer changes PIN while the driver is mid-attempt | The attempt uses whichever verifier is committed when the transaction reads it. Worst case: one wasted attempt and a puzzled driver. Acceptable — and the reason not to make the per-ride cap tighter than 5                                                                                                                                                                                            |
| 8   | Redis unavailable                                    | **Fail closed** — 503 `SERVICE_UNAVAILABLE`, consistent with every other security store in `auth.plugin.ts`. Alert immediately; a Redis outage already degrades dispatch, the trip meter and idempotency (§14.5)                                                                                                                                                                                        |
| 9   | Database transaction fails                           | Whole start rolls back; ride stays `DRIVER_ARRIVED`; no outbox row, so no `RIDE_STARTED` is ever emitted. **The Redis attempt record deliberately survives** — that is the point of putting it outside the transaction                                                                                                                                                                                  |
| 10  | Outbox insertion fails                               | Inside the transaction, so the entire start rolls back. Ride is not started. Correct: no state change without its event                                                                                                                                                                                                                                                                                 |
| 11  | Realtime delivery fails                              | Ride is already started and durable. `OutboxRelay` retries with backoff, then dead-letters (`OutboxRelay.ts:59-71`). Clients reconcile via `GET /rides/active`                                                                                                                                                                                                                                          |
| 12  | Trip meter reset fails                               | Swallowed with `logger.warn` (`:531-533`). Ride starts. Fare risk bounded by `max(measured, quoted)` and `assertPlausibleTripData`. Unchanged (MEDIUM-4, out of scope)                                                                                                                                                                                                                                  |
| 13  | Driver's app retries the start request               | Second request: 409 `INVALID_RIDE_STATE_TRANSITION`. **The client must treat 409 on start as success-already-applied and re-read the ride, not as an error to surface.** Worth stating in the API contract; consider a distinct `RIDE_ALREADY_STARTED` code in a later iteration                                                                                                                        |
| 14  | Network timeout after the backend started the ride   | Same as 13 — the ride is `IN_PROGRESS`, the retry returns 409, the client reconciles from `GET /rides/active`                                                                                                                                                                                                                                                                                           |
| 15  | Customer shares a PIN with another customer          | **No effect whatsoever.** Verification is customer-scoped via `ride.customerId`. `4827` on customer B's ride is refused even though customer A's PIN is also `4827`. This is the §3 requirement, and §24 makes it an executable test                                                                                                                                                                    |

---

## 26. Observability Plan **[TARGET]**

Follows the existing `RideMetrics` / `UserMetrics` pattern — `incrementCounter(name, fields)` plus a structured log line (`ride.metrics.ts:35-38`).

| Metric                                | Labels                                                  | Purpose                                                                 |
| ------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ride_pin_verification_success_total` | none                                                    | Baseline volume                                                         |
| `ride_pin_verification_failure_total` | `reason` (`invalid` \| `not_configured` \| `throttled`) | Brute-force and UX signal                                               |
| `ride_pin_lockout_total`              | `scope` (`ride` \| `customer` \| `driver`)              | Abuse signal; the `driver` scope is the collusion indicator             |
| `ride_pin_change_total`               | `method` (`set` \| `change` \| `reset`)                 | Adoption tracking during Phases 2-4                                     |
| `ride_start_success_total`            | none                                                    | Exists as `ride_started_total` (`ride.metrics.ts:23`)                   |
| `ride_start_failure_total`            | `reason`                                                | Currently missing — `otpFailure` is defined and never called (MEDIUM-5) |

**Label hygiene:** never put a PIN, a verifier, a `rideId`, a `driverId`, or a `customerId` in a metric label. Ids are unbounded cardinality and would blow up the series count; they belong in the structured log line, which `RideMetrics.emit` already writes alongside the counter. **[VERIFIED]** the existing code passes `rideId` into `fields`, which reach _both_ `incrementCounter` and the logger (`ride.metrics.ts:36-37`) — the new PIN metrics should pass ids only via a separate log call, not via `fields`, or the cardinality problem is inherited. Worth flagging as a pre-existing issue in its own right.

**Adoption gate for Phase 4:** do not cut `/start` over until `ride_pin_change_total{method="set"}` covers a sufficient fraction of active riders. The exact threshold is an operational call — **[NOT VERIFIED]**, no active-rider count is derivable from the repository.

**Alerts:** lockout rate above baseline; any single driver exceeding the per-driver cap more than once in a week; verification failure ratio above a tuned threshold; Redis-unavailable 503s on `/start`.

---

## 27. Rollback Strategy **[TARGET]**

| Phase                      | Rollback                                                                                                                                                                                                                                                                                                                                                                   | Data impact                                                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Columns                | Revert the app; leave the columns (nullable, unread)                                                                                                                                                                                                                                                                                                                       | None                                                                                                                                                                                                                                                                                                |
| 2 — Setup endpoints        | Revert; PINs already set remain stored and unused                                                                                                                                                                                                                                                                                                                          | None — they become valid again on re-deploy                                                                                                                                                                                                                                                         |
| 3 — Verification infra     | Revert; nothing was wired to `/start`                                                                                                                                                                                                                                                                                                                                      | None                                                                                                                                                                                                                                                                                                |
| **4 — `/start` migration** | **The critical one.** Revert to OTP verification. **Requires the OTP path to still exist — which is exactly why Phases 5-6 come after, not before.** Rides started under the PIN path are unaffected; in-flight rides at `DRIVER_ARRIVED` fall back to OTP, and a ride accepted during the PIN window has no `ride_otps` row, so it **cannot** be started after a rollback | **In-flight rides accepted during the PIN window are stranded on rollback.** Mitigate by rolling back during a low-traffic window and cancelling the affected rides, or by keeping OTP minting active through Phase 4 (recommended — mint the OTP but verify the PIN, then stop minting in Phase 5) |
| 5 — Acceptance cleanup     | Revert to resume OTP minting                                                                                                                                                                                                                                                                                                                                               | None                                                                                                                                                                                                                                                                                                |
| 6 — Response security      | Revert restores the leak                                                                                                                                                                                                                                                                                                                                                   | None — but do not revert this one                                                                                                                                                                                                                                                                   |
| 9 — Legacy removal         | Not practically reversible once the table is dropped                                                                                                                                                                                                                                                                                                                       | Drop `ride_otps` last, after a retention window and a verified backup                                                                                                                                                                                                                               |

> **The Phase 4 rollback hazard is the single biggest operational risk in this migration.** The recommendation — keep minting the OTP through Phase 4 even though nothing verifies it — costs one wasted insert per ride and buys a clean rollback. Take it.

---

## 28. Information Gaps **[NOT VERIFIED]**

- Production `OTP_PEPPER` value, and whether it is set at all. The fallback derives from `JWT_REFRESH_SECRET`, so rotating that secret silently invalidates every outstanding OTP hash. The same coupling must not be repeated for `RIDE_PIN_PEPPER`.
- Production `SMS_PROVIDER` selection and whether MSG91 credentials are configured. `SmsProviderNotDeliverableError` blocks `mock` in production/staging (`notification.config.ts:22-30`), but the live setting is not in the repository.
- MSG91's actual delivery behaviour, latency, retention, and whether message bodies are logged provider-side.
- Production Redis configuration, persistence mode, eviction policy and HA topology — directly affects §14.5 and the trip meter.
- Whether the driver mobile app currently reads `data.plaintextOtp`. The field is sent regardless, so CRITICAL-1 exists at the API boundary either way; but it determines whether Phase 6 is a client-breaking change.
- Whether the customer mobile app has any PIN entry/display surface, and mobile release cadence — determines whether §19.4 needs the `otpCode` compatibility alias.
- Deployment secrets, environment variables, and which migrations are actually applied in production.
- Whether a config/feature-flag mechanism exists for a gradual Phase 4 rollout. `platform-config-resolver.service.ts` exists in the admin module but was **not** traced for this purpose.
- Active-rider counts, so no adoption threshold for the Phase 4 cutover can be recommended numerically.
- **Runtime confirmation of CRITICAL-2.** The rollback is confirmed by reading the call chain plus documented Prisma `$transaction` semantics; it was not executed. The §24 integration test settles it.
- Real-world PIN-choice distribution for this specific user base — the blocklist in §10.1 is based on published general studies, not on this platform's data.
- Prior audit documents exist under `docs/` (`CUSTOMER_PERMANENT_RIDE_PIN_VERIFICATION.md`, `COMPLETE_RIDE_PLATFORM_WORKFLOW_AUDIT.md`, others). This analysis was performed from source and did not rely on them; note that at least one is now **stale** — it states the customer has no delivery channel, whereas `deliverStartOtpToCustomer` exists at `lifecycle.service.ts:401`.

---

## 29. Production Readiness Checklist **[TARGET]**

### Credential security

- [ ] PIN never stored in plaintext
- [ ] Verifier is **salted** (scrypt per-record salt) — not a bare unsalted HMAC
- [ ] Verifier additionally protected by a **dedicated** server-side pepper, not one derived from `JWT_REFRESH_SECRET`
- [ ] Comparison is constant-time (`timingSafeEqual`)
- [ ] "No PIN" and "wrong PIN" are indistinguishable in code, message, and timing
- [ ] PIN never sent to the driver on any surface
- [ ] PIN never logged at any level in any environment
- [ ] PIN never in events, outbox, socket payloads, metric labels, or Swagger
- [ ] Leading zeros preserved — PIN handled as a string end to end, never parsed as a number

### Authorization

- [ ] Authenticated driver
- [ ] Operable driver
- [ ] Driver assigned to _this_ ride
- [ ] PIN resolved from `ride.customerId`, never from the request
- [ ] Ride in `DRIVER_ARRIVED`

### Abuse prevention

- [ ] **Failed attempts persist across the transaction rollback** (the CRITICAL-2 regression test passes)
- [ ] Per-ride, per-customer and per-driver limits all enforced
- [ ] Cooldown between attempts
- [ ] Lockout with a clear retry-after
- [ ] Redis-down behaviour is fail-closed and alerted

### State

- [ ] Atomic transition preserved (`lockForUpdate` + `updateStatusIf`)
- [ ] Replay governed by the state machine, with the trade documented and tested
- [ ] Trip meter resets only after a successful commit

### Operations

- [ ] Phase 1 migration tested on a production-sized copy
- [ ] Rollback strategy per phase (§27), including the Phase 4 stranded-ride mitigation
- [ ] Metrics live and dashboarded before Phase 4
- [ ] Alerting on lockout rate and per-driver failure rate
- [ ] `RIDE_PIN_PEPPER` provisioned in the secret manager, distinct from `JWT_REFRESH_SECRET`, with a documented rotation plan
- [ ] Support runbook: "customer forgot PIN" -> self-service reset, **never** an operator lookup (operators cannot read it, by design)

---

## 30. Final Recommendation

Proceed with the static 4-digit customer PIN, in the phase order of §22, with three non-negotiables:

1. **Use salted scrypt (`hashPassword`/`verifyPassword`), not `OtpHasher`.** An unsalted HMAC over a 10,000-value keyspace is broken by frequency analysis on a database dump alone, with no secret required. This is the decision most likely to be shortcut on the grounds that "the existing hasher is already there" — it should not be.
2. **Move attempt accounting out of the ride transaction.** CRITICAL-2 exists because a counter was incremented inside the transaction that the failure aborts. Re-creating that shape in the new code is the most likely way for this migration to ship a familiar bug in unfamiliar clothes.
3. **Keep OTP minting alive through Phase 4.** One wasted insert per ride buys a clean rollback on the only phase where rollback can strand live rides.

Everything else — authorization, state machine, locking, trip meter, audit, outbox, realtime — is already correct and should be left alone.

---

# 31. Final Executive Summary

### CURRENT — what the system does today

A fresh 6-digit ride-scoped OTP is minted inside the driver-acceptance transaction, stored as an unsalted peppered HMAC in `ride_otps` with a 15-minute TTL and a 5-attempt cap, SMSed to the customer after commit, and verified at `POST /rides/:id/start` under a ride row lock with a conditional status claim. Replay and concurrency protection are genuinely strong.

### PROBLEM — what is unsafe today

1. **CRITICAL-1:** the plaintext OTP is returned to the driver in the accept response (`lifecycle.service.ts:387` -> `ride-state.controller.ts:44`), voiding the passenger-presence control entirely. Two integration tests depend on the bypass.
2. **CRITICAL-2:** the failed-attempt counter is incremented inside the transaction that the failure rolls back, so the 5-attempt cap never engages; the route has no HTTP rate limit; and the unit test that appears to prove the cap uses a rollback-free in-memory fake.
3. **HIGH-1:** a 15-minute TTL with no regeneration path permanently bricks any ride with a slow pickup.
4. **HIGH-2:** OTP delivery is silent-fail with no resend — masked today by CRITICAL-1, and a live availability failure the moment CRITICAL-1 is fixed alone.

### TARGET

A 4-digit PIN owned by the customer account, stored on `users` as `scrypt(HMAC(dedicated_pepper, pin))` with a per-record salt, resolved at ride start via `ride.customerId`, verified with `timingSafeEqual`, and protected by layered Redis throttling (per-ride / per-customer / per-driver / cooldown / lockout) recorded **outside** the ride transaction. No credential is minted at acceptance, no SMS is sent, and the driver never receives the PIN on any surface.

### KEEP — existing code that is safe and reusable

`hashPassword`/`verifyPassword` (scrypt, salted, `timingSafeEqual`, dummy-hash path) · `RateLimitStore` (atomic Lua INCR+EXPIRE) · `OtpService.send`/`verify` for reset step-up · `lockAndValidate` · `ALLOWED_TRANSITIONS` / `validateTransition` · `updateStatusIf` / `lockForUpdate` · the partial unique indexes · `TripDistanceStore` and `resetTripMeter` · `RideStatusEventRepository` · `EventPublisher` / `OutboxRelay` / `EventBus` · both ride consumers · `auth.plugin.ts` · `assertRideParty` · the booking-time onboarding-gate pattern · `OtpHasher` (for the auth OTP, just not for the PIN).

### CHANGE

`startRide` verifies the customer PIN with throttling outside the transaction · `startRideSchema` becomes a 4-digit digit-validated `pin` · `acceptRideRequest` stops returning `plaintextOtp` · `POST /rides/accept` gains a response schema · booking gains a PIN-configured gate · `users` gains three columns · new ride-PIN errors and metrics · `redact.ts` gains PIN field names · `OtpPurpose` gains `RIDE_PIN_RESET`.

### REMOVE — Phase 9, after the PIN path is proven

`RideOtpService` · `RideOtpRepository` · `generateRideOtp` · the three `RIDE_OTP_*` constants · `deliverStartOtpToCustomer` · `OtpVerificationError` · the `RideOtp` model and `ride_otps` table · `tests/unit/rides/ride-otp.test.ts`.

### NEW

`RidePinService` (set/change/reset + blocklist + versioning) · three `/users/me/ride-pin*` endpoints · `RidePinVerificationService` · `RidePinThrottle` · `ride-pin.config.ts` · the Phase 1 migration · the §24 test suite.

### RISK — the biggest migration risks

1. **Phase 4 rollback strands in-flight rides** — a ride accepted during the PIN window has no `ride_otps` row and cannot be started after a revert. Mitigate by keeping OTP minting alive through Phase 4.
2. **Re-creating CRITICAL-2 in the new throttle** — the failure record must survive the rollback. It is the easiest mistake to repeat.
3. **Reusing `OtpHasher` out of convenience** — an unsalted HMAC over a 10,000 keyspace is broken by frequency analysis alone.
4. **Fixing CRITICAL-1 without the PIN model** — promotes HIGH-2 into dead rides on every dropped SMS.
5. **Client coordination** on the `otpCode` -> `pin` body change — mobile release cadence is **[NOT VERIFIED]**.
6. **Customers without a PIN reaching the kerb** — prevented only if the booking gate ships in the _same_ release as the `/start` change.

### IMPLEMENTATION ORDER

```
0. Audit                          [this document — complete]
1. users: three columns           [additive, reversible, no read path]
2. PIN setup/change/reset         [customers begin setting PINs]
   -- allow adoption to accumulate --
3. Verification + throttle infra  [unit-tested, not yet wired]
4. /start -> PIN  +  booking gate [SAME RELEASE; keep OTP minting alive]
5. Acceptance cleanup             [stop minting + stop SMS]
6. Response security              [remove plaintextOtp; attach response schema]
7. Tests                          [§24 in full]
8. Observability verification     [prove no leakage; prove attempts persist]
9. Legacy removal                 [deprecate, then drop ride_otps last]
```

**No code, schema, migration, dependency, or test in this repository was modified in producing this document.**
