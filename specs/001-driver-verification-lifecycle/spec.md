# Feature Specification: Driver Document Verification & Online Eligibility Lifecycle

**Feature Directory**: `specs/001-driver-verification-lifecycle`
**Status**: Specification complete — no implementation performed
**Created**: 2026-08-20
**Repo**: `zaroorat-back` (Fastify + Prisma + Awilix + PostgreSQL + Redis, TypeScript)

**Decision labels used throughout**: `VERIFIED_EXISTING` (confirmed in current source), `REQUIRED_CHANGE` (must be built/modified), `CONFIGURATION_DECISION` (a choice this spec makes where the codebase leaves it open), `OPEN_QUESTION` (needs a human answer before/at planning).

---

## 1. Problem Statement

The production flow **Phone → OTP → User → Driver Onboarding → Driver Profile → File Upload → Document Submission → Admin Document Review → All Required Documents Verified → Admin Driver Approval → `driver.verified` Event → Auth Subscriber → Grant `driver` Role → Online Eligibility → Shift Start → Geo/Dispatch Availability** does not currently function end-to-end. Investigation of the current codebase (verified 2026-08-20, see §2) found that **no driver can currently pass `POST /drivers/status/online` through the real production code path**, because:

- Driver-level approval (`POST /:id/verify`) unconditionally sets `verificationStatus = VERIFIED` without inspecting any `DriverDocument` row.
- No code path anywhere ever sets a `DriverDocument.verificationStatus` to `VERIFIED` (no per-document review exists).
- `StatusService.setOnline` requires a `DriverDocument` with `documentType = 'DRIVING_LICENSE' AND verificationStatus = 'VERIFIED'` — a condition that can never be satisfied by any reachable code path.
- Document submission accepts a raw, client-supplied `fileUrl: z.string().url()` with no relation to the Files module at all — no ownership check, no purpose check, no proof the "file" was ever legitimately uploaded.
- The `driver` role is never granted to any user in production (`AuthService.grantRole` exists and works correctly but has zero callers).

This specification defines the minimum production-correct set of changes to make this flow actually work, while reusing every existing pattern the codebase already has for file ownership, transactional events, role assignment, and geo publishing — rather than inventing parallel mechanisms.

---

## 2. Current Verified Baseline

Everything in this section was directly re-verified against source in this session (not taken from prior audit docs without cross-check). File:line references are exact as of the current working tree.

### 2.1 Driver onboarding & profile — `VERIFIED_EXISTING`, working correctly
- `GET /drivers/me` → `OnboardingService.createOrGetDriver(userId)` (`src/modules/drivers/services/onboarding/onboarding.service.ts:23-38`) auto-creates a `Driver` row (`verificationStatus: PENDING`) on first call for the authenticated user, inside a transaction, publishing `DRIVER_EVENT_CATALOG.ONBOARDED`. This is an accepted existing behavior for the *Drivers* module's own `/me` (distinct from the *Users* module's `GET /me`, which never touches `Driver` — see §2.9).
- `PATCH /drivers/:driverId/profile` → `OnboardingService.updateProfile` → `DriverRepository.updateProfile`, a real Prisma `upsert` on `DriverProfile` keyed by `driverId` (`driver.repository.ts:71-78`). DB-enforced 1:1 via `driver_profiles_driver_id_key` unique index (migration `20260724173304_init`).

### 2.2 Document submission — `VERIFIED_EXISTING` (broken/insecure as built)
- Route: `POST /drivers/:driverId/documents` (`driver.routes.ts:13-15`) → `submitDocument` (`driver-onboarding.controller.ts:42-53`).
- Schema (`driver.schemas.ts:17-32`):
  ```ts
  export const submitDriverDocumentSchema = z.object({
    documentType: z.enum(['DRIVING_LICENSE','RC','INSURANCE','AADHAAR','PAN','PUC','POLICE_VERIFICATION','PROFILE_PHOTO']),
    fileUrl: z.string().url(),
    documentNumber: z.string().max(100).optional(),
    expiresAt: z.string().datetime().optional(),
  });
  ```
  Accepts a **raw URL string**. No `fileId`. `OnboardingService.submitDocument` (`onboarding.service.ts:44-66`) has **no dependency on any Files-module service** (its constructor injects only `DriverRepository`, `DriverDocumentRepository`, `TransactionManager`, `EventPublisher`, `DriverMetrics`).
- `DriverDocumentRepository.upsertDocument` (`driver-document.repository.ts:6-47`) does a **findFirst-then-create/update** (not an atomic upsert) keyed by `(driverId, documentType)`, and **always hardcodes `verificationStatus: 'PENDING'`** on every write, including re-uploads.
- If the driver's own status is currently `PENDING`, the first document submission advances it to `DOCUMENT_REVIEW` (`onboarding.service.ts:55-63`) — there is no explicit "submit application for review" action.
- `DriverDocument` Prisma model (`driver.prisma:72-96`) has `fileUrl String` — **no FK to `File`**, no `fileId` column at all.

### 2.3 Admin driver approval — `VERIFIED_EXISTING` (checks nothing)
`POST /drivers/:id/verify` (admin-only, `authorize({ roles: ['admin'] })`) → `reviewVerification` → `OnboardingService.reviewDriverVerification`, full method (`onboarding.service.ts:67-98`):
```ts
async reviewDriverVerification(driverId, status, approvedBy?, rejectionReason?): Promise<Driver> {
  const driver = await this.driverRepo.findById(driverId);
  if (!driver) throw new DriverNotFoundError(driverId);
  return this.txManager.execute(async (tx) => {
    await this.driverRepo.lockForUpdate(driverId, tx);
    const newStatus = status === 'VERIFIED' ? 'VERIFIED' : 'REJECTED';
    const updated = await this.driverRepo.updateVerificationStatus(driverId, newStatus, approvedBy, rejectionReason, tx);
    if (newStatus === 'VERIFIED') {
      this.driverMetrics.driverVerified({ driverId });
      await this.eventPublisher.publish(driverEvent(DRIVER_EVENT_CATALOG.VERIFIED, driverId, { driverId, approvedBy }), tx);
    }
    return updated;
  });
}
```
- Reads zero `DriverDocument` rows. No transition guard (an already-`VERIFIED` driver can be re-approved; a `REJECTED` driver can be approved by simply calling again).
- `DRIVER_EVENT_CATALOG.VERIFIED` (`driver.events/catalog.ts:5`, value `'driver.verified'`) **is already published correctly, transactionally**, via the standard outbox pattern (`eventPublisher.publish(..., tx)` — written to `outbox_events` in the same DB transaction as the state write). This is the only place `VERIFIED` is ever published.

### 2.4 `setOnline` — `VERIFIED_EXISTING` (currently unsatisfiable)
Full method, `StatusService.setOnline` (`status.service.ts:28-76`):
```ts
if (driver.verificationStatus !== 'VERIFIED') throw new DriverNotVerifiedError(...);
if (driver.isSuspended) throw new DriverSuspendedError(...);
const docs = await this.docRepo.findByDriverId(driverId, tx);
const hasValidLicense = docs.some(d => d.documentType === 'DRIVING_LICENSE' && d.verificationStatus === 'VERIFIED');
if (!hasValidLicense) throw new DriverNotVerifiedError('Driver does not have a verified Driving License');
```
Since no code path (per §2.5) ever sets a document's `verificationStatus` to `'VERIFIED'`, **the third check can never pass** — `setOnline` is presently a dead end for every real driver. Route guard: `preHandler: fastify.authorize({ requireOperableDriver: true })` (`driver.routes.ts:21-25`).

### 2.5 Per-document review — does not exist
`DriverDocumentRepository.updateVerificationStatus(id, status, verifiedBy?, rejectionReason?, tx?)` (`driver-document.repository.ts:54-75`) exists and is capable of writing `VERIFIED`, but has **exactly one caller in the entire repo**: `doc-expiration.job.ts:23-28`, which only ever writes `'REJECTED'`. No controller, route, or service sets a document to `VERIFIED`. The `DriverDocument` model already has `verifiedBy String? / verifiedAt DateTime? / verificationNotes String? / rejectionReason String?` columns (`driver.prisma:80-86,89`) — **fully unused today**, but schema-ready for a review endpoint with no migration needed for those specific fields.

### 2.6 `requireApprovedDocuments` — `VERIFIED_EXISTING` (dead config)
`src/config/driver/driver.config.ts:1-18`:
```ts
requireApprovedDocuments: process.env.DRIVER_REQUIRE_APPROVED_DOCS !== 'false', // defaults true
```
Repo-wide grep found this referenced **only in its own definition** — never read by `reviewDriverVerification`, `setOnline`, or anywhere else. No `REQUIRED_DOCUMENT_TYPES`-style config exists anywhere (mandatory document *types* are not declared anywhere in code).

### 2.7 Files module — `VERIFIED_EXISTING`, mature, and has the exact pattern needed
- Upload is two-step: `POST /files` (presigned S3 PUT, `FileUploadService.createUpload`) → client PUTs bytes → `POST /files/:id/complete` (`FileUploadService.completeUpload`, validates magic bytes/size/EXIF, promotes `PENDING → READY`, publishes `file.uploaded`). File bytes never transit the API.
- `FilePurpose` enum (`file.prisma:101-108`) already includes `DRIVER_DOCUMENT` and `VEHICLE_DOCUMENT` — already policy-configured in `filePurposePolicy` (`file.config.ts:30-79`: MIME allow-list `image/jpeg, image/png, image/webp, application/pdf`, 10MB max, `readTtlSeconds: 300`, EXIF-location stripped, 8-year retention on `DRIVER_RELATIONSHIP_ENDED`) but **functionally orphaned** — nothing in the Drivers module calls into Files at all.
- `FileLifecycleService.assertReferenceable(fileId, ownerUserId, purpose, tx)` (`file-lifecycle.service.ts:75-88`) is the **exact primitive needed**: throws `FileNotFoundError` unless the file is owned by that user *and* matches the declared purpose; throws `FileStateError` unless `status === 'READY' && deletedAt === null`; throws `FileInUseError` if another module already holds a live reference.
- `FileLifecycleService.supersede(previousFileId, replacementFileId, tx, requestId)` (lines 89-126) is the primitive for document *renewal* (old file → `SUPERSEDED`, not deleted).
- **A working example of this exact pattern already exists** — Users module's profile-image attach flow:
  ```ts
  // src/modules/users/services/user.service.ts:76-90
  private async attachProfileImage(userId, nextFileId, tx, requestId) {
    const current = (await this.userProfileRepository.findByUserId(userId, tx))?.profileImageFileId;
    if ((current ?? null) === nextFileId) return null;
    if (nextFileId === null) return current ?? null;
    await this.fileService.assertReferenceable(nextFileId, userId, 'PROFILE_IMAGE', tx);
    if (current != null) await this.fileService.supersede(current, nextFileId, tx, requestId);
    return null;
  }
  ```
  and the reverse-reference registration (`src/modules/users/index.ts:36-40`):
  ```ts
  registerFileReference('PROFILE_IMAGE', {
    module: 'users',
    isReferenced: (fileId, tx) => container.resolve('userProfileRepository').isProfileImage(fileId, tx),
  });
  ```
  `docs/files/FLOW.md` §5 explicitly documents this same pattern as the *intended* design for driver documents (`POST /drivers/me/documents {documentType, fileId}` → `assertReferenceable` → write `driver_documents.file_id`) — it was simply never implemented in `drivers`. This spec closes that gap.

### 2.8 Auth: role grant, epoch, JWT — `VERIFIED_EXISTING`, ready to use as-is
- `AuthService.grantRole(userId, roleSlug, opts)` (`auth.service.ts:256-294`) is **idempotent by construction**: checks `findActiveAssignment` first, `create()`s only if none active, returns `false` (no-op) on a duplicate call. Only bumps the Redis epoch (`epochService.bump(userId)`) if a *new* grant happened.
- Epoch (`src/core/cache/stores/EpochStore.ts`) is a **Redis-only** per-user counter (`INCR`/`GET`, no DB column). The JWT access token carries an `epoch` claim minted at issuance; `auth.plugin.ts:43-45` compares it on **every authenticated request** and rejects with `401 TOKEN_STALE` on mismatch. This is the existing, working mechanism that forces a client to obtain a new token after any role change — no new invalidation mechanism is needed.
- Refresh (`token.service.ts` `rotate()`) **re-resolves roles fresh from the DB** on every refresh call (`AuthService.resolveActiveRoles` → `RoleRepository.findActiveRoleSlugs`), not from a cached claim.
- `grantRole`/`revokeRole` currently have **zero production callers** anywhere in the codebase (confirmed by repo-wide grep) — the only role-granting code that runs today is `ensureDefaultRole` (grants the `customer` role idempotently on every login).
- **No cross-module event consumer exists anywhere in the codebase today.** `src/modules/auth/consumers/epoch-invalidation.consumer.ts` is the only consumer directory under `src/modules/*`, and it subscribes only to auth's *own* events (`account.role.granted`, `account.role.revoked`, `account.suspended`, `auth.refresh.reuse_detected`) — an intra-module pattern, not a cross-module one. A Drivers→Auth subscriber will be **the first cross-module consumer in this codebase**; this spec must establish, not merely replicate, that wiring — using the same registration mechanics (`container.register(asClass(...).singleton())` + explicit `.register()` call from `src/bootstrap/events.bootstrap.ts`, `eventBus.on(type, handler)`).
- `requireOperableDriver` (`auth.plugin.ts:93-110` → `DriverAccessRepository.isOperableDriver`, `driver-access.repository.ts:6-12`) is a **live DB query** (`driver.findFirst({ where: { userId, verificationStatus: 'VERIFIED', isSuspended: false, deletedAt: null } })`) — it does **not** check the `driver` role claim at all, and is fail-closed (503) on lookup error. This means driver-operability gating is already immune to JWT/role propagation lag (see §14).
- Module boundaries in this codebase are **not** universally enforced via events-only: `src/modules/users/services/account/account.service.ts:16-25` directly injects `AuthService` (calls `activateInTransaction`/`deactivateInTransaction` transactionally). So "Drivers must not directly inject AuthService" (this spec's Option B decision, §13) is a deliberate choice for this feature, not an existing repo-wide law — noted per the user's explicit instruction to use Option B regardless.

### 2.9 Users module — `VERIFIED_EXISTING`
`UserService.getMe` (`user.service.ts:35-45`) reads only `User`/`UserProfile`/roles — **never touches `Driver`**, no auto-creation of anything. Confirms §J (Customer Safety) is currently satisfied and must remain so.

### 2.10 Geo — `VERIFIED_EXISTING`
- Live index = Redis (per-driver key + H3-cell sets) + H3 bucketing; PostGIS (`driver_locations`, GiST-indexed) is the durable source of truth. `docs/COMPLETE_RIDE_PLATFORM_WORKFLOW_AUDIT.md` (current/reliable) confirms Geo is fully built; `docs/PRODUCTION_RIDE_WORKFLOW_AUDIT.md`'s "geo is a stub" claim is **stale** and should be disregarded.
- `LocationService.updateLocation` (`location.service.ts:26-65`) does **both** the durable PostGIS upsert (`driver_locations`, single row per driver, not a history table — `driverId String @id`) **and** the live-index publish (`geoService.recordDriverPosition`) in one call chain — these are not separate call sites today.
- **No eligibility check exists on this path at all** — verification status, suspension, and online status are not checked. Any driver row that exists can publish to the live geo index merely by POSTing GPS coordinates, regardless of `PENDING`/`REJECTED`/`SUSPENDED` state.
- `setOnline` itself **never touches Geo** — a driver only enters the live index once a subsequent location ping arrives. `setOffline` **does** call `geoService.forgetDriverPosition(driverId)` after its transaction commits.
- `NearbyDriverService.recordPosition` performs no eligibility filtering by design (`geo/README.md:10-17`): Geo intentionally "does not filter on verification, suspension, vehicle type or busy-ness" — that responsibility belongs to callers.
- A `driver_location_history` table is referenced only in a schema comment; **no application code writes to it**.

### 2.11 Vehicles / ride-accept boundary — `VERIFIED_EXISTING`, confirms no vehicle-online gate is warranted
- `src/modules/vehicles` is a stub (`export {};`) beyond its Prisma models.
- `VehicleAssignment` (`vehicle.prisma:64-81`) is **never queried anywhere in `src`** (confirmed by repo-wide grep) — not at `setOnline`, not anywhere.
- The **only** place a vehicle is required is `LifecycleService.acceptRideRequest` (`rides/services/lifecycle/lifecycle.service.ts:105-156`), which takes a mandatory, client-supplied `vehicleId: string` with **no validation** it belongs to the driver. `DispatchService.offerToDriver` takes `vehicleId` as *optional* and currently has zero callers.
- **Conclusion, directly confirming the user's stated architectural assumption**: driver availability (online/verified/not-suspended) and vehicle assignment are two entirely disconnected axes in current code. No vehicle-related online gate should be added by this feature (§10.3).

### 2.12 Payments/wallet boundary — `VERIFIED_EXISTING`
Drivers' wallet code (`driver-wallet.repository.ts`, `wallet.service.ts`) is a **pure read model** — `getOrCreateWallet` (bootstrap create of a zero-balance row) and `listTransactions` only; no balance-mutation method exists anywhere in the Drivers module. Ledger mutations live exclusively in `payments`. Out of scope for this feature either way (§4).

### 2.13 Database invariants — `VERIFIED_EXISTING` findings
| Invariant | DB-enforced? | Evidence |
|---|---|---|
| One `Driver` per `User` | **Yes** | `drivers_user_id_key` unique index (init migration) |
| One `DriverProfile` per `Driver` | **Yes** | `driver_profiles_driver_id_key` unique index; app uses real `upsert` |
| One `DriverDocument` per `(driverId, documentType)` | **No** | Only non-unique indexes on `driver_documents`; app does findFirst-then-create/update (`upsertDocument`), a genuine TOCTOU race |
| One active ride per Driver | **No** | Only `rides_request_id_key` (per-request, not per-driver) exists; no such invariant implemented at all today |
| One active vehicle assignment per Driver | **No** | `vehicle_assignments.status` is a free-text `String`, no unique/partial-unique index |
| One active `(user, role)` pair | **Yes** | `uq_user_role_active` partial unique index `WHERE revoked_at IS NULL` (init migration) — this is the pattern to replicate for #3 |

`docs/06_Database/*.md` describes an entirely different, non-matching conceptual schema (different table names, a ledger subsystem that doesn't exist, claims of constraints — `uq_active_assignment_per_driver`, `uq_rider_one_active_trip` — that are **not present** in any migration). Disregard `docs/06_Database/` for this feature; the table above is derived directly from `prisma/schema/` and all 14 `prisma/migrations/*/migration.sql` files.

### 2.14 Existing tests — `VERIFIED_EXISTING` gap
- `tests/unit/drivers/verification-gate.test.ts` — unit test, mocked repository, tests `setOnline`'s guard logic in isolation.
- `tests/integration/auth-driver-gate.test.ts`, `tests/integration/authorization-bola.test.ts` — HTTP-level, but their `makeDriver` fixture (`tests/integration/helpers/fixtures.ts:15-42`) **writes `Driver` and a pre-`VERIFIED` `DriverDocument` row directly via Prisma**, bypassing both the document-submission and driver-approval endpoints entirely.
- **No test anywhere calls `POST /:driverId/documents`.** The `/:id/verify` transition itself is exercised via real HTTP in `authorization-bola.test.ts` (for RBAC purposes only), but every precondition state is fabricated directly in the DB. This confirms the user's stated premise (§K) that HTTP/integration coverage for the driver lifecycle is inadequate.

### 2.15 Config/env — `VERIFIED_EXISTING`
The zod-validated env schema (`src/config/env/schema.ts`) is deliberately minimal (app/server/DB/Redis/JWT secrets only). `driverConfig`, `fileConfig`, `rateLimits` are read directly off `process.env` in per-module config files with inline defaults, not validated by the central schema. `rateLimits.driverLocation` is wired to `POST /drivers/location` only — no rate limit exists on `/documents`, `/verify`, or `/status/online` today.

### 2.16 Historical audit docs — reconciliation
Per the user's instruction to verify every audit finding against current source rather than trust it: the five documents named in the task (`docs/PLATFORM_CURRENT_PRODUCTION_WORKFLOW_AND_IMPLEMENTATION_PLAN.md`, `docs/PLATFORM_FULL_WORKFLOW_AND_MODULE_OWNERSHIP_AUDIT.md`, `docs/DRIVER_MODULE_FULL_OWNERSHIP_AND_PLACEMENT_AUDIT.md`, `docs/DRIVER_PLATFORM_FINAL_CURRENT_STATE_AUDIT.md`, `docs/DRIVER_PLATFORM_FINAL_PRODUCTION_BASELINE.md`) **do not exist in this repository** (confirmed by filesystem search of `docs/` and all subdirectories). The closest existing equivalents were used instead and cross-checked line-by-line against current source in this session: `docs/DRIVER_REGISTRATION_ONBOARDING_AUDIT.md`, `docs/DRIVER_SUPPLY_PRODUCTION_AUDIT.md`, `docs/ROLE_SOURCE_AND_AUTH_FLOW_AUDIT.md`, `docs/AUTH_VERIFICATION_REPORT.md`, `docs/COMPLETE_RIDE_PLATFORM_WORKFLOW_AUDIT.md`, `docs/PRODUCTION_RIDE_WORKFLOW_AUDIT.md`, `docs/OTP_PRODUCTION_CODEBASE_AUDIT.md`, `docs/files/FLOW.md`, `docs/05_Design/08_domain-events.md`, `docs/10_Backend/02_dependency-injection.md`, `docs/06_Database/*.md`. Specific staleness found and disregarded: `docs/10_Backend/02_dependency-injection.md` describes a FastAPI/Python/SQLAlchemy stack that does not exist in this repo at all; `docs/05_Design/08_domain-events.md`'s claims of a Redis event bus and an extensive cross-module consumer catalog are aspirational, not implemented; `docs/OTP_PRODUCTION_CODEBASE_AUDIT.md`'s three most severe findings (synchronous SMS send, no worker deployed) are already remediated in current source; `docs/PRODUCTION_RIDE_WORKFLOW_AUDIT.md`'s "geo is a stub" claim is false; `docs/06_Database/*.md` describes a non-matching schema. `OPEN_QUESTION`: confirm with the user whether the five named documents were renamed/never committed, or exist in a location not yet indexed — they were not used as a source for this spec.

---

## 3. Scope

In scope (matches user's task sections A–K):
1. Driver document submission via `fileId` (Files-module-validated), replacing the raw-URL mechanism.
2. Per-document admin review endpoint (`VERIFIED`/`REJECTED`) with reviewer identity, timestamp, rejection reason.
3. One authoritative required-document eligibility function, reusing/wiring `requireApprovedDocuments`.
4. Admin driver-approval endpoint hardened to enforce the eligibility gate, valid state transitions, idempotency.
5. `driver.verified` → transactional outbox → new Auth-module subscriber → `AuthService.grantRole(userId, 'driver')`, idempotent, no direct cross-module injection.
6. JWT/token propagation behavior specified from verified epoch/refresh mechanics (no new mechanism).
7. `setOnline` hardened to use the same authoritative eligibility function; vehicle NOT added as a gate (confirmed unnecessary, §2.11).
8. Geo publish-path gated on verified+online+not-suspended, distinct from location storage.
9. `driver_documents` uniqueness invariant (`driverId`, `documentType`) — migration.
10. Acceptance tests driving the full lifecycle through HTTP/service calls, not direct DB manipulation.

## 4. Non-Goals

Per the user's explicit instruction (§L), this spec does **not** cover: full vehicle module, vehicle document workflow, dispatch matching, push notification delivery, ride `BUSY`/`ON_TRIP` lifecycle, settlement redesign, payout system, admin dashboard UI, full Drivers folder restructuring, or unrelated refactoring. Also explicitly out of scope, identified during investigation but not requested: fixing the `setSuspended`/`setOffline` nested-transaction self-lock bug (§2 finding, drivers-module agent), wiring the unused `SUSPENDED` value of `DriverVerificationStatus`, resolving `DocExpirationJob`'s non-transactional two-write pattern beyond what §10.4 requires, per-vehicle-category document requirements (no vehicle-document linkage exists yet — tracked as `OPEN_QUESTION` in §11.2), and repairing `driver_location_history` (unused, no writer exists).

## 5. Actors and Permissions

| Actor | Capabilities relevant to this feature |
|---|---|
| **Customer/unauthenticated-to-authenticated user** | Completes OTP login; `VERIFIED_EXISTING`, unaffected by this feature. |
| **Driver (self)** | Onboards (`GET /drivers/me`), completes profile, submits documents (own driver only), views own documents/wallet, goes online/offline, sends heartbeat/location. **Must never** review any document (own or others') or approve their own driver record — enforced structurally by `authorize({ roles: ['admin'] })` on review/approval routes plus an explicit self-review guard (§9.4). |
| **Admin** | Reviews individual `DriverDocument` rows (new), approves/rejects the overall `Driver` (existing endpoint, hardened), suspends drivers (existing, unchanged). |
| **Auth module (system actor)** | Consumes `driver.verified`, calls `AuthService.grantRole(userId, 'driver')` idempotently. Not a human actor; included because it is a first-class participant in the workflow. |

`CONFIGURATION_DECISION`: an admin who happens to also hold a `driver` record must not be able to review/approve their own documents — see §9.4 for the guard.

## 6. Complete User/Admin Workflow

```
1. Customer completes Phone→OTP login (VERIFIED_EXISTING, unchanged) → gets access+refresh tokens with roles:['customer'].
2. Driver onboarding: GET /drivers/me (VERIFIED_EXISTING) → Driver row created, verificationStatus=PENDING.
3. PATCH /drivers/:driverId/profile (VERIFIED_EXISTING) → DriverProfile completed.
4. For each required document type:
   a. POST /files → presigned S3 PUT URL (VERIFIED_EXISTING, purpose=DRIVER_DOCUMENT).
   b. Client PUTs bytes to S3 directly.
   c. POST /files/:id/complete (VERIFIED_EXISTING) → File row transitions to READY.
   d. POST /drivers/:driverId/documents {documentType, fileId, documentNumber?, expiresAt?} (REQUIRED_CHANGE)
      → validates fileId via FileLifecycleService.assertReferenceable(fileId, callerUserId, 'DRIVER_DOCUMENT', tx)
      → writes DriverDocument{fileId, verificationStatus: PENDING}
      → first submission advances Driver PENDING→DOCUMENT_REVIEW (VERIFIED_EXISTING behavior, kept).
5. Admin reviews each submitted document:
   POST /drivers/:driverId/documents/:documentId/review {status: VERIFIED|REJECTED, rejectionReason?} (REQUIRED_CHANGE, admin-only)
   → writes verifiedBy, verifiedAt, verificationStatus, rejectionReason.
6. Once all currently-required document types are VERIFIED and unexpired for that driver
   (computed by DriverEligibilityService.checkRequiredDocuments — REQUIRED_CHANGE),
   admin may approve the driver:
   POST /drivers/:id/verify {status: VERIFIED} (HARDENED, REQUIRED_CHANGE)
   → runs eligibility gate; rejects with 422 if not eligible
   → validates state transition
   → writes approvedBy, approvedAt (VERIFIED_EXISTING fields, already wired)
   → publishes DRIVER_EVENT_CATALOG.VERIFIED transactionally, now including data.userId (REQUIRED_CHANGE: add field)
7. Outbox relay (VERIFIED_EXISTING, ~1s tick) delivers driver.verified to the in-process EventBus.
8. New AuthDriverVerifiedConsumer (REQUIRED_CHANGE) receives it, calls
   AuthService.grantRole(userId, 'driver') — idempotent (VERIFIED_EXISTING), bumps Redis epoch on first grant.
9. Driver's outstanding access token is now epoch-stale; next authenticated request → 401 TOKEN_STALE
   (VERIFIED_EXISTING) → client calls POST /auth/refresh (VERIFIED_EXISTING) → new access token
   with roles:[...,'driver'] and fresh epoch is issued (roles re-resolved from DB on every refresh).
10. POST /drivers/status/online (HARDENED, REQUIRED_CHANGE: reuse eligibility function instead of ad-hoc license check)
    → requireOperableDriver preHandler (VERIFIED_EXISTING, DB-backed, role-claim-independent) already permits
      this immediately after step 6, even before step 9 completes (see §14 for why this is safe and intended).
    → Driver.isAvailable=true, DriverShiftLog started (VERIFIED_EXISTING), driver.status_changed published.
11. POST /drivers/location pings (VERIFIED_EXISTING endpoint, HARDENED gate) → durable PostGIS write always
    happens; live Redis/H3 index publish now gated on verified+online+not-suspended (REQUIRED_CHANGE, §10.5).
12. Driver now appears in GeoService.findNearbyDrivers results (VERIFIED_EXISTING read path, unaffected).
```

## 7. Functional Requirements

Numbered `FR-*`, each independently testable, each labeled.

- **FR-1** (`REQUIRED_CHANGE`): `POST /drivers/:driverId/documents` MUST accept `fileId: string (uuid)` instead of `fileUrl: string (url)`, and MUST reject requests still supplying `fileUrl` (schema-level 400, not silently ignored).
- **FR-2** (`REQUIRED_CHANGE`): Before persisting a `DriverDocument`, the service MUST call `FileLifecycleService.assertReferenceable(fileId, callerUserId, 'DRIVER_DOCUMENT', tx)` inside the same transaction as the document write. Any thrown `FileNotFoundError`/`FileStateError`/`FileInUseError` MUST propagate as the corresponding driver-module 4xx (mapped, not swallowed).
- **FR-3** (`REQUIRED_CHANGE`): The caller's `userId` used for `assertReferenceable` MUST be the *authenticated caller's* userId, not a value read from the request body — this is what prevents attaching another user's `fileId` (BOLA).
- **FR-4** (`REQUIRED_CHANGE`): On successful validation, `DriverDocument.fileId` MUST be written (new FK column, §12). If a document of that `(driverId, documentType)` already exists, the previous `fileId` MUST be released via `FileLifecycleService.supersede(previousFileId, newFileId, tx, requestId)`, mirroring the Users profile-image pattern exactly.
- **FR-5** (`REQUIRED_CHANGE`): Re-submitting a document (replacing an existing one) MUST reset `verificationStatus` to `PENDING`, `verifiedBy`/`verifiedAt`/`verificationNotes`/`rejectionReason` to `null` (existing hardcoded-PENDING behavior is kept, but see FR-6 for the driver-level side effect this behavior was previously missing).
- **FR-6** (`REQUIRED_CHANGE`): If a document that was `VERIFIED` and *required* is replaced (re-uploaded) while the driver's `verificationStatus` is currently `VERIFIED`, the driver MUST be downgraded to `DOCUMENT_REVIEW` in the same transaction (mirrors the existing `DocExpirationJob` behavior for expiry, applied consistently to re-upload).
- **FR-7** (`REQUIRED_CHANGE`): New endpoint `POST /drivers/:driverId/documents/:documentId/review`, admin-only (`authorize({ roles: ['admin'] })`), body `{ status: 'VERIFIED' | 'REJECTED', rejectionReason?: string }`. `rejectionReason` MUST be required (schema-enforced, min length 1) when `status === 'REJECTED'`.
- **FR-8** (`REQUIRED_CHANGE`): The review endpoint MUST reject (409) if `documentId` does not belong to `driverId` in the URL (defense against ID confusion), and MUST reject (404) if the document does not exist.
- **FR-9** (`CONFIGURATION_DECISION`): Valid document-review transitions: `PENDING → VERIFIED`, `PENDING → REJECTED`, `VERIFIED → REJECTED` (admin reconsideration), `REJECTED → VERIFIED` (admin reconsideration after clarification) are all permitted — admin decisions are reversible by a subsequent admin action. Re-submitting the *same* status as the document's current status MUST be idempotent (200, no-op, no timestamp/reviewer overwrite) — this satisfies the user's explicit idempotency requirement without inventing a rigid one-way state machine the business hasn't asked for.
- **FR-10** (`REQUIRED_CHANGE`): The review endpoint MUST refuse (403) if the authenticated admin's `userId` equals the driver's `userId` (self-review guard, §9.4), even though `roles: ['admin']` already structurally prevents a `driver`-only user from reaching this route.
- **FR-11** (`REQUIRED_CHANGE`): A single authoritative `DriverEligibilityService.checkRequiredDocuments(driverId, tx?)` MUST be the only code path that decides required-document eligibility. It MUST be called from both `reviewDriverVerification` (approval gate) and `setOnline` (online gate) — no duplicated inline checks in controllers.
- **FR-12** (`CONFIGURATION_DECISION`): Required document types for MVP: `DRIVING_LICENSE`, `RC`, `INSURANCE` (matches the existing ad-hoc `DRIVING_LICENSE`-only check's intent, extended to the full set implied by `driver.constants.ts`'s document-type list and the vehicle-relevant subset). Configurable via a new `driverConfig.requiredDocumentTypes: DriverDocumentTypeEnum[]` (env-overridable, default as above) — this is additive, not a duplicate of `requireApprovedDocuments` (see FR-13). `AADHAAR`, `PAN`, `PUC`, `POLICE_VERIFICATION`, `PROFILE_PHOTO` remain optional/non-blocking for this feature. `OPEN_QUESTION`: confirm this exact required set with product/compliance before `/speckit.plan`.
- **FR-13** (`REQUIRED_CHANGE` — wiring an existing field, not adding a duplicate): `driverConfig.requireApprovedDocuments` (already declared, currently dead) becomes the **master on/off switch** for the entire eligibility gate. When `false`, `DriverEligibilityService.checkRequiredDocuments` always returns eligible (escape hatch for staging/local dev); when `true` (production default), the full gate in FR-14 applies.
- **FR-14** (`REQUIRED_CHANGE`): `checkRequiredDocuments` returns `{ eligible: boolean, missing: DocumentType[], pending: DocumentType[], rejected: DocumentType[], expired: DocumentType[] }`, computed as: for each type in `requiredDocumentTypes`, find the driver's document of that type; absent → `missing`; `verificationStatus === 'PENDING'` → `pending`; `verificationStatus === 'REJECTED'` → `rejected`; `verificationStatus === 'VERIFIED' && expiresAt !== null && expiresAt <= now` → `expired` (live check, not dependent on the async expiration job having run); `verificationStatus === 'VERIFIED' && (expiresAt === null || expiresAt > now)` → eligible for that type. `eligible` (overall) is `true` iff `missing/pending/rejected/expired` are all empty. A driver with **zero** documents submitted is `missing` for every required type and therefore **cannot** be approved (explicit answer to the user's "can a driver be approved with zero documents" question: **no**).
- **FR-15** (`REQUIRED_CHANGE`): `POST /drivers/:id/verify` with `status: 'VERIFIED'` MUST call `checkRequiredDocuments` first; if `eligible === false`, respond `422` with the structured missing/pending/rejected/expired breakdown and MUST NOT write any state change or publish any event.
- **FR-16** (`REQUIRED_CHANGE`): `POST /drivers/:id/verify` MUST validate the transition: allowed target `VERIFIED` from current `PENDING | DOCUMENT_REVIEW | REJECTED`; allowed target `REJECTED` from current `PENDING | DOCUMENT_REVIEW | VERIFIED`. If current status already equals the requested target status, the call is idempotent: return the existing row unchanged, do not re-run the eligibility gate, do not re-publish `DRIVER_EVENT_CATALOG.VERIFIED`, do not re-fire the metric.
- **FR-17** (`REQUIRED_CHANGE`): The `driverEvent(DRIVER_EVENT_CATALOG.VERIFIED, driverId, data)` call in `reviewDriverVerification` MUST include `data.userId` (the driver's `User.id`) and SHOULD set `subjectUserId` on the `PublishInput` — required so the new Auth consumer can call `grantRole(userId, ...)` without an out-of-module DB query.
- **FR-18** (`REQUIRED_CHANGE`): New `AuthDriverVerifiedConsumer` (in `src/modules/auth/consumers/`, mirroring `EpochInvalidationConsumer`'s registration pattern) subscribes to `'driver.verified'` on the shared `EventBus` and calls `authService.grantRole(event.data.userId, 'driver', { grantedBy: event.data.approvedBy ?? null })`.
- **FR-19** (`REQUIRED_CHANGE`): The consumer MUST NOT throw on a duplicate/already-granted delivery — this is automatically satisfied by `grantRole`'s existing idempotency (`findActiveAssignment` check), requiring no additional dedup logic in the consumer itself.
- **FR-20** (`REQUIRED_CHANGE`): `StatusService.setOnline` MUST replace its ad-hoc `hasValidLicense` check with a call to `DriverEligibilityService.checkRequiredDocuments(driverId, tx)`, rejecting with `DriverNotVerifiedError` (structured detail) if not eligible — this is what actually makes `setOnline` reachable again in production (§2.4's dead-end is fixed by this + FR-7/FR-9 making document verification reachable at all).
- **FR-21** (`CONFIGURATION_DECISION`, per §2.11 evidence): No vehicle-assignment check is added to `setOnline`. This is confirmed correct by evidence, not merely assumed.
- **FR-22** (`REQUIRED_CHANGE`): `LocationService.updateLocation` MUST continue to write the durable `driver_locations` row unconditionally (support/ops/history needs), but MUST only call `geoService.recordDriverPosition(...)` (the live-index publish) when, at call time, `driver.verificationStatus === 'VERIFIED' && !driver.isSuspended && driver.isAvailable === true` (i.e., currently online). If any condition fails, the location is stored but not published to the live index, and the previously-published position (if any) is left as-is (natural TTL expiry in Redis handles staleness — see §15.2 for the small residual window this implies).
- **FR-23** (`REQUIRED_CHANGE`): `DocExpirationJob`'s existing driver-downgrade-to-`DOCUMENT_REVIEW` path (and the new FR-6 re-upload-downgrade path) MUST also call `geoService.forgetDriverPosition(driverId)` and force the driver offline (reuse `StatusService.setOffline` logic/its shift-closing + `isAvailable=false` + status-changed-event side effects) if the driver was currently online — mirroring the existing `setSuspended → setOffline` cascade.
- **FR-24** (`REQUIRED_CHANGE`, migration): Add a database-level uniqueness invariant on `driver_documents(driver_id, document_type)` (§12). Convert `DriverDocumentRepository.upsertDocument` to a real atomic Prisma `upsert` once the constraint exists (matches the pattern already used correctly for `DriverProfile`).

## 8. State Transitions

### 8.1 `Driver.verificationStatus` (`DriverVerificationStatus`: `PENDING | DOCUMENT_REVIEW | VERIFIED | REJECTED | SUSPENDED`)
```
PENDING ──(first document submitted)──► DOCUMENT_REVIEW      [VERIFIED_EXISTING]
DOCUMENT_REVIEW ──(admin approves, eligibility gate passes)──► VERIFIED   [REQUIRED_CHANGE: gated]
DOCUMENT_REVIEW ──(admin rejects)──► REJECTED                 [VERIFIED_EXISTING]
REJECTED ──(admin approves, eligibility gate passes)──► VERIFIED   [REQUIRED_CHANGE: gated, newly allowed explicitly]
VERIFIED ──(admin rejects)──► REJECTED                         [VERIFIED_EXISTING, unchanged]
VERIFIED ──(required doc expires OR is re-uploaded)──► DOCUMENT_REVIEW  [FR-23/FR-6, REQUIRED_CHANGE: now also forces offline+geo-forget]
VERIFIED / REJECTED ──(re-approve/re-reject to same value)──► no-op (idempotent)   [FR-16, REQUIRED_CHANGE]
```
`SUSPENDED` (the enum value) remains unused — suspension continues to be modeled via the separate `Driver.isSuspended` boolean (`VERIFIED_EXISTING`, unchanged; wiring the enum value is explicitly out of scope, §4).

### 8.2 `DriverDocument.verificationStatus` (shared `VerificationStatus`: `PENDING | VERIFIED | REJECTED`)
```
(create/re-upload) ──► PENDING                                 [VERIFIED_EXISTING]
PENDING ──(admin reviews VERIFIED)──► VERIFIED                  [REQUIRED_CHANGE, new endpoint]
PENDING ──(admin reviews REJECTED)──► REJECTED                  [REQUIRED_CHANGE, new endpoint]
VERIFIED ──(admin reviews REJECTED)──► REJECTED                 [REQUIRED_CHANGE, allowed per FR-9]
REJECTED ──(admin reviews VERIFIED)──► VERIFIED                 [REQUIRED_CHANGE, allowed per FR-9]
VERIFIED ──(expiresAt passes, DocExpirationJob)──► REJECTED      [VERIFIED_EXISTING, "expired" overloads REJECTED — no EXPIRED enum value exists; kept as-is, not introducing a schema enum change for this]
(any) ──(document re-uploaded)──► PENDING                       [VERIFIED_EXISTING behavior, kept]
```
`CONFIGURATION_DECISION`: no new `EXPIRED` enum value is introduced; expiry continues to be represented as `REJECTED` with `rejectionReason: 'Document expired'` (existing convention) plus the live `expiresAt` check inside `checkRequiredDocuments` (FR-14) so expiry is caught even between job runs.

## 9. Authorization Rules

- **9.1** Document submission (`POST /drivers/:driverId/documents`): caller must be the driver identified by `driverId` (existing `actingDriverId` resolution, `VERIFIED_EXISTING`, unchanged) — no admin bypass needed for submission.
- **9.2** Document review (`POST /drivers/:driverId/documents/:documentId/review`): `authorize({ roles: ['admin'] })` (`REQUIRED_CHANGE`, mirrors the existing `/verify` and `/suspend` route guards exactly).
- **9.3** Driver approval (`POST /drivers/:id/verify`): `authorize({ roles: ['admin'] })` (`VERIFIED_EXISTING`, unchanged).
- **9.4** (`REQUIRED_CHANGE`) Self-review guard: both the document-review and driver-approval services MUST load the target driver's `userId` and compare it to the authenticated caller's `userId`; if equal, refuse with `403 SELF_REVIEW_FORBIDDEN`. This defends the specific case of an admin-role user who is also onboarded as a driver record.
- **9.5** File attach authorization (`FR-3`): delegated entirely to `FileLifecycleService.assertReferenceable`, which already enforces owner-match and purpose-match — no duplicate authorization logic inside Drivers (`VERIFIED_EXISTING` primitive, reused per the user's explicit instruction not to duplicate Files' authorization).
- **9.6** `POST /drivers/status/online`: `authorize({ requireOperableDriver: true })` (`VERIFIED_EXISTING` preHandler, unchanged — its underlying DB predicate is unaffected by this feature since it never checked documents).

## 10. File Ownership/Security Rules

- **10.1** (`VERIFIED_EXISTING`, reused) A `fileId` is only usable for a driver document if: the `File` row exists; `status === 'READY'`; `deletedAt === null`; `ownerUserId === callerUserId`; `purpose === 'DRIVER_DOCUMENT'`; and no other module already holds a live reference to it (`findLiveReference` check inside `assertReferenceable`).
- **10.2** (`REQUIRED_CHANGE`) `src/modules/drivers/index.ts` MUST call `registerFileReference('DRIVER_DOCUMENT', { module: 'drivers', isReferenced: (fileId, tx) => driverDocumentRepository.isDocumentFile(fileId, tx) })`, mirroring `src/modules/users/index.ts:36-40` exactly, so Files' deletion/orphan-check logic can see driver-document references.
- **10.3** (`REQUIRED_CHANGE`) New `DriverDocumentRepository.isDocumentFile(fileId, tx?)` method: `count({ where: { fileId } }) > 0`.
- **10.4** `DriverDocument` persists `fileId` (FK to `File`) — **not** a raw URL, **not** a duplicated metadata snapshot, **not** a second storage system (`REQUIRED_CHANGE`, direct answer to the user's explicit question in §A: reuse the Files module's identity mechanism, do not invent an alternative representation). Secure retrieval of the underlying bytes for admin review continues to go through the existing `FileAccessService.getReadUrl` (time-limited signed URL, already scope-gated for ops roles via `OPS_SCOPE_FOR_PURPOSE.DRIVER_DOCUMENT = 'drivers:verify'`, `VERIFIED_EXISTING`, unchanged, no new admin-file-read endpoint needed).
- **10.5** (`REQUIRED_CHANGE`) Geo publish gating, per FR-22: storing location (PostGIS) and publishing availability (Redis/H3 live index) are explicitly two different operations from this point forward, with the second one conditional. This directly answers the user's requirement in §G to distinguish these two concerns.

## 11. Required-Document Eligibility Rules

(Also see FR-11 through FR-14.)

- **11.1** Mandatory document set for MVP: `DRIVING_LICENSE`, `RC`, `INSURANCE` (`CONFIGURATION_DECISION`, `OPEN_QUESTION` for final business sign-off).
- **11.2** (`OPEN_QUESTION`) Whether requirements vary by vehicle/service category: **not supported today and not built by this feature** — `src/modules/vehicles` is a stub with no document linkage, and no vehicle-category concept exists in `DriverDocument`. A single flat required-set applies to all drivers. Revisit once the Vehicle module (explicitly a non-goal, §4) exists.
- **11.3** Missing documents (types with no submitted row): eligibility `false`, transition blocked (FR-14).
- **11.4** Rejected required documents: eligibility `false` (FR-14) — a driver cannot be approved while any required document is currently `REJECTED`; they must re-submit (which resets to `PENDING`, FR-5) and get re-reviewed.
- **11.5** Expired required documents: eligibility `false`, computed live from `expiresAt` at check time, not solely dependent on the async `DocExpirationJob` (FR-14) — closes the race where a document expired minutes ago but the job hasn't swept it yet.
- **11.6** Re-upload resets review status to `PENDING` (`VERIFIED_EXISTING` behavior, kept) and, if the driver was `VERIFIED`, downgrades the driver to `DOCUMENT_REVIEW` (FR-6, `REQUIRED_CHANGE` — this specific driver-level cascade did not previously exist for re-upload, only for expiry).
- **11.7** Zero documents: cannot be approved — every required type is `missing` (FR-14, direct answer to user's explicit question).

## 12. Driver Approval Rules

(See FR-15 through FR-19, and §8.1 for transitions.) Summary: validates driver exists (`VERIFIED_EXISTING`) → validates transition is allowed (`REQUIRED_CHANGE`) → runs `checkRequiredDocuments` when targeting `VERIFIED` (`REQUIRED_CHANGE`) → records `approvedBy`/`approvedAt` (`VERIFIED_EXISTING` columns, already wired by `updateVerificationStatus`) → idempotent on same-state re-calls (`REQUIRED_CHANGE`) → publishes `DRIVER_EVENT_CATALOG.VERIFIED` transactionally with `userId` included (`REQUIRED_CHANGE` addition to existing `VERIFIED_EXISTING` publish call).

## 13. Event and Role Propagation Rules

- **13.1** Event: reuse `DRIVER_EVENT_CATALOG.VERIFIED` (`'driver.verified'`) — **do not invent a new event**, per explicit instruction and confirmed correct existing value (`VERIFIED_EXISTING`).
- **13.2** Transport: existing transactional outbox (`VERIFIED_EXISTING`) — event row written in the same DB transaction as the `Driver.verificationStatus` write; relay polls every ~1000ms (default `OutboxRelay` tick), claims via `FOR UPDATE SKIP LOCKED`, retries with exponential backoff up to 8 attempts before dead-lettering.
- **13.3** Consumer: new `AuthDriverVerifiedConsumer` in the **Auth module** (not Drivers) — satisfies Option B (§E of the task): Drivers never imports `AuthService`; Auth reaches into its own `grantRole` in response to an event it subscribes to (`REQUIRED_CHANGE`, first cross-module consumer in this codebase, §2.8).
- **13.4** Idempotency/duplicate delivery: guaranteed by `AuthService.grantRole`'s existing `findActiveAssignment`-then-`create` check (`VERIFIED_EXISTING`) — a duplicate `driver.verified` delivery (at-least-once semantics, confirmed, §2.8) results in a harmless no-op, no duplicate `UserRoleAssignment` row (the `uq_user_role_active` partial unique index, §2.13, is the DB-level backstop even if the application check were ever bypassed).
- **13.5** No circular dependency: Auth already depends on nothing from Drivers; Drivers does not depend on Auth for this feature (event-only coupling) — DI registration order in `di.ts` (`registerAuthService` before `registerDriversModule`, `VERIFIED_EXISTING`) remains valid and requires no change.
- **13.6** Role revocation semantics: unaffected — `AuthService.revokeRole` (`VERIFIED_EXISTING`) is not invoked by this feature. `OPEN_QUESTION`: should driver suspension or rejection-after-verification trigger `revokeRole(userId, 'driver')`? Not requested by the task (§E only specifies grant-on-verify) and no existing suspension→role-revoke path exists; flagged for a follow-up feature rather than silently added here.
- **13.7** Eventual-consistency window (§14 has the full mechanics): bounded by outbox relay tick (~1s) + consumer processing (sub-second, in-process) + time until the client's next authenticated request triggers `401 TOKEN_STALE` and a refresh. Typically low-single-digit seconds to the next natural API call; unbounded only if the client goes fully idle, in which case the stale token simply remains valid for role-independent endpoints (see §14) until it naturally expires or the next request occurs.

## 14. Token/JWT Propagation Behavior (verified against current code, not assumed)

This directly answers the user's instruction not to assume refresh behavior.

1. `AuthService.grantRole` bumps the per-user Redis epoch **only when a new grant actually happens** (`VERIFIED_EXISTING`, §2.8) — a duplicate event delivery does not bump it twice.
2. Every authenticated request checks `claims.epoch !== currentEpoch(userId)` (`auth.plugin.ts:43-45`, `VERIFIED_EXISTING`) and returns `401 TOKEN_STALE` on mismatch — this happens for **any** endpoint, not just role-gated ones, so the driver's very next API call after approval (regardless of which endpoint) will fail with `TOKEN_STALE` if it used the pre-approval access token.
3. The client's existing 401-triggers-refresh behavior (assumed to already exist for other epoch-invalidating events like suspension and session revocation — `VERIFIED_EXISTING` pattern the app must already implement for those cases to work at all) calls `POST /auth/refresh` with the refresh token.
4. Refresh (`TokenService.rotate`, `VERIFIED_EXISTING`) re-resolves roles **fresh from the database** on every call (`AuthService.resolveActiveRoles` → `RoleRepository.findActiveRoleSlugs`) and mints a new access token with the current epoch and `roles: [...,'driver']`.
5. **Critically, `POST /drivers/status/online` does not need step 3–4 to have happened yet.** Its `requireOperableDriver` gate (`VERIFIED_EXISTING`, §2.8) queries the `drivers` table directly (`verificationStatus === 'VERIFIED' && !isSuspended && deletedAt === null`) — it never inspects the JWT's `roles` claim. So a driver whose access token is already `TOKEN_STALE` (post-approval, pre-refresh) can still successfully call `/status/online`, **provided** they first hit any endpoint that forces the refresh, or the client refreshes proactively/silently before the stale token is used at all. If the client attempts `/status/online` with the stale token directly, standard request-level auth (`authenticate`, checked before `authorize`) will 401 it first — the client must refresh regardless, but the *reason* going-online works right after refreshing is the DB-backed operability check, not the `driver` role claim being present.
6. `CONFIGURATION_DECISION`: this spec does not add a `roles.includes('driver')` check to `/status/online` — `requireOperableDriver` is sufficient and already role-claim-independent, which is actually the more robust design (avoids a hard dependency on token freshness for this specific gate). The `driver` role claim remains useful for *other* purposes (e.g., driver-specific UI gating, other future driver-role-gated endpoints) but is not load-bearing for online eligibility.
7. **Answer to the user's explicit question** ("how does a newly approved driver obtain a token containing the new driver role"): via the **existing, unmodified** refresh-token rotation endpoint, triggered by the **existing, unmodified** epoch-staleness check — no new token endpoint, no new refresh trigger, no polling mechanism is introduced by this feature. The only *new* piece is what causes the epoch to bump in the first place (`grantRole` being called at all, via FR-18's consumer).

## 15. Online Eligibility Rules

- **15.1** (`REQUIRED_CHANGE`, FR-20) `setOnline` checks, in order: driver exists → row-locked → `verificationStatus === 'VERIFIED'` → `!isSuspended` → `DriverEligibilityService.checkRequiredDocuments` returns `eligible: true`. This replaces the single-license ad-hoc check with the same authoritative function used at approval time (FR-11), and is what makes `setOnline` reachable in production for the first time (§2.4).
- **15.2** No vehicle-assignment check (`CONFIGURATION_DECISION`, confirmed correct by §2.11 evidence — explicitly not adding what the user warned against).
- **15.3** Role/authorization: `requireOperableDriver` preHandler (`VERIFIED_EXISTING`, unchanged — its predicate was never document-dependent, so this feature does not need to modify it; it already independently enforces verified+not-suspended+not-deleted at the route layer, redundant with but not weaker than the service-layer check in 15.1).
- **15.4** Idempotency: calling `setOnline` while already online is `VERIFIED_EXISTING` behavior via `shiftRepo.startShift`'s existing idempotency (returns the existing open shift) — unaffected by this feature, no change needed.

## 16. Location/Geo Availability Rules

(See FR-22, FR-23, §10.5.)
- **16.1** Location **storage** (durable `driver_locations` PostGIS row): unconditional, for any existing driver row, regardless of state (`VERIFIED_EXISTING`, unchanged) — needed for support/ops tooling regardless of eligibility.
- **16.2** Location **publish to live geo/dispatch index** (Redis/H3): conditional on `verificationStatus === VERIFIED && !isSuspended && isAvailable === true` at the moment of the location update (`REQUIRED_CHANGE`, FR-22) — this is the concrete mechanism preventing unverified/suspended/offline drivers from polluting dispatch availability, since `GeoService`/`NearbyDriverService` itself deliberately performs no eligibility filtering by design (`VERIFIED_EXISTING`, §2.10) and callers are expected to gate.
- **16.3** When a driver transitions out of eligibility while already published (suspension, document expiry/re-upload downgrade — FR-23), the live position MUST be actively removed via `geoService.forgetDriverPosition` (mirrors the existing `setOffline` behavior, `VERIFIED_EXISTING` for the suspend case, `REQUIRED_CHANGE` to extend to the doc-expiry/re-upload case).
- **16.4** Residual staleness window (`OPEN_QUESTION`/acceptable-risk note): between a driver going ineligible mid-shift (e.g., their license silently expires while `ONLINE`) and the next `DocExpirationJob` run or explicit action, their last-published Redis position remains until its TTL (`GEO_LIVE_LOCATION_TTL_SEC`) naturally expires or `forgetDriverPosition` is called. FR-23 closes this for the expiry-job path; there is no proactive real-time trigger the instant `expiresAt` passes (would require a scheduled per-document timer, out of scope for this feature — the existing job cadence is retained).

## 17. Database Invariants

- **17.1** (`REQUIRED_CHANGE`, migration) Add `@@unique([driverId, documentType])` to `DriverDocument` (or equivalent raw-SQL `CREATE UNIQUE INDEX`), enforcing invariant #3 from the user's list. See §18 for full migration plan.
- **17.2** Invariants #1, #2 already DB-enforced (`VERIFIED_EXISTING`, §2.13) — no change.
- **17.3** Invariants #4 (one active ride per driver) and #5 (one active vehicle assignment per driver) are confirmed **not** enforced at any level today, and are **out of scope** for this feature (§4) — noted per the user's instruction to explicitly address only #3, with #4/#5 flagged as pre-existing gaps for a separate feature (`OPEN_QUESTION`/tracked-but-not-fixed-here).
- **17.4** New FK: `DriverDocument.fileId → File.id`, `onDelete: Restrict` (mirrors `UserProfile.profileImageFileId`'s existing pattern exactly, `REQUIRED_CHANGE`), with `@unique` on `fileId` (one file cannot back two document rows, defense-in-depth alongside the application-level `findLiveReference` check).

## 18. Migration Requirements

Two migrations, both `REQUIRED_CHANGE`:

**Migration A — `driver_documents` uniqueness (invariant #3):**
1. Pre-migration data check: `SELECT driver_id, document_type, COUNT(*) FROM driver_documents GROUP BY 1,2 HAVING COUNT(*) > 1;` — run against the target environment before deploying.
2. Duplicate handling strategy: for any existing duplicate `(driver_id, document_type)` group, keep the row with the latest `updated_at` (most recent submission is the intended current state) and delete the older row(s) — a one-time cleanup `DELETE` in the migration's `up`, scoped only to non-latest rows per group (safe because `upsertDocument`'s findFirst-then-update pattern means only one row per group was ever being *read* going forward anyway; the older rows are dead data, not conflicting live state).
3. Index type: **plain unique index**, not partial — `DriverDocument` has no soft-delete (`deletedAt`) column, so there's no "only constrain live rows" nuance needed (unlike `uq_users_phone_active`/`uq_user_role_active`, which are partial because those tables do soft-delete/revoke). `CREATE UNIQUE INDEX "driver_documents_driver_id_document_type_key" ON "driver_documents"("driver_id", "document_type");`
4. Rollback: `DROP INDEX "driver_documents_driver_id_document_type_key";` — safe, reversible, no data loss on rollback (the cleanup DELETE from step 2 is not reversible, which is why step 1's pre-check is mandatory before running in any environment with real data).
5. Compatibility: `DriverDocumentRepository.upsertDocument` MUST be converted to a real `client.driverDocument.upsert({ where: { driverId_documentType: { driverId, documentType } }, ... })` in the same change as this migration (FR-24) — deploying the constraint without the code change would turn the existing race into hard 500s (Prisma `P2002`) instead of silent duplication, which is strictly better but should still ship together.

**Migration B — `DriverDocument.fileId` FK (Files integration, §10.4, §17.4):**
1. Add nullable `file_id UUID` column + FK to `files(id)` `ON DELETE RESTRICT` + `UNIQUE` index, in one migration.
2. Data handling: any pre-existing `driver_documents` rows only have `file_url` (raw string), which cannot be mechanically resolved to a `File` row (no corresponding upload ever went through the Files module for them, per §2.2/§2.7 — this endpoint was never wired to Files). These rows MUST be treated as invalid on migration: set their `verification_status = 'PENDING'` (force re-review) if not already, and surface them to affected drivers for re-submission via the new `fileId` flow. `OPEN_QUESTION`: confirm with the user/ops whether any such legacy rows actually exist in a real environment (a fresh `zaroorat-back` deployment may have none) before deciding whether an active backfill/notification step is needed versus a no-op.
3. Whether `file_url` is dropped in this same migration or kept temporarily nullable for a rollback window: `CONFIGURATION_DECISION` — drop it in the same migration once FR-1 (schema-level rejection of `fileUrl` in the request) ships, since keeping a write-only dead column serves no purpose and the user explicitly said not to invent/preserve a second storage mechanism.
4. Make `file_id` `NOT NULL` only after the backfill/cleanup from step 2 completes (two-phase migration if any legacy rows are found in step 2's investigation; single-phase `NOT NULL` from the start if none exist).
5. Rollback: re-add `file_url` nullable column (data not recoverable — this is a forward-only migration in practice once documents are re-submitted through the new flow; document this clearly as an accepted one-way door given the endpoint was non-functional in production anyway per §2.4's core finding).

## 19. Failure Scenarios

| Scenario | Expected behavior | Rule |
|---|---|---|
| Arbitrary/foreign file URL submitted | Schema rejects (`fileUrl` no longer accepted) | FR-1 |
| `fileId` belongs to another user | `FileNotFoundError` (not exposing existence via a distinct 403) | 10.1, `VERIFIED_EXISTING` `FileAccessService` convention of not leaking existence |
| Nonexistent `fileId` | `FileNotFoundError` | 10.1 |
| `fileId` has wrong purpose (e.g. `PROFILE_IMAGE`) | `FileNotFoundError` (purpose mismatch treated same as not-found by `assertReferenceable`) | 10.1 |
| `fileId` file not yet `READY` (still uploading) | `FileStateError` | 10.1 |
| Driver reviews own or another driver's document | 403 (role gate + FR-10 self-review guard) | 9.2, 9.4 |
| Admin approves driver with missing required docs | 422 with structured breakdown, no state change | FR-15 |
| Admin approves driver with a `PENDING` required doc | 422 (counted under `pending`) | FR-14, FR-15 |
| Admin approves driver with a `REJECTED` required doc | 422 (counted under `rejected`) | FR-14, FR-15 |
| Admin approves driver with an expired required doc | 422 (counted under `expired`, live-computed) | FR-14, FR-15 |
| Re-approving an already-`VERIFIED` driver | 200, idempotent no-op, no duplicate event | FR-16 |
| `setOnline` called before verification | `DriverNotVerifiedError` (403) | 15.1, `VERIFIED_EXISTING` first check |
| `setOnline` called before token refresh (role propagation lag) | Succeeds anyway — `requireOperableDriver` is DB-backed, not role-claim-based | §14.5 |
| Duplicate `driver.verified` event delivery | No duplicate `UserRoleAssignment`; DB unique index is the backstop | 13.4 |
| Concurrent duplicate document submission (same type) | Post-migration: second write gets `P2002`, mapped to a 409 (`REQUIRED_CHANGE`: add error mapping for this Prisma error code in the driver-document write path) | 17.1, 18/A |

## 20. Idempotency and Concurrency Requirements

- Document submission: post-migration atomic `upsert` keyed by `(driverId, documentType)` (FR-24) — no lost-update/duplicate-row race.
- Document review: same-status re-review is a no-op (FR-9).
- Driver approval: same-status re-approval is a no-op (FR-16); row-locked via existing `lockForUpdate` (`VERIFIED_EXISTING`, unchanged) preventing concurrent approve+reject races.
- Role grant: idempotent via `findActiveAssignment` check (`VERIFIED_EXISTING`, §2.8); DB unique index (`uq_user_role_active`) is the concurrency backstop for a true race between two simultaneous consumer invocations (at-least-once delivery could in theory deliver to two relay instances if not for `FOR UPDATE SKIP LOCKED` claiming — already `VERIFIED_EXISTING` protection at the outbox layer).
- Event delivery: at-least-once, no generic consumer-side dedup exists in the codebase (`VERIFIED_EXISTING` gap, §2.8) — this feature's consumer is safe without one only because `grantRole` itself is idempotent; this is called out explicitly rather than assumed.

## 21. API Behavior Requirements

- `POST /drivers/:driverId/documents`: 201 on create/replace, structured `DriverDocument` view (excluding raw `fileId` internal storage details beyond what's already returned today) in response body; 400 on schema violation (including a `fileUrl` field now being rejected); 404/409/422 per §19.
- `POST /drivers/:driverId/documents/:documentId/review`: 200 with updated `DriverDocument`; 400/403/404/409 per §19; new endpoint, no rate limit initially (`CONFIGURATION_DECISION`, consistent with `/verify` and `/suspend` today having none, §2.15).
- `POST /drivers/:id/verify`: unchanged response shape, new 422 case added (§19); no rate limit change.
- `POST /drivers/status/online`: unchanged response shape; behavior change only in what conditions now actually allow success (§15.1) — this is a bugfix, not a breaking API contract change.

## 22. Observability/Audit Requirements

- `REQUIRED_CHANGE`: add `driverMetrics` counters for document review outcomes (`documentVerified`, `documentRejected`) mirroring the existing `driverVerified`/`documentExpired` pattern in `driver.metrics.ts`.
- `REQUIRED_CHANGE`: the document-review and driver-approval endpoints must log `{ documentId | driverId, reviewerId, outcome, requestId }` at minimum — reuse the existing structured-logging convention already used elsewhere in the module (`request.log`), no new logging infrastructure needed.
- `VERIFIED_EXISTING`, reused as-is: `driverEvent`'s `classification: 'audit'` tagging already applies to `VERIFIED`/`STATUS_CHANGED`/`SUSPENDED` event types (`catalog.ts:21-24`) — the new document-review actions should similarly be treated as audit-classified if/when they are also published as events (`OPEN_QUESTION`: the task did not explicitly require a new event for per-document review outside of the driver-level `VERIFIED` event; this spec does **not** add a new `DRIVER_EVENT_CATALOG` entry for individual document review, since nothing downstream currently needs to react to it — only the driver-level `VERIFIED` transition needs to be observable via events, per §13.1's "do not invent a new event if the existing one is correct").

## 23. Acceptance Criteria

Each maps to a testable scenario in §24.

- AC-1: A driver cannot go online without submitting and having all required documents admin-verified.
- AC-2: A driver cannot be approved with zero, missing, pending, rejected, or expired required documents.
- AC-3: An admin cannot review their own driver documents.
- AC-4: A driver cannot review any document (their own or another driver's).
- AC-5: A client-supplied `fileUrl` is rejected; only a valid, owned, `READY`, correctly-purposed `fileId` is accepted.
- AC-6: Duplicate document submissions of the same type never produce two live rows (DB-enforced).
- AC-7: Driver approval publishes `driver.verified` transactionally exactly once per approval; duplicate event delivery grants the `driver` role at most once (one active `UserRoleAssignment`).
- AC-8: A newly approved driver can obtain a token carrying the `driver` role via the existing refresh flow, and can successfully call `/status/online` even before that refresh completes, because of the DB-backed `requireOperableDriver` check.
- AC-9: An unverified, suspended, or offline driver's location is stored but never appears in `GeoService.findNearbyDrivers` results.
- AC-10: Duplicate onboarding (`GET /drivers/me` called twice) remains safe (`VERIFIED_EXISTING`, regression-guard only).

## 24. Test Requirements

Per the user's explicit instruction, all state transitions in the acceptance suite MUST go through real API/service calls — no direct Prisma writes to fake state, except for setting up *unrelated* preconditions (e.g., seeding an admin user's role) where no lifecycle endpoint exists for that purpose.

**Primary end-to-end scenario** (maps to the user's 21-step list in §K verbatim — all steps REQUIRED_CHANGE as new test code, since §2.14 confirmed none of this currently exists as HTTP-level coverage):
1. OTP login → user.
2. Authenticate (access+refresh tokens obtained).
3. `GET /drivers/me` → driver onboarded.
4. `PATCH /drivers/:driverId/profile` → profile completed.
5. `POST /files` + PUT + `POST /files/:id/complete` for each required document type → `READY` files.
6. `POST /drivers/:driverId/documents` with each `fileId` → documents submitted (`PENDING`).
7. Negative: attempt submission with another user's `fileId` → rejected (ownership protection verified).
8. Admin reviews each document `VERIFIED` via the new review endpoint.
9. Negative: admin attempts `POST /drivers/:id/verify` while one required doc still `PENDING` → 422.
10. Negative: admin attempts approval with a `missing` required doc (fewer than all types submitted) → 422.
11. Admin approves driver → `VERIFIED`.
12. Assert `driver.verified` row exists in `outbox_events` / gets relayed (test can poll the outbox or use a short wait matching relay tick).
13. Assert `UserRoleAssignment` for `driver` role now exists and is active.
14. Client calls `/auth/refresh` → new access token contains `roles` including `driver`.
15. `POST /drivers/status/online` succeeds.
16. Assert a `DriverShiftLog`/open shift exists.
17. `POST /drivers/location` → assert the driver appears in `GeoService.findNearbyDrivers`.
18. Negative: a second driver who is `PENDING`/suspended/offline never appears in `findNearbyDrivers` after posting location.
19. Repeat `GET /drivers/me` → still one `Driver` row (duplicate onboarding safe).
20. Repeat step 6 for one document type → still one `DriverDocument` row for that `(driverId, documentType)` (DB constraint holds).
21. Re-deliver the same `driver.verified` event payload to the consumer directly (unit/integration-level) → still exactly one active `UserRoleAssignment`.

**Additional negative tests** (per user's explicit list): arbitrary file URL bypass (schema rejection); another user's `fileId`; nonexistent `fileId`; invalid file purpose; unauthorized document review (non-admin, and self-review); invalid document transition (`OPEN_QUESTION`: since FR-9 permits all `VERIFIED`↔`REJECTED` transitions, "invalid" here reduces to reviewing a nonexistent document or a document not belonging to the URL's driver — test that); invalid driver approval transition (e.g., attempting to approve a `SUSPENDED`... — n/a since that enum value is unused; instead test the 422-eligibility-gate cases already covered above, which are the actual "invalid approval" cases in this system); online attempt before verification; online attempt before role propagation (should succeed per AC-8 — this is a positive-outcome test disguised as the user's listed negative case, worth calling out explicitly in the test plan so it isn't miscoded as an expected-failure test); expired required document; rejected required document.

## 25. Dependencies on Existing Modules

- **Files**: `FileLifecycleService.assertReferenceable`, `.supersede`, file-reference registry (`registerFileReference`) — read-only dependency additions, no changes needed inside Files itself.
- **Auth**: `AuthService.grantRole` (used as-is), new consumer registration in `src/modules/auth/consumers/`, DI registration in `src/modules/auth/index.ts`, wired into `src/bootstrap/events.bootstrap.ts` alongside the existing `EpochInvalidationConsumer` registration.
- **Users**: no changes; `GET /me` behavior must remain untouched (§2.9, Customer Safety §J).
- **Geo**: `GeoService.recordDriverPosition`/`forgetDriverPosition` — called conditionally now instead of unconditionally; no changes needed inside Geo itself (its deliberate no-filtering design, §2.10, is preserved — filtering remains the caller's job, consistent with its documented architecture).
- **Core Events/Outbox/DI**: no changes — existing transactional outbox and Awilix `di.ts` registration order already support this feature's needs (`registerAuthService` before `registerDriversModule` already holds; no new circular dependency introduced since coupling is event-only).
- **Payments/Vehicles/Rides/Dispatch/Matching**: no changes (§4, §2.11, §2.12).

## 26. Risks and Compatibility Requirements

- **R-1**: Migration B (§18) is effectively a breaking change for any pre-existing `driver_documents` rows created via the old `fileUrl` mechanism — since that endpoint was confirmed non-functional for reaching `VERIFIED` in production (§2.4), the realistic blast radius is limited to `PENDING`/`DOCUMENT_REVIEW`-stuck test/staging data, not verified production drivers. Still requires the pre-check in §18/B.2 before any real deployment.
- **R-2**: Fixing `setOnline` (FR-20) is a **behavior-restoring bugfix**, not a new restriction — today it always fails for every driver; after this change it will succeed for drivers who complete the full document flow. No existing driver is "downgraded" by this change since none could reach `ONLINE` through the real flow before.
- **R-3**: The new cross-module consumer (FR-18) is the first of its kind in this codebase (§2.8) — establishes a pattern other modules will likely follow later; worth a short internal note/README update in `src/modules/auth/consumers/` documenting the pattern for future reuse (`OPEN_QUESTION`: whether to also update `docs/05_Design/08_domain-events.md`'s aspirational catalog to reflect this as the first real entry — recommended but not required by this spec).
- **R-4**: `requireApprovedDocuments = false` (FR-13) as an escape hatch means a misconfigured production environment could silently disable the entire eligibility gate. Recommend (`OPEN_QUESTION` for planning) adding a boot-time warning log (not a hard failure, to avoid over-scoping this spec) when `APP_ENV === 'production' && !requireApprovedDocuments`.
- **R-5**: Geo publish-gating (FR-22) changes when a driver appears/disappears from live dispatch relative to today's unconditional behavior — this is a correctness fix aligned with the user's explicit safety requirement (§G), not a compatibility break, since no legitimate current caller depends on ineligible drivers being dispatchable.
- **R-6**: `DriverDocument` review transitions are intentionally reversible (FR-9) rather than a strict one-way state machine — flagged as a `CONFIGURATION_DECISION` in case the business actually wants stricter terminal-state enforcement; easy to tighten later without a schema change.

---

## Assumptions Log (for `/speckit.clarify` if needed)

1. The five audit documents named in the original task do not exist in this repository (§2.16) — proceeded using verified current source plus the closest-matching existing docs, cross-checked line-by-line.
2. Required document type set (§11.1) is a reasonable business default inferred from the existing (broken) `DRIVING_LICENSE`-only check and the full document-type enum — not confirmed with product/compliance.
3. No new `DRIVER_EVENT_CATALOG` entry is added for per-document review (§22) since nothing downstream currently needs it — revisit if a future feature needs to react to individual document verification.
4. Document review transitions are bidirectional/reversible by admin action (§8.2, FR-9) rather than a strict terminal state machine — a deliberate default in the absence of a stated business rule either way.

---

**SPECIFICATION COMPLETE**
**NO IMPLEMENTATION HAS BEEN PERFORMED**
**CURRENT CODEBASE FINDINGS HAVE BEEN VERIFIED BEFORE SPECIFICATION**
**READY FOR /speckit.plan**
