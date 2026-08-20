---
description: 'Task list for Driver Document Verification & Online Eligibility Lifecycle'
---

# Tasks: Driver Document Verification & Online Eligibility Lifecycle

**Input**: Design documents from `specs/001-driver-verification-lifecycle/`
**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required)

**Tests**: Explicitly requested by the feature owner (spec.md §24, plan.md §S) — test tasks are included per story, written before the implementation tasks they verify.

**Organization**: `spec.md` does not use the standard P1/P2/P3 user-story format (it uses a 26-section technical structure per the requester's explicit instructions). This tasks.md derives four priority-ordered, independently testable stories directly from the lifecycle spec.md §6 and plan.md §C describe, matching the natural dependency chain of the feature (each story delivers a working, HTTP-verifiable increment of the pipeline).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- File paths are exact, verified against the current repository during planning (plan.md §A)

## Path Conventions

Single project. All paths are relative to the repository root `zaroorat-back/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Schema and configuration groundwork every story depends on.

- [x] T001 Add `fileId String? @map("file_id") @db.Uuid` + `file File? @relation(fields: [fileId], references: [id])` to `DriverDocument`, loosen `fileUrl` to `String?`, and add `@@unique([driverId, documentType], map: "driver_documents_driver_id_document_type_key")` in `prisma/schema/modules/driver/driver.prisma`
- [x] T002 [P] Add reverse relation `driverDocuments DriverDocument[]` to `model File` in `prisma/schema/modules/file/file.prisma`
- [x] T003 Create `prisma/migrations/20260820120000_driver_documents_uniqueness/migration.sql` adding the plain unique index on `driver_documents(driver_id, document_type)` (plan.md §H.1)
- [x] T004 Create `prisma/migrations/20260820121500_driver_document_file_id/migration.sql` adding nullable `file_id`, its unique index, the `ON DELETE RESTRICT` FK to `files`, and dropping `NOT NULL` on `file_url` (plan.md §H.2) — depends on T001, T002
- [x] T005 [P] Add `requiredDocumentTypes: DriverDocumentTypeEnum[]` (env-overridable, default `DRIVING_LICENSE,RC,INSURANCE`) to `src/config/driver/driver.config.ts`

**Checkpoint**: Schema and config exist; `npx prisma generate` runs clean against the updated schema.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Error types, metrics, and the eligibility service that User Stories 2, 3, and 4 all depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T006 Add optional `details?: unknown` to the `DriverError` base class (stored as `this.details`) and thread it through the `DocumentValidationError` constructor in `src/modules/drivers/errors/driver.errors.ts`
- [x] T007 [P] Add `SelfReviewForbiddenError extends DriverError` (403, `SELF_REVIEW_FORBIDDEN`) to `src/modules/drivers/errors/driver.errors.ts`
- [x] T008 [P] Add `documentVerified(fields?)` and `documentRejected(fields?)` methods to `src/modules/drivers/metrics/driver.metrics.ts`
- [x] T009 Add `DocumentEligibilityResult` interface (`{eligible, missing, pending, rejected, expired}`) to `src/modules/drivers/types/driver.types.ts`
- [x] T010 Create `DriverEligibilityService.checkRequiredDocuments(driverId, tx?)` in `src/modules/drivers/services/eligibility/eligibility.service.ts` (plan.md §N) — depends on T009
- [x] T011 [P] Create barrel export `src/modules/drivers/services/eligibility/index.ts` — depends on T010
- [x] T012 Register `driverEligibilityService: asClass(DriverEligibilityService).singleton()` and alias `eligibilityService: aliasTo('driverEligibilityService')` in `src/modules/drivers/index.ts` — depends on T010

**Checkpoint**: Eligibility service is resolvable via DI; error/metric primitives exist for stories to use.

---

## Phase 3: User Story 1 - Secure Document Submission via fileId (Priority: P1) 🎯 MVP

**Goal**: A driver submits a document by referencing a Files-module `fileId` instead of a trusted arbitrary URL; the Files module's own ownership/purpose/status checks (`FileLifecycleService.assertReferenceable`) gate what can be attached, closing the BOLA-style bypass that exists today (spec.md §2.2).

**Independent Test**: Authenticate as a driver, upload+complete a file via the existing Files flow (`POST /files` → PUT → `POST /files/:id/complete`), submit it via `POST /drivers/:driverId/documents {documentType, fileId}`, and confirm the resulting `DriverDocument` row references `fileId` (not a URL). Separately confirm another user's `fileId`, a nonexistent `fileId`, and a wrong-purpose `fileId` are all rejected — all via HTTP, no direct DB manipulation.

### Tests for User Story 1 ⚠️

> Write this test FIRST, ensure it fails before the implementation tasks below land.

- [x] T013 [P] [US1] Create `tests/integration/driver-document-submission.test.ts`: successful `fileId` submission stores `fileId` (not a URL) on the `DriverDocument` row; a request body still containing `fileUrl` is rejected 400 (schema no longer accepts the field); another user's `fileId` is rejected 404; a nonexistent `fileId` is rejected 404; a `fileId` with `purpose='PROFILE_IMAGE'` is rejected 404; re-submitting the same `documentType` with a new `fileId` supersedes the old file (`files.status==='SUPERSEDED'`) and leaves exactly one `driver_documents` row for that `(driverId, documentType)`; re-submitting a required document type while the driver is currently `VERIFIED` downgrades the driver to `DOCUMENT_REVIEW` in the same call, and if the driver was `ONLINE` at the time, forces them offline and removes their live geo position (spec.md FR-6/FR-23)

### Implementation for User Story 1

- [x] T014 [US1] Replace `fileUrl: z.string().url()` with `fileId: z.string().uuid()` in `submitDriverDocumentSchema`, `src/modules/drivers/schemas/driver.schemas.ts`
- [x] T015 [US1] Convert `upsertDocument` to a real atomic `client.driverDocument.upsert({where:{driverId_documentType:{driverId,documentType}}, ...})` keyed on `fileId`; on the `update` branch also reset `verifiedBy: null, verifiedAt: null, verificationNotes: null, rejectionReason: null`; add `isDocumentFile(fileId, tx?): Promise<boolean>` in `src/modules/drivers/repositories/driver-document.repository.ts` — depends on T003, T004
- [x] T016 [US1] Inject `fileService: FileService` into `OnboardingService`; in `submitDocument`, call `fileService.assertReferenceable(fileId, driver.userId, 'DRIVER_DOCUMENT', tx)` before `upsertDocument`, and `fileService.supersede(oldFileId, newFileId, tx, requestId)` when replacing an existing document's file, in `src/modules/drivers/services/onboarding/onboarding.service.ts` — depends on T015
- [x] T017 [US1] Update `submitDocument` to pass `body.fileId` instead of `body.fileUrl` in `src/modules/drivers/controllers/driver-onboarding.controller.ts` — depends on T014, T016
- [x] T018 [US1] Import `registerFileReference` from `@modules/files` and register `'DRIVER_DOCUMENT'` (`module: 'drivers'`, `isReferenced` via `driverDocumentRepository.isDocumentFile`) inside `registerDriversModule`, `src/modules/drivers/index.ts` — depends on T015

**Checkpoint**: Driver document submission is fully Files-validated and BOLA-safe. This alone is independently deployable and testable — the rest of the lifecycle isn't required for this story's own guarantee to hold.

---

## Phase 4: User Story 2 - Admin Document Review (Priority: P2)

**Goal**: An authorized admin reviews an individual `DriverDocument` to `VERIFIED` or `REJECTED`, with reviewer identity, timestamp, and rejection-reason requirements enforced; a driver (or an admin reviewing their own driver record) cannot review documents.

**Independent Test**: With a `PENDING` document from User Story 1, an admin reviews it via `POST /drivers/:driverId/documents/:documentId/review` and the row shows `verifiedBy`/`verifiedAt`; a non-admin and a self-reviewing admin are both rejected 403; re-reviewing with the same status is idempotent (no change, no error).

### Tests for User Story 2 ⚠️

- [x] T019 [P] [US2] Create `tests/integration/driver-document-review.test.ts`: admin verifies/rejects a document with `verifiedBy`/`verifiedAt`/`rejectionReason` recorded correctly; rejection without a `rejectionReason` is rejected by schema; non-admin (customer, driver-self) gets 403; an admin whose own `userId` matches the driver's `userId` gets 403 `SELF_REVIEW_FORBIDDEN`; reviewing a nonexistent `documentId` or one not belonging to the URL's `driverId` gets 404/409; re-reviewing with the same status is a 200 idempotent no-op

### Implementation for User Story 2

- [x] T020 [US2] Add `reviewDriverDocumentSchema = z.object({status: z.enum(['VERIFIED','REJECTED']), rejectionReason: z.string().min(1).max(255).optional()}).refine(...)` (reason required when rejecting) to `src/modules/drivers/schemas/driver.schemas.ts`
- [x] T021 [US2] Add `reviewDocument(documentId, driverId, status, reviewerId, rejectionReason?)` to `OnboardingService`: self-review guard (`driver.userId === reviewerId` → `SelfReviewForbiddenError`), same-status idempotent short-circuit, otherwise `docRepo.updateVerificationStatus(...)`, in `src/modules/drivers/services/onboarding/onboarding.service.ts` — depends on T006, T007, T015
- [x] T022 [US2] Add `reviewDocument(req, reply)` controller method resolving `driverId` via the existing `authorizedDriverId` helper, parsing `reviewDriverDocumentSchema`, calling `driverService.onboarding.reviewDocument(...)`, in `src/modules/drivers/controllers/driver-onboarding.controller.ts` — depends on T020, T021
- [x] T023 [US2] Add `fastify.post('/:driverId/documents/:documentId/review', {preHandler: fastify.authorize({roles:['admin']})}, ...)` route in `src/modules/drivers/routes/driver.routes.ts` — depends on T022

**Checkpoint**: Individual documents can be reviewed to `VERIFIED`/`REJECTED` by an authorized admin, fully auditable, self-review-safe.

---

## Phase 5: User Story 3 - Driver Approval, Eligibility Gate & Role Propagation (Priority: P3)

**Goal**: Driver-level approval enforces the required-document eligibility gate (blocks approval on missing/pending/rejected/expired required documents, including zero documents submitted), is idempotent, and on success publishes `driver.verified` transactionally with the driver's `userId`, which a new Auth-module event consumer uses to grant the `driver` role idempotently through the existing outbox/event architecture (Option B — no direct Drivers→Auth dependency).

**Independent Test**: With all required documents `VERIFIED` (via Stories 1–2), admin approves the driver via `POST /drivers/:id/verify` → 200. Approving with a missing/pending/rejected/expired required document → 422 with a structured breakdown. After relaying the resulting outbox event, the user has an active `driver` `UserRoleAssignment`; duplicate event delivery grants the role at most once; a token refresh yields a JWT containing the `driver` role.

### Tests for User Story 3 ⚠️

- [x] T024 [P] [US3] Create `tests/integration/driver-approval-eligibility.test.ts`: approval blocked with 422 + correct `details.{missing,pending,rejected,expired}` for each case, including zero documents submitted; successful approval publishes `driver.verified` with `data.userId`; relaying the outbox event (`outboxRelay.processBatch`) results in an active `driver` `UserRoleAssignment` for that `userId`; `POST /auth/refresh` afterward returns a token whose `roles` include `'driver'`; re-delivering the same event a second time still leaves exactly one active assignment; re-approving an already-`VERIFIED` driver is a 200 idempotent no-op with no second `driver.verified` outbox row

### Implementation for User Story 3

- [x] T025 [US3] In `reviewDriverVerification`: add self-review guard, transition validation (§8.1 state machine), same-status idempotent short-circuit, `eligibilityService.checkRequiredDocuments(driverId, tx)` gate before allowing `VERIFIED` (throw `DocumentValidationError` with `details` on failure), and add `userId: driver.userId` to the published event's `data`, in `src/modules/drivers/services/onboarding/onboarding.service.ts` — depends on T006, T007, T010, T012
- [x] T026 [P] [US3] Create `AuthDriverVerifiedConsumer` (`constructor(eventBus, authService)`, `.register()` subscribes to `'driver.verified'`, `handle()` calls `authService.grantRole(data.userId, 'driver', {grantedBy: data.approvedBy ?? null})`) in `src/modules/auth/consumers/driver-verified.consumer.ts`, mirroring `epoch-invalidation.consumer.ts`
- [x] T027 [US3] Add barrel export for `AuthDriverVerifiedConsumer` in `src/modules/auth/consumers/index.ts` — depends on T026
- [x] T028 [US3] Register `authDriverVerifiedConsumer: asClass(AuthDriverVerifiedConsumer).singleton()` in `registerAuthService`, `src/modules/auth/index.ts` — depends on T026
- [x] T029 [US3] Add `container.resolve<AuthDriverVerifiedConsumer>('authDriverVerifiedConsumer').register();` alongside the existing `epochInvalidationConsumer` line in `src/bootstrap/events.bootstrap.ts` — depends on T028

**Checkpoint**: A fully-documented driver can be approved, and approval reliably and idempotently grants the `driver` role through the existing transactional outbox — no direct Drivers→Auth dependency, no circular dependency.

---

## Phase 6: User Story 4 - Online Activation & Geo Safety (Priority: P4)

**Goal**: `setOnline` uses the same authoritative eligibility check as approval (replacing the currently-unsatisfiable ad-hoc license-only check — spec.md §2.4), so a driver can finally go `ONLINE` through the real production flow. Live geo-index publishing is gated on verified+not-suspended+online (durable location storage stays unconditional); a driver who becomes ineligible mid-shift (required document expiry) is forced offline and removed from the live index.

**Independent Test**: A driver who completed Stories 1–3 calls `POST /drivers/status/online` and gets 200 with a shift created. An unverified/suspended/offline driver's posted location is stored (durable row exists) but never appears in `GeoService.findNearbyDrivers` results. The doc-expiration job downgrading a `VERIFIED` driver forces them offline and off the live index.

### Tests for User Story 4 ⚠️

- [x] T030 [P] [US4] Create `tests/integration/driver-online-geo.test.ts`: online succeeds (200) only once every required document is `VERIFIED` and unexpired, 403 otherwise; an unverified/suspended/offline driver's location is stored but absent from `findNearbyDrivers`; forcing a required document to expire (or directly invoking the expiration job in a controlled test) downgrades a previously-`ONLINE` `VERIFIED` driver to `DOCUMENT_REVIEW`, ends their shift, and removes them from the live geo index
- [x] T031 [P] [US4] Update `tests/unit/drivers/verification-gate.test.ts` to construct/inject a `DriverEligibilityService` (real or minimally stubbed) alongside the mocked repositories, and extend its document fixtures to cover the full required set where a pass is expected — depends on T010

### Implementation for User Story 4

- [x] T032 [US4] Replace the inline `docRepo.findByDriverId` + `hasValidLicense` block in `setOnline` with `eligibilityService.checkRequiredDocuments(driverId, tx)`, throwing `DriverNotVerifiedError` with the result as `details` on failure, in `src/modules/drivers/services/status/status.service.ts` — depends on T010, T012
- [x] T033 [P] [US4] Wrap the existing `geoService.recordDriverPosition(...)` call in `if (driver.verificationStatus==='VERIFIED' && !driver.isSuspended && driver.isAvailable===true) {...}` using the `driver` object already fetched earlier in the method, in `src/modules/drivers/services/location/location.service.ts`
- [x] T034 [US4] Add `statusRepo`/`statusService` constructor params; after downgrading a driver to `DOCUMENT_REVIEW`, check current status and call `statusService.setOffline(doc.driverId, 'DOCUMENT_EXPIRED')` if currently `ONLINE`/`BREAK` (which already internally calls `geoService.forgetDriverPosition`), in `src/modules/drivers/jobs/doc-expiration.job.ts` — depends on T032
- [x] T035 [US4] Update `makeDriver` in `tests/integration/helpers/fixtures.ts`: when `verified: true`, create a `VERIFIED` document for every type in `driverConfig.requiredDocumentTypes` (not just `DRIVING_LICENSE`), preventing the regression identified in plan.md §A at `tests/integration/authorization-bola.test.ts:263-268` — depends on T005

**Checkpoint**: The complete production lifecycle — phone → OTP → onboarding → documents → review → approval → role → online → shift → geo availability — works end-to-end for the first time.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Composite proof and regression safety net across all four stories.

- [x] T036 [P] Create `tests/integration/driver-lifecycle.test.ts`: full HTTP-driven end-to-end happy path (login → onboard → profile → upload+submit all required documents → admin reviews each → admin approves → relay outbox → role granted → refresh token → go online → shift exists → location published to geo), plus duplicate-onboarding-safety and duplicate-document-type-safety assertions, per plan.md §S.1 — depends on T013–T035
- [x] T037 [P] Run the full existing test suite and confirm no regressions in `auth-roles.test.ts`, `authorization-bola.test.ts`, `auth-driver-gate.test.ts`, `file-supersede.test.ts`, `file-lifecycle.test.ts`, `outbox-relay.test.ts`, and all Customer/OTP tests — depends on T036
- [x] T038 Update the "Core Principle & Guarantee" wording in `src/modules/drivers/README.md` to reflect that document verification is now an actually-reachable gate, not an aspirational one (spec.md §2 finding) — depends on T032

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup (T005's config is read by the Foundational eligibility service) — BLOCKS all user stories.
- **User Stories (Phase 3–6)**: All depend on Foundational completion. Story 1 has no dependency on Stories 2–4. Stories 2–4 build on artifacts Story 1 creates (a submitted document to review/approve/go-online against) but each remains independently _testable_ once its own implementation tasks land — Story 2's tests seed their own document state via Story 1's now-working submission endpoint, not via direct DB writes.
- **Polish (Phase 7)**: Depends on all four stories being complete.

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational. No dependency on other stories. **This is the MVP** — it alone closes the file-ownership security gap, independent of everything downstream.
- **US2 (P2)**: Can start after Foundational; functionally exercised against documents created by US1, but its own code (review endpoint) has no build-time dependency on US1's code changes.
- **US3 (P3)**: Can start after Foundational; its eligibility gate depends on the `DriverEligibilityService` (Foundational) and its own tests exercise documents reviewed via US2 — sequence US1→US2→US3 for testing convenience, though the code changes themselves are independent files.
- **US4 (P4)**: Depends on US3 in practice (a driver must reach `VERIFIED` + hold the `driver` role to meaningfully test going online), but `T032`/`T033` (the `setOnline`/`LocationService` code changes) touch files no other story touches and could be implemented in parallel with US2/US3 if desired — only the _test_ for US4 needs US1–US3 to already work.

### Within Each User Story

- Tests are written first and must fail before the implementation tasks land.
- Schema/type tasks (Setup/Foundational) before service tasks.
- Repository changes before the service methods that call them.
- Service changes before controller changes before route changes.
- Story complete and checkpointed before moving to the next priority (or run in parallel per team capacity, per the dependency notes above).

### Parallel Opportunities

- T002, T005 (Setup) can run in parallel with T001/T003/T004 (different files/no shared state until Prisma generate).
- T007, T008 (Foundational) can run in parallel with each other and with T006.
- T011 can run in parallel with T012 once T010 lands.
- Within US1: T013 (test) can be written in parallel with T014 (schema) since they're different files; T018 can run in parallel with T017 once T015 lands.
- Within US3: T026 (new Auth consumer) can be built in parallel with T025 (Drivers-side gate), since they're in different modules and only meet at the event contract (`data.userId`), not at compile time.
- Within US4: T030, T031 (tests) and T033 (LocationService) can all run in parallel; T032 and T034 are sequential (job depends on the service's post-downgrade behavior existing).
- T036, T037 (Polish) can be prepared in parallel but T037 should run after T036 lands.

---

## Parallel Example: User Story 1

```bash
# Once Foundational (Phase 2) is done, launch these together:
Task: "Create tests/integration/driver-document-submission.test.ts (T013)"
Task: "Replace fileUrl with fileId in submitDriverDocumentSchema (T014)"
```

## Parallel Example: User Story 3

```bash
# These touch different modules and only share an event-type contract:
Task: "Harden reviewDriverVerification with the eligibility gate (T025, Drivers module)"
Task: "Create AuthDriverVerifiedConsumer (T026, Auth module)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (schema + config).
2. Complete Phase 2: Foundational (errors, metrics, eligibility service — even though US1 doesn't call `checkRequiredDocuments` itself, the shared error/metric primitives it also uses live here).
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: Run `driver-document-submission.test.ts` independently — this alone ships the fix for the most severe finding in spec.md (arbitrary-URL file attachment with zero ownership validation).

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → test independently → deploy (closes the file-security gap — MVP).
3. US2 → test independently → deploy (admin gains real per-document review).
4. US3 → test independently → deploy (driver approval becomes trustworthy; role propagation goes live).
5. US4 → test independently → deploy (the lifecycle's actual production defect — `setOnline` being unsatisfiable — is fixed; the full pipeline now works end-to-end).
6. Polish → full E2E proof + regression sweep.

### Team Strategy

With multiple developers, US1 and the Auth-side half of US3 (`T026`) are the best parallelization opportunities — US1 has zero dependency on any other story, and `AuthDriverVerifiedConsumer` only needs the _event contract_ (`data.userId`), not Drivers' code, to be built and unit-tested in isolation.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps each task to US1–US4 for traceability back to spec.md's lifecycle sections.
- Every test task specifies exact assertions, not just "add tests" — matching the requester's instruction that tasks be executable without additional context.
- No task in this list requires infrastructure the repository doesn't already provision for its test suite (plan.md §S.4) — no new external dependency is introduced.
- T015/T016/T025/T032 all touch `onboarding.service.ts`/`status.service.ts` and are **not** marked `[P]` relative to each other within a story for that reason, even across stories, since they share files — sequence per the Dependencies section above, not by story number alone.
