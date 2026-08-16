# Customer Constant 4-Digit Ride PIN — Verification Report

## 1. Verification Scope

Single question: **does the existing codebase implement a per-customer, permanent 4-digit Ride PIN** — one code owned by the customer, unchanged across rides, spoken to the driver at pickup, and verified by the backend against `ride.customerId` before the ride may start?

This is a discovery and verification pass only. No source file was modified, no feature was implemented, no defect was fixed.

Scope covered: Prisma schema (all 15 module files), all migrations, ride/user/auth/driver/notification modules, routes, controllers, services, repositories, schemas, validators, events, jobs, seeds, config, tests, and the `docs/` tree including the two prior audit reports.

Prior modules verified in this audit series: `auth`, `users`.

---

## 2. Repository Search Results

All searches run over `src/`, `tests/`, `prisma/`, `scripts/`, `docs/`, excluding `node_modules/` and `dist/`.

### 2.1 PIN-family terms

| Term (all case variants)                                            | Hits in code (`.ts`/`.prisma`/`.sql`) | Hits in docs                                                                               |
| ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ridePin` / `ride_pin` / `ridePIN`                                  | **0**                                 | 0                                                                                          |
| `customerPin` / `customer_pin`                                      | **0**                                 | 0                                                                                          |
| `tripPin` / `trip_pin`                                              | **0**                                 | 0                                                                                          |
| `startPin` / `start_pin`                                            | **0**                                 | 0                                                                                          |
| `bookingPin` / `booking_pin`                                        | **0**                                 | 0                                                                                          |
| `securityPin` / `security_pin`                                      | **0**                                 | 0                                                                                          |
| bare `pin` (word-boundary, excluding `pinned`/`pino`/`pipe`/`spin`) | **0**                                 | 1 — `docs/03_Requirements/01_srs-functional.md:41`, "map pin" (a UI map marker, unrelated) |

A word-boundary regex for `\bpin\b|4-digit|4 digit|four-digit` across `src/`, `prisma/`, `tests/`, `scripts/` returned **zero matches**. There is no PIN concept anywhere in the codebase under any spelling.

### 2.2 OTP-family terms — what does exist

| Term                                     | Result                                                             |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `rideOtp` / `ride_otp` / `RideOtp`       | **Present** — a full per-ride OTP subsystem                        |
| `startOtp` / `START` purpose             | **Present** — `RideOtpService.generateStartOtp` / `verifyStartOtp` |
| `tripOtp` / `trip_otp`                   | 0 (the domain noun in this codebase is "ride", not "trip")         |
| `verificationCode` / `verification_code` | 0                                                                  |
| `otpVerifications`                       | **Present** — auth-side OTP audit trail (separate system)          |

### 2.3 Files carrying the relevant implementation

| File                                                                                                                   | Role                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [prisma/schema/modules/ride/ride.prisma](prisma/schema/modules/ride/ride.prisma)                                       | `RideOtp` model (per-ride)               |
| [prisma/migrations/20260724173304_init/migration.sql:1674](prisma/migrations/20260724173304_init/migration.sql#L1674)  | `ride_otps` table creation               |
| [src/modules/rides/utils/otp.util.ts](src/modules/rides/utils/otp.util.ts)                                             | `generateRideOtp()`                      |
| [src/modules/rides/services/otp/ride-otp.service.ts](src/modules/rides/services/otp/ride-otp.service.ts)               | Generate + verify                        |
| [src/modules/rides/repositories/ride-otp.repository.ts](src/modules/rides/repositories/ride-otp.repository.ts)         | Atomic attempt/verify claims             |
| [src/modules/rides/services/lifecycle/lifecycle.service.ts](src/modules/rides/services/lifecycle/lifecycle.service.ts) | `acceptRideRequest`, `startRide`         |
| [src/modules/rides/controllers/ride-state.controller.ts](src/modules/rides/controllers/ride-state.controller.ts)       | HTTP handlers                            |
| [src/modules/rides/routes/ride.routes.ts](src/modules/rides/routes/ride.routes.ts)                                     | Route table                              |
| [src/modules/rides/constants/ride.constants.ts](src/modules/rides/constants/ride.constants.ts)                         | `RIDE_OTP_LENGTH = 6`, TTL, max attempts |
| [src/modules/auth/services/otp/otp.hasher.ts](src/modules/auth/services/otp/otp.hasher.ts)                             | HMAC-SHA256 hasher, shared               |
| [tests/unit/rides/ride-otp.test.ts](tests/unit/rides/ride-otp.test.ts)                                                 | 8 unit tests                             |

### 2.4 Semantic searches

- "customer verification before ride start" → only the per-ride OTP path.
- "driver verifies customer" → `POST /api/v1/rides/:id/start` with `otpCode`.
- "PIN generated for customer" / "PIN assigned to customer" / "PIN stored against user" → **nothing**. No code generates, stores, or reads any long-lived code against a `User`.
- Notification delivery of a ride code → **nothing**. `src/modules/notifications/` has no consumers directory and no ride-event subscriber (§6).

---

## 3. Database Evidence

### 3.1 User-side tables — no PIN

`User` ([prisma/schema/modules/user/user.prisma](prisma/schema/modules/user/user.prisma)) scalar columns in full:

`id`, `phoneNumber`, `email`, `passwordHash`, `status`, `isPhoneVerified`, `isEmailVerified`, `lastLoginAt`, `createdAt`, `updatedAt`, `deletedAt`.

`UserProfile` scalar columns in full:

`id`, `userId`, `firstName`, `lastName`, `dateOfBirth`, `gender`, `profileImageFileId`, `languageCode`, `referralCode`, `createdAt`, `updatedAt`.

Neither carries a PIN, PIN hash, or PIN digest. There is no `CustomerSecurity`, `UserPin`, `CustomerPin`, or equivalent table anywhere in the 15 schema module directories.

### 3.2 The one code table on the ride side

```prisma
model RideOtp {
  id         String    @id @default(uuid(7)) @db.Uuid
  rideId     String    @map("ride_id") @db.Uuid      // ← per RIDE, not per customer
  otpHash    String    @map("otp_hash")
  purpose    String    @default("START")
  attempts   Int       @default(0) @db.SmallInt
  verified   Boolean   @default(false)
  verifiedAt DateTime? @map("verified_at")
  expiresAt  DateTime  @map("expires_at")            // ← expiring, therefore not constant
  createdAt  DateTime  @default(now()) @map("created_at")

  ride Ride @relation(fields: [rideId], references: [id])

  @@index([rideId])
  @@map("ride_otps")
}
```

No `customerId` column. No `userId` column. The link to a customer is transitive only: `ride_otps.ride_id → rides.id → rides.customer_id`.

### 3.3 Answers to the ten Phase 2 questions

| #   | Question                             | Answer                                                                                                                                                          |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does `User` contain a PIN?           | **No**                                                                                                                                                          |
| 2   | Does `UserProfile` contain a PIN?    | **No**                                                                                                                                                          |
| 3   | Separate CustomerSecurity/PIN table? | **No**                                                                                                                                                          |
| 4   | Is there a Ride PIN table?           | Only `ride_otps` — a _per-ride expiring OTP_, not a PIN                                                                                                         |
| 5   | Stored per customer or per ride?     | **Per ride** (`ride_otps.ride_id`, FK to `rides`)                                                                                                               |
| 6   | Plaintext or hashed?                 | **Hashed** — HMAC-SHA256 with a server pepper                                                                                                                   |
| 7   | Unique constraint?                   | **None** on the code. Only the PK on `id`                                                                                                                       |
| 8   | Index?                               | `ride_otps_ride_id_idx` on `ride_id` ([migration.sql:2880](prisma/migrations/20260724173304_init/migration.sql#L2880))                                          |
| 9   | Audit/history record?                | Rows are retained with `attempts`/`verified`/`verifiedAt`; ride state changes are separately recorded in `ride_status_events`. No dedicated PIN-history table   |
| 10  | Migration creating it?               | Yes — `ride_otps` in [20260724173304_init](prisma/migrations/20260724173304_init/migration.sql#L1674). **No migration anywhere adds a PIN column to any table** |

### 3.4 Required Phase 2 table

| Location            | Field/Table        | Type                     | Per Customer or Per Ride | Evidence                                                                                                            |
| ------------------- | ------------------ | ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `users`             | —                  | —                        | —                        | No PIN column exists ([user.prisma](prisma/schema/modules/user/user.prisma))                                        |
| `user_profiles`     | —                  | —                        | —                        | No PIN column exists ([user.prisma](prisma/schema/modules/user/user.prisma))                                        |
| `ride_otps`         | `otp_hash`         | `TEXT` (HMAC-SHA256 hex) | **Per Ride**             | [ride.prisma](prisma/schema/modules/ride/ride.prisma) `RideOtp.rideId`                                              |
| `ride_otps`         | `expires_at`       | `TIMESTAMP`              | Per Ride                 | 15-minute TTL — a constant PIN would not expire                                                                     |
| `ride_otps`         | `attempts`         | `SMALLINT`               | Per Ride                 | Cap enforced per OTP row, not per customer                                                                          |
| `otp_verifications` | _(no hash column)_ | —                        | Per phone number         | Auth-side audit trail only; secret lives in Redis ([auth.prisma:74-75](prisma/schema/modules/auth/auth.prisma#L74)) |

---

## 4. PIN Generation

**No customer PIN is generated anywhere.** There is no code path — registration, first login, customer creation, first ride, admin action, or external service — that assigns a durable code to a `User`.

What exists instead, for completeness:

### 4.1 Ride OTP generation

[src/modules/rides/utils/otp.util.ts](src/modules/rides/utils/otp.util.ts):

```ts
export function generateRideOtp(): string {
  let code = '';
  for (let i = 0; i < RIDE_OTP_LENGTH; i += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
}
```

| Property                        | Actual implementation                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When generated**              | Inside `LifecycleService.acceptRideRequest` — the moment a driver accepts, in the same transaction that creates the `Ride` ([lifecycle.service.ts:137](src/modules/rides/services/lifecycle/lifecycle.service.ts#L137)) |
| **Length**                      | **6 digits**, not 4. `RIDE_OTP_LENGTH = 6` ([ride.constants.ts:31](src/modules/rides/constants/ride.constants.ts#L31))                                                                                                  |
| **Randomness**                  | Cryptographically secure — `randomInt` from `node:crypto`, one draw per digit                                                                                                                                           |
| **Leading zero**                | **Yes**, possible. Each digit is drawn independently from `[0,10)`. Explicitly tested                                                                                                                                   |
| **Duplicates across customers** | Permitted and expected — there is no uniqueness constraint, and none is needed for a per-ride code scoped by `rideId`                                                                                                   |
| **Regenerated**                 | Per ride. A new `RideOtp` row per accepted ride. No customer-facing regeneration endpoint                                                                                                                               |
| **Customer can change it**      | **No** — no endpoint exists                                                                                                                                                                                             |
| **Customer can reset it**       | **No** — no endpoint exists                                                                                                                                                                                             |
| **Lifetime**                    | 15 minutes (`RIDE_OTP_TTL_MINUTES = 15`)                                                                                                                                                                                |

Note: the "4-digit" phrasing in the requirement does appear in this repository's history — [docs/PRODUCTION_READINESS_AUDIT.md:819](docs/PRODUCTION_READINESS_AUDIT.md#L819) records that `generateRideOtp` once produced a 4-digit code via `randomInt(1000, 9999)`. It was **hardened to 6 digits** and re-hashed as part of finding P1-1. That historical 4-digit code was still **per-ride**, never per-customer.

---

## 5. PIN Storage

No customer PIN is stored. Storage of the per-ride OTP:

**Hashed**, via the shared auth hasher ([src/modules/auth/services/otp/otp.hasher.ts](src/modules/auth/services/otp/otp.hasher.ts)):

```ts
hash(code: string): string {
  return createHmac('sha256', this.pepper).update(code).digest('hex');
}
```

Written at [ride-otp.service.ts:25](src/modules/rides/services/otp/ride-otp.service.ts#L25) as `otpHash: this.otpHasher.hash(plaintextOtp)`. The plaintext is never persisted.

**Security assessment of the current mechanism (reporting only, no redesign):**

- The pepper is a server-side secret held outside the database (`OtpConfig.pepper`). An attacker with only a database dump cannot build a lookup table without also obtaining the pepper — this is materially stronger than a bare hash and is the correct control for a small keyspace.
- The keyspace is 10⁶ (1,000,000) for the current 6-digit code, not 10⁴. **If the product moves to a 4-digit constant PIN, the keyspace collapses to 10,000 and — critically — the value becomes permanent.** A permanent secret changes the threat model entirely: pepper compromise would expose every customer's PIN indefinitely, and a leaked PIN never rotates. The current per-ride, 15-minute, single-use design bounds that exposure to one ride.
- Comparison is `this.otpHasher.hash(plaintextOtp) !== latestOtp.otpHash` ([ride-otp.service.ts:53](src/modules/rides/services/otp/ride-otp.service.ts#L53)) — a plain string `!==`, not `crypto.timingSafeEqual`. Both operands are 64-char hex digests of a peppered HMAC, so the timing channel leaks nothing an attacker can steer without the pepper. Noted for completeness; not exploitable as written.
- There is no PIN history/rotation table, which is expected for a per-ride code and would be a gap for a rotatable customer PIN.

---

## 6. Customer PIN Access

**The customer has no PIN, and — more surprisingly — no way to obtain even the per-ride OTP.**

Every customer-facing ride route was traced ([ride.routes.ts](src/modules/rides/routes/ride.routes.ts)):

| Route                           | Handler                                                           | Returns any code?                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/rides/active`      | `RideQueryController.getActive` → `rideRepo.findActiveByCustomer` | **No** — bare `ride.findFirst`, no `otps` include                                                                                                                  |
| `GET /api/v1/rides/:id`         | `RideQueryController.getById` → `rideRepo.findById`               | **No** — includes `fare`, `cancellation`, `statusEvents`, `driver.userId` only ([ride.repository.ts:70-82](src/modules/rides/repositories/ride.repository.ts#L70)) |
| `GET /api/v1/rides/history`     | `listCustomerRides`                                               | **No** — includes `fare` only                                                                                                                                      |
| `GET /api/v1/rides/:id/receipt` | `ReceiptService`                                                  | **No**                                                                                                                                                             |

User-module routes (`/me`, profile, etc.) were searched for any PIN or OTP field — none exists.

**No out-of-band delivery either.** The `ride.accepted` event carries only `{ rideId, driverId }` ([lifecycle.service.ts:151-156](src/modules/rides/services/lifecycle/lifecycle.service.ts#L151)) — no code. `src/modules/notifications/` contains `notification.config.ts`, `notification.service.ts`, and `providers/` — and **no consumer subscribes to any `ride.*` event**. A grep for `ride.` across `src/modules/notifications/` and `src/jobs/consumers/` returns zero hits. No websocket handler emits an OTP (`src/plugins/socket/`, `src/core/websocket/` — zero hits for `otp`).

**Where the plaintext code actually goes:** to the **driver**, in the HTTP response to `POST /api/v1/rides/accept`.

```ts
// lifecycle.service.ts:158
return { ride, plaintextOtp };

// ride-state.controller.ts:36 — driverOnly route
reply.send({ data: result }); // data.plaintextOtp reaches the driver
```

Confirmed by the integration test, which reads the code straight out of the driver's own accept response and replays it into `/start`:

```ts
// tests/integration/earnings-pipeline.test.ts:89-90
const rideId = accepted.json().data.ride.id;
const otpCode = accepted.json().data.plaintextOtp;
```

This is the single most consequential finding in this report — see §17, CRITICAL-1.

**Logging:** no `log` call in the rides module writes `plaintextOtp`. The code is not logged; it is _returned in an API response body_ to the wrong party, which is worse.

---

## 7. Ride Creation Relationship

Flow traced end to end:

1. Customer → `POST /api/v1/rides/requests` → `RideRequest` row with `customerId`.
2. Driver → `POST /api/v1/rides/accept` → `LifecycleService.acceptRideRequest`, inside one transaction:
   - locks + conditionally claims the request (`claimForMatch`),
   - creates the `Ride`, copying `customerId` from `request.customerId` ([lifecycle.service.ts:123](src/modules/rides/services/lifecycle/lifecycle.service.ts#L123)),
   - calls `generateStartOtp(ride.id, tx)` — keyed on `ride.id` **only**.

**Classification of the linkage:**

| Possibility                                            | Actual                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Code copied into the `Ride` record                     | **No** — `Ride` has no OTP/PIN column                                                |
| Code referenced through `customerId`                   | **No** — `RideOtp` has no customer column and the generator never reads the customer |
| Code retrieved from `User` at verification time        | **No** — `User` has no code to retrieve                                              |
| Code stored in a per-ride side table keyed on `rideId` | **Yes** — this is the implementation                                                 |

The `Ride` correctly references the customer (`rides.customer_id`, FK to `users`, indexed). That relationship is sound and is what a future per-customer PIN lookup would traverse. It is simply not used for code verification today.

---

## 8. Driver Verification

The endpoint exists and is well-built — for a per-ride OTP.

**Endpoint:** `POST /api/v1/rides/:id/start`

| Aspect                    | Implementation                                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Route**                 | [ride.routes.ts:21](src/modules/rides/routes/ride.routes.ts#L21)                                                                                                                                                                                                      |
| **Request body**          | `{ otpCode: string }` — `z.string().length(RIDE_OTP_LENGTH)`, i.e. **exactly 6 characters** ([ride.schemas.ts:36](src/modules/rides/schemas/ride.schemas.ts#L36)). Note: length-checked, not digit-checked; `"abcdef"` passes validation and fails at hash comparison |
| **Authentication**        | Global `denyByDefault` `onRequest` hook + JWT. `tests/integration/route-graph.test.ts` asserts every `/api/v1/rides` route rejects unauthenticated callers                                                                                                            |
| **Authorization**         | `fastify.authorize({ requireOperableDriver: true })` — caller must be an operable driver; fails closed on lookup error ([auth.plugin.ts:106-120](src/modules/auth/plugins/auth.plugin.ts#L106))                                                                       |
| **Actor resolution**      | `actingDriverId(req)` maps the JWT user id → `Driver.id` via `driverRepository.findByUserId`                                                                                                                                                                          |
| **Ride ownership**        | `lockAndValidate` throws `RideDriverMismatchError` unless `ride.driverId === actor.driverId` ([lifecycle.service.ts:91](src/modules/rides/services/lifecycle/lifecycle.service.ts#L91))                                                                               |
| **Code lookup**           | `otpRepo.findLatestByRideId(rideId)` — `where: { rideId, verified: false }`, newest first                                                                                                                                                                             |
| **Comparison**            | HMAC digest equality (§5)                                                                                                                                                                                                                                             |
| **Expiry check**          | `expiresAt <= now` → `OtpVerificationError('OTP has expired')`                                                                                                                                                                                                        |
| **Attempt limit**         | `claimAttempt(id, RIDE_OTP_MAX_ATTEMPTS = 5)` — a **conditional `updateMany`** (`attempts < max`), atomic, race-safe                                                                                                                                                  |
| **Replay protection**     | `claimVerification(id)` — conditional `updateMany` on `verified: false`; a second use of the same code fails                                                                                                                                                          |
| **Ride-state validation** | `validateTransition(ride.status, 'IN_PROGRESS')` — only `DRIVER_ARRIVED → IN_PROGRESS` is permitted                                                                                                                                                                   |
| **Row lock**              | `SELECT … FOR UPDATE` on the ride before validation ([ride.repository.ts:27](src/modules/rides/repositories/ride.repository.ts#L27))                                                                                                                                  |
| **Transaction**           | The whole verification + status change + event publish runs inside `txManager.execute`                                                                                                                                                                                |
| **State transition**      | `updateStatusIf(rideId, expected, 'IN_PROGRESS', { startedAt })` — compare-and-swap; returns false → `InvalidRideStateTransitionError`                                                                                                                                |
| **Rate limiting (HTTP)**  | **None.** `/:id/start` carries no `fastify.rateLimit(...)`. Only `/requests` and `/:id/cancel` do                                                                                                                                                                     |

The mechanics here are genuinely solid. The defect is not in the verification machinery — it is that the secret being verified was handed to the party doing the verifying (§6).

---

## 9. Customer-to-Ride Binding

**Verdict: correctly bound — by construction, not by an explicit customer check.**

The security scenario in the brief — _driver assigned to Customer A submits Customer B's valid code_ — is **rejected**, for this reason:

- The lookup is `findLatestByRideId(rideId, …)` where `rideId` comes from the URL path.
- `lockAndValidate` has already proven `ride.driverId === callerDriverId`, so `rideId` cannot be a ride the caller is not assigned to.
- The `ride_otps` row set is partitioned by `ride_id`. Customer B's code lives on Customer B's ride and is unreachable from Customer A's `rideId`.

So the effective check is `submittedCode == code(ride)` where `ride` is bound to exactly one `customerId`. That is _stronger_ per-ride isolation than `submittedPin == pin(ride.customerId)` would be, and it structurally cannot be satisfied by another customer's code.

**Caveat for the target design.** The relationship the brief asks about — `Ride → customerId → Customer → customerRidePin → compare` — **does not exist in code**. `RideOtpService` never reads `ride.customerId`; it never loads a `User`. If a per-customer constant PIN is later introduced, this binding must be written from scratch. Nothing in the current implementation can be reused as the customer-binding step, and a naive implementation that looks the PIN up by "any customer with this PIN" would be the exact vulnerability the brief warns about. The correct traversal (`ride.customerId → user.ridePinHash`) is available — `rides.customer_id` exists, is a real FK, and is indexed — but is presently unused for verification.

---

## 10. Ride Start State Machine

Real state names from [ride.constants.ts:1-14](src/modules/rides/constants/ride.constants.ts#L1) and the `RideStatus` enum:

`REQUESTED`, `SEARCHING`, `ACCEPTED`, `DRIVER_ARRIVING`, `DRIVER_ARRIVED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_DRIVER`, `CANCELLED_BY_SYSTEM`, `NO_DRIVERS_FOUND`.

Actual transition table ([lifecycle.service.ts:25-49](src/modules/rides/services/lifecycle/lifecycle.service.ts#L25)):

```
ACCEPTED         → DRIVER_ARRIVING, DRIVER_ARRIVED, CANCELLED_BY_{CUSTOMER,DRIVER,SYSTEM}
DRIVER_ARRIVING  → DRIVER_ARRIVED, CANCELLED_BY_{CUSTOMER,DRIVER,SYSTEM}
DRIVER_ARRIVED   → IN_PROGRESS, CANCELLED_BY_{CUSTOMER,DRIVER,SYSTEM}
IN_PROGRESS      → COMPLETED, CANCELLED_BY_SYSTEM
COMPLETED / CANCELLED_* / NO_DRIVERS_FOUND → (terminal)
```

**The state immediately before code verification is `DRIVER_ARRIVED`.** It is the _only_ predecessor of `IN_PROGRESS` — `ACCEPTED → IN_PROGRESS` and `DRIVER_ARRIVING → IN_PROGRESS` are both absent from the table, so a driver cannot skip the arrival step.

Code verification is **structurally mandatory** on the only path into the active state: `startRide` calls `verifyStartOtp` before `updateStatusIf`, and a thrown `OtpVerificationError` aborts the enclosing transaction. There is no `if (config.requireStartOtp)` guard around it (see §11, HIGH-1 — a config flag for exactly this exists but is never read; the code is unconditional, which is the safe outcome).

A `Ride` is created directly in `ACCEPTED` (`@default(ACCEPTED)`, and the raw `INSERT` hard-codes `'ACCEPTED'::"RideStatus"`), so the earlier `REQUESTED`/`SEARCHING` names apply to `RideRequest`, not to `Ride`.

---

## 11. Possible PIN Bypass Paths

Every reference to `IN_PROGRESS` in `src/` was enumerated and each classified.

| Start Path               | Endpoint/Function                                             | PIN Required?                                                                                                            | Evidence                                                                                       |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Driver starts ride       | `POST /api/v1/rides/:id/start` → `LifecycleService.startRide` | **Yes** — `verifyStartOtp` before `updateStatusIf`, same transaction                                                     | [lifecycle.service.ts:204-241](src/modules/rides/services/lifecycle/lifecycle.service.ts#L204) |
| Driver arrival           | `POST /:id/arrive` → `markDriverArrived`                      | N/A — target is `DRIVER_ARRIVED`, cannot reach `IN_PROGRESS`                                                             | [lifecycle.service.ts:161](src/modules/rides/services/lifecycle/lifecycle.service.ts#L161)     |
| Driver accepts           | `POST /accept` → `acceptRideRequest`                          | N/A — creates ride in `ACCEPTED`                                                                                         | [lifecycle.service.ts:105](src/modules/rides/services/lifecycle/lifecycle.service.ts#L105)     |
| Complete                 | `POST /:id/complete`                                          | N/A — requires `IN_PROGRESS` as the _source_ state                                                                       | [lifecycle.service.ts:243](src/modules/rides/services/lifecycle/lifecycle.service.ts#L243)     |
| Admin override           | —                                                             | **No such path** — `src/modules/admin/index.ts` is `export {};`, a stub with no routes                                   | [src/modules/admin/index.ts](src/modules/admin/index.ts)                                       |
| Background jobs          | `dispatch-timeout.job.ts`, `request-expiry.job.ts`            | **No such path** — only touch `RideRequest` status (`CREATED`/`SEARCHING` → `EXPIRED`)                                   | [request-expiry.job.ts:21-29](src/modules/rides/jobs/request-expiry.job.ts#L21)                |
| Unconditional repo write | `RideRepository.updateStatus` (no CAS, no code check)         | **N/A — dead code.** A grep for `updateStatus(` across `src/` and `tests/` finds **zero callers** on the ride repository | [ride.repository.ts:114](src/modules/rides/repositories/ride.repository.ts#L114)               |
| Raw SQL                  | —                                                             | **None** — no `UPDATE "rides"` statement exists anywhere in `src/` or `prisma/`                                          | grep: 0 hits                                                                                   |
| Prisma extension         | `RideExtensions.ts`                                           | Read-only — `findMany({ where: { status: 'IN_PROGRESS' } })`                                                             | [RideExtensions.ts:11](src/core/database/extensions/RideExtensions.ts#L11)                     |

**Conclusion: there is exactly one code path into `IN_PROGRESS`, and it verifies the code.** No bypass exists at the state-machine level.

**But the practical bypass is total, and it is not a state-machine problem.** The driver is given the plaintext code in the accept response (§6) and can replay it into `/start` without ever speaking to the customer — as the integration test demonstrates in three lines. Verification is enforced; it is simply not a _proof of anything_, because both sides of the check are held by one party.

One latent gap worth recording: `RideRepository.updateStatus` is an unconditional, uncheckable status write with no callers. It is not a live bypass today, but it is a loaded footgun sitting one import away from the verification boundary.

---

## 12. Brute Force / Rate Limiting

| Control                        | Present     | Detail                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Max attempts per code          | **Yes**     | `RIDE_OTP_MAX_ATTEMPTS = 5`                                                                                                                                                                                                                                                                      |
| Atomic attempt counter         | **Yes**     | `claimAttempt` — `updateMany` with `attempts: { lt: maxAttempts }` in the `WHERE`; increments and gate-checks in one statement. Not read-then-write                                                                                                                                              |
| Race-safety proven             | **Yes**     | Test fires 50 parallel guesses; asserts `attempts === RIDE_OTP_MAX_ATTEMPTS` exactly                                                                                                                                                                                                             |
| Single-use enforcement         | **Yes**     | `claimVerification` — conditional `updateMany` on `verified: false`                                                                                                                                                                                                                              |
| Expiry                         | **Yes**     | 15 minutes                                                                                                                                                                                                                                                                                       |
| Lockout after cap              | **Partial** | The _code_ is locked (all further attempts throw). No new code can be issued for that ride — `generateStartOtp` is only ever called from `acceptRideRequest`, so a capped-out ride is **unstartable** and must be cancelled. A denial-of-service on the ride itself, not a security hole         |
| HTTP rate limiting on `/start` | **No**      | No `fastify.rateLimit` on the route. `rateLimits.rideWrite` (60/hour, keyed by user) exists in [rate-limit.config.ts:47](src/config/rate-limit/rate-limit.config.ts#L47) and is applied to `/requests` and `/:id/cancel` — **not** to `/accept`, `/:id/arrive`, `/:id/start`, or `/:id/complete` |
| Driver-level rate limiting     | **No**      | A driver may burn 5 attempts on ride A, then 5 on ride B, with no cross-ride tracking                                                                                                                                                                                                            |
| Redis counter                  | **No**      | Attempt state is in Postgres. Redis is used for auth OTP, not ride OTP                                                                                                                                                                                                                           |
| Failure metric emitted         | **No**      | `RideMetrics.otpFailure()` is **defined but never called** — a grep finds the definition at [ride.metrics.ts:35](src/modules/rides/metrics/ride.metrics.ts#L35) and zero call sites. Failed verifications are invisible to monitoring                                                            |

**Keyspace arithmetic.** Against the current 6-digit code with a 5-attempt cap, a blind attacker has a 5/1,000,000 chance per ride — negligible. **Against a 4-digit constant PIN the same 5-attempt cap gives 5/10,000 per ride, and — because the PIN never changes — the attempts accumulate across every ride that customer ever takes.** A driver who repeatedly matches with the same customer, or a colluding fleet, converges on the PIN. With no cross-ride attempt tracking and no rate limit on `/start`, the current controls would not bound that. This is the central security consequence of the constant-PIN design and must be sized before implementation, not after.

---

## 13. Constant PIN vs Ride-Specific OTP

**Classification: B — RIDE-SPECIFIC OTP.**

The implemented behaviour is:

```
Customer A, Ride 1 → 482913
Customer A, Ride 2 → 730154   (different code, new row, new 15-min window)
Customer A, Ride 3 → 019287   (different again)
```

Not A (constant customer PIN). Not C (something does exist). Not D (the ride-OTP flow is complete and tested end to end over real HTTP — it is not a half-built PIN).

Determining evidence:

| Requirement of a constant customer PIN | Implementation                                | Match  |
| -------------------------------------- | --------------------------------------------- | ------ |
| Stored against the customer            | Stored against `ride_otps.ride_id`            | **No** |
| Same value across rides                | New random value per `acceptRideRequest`      | **No** |
| Never expires                          | `expiresAt` = now + 15 min                    | **No** |
| Exactly 4 digits                       | `RIDE_OTP_LENGTH = 6`                         | **No** |
| Reusable                               | `verified` flag makes it strictly single-use  | **No** |
| Customer can retrieve it               | No endpoint, no notification, no socket event | **No** |
| Regeneration/change mechanism          | None (and none needed for a per-ride code)    | **No** |

Zero of seven. The two designs share only the phrase "code the driver types in".

For the record, this matches the **documented** product requirement, which also specifies a per-trip OTP rather than a constant PIN:

- `FR-TRIP-02` — "The system SHALL require pickup verification (OTP) before a trip transitions to in-progress" ([docs/03_Requirements/01_srs-functional.md:62](docs/03_Requirements/01_srs-functional.md#L62))
- `R-TRIP-2` — "Pickup OTP prevents wrong-rider trips — a Must" ([docs/02_Product/01_prd.md:85](docs/02_Product/01_prd.md#L85))
- `US-TRIP-02` — "As a rider/driver I want a pickup OTP so that the right rider gets the right car" ([docs/02_Product/02_user-stories.md:124](docs/02_Product/02_user-stories.md#L124))

**A per-customer constant Ride PIN appears in no requirement, PRD, user story, ADR, traceability row, or API document in this repository.** It is a new product concept relative to everything currently written down.

---

## 14. Existing OTP Systems

Three distinct code systems exist. They are correctly kept separate in code, and this report does not conflate them.

| Code Type                                | Purpose                                                        | Lifetime                                                                                                                 | Owner                                   | Used By                                                                             |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------- |
| **Auth OTP** (`LOGIN`, `REGISTER`)       | Prove control of a phone number to authenticate                | Short TTL; secret is **Redis-only**, never in Postgres ([auth.prisma:74-75](prisma/schema/modules/auth/auth.prisma#L74)) | Phone number (`User` may not exist yet) | `POST /auth/otp/send`, `/auth/otp/verify`. Rate-limited via `OtpRateLimiter`        |
| **Phone-change OTP** (`PHONE_CHANGE`)    | Prove control of a **new** number before rebinding an account  | Short TTL, Redis-only, **purpose-scoped Redis key** so it cannot be replayed against `/auth/otp/verify` to log in        | Existing `User`                         | [phone-change.service.ts](src/modules/users/services/phone/phone-change.service.ts) |
| **Ride start OTP** (`purpose = 'START'`) | Prove the right rider is in the right car before `IN_PROGRESS` | **15 min**, single-use, stored **hashed in Postgres** (`ride_otps`)                                                      | **A `Ride`** — not a customer           | `POST /api/v1/rides/:id/start`                                                      |
| **Customer constant Ride PIN**           | _(the requirement under verification)_                         | —                                                                                                                        | —                                       | **DOES NOT EXIST**                                                                  |

`otp_verifications` (auth side) deliberately holds **no** `otp_hash` column — it is a purgeable fraud/audit trail (R-AUTH-22/26/30), with the secret in Redis. `ride_otps` takes the opposite approach: hash in Postgres, no Redis. Both are deliberate and documented; they are not duplicates of each other. The only shared component is `OtpHasher`, reused by rides after audit finding P1-1.

---

## 15. Test Coverage

Ride-code tests: [tests/unit/rides/ride-otp.test.ts](tests/unit/rides/ride-otp.test.ts) (8 tests), [tests/unit/rides/ride-state-machine.test.ts](tests/unit/rides/ride-state-machine.test.ts), [tests/unit/rides/ride-lifecycle-concurrency.test.ts](tests/unit/rides/ride-lifecycle-concurrency.test.ts), and the HTTP path in [tests/integration/earnings-pipeline.test.ts](tests/integration/earnings-pipeline.test.ts).

| Test                                                 | File                               | Scenario                                     | Status                                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Generation — length & charset                        | `ride-otp.test.ts:39`              | Asserts `/^\d{6}$/`                          | **PASS (6-digit)** — actively contradicts a 4-digit requirement                                                                           |
| Generation — leading zero                            | `ride-otp.test.ts:45`              | 3,000 draws include one starting `0`         | PASS                                                                                                                                      |
| Storage — peppered hash                              | `ride-otp.test.ts:51`              | Digest ≠ bare SHA-256 of the code            | PASS                                                                                                                                      |
| Correct code accepted once                           | `ride-otp.test.ts:57`              | Second use rejected (replay)                 | PASS                                                                                                                                      |
| Expired code rejected                                | `ride-otp.test.ts:73`              | `expiresAt` in the past → error              | PASS                                                                                                                                      |
| Wrong code spends an attempt; cap holds              | `ride-otp.test.ts:86`              | 5 wrong guesses, then correct code refused   | PASS                                                                                                                                      |
| Parallel guesses cannot overrun cap                  | `ride-otp.test.ts:106`             | 50 concurrent → `attempts === 5` exactly     | PASS                                                                                                                                      |
| TTL bounded                                          | `ride-otp.test.ts:126`             | `RIDE_OTP_TTL_MINUTES <= 15`                 | PASS                                                                                                                                      |
| State machine — `DRIVER_ARRIVED → IN_PROGRESS` legal | `ride-state-machine.test.ts:23`    | Transition allowed                           | PASS                                                                                                                                      |
| State machine — `IN_PROGRESS → ACCEPTED` illegal     | `ride-state-machine.test.ts:35`    | Rejected                                     | PASS                                                                                                                                      |
| Full HTTP ride flow incl. `/start`                   | `earnings-pipeline.test.ts:81-106` | request → accept → arrive → start → complete | PASS                                                                                                                                      |
| **Wrong customer's code rejected**                   | —                                  | —                                            | **ABSENT** — no test submits customer B's code against customer A's ride                                                                  |
| **Code is withheld from the driver**                 | —                                  | —                                            | **ABSENT** — the integration test does the opposite: it _reads_ `plaintextOtp` from the driver's accept response (§6)                     |
| **Customer can retrieve the code**                   | —                                  | —                                            | **ABSENT** — no such endpoint to test                                                                                                     |
| **Bypass — start without a code**                    | —                                  | —                                            | **ABSENT** — no test asserts `/start` fails with a missing/omitted body                                                                   |
| **Driver authorization on `/start`**                 | —                                  | —                                            | **ABSENT at the OTP layer.** `RideDriverMismatchError` is covered generically in `authorization-bola.test.ts`, not specifically for start |
| **Constant PIN — generation / retrieval / rotation** | —                                  | —                                            | **N/A — nothing to test**                                                                                                                 |

Overall: the per-ride OTP mechanism is well tested. Coverage of the _trust model_ — who may hold the code — is absent, which is precisely why CRITICAL-1 went unnoticed.

---

## 16. Previous Audit Comparison

Both prior audits discuss a ride-start OTP. **Neither mentions a per-customer constant PIN — the concept does not appear in any previous audit.**

| Prior finding                                                                                                              | Where                                                                          | Then                                                 | Now                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| P1-1 — "Ride OTP is unsalted SHA-256 of a **4-digit** code … 9,000-entry rainbow table"                                    | [PRODUCTION_READINESS_AUDIT.md:819](docs/PRODUCTION_READINESS_AUDIT.md#L819)   | Bare `createHash('sha256')`, 4 digits, 1-hour expiry | **Fixed** — `OtpHasher` HMAC+pepper, **6 digits**, 15-min TTL             |
| P1-2 — "Ride OTP attempt limit is bypassable — read/check/increment non-atomic"                                            | [PRODUCTION_READINESS_AUDIT.md:821](docs/PRODUCTION_READINESS_AUDIT.md#L821)   | Non-atomic counter                                   | **Fixed** — `claimAttempt` conditional `updateMany`; 50-way parallel test |
| `randomInt(1000, 9999)` excluded its bound and could never emit a leading zero                                             | [PRODUCTION_HARDENING_REPORT.md:86](docs/PRODUCTION_HARDENING_REPORT.md#L86)   | Broken keyspace                                      | **Fixed** — per-digit `randomInt(0, 10)`                                  |
| "A ride could never be started over HTTP — `startRideSchema` required a **4-digit** `otpCode` while the generator emits 6" | [PRODUCTION_READINESS_GATE.md:207-209](docs/PRODUCTION_READINESS_GATE.md#L207) | Validation rejected every real code                  | **Fixed** — schema pins to `RIDE_OTP_LENGTH`                              |
| "Driver arrives → OTP → start ── PARTIAL, weak OTP"                                                                        | [PRODUCTION_READINESS_AUDIT.md:175](docs/PRODUCTION_READINESS_AUDIT.md#L175)   | Flagged weak                                         | Cryptographically hardened — **but the trust model was never audited**    |

**The important reading of this history:** the "4-digit" figure in the requirement under verification matches a code this repository _used to have_ — and that code was **per-ride, not per-customer**, and was deliberately widened to 6 digits on security grounds. Anyone reading the old audits could mistake P1-1's "4-digit code" for evidence that a 4-digit customer PIN once existed. It did not. Reverting to 4 digits would undo a fix that was made for a documented reason.

Equally important: **three separate prior audits examined this OTP subsystem and none observed that the plaintext code is returned to the driver** (§6, CRITICAL-1). They audited hashing, atomicity, keyspace, and schema length — every property of the code _as a secret_ — without asking who holds it.

---

## 17. Findings

### CRITICAL-1 — The ride start code is returned to the driver, defeating pickup verification entirely

`LifecycleService.acceptRideRequest` returns `plaintextOtp`, and `RideStateController.accept` sends it in the response body of the driver-only route `POST /api/v1/rides/accept`:

```ts
// lifecycle.service.ts:158
return { ride, plaintextOtp };

// ride-state.controller.ts:36  (route guarded by requireOperableDriver)
reply.send({ data: result });
```

The customer has no way to obtain the code (§6): no endpoint returns it, no notification carries it, no socket emits it, and the `ride.accepted` event payload is `{ rideId, driverId }`.

**Consequence:** the driver receives the code at accept time and can start the ride without the customer being present, without the customer consenting, and without ever meeting them. `tests/integration/earnings-pipeline.test.ts:89-106` performs exactly this sequence and passes. Every downstream control — the HMAC pepper, the 5-attempt cap, the single-use flag, the state machine — protects a secret that was already handed to the only party it is meant to constrain.

This nullifies `R-TRIP-2` / `FR-TRIP-02` ("prevents wrong-rider trips"). It also enables fare fraud: a driver can start and complete a ride with no rider, and `LedgerService.recordTripPayment` will book the fare and driver earning.

_Reported, not fixed, per scope._

### CRITICAL-2 — No per-customer constant 4-digit Ride PIN exists in any form

Zero occurrences of any PIN identifier across `src/`, `prisma/`, `tests/`, `scripts/`. No column on `users` or `user_profiles`. No PIN table. No migration. No generation, storage, retrieval, or verification code. No requirement, PRD entry, user story, or ADR describing one.

The requirement is **entirely unimplemented**. What exists is a different mechanism (per-ride expiring OTP) that superficially resembles it at the point of driver entry only.

### HIGH-1 — `rideConfig.requireStartOtp` is declared but never read

Defined at [ride.config.ts:16](src/config/ride/ride.config.ts#L16) and [:65](src/config/ride/ride.config.ts#L65) (`RIDE_REQUIRE_START_OTP !== 'false'`), and referenced **nowhere else in the codebase** — a repository-wide grep returns only those two lines.

Setting `RIDE_REQUIRE_START_OTP=false` in production would silently do nothing. The behaviour is safe (verification is unconditional), but the flag is a live operational trap: an operator will reasonably believe it works. It also signals that a conditional-verification path was contemplated — if it is ever wired up, it becomes a first-class bypass switch.

### HIGH-2 — No HTTP rate limiting on the ride lifecycle write routes

`/accept`, `/:id/arrive`, `/:id/start`, `/:id/complete` carry no `fastify.rateLimit`, while `/requests` and `/:id/cancel` do. `rateLimits.rideWrite` already exists and is unused on these routes.

Per-ride attempt caps bound guessing within one ride but nothing bounds attempts across rides. **Under the proposed constant-PIN design this becomes the primary attack surface**, since attempts against a permanent 4-digit secret accumulate over a customer's entire history (§12).

### MEDIUM-1 — Attempt exhaustion permanently bricks a ride

`generateStartOtp` is called only from `acceptRideRequest`. Once `attempts` reaches 5, `claimAttempt` returns false forever and there is no resend/regenerate path. A driver who fat-fingers the code five times cannot start the ride at all — the only exit is cancellation, with cancellation-fee and rating consequences for a legitimate rider.

### MEDIUM-2 — `RideMetrics.otpFailure()` is defined but never called

[ride.metrics.ts:35](src/modules/rides/metrics/ride.metrics.ts#L35), zero call sites. Failed verifications emit no telemetry, so a brute-force campaign or a systematic delivery failure would be invisible. Notably, this is the one metric that would have surfaced CRITICAL-1 in reverse — a _suspiciously low_ failure rate.

### MEDIUM-3 — `RideRepository.updateStatus` is an uncontrolled status write with no callers

[ride.repository.ts:114](src/modules/rides/repositories/ride.repository.ts#L114) writes any status with no compare-and-swap and no verification, unlike the `updateStatusIf` used everywhere else. Currently dead (§11), so not an active bypass — but it is an unguarded route into `IN_PROGRESS` sitting inside the same class as the guarded one.

### LOW-1 — `otpCode` is length-validated but not digit-validated

`z.string().length(RIDE_OTP_LENGTH)` ([ride.schemas.ts:36](src/modules/rides/schemas/ride.schemas.ts#L36)) accepts `"abcdef"`. Non-numeric input consumes an attempt and fails at hash comparison. Correct outcome, wasteful path, and it means malformed input is indistinguishable from a wrong guess in the attempt budget.

### LOW-2 — Digest comparison uses `!==` rather than `crypto.timingSafeEqual`

[ride-otp.service.ts:53](src/modules/rides/services/otp/ride-otp.service.ts#L53). Both operands are 64-char hex HMAC digests, so an attacker cannot steer the comparison without the pepper. Not exploitable as written; recorded because the same code would be reused for a constant PIN, where a permanent secret raises the value of any oracle.

### INFO-1 — The customer-binding traversal is available but unused

`rides.customer_id` is a real, indexed FK to `users`. A future `ride.customerId → user.ridePinHash` lookup has a sound path. Nothing in `RideOtpService` reads it today (§9).

### INFO-2 — The three existing OTP systems are correctly separated

Auth OTP (Redis-only), phone-change OTP (purpose-scoped Redis key), and ride-start OTP (hashed in Postgres) are distinct by design with documented rationale. The `PHONE_CHANGE` purpose-scoping in particular prevents cross-flow replay. Only `OtpHasher` is shared. No conflation issue was found.

### INFO-3 — The documented requirement is a per-trip OTP, not a constant PIN

`FR-TRIP-02`, `R-TRIP-2`, and `US-TRIP-02` all specify a **pickup OTP**. The implementation matches the written specification. The constant-PIN requirement under verification is a **new product concept** that no document in this repository currently describes.

---

## Final Verification Matrix

| Area                                   | Status      | Evidence                                                                                                                                                                                                    | Risk     |
| -------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Customer PIN exists                    | **FAIL**    | Zero hits for any PIN identifier across `src/`, `prisma/`, `tests/`, `scripts/`; no column on `users`/`user_profiles`; no table; no migration                                                               | CRITICAL |
| PIN is exactly 4 digits                | **FAIL**    | `RIDE_OTP_LENGTH = 6` ([ride.constants.ts:31](src/modules/rides/constants/ride.constants.ts#L31)); test asserts `/^\d{6}$/`. The 4-digit variant was deliberately removed by audit finding P1-1             | HIGH     |
| PIN is constant per customer           | **FAIL**    | `RideOtp.rideId` + 15-min `expiresAt` + single-use `verified` — a new code per ride                                                                                                                         | CRITICAL |
| PIN generation                         | **FAIL**    | No customer-PIN generator. `generateRideOtp` is per-ride, invoked from `acceptRideRequest`                                                                                                                  | CRITICAL |
| PIN storage                            | **PARTIAL** | No PIN store. The per-ride analogue is stored correctly — HMAC-SHA256 + server pepper ([otp.hasher.ts](src/modules/auth/services/otp/otp.hasher.ts))                                                        | MEDIUM   |
| Customer can retrieve PIN              | **FAIL**    | No endpoint, no notification consumer, no socket event, not in the `ride.accepted` payload. The customer cannot obtain even the per-ride code                                                               | CRITICAL |
| Ride references customer               | **PASS**    | `rides.customer_id` FK → `users`, indexed; copied from `request.customerId` at [lifecycle.service.ts:123](src/modules/rides/services/lifecycle/lifecycle.service.ts#L123)                                   | —        |
| Driver can submit PIN                  | **PARTIAL** | `POST /:id/start` accepts a 6-char `otpCode` with auth, driver-operability, and ride-ownership checks — but no PIN concept                                                                                  | MEDIUM   |
| PIN verified against `ride.customerId` | **PARTIAL** | Verification is scoped by `rideId`, which is itself bound to one `customerId` — so cross-customer replay is structurally impossible. The explicit `ride.customerId → customer PIN` traversal does not exist | HIGH     |
| PIN required before ride start         | **PARTIAL** | Code verification is unconditional on the only path into `IN_PROGRESS` — but it is a per-ride OTP, and the driver already holds it                                                                          | CRITICAL |
| No bypass path                         | **PARTIAL** | State machine is airtight — one path, verified, `DRIVER_ARRIVED → IN_PROGRESS` only, admin module is a stub, jobs touch requests only. **Practical bypass via CRITICAL-1 is total**                         | CRITICAL |
| Attempt protection                     | **PASS**    | `RIDE_OTP_MAX_ATTEMPTS = 5` via atomic `claimAttempt` conditional `updateMany`; proven under 50-way concurrency                                                                                             | LOW      |
| Rate limiting                          | **FAIL**    | No `fastify.rateLimit` on `/start` (or `/accept`, `/arrive`, `/complete`); no driver-level or cross-ride counter; `rateLimits.rideWrite` exists but is unapplied                                            | HIGH     |
| Tests                                  | **PARTIAL** | 8 solid OTP unit tests + state-machine + full HTTP flow. **No test for wrong-customer code, code withholding, missing-code start, or PIN constancy**                                                        | HIGH     |

---

## Final Conclusion

**1. Does a permanent 4-digit customer Ride PIN currently exist?**
**No.** Not in any form, under any name. Zero references across the entire repository. What exists is a **per-ride, 6-digit, 15-minute, single-use start OTP** — classification **B (ride-specific OTP)** per §13. Seven of seven defining properties of a constant customer PIN are absent.

**2. Where is it stored?**
Nowhere — there is no customer PIN. The per-ride OTP is stored as `ride_otps.otp_hash` (`TEXT`, HMAC-SHA256 hex), keyed on `ride_id`, indexed by `ride_otps_ride_id_idx`. Neither `users` nor `user_profiles` has any PIN column, and no migration ever added one.

**3. How is it generated?**
No customer PIN is generated. The ride OTP is generated by `generateRideOtp()` — six independent `randomInt(0, 10)` draws from `node:crypto`, cryptographically secure, leading zeros permitted, no uniqueness constraint — called from `LifecycleService.acceptRideRequest` inside the transaction that creates the `Ride`.

**4. How does the customer retrieve it?**
**They cannot.** This is a live defect, not merely a gap in the PIN feature. No endpoint returns the code, no notification consumer subscribes to `ride.accepted`, no socket emits it, and the event payload is `{ rideId, driverId }`. The customer is never told the code they are supposed to speak aloud.

**5. How does the driver submit it?**
`POST /api/v1/rides/:id/start` with `{ otpCode: string }`, guarded by JWT auth, `requireOperableDriver`, and a `ride.driverId` ownership check. **The driver already received the plaintext code in the response to `POST /api/v1/rides/accept` (CRITICAL-1)** and does not need the customer to supply it.

**6. How does the backend verify it?**
`RideOtpService.verifyStartOtp`: fetch newest unverified row for `rideId` → reject if expired → atomically claim an attempt (cap 5) → compare HMAC digests → atomically claim single-use verification. All inside the `startRide` transaction, after a `SELECT … FOR UPDATE` on the ride, before a compare-and-swap status write. The mechanism is well built.

**7. Is it tied specifically to `ride.customerId`?**
**Indirectly, and correctly — but not by design.** Lookup is scoped by `rideId`, and each ride has exactly one `customerId`, so customer B's code cannot satisfy customer A's ride. The attack in Phase 8 is structurally impossible today. However, the explicit `Ride → customerId → Customer → PIN` traversal **does not exist in code** and would have to be written from scratch.

**8. Is PIN verification mandatory before ride start?**
**Structurally yes; meaningfully no.** `DRIVER_ARRIVED → IN_PROGRESS` is the only transition into the active state, `startRide` is its only implementation, and `verifyStartOtp` runs unconditionally before the status write (the `requireStartOtp` config flag is never read — HIGH-1). But a check whose secret was handed to the checker proves nothing.

**9. Can a driver bypass verification?**
**No alternative endpoint exists — and none is needed.** Every path into `IN_PROGRESS` was enumerated (§11): one live path, verified; admin module is a stub; jobs touch only `RideRequest`; no raw SQL updates `rides`; `RideRepository.updateStatus` is dead code. **The driver bypasses verification simply by using the code handed to them at accept time.** The integration test demonstrates this in three lines.

**10. Is it protected against brute force?**
**Partially.** Per-code protection is genuinely good: atomic 5-attempt cap proven under 50-way concurrency, single-use, 15-minute expiry, peppered HMAC. Missing: HTTP rate limiting on `/start`, any driver-level or cross-ride attempt counter, Redis-backed throttling, and any failure metric (`otpFailure()` is defined and never called). Adequate for a 10⁶ per-ride keyspace; **inadequate for a 10⁴ permanent one**, where attempts accumulate across a customer's lifetime.

**11. What exactly is missing, if anything?**

Missing for the constant-PIN requirement — **everything**:

- A PIN column or table (`users.ridePinHash`, or a dedicated table) plus its migration
- Generation at customer creation, and backfill for existing customers
- A retrieval endpoint for the customer, with a masking/visibility policy
- A regeneration/reset mechanism and its abuse controls (the brief's "unless the product explicitly provides" clause)
- The `ride.customerId → customer PIN` verification traversal in `startRide`
- Cross-ride, per-customer brute-force accounting sized for a permanent 10,000-value keyspace
- Tests for constancy, wrong-customer rejection, rotation, and retrieval

Missing/broken in what already exists, independent of the PIN decision:

- **CRITICAL-1** — the plaintext start code is returned to the driver; the customer never receives it. This defeats `R-TRIP-2` today and would defeat a constant PIN identically if the delivery model is not fixed first.
- **HIGH-1** — `requireStartOtp` is dead config.
- **HIGH-2** — no rate limiting on lifecycle write routes.
- **MEDIUM-1/2/3** — no OTP resend (rides brick at 5 attempts), `otpFailure()` never emitted, dead unconditional `updateStatus`.
- Test gaps: wrong-customer code, code withholding, missing-code start.

**One observation for whoever reviews this.** CRITICAL-1 is independent of the PIN decision and is the more urgent item: whatever code the driver types — per-ride OTP or constant PIN — the flow is only meaningful if the customer holds the secret and the driver does not. Implementing a constant PIN on top of the current delivery model would reproduce the same failure with a permanently valuable secret instead of a 15-minute one. Also note that the requested 4-digit length would reverse a documented hardening fix (audit finding P1-1) that widened the code to 6 digits for keyspace reasons.

---

## Decision Pending

"Implementation decision is intentionally deferred until this verification report is reviewed."
