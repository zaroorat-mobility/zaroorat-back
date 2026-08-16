# Zaroorat Mobility

# Customer Permanent 4-Digit Ride PIN

# Production Research & Verification Report

**Evidence labels used throughout:** `[CODEBASE]` verified in this repository · `[WEB]` external source, cited · `[SECURITY]` published standard (NIST/OWASP) · `[INFERENCE]` reasoning, not fact.

No code, schema, migration, or API was modified. This report is the only deliverable.

---

## 1. Executive Summary

**Zaroorat has no customer PIN of any kind** `[CODEBASE]`. It has a per-ride, 6-digit, 15-minute, single-use start OTP that is well-engineered cryptographically — and one defect that makes it useless in practice: **the backend returns the plaintext code to the driver in the `/accept` response, and the customer has no way to obtain it at all** `[CODEBASE]`.

That defect matters more than the PIN decision. Whatever code the driver types — a per-ride OTP or a permanent PIN — the mechanism only proves something if the _customer_ holds the secret. Building a permanent PIN on the current delivery model would replace a 15-minute secret with a lifetime one in the same broken channel.

On the product question, external research is lopsided. Of five platforms researched, **four use per-ride codes** (Uber, Lyft, Ola, Namma Yatri) and **one uses a static per-customer PIN (Rapido)** `[WEB]`. Uber's and Lyft's are documented on official help pages; Ola's on its official blog. **Rapido's static PIN is not documented on any official Rapido page found in this research** — it is attested only by secondary sources, so its _user-visible behaviour_ is well-corroborated but its _backend design_ is entirely unverified `[WEB]`.

The central engineering tension is not brute force. It is this: **a permanent PIN the customer can always view cannot be stored one-way.** Hashing is irreversible; display requires reversibility. Zaroorat has an HMAC hasher and **no application-level encryption utilities whatsoever** (`src/shared/crypto/index.ts` is `export {};`) `[CODEBASE]`. Adopting a viewable permanent PIN means introducing a reversible-encryption capability and its key management — genuinely new infrastructure for this codebase.

The second tension is specific to _permanence_ and is underappreciated: **every driver who has ever legitimately carried a customer knows that customer's PIN forever** `[INFERENCE]`. A per-ride OTP expires in 15 minutes; a static PIN does not. This, not blind guessing, is the dominant threat.

Recommendation summary (§24): fix the exposure first; if the static PIN is adopted, store it in a dedicated table under reversible AEAD encryption with **no unique constraint and no index on the PIN column**, verify strictly via `ride.customerId`, and add multi-axis Redis throttling modelled on the existing, proven `OtpRateLimiter`.

---

## 2. Confirmed Current Codebase Behavior

All `[CODEBASE]`. Searches run over `src/`, `prisma/`, `tests/`, `scripts/`, `docs/`, excluding `node_modules/` and `dist/`.

| Searched term (all case variants)                                                                                                     | Hits in code                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ridePin`, `ride_pin`, `customerPin`, `customer_pin`, `tripPin`, `startPin`, `bookingPin`, `securityPin`, `staticPin`, `permanentPin` | **0**                                                                                              |
| `\bpin\b` word-boundary (excluding `pinned`/`pino`/`pipe`/`spin`)                                                                     | **0** in code; 1 in docs — `docs/03_Requirements/01_srs-functional.md:41`, "map pin" (a UI marker) |
| `4-digit`, `4 digit`, `four-digit`                                                                                                    | **0** in code                                                                                      |
| `rideOtp`, `RideOtp`, `startOtp`, `START` purpose                                                                                     | **Present** — the subsystem in §3                                                                  |
| `verificationCode`, `verification_code`                                                                                               | **0**                                                                                              |

`User` scalar columns, complete ([prisma/schema/modules/user/user.prisma](prisma/schema/modules/user/user.prisma)): `id`, `phoneNumber`, `email`, `passwordHash`, `status`, `isPhoneVerified`, `isEmailVerified`, `lastLoginAt`, `createdAt`, `updatedAt`, `deletedAt`.

`UserProfile` scalar columns, complete: `id`, `userId`, `firstName`, `lastName`, `dateOfBirth`, `gender`, `profileImageFileId`, `languageCode`, `referralCode`, `createdAt`, `updatedAt`.

No PIN column, no PIN table, no migration adding one, in any of the 15 schema module directories.

Account creation writes no code of any kind — `UserRepository.create` inserts only `phoneNumber`, `isPhoneVerified`, and optionally `status`/`email` ([user.repository.ts:25-34](src/modules/auth/repositories/user.repository.ts#L25)).

---

## 3. Existing Ride OTP Architecture

Traced completely `[CODEBASE]`.

### 3.1 Storage

```prisma
model RideOtp {
  id         String    @id @default(uuid(7)) @db.Uuid
  rideId     String    @map("ride_id") @db.Uuid      // per RIDE
  otpHash    String    @map("otp_hash")
  purpose    String    @default("START")
  attempts   Int       @default(0) @db.SmallInt
  verified   Boolean   @default(false)
  verifiedAt DateTime? @map("verified_at")
  expiresAt  DateTime  @map("expires_at")
  createdAt  DateTime  @default(now()) @map("created_at")

  ride Ride @relation(fields: [rideId], references: [id])

  @@index([rideId])
  @@map("ride_otps")
}
```

Created in [20260724173304_init/migration.sql:1674](prisma/migrations/20260724173304_init/migration.sql#L1674); index `ride_otps_ride_id_idx` at [:2880](prisma/migrations/20260724173304_init/migration.sql#L2880). No `customerId`, no `userId`.

### 3.2 Full trace

| Dimension                 | Implementation                                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Generation**            | `generateRideOtp()` — 6 independent `randomInt(0, 10)` draws from `node:crypto` ([otp.util.ts](src/modules/rides/utils/otp.util.ts)); `RIDE_OTP_LENGTH = 6` ([ride.constants.ts:31](src/modules/rides/constants/ride.constants.ts#L31))                               |
| **When**                  | Inside `acceptRideRequest`, same transaction that creates the `Ride` ([lifecycle.service.ts:137](src/modules/rides/services/lifecycle/lifecycle.service.ts#L137))                                                                                                     |
| **Storage**               | HMAC-SHA256 + server pepper via auth's `OtpHasher`; plaintext never persisted ([ride-otp.service.ts:25](src/modules/rides/services/otp/ride-otp.service.ts#L25))                                                                                                      |
| **Expiry**                | 15 min (`RIDE_OTP_TTL_MINUTES = 15`); checked at [ride-otp.service.ts:44](src/modules/rides/services/otp/ride-otp.service.ts#L44)                                                                                                                                     |
| **Attempt limit**         | `RIDE_OTP_MAX_ATTEMPTS = 5` via `claimAttempt` — one conditional `updateMany` (`attempts: { lt: max }`), atomic                                                                                                                                                       |
| **Verification**          | `findLatestByRideId` → expiry → claim attempt → digest compare → `claimVerification` (single-use)                                                                                                                                                                     |
| **Driver access**         | **Plaintext returned in the `/accept` response** — see §11                                                                                                                                                                                                            |
| **Customer access**       | **None.** No endpoint, no SMS, no push, no socket, not in the `ride.accepted` payload                                                                                                                                                                                 |
| **Ride binding**          | By `rideId` only. `RideOtpService` never reads `ride.customerId` and never loads a `User`                                                                                                                                                                             |
| **Start transition**      | `startRide` → verify → `updateStatusIf(rideId, expected, 'IN_PROGRESS', { startedAt })` (compare-and-swap), all in one `txManager.execute`                                                                                                                            |
| **Events**                | `ride.accepted` = `{ rideId, driverId }`; `ride.started` = `{ rideId, driverId }`; `ride.dispatch.offered` = `{ dispatchId, requestId, driverId }` ([dispatch.service.ts:42-49](src/modules/rides/services/dispatch/dispatch.service.ts#L42)). No code in any payload |
| **Socket delivery**       | None — `src/plugins/socket/socket.plugin.ts` is `export {};`, a stub                                                                                                                                                                                                  |
| **Notification delivery** | None — no ride-event consumer exists; `NotificationService.sendOtp` is called only by auth ([otp.service.ts:104](src/modules/auth/services/otp/otp.service.ts#L104))                                                                                                  |

### 3.3 What must happen to `RideOtp` if a permanent PIN is adopted

Evaluated in §21.4. Nothing here is removed or modified by this report.

---

## 4. Missing Functionality

For the requested product flow, missing entirely `[CODEBASE]`:

1. PIN storage — column or table, plus migration.
2. Reversible-encryption capability, if the PIN must remain viewable (`src/shared/crypto/index.ts` is `export {};`; the only KMS usage in the repo is S3 server-side encryption in `src/modules/files/`, not app-level field encryption).
3. PIN generation at customer creation, plus backfill for existing customers.
4. A customer retrieval endpoint with a visibility/masking policy.
5. Regeneration/reset, and its abuse controls.
6. The `ride.customerId → customer PIN` verification traversal inside `startRide`.
7. Cross-ride, per-customer attempt accounting sized for a permanent secret.
8. Tests for constancy, wrong-customer rejection, retrieval, rotation, and code-withholding.

Missing independently of the PIN decision:

9. **Any delivery channel to the customer for the existing ride OTP** — the current flow cannot work as specified today.
10. HTTP rate limiting on `/accept`, `/:id/arrive`, `/:id/start`, `/:id/complete` (`rateLimits.rideWrite` exists at [rate-limit.config.ts:47](src/config/rate-limit/rate-limit.config.ts#L47) and is applied only to `/requests` and `/:id/cancel`).
11. An OTP resend path — `generateStartOtp` is reachable only from `acceptRideRequest`, so a ride is unstartable forever after 5 failed attempts.
12. `RideMetrics.otpFailure()` emission — defined at [ride.metrics.ts:35](src/modules/rides/metrics/ride.metrics.ts#L35), zero call sites.
13. `rideConfig.requireStartOtp` is dead config — defined at [ride.config.ts:16](src/config/ride/ride.config.ts#L16) and [:65](src/config/ride/ride.config.ts#L65), referenced nowhere else.

---

## 5. Customer PIN Requirements

Restated from the brief, with the engineering consequence of each `[INFERENCE]`:

| Requirement                                         | Consequence                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Customer-scoped, not ride-scoped                    | Storage keyed on `userId`, not `rideId`                                                                                   |
| Exactly 4 digits, `0000`–`9999`                     | 10,000-value keyspace; leading zeros must survive as a string                                                             |
| Permanent across rides                              | No expiry; rotation only on explicit request                                                                              |
| Customer knows/sees it                              | **Storage must be reversible** — this is the decisive constraint (§8)                                                     |
| Not globally unique                                 | A `UNIQUE` constraint is mathematically impossible past 10,000 customers (§6)                                             |
| Backend must never identify a customer by PIN alone | PIN is a _verifier_, never a lookup key. No index on it                                                                   |
| `ride.customerId` is authoritative identity         | Verification path: authenticated driver → `rideId` → `ride.driverId` check → `ride.customerId` → that customer's verifier |
| Driver must never receive it from the backend       | Directly violated today (§11)                                                                                             |

---

## 6. 1-Million-Customer Scalability

`[INFERENCE]`, arithmetic.

**1,000,000 customers ÷ 10,000 possible values = ~100 customers per PIN value on average.** By the pigeonhole principle, once customer 10,001 is created, at least one collision is unavoidable.

| Question              | Answer                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicates            | **Expected and unavoidable.** ~100 customers share each value at 1M scale                                                                                                                                                                                                                                                                 |
| **UNIQUE constraint** | **INCORRECT.** It is mathematically unsatisfiable beyond 10,000 customers. Attempting it would make registration fail once the space saturates, and long before that would turn PIN assignment into a retry storm as the space fills. A unique constraint would also _turn the PIN into an identifier_ — precisely what the brief forbids |
| Indexing              | **No index on the PIN column.** It is never a lookup key. Every read is `WHERE user_id = ?`, already served by the PK/FK. An index would be dead weight and would make "find all users with PIN X" a cheap query for anyone with DB access — a small but gratuitous insider-risk gift                                                     |
| Lookup strategy       | Single-row fetch by `userId`, obtained from `ride.customerId`. One indexed read per verification                                                                                                                                                                                                                                          |
| Customer binding      | Identity flows from the JWT: authenticated customer books → `RideRequest.customerId` → copied to `Ride.customerId` at accept ([lifecycle.service.ts:123](src/modules/rides/services/lifecycle/lifecycle.service.ts#L123)) `[CODEBASE]`. The PIN never participates in identification                                                      |
| Collision behavior    | Irrelevant by construction. Two customers sharing `4827` never interact, because verification is always scoped to one `customerId`                                                                                                                                                                                                        |
| Generation            | No collision check, no retry loop, no coordination. A single random draw per customer — O(1), no contention, no hot rows                                                                                                                                                                                                                  |
| DB performance        | Negligible. One extra indexed row read per ride start; the row is tiny. Encryption/decryption is a microsecond-scale CPU operation                                                                                                                                                                                                        |

**How the backend identifies the correct customer without using the PIN as an identifier:** it never searches by PIN. The chain is `driver JWT → Driver.id → ride.driverId must match → ride.customerId → that customer's stored verifier → compare`. The submitted PIN is compared against exactly one expected value. The anti-pattern the brief warns about — `WHERE pin = ?` — would at 1M scale return ~100 candidate customers and is both insecure and semantically meaningless.

---

## 7. PIN Generation Options

The current repo pattern `[CODEBASE]`, from [otp.util.ts](src/modules/rides/utils/otp.util.ts):

```ts
for (let i = 0; i < RIDE_OTP_LENGTH; i += 1) code += randomInt(0, 10).toString();
```

| Option                        | Method                                            | Assessment                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1 — per-digit loop**       | 4 × `randomInt(0, 10)`                            | Matches the existing house style exactly. Uniform, CSPRNG, leading zeros natural. Zero new concepts                                                                                                                                                                                                                                 |
| **G2 — single draw + pad**    | `String(randomInt(0, 10000)).padStart(4, '0')`    | One CSPRNG call instead of four; identical uniform distribution over `0000`–`9999`. Marginally simpler                                                                                                                                                                                                                              |
| **G3 — weak-value blacklist** | G1/G2, redraw if in `{0000, 1111, …, 1234, 4321}` | Removes the values a guesser tries first. Costs ~0.3% of the keyspace. Meaningful _because the PIN is permanent_ — a customer stuck with `1234` for life is stuck with the single most-guessed value                                                                                                                                |
| **G4 — memorable patterns**   | Repeated digits / simple series                   | **Reject.** `[WEB]` Secondary reporting describes Rapido's PIN as "either a combination of repeated digits or a simple number series to remember". `[INFERENCE]` If accurate, that collapses effective entropy from 10,000 to the low hundreds and inverts G3 — it deliberately selects the most-guessable values. Do not copy this |

`randomInt` from `node:crypto` is the correct primitive; `Math.random()` must never be used `[SECURITY]`.

**Timing options:** eager at registration (every customer always has one; costs a backfill for existing users) · lazy on first read (no backfill, but a customer can reach a ride start with no PIN — the failure mode lands at the worst moment) · migration backfill (see §21). **Regeneration/replacement** is a separate endpoint with its own throttling; not chosen here.

---

## 8. PIN Storage Options

This is the decisive section. **A permanent PIN the customer can always view cannot be stored one-way.**

| Option                               | Customer can view?    | Backend verify?                                                           | DB-compromise risk                                                                                                                      | Key mgmt                                                  | Rotation        | Complexity                                                 | Recovery        | Migration                                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------- | ---------------------------------------------------------- | --------------- | ----------------------------------------- |
| **A — Plaintext column**             | Yes                   | Trivial                                                                   | **Total.** A dump yields every PIN. Insider read is one `SELECT`                                                                        | None                                                      | Trivial         | Lowest                                                     | Trivial         | Trivial                                   |
| **B — One-way hash/HMAC**            | **No** — irreversible | Yes                                                                       | Low. Pepper is outside the DB; a dump alone is not enough                                                                               | Pepper only (exists)                                      | Regenerate only | Low — `OtpHasher` already exists `[CODEBASE]`              | Regenerate only | Trivial                                   |
| **C — Reversible encryption (AEAD)** | Yes                   | Yes (decrypt-and-compare, or encrypt-and-compare with deterministic mode) | Low **while the key is safe**; total if key and DB are taken together                                                                   | **Real** — needs a managed key, rotation, envelope scheme | Supported       | **High for this repo** — no app-level crypto exists at all | Yes             | Needs key provisioning before backfill    |
| **D — Dedicated credential table**   | Depends on B or C     | Yes                                                                       | Same as its crypto choice, plus **isolation**: least-privilege grants, separate audit, no accidental inclusion in `SELECT *` on `users` | Same                                                      | Same            | Medium                                                     | Same            | Clean — additive table, no `users` change |
| **E — Reuse existing mechanism**     | **No**                | Yes                                                                       | Low                                                                                                                                     | Already solved                                            | Regenerate only | Lowest — zero new infrastructure                           | Regenerate only | Trivial                                   |

**What actually exists in this repo** `[CODEBASE]`:

- `OtpHasher` — `createHmac('sha256', pepper)` ([otp.hasher.ts](src/modules/auth/services/otp/otp.hasher.ts)). One-way.
- Pepper resolution — `OTP_PEPPER`, else derived as `HMAC-SHA256(JWT_REFRESH_SECRET, 'zaroorat:otp:pepper:v1')` ([otp.config.ts](src/config/otp/otp.config.ts)).
- **No encryption utilities.** `src/shared/crypto/index.ts` is `export {};`. A repo-wide grep for `createCipheriv`/`createDecipheriv` returns **zero hits**. The only `KMS` references are `STORAGE_KMS_KEY_ID` for S3 server-side encryption in `src/modules/files/` — object storage, not application field encryption.

So option **E collapses into B**: the only reusable secure pattern is one-way, and one-way forecloses permanent display.

**The unavoidable fork** `[INFERENCE]`:

- **Fork 1 — PIN is permanently viewable** → storage must be reversible → Option C or D-with-C → Zaroorat must build an encryption + key-management capability it does not have.
- **Fork 2 — PIN is shown once at generation, then only replaceable** → Option B or D-with-B → reuses `OtpHasher` with essentially no new infrastructure, but the customer who forgets their PIN must regenerate rather than re-view. Note the customer's phone app can cache the plaintext locally after the one-time reveal, which restores most of the everyday UX without server-side reversibility.

Fork 2 is materially cheaper and materially safer. Fork 1 matches the requirement as literally written.

---

## 9. Customer Display/Retrieval

`[INFERENCE]` throughout, informed by `[SECURITY]`.

**What should not happen:** the PIN must not appear in `GET /api/v1/users/me`. That response is the widest-cached, most-logged, most-screenshotted payload in the product, and it is fetched on nearly every app launch. Today `toAccountView` returns `id`, `phoneNumber`, `email`, `isPhoneVerified`, `isEmailVerified`, `status`, `roles`, `createdAt`, `lastLoginAt`, `profile` ([user.service.ts:13-26](src/modules/users/services/user.service.ts#L13)) `[CODEBASE]` — a credential does not belong in that shape.

**A dedicated endpoint** (e.g. `GET /me/ride-pin`) is the right shape: narrow, separately rate-limited, separately audited, and trivially revocable. `[CODEBASE]` The codebase already has the pieces — `requireUntamperedDevice` is used for sensitive user routes in [user.routes.ts](src/modules/users/routes/user.routes.ts), and `fastify.rateLimit` supports `keyBy: 'user'`.

| Concern                       | Position                                                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Masking / reveal              | Show masked by default in the app, explicit tap to reveal. Server-side the value is either returned or not — masking is a client concern, but the _endpoint separation_ is what makes client masking enforceable |
| Re-authentication / biometric | Reasonable for a permanent credential; a device-local biometric gate costs nothing server-side. Do not build a server-side step-up flow for v1                                                                   |
| Client caching / app storage  | Cache in platform secure storage (Keychain/Keystore), never plain preferences. This is what makes offline access work                                                                                            |
| Offline access                | Important — pickup often happens with poor connectivity. A locally cached PIN is the practical answer; a server round-trip at pickup is not                                                                      |
| Screenshots                   | Cannot be prevented meaningfully; accept it. A permanent PIN _will_ end up in a screenshot                                                                                                                       |
| Logging                       | The PIN must never appear in request/response logging. Today no rides-module log call writes the plaintext code `[CODEBASE]` — that property must be preserved deliberately, not by luck                         |

---

## 10. Driver Verification

**Yes — this can be implemented almost entirely with existing Ride services** `[CODEBASE]`.

`startRide` already performs every step of the required flow except the verifier lookup:

| Required step               | Already exists                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated request       | Global `denyByDefault` `onRequest` hook + JWT                                                                                                                  |
| Driver authorization        | `fastify.authorize({ requireOperableDriver: true })`, fails closed ([auth.plugin.ts:106-120](src/modules/auth/plugins/auth.plugin.ts#L106))                    |
| `rideId` → identify ride    | `rideRepo.lockForUpdate` — `SELECT … FOR UPDATE` ([ride.repository.ts:27](src/modules/rides/repositories/ride.repository.ts#L27))                              |
| Driver owns the ride        | `RideDriverMismatchError` unless `ride.driverId === actor.driverId` ([lifecycle.service.ts:91](src/modules/rides/services/lifecycle/lifecycle.service.ts#L91)) |
| Verify ride state           | `validateTransition(ride.status, 'IN_PROGRESS')` — only `DRIVER_ARRIVED` qualifies                                                                             |
| Get `ride.customerId`       | Already loaded on the locked ride object — **currently unused by verification**                                                                                |
| Obtain customer verifier    | **MISSING** — the only genuinely new step                                                                                                                      |
| Verify submitted PIN        | Pattern exists (`OtpHasher` digest compare)                                                                                                                    |
| Attempt / rate-limit checks | Per-code pattern exists (`claimAttempt`); per-customer accounting **MISSING**                                                                                  |
| Atomic transition           | `updateStatusIf` compare-and-swap inside `txManager.execute`                                                                                                   |

The change is narrow: swap `verifyStartOtp(rideId, code, tx)` for a customer-PIN verification that reads `ride.customerId` from the already-locked ride. Every surrounding guarantee — lock, ownership, state gate, transaction, CAS — is untouched and already tested.

---

## 11. Ride Start Enforcement

Every `IN_PROGRESS` reference in `src/` enumerated `[CODEBASE]`.

| Path           | Endpoint/Function                                             | Actor  | PIN/OTP Required                                                                        | Evidence                                                                                       |
| -------------- | ------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Start ride     | `POST /api/v1/rides/:id/start` → `LifecycleService.startRide` | Driver | **Yes** — `verifyStartOtp` before `updateStatusIf`, same transaction; a throw aborts it | [lifecycle.service.ts:204-241](src/modules/rides/services/lifecycle/lifecycle.service.ts#L204) |
| Arrive         | `POST /:id/arrive` → `markDriverArrived`                      | Driver | N/A — targets `DRIVER_ARRIVED`                                                          | [lifecycle.service.ts:161](src/modules/rides/services/lifecycle/lifecycle.service.ts#L161)     |
| Accept         | `POST /accept` → `acceptRideRequest`                          | Driver | N/A — creates ride in `ACCEPTED`                                                        | [lifecycle.service.ts:105](src/modules/rides/services/lifecycle/lifecycle.service.ts#L105)     |
| Complete       | `POST /:id/complete`                                          | Driver | N/A — needs `IN_PROGRESS` as source                                                     | [lifecycle.service.ts:243](src/modules/rides/services/lifecycle/lifecycle.service.ts#L243)     |
| Admin override | —                                                             | —      | **No such path** — `src/modules/admin/index.ts` is `export {};`                         | [src/modules/admin/index.ts](src/modules/admin/index.ts)                                       |
| Jobs           | `dispatch-timeout.job.ts`, `request-expiry.job.ts`            | System | **No such path** — only `RideRequest` status                                            | [request-expiry.job.ts:21-29](src/modules/rides/jobs/request-expiry.job.ts#L21)                |
| Repo write     | `RideRepository.updateStatus` — no CAS, no verification       | —      | **Dead code** — zero callers across `src/` and `tests/`                                 | [ride.repository.ts:114](src/modules/rides/repositories/ride.repository.ts#L114)               |
| Raw SQL        | —                                                             | —      | **None** — no `UPDATE "rides"` anywhere                                                 | grep: 0 hits                                                                                   |

Transition table ([lifecycle.service.ts:25-49](src/modules/rides/services/lifecycle/lifecycle.service.ts#L25)) confirms `DRIVER_ARRIVED` is the **only** predecessor of `IN_PROGRESS`.

**No endpoint-level bypass exists.** But there is a total practical bypass, and it is the finding that dominates this report:

```ts
// lifecycle.service.ts:110, 158  — signature and return
async acceptRideRequest(…): Promise<{ ride: Ride; plaintextOtp: string }>
return { ride, plaintextOtp };

// ride-state.controller.ts:36  — route guarded by requireOperableDriver
reply.send({ data: result });        // data.plaintextOtp goes to the driver
```

```ts
// tests/integration/earnings-pipeline.test.ts:89-90 — the test reads it back and starts the ride
const otpCode = accepted.json().data.plaintextOtp;
```

The driver holds the secret they are being challenged on. Combined with the customer having no channel to receive it (§3.2), pickup verification currently proves nothing, and a driver can start and complete a rider-less ride — which `LedgerService.recordTripPayment` will bill.

Channel audit — every other surface is clean `[CODEBASE]`: driver ride-details reads (`findActiveByDriverUserId`, bare `findFirst`), the `/api/v1/drivers/*` API, socket (stub plugin), push (no ride-event consumer), logs, DB responses (only `otpHash` persisted), and all event payloads.

---

## 12. Security Analysis

### 12.1 What a permanent 4-digit PIN actually changes

`[SECURITY]` NIST SP 800-63B classifies a numeric PIN as a _memorized secret_ and requires that **"if the authenticator output has less than 64 bits of entropy, the verifier SHALL implement a throttling mechanism that effectively limits the number of failed authentication attempts."** A 4-digit PIN carries ~13.3 bits. Throttling is not optional; it is the entire security model.

`[SECURITY]` NIST further advises counting failures **per account and, ideally, per source to resist distributed guessing**, and that the mechanism **must not be trivially reset by the attacker**. Its reference ceiling is no more than 100 consecutive failures, with exponential backoff or temporary lockout.

`[SECURITY]` OWASP's Authentication Cheat Sheet recommends **five to ten failed attempts before a time-based lockout**, and warns that lockout **creates a denial-of-service risk** and does not defend against attacks that need only one guess per account.

`[INFERENCE]` Applying this to Zaroorat: the current 5-attempt cap sits inside OWASP's range — but it is scoped **per OTP row**, i.e. per ride. For a per-ride code that is exactly right, because the code dies with the ride. For a **permanent** PIN it is the wrong unit entirely: the budget must be **per customer, accumulating over time**, or the attacker simply gets 5 fresh guesses per ride forever.

### 12.2 The dominant threat is not guessing

`[INFERENCE]` Blind brute force against a permanent PIN needs ~2,000 rides against one customer at 5 guesses each — not a realistic single-driver attack. The real exposures are:

1. **Permanent knowledge by past drivers.** Every driver who has ever carried a customer legitimately learned that customer's PIN, and it never rotates. A returning driver can start a future ride without the customer present. A per-ride OTP forecloses this in 15 minutes; a static PIN never does. **This is the single strongest security argument against permanence**, and it directly undercuts the fraud-prevention rationale reported as Rapido's motivation (§14).
2. **Shoulder-surfing and ambient capture.** The PIN is spoken aloud in a vehicle, on every ride, for the life of the account.
3. **Screenshot and device persistence.** A viewable permanent credential ends up in photo rolls and backups.
4. **Insider/DB access.** Under Option A a dump is catastrophic; under C it depends entirely on key custody. This is why a `UNIQUE` constraint or an index on the PIN column is doubly wrong (§6) — it turns "find everyone with PIN 4827" into a fast query.
5. **Distributed guessing across accounts.** OWASP's credential-stuffing analogue: one guess against each of many customers. Per-customer lockout does nothing here; only per-driver/per-source accounting catches it.

### 12.3 Current control inventory

`[CODEBASE]`

| Control                            | State                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-code attempt cap, atomic       | **PASS** — `claimAttempt` conditional `updateMany`; 50 parallel guesses cap at exactly 5 ([ride-otp.test.ts:106](tests/unit/rides/ride-otp.test.ts#L106)) |
| Replay protection                  | **PASS** — `claimVerification` on `verified: false`                                                                                                       |
| Race conditions                    | **PASS** — row lock + CAS + one transaction; lifecycle concurrency suite covers exactly-once completion and single terminal transition                    |
| Per-driver rate limit              | **ABSENT**                                                                                                                                                |
| Per-customer cross-ride accounting | **ABSENT**                                                                                                                                                |
| IP rate limiting on `/start`       | **ABSENT** — no `fastify.rateLimit` on the route                                                                                                          |
| Lockout / cooldown                 | Per-code only, and it is permanent (no resend) — a DoS on the ride, exactly the OWASP-warned failure mode                                                 |
| Abuse detection / telemetry        | **ABSENT** — `otpFailure()` never called, so failures are invisible                                                                                       |
| PIN in logs                        | Clean                                                                                                                                                     |
| PIN in API responses               | **FAIL** — §11                                                                                                                                            |
| PIN in socket/push/events          | Clean                                                                                                                                                     |
| DB exposure                        | Hashed with pepper; pepper outside the DB                                                                                                                 |

### 12.4 Reusable throttling infrastructure

`[CODEBASE]` Zaroorat already has a proven multi-axis limiter — `OtpRateLimiter` ([otp.rate-limiter.ts](src/modules/auth/services/otp/otp.rate-limiter.ts)) checks **per phone, per device, and per IP** against `redisService.rateLimit.hit(scope, id, limit, windowSeconds)`, plus `isLocked` / `registerFailedAttempt` / `clearAttempts` with a configurable lockout. Limits and windows are already externalised per axis in [otp.config.ts](src/config/otp/otp.config.ts). The generic `fastify.rateLimit` plugin supports `keyBy: 'ip' | 'user' | 'both'` and defaults to `onStoreError: 'closed'` — fails closed when Redis is down.

`[INFERENCE]` This is precisely the shape a permanent PIN needs, and it is the strongest argument for not inventing anything new: the multi-axis pattern (per customer + per driver + per IP, with lockout) already exists, is configured, and is in production use for auth OTP.

---

## 13. Rate Limiting / Anti-Brute Force

`[INFERENCE]`, grounded in §12's `[SECURITY]` citations. Reported as analysis, not as a design decision.

| Axis                             | Purpose                                           | Why it is needed                                                                                                     |
| -------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Per ride**                     | Bound guesses within one pickup                   | Exists today (5). Retain                                                                                             |
| **Per customer, rolling window** | Bound lifetime guesses against a permanent secret | The axis that actually matters. NIST: throttle per account. Without it, 5 guesses/ride × unlimited rides = unlimited |
| **Per driver, rolling window**   | Catch a driver probing many customers             | OWASP's credential-stuffing analogue; per-customer limits are blind to it                                            |
| **Per IP**                       | Catch scripted/distributed attempts               | Already an axis in `OtpRateLimiter`                                                                                  |
| **Lockout + backoff**            | Slow a determined attacker                        | NIST: exponential backoff or temporary lockout; must not be attacker-resettable                                      |
| **Telemetry**                    | Detect campaigns                                  | `otpFailure()` exists and is uncalled — the cheapest missing control in the whole system                             |

**The DoS tension is real and must be designed for, not discovered.** `[SECURITY]` OWASP explicitly warns that lockout can be weaponised. A per-customer lockout on ride start means a malicious driver can lock a customer out of _starting any ride_ by burning attempts. The current per-ride cap already exhibits the mild version of this: five wrong entries brick the ride permanently with no resend path (§4, item 11). Any per-customer lockout amplifies it from one ride to the whole account, so the fallback path (support override, PIN regeneration, or a secondary verification channel) has to be part of the design rather than an afterthought.

---

## 14. Rapido Research

**CONFIRMED PUBLIC BEHAVIOR** `[WEB]` — consistent across multiple independent secondary sources and directly observable by any Rapido user:

- Rapido operates a feature called **Rapid PIN**, introduced on the customer app in **November 2019**.
- It is **4 digits**.
- It is **per customer, not per ride** — "the same four-digit Rapid PIN remains the same on ride after ride"; described as "similar to an ATM PIN, every customer on the Rapido app now has their own single and unique Rapid PIN to share with the driver-partner (Captain) for ride verification."
- It is **displayed in the customer's app**.
- Reported motivation: drivers arriving at pickup, marking the ride started without the passenger boarding, then leaving — with the customer charged.
- Reported outcomes: reduced booking-to-start time, fewer cancellations, and a **28% reduction in customer complaints**.

**NOT CONFIRMED — treat as unverified** `[INFERENCE]`:

- **No official Rapido help page, support article, engineering blog, or press release documenting Rapid PIN was found in this research.** The attestations come from a Medium article by a product writer, a personal engineering blog (renderlog), a LinkedIn post, and an X post. On direct inspection, the renderlog article **cites no official Rapido sources at all** and is explicitly reverse-engineered product analysis ("In product terms it is usually a deliberate trade").
- **Backend implementation is entirely unknown.** Storage form (plaintext / hashed / encrypted), key management, rate limiting, and rotation policy are undocumented publicly. Any claim about them is speculation.
- The 28% complaint-reduction figure traces to the same non-official Medium source and should not be treated as an audited metric.

**Two secondary claims that warrant explicit caution** `[WEB]` + `[INFERENCE]`:

1. One Medium source states that when a ride is booked, **"the driver's app fetches that stored PIN and displays it."** If accurate, that would be functionally identical to Zaroorat's CRITICAL-1 (§11) and would defeat the feature's stated anti-fraud purpose. **This claim is unverified, comes from a non-official source, and must not be used as a design justification.** It is noted here precisely because a reader skimming the same articles might mistake it for a licence to keep the current behaviour.
2. One source describes the PIN as "either a combination of repeated digits or a simple number series to remember." If accurate, that is a deliberate entropy reduction for memorability and is a security anti-pattern (§7, G4).

---

## 15. Namma Yatri Research

`[WEB]`

- Namma Yatri uses a **per-ride OTP**: the driver accepts, arrives, **collects the OTP from the customer**, enters it, and the trip starts.
- The platform is **open source** (`github.com/nammayatri/nammayatri`) and built on open protocols (Beckn), describing itself as 100% open source with open data. `[INFERENCE]` This makes it the one platform in this comparison whose ride-start verification could be read directly rather than inferred — worth doing before any final design decision, since it is the closest architectural analogue to Zaroorat (Indian market, direct-to-driver, auto/bike).
- No evidence of a static per-customer PIN.

---

## 16. Uber Research

`[WEB]` Official Uber help page, _"What's Verify my Ride?"_, fetched directly:

- **4 digits** — "you'll receive a unique 4-digit PIN whenever you request a ride."
- **Per ride, not permanent** — the phrasing "whenever you request a ride" denotes per-trip generation.
- **Opt-in**, with a scope choice: all trips, or only at night (9pm–6am).
- Flow: "Before entering your driver's vehicle, tell them your PIN; if they are the driver the app matched you with, they'll be able to start the trip after they enter your PIN into their app."
- `[WEB]` Uber's driver-facing material states drivers get **5 attempts** to enter the correct PIN and can only start the trip after a correct entry. `[INFERENCE]` Notably identical to Zaroorat's existing `RIDE_OTP_MAX_ATTEMPTS = 5` and inside OWASP's 5–10 guidance.

---

## 17. Ola Research

`[WEB]` Official Ola blog, _"Start your Ola rides easily with an OTP"_:

- **4-digit OTP**, **per ride**.
- Delivered **in the customer app** (visible on the "Track Ride" screen; Android surfaces it in the notification drawer), with **SMS** delivery on other platforms at booking confirmation.
- The rider shares it with the driver, who must enter the start code to begin the trip; the driver can enter the odometer only after the OTP is shared.
- Stated purpose: correct billing and verifying that the right passenger and driver are connected.

`[INFERENCE]` Ola is the useful counter-example to Zaroorat's current state: same per-ride model, but with an actual customer-side delivery channel — the piece Zaroorat is missing entirely.

---

## 18. Industry Comparison

| Platform               | PIN Type                       | Static/Dynamic | Lifetime                                | Customer Binding                                               | Public Evidence                                                                                                                               |
| ---------------------- | ------------------------------ | -------------- | --------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rapido**             | 4-digit "Rapid PIN"            | **Static**     | Permanent, per customer                 | Per customer (behaviour observable); backend unknown           | `[WEB]` Secondary only — Medium, personal blogs, social posts. **No official Rapido documentation found.** Backend design entirely unverified |
| **Namma Yatri**        | Ride OTP                       | Dynamic        | Per ride                                | Per ride                                                       | `[WEB]` App documentation + open-source repo (`nammayatri/nammayatri`); implementation is publicly readable                                   |
| **Uber**               | 4-digit "Verify Your Ride" PIN | Dynamic        | Per ride                                | Per ride                                                       | `[WEB]` **Official** Uber help page + driver blog. Opt-in; 5 driver attempts                                                                  |
| **Lyft**               | 4-digit PIN                    | Dynamic        | Per ride (new code issued if one fails) | Per ride                                                       | `[WEB]` **Official** Lyft help pages (rider + driver). Opt-in; all rides or 9pm–6am                                                           |
| **Ola**                | 4-digit OTP                    | Dynamic        | Per ride                                | Per ride                                                       | `[WEB]` **Official** Ola blog. In-app + SMS delivery                                                                                          |
| **Zaroorat (current)** | 6-digit ride OTP               | Dynamic        | 15 min, single-use, per ride            | **Per ride** (`ride_otps.ride_id`); customer never receives it | `[CODEBASE]` `RideOtp` model, `RideOtpService`, `startRide`                                                                                   |

`[INFERENCE]` Four of five researched platforms use per-ride codes, and the three best-documented (Uber, Lyft, Ola) all do. The single static-PIN example is also the single one with no official documentation. Two of the five (Uber, Lyft) make PIN verification **opt-in** rather than mandatory — a middle path not currently contemplated in the Zaroorat requirement.

---

## 19. Production Architecture Options

`[INFERENCE]`, constrained by `[CODEBASE]` facts.

### Option A — Encrypted PIN column on `User`

- **DB:** `users.ride_pin_encrypted TEXT NULL`. No unique constraint, no index.
- **Generation:** at registration; backfill for existing rows.
- **Storage:** AES-256-GCM with a key from env/KMS; store IV + auth tag with the ciphertext.
- **Retrieval:** decrypt on a dedicated endpoint.
- **Verification:** decrypt, constant-time compare against the submitted PIN.
- **Security:** key custody is everything. A credential now lives in the hottest table in the schema and will ride along in every incautious `SELECT`.
- **Migration:** touches `users`, the highest-traffic table; a backfill is an `UPDATE` over 1M rows.
- **Complexity:** requires building app-level crypto from zero `[CODEBASE]`.

### Option B — Dedicated `CustomerRidePin` table, encrypted

- **DB:** new table — `userId` (unique FK, the only index), `pinEncrypted`, `algo`/`keyVersion`, `createdAt`, `rotatedAt`, `lastVerifiedAt`. No constraint or index on the PIN.
- **Generation:** at registration or lazily on first read; backfill is an additive `INSERT`, never an `UPDATE` on `users`.
- **Retrieval / verification:** as Option A, but through a single narrow repository whose entire surface is auditable.
- **Security:** best isolation — least-privilege grants, separate audit trail, no accidental inclusion in user projections, and `keyVersion` makes key rotation expressible from day one.
- **Migration:** cleanest — additive, restartable, no lock pressure on `users`.
- **Complexity:** one extra table; same crypto burden as A.

### Option C — Dedicated table, HMAC (one-way), reveal-once

- **DB:** as B, but `pinHash` via the existing `OtpHasher` pattern.
- **Retrieval:** plaintext shown **once** at generation/rotation; the app caches it in platform secure storage. Afterwards the server cannot reveal it — only regenerate.
- **Security:** strongest at rest. A DB dump is useless without the pepper; there is no decryption path to abuse, and no key-management failure mode.
- **Complexity:** **lowest of the three** — reuses `OtpHasher` and the existing pepper resolution; **no new crypto infrastructure at all** `[CODEBASE]`.
- **Trade-off:** does not literally satisfy "customer can always see the PIN" from the server's perspective; it satisfies it from the _user's_ perspective via device-local caching, and degrades to "regenerate" if the device is lost.

### Option D — Keep per-ride OTP, fix delivery instead

- **DB:** no change.
- **Work:** deliver the existing code to the customer (in-app on `GET /rides/active` for the ride's own customer, plus SMS via the existing `NotificationService`), and stop returning it to the driver.
- **Security:** strictly the strongest — a 15-minute single-use secret with no permanent-knowledge exposure (§12.2).
- **Complexity:** smallest by a wide margin; closes CRITICAL-1 and matches Uber/Lyft/Ola/Namma Yatri `[WEB]`.
- **Trade-off:** does not deliver the requested product experience. Listed because it is the honest baseline the PIN options must be judged against, not as a substitute for a product decision.

---

## 20. Zaroorat Compatibility Analysis

`[CODEBASE]` — how each option lands against what actually exists.

| Existing asset                                                                 | State                                                                                                                      | Fits which option                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Prisma modular schema (15 module dirs, per-module `.prisma`)                   | A new `user`-module model is idiomatic                                                                                     | **B/C** cleanly; A requires editing the busiest model |
| `OtpHasher` (HMAC-SHA256 + pepper)                                             | Exists, proven, already shared across two modules                                                                          | **C** directly; A/B not at all                        |
| Pepper management (`OTP_PEPPER`, else derived from `JWT_REFRESH_SECRET`)       | Exists                                                                                                                     | **C**                                                 |
| App-level encryption                                                           | **Does not exist.** `src/shared/crypto/index.ts` is `export {};`; zero `createCipheriv` hits repo-wide; KMS is S3-SSE only | **A/B require building it**                           |
| `OtpRateLimiter` (per phone/device/IP + lockout + attempt counters, Redis)     | Exists, production-proven for auth OTP                                                                                     | All options — this is the throttling model to mirror  |
| `fastify.rateLimit` (`keyBy: ip/user/both`, fails closed)                      | Exists, unapplied to ride lifecycle routes                                                                                 | All options                                           |
| `startRide` (lock → ownership → state → verify → CAS → event, one transaction) | Exists and is tested                                                                                                       | All options — only the verifier step changes          |
| `rides.customer_id` FK → `users`, indexed                                      | Exists                                                                                                                     | All options — the binding traversal is available      |
| Repository/service/controller/route layering + Zod schemas + DI container      | Consistent house style                                                                                                     | All options                                           |
| `NotificationService.sendSms` / `sendOtp`                                      | Exists; used only by auth                                                                                                  | **D**, and any PIN-rotation notification              |
| Events + outbox (`EventPublisher`, `rideEvent`)                                | Exists                                                                                                                     | PIN rotation as an auditable event                    |

`[INFERENCE]` **Option C fits the existing codebase best by a clear margin** — it is the only PIN option that adds no new cryptographic infrastructure, and the "reveal once + device cache + regenerate" model is a product decision rather than an engineering risk. Option B is the right choice **if and only if** permanent server-side reveal is a hard product requirement, and it should then be scoped honestly as "build and operate field encryption," not as "add a column." Option A is not recommended under any reading: it puts a credential in the hottest table with the weakest isolation for no compensating benefit.

---

## 21. Migration Strategy

`[INFERENCE]`. Nothing here was executed.

### 21.1 Assigning PINs to existing customers

- **Backfill** in bounded batches (e.g. 5,000 rows), restartable, idempotent (`INSERT … ON CONFLICT DO NOTHING` on `userId`). With Option B/C this is an additive `INSERT` into a new table — no lock pressure on `users`. Every customer has a PIN before the feature is enabled.
- **Lazy generation** on first read avoids the backfill but risks a customer reaching ride start with no PIN — the failure lands at pickup, the worst possible moment.
- **Recommended shape:** backfill as the primary path, lazy generation as a safety net for rows created during the rollout window.

### 21.2 Data concerns

- **Duplicates:** expected, ~100 per value at 1M scale. No constraint, no retry loop (§6).
- **Leading zeros:** the PIN must be a **string** end to end — column, DTO, and JSON. Any integer typing silently destroys `0042`. `[CODEBASE]` The existing generator already returns a string and its test explicitly asserts leading zeros are producible ([ride-otp.test.ts:45](tests/unit/rides/ride-otp.test.ts#L45)) — the same discipline must carry over.
- **Failure/retry:** batches must be resumable from the last processed `userId`; a partial backfill must never leave a customer with two PINs.
- **Customer notification:** a permanent credential arriving silently is a support problem. In-app announcement is sufficient; SMS-ing 1M PINs would be both expensive and a mass credential broadcast over an unencrypted channel — not recommended.

### 21.3 Active rides during cutover

Rides already in `ACCEPTED`/`DRIVER_ARRIVING`/`DRIVER_ARRIVED` have an issued `RideOtp` and no PIN expectation. A hard switch would strand them. This is what makes dual-mode (§21.4) necessary rather than optional.

### 21.4 What happens to `RideOtp`

| Option                                 | Assessment                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep temporarily                       | Required for in-flight rides regardless of the final decision                                                                                                                                                                                                                         |
| **Feature flag**                       | `[CODEBASE]` The repo already has the intended flag — `rideConfig.requireStartOtp` — but it is **dead** (defined, never read). Wiring a real, tested flag is prerequisite work, and it must be tested in both positions, since a flag that silently does nothing is what exists today |
| **Dual verification during migration** | Accept either a valid `RideOtp` **or** the customer PIN while both driver and customer app versions are in the field. `[SECURITY]` Note this **widens** the accepted-secret surface for the window it is enabled — it should be time-boxed and monitored, not left on                 |
| Replace                                | Only after dual-mode telemetry shows PIN verification succeeding at the expected rate                                                                                                                                                                                                 |
| Deprecate / remove later               | Table and rows should be retained well past cutover for dispute investigation; removal is a separate, later decision                                                                                                                                                                  |

**Rollback:** the flag must be able to return to OTP-only without a deploy, and the `ride_otps` write path must therefore keep working throughout — i.e. do not stop generating ride OTPs at cutover; stop _requiring_ them.

---

## 22. Testing Strategy

`[INFERENCE]`. Current state `[CODEBASE]`: 8 OTP unit tests, a state-machine suite, a lifecycle-concurrency suite, and one full HTTP ride flow. The _mechanism_ is well covered; the _trust model_ has no coverage at all — which is why the §11 exposure survived three prior audits.

**Unit**

- Generation: exactly 4 characters, `/^\d{4}$/`, leading zeros producible over a large sample, uniform-ish distribution, CSPRNG source.
- Weak-value blacklist behaviour, if adopted (G3).
- Storage round-trip: encrypt→decrypt fidelity (B) **or** hash determinism and pepper dependence (C).
- Verification: correct PIN passes; wrong PIN fails; non-numeric input rejected before it consumes an attempt.

**Integration**

- Customer retrieval returns the PIN on the dedicated endpoint, and **`GET /me` does not**.
- Same PIN returned across two separate retrievals — the constancy property, currently untestable because nothing is constant.
- **Same PIN accepted on two different rides for the same customer** — the defining behavioural test for this feature.
- Driver verification starts the ride; ride reaches `IN_PROGRESS`; `startedAt` set.
- Ride state: `/start` refused from `ACCEPTED` and `DRIVER_ARRIVING`.

**Security** (the section that must not be trimmed)

- Wrong PIN rejected, attempt consumed.
- **Customer B's PIN rejected on Customer A's ride** — the binding test.
- Brute force: per-ride cap, per-customer cross-ride cap, per-driver cap, lockout, and recovery from lockout.
- Driver cannot start another driver's ride (`RideDriverMismatchError`).
- **PIN is absent from the `/accept` response** — the regression test for CRITICAL-1. `[CODEBASE]` Note this test would **fail today**, and `tests/integration/earnings-pipeline.test.ts` currently depends on the opposite behaviour, so that test must be reworked as part of any fix.
- PIN absent from logs, socket payloads, push payloads, and all event payloads.
- Concurrent verification: N parallel attempts consume exactly the cap, never more (mirroring the existing 50-way test).
- Ride cannot start with a missing or empty body.
- No alternate route reaches `IN_PROGRESS`.

**E2E**
Customer logs in → retrieves PIN → books ride → driver accepts (**response contains no PIN**) → driver arrives → customer supplies PIN out of band → driver submits → ride starts → fare and ledger post correctly. `[CODEBASE]` The existing `earnings-pipeline.test.ts` already drives request → accept → arrive → start → complete over real HTTP and is the natural host for this, once the PIN no longer leaks through the accept response.

---

## 23. Risks

| #   | Risk                                                                                                                                                                                                                             | Severity     | Basis                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------- |
| R1  | **The driver already receives the start code.** Building a permanent PIN on this delivery model converts a 15-minute leak into a lifetime one                                                                                    | **CRITICAL** | `[CODEBASE]` §11                   |
| R2  | **Permanent knowledge by past drivers** — every driver who has carried a customer retains their PIN forever; no rotation, no expiry                                                                                              | **CRITICAL** | `[INFERENCE]` §12.2                |
| R3  | **No customer delivery channel exists at all** — the feature cannot function until one is built (no endpoint, no push consumer, socket plugin is a stub)                                                                         | **HIGH**     | `[CODEBASE]` §3.2                  |
| R4  | **No app-level encryption capability** — a viewable permanent PIN requires building crypto + key management from zero                                                                                                            | **HIGH**     | `[CODEBASE]` §8                    |
| R5  | **Attempt budget is scoped per ride, not per customer** — 5 guesses per ride forever is an unbounded lifetime budget against a 10,000-value secret                                                                               | **HIGH**     | `[CODEBASE]` + `[SECURITY]` §12–13 |
| R6  | **Lockout becomes a customer-wide DoS** — a malicious driver could lock a customer out of starting any ride; today's per-ride version already bricks rides permanently with no resend                                            | **HIGH**     | `[SECURITY]` OWASP §13             |
| R7  | **A `UNIQUE` constraint or PIN index would be adopted by reflex** — unsatisfiable past 10,000 customers, and it turns the PIN into an identifier                                                                                 | **MEDIUM**   | `[INFERENCE]` §6                   |
| R8  | **Design-by-blog** — the only static-PIN precedent has no official documentation, and the secondary sources include two claims (driver app displays the PIN; memorable digit patterns) that are security anti-patterns if copied | **MEDIUM**   | `[WEB]` §14                        |
| R9  | **Dead feature flag precedent** — `requireStartOtp` looks functional and does nothing; a migration flag built the same way would fail silently                                                                                   | **MEDIUM**   | `[CODEBASE]` §4                    |
| R10 | **No failure telemetry** — `otpFailure()` is never called, so a guessing campaign against permanent PINs would be invisible                                                                                                      | **MEDIUM**   | `[CODEBASE]` §12.3                 |
| R11 | **Leading-zero corruption** — any integer typing anywhere in the stack silently destroys `0042`                                                                                                                                  | **MEDIUM**   | `[INFERENCE]` §21.2                |
| R12 | **Regression risk in the existing test suite** — the current integration test depends on the driver receiving the plaintext code                                                                                                 | **LOW**      | `[CODEBASE]` §22                   |

---

## 24. Recommended Architecture

**Answering the question posed:** _given the actual Zaroorat codebase and verified industry/security research, what is the safest production-level way to give each customer a permanent visible 4-digit Ride PIN and use it to authorize ride start?_

### Sequencing, in priority order

**First — close the exposure, independent of the PIN decision.** Stop returning `plaintextOtp` from `POST /rides/accept`, and give the customer a channel (in-app on the ride's own read for that customer, plus SMS via the existing `NotificationService`). `[CODEBASE]` R1 makes every downstream control decorative; `[WEB]` Uber, Lyft, and Ola all deliver the code to the customer, and none deliver it to the driver. Doing this alone converts a non-functional verification into a functioning one, and it is prerequisite to any PIN work — a PIN shipped on the current channel is strictly worse than today.

**Then — if the permanent PIN is adopted:**

**Storage: Option C (dedicated table, HMAC via the existing `OtpHasher`, reveal-once + device cache), unless permanent server-side reveal is a hard product requirement — in which case Option B (dedicated table, AEAD-encrypted, `keyVersion` from day one).**

Rationale: `[CODEBASE]` Option C is the only PIN option that adds no new cryptographic infrastructure to a codebase whose `src/shared/crypto/index.ts` is `export {};`, and it keeps the strongest at-rest posture — a DB dump is useless without the pepper, and there is no decryption path to abuse. The customer's practical experience is preserved by caching the revealed PIN in platform secure storage, which also solves offline access at pickup better than any server round-trip. If the product insists the server must be able to re-display the PIN indefinitely, that is Option B, and it should be scoped honestly as _building and operating field encryption_, not as _adding a column_.

**Both variants share:**

- **Dedicated table, not a `users` column** — isolation, least-privilege grants, no accidental inclusion in user projections, clean additive migration, and a natural home for `rotatedAt`/`keyVersion`.
- **No `UNIQUE` constraint and no index on the PIN.** `[INFERENCE]` §6 — unsatisfiable past 10,000 customers, and indexing a credential only helps an attacker with DB access.
- **Generation:** single CSPRNG draw, `String(randomInt(0, 10000)).padStart(4, '0')`, string-typed end to end, with a small weak-value blacklist (G3) — worth it precisely because the value is permanent.
- **Retrieval:** a dedicated endpoint, never `GET /me`, rate-limited `keyBy: 'user'`, with the existing `requireUntamperedDevice` gate available.
- **Verification:** inside the existing `startRide` transaction. `[CODEBASE]` Only the verifier lookup changes; lock, driver-ownership, state gate, CAS, and event publishing are untouched and already tested. The lookup is `ride.customerId → that customer's row`, never `WHERE pin = ?`.
- **Throttling:** mirror `OtpRateLimiter`'s multi-axis Redis pattern — per customer (rolling window), per driver, per IP, plus lockout — with `otpFailure()` finally emitting. `[SECURITY]` NIST requires per-account throttling for sub-64-bit authenticators and advises per-source too; OWASP's 5–10 attempt guidance sets the per-ride number. A lockout-recovery path must ship _with_ the lockout (R6).
- **Migration:** batched, restartable, idempotent backfill with lazy generation as a safety net; dual verification behind a **real, tested** feature flag (not the `requireStartOtp` pattern); `ride_otps` generation continues throughout so rollback needs no deploy.

### The product trade-off, stated plainly

`[WEB]` Four of five researched platforms use per-ride codes, and the three with official documentation (Uber, Lyft, Ola) all do; Uber and Lyft additionally make PIN verification **opt-in**. The single static-PIN precedent, Rapido, has **no official documentation** and its backend is unverified. `[INFERENCE]` The static PIN's advantage is genuine and is a UX advantage — nothing to look up, nothing to wait for, works offline, fewer failed pickups. Its cost is R2: the credential never rotates, so every past driver retains it permanently, which weakens exactly the fraud scenario the design is reported to target.

That is a product decision, not an engineering one, and this report does not make it. If it is made in favour of the static PIN, the architecture above is the safest way this codebase can carry it. If a middle path is wanted, the Uber/Lyft pattern — per-ride code by default, mandatory rather than opt-in — is what the documented industry does, and Zaroorat is one delivery-channel fix away from having it.

---

## Final Decision Matrix

Recommendations, not decisions — implementation remains deferred.

| Decision                | Option                                                                                                                                                            | Reason                                                                                                                                                | Evidence                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **PIN ownership**       | Customer-scoped, dedicated table keyed on `userId`                                                                                                                | Isolation, least privilege, clean additive migration, natural home for rotation metadata                                                              | `[CODEBASE]` modular Prisma schema; `[INFERENCE]` §19–20                                        |
| **PIN generation**      | `String(randomInt(0, 10000)).padStart(4, '0')`, string-typed, small weak-value blacklist                                                                          | CSPRNG, uniform, leading zeros preserved; blacklist matters because the value is permanent. Reject memorable-pattern generation                       | `[CODEBASE]` existing `randomInt` pattern; `[WEB]` §14 anti-pattern; `[SECURITY]` §7            |
| **PIN storage**         | **C** — HMAC via existing `OtpHasher`, reveal-once + device cache. **B** (AEAD, `keyVersion`) only if permanent server-side reveal is mandatory                   | C adds zero new crypto to a repo with `src/shared/crypto/index.ts` = `export {};` and no `createCipheriv` anywhere                                    | `[CODEBASE]` §8, §20                                                                            |
| **PIN uniqueness**      | **No unique constraint, no index on the PIN**                                                                                                                     | Unsatisfiable past 10,000 customers; a unique PIN would make it an identifier, which the brief forbids; an index helps only an attacker               | `[INFERENCE]` §6                                                                                |
| **Customer retrieval**  | Dedicated endpoint, rate-limited `keyBy: 'user'`; **never** in `GET /me`                                                                                          | `/me` is the widest-cached, most-logged payload; a credential does not belong in it                                                                   | `[CODEBASE]` `toAccountView` §9; `[INFERENCE]`                                                  |
| **Driver verification** | Inside existing `startRide`; swap only the verifier lookup, resolved via `ride.customerId`                                                                        | Lock, ownership, state gate, CAS, transaction already exist and are tested                                                                            | `[CODEBASE]` §10                                                                                |
| **Attempt protection**  | Retain per-ride cap (5); **add per-customer rolling budget**                                                                                                      | Per-ride caps are the wrong unit for a permanent secret — 5/ride forever is unbounded                                                                 | `[SECURITY]` NIST per-account throttling; OWASP 5–10; `[CODEBASE]` §12.3                        |
| **Rate limiting**       | Multi-axis Redis (customer + driver + IP) modelled on `OtpRateLimiter`, plus `fastify.rateLimit` on the lifecycle routes; ship lockout **with** its recovery path | The pattern already exists and is production-proven; lockout without recovery is a DoS                                                                | `[CODEBASE]` `OtpRateLimiter`, `rateLimits.rideWrite` unapplied; `[SECURITY]` OWASP DoS warning |
| **Ride binding**        | `ride.customerId → customer verifier`; never `WHERE pin = ?`                                                                                                      | At 1M scale a PIN lookup returns ~100 candidates and is meaningless as identity                                                                       | `[INFERENCE]` §6; `[CODEBASE]` `rides.customer_id` FK indexed                                   |
| **Existing `RideOtp`**  | Keep; dual-verify behind a **real, tested** feature flag; deprecate only after telemetry; retain rows for disputes                                                | In-flight rides would otherwise be stranded; `requireStartOtp` proves a flag can look functional and do nothing                                       | `[CODEBASE]` §4, §21.4                                                                          |
| **Migration**           | Batched, restartable, idempotent backfill + lazy fallback; keep generating ride OTPs so rollback needs no deploy                                                  | Additive `INSERT`, no lock pressure on `users`; lazy-only risks failure at pickup                                                                     | `[INFERENCE]` §21                                                                               |
| **Testing**             | Ship the security block in full — binding, brute force, lockout recovery, concurrency, and **PIN-absent-from-accept-response**                                    | The trust model has zero coverage today, which is why the exposure survived three audits; the current integration test asserts the opposite behaviour | `[CODEBASE]` §22                                                                                |

---

## Explicit Answers

**1. How can 1 million customers use only 10,000 PIN values?**
Because the PIN is a _verifier_, not an _identifier_. ~100 customers share each value at 1M scale, and it does not matter: the backend never searches by PIN. Identity comes from `ride.customerId`, and the submitted PIN is compared against exactly one expected value. Two customers holding `4827` never interact. `[INFERENCE]` §6

**2. Should PINs be unique?**
**No — a `UNIQUE` constraint is incorrect and unsatisfiable.** Past 10,000 customers the pigeonhole principle guarantees collisions; the constraint would break registration and, long before that, turn assignment into a retry storm. It would also make the PIN an identifier, which the requirement explicitly forbids. Do not index the column either. `[INFERENCE]` §6

**3. Where should the PIN belong?**
A dedicated customer-credential table keyed on `userId` — not a column on `users`. Isolation, least-privilege access, no accidental inclusion in user projections, clean additive migration, and a natural home for `rotatedAt`/`keyVersion`. `[INFERENCE]` §19–20

**4. How should it be generated?**
`String(randomInt(0, 10000)).padStart(4, '0')` using `node:crypto`, string-typed end to end so leading zeros survive, with a small weak-value blacklist. No collision check, no retry loop. Reject memorability-optimised patterns. `[CODEBASE]` + `[SECURITY]` §7

**5. How should it be stored?**
Preferably **one-way HMAC** via the existing `OtpHasher` with reveal-once + device-side caching — the only option needing no new crypto in a repo that has none. If permanent server-side reveal is a hard requirement, **AEAD encryption with versioned keys**, scoped honestly as new infrastructure. Never plaintext. `[CODEBASE]` §8, §20

**6. How does the customer retrieve it?**
Through a dedicated, rate-limited endpoint — never `GET /me`. Masked by default with an explicit reveal, cached in platform secure storage so it works offline at pickup. `[INFERENCE]` §9

**7. How does the driver submit it?**
`POST /api/v1/rides/:id/start` with the PIN in the body — the existing endpoint, with its existing JWT auth, `requireOperableDriver` gate, and `ride.driverId` ownership check. `[CODEBASE]` §10

**8. How does the backend identify the correct customer?**
`driver JWT → Driver.id → ride.driverId must match → ride.customerId → that customer's stored verifier`. The PIN never participates in identification. `[CODEBASE]` §6, §10

**9. How do we prevent brute force?**
Multi-axis Redis throttling modelled on the existing `OtpRateLimiter`: per ride (retain 5), **per customer on a rolling window** (the axis that matters for a permanent secret), per driver, per IP, plus lockout with exponential backoff — and a recovery path shipped alongside it, since OWASP warns lockout is itself a DoS vector. Emit `otpFailure()` so campaigns are visible. `[SECURITY]` + `[CODEBASE]` §12–13

**10. How do we prevent the driver from receiving the expected PIN?**
Stop returning `plaintextOtp` from `POST /rides/accept`, and never place the verifier in any driver-facing response, event, socket payload, or log. Add a regression test asserting the accept response contains no code — noting that test fails today and that `earnings-pipeline.test.ts` currently depends on the opposite. `[CODEBASE]` §11, §22

**11. What happens to the current `RideOtp`?**
Kept. Dual verification behind a real, tested feature flag during rollout — in-flight rides already hold issued OTPs and would otherwise be stranded. Ride OTPs keep being generated throughout so rollback needs no deploy. Deprecation only after telemetry confirms PIN verification is healthy; rows retained for dispute investigation. `[CODEBASE]` §21.4

**12. What must be implemented before production?**
Closing the driver exposure and building a customer delivery channel (prerequisite to everything); PIN storage + generation + backfill; the dedicated retrieval endpoint; the `ride.customerId` verification traversal; per-customer and per-driver throttling with lockout **and** recovery; the feature flag, actually wired; and the full security test block including the binding and code-withholding tests.

**13. What can be deferred?**
Customer-initiated PIN regeneration (support-mediated rotation suffices for v1); biometric/step-up re-authentication on reveal (device-local gating is enough initially); PIN-history/rotation auditing beyond a `rotatedAt` timestamp; automated key rotation if Option B is chosen (`keyVersion` in the schema from day one makes it deferrable rather than a rewrite); and `RideOtp` removal, which should wait well past cutover.

---

## Sources

- [What's Verify my Ride? — Uber Help (official)](https://help.uber.com/riders/article/whats-verify-my-ride/?nodeId=2ddbb5e8-0dd3-4048-b9ee-f6b5e5311e25)
- [PIN verification for drivers — Uber (official)](https://www.uber.com/en-US/blog/pin-verification-drivers)
- [PIN verification for riders — Lyft Help (official)](https://help.lyft.com/hc/en-us/rider/articles/6319159425-PIN-verification-for-riders)
- [PIN verification for drivers — Lyft Help (official)](https://help.lyft.com/hc/en-us/driver/articles/8674172880-pin-verification-for-drivers)
- [Start your Ola rides easily with an OTP — Ola Cabs blog (official)](https://blog.olacabs.com/start-your-ola-rides-easily-with-an-otp/)
- [nammayatri/nammayatri — open-source mobility platform](https://github.com/nammayatri/nammayatri)
- [Namma Yatri — Home](https://www.nammayatri.in/)
- [Rapid PIN — A smart way to unlock your Rapido Rides (Medium, secondary — not official Rapido)](https://aditi-halder.medium.com/rapid-pin-a-smart-way-to-unlock-your-rapido-rides-3f6378d45948)
- [Why Rapido Uses a Static PIN (renderlog, secondary — cites no official Rapido source)](https://renderlog.in/blog/rapido-rapid-pin-static-otp/)
- [Why Rapido gives you the same OTP every trip (Medium, secondary)](https://medium.com/@uditjain_100/why-rapido-gives-you-the-same-otp-every-trip-and-why-uber-doesnt-25a530a8e5a3)
- [NIST SP 800-63B — Digital Identity Guidelines, Authentication](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP — Blocking Brute Force Attacks](https://owasp.org/www-community/controls/Blocking_Brute_Force_Attacks)
- [OWASP WSTG — Testing for Weak Lock Out Mechanism](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/04-Authentication_Testing/03-Testing_for_Weak_Lock_Out_Mechanism)
