# Platform — Current Production Workflow and Implementation Plan

**Repository:** `backend_zaroorat` · **Branch:** `feature/auth` · **HEAD:** `269e927`
**Date:** 2026-08-20
**Type:** Investigation + production planning. No code changed, no file moved, no migration, no refactor, no new endpoint.

**Evidence labels:** `CODEBASE VERIFIED` · `TEST VERIFIED` · `SCHEMA VERIFIED` · `BUILD VERIFIED` · `INFERENCE`
**Prior-audit classification:** `CONFIRMED` · `CHANGED` · `FIXED` · `STALE` · `NOT_VERIFIABLE`

---

## 1. Executive Summary

**The most important finding of this pass is that three P0s from the earliest driver audit are now FIXED** — by work committed today. `docs/DRIVER_ONBOARDING_CODEBASE_AUDIT.md` named three blockers (implicit creation via `GET /me`, missing email collection, `P2002` concurrency crash) and all three are resolved in `b7f7da7`. Its P1 (customer accidentally creating a Driver) is fixed as a consequence. **Its own recommended implementation steps 1 and 2 were completed today.** `CODEBASE VERIFIED`

**30 audit documents now exist in `docs/`** (~1.5 MB). This report verifies the two that predate the current session against live code, and re-verifies the rest. **One prior conclusion is downgraded** — see §1.2.

**Platform health is good:** typecheck `PASS`, lint `PASS`, build completes end-to-end, 714/714 unit tests, working tree clean. `format:check` fails on 34 files, **all outside `src/`**, and it is **CI's first gate**. `BUILD VERIFIED`

**Two transitions block the entire driver lifecycle**, unchanged across four verification passes:

1. **Document `PENDING → VERIFIED`** — no production writer anywhere.
2. **Driver `VERIFIED` → `driver` role** — `grantRole` has zero production callers.

Because `setOnline` requires a `VERIFIED` driving licence, **no driver in the system can go online.** Fixing (1) and (2) is sufficient to reach ONLINE for the first time.

**Two independent money gaps**, both cheap: `SettlementJob` is registered but **never scheduled** (absent from both job maps), and `DriverWallet` is **only ever created, never updated**. The ledger beneath them is correct — `completeRide` posts proper double-entry `DRIVER_PAYABLE` in-transaction.

**Zero files should move to another top-level module.** §20.

### 1.1 Prior-audit verification summary

| Prior finding                                             | Source                                      | Status today                                                                                 |
| --------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /me` creates a Driver as a GET side effect           | `DRIVER_ONBOARDING_CODEBASE_AUDIT.md` P0    | **FIXED** (`b7f7da7`) — pure `findByUserId`                                                  |
| Email cannot be collected                                 | same, P0                                    | **FIXED** — `email` in `updateDriverProfileSchema`, persisted to `users.email`               |
| Concurrent onboarding → unhandled `P2002` → 500           | same, P0                                    | **FIXED** — caught, winner re-read                                                           |
| Customer can accidentally create a Driver                 | same, P1                                    | **FIXED** — consequence of the above                                                         |
| No explicit `PROFILE_COMPLETE` state                      | same, P2                                    | **CONFIRMED as a gap, CHANGED as a recommendation** — §1.2                                   |
| No HTTP integration tests for onboarding                  | same + `..._IMPLEMENTATION_VERIFICATION.md` | **CONFIRMED — still open**                                                                   |
| Documents can be submitted before the profile is complete | `..._IMPLEMENTATION_VERIFICATION.md` P1     | **CONFIRMED** — `submitDocument` never reads the profile                                     |
| Email write to `User` is a **PASS**                       | `..._IMPLEMENTATION_VERIFICATION.md` §5     | **CHANGED — downgraded to a defect** — §1.2                                                  |
| `driver.registered` event exists                          | `DRIVER_ONBOARDING_CODEBASE_AUDIT.md` §2    | **STALE** — no such event in `DRIVER_EVENT_CATALOG`; the published one is `driver.onboarded` |
| Document review, `grantRole`, dispatch, settlement gaps   | later audits                                | **CONFIRMED** — unchanged                                                                    |

### 1.2 Two corrections to prior conclusions

**(a) Email write — prior audit says PASS, this audit says defect.**
`DRIVER_ONBOARDING_IMPLEMENTATION_VERIFICATION.md` §5 marks the email path **PASS** because it "correctly reaches back into the `User` model (`client.user.update`)". That is true functionally and wrong architecturally: `DriverRepository.updateProfile` issues a **raw Prisma write**, bypassing `UserRepository.updateEmail` — which exists and _is_ used by `UserService`. Consequences: a `users_email_key` collision surfaces as **500, not 409**; `isEmailVerified` is never managed; two write paths to one unique column will drift. **CHANGED — downgraded from PASS to P1.** `CODEBASE VERIFIED`

**(b) `PROFILE_COMPLETE` state — prior audit recommends adding one; this audit does not.**
The _gap_ is real and confirmed. The _fix_ differs. `Driver.verificationStatus` is already the explicit state machine, and `findByUserId` returns profile + documents + onlineStatus in one read — enough to derive readiness. Adding an `onboardingStep` column duplicates data the schema already carries and creates a new consistency burden. **What is actually missing is a declared required-field/required-document set and a server-side gate in `submitDocument`, not a new column.** `INFERENCE` from `SCHEMA VERIFIED` facts.

---

## 2. Current Git / Build / CI Health

`BUILD VERIFIED` — executed this session.

| Check                      | Status                                                      | Category                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Branch / HEAD              | `feature/auth` @ `269e927`                                  | —                                                                                                                                         |
| Working tree               | **CLEAN** (`src/`, `prisma/`, `tests/`)                     | —                                                                                                                                         |
| `npm run typecheck`        | **PASS** (both tsconfigs)                                   | —                                                                                                                                         |
| `npm run lint`             | **PASS** (`--max-warnings=0`)                               | —                                                                                                                                         |
| `npm run build`            | **PASS** — `clean` → `tsc` → `tsc-alias` → `copy-generated` | —                                                                                                                                         |
| `npm run prisma:validate`  | **PASS**                                                    | —                                                                                                                                         |
| `npm run test:unit`        | **PASS** — 714/714, 142 suites                              | —                                                                                                                                         |
| `npm run test:integration` | **NOT_VERIFIABLE**                                          | Infrastructure unavailable — no local Postgres/Redis; Docker daemon unreachable. **CI runs them** with PostGIS + Redis service containers |
| `npm run format:check`     | **FAIL** — 34 files                                         | **PRE-EXISTING CI FAILURE**                                                                                                               |

**Recent commits (today):**

```
269e927  chore(logger): keep otp and phone readable in development logs only
b7f7da7  feat(driver): add explicit onboarding endpoint and driver email capture
eb3e062  feat(auth): allow email updates through the user profile endpoint
```

### 2.1 `format:check` — evidence and recommendation

CI `quality` job order: **`format:check` → `lint` → `typecheck`.** The first step fails, so **nothing merges**.

The 34 files are in `ride-demo-frontend/`, `.specify/` templates, and `docs/*.md`. **Zero are in `src/`.**

| Option                           | Assessment                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(1) `npm run format`**         | Rewrites frontend files that may be someone else's in-flight work, and reformats Spec Kit templates that are vendor-managed                                                                   |
| **(2) Extend `.prettierignore`** | **Recommended.** `ride-demo-frontend/` is a separate app with its own conventions; `.specify/` is generated by the Spec Kit tool; `docs/` is prose. None benefits from backend Prettier rules |

**Recommendation: (2)**, adding `ride-demo-frontend/`, `.specify/`, and `docs/` to `.prettierignore`. `INFERENCE` — **not applied in this phase.**

---

## 3. Current Module Map

`CODEBASE VERIFIED` — 23 modules. Registered HTTP surface: `/health`, `/ready`, `/metrics`, `/api/v1/{auth,users,files,rides,drivers,payments}`.

| Module                                                                                                                                                                  | Status      | Routes             | Jobs                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------ | ----------------------------------------------------------- |
| `auth`                                                                                                                                                                  | **WORKING** | `/api/v1/auth`     | `authRetentionJob`, `otpDeliveryJob`                        |
| `users`                                                                                                                                                                 | **WORKING** | `/api/v1/users`    | `accountErasureJob`                                         |
| `files`                                                                                                                                                                 | **WORKING** | `/api/v1/files`    | `fileSweeperJob`, `fileRetentionJob`, reconciliation        |
| `payments`                                                                                                                                                              | **PARTIAL** | `/api/v1/payments` | `reconciliationJob` ✅ · **`settlementJob` ❌ unscheduled** |
| `rides`                                                                                                                                                                 | **PARTIAL** | `/api/v1/rides`    | `dispatchTimeoutJob`, `requestExpiryJob`                    |
| `drivers`                                                                                                                                                               | **PARTIAL** | `/api/v1/drivers`  | `heartbeatTimeoutJob` ✅ · `docExpirationJob` (inert)       |
| `geo`                                                                                                                                                                   | **PARTIAL** | none               | none                                                        |
| `notifications`                                                                                                                                                         | **PARTIAL** | none               | none                                                        |
| `vehicles`, `dispatch`, `matching`, `admin`, `support`, `documents`, `onboarding`, `riders`, `pricing`, `promotions`, `reviews`, `chat`, `sos`, `analytics`, `settings` | **STUB**    | none               | none                                                        |

---

## 4. Full Customer Workflow

`CODEBASE VERIFIED`

```
phone → POST /auth/otp/send  → OtpService.send                      [WORKING]
     → POST /auth/otp/verify → AuthService.verifyOtp (1 transaction)[WORKING]
        otpService.verify → resolveAccount (find-or-create, P2002)
        → ensureDefaultRole('customer') → assertAuthenticatable
        → userProfile.ensureExists → deviceService.register
        → findActiveRoleSlugs → session → issuePair
     → GET/PATCH /users/me/*                                        [WORKING]
     → POST /rides/quote                                            [WORKING]
     → POST /rides/requests → RideRequest(CREATED)                  [WORKING]
        └─ publish ride.requested → ZERO SUBSCRIBERS                [DISCONNECTED]
```

**The Customer flow is production-solid and imports nothing from `drivers/`.** Any driver work is safe for it. `CODEBASE VERIFIED`

---

## 5. Full Driver Workflow

| Step                               | Status             | Evidence                                             |
| ---------------------------------- | ------------------ | ---------------------------------------------------- |
| Phone → OTP → User → JWT           | **WORKING**        | Same two endpoints; no driver branch                 |
| `POST /drivers/me/onboard`         | **WORKING**        | Explicit, idempotent, `P2002`-safe — **fixed today** |
| Profile (name/gender/email)        | **PARTIAL**        | Persists; raw `users.email` write                    |
| File upload via Files              | **DISCONNECTED**   | `drivers/` never imports `@modules/files`            |
| Document submission                | **PARTIAL**        | `fileUrl: z.string().url()` — any URL                |
| **Document review**                | **MISSING**        | ⛔ no writer of `VERIFIED`                           |
| Driver approval                    | **PARTIAL**        | Approves with zero documents                         |
| **DRIVER role**                    | **DISCONNECTED**   | ⛔ `grantRole` 0 callers                             |
| Eligibility / ONLINE               | **BLOCKED**        | by document review                                   |
| Location → Geo index               | **PARTIAL**        | works, no eligibility gate                           |
| Nearby discovery                   | **DISCONNECTED**   | 0 callers outside geo                                |
| Matching / dispatch / offer / push | **STUB / MISSING** | —                                                    |
| Accept → active ride               | **PARTIAL**        | no offer/vehicle/concurrency checks                  |
| BUSY / ON_TRIP                     | **MISSING**        | no writer                                            |
| Arrive → start → complete          | **WORKING**        | row locks, CAS, start-OTP                            |
| Payment ledger                     | **WORKING**        | `recordTripPayment` in-transaction                   |
| Settlement                         | **DISCONNECTED**   | job never scheduled                                  |
| Wallet projection                  | **MISSING**        | never updated                                        |

---

## 6. Full Admin Workflow

`CODEBASE VERIFIED` — `admin/` and `support/` are `export {};`. No `/api/v1/admin` prefix.

| Capability                        | State                                                       |
| --------------------------------- | ----------------------------------------------------------- |
| Approve/reject a driver           | ✅ `POST /drivers/:id/verify` `roles:['admin']`             |
| Suspend/unsuspend                 | ⚠️ `POST /:id/suspend` — **suspend deadlocks**              |
| Read a driver's location / wallet | ✅ staff bypass in `authorizedDriverId`                     |
| Read another user's file          | ✅ `decideRead` operator scopes                             |
| Payout execution                  | ✅ `finance`/`admin`                                        |
| **Pending-driver queue**          | ❌ missing                                                  |
| **Pending-document queue**        | ❌ missing                                                  |
| **Document review**               | ❌ missing                                                  |
| **Audit log**                     | ❌ no `AuditLog` model (`audit.prisma` is one comment line) |

> **Admin should not own driver business rules.** `reviewDriverVerification` locks the driver row and drives the state machine — Driver domain regardless of initiator. Admin should add the _queue/list_ surface and call Driver services. `INFERENCE`

---

## 7. Auth and Role Workflow

| #   | Question                                       | Answer                                                                                                                                                         |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Customer/Driver share identity?                | **YES** — `Driver.userId @unique` FK to `User.id`                                                                                                              |
| 2   | Can OTP create a Driver?                       | **NO** — fixed today                                                                                                                                           |
| 3   | Is User creation correct?                      | **YES** — only in `resolveAccount`, `P2002`-safe                                                                                                               |
| 4   | Default role secure?                           | ⚠️ `DEFAULT_ROLE_SLUG = process.env.DEFAULT_USER_ROLE ?? 'customer'`                                                                                           |
| 5   | **Do revoked roles return on login?**          | **YES, for the default role** — `ensureDefaultRole` runs on **every** login and re-grants when no live assignment exists. Revoking `customer` is not durable   |
| 6   | **Can env config grant admin?**                | **YES** — `DEFAULT_USER_ROLE` is **absent from `EnvironmentSchema`**, so unvalidated at boot. `DEFAULT_USER_ROLE=admin` grants admin to every account at login |
| 7   | Authorization uses current assignments?        | **YES** — read at issuance and re-read on refresh; epoch invalidates stale claims                                                                              |
| 8   | Customer flow isolated from driver onboarding? | **YES** — no import edge                                                                                                                                       |

**Roles are un-injectable by construction:** no `role`/`roles`/`userType`/`appType` field in any auth request schema; Zod strips unknown keys.

---

## 8. Driver Onboarding Workflow

| Check                                    | Result                                                 |
| ---------------------------------------- | ------------------------------------------------------ |
| `GET /drivers/me` read-only              | ✅ **FIXED**                                           |
| `POST /me/onboard` explicit              | ✅ **FIXED**                                           |
| Concurrency-safe                         | ✅ **FIXED** — `P2002` re-read + `drivers_user_id_key` |
| One User → one Driver                    | ✅ DB-enforced                                         |
| One Driver → one DriverProfile           | ✅ DB-enforced                                         |
| Email on shared User identity            | ✅ correct location, ⚠️ wrong write path               |
| BOLA / IDOR                              | ✅ `callerId(req)`; `:driverId` parsed and **ignored** |
| Resume after restart                     | ✅ one read returns everything                         |
| Idempotent                               | ✅                                                     |
| Arbitrary `userId`/`driverId` injectable | ❌ no                                                  |
| Documents before profile complete        | ❌ **YES — gap confirmed**                             |

> **Is an `onboardingStep` column necessary? NO.** §1.2(b). What is needed is a declared required-field set and a gate in `submitDocument`. `INFERENCE`

---

## 9. Driver Documents Workflow

**Ownership boundary — correct as-is:**

| Owner       | Concerns                                                                            |
| ----------- | ----------------------------------------------------------------------------------- |
| **Files**   | bytes, object storage, access, ownership, metadata, purpose                         |
| **Drivers** | `DriverDocument` record, type, number, expiry, KYC status, eligibility relationship |

> **`DriverDocument` should NOT move to Files.** Types are entirely driver KYC; `VehicleDocument` already exists as a separate model — the schema author chose per-domain document tables. `SCHEMA VERIFIED` + `INFERENCE`

**Current API accepts arbitrary `fileUrl`** — `fileUrl: z.string().url()`. **`fileId` should be used instead.** `drivers/` does not import `@modules/files` at all.

**Every writer of `DriverDocument.verificationStatus`:**

| Status         | Production writer                                                                 |
| -------------- | --------------------------------------------------------------------------------- |
| `PENDING`      | `DriverDocumentRepository.upsertDocument` (both branches)                         |
| `REJECTED`     | `DocExpirationJob:23` — **the only caller of `updateVerificationStatus`**         |
| **`VERIFIED`** | **NONE** ⛔ **LIFECYCLE BLOCKER**                                                 |
| `EXPIRED`      | **status does not exist** — `VerificationStatus` is `PENDING\|VERIFIED\|REJECTED` |

`verifiedBy`, `verifiedAt`, `verificationNotes` — **never written**. `rejectionReason` — only the expiry job's fixed string.

---

## 10. Driver Verification and Role Workflow

| #   | Question                                            | Answer                                                                                                                                                                                                         |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Approve with zero documents?                        | **YES** — documents table never queried                                                                                                                                                                        |
| 2   | Approve with rejected/missing required docs?        | **YES**                                                                                                                                                                                                        |
| 3   | Single required-document rule?                      | **NO — none declared anywhere**                                                                                                                                                                                |
| 4   | Is `requireApprovedDocuments` consumed?             | **NO — zero consumers** (default `true`)                                                                                                                                                                       |
| 5   | What writes `Driver.verificationStatus = VERIFIED`? | `OnboardingService.reviewDriverVerification`, via `POST /drivers/:id/verify`                                                                                                                                   |
| 6   | What calls `grantRole`?                             | **Nothing** — 1 ref in `src/` = its definition                                                                                                                                                                 |
| 7   | Does a verified driver get the `driver` role?       | **NO**                                                                                                                                                                                                         |
| 8   | Do ride APIs depend on the role?                    | **Write routes: no** (they use `requireOperableDriver`). **Read routes: yes** — `GET /rides/active` and `/history` branch on `callerHasRole(req,'driver')`, so a real driver is served **customer** data today |
| 9   | If approval succeeds but the grant is delayed?      | Driver passes `requireOperableDriver` and can go online, but the two read endpoints stay wrong until refresh                                                                                                   |

**Dependency direction — verified:** `DriverAccessRepository` imports **only `@core/database`** and reads `this.client.driver`. **There is no `auth → drivers` import edge.** A `drivers → auth` import would **not** create a cycle.

### 10.1 Option A vs Option B

|                   | **A — grant inside the approval transaction**                                                                         | **B — `driver.verified` → outbox → Auth subscriber**                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Cycle risk        | **none**                                                                                                              | none                                                                                                                   |
| Atomicity         | strong — role and status commit together                                                                              | eventual window                                                                                                        |
| Precedent in repo | none                                                                                                                  | **matches `EpochInvalidationConsumer`, the only subscriber**                                                           |
| Failure mode      | rolls back visibly                                                                                                    | outbox retry ⇒ at-least-once; `grantRole` idempotent (service check **+** `uq_user_role_active`) ⇒ redelivery harmless |
| Caution           | `grantRole` bumps the epoch **after** commit — inside an outer transaction the bump fires **before** the outer commit | app must tolerate a brief `VERIFIED`-without-role window                                                               |

> **Recommendation: Option B**, on current-architecture evidence — it is the only cross-module side-effect pattern the repository already uses, the outbox guarantees no lost grants, `grantRole` is idempotent twice over, and it avoids the epoch-ordering hazard in A. **Option A is also safe** and simpler if atomicity is valued more.
>
> **`DECISION_REQUIRED`** — the architecture supports both; the trade-off is the owner's.

---

## 11. Driver Online / Shift Workflow

| Gate                              | Present                    | Status                    |
| --------------------------------- | -------------------------- | ------------------------- |
| Driver exists                     | ✅                         | `WORKING`                 |
| `verificationStatus === VERIFIED` | ✅ guard **and** service   | `WORKING`                 |
| `!isSuspended`                    | ✅ both                    | `WORKING`                 |
| **`DRIVING_LICENSE` `VERIFIED`**  | ✅                         | **IMPOSSIBLE TO SATISFY** |
| Existing active shift             | ✅ idempotent `startShift` | `WORKING`                 |
| Licence expiry                    | ❌                         | `MISSING`                 |
| Vehicle                           | ❌                         | **correct — see §13**     |
| Active-ride conflict              | ❌                         | `MISSING`                 |

**Shift chain:** `startShift` (idempotent under row lock) → heartbeat → `HeartbeatTimeoutJob` (`* * * * *`) → `setOffline` → `endShift` computes `totalOnlineMinutes`. **Every other shift statistic stays at its default.** `heartbeatAt = null` drivers are **never swept**. `maxContinuousShiftHours` (12) has **zero consumers** — **shift limits are not enforced**.

**Suspension self-deadlock — confirmed:** `setSuspended` holds `SELECT … FOR UPDATE`, then calls `setOffline`, which opens a **second** transaction (`TransactionManager.execute` never joins an in-flight one) and locks the same row. Blocks → Prisma 5 s timeout → fails. The body is also a raw cast with no Zod schema.

---

## 12. Driver Location / Geo Workflow

| Driver state         | Can update location? | Enters live geo index? | Should it?                         |
| -------------------- | -------------------- | ---------------------- | ---------------------------------- |
| `PENDING`            | **YES**              | **YES**                | ❌ no                              |
| `DOCUMENT_REVIEW`    | **YES**              | **YES**                | ❌ no                              |
| `VERIFIED` + OFFLINE | **YES**              | **YES**                | ❌ no                              |
| Suspended            | **YES**              | **YES**                | ❌ no                              |
| `VERIFIED` + ONLINE  | YES                  | YES                    | ✅ yes                             |
| `BUSY` / `ON_TRIP`   | n/a — never written  | n/a                    | ✅ update yes, **discoverable no** |

**Recommended production rule** (`INFERENCE`, evidence-based):

- **Accept location** from any driver whose status is `ONLINE`, `BUSY`, or `ON_TRIP` — position is needed during a trip.
- **Include in nearby discovery** only `ONLINE` + `isAvailable` + `VERIFIED` + `!isSuspended` + fresh.
- Enforce in **two** places: an eligibility gate on `POST /drivers/location`, **and** a driver-state filter in `findNearbyDrivers` — because `PostgisProvider` currently queries `driver_locations` alone with no join to `drivers`.

---

## 13. Vehicle Workflow

`vehicles/` is `export {};` — **schema only, no code.**

| Concern                                                                                               | Schema                            | Code            |
| ----------------------------------------------------------------------------------------------------- | --------------------------------- | --------------- |
| `Vehicle`, `VehicleType`, `VehicleDocument`, `VehicleImage`, `VehicleInspection`, `VehicleAssignment` | ✅ complete                       | ❌ none         |
| `VehicleAssignment` uniqueness                                                                        | ❌ **only `@@index([driverId])`** | ❌ no code      |
| `Driver.currentVehicleId`                                                                             | ⚠️ no `@relation`, no FK          | ❌ 0 references |

**Can a driver have multiple ACTIVE assignments? YES** — no database protection, no service protection.

**Where does vehicle validation belong? — from schema, not preference:**

| Fact                                           | Implication                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `rides.vehicle_id` **NOT NULL**                | ride cannot exist without a vehicle → **hard gate at ACCEPT** |
| `RideDispatch.vehicleId` **nullable**          | offer may exist without one → **no gate at OFFER**            |
| `DriverOnlineStatus` has **no vehicle column** | availability modelled independently → **no gate at ONLINE**   |

**Answer: ACCEPT.** Adding a vehicle requirement to `setOnline` would contradict a schema deliberately built without one. `SCHEMA VERIFIED`

**One active assignment per driver needs all three:** service validation + transaction locking + **partial unique index** (`WHERE released_at IS NULL AND status = 'ACTIVE'`). The codebase already uses partial uniques in three places.

---

## 14–15. Ride Matching and Dispatch Workflow

`matching/` and `dispatch/` are both `export {};`.

| Symbol                                                                             | Production callers          | Class                 |
| ---------------------------------------------------------------------------------- | --------------------------- | --------------------- |
| `findNearbyDrivers`                                                                | 0 outside geo               | `DISCONNECTED`        |
| `offerToDriver`                                                                    | **0**                       | `DISCONNECTED`        |
| `RideDispatchRepository.createOffer` / `findByRequestAndDriver` / `updateResponse` | **0**                       | `DISCONNECTED`        |
| `findActiveByDriver`                                                               | **0**                       | `DISCONNECTED`        |
| `claimForMatch`                                                                    | **1** — `acceptRideRequest` | `CONNECTED`           |
| `DispatchTimeoutJob`                                                               | scheduled ✅, empty table   | `PARTIALLY_CONNECTED` |

`ride.requested` → **zero subscribers** → chain ends.

> **The missing piece is the orchestrator, not the primitives.** On current boundaries it belongs in **`dispatch/`** — it coordinates offer lifecycle across geo (discovery), drivers (eligibility), and rides (claim). `matching/` would own candidate _ranking_ when that becomes non-trivial; today ranking is a distance sort inside `findNearbyDrivers`. **Do not put it in `rides/`** — that module owns the ride aggregate, not fulfilment orchestration. `INFERENCE`

---

## 16. Ride Lifecycle Workflow

| Transition | State machine                               | Updates driver status? |
| ---------- | ------------------------------------------- | ---------------------- |
| accept     | ✅ `claimForMatch` + `rides_request_id_key` | **NO**                 |
| arrive     | ✅ lock + CAS + ownership                   | **NO**                 |
| start      | ✅ + start-OTP                              | **NO**                 |
| complete   | ✅ + fare + **ledger**                      | **NO**                 |
| cancel     | ✅                                          | **NO**                 |

**Ride status and driver status are completely disconnected.** A driver mid-trip remains `ONLINE`, `isAvailable: true`, and in the geo index.

> **Single source of truth:** the ride is authoritative for trip state; the driver row is authoritative for availability. **Rides should call a Drivers status method inside its existing accept/complete transactions.** Do not move ride lifecycle into Drivers. `INFERENCE`

---

## 17. Payment / Ledger / Settlement / Wallet Workflow

**What works** — `completeRide` calls `ledgerService.recordTripPayment(...)` **inside the same transaction** as the status write:

| Method      | Entries                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------- |
| **CASH**    | `DRIVER_PAYABLE` **DEBIT** commission + `PLATFORM_COMMISSION` **CREDIT**                          |
| **Prepaid** | `CUSTOMER_WALLET` **DEBIT** fare + `DRIVER_PAYABLE` **CREDIT** + `PLATFORM_COMMISSION` **CREDIT** |

`postTransactionGroup` rejects non-positive amounts. Double-entry sound.

**What breaks:**

| Link                        | Status                                                                        |
| --------------------------- | ----------------------------------------------------------------------------- |
| Ride → ledger               | ✅ **WORKS**                                                                  |
| Ledger → `DriverSettlement` | ❌ `SettlementJob` **absent from `JOB_SCHEDULES` and `MAINTENANCE_HANDLERS`** |
| Settlement → `DriverWallet` | ❌ sole write is `driverWallet.create`                                        |
| Wallet read API             | ✅ works, returns **zero forever**                                            |

**Ownership correct:** Payments owns ledger/settlement/mutations/payouts; Drivers owns only a read projection. `grep -rln "earnings" src` → 3 Payments files, **zero Drivers files**.

---

## 18. Notification Workflow

`NotificationService` has exactly `sendSms` and `sendOtp` behind an `SmsProvider` interface (MSG91 + mock).

| Path                               | State          |
| ---------------------------------- | -------------- |
| OTP → SMS                          | ✅ **WORKING** |
| Document result → notification     | ❌ missing     |
| Driver verification → notification | ❌ missing     |
| Ride offer → push/realtime         | ❌ **missing** |

**FCM tokens:** stored on `UserDevice` at OTP verify; **zero reads for delivery**. No FCM SDK, no APNs, no Firebase dependency. `plugins/socket/socket.plugin.ts` is `export {};` and unregistered.

**Distinguishing clearly:**

- **Existing infrastructure:** `SmsProvider` interface, `NotificationService` shape, BullMQ delivery with backoff, `fcmToken` storage.
- **Missing implementation:** any push/realtime transport.
- **Future scope:** in-app notification store (`notification.prisma` exists, unused).

> **Push is a hard prerequisite for dispatch** — an offer with no delivery channel cannot reach a driver.

---

## 19. Background Jobs Workflow

`CODEBASE VERIFIED` — jobs resolve by **string token**; a rename fails at cron time, not compile time.

| Job class             | DI token              | Worker token   | Schedule       | Handler     | Status                                            |
| --------------------- | --------------------- | -------------- | -------------- | ----------- | ------------------------------------------------- |
| `FileSweeperJob`      | `fileSweeperJob`      | same           | `*/15 * * * *` | ✅          | `SCHEDULED_AND_WORKING`                           |
| `FileRetentionJob`    | `fileRetentionJob`    | same           | `0 3 * * *`    | ✅          | `SCHEDULED_AND_WORKING`                           |
| `AccountErasureJob`   | `accountErasureJob`   | same           | config         | ✅          | `SCHEDULED_AND_WORKING`                           |
| `AuthRetentionJob`    | `authRetentionJob`    | same           | `30 4 * * *`   | ✅          | `SCHEDULED_AND_WORKING`                           |
| `DispatchTimeoutJob`  | `dispatchTimeoutJob`  | same           | `* * * * *`    | ✅          | `SCHEDULED_BUT_DISCONNECTED`                      |
| `RequestExpiryJob`    | `requestExpiryJob`    | same           | `* * * * *`    | ✅          | `SCHEDULED_AND_WORKING`                           |
| `HeartbeatTimeoutJob` | `heartbeatTimeoutJob` | same           | `* * * * *`    | ✅          | `SCHEDULED_AND_WORKING`                           |
| `DocExpirationJob`    | `docExpirationJob`    | same           | `0 2 * * *`    | ✅          | `SCHEDULED_BUT_DISCONNECTED` — no `VERIFIED` docs |
| `ReconciliationJob`   | `reconciliationJob`   | same           | `15 * * * *`   | ✅          | `SCHEDULED_AND_WORKING`                           |
| **`SettlementJob`**   | **`settlementJob`**   | ❌ **none**    | ❌ **none**    | ❌ **none** | **`REGISTERED_BUT_NEVER_SCHEDULED`**              |
| `OtpDeliveryJob`      | `otpDeliveryJob`      | queue consumer | on demand      | n/a         | `SCHEDULED_AND_WORKING`                           |

**Rename risk:** the nine tokens above are string literals in `src/jobs/workers/index.ts`. Renaming a DI registration without updating that map yields `No handler registered for job "..."` **only when the cron fires**.

---

## 20. Module Ownership Map

| Module          | Owns                                                                                              | Verdict                                 |
| --------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `auth`          | identity, JWT, roles, authorization, OTP                                                          | ✅ correct                              |
| `users`         | shared user identity/profile, `users.email`                                                       | ✅ correct                              |
| `files`         | bytes, storage, metadata, ownership, access, purpose                                              | ✅ correct                              |
| `drivers`       | onboarding, profile, documents-as-KYC, verification, availability, location, shifts, wallet reads | ✅ correct                              |
| `vehicles`      | vehicles + assignments                                                                            | ⚠️ schema only                          |
| `geo`           | spatial index, nearby search, coordinates                                                         | ✅ correct                              |
| `matching`      | candidate selection                                                                               | ⚠️ stub                                 |
| `dispatch`      | offer orchestration + lifecycle                                                                   | ⚠️ stub — **orchestrator belongs here** |
| `rides`         | ride lifecycle                                                                                    | ✅ correct                              |
| `payments`      | ledger, settlement, wallet mutation, payouts                                                      | ✅ correct                              |
| `notifications` | SMS, push, delivery                                                                               | ⚠️ SMS only                             |
| `admin`         | administrative APIs/orchestration                                                                 | ⚠️ stub                                 |
| `jobs`          | scheduling and execution                                                                          | ✅ correct                              |

---

## 21. Driver Module File Placement Map

**`MOVE_TO_EXISTING_MODULE`: zero files.** `CODEBASE VERIFIED`

| Group                                                                                                                                                                                         | Classification                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `services/onboarding/` (`onboardDriver`, `updateProfile`), controller, `driver.repository.ts`, `driver-code.util.ts`, schemas, routes                                                         | `KEEP_IN_DRIVERS`                                                           |
| `submitDocument` (inside onboarding service), `driver-document.repository.ts`, `doc-expiration.job.ts`                                                                                        | `KEEP_IN_DRIVERS` — **wrong submodule** → `drivers/documents/`              |
| `reviewDriverVerification` (inside onboarding service)                                                                                                                                        | `KEEP_IN_DRIVERS` — **wrong submodule** → `drivers/verification/`           |
| `services/status/`, `driver-status.repository.ts`, `heartbeat-timeout.job.ts`                                                                                                                 | `KEEP_IN_DRIVERS`                                                           |
| `services/location/`, `driver-location.repository.ts`                                                                                                                                         | `KEEP_IN_DRIVERS`                                                           |
| `driver-shift.repository.ts`                                                                                                                                                                  | `KEEP_IN_DRIVERS`                                                           |
| `services/wallet/`, `driver-wallet.repository.ts`                                                                                                                                             | `KEEP_IN_DRIVERS`                                                           |
| `StatusService.setOnline` (eligibility), `LocationService` (geo write)                                                                                                                        | `CROSS_MODULE_ORCHESTRATION`                                                |
| `driver-bank.repository.ts`                                                                                                                                                                   | `DECISION_REQUIRED` — 0 callers; Drivers or Payments when payouts are built |
| `plugins/`, `schemas/driver.responses.ts`, `services/shift/shift.service.ts`, `DriverWalletRepository.lockForUpdate`, 2 unused errors, `DriverMetrics.heartbeatTimeout`, 4 unpublished events | `DEAD_CODE`                                                                 |

**Recommended final Driver structure** — only folders with real code:

```
drivers/
├── onboarding/    (+ profile — 2 methods do not justify their own folder)
├── documents/     ← submitDocument + repo + expiry job + review (new)
├── verification/  ← reviewDriverVerification + grantRole hook
├── status/        (+ shift — repository only)
├── location/
├── wallet/
├── shared/        driver-identity, driver.repository, events, metrics, types, errors, constants
├── routes/index.ts
└── index.ts
```

**No `profile/`, no `earnings/`.** `INFERENCE`

---

## 22. Existing Code to Reuse

**Do not rebuild:** OTP · Auth (sessions, tokens, refresh rotation, epoch) · `grantRole`/`revokeRole` · `User` identity + `users.email` · the entire Files module incl. `DRIVER_DOCUMENT` purpose, `decideRead`, `registerFileReference` · the Geo stack · outbox/relay/EventBus · job scheduler + `LockStore` · `TransactionManager` + `lockForUpdate` · the Rides state machine · **the Payments ledger and `recordTripPayment`** · `claimForMatch` + `rides_request_id_key` · backend-controlled roles · `di-wiring.test.ts` + `route-graph.test.ts` · the Prisma schema.

---

## 23. Missing Connections

Fourteen complete capabilities with no caller: `grantRole` · `updateVerificationStatus` (`VERIFIED` path) · `requireApprovedDocuments` · `maxContinuousShiftHours` · Files `DRIVER_DOCUMENT` purpose + `registerFileReference` · `findNearbyDrivers` · `offerToDriver` · `RideDispatchRepository` (3 methods) · `findActiveByDriver` · **`SettlementJob`** · `fcmToken` reads · `PermissionRepository.findAllowedCodesForUser` · `ShiftService` · `DriverBankRepository`.

## 24. Missing Features

Document review service + route · required-document declaration · admin review queue · matching · dispatch orchestration · push/realtime · vehicles module · `BUSY`/`ON_TRIP` writers · wallet projection · location history · driver aggregates + shift stats · `AuditLog` model · `EXPIRED` document status.

## 25. Broken Features

`POST /drivers/:id/suspend` (self-deadlock) · `GET /rides/active` + `/history` for drivers (dead role branch) · `DocExpirationJob` (permanently inert) · `DispatchTimeoutJob` (empty table) · driver wallet balance (always zero).

---

## 26. Security / BOLA / Integrity Risks

| Risk                                                                          | Severity |
| ----------------------------------------------------------------------------- | -------- |
| Documents accept arbitrary client URLs — no ownership/purpose/scan            | **P0**   |
| Driver approvable with zero/`PENDING`/`REJECTED` documents                    | **P0**   |
| One driver, unlimited concurrent rides — no code, no index                    | **P0**   |
| `vehicleId` unvalidated at accept — another driver's vehicle usable           | **P0**   |
| Unverified/suspended/offline drivers in the live geo index                    | **P1**   |
| **Revoked default role silently re-granted on next login**                    | **P1**   |
| **`DEFAULT_USER_ROLE` unvalidated at boot** — could grant admin platform-wide | **P1**   |
| Driver email via raw Prisma — 500 not 409, `isEmailVerified` unmanaged        | **P1**   |
| Staff bypass in `authorizedDriverId` unaudited                                | **P1**   |
| `actingDriverId` duplicated in Rides — authorization drift risk               | **P2**   |

**Verified correct:** deny-by-default authentication · fail-closed on infra failure · JWT-derived identity everywhere · `:driverId` params ignored · no role field in any request schema · OTP redaction in production.

---

## 27. Database Invariant Matrix

`SCHEMA VERIFIED` — enumerated every `CREATE UNIQUE INDEX` across all migrations.

| #   | Invariant                                   | App protection | DB protection | Production safe | Evidence                                                                                    |
| --- | ------------------------------------------- | -------------- | ------------- | --------------- | ------------------------------------------------------------------------------------------- |
| 1   | One Driver per User                         | **YES**        | **YES**       | ✅              | `drivers_user_id_key` + `P2002` re-read                                                     |
| 2   | One DriverProfile per Driver                | **YES**        | **YES**       | ✅              | `driver_profiles_driver_id_key` + `upsert`                                                  |
| 3   | One active role assignment per User/Role    | **YES**        | **YES**       | ✅              | **`uq_user_role_active`** partial (`WHERE revoked_at IS NULL`)                              |
| 4   | One live profile image per User             | **YES**        | **YES**       | ✅              | **`uq_files_one_live_profile_image`** partial + release-on-replace                          |
| 5   | **One DriverDocument per Driver/Type**      | **NO**         | **NO**        | ❌              | `findFirst`-then-`create`; only plain indexes on `driver_id`, `document_type`, `expires_at` |
| 6   | **One active ride per Driver**              | **NO**         | **NO**        | ❌              | `findActiveByDriver` **0 call sites**; only plain `rides_driver_id_idx`                     |
| 7   | One ride per Request                        | **YES**        | **YES**       | ✅              | **`rides_request_id_key`** + `claimForMatch` (1 call site)                                  |
| 8   | **One active VehicleAssignment per Driver** | **NO**         | **NO**        | ❌              | `VehicleAssignment` has only `@@index([driverId])`; no code at all                          |

**Contrast for #6:** `findActiveByCustomer` has **3 call sites** — the customer side _is_ guarded by `createRequest`. The driver-side twin was written and never used.

**The partial-unique pattern already exists three times** (#3, #4, plus `uq_users_phone_active`). It simply was not applied to 5, 6, 8.

**Six UUID columns with no FK:** `Driver.currentVehicleId`, `Driver.approvedBy`, `DriverDocument.verifiedBy`, `DriverBankAccount.verifiedBy`, `DriverOnlineStatus.currentShiftId`, `DriverLocation.rideId`.

---

## 28. Event and Outbox Flow

`EventPublisher.publish(input, tx?)` → `event_outbox` (in-transaction) → `OutboxRelay` (claim token, retry/backoff) → `EventBus.emit`.

**Subscribers platform-wide: ONE.** `grep -rn "eventBus.on(" src --exclude-dir=generated` → `epoch-invalidation.consumer.ts:17`.

| Event                                       | Producer                                    | Subscriber                 |
| ------------------------------------------- | ------------------------------------------- | -------------------------- |
| `driver.onboarded`                          | `onboardDriver`                             | ❌                         |
| **`driver.verified`**                       | `reviewDriverVerification`                  | ❌ **the role-grant hook** |
| `driver.status_changed`, `driver.suspended` | `StatusService`                             | ❌                         |
| **`ride.requested`**                        | `createRequest`                             | ❌ **the dispatch hook**   |
| `ride.accepted`, `ride.dispatch_offered`    | rides                                       | ❌                         |
| `account.role.granted`                      | `grantRole` (0 callers) + new-account login | ✅ epoch bump              |

**Declared, never published:** `driver.document_expired`, `driver.shift_started`, `driver.shift_ended`, `driver.location_updated`.

---

## 29. Dependency Graph / Circular Dependency Risks

**Outbound from `drivers/`:** `@modules/geo` ×4 — **the only domain-module dependency**. Everything else is `@core/*`, `@config`, `@shared`.

**Inbound:** `core/di.ts` (barrel) · `routes/register.ts` (barrel) · **`rides/controllers/ride-state.controller.ts` (2 deep imports)** · 4 test files.

**Actual cycles: ZERO.**

| Prospective edge              | Cycle?                                           |
| ----------------------------- | ------------------------------------------------ |
| `drivers → auth` (grantRole)  | **NO** — no `auth → drivers` import exists       |
| `drivers → users` / `→ files` | **NO**                                           |
| `drivers → rides`             | **YES — never add**                              |
| `geo → drivers`               | **YES — never add**; pass a predicate _into_ Geo |

**Also:** `rides` deep-imports `@modules/payments/services/ledger/ledger.service.js` — needs a barrel.

---

## 30. Test Coverage Matrix

`TEST VERIFIED` — 109 files, 714 unit tests.

| Category                      | Present                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Unit tests                    | ✅ 714                                                                                     |
| Integration (service-level)   | ✅ geo, earnings pipeline, auth roles                                                      |
| **HTTP route tests**          | ⚠️ auth/users/files/rides only — **zero for `driver.routes.ts`** except 2 auth/BOLA probes |
| Database constraint tests     | ⚠️ `auth-roles.test.ts` tests `uq_user_role_active`                                        |
| Transaction/concurrency tests | ✅ `ride-lifecycle-concurrency.test.ts`, 4-way concurrent `grantRole`                      |
| **End-to-end lifecycle**      | ❌ **none**                                                                                |

**Fixture shortcuts** insert directly: VERIFIED drivers, VERIFIED documents, DRIVER role, active rides, geo positions, vehicles — hiding exactly the two lifecycle blockers.

**Required lifecycle test — what can run where:**

| Segment                             | Runnable locally        | Runnable in CI            |
| ----------------------------------- | ----------------------- | ------------------------- |
| OTP → User → JWT                    | ❌ needs Postgres+Redis | ✅                        |
| Onboard → profile → document submit | ❌                      | ✅                        |
| Files upload → `fileId`             | ❌ needs S3 mock        | ✅ (mock provider exists) |
| Admin review → approve → role       | ❌                      | ✅ once built             |
| Online → location → discovery       | ❌ needs PostGIS        | ✅                        |
| Ride → accept → complete → ledger   | ❌                      | ✅                        |
| Settlement → wallet                 | ❌                      | ✅ once scheduled         |

**Everything needs CI infrastructure.** Locally only unit tests run.

---

## 31. CI / Build Health

Covered in §2. **One blocker: `format:check`, CI's first gate, 34 non-`src/` files.** Recommendation: extend `.prettierignore`.

---

## 32. Production Blockers

| ID        | Blocker                                                     | Stage |
| --------- | ----------------------------------------------------------- | ----- |
| **P0-1**  | No writer of `DriverDocument.verificationStatus = VERIFIED` | 1     |
| **P0-2**  | `grantRole` zero production callers                         | 2     |
| **P0-3**  | Driver approvable with zero/unverified documents            | 1     |
| **P0-4**  | Documents accept arbitrary client URLs                      | 1     |
| **P0-5**  | `POST /drivers/:id/suspend` self-deadlocks                  | 3     |
| **P0-6**  | One driver, unlimited concurrent rides                      | 4     |
| **P0-7**  | `vehicleId` unvalidated at accept                           | 5     |
| **P0-8**  | Dispatch has no orchestrator                                | 6     |
| **P0-9**  | `SettlementJob` never scheduled                             | **0** |
| **P0-10** | `DriverWallet` never updated                                | 9     |

---

## 33. Recommended Final Module Structure

No top-level module changes. Inside `drivers/`: extract `documents/` and `verification/` (§21). Build `dispatch/` for the orchestrator, `vehicles/` for the vehicle lifecycle, and push inside `notifications/`.

---

## 34–35. Production Implementation Stages and Dependency Order

**Adjusted from the suggested order on evidence** — two changes explained below.

| Stage  | Work                                                                                                                                                                   | Depends on | Why here                                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**  | `.prettierignore` fix; **schedule `SettlementJob`**; HTTP smoke tests for the 13 driver routes                                                                         | —          | CI's first gate blocks all merges. **`SettlementJob` moved from Stage 9 to Stage 0** — it is two lines, entirely independent, and unblocks money flow today |
| **1**  | Document review service + admin route; required-document set; document gate in approval; `fileId` + Files ownership check                                              | 0          | The single lifecycle blocker. **Extract `drivers/documents/` first** so review is written once, in the right place                                          |
| **2**  | `grantRole` on approval (Option A or B — `DECISION_REQUIRED`); extract `drivers/verification/`                                                                         | 1          | Needs the document gate to be meaningful. Also fixes `/rides/active` + `/history`                                                                           |
| **3**  | Suspend deadlock; location eligibility gate; licence expiry; suspend body validation; `heartbeatAt = null` sweep; revoked-default-role; `DEFAULT_USER_ROLE` allow-list | 2          | Operational correctness once drivers can actually be online                                                                                                 |
| **4**  | Database invariants 5 + 6 (partial unique indexes) + `findActiveByDriver` call                                                                                         | 3          | **Moved before vehicles** — invariant 6 protects the accept path that Stage 5 extends                                                                       |
| **5**  | Vehicles module: registration, documents, assignment (+ invariant 8), approval; vehicle validation **at accept**                                                       | 4          | Accept-path gate per §13                                                                                                                                    |
| **6**  | Push/realtime notifications                                                                                                                                            | 3          | **Moved before dispatch** — dispatch without delivery is inert                                                                                              |
| **7**  | Matching + dispatch orchestrator in `dispatch/`; geo state filter                                                                                                      | 5, 6       | Needs eligible online drivers, a vehicle gate, and a delivery channel                                                                                       |
| **8**  | Ride lifecycle ↔ `BUSY`/`ON_TRIP` synchronization from Rides                                                                                                           | 7          | Needs real offers/accepts to synchronize                                                                                                                    |
| **9**  | Wallet projection from `DRIVER_PAYABLE`                                                                                                                                | 0          | Job already running by then; projection is the remaining half                                                                                               |
| **10** | Full end-to-end integration test, zero direct DB writes                                                                                                                | all        | Definition of done                                                                                                                                          |

**Two deviations from the suggested order, both evidence-driven:**

1. **`SettlementJob` scheduling moved 9 → 0.** Two lines, no dependencies, and money is currently invisible to drivers.
2. **Notifications moved 7 → 6, before dispatch.** An offer with no delivery channel cannot reach a driver — building dispatch first produces another inert subsystem.

---

## 36. What Must Be Fixed Before New Features

`format:check` (blocks all merges) · document review (blocks the lifecycle) · `grantRole` (blocks the role and breaks two live endpoints) · document gate on approval (security) · `fileId` ownership validation (security) · suspend deadlock (safety operation) · invariants 5 and 6 (data integrity).

## 37. What Can Be Deferred

Location history · driver aggregates + shift stats · `AuditLog` model · `EXPIRED` document status · admin queue UI (API first) · `super_admin` role · the full 35-file vertical split · dead-code deletion · `PermissionRepository` enforcement · `maxContinuousShiftHours` · in-app notification store.

---

## 38. Exact Files Likely To Change Per Stage

_Predicted surface, for scoping only._

| Stage  | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0**  | `.prettierignore`; `src/jobs/scheduler/index.ts` (+`SETTLEMENT` entry); `src/jobs/workers/index.ts` (+`settlementJob` handler); **new** `tests/integration/driver-routes.test.ts`                                                                                                                                                                                                                                                                      |
| **1**  | **new** `drivers/documents/{services,repositories,controllers,schemas,routes,jobs}/*`; `drivers/services/onboarding/onboarding.service.ts` (split); `drivers/controllers/driver-onboarding.controller.ts` (split); `drivers/routes/driver.routes.ts`; `drivers/schemas/driver.schemas.ts`; `drivers/constants/driver.constants.ts` (required set); `drivers/index.ts` (DI); `prisma/schema/modules/driver/driver.prisma` (`fileId`); **new migration** |
| **2**  | **new** `drivers/verification/**`; `drivers/index.ts`; **new** `auth/consumers/driver-verified.consumer.ts` _(Option B)_ + `src/bootstrap/events.bootstrap.ts`; or `onboarding.service.ts` _(Option A)_; `rides/controllers/ride-query.controller.ts` (regression test)                                                                                                                                                                                |
| **3**  | `drivers/services/status/status.service.ts`; `drivers/controllers/driver-status.controller.ts`; `drivers/routes/driver.routes.ts`; `drivers/jobs/heartbeat-timeout.job.ts`; `auth/services/auth.service.ts` (`ensureDefaultRole`); `config/env/schema.ts`                                                                                                                                                                                              |
| **4**  | `rides/services/lifecycle/lifecycle.service.ts`; **new migration** (2 partial unique indexes)                                                                                                                                                                                                                                                                                                                                                          |
| **5**  | **new** `modules/vehicles/**`; `routes/register.ts`; `core/di.ts`; `rides/services/lifecycle/lifecycle.service.ts`; **new migration**                                                                                                                                                                                                                                                                                                                  |
| **6**  | **new** `notifications/providers/push.*`; `notifications/notification.service.ts`; `auth/repositories/device.repository.ts` (read path)                                                                                                                                                                                                                                                                                                                |
| **7**  | **new** `modules/dispatch/**`; `geo/providers/postgis.provider.ts` (state filter); `bootstrap/events.bootstrap.ts`; `jobs/scheduler/index.ts`                                                                                                                                                                                                                                                                                                          |
| **8**  | `rides/services/lifecycle/lifecycle.service.ts`; `drivers/repositories/driver-status.repository.ts`                                                                                                                                                                                                                                                                                                                                                    |
| **9**  | `payments/services/settlement/settlement.service.ts`; `drivers/repositories/driver-wallet.repository.ts`                                                                                                                                                                                                                                                                                                                                               |
| **10** | **new** `tests/integration/driver-lifecycle-e2e.test.ts`                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 39. Migration Requirements Per Stage

| Stage | Migration                                                                                                                                                                                                   | Risk                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 0     | **none**                                                                                                                                                                                                    | —                                                                 |
| **1** | `DriverDocument.fileId` (nullable → backfill → FK to `files`), keep `fileUrl` during transition; **`@@unique([driverId, documentType])`** (invariant 5) — build fails if duplicates exist, which is correct | **MEDIUM** — check for duplicates first                           |
| 2     | none                                                                                                                                                                                                        | —                                                                 |
| 3     | none                                                                                                                                                                                                        | —                                                                 |
| **4** | **Partial unique on `rides(driver_id) WHERE status IN (active…)`** (invariant 6)                                                                                                                            | **MEDIUM** — fails on existing duplicates; `rides` is small today |
| **5** | **Partial unique on `vehicle_assignments(driver_id) WHERE released_at IS NULL AND status='ACTIVE'`** (invariant 8); FK for `Driver.currentVehicleId`                                                        | **LOW** — tables are empty                                        |
| 6–8   | none                                                                                                                                                                                                        | —                                                                 |
| 9     | Possibly none — projection may write existing `DriverWallet` columns                                                                                                                                        | **LOW**                                                           |

**Deferred schema items:** `EXPIRED` on `VerificationStatus` · `AuditLog` model · `driver_location_history` · the five remaining FK-less UUID columns.

**Note:** Prisma wraps migrations in a transaction, so `CREATE INDEX CONCURRENTLY` cannot be used inline — migration `20260810100000` documents this pattern and the out-of-band alternative.

---

## 40. Final GO / NO-GO Decision

> ### ✅ **GO — for specification and staged implementation**
>
> **Why GO.** The baseline is healthy: typecheck, lint, build, and 714 unit tests all pass; the tree is clean and committed. Ownership is settled with evidence — **zero files need to move between top-level modules**. The gaps are enumerated, and §22 shows most of the remaining work is _connecting_ existing, correct code rather than building new subsystems. Critically, **three P0s from the first driver audit are already fixed**, which demonstrates the plan is tractable.
>
> **Two conditions before Stage 1:**
>
> 1. **`format:check`** must be resolved — it is CI's first gate and blocks every merge. Recommendation: extend `.prettierignore` (§2.1).
> 2. **The role-assignment mechanism must be chosen** (§10.1). Option B fits the existing architecture better; Option A is simpler and atomic. Both are structurally safe. **`DECISION_REQUIRED`** — the spec cannot leave it open.
>
> **Highest-value first move, independent of both:** schedule `SettlementJob`. Two lines, no dependencies, and it makes driver earnings real.
>
> **The lifecycle unblocks in two steps.** Document review (Stage 1) and `grantRole` (Stage 2) are together sufficient for the first real driver to reach ONLINE. Everything after that is expansion.

**Recommended next command:**

```
/speckit.specify
```

Scope it to **Stage 1 + Stage 2** — document review, the required-document gate, secure `fileId` ownership, and driver role assignment. That is one coherent feature with a clear acceptance test: _a real driver completes phone → OTP → onboard → profile → document upload → admin review → approval → role → ONLINE, with zero direct database writes._

**Do not scope the spec wider.** Vehicles, dispatch, and notifications are separate features with their own dependency chains.

---

PLATFORM WORKFLOW VERIFIED. PRODUCTION IMPLEMENTATION PLAN READY. NO CODE CHANGED.
