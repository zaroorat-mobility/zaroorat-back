# Implementation Plan: Driver Document Verification & Online Eligibility Lifecycle

**Feature Directory**: `specs/001-driver-verification-lifecycle`
**Input**: [spec.md](./spec.md), [checklists/requirements.md](./checklists/requirements.md), `.specify/feature.json`
**Status**: Planning complete — no source code modified
**Created**: 2026-08-20

This plan re-verifies the spec's findings against the exact current file contents (not just architecture-level claims) and resolves every implementation-level detail needed to hand this to `/speckit.tasks`. Three things changed from the spec's tentative decisions after this deeper pass, each backed by new evidence found during planning:

1. **The `driverEvent()` payload needs no signature change** — `data.userId` alone is sufficient, because `EpochInvalidationConsumer.handle()` (`src/modules/auth/consumers/epoch-invalidation.consumer.ts:22-28`) already reads `envelope.data.userId` as a fallback when `envelope.subject.userId` is absent, and `driverEvent()` never sets `subject.userId` anyway. The spec's FR-17 "add `subjectUserId`" is dropped; only `data.userId` is added.
2. **`DriverDocumentRepository.upsertDocument`, once the DB unique constraint exists, becomes a real atomic Prisma `upsert`** — this fully closes the concurrent-duplicate-submission race at the database level via `ON CONFLICT`. No Prisma `P2002` error-mapping code is needed (contrary to spec §19's speculative row), because a genuine `upsert` against a unique constraint cannot raise `P2002` for that key.
3. **The `fileId` migration follows a strict expand-only pattern this codebase already uses for the identical situation** — migration `20260803120000_profile_image_file_id` added `profile_image_file_id` as nullable, added a unique index and an `ON DELETE RESTRICT` FK, and left the old `profile_image` URL column in place; that column was dropped only in a **later, separate** migration (`20260804090000_drop_profile_image_url`) after the cutover was live and verified. This plan follows the identical two-deploy shape for `driver_documents.file_id`/`file_url` instead of the spec's single-migration drop (§18/Migration B), because that is the codebase's own established convention for this exact class of change.

A fourth, unplanned finding surfaced during this pass and is addressed in §T/§U: the shared test fixture `makeDriver()` (`tests/integration/helpers/fixtures.ts:15-42`) only ever creates one `DRIVING_LICENSE` document, and an **existing, currently-passing test** (`tests/integration/authorization-bola.test.ts:263-268`) chains `makeDriver(..., {verified:true})` → `POST /status/online` → expects `200`. Once `setOnline` enforces the full required-document set, this test will regress unless the fixture is updated in the same change. This is now a required file, not an optional one.

---

## A. Current Implementation Verification Summary

Every file below was read in full or in the cited range during this planning pass (not carried over unverified from the spec).

| Area | File | Verified state |
|---|---|---|
| Driver DI | `src/modules/drivers/index.ts` (87 lines, full) | Awilix `CLASSIC` registration; `driverRepo`/`docRepo`/`locationRepo`/`shiftRepo`/`statusRepo`/`txManager` are `aliasTo(...)` shortcuts used by constructor param names throughout the module. `DriverService`/`DriverController` are hand-composed facades via `.inject((c) => ({...}))`. |
| Auth DI | `src/modules/auth/index.ts` (39 lines, full) | `registerAuthService` registers `authService`, `authRetentionJob`, `otpDeliveryJob`, `epochInvalidationConsumer`. No consumers barrel export list conflict. |
| Event bootstrap | `src/bootstrap/events.bootstrap.ts` (12 lines, full) | Resolves `epochInvalidationConsumer` and calls `.register()`; then resolves `outboxRelay` and calls `.start()`. This function is **not called by `createApp()`** (`src/app/app.ts`, confirmed full read) — it only runs from the real server entrypoint, not in `app.inject()`-based tests. |
| File reference registry | `src/modules/files/services/file-reference.service.ts` (26 lines, full) | `CHECKS` is a `Map<FilePurposeName, FileReferenceCheck>` — **one registrant per purpose**, last `.set()` wins. Repo-wide grep confirms exactly one production call site today: `src/modules/users/index.ts:36-40` for `'PROFILE_IMAGE'`. No production registrant exists for `'DRIVER_DOCUMENT'` — safe for Drivers to claim it. |
| File facade | `src/modules/files/services/file.service.ts` (68 lines, full) | `FileService` constructor takes `(fileUploadService, fileAccessService, fileLifecycleService)`; exposes `assertReferenceable(fileId, ownerUserId, purpose, tx)` and `supersede(previousFileId, replacementFileId, tx, requestId)` as thin pass-throughs. Registered as DI key `fileService` (`src/modules/files/index.ts:37`) — matches the constructor-param-name Drivers services will use, no alias needed. |
| File lifecycle internals | `src/modules/files/services/file-lifecycle.service.ts` (128 lines, full) | `assertReferenceable` throws `FileNotFoundError` on missing/wrong-owner/wrong-purpose, `FileStateError` on not-`READY`/soft-deleted, `FileInUseError` if `findLiveReference` finds another live holder. `supersede` additionally requires same owner, same purpose, replacement `READY`, and calls `fileRepository.markSuperseded` (an atomic conditional update — "won" pattern), then publishes `file.superseded` transactionally. |
| Event bus | `src/core/events/EventBus.ts` (46 lines, full) | Plain in-process `Map<string, Set<EventHandler>>`; `on(type, handler)` returns an `Unsubscribe`; `emit` dispatches to type-specific + `'*'` handlers via `Promise.allSettled`. Confirms no Redis/broker involvement — a directly resolvable, testable singleton. |
| Reference consumer pattern | `src/modules/auth/consumers/epoch-invalidation.consumer.ts` (43 lines, full) | Exact class shape to mirror: constructor takes `(eventBus, epochService)` (services, not raw DI container), `.register()` returns a combined `Unsubscribe`, `handle()` is `private`. |
| Driver errors | `src/modules/drivers/errors/driver.errors.ts` (67 lines, full) | Base `DriverError{code, statusCode}` has **no `details` field** today. `DocumentValidationError` (422, `DOCUMENT_VALIDATION_ERROR`) exists, zero throw-sites — reusable but needs a `details` constructor param added. |
| Driver error mapping | `src/modules/drivers/schemas/error-response.ts` (22 lines, full) | `handleDriverError` already forwards `err.details` into the response body generically (`...(err.details !== undefined ? {details: err.details} : {})`) via `isCodedError`/`errorEnvelope` (`src/core/errors/envelope.ts`, full read — `CodedError.details?: unknown` already part of the shared interface). **No error-handling infrastructure change needed** — only `DriverError` subclasses need a `details` property added where used. |
| Document repository | `src/modules/drivers/repositories/driver-document.repository.ts` (85 lines, full) | `upsertDocument` does findFirst→update/create (the TOCTOU race). `updateVerificationStatus(id, status, verifiedBy?, rejectionReason?, tx?)` already sets `verifiedAt: new Date()` only in the `VERIFIED` branch — **does not currently clear `verifiedAt`/`verifiedBy` when transitioning back to `PENDING` on re-upsert** (only `verificationStatus` is force-set to `'PENDING'` inside `upsertDocument`, `verifiedBy`/`verifiedAt`/`verificationNotes` are left stale from a prior review). This is a latent correctness gap the spec didn't call out — addressed in §J. |
| Driver repository | `src/modules/drivers/repositories/driver.repository.ts` (121 lines, full) | `updateVerificationStatus(id, status, approvedBy?, rejectionReason?, tx?)` already writes `approvedAt`/`approvedBy` correctly on the `VERIFIED` branch — confirms spec §2.3's claim exactly. `lockForUpdate` uses raw `SELECT ... FOR UPDATE` then a normal `findUnique` — reusable as-is. |
| Status service | `src/modules/drivers/services/status/status.service.ts` (137 lines, full) | Constructor already includes `GeoService` (param name `geoService`, line 26) — used today only in `setOffline` (line 107, called **after** the transaction commits, matching the outbox-can't-carry-side-effects convention). `setOnline` currently reads `docRepo.findByDriverId` inline (lines 46-52) — this inline block is what gets replaced by a call to the new eligibility service. |
| Location service | `src/modules/drivers/services/location/location.service.ts` (69 lines, full) | Constructor already includes `driverRepo` (param name, line 21) and already calls `this.driverRepo.findById(input.driverId)` at line 31 **before** the `geoService.recordDriverPosition` call at line 57 — the fetched `driver` object (which carries `verificationStatus`, `isSuspended`, `isAvailable`) is already in scope at the point the gating condition needs to run. **No new repository call is needed for the geo-gate** — it's a pure conditional wrap of the existing line 57-62 block using data already fetched. |
| Doc expiration job | `src/modules/drivers/jobs/doc-expiration.job.ts` (46 lines, full) | Constructor: `(db, redis, docRepo, driverRepo, driverMetrics)` — **no `statusRepo` or `statusService`**, so the geo-forget/force-offline cascade (spec FR-23) requires adding two new constructor params. |
| Driver metrics | `src/modules/drivers/metrics/driver.metrics.ts` (43 lines, full) | No `documentVerified`/`documentRejected`/`driverOnlineBlocked` methods exist yet — need two additions for FR-7 observability. |
| Onboarding controller | `src/modules/drivers/controllers/driver-onboarding.controller.ts` (73 lines, full) | `submitDocument` passes `body.fileUrl` straight through with no Files interaction (confirms spec exactly). `reviewVerification` already resolves `approvedBy = callerId(req)` — same pattern to reuse for the new document-review controller method. |
| Driver schemas | `src/modules/drivers/schemas/driver.schemas.ts` (54 lines, full) | `submitDriverDocumentSchema.fileUrl: z.string().url()` confirmed exact; `reviewVerificationSchema` (`{status, rejectionReason?}`) is the exact template for the new `reviewDriverDocumentSchema`. |
| Driver identity helper | `src/modules/drivers/controllers/driver-identity.ts` (25 lines, full) | `actingDriverId` resolves the caller's own driver row (used by `submitDocument`); `authorizedDriverId` additionally permits `admin`/`support` staff roles to act on another `driverId` from the URL — **this is the existing pattern for staff-acting-on-another-driver's-resource** and is what the new document-review route should use for resolving/validating `:driverId`, rather than inventing a new helper. |
| Driver Prisma model | `prisma/schema/modules/driver/driver.prisma` (222 lines, full) | `DriverDocument` (lines 72-96) confirmed: `fileUrl String` (not null), `verifiedBy/verifiedAt/verificationNotes/rejectionReason` all present and unused, only three non-unique indexes, **no** `@@unique([driverId, documentType])`. |
| Enums | `prisma/schema/shared/enums.prisma` (394 lines, full) | `VerificationStatus` (`PENDING\|VERIFIED\|REJECTED`) is explicitly commented "Shared by document / bank-account / vehicle-document review workflows" — confirms it must **not** be extended with a document-specific value; expiry correctly stays modeled as `REJECTED`. `DriverVerificationStatus` confirmed 5 values, `SUSPENDED` unused. |
| Migration conventions | `20260803120000_profile_image_file_id`, `20260804160000_account_deletion_requests`, `20260815000000_driver_locations_spatial_index` (all full reads) | Confirmed: (a) additive nullable-column + unique-index + `ON DELETE RESTRICT` FK is the established file-reference pattern; (b) partial unique indexes (`WHERE status = ...`) are used only when the table has a soft-delete/status dimension needing exclusion — `driver_documents` has neither, so a **plain** unique index is correct, matching spec §18; (c) migrations run **non-concurrently** deliberately, because Prisma wraps each migration in a transaction and `CREATE INDEX CONCURRENTLY` cannot run inside one — confirmed acceptable here since `driver_documents` is small (one row per driver per document type, not per-ping like `driver_locations`). |
| Test harness | `tests/integration/helpers/harness.ts` (83 lines, full) | `resetState()` truncates an explicit table list that does **not** name `drivers`/`driver_documents`/`user_roles` — but `TRUNCATE "users" ... CASCADE` cascades automatically to every table with an FK back to `users`, which covers all of them transitively. `loginAs(app, phoneNumber)` is the standard HTTP-login helper (OTP send→verify via `app.inject`), fixed OTP `123456` patched in for tests. |
| Outbox test pattern | `tests/integration/outbox-relay.test.ts` (confirmed pattern at lines 198-260) | Tests construct a **fresh, standalone** `new EventBus()` + `new OutboxRelay(repo(), bus, new OutboxMetrics())` per test, bypassing the DI container's singleton `eventBus`/`outboxRelay`. This is fine for testing relay mechanics in isolation, but **wrong for our purpose** — our acceptance test must exercise the *actual* production wiring (the container's singleton `eventBus`, resolved the same way `bootstrapEvents()` resolves it), not a disposable bus nothing else is listening on. See §S. |
| Role-grant test coverage | `tests/integration/auth-roles.test.ts` (confirmed via grep, `grantRole('driver')` called at lines 55, 67, 127, 147, 164, 183, 186, 198, 210, 224) | **`AuthService.grantRole(userId, 'driver')` is already extensively tested** at the service level, including idempotency (line 183-186: revoke then re-grant), and concurrent-call idempotency (line 210: `Promise.all` of 4 concurrent grants). This feature's new consumer only needs to prove *the event triggers the call*; it does not need to re-prove `grantRole`'s own correctness. |
| Regression risk found | `tests/integration/authorization-bola.test.ts:263-268` + `tests/integration/helpers/fixtures.ts:15-42` (`makeDriver`) | `makeDriver(userId, {verified:true})` creates exactly one `VERIFIED` `DRIVING_LICENSE` document. `authorization-bola.test.ts:263-268` does `makeDriver(..., {verified:true})` → `POST /status/online` → asserts `200`. Once `setOnline` requires the full set (`DRIVING_LICENSE, RC, INSURANCE`), **this currently-passing test will start failing (403) unless `makeDriver` is updated in this same change.** Confirmed no other currently-passing test relies on the old single-document behavior for a *successful* online call (the other 4 `makeDriver` call sites in `payout-authorization.test.ts`, `earnings-pipeline.test.ts`, and `auth-driver-gate.test.ts` don't chain to `/status/online`). |

## B. Current Dependency and Ownership Map

```
Drivers module (src/modules/drivers)
 ├─ depends on (constructor injection, VERIFIED_EXISTING) → @modules/geo (GeoService, already in StatusService + LocationService)
 ├─ depends on (constructor injection, NEW) → fileService (from @modules/files, into OnboardingService only)
 ├─ depends on (event, NEW, one-way) → nothing directly; publishes driver.verified, does not know who listens
 ├─ imports (plain module import, VERIFIED_EXISTING) → @config (driverConfig)
 └─ registers itself into @modules/files (NEW) via registerFileReference('DRIVER_DOCUMENT', ...) — a registration call, not a runtime dependency; Files never calls back into Drivers

Auth module (src/modules/auth)
 ├─ depends on (constructor injection, VERIFIED_EXISTING) → EventBus, EpochService (existing consumer)
 ├─ depends on (constructor injection, NEW) → EventBus, AuthService (new consumer — AuthService is already in the same module, not cross-module)
 └─ has ZERO dependency on Drivers at any level, before or after this feature — confirmed by repo-wide grep in the prior investigation and re-confirmed by reading auth/index.ts in full this pass. No circular dependency is introduced.

Files module (src/modules/files)
 └─ has ZERO dependency on Drivers — the `FileReferenceCheck.isReferenced` callback registered BY Drivers is stored in Files' own module-level `Map` and invoked by Files' own code (`findLiveReference`), but the callback closure itself lives in and is defined by Drivers (container.resolve('driverDocumentRepository') is called from inside drivers/index.ts, at registration time, not import time) — this is the exact same shape as the existing Users→Files registration, not a new kind of coupling.
```

Ownership decisions (§D) follow directly from this map: no new top-level module, no circular dependency, Drivers is the only new caller into Files (`fileService.assertReferenceable`/`.supersede`) and the only new event producer Auth listens to.

## C. Exact End-to-End Lifecycle (implementation-level)

```
1.  POST /api/v1/auth/otp/send, POST /api/v1/auth/otp/verify         [VERIFIED_EXISTING, unchanged]
2.  GET  /api/v1/drivers/me                                          [VERIFIED_EXISTING, unchanged] → Driver{verificationStatus:PENDING}
3.  PATCH /api/v1/drivers/:driverId/profile                          [VERIFIED_EXISTING, unchanged]
4.  POST /api/v1/files  (purpose=DRIVER_DOCUMENT)                    [VERIFIED_EXISTING, unchanged] → presigned PUT
5.  client PUTs bytes to storage                                     [VERIFIED_EXISTING, unchanged]
6.  POST /api/v1/files/:id/complete                                  [VERIFIED_EXISTING, unchanged] → File.status=READY
7.  POST /api/v1/drivers/:driverId/documents {documentType, fileId}  [MODIFIED — was fileUrl]
       → OnboardingController.submitDocument
       → OnboardingService.submitDocument
         → fileService.assertReferenceable(fileId, callerUserId, 'DRIVER_DOCUMENT', tx)
         → driverDocumentRepository.upsertDocument({..., fileId}, tx)  [real Prisma upsert now]
         → if replacing an existing fileId, fileService.supersede(oldFileId, newFileId, tx, requestId)
         → if driver.verificationStatus === 'PENDING', advance to 'DOCUMENT_REVIEW' [unchanged behavior]
         → if driver.verificationStatus === 'VERIFIED' AND documentType is required, downgrade to 'DOCUMENT_REVIEW' [NEW]
8.  POST /api/v1/drivers/:driverId/documents/:documentId/review {status, rejectionReason?}  [NEW]
       → DriverOnboardingController.reviewDocument (admin-only)
       → OnboardingService.reviewDocument
         → self-review guard (reviewer.userId !== driver.userId)
         → transition validity check (see §F state machine)
         → driverDocumentRepository.updateVerificationStatus(documentId, status, reviewerId, rejectionReason, tx)
9.  (repeat 4-8 for every required document type)
10. POST /api/v1/drivers/:id/verify {status: 'VERIFIED'}             [MODIFIED — gate + transition + idempotency added]
       → OnboardingController.reviewVerification (admin-only, unchanged route/controller signature)
       → OnboardingService.reviewDriverVerification
         → self-review guard
         → transition validity check
         → if target is VERIFIED: eligibilityService.checkRequiredDocuments(driverId, tx) — reject 422 if not eligible
         → driverRepository.updateVerificationStatus(driverId, 'VERIFIED', approvedBy, undefined, tx)
         → eventPublisher.publish(driverEvent(DRIVER_EVENT_CATALOG.VERIFIED, driverId, {driverId, approvedBy, userId: driver.userId}), tx)
           [outbox_events row written in the SAME transaction — VERIFIED_EXISTING mechanism, only the data payload changes]
11. OutboxRelay (VERIFIED_EXISTING, ~1s tick in production; test-driven via processBatch in tests) claims + emits on the singleton EventBus
12. AuthDriverVerifiedConsumer.handle(envelope)  [NEW]
       → authService.grantRole(envelope.data.userId, 'driver', { grantedBy: envelope.data.approvedBy ?? null })
       → grantRole is already idempotent (VERIFIED_EXISTING) — bumps Redis epoch only on a genuine new grant
13. Driver's existing access token is now epoch-stale on its NEXT authenticated request → 401 TOKEN_STALE [VERIFIED_EXISTING]
       → client calls POST /api/v1/auth/refresh [VERIFIED_EXISTING] → new access token with roles:[...,'driver']
14. POST /api/v1/drivers/status/online                               [MODIFIED — ad-hoc license check replaced]
       → requireOperableDriver preHandler [VERIFIED_EXISTING, DB-backed, unaffected by step 13's timing]
       → StatusService.setOnline
         → verificationStatus===VERIFIED, !isSuspended [VERIFIED_EXISTING checks, unchanged]
         → eligibilityService.checkRequiredDocuments(driverId, tx) replaces the inline hasValidLicense check [MODIFIED]
         → shiftRepo.startShift, driverRepo.updateAvailability(true), statusRepo.updateStatus('ONLINE') [VERIFIED_EXISTING, unchanged]
15. POST /api/v1/drivers/location                                    [MODIFIED — geo publish now conditional]
       → LocationService.updateLocation
         → locationRepo.updateLocation(input) — durable PostGIS write, UNCONDITIONAL [unchanged]
         → IF driver.verificationStatus==='VERIFIED' && !driver.isSuspended && driver.isAvailable===true:
             geoService.recordDriverPosition(...) [conditional — NEW gate around existing call]
16. GeoService.findNearbyDrivers(...)                                 [VERIFIED_EXISTING, unaffected — reads only what was published]
```

## D. Module Ownership Decisions

| Responsibility | Owner (unchanged) | Evidence this feature does not move it |
|---|---|---|
| `DriverDocument` business record + review workflow | Drivers | New service/repository methods added inside `src/modules/drivers/*`, none moved elsewhere |
| Required-document eligibility rule | Drivers (new `DriverEligibilityService`) | Lives in `src/modules/drivers/services/eligibility/`, consumes only `driverConfig` + `DriverDocumentRepository`, both already Drivers-owned |
| File bytes/storage/ownership validation | Files | Drivers only calls `fileService.assertReferenceable`/`.supersede` — no new file-handling code written inside Drivers |
| Role grant | Auth | New consumer lives in `src/modules/auth/consumers/`, calls `AuthService.grantRole` which is already Auth's own method — Drivers never imports `AuthService` |
| Live geo index publish/forget | Geo | Drivers only calls existing `GeoService.recordDriverPosition`/`.forgetDriverPosition` — the conditional wrapping is Drivers-side caller logic, not new Geo logic |
| Spatial query / nearby lookup | Geo | Untouched |
| Vehicle assignment | (no owner change) | Confirmed again this pass: zero query sites for `VehicleAssignment` anywhere in `src` — not touched, not queried, no gate added |
| Driver wallet | Drivers (read model) | Untouched — out of scope |

No new top-level module is created. `DriverEligibilityService` is a new **file** inside the existing Drivers module tree, not a new module.

## E. Existing Files to Modify

| # | File | Change |
|---|---|---|
| 1 | `src/modules/drivers/schemas/driver.schemas.ts` | `submitDriverDocumentSchema`: replace `fileUrl: z.string().url()` with `fileId: z.string().uuid()`. Add `reviewDriverDocumentSchema = z.object({ status: z.enum(['VERIFIED','REJECTED']), rejectionReason: z.string().min(1).max(255).optional() }).refine(v => v.status !== 'REJECTED' || !!v.rejectionReason, 'rejectionReason is required when rejecting')`. |
| 2 | `src/modules/drivers/repositories/driver-document.repository.ts` | `upsertDocument`: accept `fileId: string` instead of `fileUrl: string`; convert to `client.driverDocument.upsert({ where: { driverId_documentType: { driverId, documentType } }, create: {...}, update: {...} })`; on the `update` branch, explicitly reset `verifiedBy: null, verifiedAt: null, verificationNotes: null, rejectionReason: null` alongside the existing `verificationStatus: 'PENDING'` (closes the stale-reviewer-metadata gap found in §A). Add `isDocumentFile(fileId: string, tx?: TransactionClient): Promise<boolean>` (`count({where:{fileId}}) > 0`) for the file-reference registry. |
| 3 | `src/modules/drivers/repositories/driver.repository.ts` | No signature change — `updateVerificationStatus` and `findById` are reused as-is. (Considered adding a `findByIdForEligibilityCheck` variant but `findById`'s existing `include: {documents:true}` already returns what's needed; no change made — noted here to record the decision was considered and rejected.) |
| 4 | `src/modules/drivers/services/onboarding/onboarding.service.ts` | Constructor: add `fileService: FileService` and `eligibilityService: DriverEligibilityService` params. `submitDocument`: call `fileService.assertReferenceable` before `upsertDocument`; call `fileService.supersede` when replacing an existing document's file; add the VERIFIED→DOCUMENT_REVIEW downgrade-on-replace branch. Add new method `reviewDocument(documentId, driverId, status, reviewerId, rejectionReason?)`. `reviewDriverVerification`: add self-review guard, transition validation, idempotent-same-status short-circuit, `eligibilityService.checkRequiredDocuments` gate before allowing `VERIFIED`, and add `userId: driver.userId` to the published event's `data`. |
| 5 | `src/modules/drivers/services/status/status.service.ts` | Constructor: add `eligibilityService: DriverEligibilityService` param. `setOnline`: replace the inline `docRepo.findByDriverId` + `hasValidLicense` block (lines 46-52) with a call to `eligibilityService.checkRequiredDocuments(driverId, tx)`, throwing `DriverNotVerifiedError` with `details` from the result on failure. |
| 6 | `src/modules/drivers/services/location/location.service.ts` | Wrap the existing `geoService.recordDriverPosition(...)` call (lines 57-62) in `if (driver.verificationStatus === 'VERIFIED' && !driver.isSuspended && driver.isAvailable === true) { ... }`, using the `driver` object already fetched at line 31 — no new query added. |
| 7 | `src/modules/drivers/jobs/doc-expiration.job.ts` | Constructor: add `statusRepo: DriverStatusRepository` and `statusService: StatusService` params. After downgrading a driver to `DOCUMENT_REVIEW`, check `statusRepo.getStatus(doc.driverId)`; if `status === 'ONLINE'` or `'BREAK'`, call `statusService.setOffline(doc.driverId, 'DOCUMENT_EXPIRED')` (which already internally calls `geoService.forgetDriverPosition`, per §A — no separate geo call needed here, reuse is exact). |
| 8 | `src/modules/drivers/controllers/driver-onboarding.controller.ts` | `submitDocument`: pass `body.fileId` instead of `body.fileUrl`. Add `reviewDocument(req, reply)` method: resolve `driverId` via `authorizedDriverId(req, this.driverRepository, (req.params as {driverId:string}).driverId)` (reusing the existing staff-override helper, §A), parse `reviewDriverDocumentSchema`, call `driverService.onboarding.reviewDocument(documentId, driverId, body.status, callerId(req), body.rejectionReason)`. |
| 9 | `src/modules/drivers/routes/driver.routes.ts` | Add `fastify.post('/:driverId/documents/:documentId/review', { preHandler: fastify.authorize({ roles: ['admin'] }) }, (req, reply) => controller.onboarding.reviewDocument(req, reply));` — placed after the existing `/:driverId/documents` route, before `/:id/verify`, matching the file's existing top-to-bottom lifecycle ordering. |
| 10 | `src/modules/drivers/errors/driver.errors.ts` | `DriverError`: add optional 4th constructor param `details?: unknown` stored as `this.details`. `DocumentValidationError`: add `details?: unknown` param, pass through. Add new `SelfReviewForbiddenError extends DriverError` (403, `SELF_REVIEW_FORBIDDEN`). |
| 11 | `src/modules/drivers/metrics/driver.metrics.ts` | Add `documentVerified(fields?)`, `documentRejected(fields?)` methods, same `emit(...)` pattern as existing methods. |
| 12 | `src/modules/drivers/index.ts` | Register new keys: `driverEligibilityService: asClass(DriverEligibilityService).singleton()`, alias `eligibilityService: aliasTo('driverEligibilityService')` (so constructor param name `eligibilityService` resolves correctly under `CLASSIC` injection mode, matching the existing `driverRepo`/`docRepo` alias convention). Add `import { registerFileReference } from '@modules/files';` and call `registerFileReference('DRIVER_DOCUMENT', { module: 'drivers', isReferenced: (fileId, tx) => container.resolve<DriverDocumentRepository>('driverDocumentRepository').isDocumentFile(fileId, tx) })` inside `registerDriversModule`, mirroring `src/modules/users/index.ts:36-40` exactly. |
| 13 | `src/modules/auth/index.ts` | Register new key: `authDriverVerifiedConsumer: asClass(AuthDriverVerifiedConsumer).singleton()`. |
| 14 | `src/modules/auth/consumers/index.ts` | Add barrel export for the new consumer (mirrors however `EpochInvalidationConsumer` is currently exported from this barrel — same pattern). |
| 15 | `src/bootstrap/events.bootstrap.ts` | Add `container.resolve<AuthDriverVerifiedConsumer>('authDriverVerifiedConsumer').register();` alongside the existing `epochInvalidationConsumer` line. |
| 16 | `prisma/schema/modules/driver/driver.prisma` | `DriverDocument` model: add `fileId String? @map("file_id") @db.Uuid` and relation `file File? @relation(fields: [fileId], references: [id])`; change `fileUrl String` to `fileUrl String? @map("file_url")` (nullable, deprecated-in-place, not dropped — §Migration plan); add `@@unique([driverId, documentType], map: "driver_documents_driver_id_document_type_key")`. |
| 17 | `prisma/schema/modules/file/file.prisma` | Add the reverse relation array for the new FK: `driverDocuments DriverDocument[]` on `model File` (Prisma requires the back-relation to be declared on both sides). |
| 18 | `tests/integration/helpers/fixtures.ts` | `makeDriver`: when `verified: true`, create a `VERIFIED` document for **every** type in `driverConfig.requiredDocumentTypes` (not just `DRIVING_LICENSE`), so the fixture's contract ("a verified, online-eligible driver") stays true after this feature ships. This is required to prevent the regression identified in §A. |
| 19 | `tests/unit/drivers/verification-gate.test.ts` | Update `StatusService` instantiation to pass a (real or minimally-stubbed) `DriverEligibilityService`, and update its mocked document fixtures to cover the full required set where the test expects a pass. |

## F. New Files to Create

| # | File | Purpose |
|---|---|---|
| 1 | `src/modules/drivers/services/eligibility/eligibility.service.ts` | `DriverEligibilityService` — the single authoritative eligibility function (FR-11 through FR-14). Constructor: `(docRepo: DriverDocumentRepository)`. Method: `async checkRequiredDocuments(driverId: string, tx?: TransactionClient): Promise<DocumentEligibilityResult>`. Reads `driverConfig.requireApprovedDocuments` and `driverConfig.requiredDocumentTypes` directly via `import { driverConfig } from '@config';` (same pattern as `LocationService`) — no DI needed for config. |
| 2 | `src/modules/drivers/services/eligibility/index.ts` | Barrel export, matching the pattern of `services/onboarding/index.ts`, `services/status/index.ts`, etc. |
| 3 | `src/modules/drivers/types/driver-eligibility.types.ts` (or added to existing `types/driver.types.ts`) | `DocumentEligibilityResult` interface: `{ eligible: boolean; missing: DriverDocumentTypeEnum[]; pending: DriverDocumentTypeEnum[]; rejected: DriverDocumentTypeEnum[]; expired: DriverDocumentTypeEnum[] }`. |
| 4 | `src/modules/auth/consumers/driver-verified.consumer.ts` | `AuthDriverVerifiedConsumer` — constructor `(eventBus: EventBus, authService: AuthService)`, `.register()` subscribes to `'driver.verified'`, `handle()` (private) reads `envelope.data.userId` and `envelope.data.approvedBy`, calls `authService.grantRole(userId, 'driver', { grantedBy: approvedBy ?? null })`. Exact structural mirror of `epoch-invalidation.consumer.ts`. |
| 5 | `prisma/migrations/20260820120000_driver_documents_uniqueness/migration.sql` | Invariant #3 — see §H. |
| 6 | `prisma/migrations/20260820121500_driver_document_file_id/migration.sql` | Expand-phase file-reference migration — see §H. |
| 7 | `tests/integration/driver-lifecycle.test.ts` | Full HTTP-driven acceptance suite — see §S. |
| 8 | `tests/integration/driver-document-review.test.ts` | Focused negative-path suite for document review authorization/transitions — see §S. (Split from the lifecycle test to keep each file's scope legible, matching the codebase's existing pattern of one concern per integration test file, e.g. `file-supersede.test.ts` vs `file-lifecycle.test.ts` being separate.) |

## G. Files That Should NOT Be Changed

Explicitly confirmed out of scope, with the specific reason each was considered and rejected:

- `src/modules/vehicles/*` — stub, confirmed zero query sites for `VehicleAssignment`; no online-gate dependency introduced (§D).
- `src/modules/rides/*`, `src/modules/dispatch/*`, `src/modules/matching/*` — non-goal (spec §4); `LifecycleService.acceptRideRequest`'s unvalidated `vehicleId` is a separate, already-tracked issue, not this feature's concern.
- `src/modules/payments/*`, `src/modules/drivers/services/wallet/*`, `src/modules/drivers/repositories/driver-wallet.repository.ts` — read-model boundary confirmed intact, no mutation logic added.
- `src/modules/users/*` — `GET /me` behavior must remain untouched (Customer Safety, spec §J); no changes planned or needed here.
- `src/modules/files/services/file-access.service.ts`, `file-upload.service.ts`, `file-validation.service.ts`, `file.repository.ts` — read/upload/validate paths are unaffected; only `FileLifecycleService`'s already-public `assertReferenceable`/`supersede` are called, not modified.
- `src/core/events/EventBus.ts`, `EventPublisher.ts`, `OutboxRelay.ts`, `OutboxRepository.ts` — the transactional outbox is reused exactly as-is; no changes needed at any layer here.
- `src/core/di.ts` — registration **order** (`registerAuthService` before `registerDriversModule`) already supports this feature; the file itself needs no edit since neither new module registration function's *call site* changes, only what happens inside `registerDriversModule`/`registerAuthService`.
- `src/modules/drivers/events/catalog.ts` — confirmed no change needed; `DRIVER_EVENT_CATALOG.VERIFIED` and the `driverEvent()` helper's signature are both reused unmodified (see the correction in this plan's preamble).
- `src/modules/auth/services/auth.service.ts` — `grantRole` is reused exactly as-is; already idempotent, already bumps the epoch correctly. No change.
- `src/modules/auth/plugins/auth.plugin.ts`, `src/modules/auth/repositories/driver-access.repository.ts` (`requireOperableDriver`/`isOperableDriver`) — confirmed correct and DB-backed already; no change needed for online eligibility to work correctly post-fix (§14 of spec).
- `src/modules/geo/*` — no changes; only existing public `GeoService` methods are called, and only from existing call sites (`LocationService`, `StatusService`), with an added conditional around an already-existing call.

## H. Database and Migration Plan

Two migrations, in this order, both additive/non-destructive.

### H.1 — `20260820120000_driver_documents_uniqueness`

Enforces invariant #3. Modeled directly on `20260804160000_account_deletion_requests`'s style (comment-first, states the "why" before the SQL) but uses a **plain** unique index, not partial, because — unlike `account_deletion_requests` (which needs "one *pending*" scoped by status) or `users`/`user_roles` (which need "one *active*" scoped by a soft-delete/revoke timestamp) — `driver_documents` has no soft-delete column and the invariant is unconditional: a driver may never have two rows of the same `document_type`, full stop, regardless of `verification_status`.

```sql
-- One DriverDocument per (driver, documentType) — invariant #3 (plan.md §H.1).
--
-- Application code (`upsertDocument`, driver-document.repository.ts) has always
-- intended one row per (driver_id, document_type): it does a findFirst-then-
-- update/create keyed on that pair before writing. Nothing in the schema ever
-- enforced it, so two concurrent submissions of the same document type can both
-- pass the findFirst check and both insert — a genuine TOCTOU race, not a
-- theoretical one. This index closes it, and the repository is converted to a
-- real `upsert` against this same key in the same change, so the constraint and
-- the write path agree with each other from the moment this ships.
--
-- Plain (not partial): there is no soft-delete or status dimension on this table
-- that should ever coexist with a duplicate — a REJECTED document does not free
-- up the (driver, type) slot, re-submission updates that same row instead.
CREATE UNIQUE INDEX "driver_documents_driver_id_document_type_key"
  ON "driver_documents" ("driver_id", "document_type");
```

**Pre-deploy data check** (run manually against the target environment before applying, not part of the migration file itself, per spec §18):
```sql
SELECT driver_id, document_type, COUNT(*)
FROM driver_documents
GROUP BY driver_id, document_type
HAVING COUNT(*) > 1;
```
If any rows return, deduplicate by keeping the row with the latest `updated_at` per group before applying this migration (one-time manual cleanup or a preceding data-migration script — not embedded in the DDL migration itself, to keep the migration file's blast radius auditable and match this repo's convention of keeping schema migrations free of speculative data manipulation unless the migration's own comment says otherwise, as `account_deletion_requests`'s migration does for its CHECK constraints only).

**Rollback**: `DROP INDEX "driver_documents_driver_id_document_type_key";` — clean, no data loss.

### H.2 — `20260820121500_driver_document_file_id`

Expand-phase only, mirroring `20260803120000_profile_image_file_id` exactly in shape (nullable column, unique index, `ON DELETE RESTRICT` FK), plus loosening `file_url` to nullable so the application can stop populating it without violating `NOT NULL`.

```sql
-- DRIVERS module — file-reference cutover, deploy 1 of 2 (plan.md §H.2, mirrors
-- the profile-image cutover in 20260803120000_profile_image_file_id).
--
-- `driver_documents.file_url` is a live, trusted, client-supplied URL with no
-- relationship to the Files module at all — no ownership check, no purpose
-- check, no proof the file was ever legitimately uploaded. This deploy adds
-- `file_id` as the real answer, referencing a `File` row the Files module has
-- already validated (READY, owned by the caller, purpose=DRIVER_DOCUMENT).
--
-- Expand only: `file_url` is loosened to nullable so new code can stop writing
-- it, but the column is NOT dropped here. It is dropped in a later, separate
-- migration once this has been live and confirmed nothing reads it — same
-- two-deploy shape as 20260803120000 → 20260804090000 for profile_image.

ALTER TABLE "driver_documents" ALTER COLUMN "file_url" DROP NOT NULL;

ALTER TABLE "driver_documents" ADD COLUMN "file_id" UUID;

-- A file may back at most one live document row (mirrors
-- user_profiles_profile_image_file_id_key exactly) — NULLs are distinct in
-- Postgres, so documents with no file_id yet (there should be none going
-- forward, but existing pre-cutover rows may have one) coexist freely.
CREATE UNIQUE INDEX "driver_documents_file_id_key"
  ON "driver_documents" ("file_id");

-- RESTRICT, not SET NULL: a file backing a live, possibly-VERIFIED document
-- must not be silently removable out from under it.
ALTER TABLE "driver_documents"
  ADD CONSTRAINT "driver_documents_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "files" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

**Data handling for pre-existing rows** (per spec §18/Migration B, confirmed still the right call): any `driver_documents` row that only has `file_url` predates this feature and cannot be mechanically resolved to a `File` row (no such upload ever went through the Files module for it). `OPEN_QUESTION` carried over from spec: confirm with ops whether any such rows exist in a real target environment before this ships; if they do, they should be treated as needing re-submission through the new endpoint (their `verification_status` can be left as-is — the new `checkRequiredDocuments` gate will naturally treat a `fileId`-less-but-otherwise-`VERIFIED` legacy row as still satisfying eligibility today, since eligibility only inspects `verificationStatus`/`expiresAt`, not `fileId` — so no forced re-review is strictly required by this migration alone; re-submission only becomes necessary if/when a later contract migration drops `file_url` or if the row needs to be re-verified for an unrelated reason).

**Deferred to a future migration (explicitly out of scope for this feature)**: `DROP COLUMN "file_url"`. Do this only after confirming (a) no application code reads it (true immediately after this feature ships, since `upsertDocument` stops writing it and no read path ever selected it individually — `findById`/`findByDriverId` return whole rows via Prisma, so `fileUrl` would still appear in API responses until that field is also removed from the response schema/type — noted as a small follow-up, not a migration blocker) and (b) the pre-existing-legacy-row question above is resolved.

**Rollback for H.2**: `ALTER TABLE "driver_documents" DROP CONSTRAINT "driver_documents_file_id_fkey"; DROP INDEX "driver_documents_file_id_key"; ALTER TABLE "driver_documents" DROP COLUMN "file_id"; ALTER TABLE "driver_documents" ALTER COLUMN "file_url" SET NOT NULL;` — the last step only safe if no row was written with a null `file_url` in the interim; note this caveat in the migration's own rollback comment.

### H.3 — Prisma schema edits accompanying both migrations
See §E items 16-17 for the exact model changes. `documentType` field stays `DriverDocumentType` (unchanged); no enum changes (confirmed correct per §A — `VerificationStatus` is explicitly shared across three review workflows and must not be extended for this feature alone).

## I. API/Route Plan

| Method + Path | Status | Auth | Change |
|---|---|---|---|
| `POST /api/v1/drivers/:driverId/documents` | Modified | self (existing `actingDriverId`) | Body: `fileId` replaces `fileUrl` |
| `POST /api/v1/drivers/:driverId/documents/:documentId/review` | **New** | `admin` role | New route, new controller method, new service method |
| `POST /api/v1/drivers/:id/verify` | Modified (same route/method/controller signature) | `admin` role, unchanged | Behavior only: eligibility gate, transition validation, idempotency, self-review guard, event payload adds `userId` |
| `POST /api/v1/drivers/status/online` | Modified (same route) | `requireOperableDriver`, unchanged | Behavior only: eligibility check delegated to new service |
| `POST /api/v1/drivers/location` | Modified (same route) | rate-limited, unchanged | Behavior only: geo publish now conditional |
| All other driver routes | Unchanged | — | — |

No route path changes, no auth-preHandler changes on existing routes, no new top-level route prefix. The one new route slots into the existing `driver.routes.ts` file, following its existing top-to-bottom ordering convention (identity → profile → documents → review → status → location → wallet).

## J. Service and Repository Plan

Beyond what's itemized in §E/§F, two precision details worth recording explicitly:

- **`upsertDocument`'s stale-reviewer-metadata fix** (found in §A, not in the original spec): when a document is re-submitted, the existing code already force-resets `verificationStatus` to `'PENDING'` but leaves `verifiedBy`/`verifiedAt`/`verificationNotes`/`rejectionReason` from the *previous* review cycle sitting on the row. A document rejected for reason X, then re-uploaded, would show the old rejection reason next to a `PENDING` status until the next review overwrites it — confusing but not exploitable, since eligibility only reads `verificationStatus`/`expiresAt`. Still, this plan fixes it in the same `upsertDocument` change (§E.2) since it's a one-line addition to the same `update` block already being touched.
- **`checkRequiredDocuments`'s tx-awareness**: must accept an optional `tx` parameter and pass it through to `docRepo.findByDriverId(driverId, tx)`, because it is called from *inside* `reviewDriverVerification`'s and `setOnline`'s existing transactions (both use `txManager.execute(async (tx) => {...})`) — calling it without `tx` would read outside the transaction and could see stale data on a row already locked by the same transaction (`lockForUpdate` is called first in both call sites, so reading without `tx` risks a self-deadlock or a stale read against the just-locked row, not just a correctness nuance).

## K. Event and Outbox Plan

No changes to `EventPublisher`, `EventBus`, `OutboxRelay`, `OutboxRepository`, or the `outbox_events` table/model. The only change is the **payload** of one existing publish call (`onboarding.service.ts`'s `reviewDriverVerification`, adding `userId: driver.userId` to `data`) and one **new subscriber** (`AuthDriverVerifiedConsumer`) registered exactly like the one existing subscriber (`EpochInvalidationConsumer`) is registered — same DI pattern (§E.13), same bootstrap wiring (§E.15). `DRIVER_EVENT_CATALOG.VERIFIED` (`'driver.verified'`) is reused unmodified, confirming spec §13.1.

## L. Auth Role Propagation Plan

```
AuthDriverVerifiedConsumer (src/modules/auth/consumers/driver-verified.consumer.ts)
  constructor(eventBus: EventBus, authService: AuthService)
  register(): Unsubscribe {
    return this.eventBus.on('driver.verified', (envelope) => this.handle(envelope));
  }
  private async handle(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { userId?: string; approvedBy?: string };
    if (!data.userId) { logger.warn(...); return; }  // defensive, mirrors EpochInvalidationConsumer's own guard
    await this.authService.grantRole(data.userId, 'driver', { grantedBy: data.approvedBy ?? null });
  }
```
No new circular dependency: `AuthService` is already constructed inside the Auth module (`src/modules/auth/services/auth.service.ts`); the consumer is also inside the Auth module. Drivers is never imported by Auth at any point in this chain — Auth only reacts to an event type string it already knows the shape of (`data.userId`), decoupled entirely from Drivers' internal types.

Idempotency is inherited, not reimplemented: `grantRole`'s existing `findActiveAssignment`-then-`create` check (confirmed in §A cross-reference to `auth-roles.test.ts`) already makes duplicate delivery a safe no-op. No new idempotency table, no dedup key, no changes to `grantRole` itself.

## M. File Ownership/Reference Plan

Already fully specified in §E.2 (repository), §E.12 (registration), §F.4 is not applicable here (that's the Auth consumer) — the concrete call sequence inside `OnboardingService.submitDocument`:
```ts
async submitDocument(data: { driverId, documentType, fileId, documentNumber?, expiresAt? }) {
  const driver = await this.driverRepo.findById(data.driverId);
  if (!driver) throw new DriverNotFoundError(data.driverId);
  return this.txManager.execute(async (tx) => {
    const existing = (await this.docRepo.findByDriverId(data.driverId, tx))
      .find(d => d.documentType === data.documentType);
    await this.fileService.assertReferenceable(data.fileId, driver.userId, 'DRIVER_DOCUMENT', tx);
    const doc = await this.docRepo.upsertDocument({ ...data }, tx);   // real Prisma upsert now
    if (existing?.fileId && existing.fileId !== data.fileId) {
      await this.fileService.supersede(existing.fileId, data.fileId, tx, requestId);
    }
    if (driver.verificationStatus === 'PENDING') {
      await this.driverRepo.updateVerificationStatus(data.driverId, 'DOCUMENT_REVIEW', undefined, undefined, tx);
    } else if (driver.verificationStatus === 'VERIFIED' && isRequired(data.documentType)) {
      await this.driverRepo.updateVerificationStatus(data.driverId, 'DOCUMENT_REVIEW', undefined, 'Required document re-submitted', tx);
    }
    return doc;
  });
}
```
`driver.userId` (not the request body) is what's passed to `assertReferenceable` — this is what makes the BOLA protection real: a caller cannot attach a `fileId` they don't own, and cannot claim to be a different driver, because `driverId` itself was already resolved from the JWT via `actingDriverId` upstream in the controller (§A), and `driver.userId` here is read from the DB row for that resolved `driverId`, not from client input at any point in the chain.

## N. Document Eligibility Plan

```ts
// src/modules/drivers/services/eligibility/eligibility.service.ts
export class DriverEligibilityService {
  constructor(private readonly docRepo: DriverDocumentRepository) {}
  async checkRequiredDocuments(driverId: string, tx?: TransactionClient): Promise<DocumentEligibilityResult> {
    if (!driverConfig.requireApprovedDocuments) {
      return { eligible: true, missing: [], pending: [], rejected: [], expired: [] };
    }
    const docs = await this.docRepo.findByDriverId(driverId, tx);
    const byType = new Map(docs.map(d => [d.documentType, d]));
    const now = new Date();
    const missing: DriverDocumentTypeEnum[] = [];
    const pending: DriverDocumentTypeEnum[] = [];
    const rejected: DriverDocumentTypeEnum[] = [];
    const expired: DriverDocumentTypeEnum[] = [];
    for (const type of driverConfig.requiredDocumentTypes) {
      const doc = byType.get(type);
      if (!doc) { missing.push(type); continue; }
      if (doc.verificationStatus === 'PENDING') { pending.push(type); continue; }
      if (doc.verificationStatus === 'REJECTED') { rejected.push(type); continue; }
      if (doc.expiresAt && doc.expiresAt <= now) { expired.push(type); continue; }
    }
    const eligible = !missing.length && !pending.length && !rejected.length && !expired.length;
    return { eligible, missing, pending, rejected, expired };
  }
}
```
`src/config/driver/driver.config.ts` gets one new field (`CONFIGURATION_DECISION`, per spec FR-12, unchanged from spec):
```ts
requiredDocumentTypes: (process.env.DRIVER_REQUIRED_DOCUMENT_TYPES ?? 'DRIVING_LICENSE,RC,INSURANCE')
  .split(',').map(s => s.trim()) as DriverDocumentTypeEnum[],
```
placed alongside the existing `requireApprovedDocuments` field, same file, same `Object.freeze` block — no new config file.

## O. Geo Availability Safety Plan

Fully specified in §E.6/§E.7 and §C step 15. No new Geo-module code. The gate uses fields already present on the `driver` row already fetched by `LocationService.updateLocation` at line 31 (`driverRepo.findById`) — confirmed this includes `verificationStatus`, `isSuspended`, `isAvailable` as plain columns on `Driver` (§A schema read), so **zero additional database round-trips** are introduced by this gate.

## P. Transaction and Concurrency Strategy

| Operation | Mechanism |
|---|---|
| Concurrent duplicate document submissions (same type) | DB unique index (§H.1) + real Prisma `upsert` (§E.2) — atomic at the DB level, no application-level race window remains |
| Concurrent admin reviews of the same document | `updateVerificationStatus` is a plain `update` by primary key `id` — last-write-wins is acceptable here since both writers are admins making a considered decision; no row-lock added (matches the codebase's existing choice not to lock `DriverDocument` rows anywhere) |
| Driver approval racing with a document change | `reviewDriverVerification` already calls `driverRepo.lockForUpdate(driverId, tx)` first (`VERIFIED_EXISTING`) — this serializes concurrent approval attempts on the same driver, but does **not** lock the `DriverDocument` rows the eligibility check reads. A document review committing between the eligibility check and the driver-status write inside the same transaction is not possible (both happen inside one `txManager.execute` block reading via `tx`, and Postgres's default `READ COMMITTED` isolation means the eligibility read sees a consistent snapshot as of the start of that statement) — accepted as sufficient, matching the isolation level already used everywhere else in this codebase (no `SERIALIZABLE` usage found anywhere). |
| Approving an already-`VERIFIED`/`REJECTED` document or driver | Idempotent no-op per spec FR-9/FR-16 — implemented as an early-return before any write when current state already equals requested state |
| Event publication reliability | Unchanged — outbox guarantees at-least-once, already the codebase-wide standard |
| Role grant idempotency | Unchanged — inherited from `AuthService.grantRole`, already proven in `auth-roles.test.ts` |

## Q. Error Handling and Authorization Strategy

All new errors extend the existing `DriverError` base class and flow through the existing `handleDriverError` handler (§A) — no new error-handling infrastructure. Authorization reuses `authorize({ roles: ['admin'] })` (document review, matching `/verify` and `/suspend`) and the existing `actingDriverId`/`authorizedDriverId` helpers (§A) rather than new ad-hoc identity resolution — directly satisfying the user's instruction not to bypass the existing acting-identity pattern.

| Error | Code | Status | Thrown when |
|---|---|---|---|
| `DocumentValidationError` (extended with `details`) | `DOCUMENT_VALIDATION_ERROR` | 422 | `checkRequiredDocuments` returns `eligible: false` at either approval or online-attempt time; `details` carries the `{missing,pending,rejected,expired}` breakdown |
| `SelfReviewForbiddenError` (new) | `SELF_REVIEW_FORBIDDEN` | 403 | Admin's `userId` equals the target driver's `userId`, at either document-review or driver-approval time |
| `DriverError` (generic, reused) | `DRIVER_ERROR` | 409 (via a new `code: 'INVALID_TRANSITION'` message, still the base class — no new subclass needed since this is a single call site) | Requested transition is not in the allowed set (§ state machine in spec §8) |
| `FileNotFoundError`/`FileStateError`/`FileInUseError` (Files module, reused unmodified) | as defined in Files | as defined in Files | Propagate straight through from `assertReferenceable`/`supersede` — Drivers does not catch/rewrap them, consistent with how Users' `attachProfileImage` also lets them propagate unmodified |

## R. DI/Registration Changes

Fully itemized in §E.12-15. Summary of the exact Awilix registration additions:

```ts
// src/modules/drivers/index.ts, inside registerDriversModule
driverEligibilityService: asClass(DriverEligibilityService).singleton(),
eligibilityService: aliasTo('driverEligibilityService'),
```
```ts
// src/modules/auth/index.ts, inside registerAuthService
authDriverVerifiedConsumer: asClass(AuthDriverVerifiedConsumer).singleton(),
```
```ts
// src/bootstrap/events.bootstrap.ts, alongside the existing epochInvalidationConsumer line
container.resolve<AuthDriverVerifiedConsumer>('authDriverVerifiedConsumer').register();
```
No change to `src/core/di.ts` itself, no change to registration order (already correct — confirmed in §A).

## S. Test Strategy

The existing integration harness (`tests/integration/helpers/harness.ts`) already provides everything needed: `bootApp()`, `loginAs()`, `db()`, `resetState()`. Two gaps identified in §A that the test plan must work around rather than assume:

1. **`createApp()`/`bootApp()` does not call `bootstrapEvents()`** — the new `AuthDriverVerifiedConsumer` (and the existing `EpochInvalidationConsumer`) are not auto-registered on the container's `eventBus` when a test boots the app via `app.inject()`. The acceptance test must explicitly do, once in a `before()` hook: `container.resolve<AuthDriverVerifiedConsumer>('authDriverVerifiedConsumer').register();` — this is not new test-infrastructure work, it's one line mirroring exactly what `bootstrapEvents()` does in production.
2. **The outbox relay does not run automatically in tests either** — following the *production-faithful* variant of the pattern already established in `outbox-relay.test.ts` (§A), but resolving the container's **singleton** `outboxRelay`/`eventBus` (not constructing fresh disposable ones, since the consumer registered itself on the singleton bus in step 1): `await container.resolve<OutboxRelay>('outboxRelay').processBatch(10);` after the approval call, before asserting the role was granted.

### S.1 `tests/integration/driver-lifecycle.test.ts` — primary end-to-end suite

Mirrors `user-avatar.test.ts`'s structure (`before`/`after`/`afterEach` with `bootApp`/`resetState`, a small local helper for the files upload+complete round-trip reusing `image-fixtures.ts`/`MockStorageProvider` exactly as that file does). Steps, all through `app.inject()` (no direct Prisma writes for any state transition, per the user's explicit requirement):

1. `loginAs(app, phone)` → driver-to-be user.
2. `loginAs(app, adminPhone)` + `grantRole(admin.userId, 'admin')` (existing `fixtures.ts` helper, §A — seeding an admin's own role via this helper is acceptable since it is not part of the lifecycle under test, only test setup, matching how `authorization-bola.test.ts` already seeds admin/support roles this same way).
3. `GET /drivers/me` → driver onboarded.
4. `PATCH /drivers/:driverId/profile`.
5. For each of `DRIVING_LICENSE`, `RC`, `INSURANCE`: upload+complete a file (purpose `DRIVER_DOCUMENT`), then `POST /drivers/:driverId/documents {documentType, fileId}`.
6. For each submitted document: `POST /drivers/:driverId/documents/:documentId/review {status:'VERIFIED'}` as admin.
7. `POST /drivers/:id/verify {status:'VERIFIED'}` as admin → 200.
8. Register the consumer (step 1 of the gap-workaround above, actually done in `before()`), then `processBatch(10)` on the resolved `outboxRelay`.
9. Assert `db().client.userRoleAssignment.findFirst({where:{userId, roleId: driverRole.id, revokedAt:null}})` is non-null.
10. `POST /auth/refresh` with the driver's refresh token → assert response `roles` includes `'driver'`.
11. `POST /drivers/status/online` → 200.
12. Assert a `driver_shift_logs` row (or `driver_online_status.currentShiftId`) exists.
13. `POST /drivers/location` with valid coordinates → assert `GeoService`/`findNearbyDrivers` (via `@modules/geo`'s existing test helper pattern, cross-referencing `geo-nearby.test.ts` for how nearby assertions are made in this codebase) returns the driver.
14. A second driver seeded `PENDING`/suspended/offline posts location → assert absence from `findNearbyDrivers`.
15. Re-call `GET /drivers/me` → still one `Driver` row (`db().client.driver.count({where:{userId}})===1`).
16. Re-submit the same `documentType` with a new `fileId` → still exactly one `driver_documents` row for that `(driverId, documentType)` (constraint holds; also assert the old `fileId` was superseded, not orphaned — check `files.status==='SUPERSEDED'`).
17. Directly invoke the registered consumer a second time with the same envelope shape (unit-level call, not re-publishing through the outbox) → assert still exactly one active `UserRoleAssignment`.

### S.2 `tests/integration/driver-document-review.test.ts` — negative/authorization suite

- Arbitrary `fileUrl` in the submit-document body → 400 (schema rejection, no `fileUrl` key exists anymore).
- `fileId` belonging to another user → `FileNotFoundError` propagated as 404.
- Nonexistent `fileId` → 404.
- `fileId` with `purpose='PROFILE_IMAGE'` → 404 (purpose mismatch).
- Non-admin (customer, driver-self) attempts document review → 403.
- Admin whose own `userId` matches the driver's `userId` attempts review → 403 `SELF_REVIEW_FORBIDDEN` (seed this via `grantRole(driverUser.userId, 'admin')` on the same user that also has a `Driver` row).
- Reviewing a nonexistent `documentId`, or one not belonging to the URL's `driverId` → 404/409.
- Approve driver with zero documents submitted → 422 with `details.missing` = all three required types.
- Approve driver with one `PENDING` required document → 422 with `details.pending` non-empty.
- Approve driver with one `REJECTED` required document → 422 with `details.rejected` non-empty.
- Approve driver with one required document `VERIFIED` but `expiresAt` in the past → 422 with `details.expired` non-empty.
- `POST /status/online` before verification → 403 `DRIVER_NOT_VERIFIED` (existing error, unchanged code).
- Re-approve an already-`VERIFIED` driver → 200, idempotent, assert no second `driver.verified` outbox row was written (count stays 1).

### S.3 What is explicitly **not** re-tested here (already covered elsewhere, per §A)

- `AuthService.grantRole`'s own idempotency/concurrency correctness — already exhaustively covered in `auth-roles.test.ts`.
- `FileLifecycleService.assertReferenceable`/`.supersede`'s own correctness — already covered in `file-supersede.test.ts`/`file-lifecycle.test.ts`.
- `OutboxRelay`'s claim/retry/dead-letter mechanics — already covered in `tests/unit/events/outbox-relay.test.ts` and `tests/integration/outbox-relay.test.ts`.
- Existing Customer OTP/login flow — untouched, existing `auth-login.test.ts` etc. continue to cover it; this feature adds no new assertions there beyond confirming (via the lifecycle test's own login calls) that nothing broke.

### S.4 Environment limitations to flag explicitly

Per the user's instruction to distinguish planned-vs-currently-runnable tests: all of the above run against the existing local/CI Postgres+Redis test setup already used by every other integration test in this repo (no new external dependency introduced — Files already uses a `MockStorageProvider` in tests, confirmed in `user-avatar.test.ts`, so no real S3 is needed here either). No test in this plan requires infrastructure this repo doesn't already provision for its test suite.

## T. Exact Implementation Order

1. Prisma schema edits (§E.16-17) + generate client.
2. Migration H.1 (uniqueness) — apply, verify no duplicate-data failure locally.
3. Migration H.2 (file_id expand) — apply.
4. `driver.errors.ts` additions (§E.10) — no dependents yet, safe to land first.
5. `driver.metrics.ts` additions (§E.11).
6. `DriverEligibilityService` + types (§F.1-3) — pure addition, no existing file depends on it yet.
7. `driver-document.repository.ts` changes (§E.2) — `upsertDocument` signature change will break its two current callers until step 8/9 land; land together in one commit/PR-internal sequence, not as separate deploys, since this is pre-merge planning not a live rolling deploy like the profile-image migration was.
8. `driver.schemas.ts` changes (§E.1).
9. `onboarding.service.ts` changes (§E.4) — now compiles against the new repository/schema/eligibility-service shapes.
10. `status.service.ts`, `location.service.ts`, `doc-expiration.job.ts` changes (§E.5-7).
11. `driver-onboarding.controller.ts` + `driver.routes.ts` changes (§E.8-9).
12. `drivers/index.ts` DI + file-reference registration (§E.12).
13. `AuthDriverVerifiedConsumer` + `auth/index.ts` + `auth/consumers/index.ts` + `events.bootstrap.ts` (§F.4, §E.13-15).
14. `fixtures.ts` fixture fix (§E.18) — must land before/with step 15 or the existing suite regresses.
15. `verification-gate.test.ts` update (§E.19).
16. New test files (§F.7-8).
17. Full test suite run; targeted manual smoke of the HTTP lifecycle if a dev environment is available.

This order front-loads schema/pure-addition changes, then changes the shared repository/schema contracts once, then updates every caller of those contracts together, then wires DI/events, then fixes the test fixture that would otherwise regress, then adds new tests last.

## U. Risks and Compatibility Checks

- **R-1 (regression, high confidence, mitigated in this plan)**: `authorization-bola.test.ts:263-268` breaks without the `fixtures.ts` fix in §E.18/§T.14 — explicitly planned for, not a residual risk if the implementation order is followed.
- **R-2 (behavior-restoring bugfix, not a break)**: `setOnline` starts succeeding for properly-documented drivers for the first time — confirmed in the spec, re-confirmed here; no currently-online production driver is downgraded, since none could reach `ONLINE` through the real flow before (§A/§2.4 of spec).
- **R-3 (schema)**: `File` model needs a new back-relation field (§E.17) — purely additive, Prisma requires it for the FK to compile but it has no runtime behavior implications for existing Files-module code.
- **R-4 (config default risk, carried from spec R-4)**: `driverConfig.requireApprovedDocuments=false` remains a full bypass of the gate — unchanged from spec's assessment; no boot-time warning added in this plan (still an `OPEN_QUESTION`, not implemented, matching spec's own scoping).
- **R-5 (test infra)**: the two test-harness gaps found in §A/§S (consumer not auto-registered, relay not auto-started under `app.inject()`) are workarounds *within* the new tests, not changes to shared harness files — deliberately scoped this way so this feature doesn't alter shared test infrastructure other test files depend on.
- **R-6 (migration ordering)**: H.1 and H.2 are independent of each other (different columns) and could technically apply in either order, but this plan fixes H.1 before H.2 so the uniqueness constraint exists before the repository's `upsertDocument` is converted to rely on it (§T step 2-3 before step 7) — sequencing risk is avoidable by following §T as written.

## V. Decisions/Assumptions Requiring Confirmation

Carried forward from spec.md plus new ones found during planning, all labeled:

1. `OPEN_QUESTION` (from spec, unchanged): required document set `DRIVING_LICENSE, RC, INSURANCE` is an inferred default, not confirmed with product/compliance.
2. `OPEN_QUESTION` (from spec, unchanged): whether any pre-existing `driver_documents` rows with only `file_url` exist in a real target environment — affects whether §H.2's data-handling note needs an active backfill step or is a no-op.
3. `OPEN_QUESTION` (new, this plan): the `file_url` column's actual drop (contract-phase migration) is deferred to a follow-up feature/migration, not this one — confirm this phasing is acceptable rather than expecting a single-migration cutover.
4. `CONFIGURATION_DECISION` (new, this plan): document review transitions remain bidirectional (`VERIFIED ↔ REJECTED` by admin reconsideration), matching spec FR-9 — re-affirmed here with no new evidence changing that call.
5. `CONFIGURATION_DECISION` (new, this plan): `checkRequiredDocuments` is called with the caller's transaction handle (`tx`) at both call sites rather than being read outside the transaction — this is a correctness requirement, not really optional, but flagged since it's an implementation detail with no explicit test asserting the isolation behavior itself (would require a deliberately racy test to prove, judged not worth the complexity for this feature).
6. `OPEN_QUESTION` (new, this plan): whether `tests/integration/driver-document-review.test.ts` should be a separate file or folded into `driver-lifecycle.test.ts` — this plan splits them for legibility (§F.8's rationale), but either is compatible with `/speckit.tasks`; flagging in case the user prefers one file.

---

**PLAN COMPLETE**
**NO SOURCE CODE HAS BEEN MODIFIED**
**NO tasks.md HAS BEEN GENERATED**
**CURRENT CODEBASE FINDINGS HAVE BEEN VERIFIED AGAINST EXACT FILE CONTENTS, NOT ARCHITECTURE-LEVEL SUMMARIES ALONE**
**READY FOR /speckit.tasks**
