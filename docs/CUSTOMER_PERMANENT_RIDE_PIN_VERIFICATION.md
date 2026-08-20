# Customer Permanent 4-Digit Ride PIN

# Codebase Verification Report

## 1. Verification Scope

Verify against **source code only** whether this flow exists today:

```
Customer → permanent 4-digit PIN → same PIN every ride → customer tells driver
        → driver enters PIN → backend verifies it against ride.customerId → ride starts
```

with the PIN being customer-owned, exactly 4 digits, constant across rides, used for ride-start verification, **never handed to the driver by the backend**, and verified against the customer of that specific ride.

Read directly, not inferred: `prisma/schema/modules/**` (all 15 module dirs), `prisma/migrations/**`, `src/modules/rides/**` (routes, controllers, services, repositories, schemas, events, jobs, metrics, constants, utils), `src/modules/users/**`, `src/modules/auth/**` (OTP services, hasher, plugins, repositories), `src/modules/drivers/routes+controllers`, `src/modules/notifications/**`, `src/plugins/socket/`, `src/core/websocket/`, `src/core/database/extensions/`, `src/config/ride/`, `src/config/rate-limit/`, `tests/unit/rides/**`, `tests/integration/**`, `prisma/seed/**`.

Documentation was read **last and only for cross-reference** (§14, §16). Every claim below cites a file and line. No file was modified.

---

## 2. Existing Implementation

**A per-customer permanent PIN does not exist.** A **per-ride, 6-digit, 15-minute, single-use start OTP** exists and is fully wired.

Repository-wide identifier search, all case variants, over `src/`, `prisma/`, `tests/`, `scripts/`:

| Searched                                                                                                 | Hits                                                                                               |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ridePin`, `ride_pin`, `customerPin`, `customer_pin`, `tripPin`, `startPin`, `bookingPin`, `securityPin` | **0**                                                                                              |
| `\bpin\b` word-boundary (minus `pinned`/`pino`/`pipe`/`spin`)                                            | **0** in code; 1 in docs — `docs/03_Requirements/01_srs-functional.md:41`, "map pin" (a UI marker) |
| `4-digit`, `4 digit`, `four-digit`                                                                       | **0** in code                                                                                      |
| `rideOtp` / `RideOtp` / `START` purpose                                                                  | **Present** — the subsystem below                                                                  |

The real components:

| File                                                                                                                   | Role                                        |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [prisma/schema/modules/ride/ride.prisma](prisma/schema/modules/ride/ride.prisma)                                       | `RideOtp` model, keyed on `rideId`          |
| [prisma/migrations/20260724173304_init/migration.sql:1674](prisma/migrations/20260724173304_init/migration.sql#L1674)  | `ride_otps` table                           |
| [src/modules/rides/utils/otp.util.ts](src/modules/rides/utils/otp.util.ts)                                             | `generateRideOtp()`                         |
| [src/modules/rides/services/otp/ride-otp.service.ts](src/modules/rides/services/otp/ride-otp.service.ts)               | `generateStartOtp` / `verifyStartOtp`       |
| [src/modules/rides/repositories/ride-otp.repository.ts](src/modules/rides/repositories/ride-otp.repository.ts)         | Atomic `claimAttempt` / `claimVerification` |
| [src/modules/rides/services/lifecycle/lifecycle.service.ts](src/modules/rides/services/lifecycle/lifecycle.service.ts) | `acceptRideRequest`, `startRide`            |
| [src/modules/rides/controllers/ride-state.controller.ts](src/modules/rides/controllers/ride-state.controller.ts)       | HTTP handlers                               |
| [src/modules/auth/services/otp/otp.hasher.ts](src/modules/auth/services/otp/otp.hasher.ts)                             | HMAC-SHA256 + pepper, shared                |

---

## 3. Customer PIN Storage

**No PIN is stored against any customer.**

`User` scalar columns, complete ([prisma/schema/modules/user/user.prisma](prisma/schema/modules/user/user.prisma)):

`id`, `phoneNumber`, `email`, `passwordHash`, `status`, `isPhoneVerified`, `isEmailVerified`, `lastLoginAt`, `createdAt`, `updatedAt`, `deletedAt`

`UserProfile` scalar columns, complete:

`id`, `userId`, `firstName`, `lastName`, `dateOfBirth`, `gender`, `profileImageFileId`, `languageCode`, `referralCode`, `createdAt`, `updatedAt`

No PIN, PIN hash, or PIN digest on either. No `CustomerSecurity`, `UserPin`, or `CustomerPin` table in any of the 15 schema module directories. No migration adds a PIN column to any table.

The only ride-side code store:

```prisma
model RideOtp {
  id         String    @id @default(uuid(7)) @db.Uuid
  rideId     String    @map("ride_id") @db.Uuid      // ← per RIDE
  otpHash    String    @map("otp_hash")
  purpose    String    @default("START")
  attempts   Int       @default(0) @db.SmallInt
  verified   Boolean   @default(false)
  verifiedAt DateTime? @map("verified_at")
  expiresAt  DateTime  @map("expires_at")            // ← expires, so not constant
  createdAt  DateTime  @default(now()) @map("created_at")

  ride Ride @relation(fields: [rideId], references: [id])

  @@index([rideId])
  @@map("ride_otps")
}
```

No `customerId`, no `userId`. Storage form: **hashed**, HMAC-SHA256 with a server-side pepper — never plaintext ([ride-otp.service.ts:25](src/modules/rides/services/otp/ride-otp.service.ts#L25)). Index: `ride_otps_ride_id_idx` ([migration.sql:2880](prisma/migrations/20260724173304_init/migration.sql#L2880)). No unique constraint on the code.

---

## 4. PIN Generation

**No customer PIN is generated.** The account-creation path writes no code of any kind — `UserRepository.create` ([src/modules/auth/repositories/user.repository.ts:25-34](src/modules/auth/repositories/user.repository.ts#L25)) inserts only `phoneNumber`, `isPhoneVerified`, and optionally `status` and `email`. Nothing in registration, first login, first ride, admin action, or seed data assigns a durable code to a `User`.

The ride OTP generator ([src/modules/rides/utils/otp.util.ts](src/modules/rides/utils/otp.util.ts)):

```ts
export function generateRideOtp(): string {
  let code = '';
  for (let i = 0; i < RIDE_OTP_LENGTH; i += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
}
```

| Property                    | Actual                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Length                      | **6 digits** — `RIDE_OTP_LENGTH = 6` ([ride.constants.ts:31](src/modules/rides/constants/ride.constants.ts#L31))                                                  |
| Randomness                  | Cryptographically secure — `randomInt` from `node:crypto`, one draw per digit                                                                                     |
| Leading zero                | Possible; each digit drawn independently from `[0,10)`                                                                                                            |
| When                        | Inside `acceptRideRequest`, same transaction that creates the `Ride` ([lifecycle.service.ts:137](src/modules/rides/services/lifecycle/lifecycle.service.ts#L137)) |
| Automatic                   | Yes — per ride acceptance, not per customer                                                                                                                       |
| Duplicates across customers | Permitted; no uniqueness constraint                                                                                                                               |
| Lifetime                    | 15 min (`RIDE_OTP_TTL_MINUTES = 15`)                                                                                                                              |

---

## 5. PIN Persistence

**Not persistent — the opposite by design.** Three independent mechanisms make the current code non-constant:

1. **New row per ride.** `generateStartOtp(ride.id, tx)` is called once per `acceptRideRequest`, inserting a fresh `RideOtp` with a fresh random value.
2. **Expiry.** `expiresAt = now + 15 min`; `verifyStartOtp` rejects on `expiresAt <= Date.now()` ([ride-otp.service.ts:44-46](src/modules/rides/services/otp/ride-otp.service.ts#L44)).
3. **Single use.** `claimVerification` flips `verified` via a conditional `updateMany`; a second use of the same code fails ([ride-otp.repository.ts](src/modules/rides/repositories/ride-otp.repository.ts)).

Observed behaviour:

```
Customer A, Ride 1 → 482913
Customer A, Ride 2 → 730154   (new row, new value, new 15-min window)
Customer A, Ride 3 → 019287
```

Against the requirement's seven defining properties — stored against the customer, same across rides, never expires, exactly 4 digits, reusable, customer-retrievable, has a change/regenerate mechanism — the implementation matches **zero of seven**.

---

## 6. Customer Retrieval

**The customer cannot retrieve any code — not a PIN, and not even the per-ride OTP.**

Traced every customer-readable surface:

| Surface                         | Handler / evidence                                                                                                                                                                                                                                   | Exposes a code? |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `GET /api/v1/users/me`          | `UserService.getMe` → `toAccountView` returns `id`, `phoneNumber`, `email`, `isPhoneVerified`, `isEmailVerified`, `status`, `roles`, `createdAt`, `lastLoginAt`, `profile` ([user.service.ts:13-26](src/modules/users/services/user.service.ts#L13)) | **No**          |
| `GET /api/v1/rides/active`      | `findActiveByCustomer` — bare `ride.findFirst`, no `otps` include ([ride.repository.ts:86](src/modules/rides/repositories/ride.repository.ts#L86))                                                                                                   | **No**          |
| `GET /api/v1/rides/:id`         | `findById` includes `fare`, `cancellation`, `statusEvents`, `driver.userId` only ([ride.repository.ts:70-82](src/modules/rides/repositories/ride.repository.ts#L70))                                                                                 | **No**          |
| `GET /api/v1/rides/history`     | `listCustomerRides` — includes `fare` only                                                                                                                                                                                                           | **No**          |
| `GET /api/v1/rides/:id/receipt` | `ReceiptService`                                                                                                                                                                                                                                     | **No**          |
| SMS                             | `NotificationService.sendOtp` exists ([notification.service.ts:24](src/modules/notifications/notification.service.ts#L24)) but its **only caller** is `auth/services/otp/otp.service.ts:104`. The rides module never calls it                        | **No**          |
| Push / in-app                   | `src/modules/notifications/` has no consumers directory; **no subscriber to any `ride.*` event** (grep for `ride.` across the module and `src/jobs/consumers/`: 0 hits)                                                                              | **No**          |
| WebSocket                       | `src/plugins/socket/socket.plugin.ts` is **`export {};`** — a stub. No realtime channel exists at all                                                                                                                                                | **No**          |
| `ride.accepted` event           | Payload is `{ rideId, driverId }` ([lifecycle.service.ts:151-156](src/modules/rides/services/lifecycle/lifecycle.service.ts#L151))                                                                                                                   | **No**          |

The customer is never told the code they are supposed to speak aloud. There is no retrieval endpoint to mask, rate-limit, or audit, because there is no retrieval endpoint.

---

## 7. Ride → Customer Binding

The **data** relationship is sound. The **verification** relationship does not exist.

Trace:

1. `POST /api/v1/rides/requests` → `RideRequest` row carrying `customerId`.
2. `POST /api/v1/rides/accept` → `acceptRideRequest`, one transaction:
   - `requestRepo.lockForUpdate` + `claimForMatch` (conditional claim, so one winner),
   - `rideRepo.create({ customerId: request.customerId, … })` ([lifecycle.service.ts:123](src/modules/rides/services/lifecycle/lifecycle.service.ts#L123)),
   - `generateStartOtp(ride.id, tx)` — keyed on `ride.id` **only**.

`rides.customer_id` is a real FK to `users`, indexed (`@@index([customerId])`). So the traversal `ride.customerId → User` **is available**.

But `RideOtpService` never uses it. It never reads `ride.customerId`, never loads a `User`. The lookup is:

```ts
const latestOtp = await this.otpRepo.findLatestByRideId(rideId, tx); // ride-otp.service.ts:40
```

| Possible linkage                                | Actual                                    |
| ----------------------------------------------- | ----------------------------------------- |
| Code copied into the `Ride` record              | **No** — `Ride` has no code column        |
| Code referenced through `customerId`            | **No** — `RideOtp` has no customer column |
| Code retrieved from `User` at verification time | **No** — `User` has no code to retrieve   |
| Code in a per-ride side table keyed on `rideId` | **Yes**                                   |

**On the "search for a customer whose PIN matches" anti-pattern:** the current code does not do this, and structurally cannot — there is no customer-keyed code table to search. The concern is prospective: if a per-customer PIN is added, the correct traversal must be written from scratch, and nothing in `RideOtpService` can be reused as the binding step.

---

## 8. Driver PIN Entry

**Endpoint:** `POST /api/v1/rides/:id/start` ([ride.routes.ts:21](src/modules/rides/routes/ride.routes.ts#L21))

| Aspect               | Implementation                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body                 | `{ otpCode: string }` — `z.string().length(RIDE_OTP_LENGTH)` = exactly 6 chars ([ride.schemas.ts:36](src/modules/rides/schemas/ride.schemas.ts#L36)). Length-checked, **not** digit-checked — `"abcdef"` passes schema validation |
| Authentication       | Global `denyByDefault` `onRequest` hook + JWT; `tests/integration/route-graph.test.ts` asserts every `/api/v1/rides` route rejects unauthenticated callers                                                                        |
| Driver authorization | `fastify.authorize({ requireOperableDriver: true })`; fails **closed** on lookup error ([auth.plugin.ts:106-120](src/modules/auth/plugins/auth.plugin.ts#L106))                                                                   |
| Actor resolution     | `actingDriverId(req)` → `driverRepository.findByUserId(callerId)` → `Driver.id` ([ride-state.controller.ts:21-25](src/modules/rides/controllers/ride-state.controller.ts#L21))                                                    |
| Driver owns the ride | `lockAndValidate` throws `RideDriverMismatchError` unless `ride.driverId === actor.driverId` ([lifecycle.service.ts:91](src/modules/rides/services/lifecycle/lifecycle.service.ts#L91))                                           |
| Ride status gate     | `validateTransition(ride.status, 'IN_PROGRESS')` — only `DRIVER_ARRIVED` qualifies                                                                                                                                                |
| Row lock             | `SELECT … FOR UPDATE` before validation ([ride.repository.ts:27](src/modules/rides/repositories/ride.repository.ts#L27))                                                                                                          |
| Transaction          | Verification + status write + event publish all inside `txManager.execute`                                                                                                                                                        |
| State transition     | `updateStatusIf(rideId, expected, 'IN_PROGRESS', { startedAt })` — compare-and-swap                                                                                                                                               |

---

## 9. PIN Verification

`RideOtpService.verifyStartOtp` ([ride-otp.service.ts:35-61](src/modules/rides/services/otp/ride-otp.service.ts#L35)), in order:

1. `findLatestByRideId(rideId)` — `where: { rideId, verified: false }`, newest first. Absent → `OtpVerificationError`.
2. Expiry → `OtpVerificationError('OTP has expired')`.
3. `claimAttempt(id, RIDE_OTP_MAX_ATTEMPTS)` — atomic conditional `updateMany` (`attempts < max`); false → "Maximum OTP verification attempts exceeded".
4. `this.otpHasher.hash(plaintextOtp) !== latestOtp.otpHash` → "Invalid start OTP code".
5. `claimVerification(id)` — atomic conditional `updateMany` on `verified: false`; false → "This OTP has already been used".

Comparison is a plain string `!==` on two 64-char hex HMAC digests, not `crypto.timingSafeEqual`. Since both operands are peppered digests, the timing channel leaks nothing an attacker can steer without the pepper.

The verification machinery is correct. Its weakness is not in the algorithm — it is that the secret was already given to the party being checked (§11).

---

## 10. Ride Start Enforcement

Real ride states ([ride.constants.ts:1-14](src/modules/rides/constants/ride.constants.ts#L1)): `REQUESTED`, `SEARCHING`, `ACCEPTED`, `DRIVER_ARRIVING`, `DRIVER_ARRIVED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_DRIVER`, `CANCELLED_BY_SYSTEM`, `NO_DRIVERS_FOUND`.

Transition table ([lifecycle.service.ts:25-49](src/modules/rides/services/lifecycle/lifecycle.service.ts#L25)):

```
ACCEPTED         → DRIVER_ARRIVING, DRIVER_ARRIVED, CANCELLED_BY_{CUSTOMER,DRIVER,SYSTEM}
DRIVER_ARRIVING  → DRIVER_ARRIVED, CANCELLED_BY_{CUSTOMER,DRIVER,SYSTEM}
DRIVER_ARRIVED   → IN_PROGRESS, CANCELLED_BY_{CUSTOMER,DRIVER,SYSTEM}
IN_PROGRESS      → COMPLETED, CANCELLED_BY_SYSTEM
COMPLETED / CANCELLED_* / NO_DRIVERS_FOUND → terminal
```

`DRIVER_ARRIVED` is the **only** predecessor of `IN_PROGRESS` — a driver cannot skip arrival.

Every `IN_PROGRESS` reference in `src/` enumerated:

| Start Path               | Function/Endpoint                                             | PIN Required                                                                                           | Evidence                                                                                       |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Driver starts ride       | `POST /api/v1/rides/:id/start` → `LifecycleService.startRide` | **Yes** — `verifyStartOtp` runs before `updateStatusIf`, same transaction; a throw aborts it           | [lifecycle.service.ts:204-241](src/modules/rides/services/lifecycle/lifecycle.service.ts#L204) |
| Driver arrival           | `POST /:id/arrive` → `markDriverArrived`                      | N/A — targets `DRIVER_ARRIVED`                                                                         | [lifecycle.service.ts:161](src/modules/rides/services/lifecycle/lifecycle.service.ts#L161)     |
| Driver accepts           | `POST /accept` → `acceptRideRequest`                          | N/A — creates ride in `ACCEPTED`                                                                       | [lifecycle.service.ts:105](src/modules/rides/services/lifecycle/lifecycle.service.ts#L105)     |
| Complete                 | `POST /:id/complete`                                          | N/A — needs `IN_PROGRESS` as source                                                                    | [lifecycle.service.ts:243](src/modules/rides/services/lifecycle/lifecycle.service.ts#L243)     |
| Admin override           | —                                                             | **No such path** — `src/modules/admin/index.ts` is `export {};`                                        | [src/modules/admin/index.ts](src/modules/admin/index.ts)                                       |
| Background jobs          | `dispatch-timeout.job.ts`, `request-expiry.job.ts`            | **No such path** — only `RideRequest` status (`CREATED`/`SEARCHING` → `EXPIRED`)                       | [request-expiry.job.ts:21-29](src/modules/rides/jobs/request-expiry.job.ts#L21)                |
| Unconditional repo write | `RideRepository.updateStatus` — no CAS, no code check         | **Dead code** — grep for `updateStatus(` on the ride repo across `src/` and `tests/`: **zero callers** | [ride.repository.ts:114](src/modules/rides/repositories/ride.repository.ts#L114)               |
| Raw SQL                  | —                                                             | **None** — no `UPDATE "rides"` anywhere in `src/` or `prisma/`                                         | grep: 0 hits                                                                                   |
| Prisma extension         | `RideExtensions.ts`                                           | Read-only `findMany`                                                                                   | [RideExtensions.ts:11](src/core/database/extensions/RideExtensions.ts#L11)                     |

**One path into `IN_PROGRESS`, and it verifies the code.** No alternate endpoint bypass exists.

Note: `rideConfig.requireStartOtp` ([ride.config.ts:16](src/config/ride/ride.config.ts#L16), [:65](src/config/ride/ride.config.ts#L65)) is defined and **referenced nowhere else** — a repo-wide grep returns only those two lines. Verification is therefore unconditional, which is the safe outcome; but `RIDE_REQUIRE_START_OTP=false` would silently do nothing (§16, HIGH-1).

---

## 11. PIN Exposure Check

**This is the critical finding. The backend hands the code straight to the driver.**

`acceptRideRequest` returns the plaintext, and the driver-only accept handler sends it in the response body:

```ts
// lifecycle.service.ts:110  — signature
async acceptRideRequest(data: {…}): Promise<{ ride: Ride; plaintextOtp: string }>

// lifecycle.service.ts:158
return { ride, plaintextOtp };

// ride-state.controller.ts:29-36  — route guarded by requireOperableDriver
const result = await this.rideService.lifecycle.acceptRideRequest({ … });
reply.send({ data: result });        // data.plaintextOtp goes to the driver
```

Proven by the integration test, which reads the code out of the driver's own accept response and replays it into `/start`:

```ts
// tests/integration/earnings-pipeline.test.ts:89-90, 100-106
const rideId  = accepted.json().data.ride.id;
const otpCode = accepted.json().data.plaintextOtp;
…
url: `/api/v1/rides/${rideId}/start`, payload: { otpCode }   // → 200
```

Channel-by-channel audit as required:

| Channel                          | Result                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Driver accept response**       | **EXPOSED** — `data.plaintextOtp` ([ride-state.controller.ts:36](src/modules/rides/controllers/ride-state.controller.ts#L36))                                                                                                                                                                          |
| Driver ride details              | Not exposed — driver reads via `GET /api/v1/rides/active` → `findActiveByDriverUserId`, a bare `findFirst` with no `otps` include ([ride.repository.ts:106](src/modules/rides/repositories/ride.repository.ts#L106)); `GET /:id` includes only `fare`, `cancellation`, `statusEvents`, `driver.userId` |
| Driver API (`/api/v1/drivers/*`) | Not exposed — no ride-code surface; routes cover profile, documents, status, location, wallet ([driver.routes.ts](src/modules/drivers/routes/driver.routes.ts))                                                                                                                                        |
| Socket event                     | Not exposed — `src/plugins/socket/socket.plugin.ts` is `export {};`, a stub                                                                                                                                                                                                                            |
| Push notification                | Not exposed — no ride-event consumer in `src/modules/notifications/`; `sendOtp` is called only by auth                                                                                                                                                                                                 |
| Logs                             | Not exposed — no `log` call in the rides module writes `plaintextOtp`                                                                                                                                                                                                                                  |
| Database response                | Not exposed — only `otpHash` is persisted; plaintext never written                                                                                                                                                                                                                                     |
| Event payloads                   | Not exposed — `ride.accepted` = `{ rideId, driverId }`; `ride.dispatch.offered` = `{ dispatchId, requestId, driverId }` ([dispatch.service.ts:42-49](src/modules/rides/services/dispatch/dispatch.service.ts#L42))                                                                                     |

Every channel is clean except the one that matters. **The requirement "the driver must NOT receive the expected PIN from the backend" is violated today**, and the customer — who is supposed to be the sole holder — has no way to get the code at all (§6).

---

## 12. Security Verification

| Check                                           | Result              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not stored plaintext                            | **PASS**            | HMAC-SHA256 + server pepper; only `otpHash` persisted ([otp.hasher.ts](src/modules/auth/services/otp/otp.hasher.ts), [ride-otp.service.ts:25](src/modules/rides/services/otp/ride-otp.service.ts#L25))                                                                                                                                                                                                                                                                                          |
| **Not returned to driver**                      | **FAIL**            | `data.plaintextOtp` in the `/accept` response (§11)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Not logged                                      | **PASS**            | No log call writes the plaintext                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Customer A's code unusable on Customer B's ride | **PASS**            | Lookup is `findLatestByRideId(rideId)`; `ride_otps` rows are partitioned by `ride_id`, and each ride has exactly one `customerId`. Another customer's code is unreachable from this `rideId`                                                                                                                                                                                                                                                                                                    |
| Driver cannot verify another customer's code    | **PASS**            | Same mechanism, plus `lockAndValidate` proves `ride.driverId === callerDriverId` before any lookup                                                                                                                                                                                                                                                                                                                                                                                              |
| Driver cannot start another driver's ride       | **PASS**            | `RideDriverMismatchError` ([lifecycle.service.ts:91](src/modules/rides/services/lifecycle/lifecycle.service.ts#L91)); covered by test "refuses a driver acting on another driver's ride" ([ride-lifecycle-concurrency.test.ts:204](tests/unit/rides/ride-lifecycle-concurrency.test.ts#L204))                                                                                                                                                                                                   |
| Wrong code fails                                | **PASS**            | Digest mismatch → `OtpVerificationError`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Repeated wrong attempts controlled              | **PASS (per code)** | `RIDE_OTP_MAX_ATTEMPTS = 5` via `claimAttempt` — a single conditional `updateMany` (`attempts: { lt: max }`), not read-then-write                                                                                                                                                                                                                                                                                                                                                               |
| Brute-force protection                          | **PARTIAL**         | Per-code cap only. **No** `fastify.rateLimit` on `/start` (nor `/accept`, `/arrive`, `/complete`) — `rateLimits.rideWrite` exists at [rate-limit.config.ts:47](src/config/rate-limit/rate-limit.config.ts#L47) and is applied only to `/requests` and `/:id/cancel`. No driver-level or cross-ride counter. No Redis throttle. `RideMetrics.otpFailure()` is defined at [ride.metrics.ts:35](src/modules/rides/metrics/ride.metrics.ts#L35) and **never called**, so failures emit no telemetry |
| Concurrent verification                         | **PASS**            | Both claims are atomic conditional updates; test fires 50 parallel guesses and asserts `attempts === RIDE_OTP_MAX_ATTEMPTS` exactly ([ride-otp.test.ts:106](tests/unit/rides/ride-otp.test.ts#L106))                                                                                                                                                                                                                                                                                            |
| Replay                                          | **PASS**            | `claimVerification` on `verified: false`; second use rejected ([ride-otp.test.ts:57](tests/unit/rides/ride-otp.test.ts#L57))                                                                                                                                                                                                                                                                                                                                                                    |
| Transaction safety                              | **PASS**            | `startRide` wraps lock → validate → verify → CAS status → event in one `txManager.execute`; concurrency tests confirm exactly-once completion and one terminal transition under races                                                                                                                                                                                                                                                                                                           |

**Keyspace note for the proposed design.** The current 6-digit code gives 10⁶ values with a 5-attempt cap — 5-in-1,000,000 per ride, and the code dies in 15 minutes. A **permanent 4-digit** PIN gives 10,000 values, and because it never rotates, attempts **accumulate across every ride that customer ever takes**. With no cross-ride attempt tracking, no rate limit on `/start`, and no failure metric, the existing controls would not bound that. Reported, not redesigned.

---

## 13. PIN Change/Regeneration

**NOT IMPLEMENTED.**

No endpoint, service method, or repository call anywhere changes, rotates, resets, or regenerates a customer code. There is nothing to check for authentication, current-PIN verification, new-PIN validation, old-PIN invalidation, active-ride handling, or rate limiting.

This is consistent, not defective: a per-ride code has no need for rotation — it is replaced on every ride by construction. It becomes a required component only if a permanent PIN is adopted.

Related gap that _is_ a live issue: there is no **resend** path either. `generateStartOtp` is called only from `acceptRideRequest`, so once `attempts` hits 5 the ride can never be started and must be cancelled (§16, MEDIUM-1).

---

## 14. Existing OTP Comparison

Four concepts, kept strictly separate in code:

| Code Type                                | Purpose                                            | Lifetime                                                                                                                                                                              | Owner                                   | Used By                                                                                                                                                                                            |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AUTH OTP** (`LOGIN`, `REGISTER`)       | Prove control of a phone number to authenticate    | Short TTL; secret **Redis-only**, never in Postgres — `otp_verifications` deliberately has **no** `otp_hash` column ([auth.prisma:74-75](prisma/schema/modules/auth/auth.prisma#L74)) | Phone number (`User` may not exist yet) | `POST /auth/otp/send`, `/auth/otp/verify`; rate-limited via `OtpRateLimiter`; delivered by `NotificationService.sendOtp` ([otp.service.ts:104](src/modules/auth/services/otp/otp.service.ts#L104)) |
| **PHONE CHANGE OTP** (`PHONE_CHANGE`)    | Prove control of a **new** number before rebinding | Short TTL, Redis-only, **purpose-scoped Redis key** so it cannot be replayed against `/auth/otp/verify` to log in                                                                     | Existing `User`                         | [phone-change.service.ts](src/modules/users/services/phone/phone-change.service.ts)                                                                                                                |
| **RIDE START OTP** (`purpose = 'START'`) | Gate `DRIVER_ARRIVED → IN_PROGRESS`                | **15 min**, single-use, **hashed in Postgres** (`ride_otps`)                                                                                                                          | **A `Ride`** — not a customer           | `POST /api/v1/rides/:id/start`; **no SMS/push/socket delivery path exists**                                                                                                                        |
| **CUSTOMER PERMANENT PIN**               | _(the requirement)_                                | —                                                                                                                                                                                     | —                                       | **DOES NOT EXIST**                                                                                                                                                                                 |

The only shared component is `OtpHasher`. Auth keeps its secret in Redis with a Postgres audit trail; rides keeps a hash in Postgres with no Redis. Both are deliberate; they are not duplicates.

---

## 15. Test Coverage

Files: [tests/unit/rides/ride-otp.test.ts](tests/unit/rides/ride-otp.test.ts) (8), [tests/unit/rides/ride-state-machine.test.ts](tests/unit/rides/ride-state-machine.test.ts), [tests/unit/rides/ride-lifecycle-concurrency.test.ts](tests/unit/rides/ride-lifecycle-concurrency.test.ts), [tests/integration/earnings-pipeline.test.ts](tests/integration/earnings-pipeline.test.ts).

| Requested coverage                 | Status                       | Evidence                                                                                                                                  |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| PIN generation                     | **Covered for the ride OTP** | `ride-otp.test.ts:39`                                                                                                                     |
| **Exactly 4 digits**               | **CONTRADICTED**             | `ride-otp.test.ts:39` asserts `/^\d{6}$/` — the suite actively enforces 6                                                                 |
| PIN persistence                    | **MISSING**                  | Nothing asserts a code survives beyond one ride                                                                                           |
| **Same PIN across multiple rides** | **MISSING**                  | No test books two rides for one customer and compares codes                                                                               |
| Customer retrieval                 | **MISSING**                  | No endpoint exists to test                                                                                                                |
| Driver submission                  | **Covered**                  | `earnings-pipeline.test.ts:100-106`                                                                                                       |
| Correct customer binding           | **MISSING**                  | No test asserts the code is bound to `ride.customerId`                                                                                    |
| Wrong PIN                          | **Covered**                  | `ride-otp.test.ts:86`                                                                                                                     |
| **Wrong customer's PIN**           | **MISSING**                  | No test submits customer B's code against customer A's ride                                                                               |
| Brute force                        | **Covered (per code)**       | `ride-otp.test.ts:86` — 5 wrong guesses then correct code refused                                                                         |
| Concurrent attempts                | **Covered**                  | `ride-otp.test.ts:106` — 50 parallel, `attempts === 5` exactly                                                                            |
| **PIN not returned to driver**     | **MISSING — and inverted**   | `earnings-pipeline.test.ts:89-90` depends on the driver receiving `plaintextOtp`; a test enforcing the correct behaviour would fail today |
| Ride cannot start without PIN      | **MISSING**                  | No test posts `/start` with a missing or empty body                                                                                       |
| Alternate ride-start bypass        | **MISSING**                  | No test asserts no other route reaches `IN_PROGRESS`                                                                                      |
| Expiry                             | Covered                      | `ride-otp.test.ts:73`                                                                                                                     |
| Replay                             | Covered                      | `ride-otp.test.ts:57`                                                                                                                     |
| Hashing not bare SHA-256           | Covered                      | `ride-otp.test.ts:51`                                                                                                                     |
| Driver owns the ride               | Covered (lifecycle level)    | `ride-lifecycle-concurrency.test.ts:204`                                                                                                  |
| State machine legality             | Covered                      | `ride-state-machine.test.ts:23,35`                                                                                                        |

The mechanism is well tested. The **trust model** — who is allowed to hold the code — has no coverage at all, which is why the exposure in §11 survived three prior audits.

---

## 16. Findings

### CRITICAL-1 — The backend gives the ride start code to the driver

`acceptRideRequest` returns `plaintextOtp`; the driver-only `POST /api/v1/rides/accept` sends it in the response body. The customer has no channel to receive it (§6). The driver can therefore start the ride without the customer being present or consenting — `tests/integration/earnings-pipeline.test.ts:89-106` performs exactly that and passes.

Every downstream control (pepper, 5-attempt cap, single-use flag, state machine) protects a secret already held by the party it is meant to constrain. This also enables fare fraud: a driver can start and complete a rider-less ride, and `LedgerService.recordTripPayment` books the fare and driver earning.

**This defect is independent of the PIN decision** — it breaks the existing pickup-verification flow today, and a permanent PIN dropped onto the same delivery model would inherit it with a far more valuable secret.

### CRITICAL-2 — No permanent customer PIN exists, at any layer

Zero PIN identifiers in `src/`, `prisma/`, `tests/`, `scripts/`. No column on `users`/`user_profiles`, no table, no migration, no generation, no storage, no retrieval, no verification, no rotation. The requirement is unimplemented end to end.

### HIGH-1 — `rideConfig.requireStartOtp` is dead configuration

Defined at [ride.config.ts:16](src/config/ride/ride.config.ts#L16) and [:65](src/config/ride/ride.config.ts#L65), referenced nowhere else. `RIDE_REQUIRE_START_OTP=false` silently does nothing. Behaviour is safe today, but an operator will reasonably believe the switch works — and if it is ever wired up it becomes a first-class bypass.

### HIGH-2 — No rate limiting on ride lifecycle write routes

`/accept`, `/:id/arrive`, `/:id/start`, `/:id/complete` have no `fastify.rateLimit`, while `/requests` and `/:id/cancel` do. `rateLimits.rideWrite` already exists and is unapplied. Per-code caps bound guessing within one ride; nothing bounds it across rides — the decisive gap for a permanent 4-digit secret.

### MEDIUM-1 — Attempt exhaustion permanently bricks a ride

`generateStartOtp` is reachable only from `acceptRideRequest`, and there is no resend path. Five wrong entries make the ride unstartable forever; the only exit is cancellation, with fee and rating consequences for a legitimate rider.

### MEDIUM-2 — `RideMetrics.otpFailure()` defined but never called

[ride.metrics.ts:35](src/modules/rides/metrics/ride.metrics.ts#L35), zero call sites. Verification failures are invisible to monitoring. Ironically this is the signal that would have exposed CRITICAL-1 in reverse — an implausibly low failure rate.

### MEDIUM-3 — `RideRepository.updateStatus` is an unguarded status write with no callers

[ride.repository.ts:114](src/modules/rides/repositories/ride.repository.ts#L114) writes any status with no compare-and-swap and no verification, unlike `updateStatusIf` used everywhere else. Dead today, so not a live bypass — but an unguarded route into `IN_PROGRESS` sitting in the same class as the guarded one.

### LOW-1 — `otpCode` is length-validated, not digit-validated

`z.string().length(RIDE_OTP_LENGTH)` accepts `"abcdef"` ([ride.schemas.ts:36](src/modules/rides/schemas/ride.schemas.ts#L36)). Malformed input consumes an attempt and is indistinguishable from a wrong guess in the budget.

### LOW-2 — Digest comparison uses `!==`, not `crypto.timingSafeEqual`

[ride-otp.service.ts:53](src/modules/rides/services/otp/ride-otp.service.ts#L53). Not exploitable as written (both operands are peppered HMAC digests). Recorded because a permanent secret raises the value of any oracle if this code is reused.

### INFO-1 — The customer-binding traversal exists but is unused

`rides.customer_id` is a real, indexed FK to `users`. A future `ride.customerId → user.ridePinHash` lookup has a sound path; `RideOtpService` simply does not use it.

### INFO-2 — The three OTP systems are correctly separated

Auth (Redis-only), phone-change (purpose-scoped Redis key, preventing cross-flow replay), ride-start (hashed in Postgres). Only `OtpHasher` is shared. No conflation found.

### INFO-3 — Docs cross-reference (read after the code, as required)

The written specification also describes a **per-trip** OTP, not a constant PIN: `FR-TRIP-02` ([01_srs-functional.md:62](docs/03_Requirements/01_srs-functional.md#L62)), `R-TRIP-2` ([01_prd.md:85](docs/02_Product/01_prd.md#L85)), `US-TRIP-02` ([02_user-stories.md:124](docs/02_Product/02_user-stories.md#L124)). A permanent customer PIN appears in no requirement, PRD, user story, ADR, or API document.

Also relevant: [PRODUCTION_READINESS_AUDIT.md:819](docs/PRODUCTION_READINESS_AUDIT.md#L819) records that the ride OTP was **once 4 digits** and was deliberately widened to 6 (finding P1-1) because an unsalted hash over a 4-digit code was a lookup table. That historical 4-digit code was still per-ride, never per-customer. Source code confirms the current state independently: `RIDE_OTP_LENGTH = 6`. Adopting a 4-digit length would reverse a documented hardening fix.

---

## 17. Verification Matrix

| Requirement                     | Status      | Evidence                                                                                                                                                                                                                                                                                             | Risk     |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Customer has PIN                | **FAIL**    | Zero PIN identifiers in `src/`/`prisma/`/`tests/`/`scripts/`; no column on `users`/`user_profiles`; no table; no migration                                                                                                                                                                           | CRITICAL |
| Exactly 4 digits                | **FAIL**    | `RIDE_OTP_LENGTH = 6` ([ride.constants.ts:31](src/modules/rides/constants/ride.constants.ts#L31)); test asserts `/^\d{6}$/`                                                                                                                                                                          | HIGH     |
| Permanent across rides          | **FAIL**    | New `RideOtp` row per `acceptRideRequest`; 15-min `expiresAt`; single-use `verified`                                                                                                                                                                                                                 | CRITICAL |
| Secure storage                  | **PARTIAL** | No PIN store exists. The per-ride analogue is correct — HMAC-SHA256 + server pepper, plaintext never persisted                                                                                                                                                                                       | MEDIUM   |
| Customer can retrieve           | **FAIL**    | No endpoint, no SMS (rides never call `sendOtp`), no push (no ride-event consumer), no socket (`socket.plugin.ts` is `export {};`), not in `ride.accepted` payload                                                                                                                                   | CRITICAL |
| Driver can submit               | **PARTIAL** | `POST /:id/start` with auth, `requireOperableDriver`, and ride-ownership checks — but a 6-char OTP, not a PIN                                                                                                                                                                                        | MEDIUM   |
| Bound to `ride.customerId`      | **PARTIAL** | Lookup scoped by `rideId`, which maps to exactly one `customerId`, so cross-customer use is structurally impossible. The explicit `ride.customerId → customer PIN` traversal does not exist                                                                                                          | HIGH     |
| **Driver does not receive PIN** | **FAIL**    | `data.plaintextOtp` returned by driver-only `POST /rides/accept` ([lifecycle.service.ts:158](src/modules/rides/services/lifecycle/lifecycle.service.ts#L158), [ride-state.controller.ts:36](src/modules/rides/controllers/ride-state.controller.ts#L36)); consumed by `earnings-pipeline.test.ts:90` | CRITICAL |
| PIN required before ride start  | **PARTIAL** | Verification is unconditional on the only path into `IN_PROGRESS` — but it verifies a per-ride OTP the driver already holds                                                                                                                                                                          | CRITICAL |
| No alternate bypass             | **PASS**    | One path into `IN_PROGRESS`; admin module is `export {};`; jobs touch only `RideRequest`; no raw `UPDATE "rides"`; `updateStatus` has zero callers                                                                                                                                                   | LOW      |
| Wrong PIN rejected              | **PASS**    | Digest mismatch → `OtpVerificationError`; `ride-otp.test.ts:86`                                                                                                                                                                                                                                      | LOW      |
| Brute-force protection          | **PARTIAL** | Atomic 5-attempt cap per code; **no** rate limit on `/start`, no cross-ride/driver counter, no Redis throttle, `otpFailure()` never emitted                                                                                                                                                          | HIGH     |
| Concurrent verification safe    | **PASS**    | Atomic conditional updates; 50 parallel guesses cap at exactly 5 ([ride-otp.test.ts:106](tests/unit/rides/ride-otp.test.ts#L106)); lifecycle races covered                                                                                                                                           | LOW      |
| Tests                           | **PARTIAL** | Mechanism well covered (8 OTP + state machine + concurrency + full HTTP flow). Trust model uncovered: no wrong-customer, no code-withholding, no missing-code start, no PIN-constancy test                                                                                                           | HIGH     |

---

## Verification Conclusion

**1. What already exists?**

A complete, well-engineered **per-ride start OTP**: `ride_otps` keyed on `ride_id`; 6 digits from `randomInt(0,10)` per digit (`node:crypto`); HMAC-SHA256 + server pepper; 15-minute TTL; single-use; atomic 5-attempt cap; generated in the accept transaction; verified in `startRide` inside one transaction after a `SELECT … FOR UPDATE`, gated by JWT auth, `requireOperableDriver`, driver-ownership, and a `DRIVER_ARRIVED → IN_PROGRESS` compare-and-swap. Plus the sound data relationship `rides.customer_id → users` (real FK, indexed).

**2. What is missing?**

The entire permanent-PIN feature: PIN column/table and migration; generation at customer creation plus backfill; a customer retrieval endpoint and its masking/visibility policy; a change/regeneration mechanism with its abuse controls (**NOT IMPLEMENTED**, §13); the `ride.customerId → customer PIN` verification traversal; cross-ride per-customer brute-force accounting sized for 10,000 permanent values; and tests for constancy, wrong-customer rejection, retrieval, and rotation. Also missing independently: any delivery channel to the customer, HTTP rate limiting on lifecycle write routes, an OTP resend path, and the `otpFailure` metric emission.

**3. What is partially implemented?**

Driver submission (real endpoint, real authorization — but a per-ride OTP). Customer binding (correct by construction via `rideId` scoping, but not the explicit traversal the requirement specifies). Storage security (correct mechanism, wrong subject). Brute-force protection (excellent per code, absent across rides). Ride-start enforcement (structurally mandatory, semantically void because of the exposure). Tests (mechanism yes, trust model no).

**4. What security problems exist?**

**CRITICAL-1** — the backend returns the plaintext start code to the driver in the `/accept` response while the customer has no way to obtain it, so pickup verification proves nothing and rider-less rides can be started and billed. **HIGH-1** — `requireStartOtp` is dead config that appears functional. **HIGH-2** — no rate limiting on `/accept`, `/arrive`, `/start`, `/complete`. **MEDIUM-1/2/3** — no resend (rides brick at 5 attempts), `otpFailure()` never emitted so brute force is invisible, and a dead unconditional `updateStatus` sitting beside the guarded one. **LOW-1/2** — non-digit input consumes an attempt; digest comparison is not constant-time.

**5. What code paths are affected?**

`src/modules/rides/services/lifecycle/lifecycle.service.ts` (`acceptRideRequest` :105-159, `startRide` :204-241), `src/modules/rides/controllers/ride-state.controller.ts` (:29-53), `src/modules/rides/services/otp/ride-otp.service.ts`, `src/modules/rides/repositories/ride-otp.repository.ts`, `src/modules/rides/utils/otp.util.ts`, `src/modules/rides/constants/ride.constants.ts`, `src/modules/rides/schemas/ride.schemas.ts`, `src/modules/rides/routes/ride.routes.ts`, `src/config/ride/ride.config.ts`, `src/config/rate-limit/rate-limit.config.ts`, `prisma/schema/modules/ride/ride.prisma`, `prisma/schema/modules/user/user.prisma`, `tests/integration/earnings-pipeline.test.ts`, `tests/unit/rides/ride-otp.test.ts`.

**6. What evidence supports each conclusion?**

Non-existence of the PIN: exhaustive identifier and word-boundary greps returning zero, plus full column listings of `User` and `UserProfile` and a review of every migration. Per-ride (not per-customer): `RideOtp.rideId` with no customer column, `expiresAt`, `verified`, and generation inside `acceptRideRequest`. Six digits: `RIDE_OTP_LENGTH = 6` and a test asserting `/^\d{6}$/`. Driver exposure: the `Promise<{ ride; plaintextOtp }>` signature, `reply.send({ data: result })` on a `requireOperableDriver` route, and an integration test that consumes `data.plaintextOtp` and starts the ride with it. No bypass: enumeration of every `IN_PROGRESS` reference in `src/`, a zero-caller grep on `updateStatus`, an `export {};` admin module, jobs touching only `RideRequest`, and no raw `UPDATE "rides"`. No customer channel: bare `findFirst` in the customer read paths, no ride-event consumer in notifications, `sendOtp` called only by auth, and a stub socket plugin.

---

## Decision Pending

Implementation decision is intentionally deferred until this verification report is reviewed.
