# Drivers Module Architecture & Operations

The **Drivers Module** (`src/modules/drivers/`) owns driver identity, profile onboarding, document verification workflows, operational eligibility gates, shift lifecycle tracking, heartbeat monitoring, and GPS location ingestion orchestration.

---

## 1. Core Principles & Guarantees

1. **Driver Operational Verification Gate**: A driver cannot transition from `OFFLINE` to `ONLINE` unless:
   - `verificationStatus === 'VERIFIED'`
   - `isSuspended === false`
   - Every document type in `driverConfig.requiredDocumentTypes` (default `DRIVING_LICENSE, RC, INSURANCE`) has a submitted `DriverDocument` row that is `VERIFIED` and unexpired — computed by the single authoritative `DriverEligibilityService.checkRequiredDocuments(driverId, tx)`, the same function that gates admin driver-approval (`POST /:id/verify`). This is an actually-reachable gate: documents are submitted via `POST /:driverId/documents {documentType, fileId}` (Files-module-validated), reviewed per-document by an admin via `POST /:driverId/documents/:documentId/review`, and only once every required type is verified does the eligibility gate — and therefore `setOnline` — pass.
     Verification checks execute under database row locks (`SELECT ... FOR UPDATE`) via `driverRepo.lockForUpdate(driverId, tx)` to prevent verification/suspension race conditions.
2. **Single Active Shift Constraint**: Guarantees that concurrent `ONLINE` requests create exactly one active `DriverShiftLog` record per driver within database transactions (`tx`).
3. **Server-Side Heartbeat Timeout Worker**: Automated background job (`HeartbeatTimeoutJob`) scans drivers missing heartbeats (`heartbeatAt < T - timeout`), re-verifies staleness under row lock (`SELECT ... FOR UPDATE`), marks driver `OFFLINE`, and closes active shift.
4. **Mock Location Rejection**: GPS location updates flagged with `isMockLocation === true` are rejected with `MockLocationRejectedError`.
5. **Decoupled Financial & Geographic Architecture**: Exposes read projections for driver earnings backed by the Payments module (`src/modules/payments/`); delegates geographic spatial indexing to PostGIS `ST_SetSRID(ST_MakePoint(...))` without duplicating H3/location infrastructure.

---

## 2. Directory Structure

```
src/modules/drivers/
│
├── controllers/                    # Fastify HTTP controllers (onboarding, status, location, wallet)
├── routes/                         # Route registrations (/api/v1/drivers)
├── schemas/                        # Zod schemas, Response DTOs & Error envelopes
├── services/                       # Domain business services
│   ├── onboarding/                 # Profile & document verification service
│   ├── status/                     # Shift & online operational verification gate service
│   ├── location/                   # GPS location ingestion service
│   ├── wallet/                     # Earnings wallet read projection service
│   ├── shift/                      # Shift duration & stats service
│   └── driver.service.ts           # Thin aggregated orchestrator service
├── repositories/                   # Prisma database access repositories (with SELECT ... FOR UPDATE)
├── jobs/                           # Background workers (heartbeat timeout, document expiration)
├── metrics/                        # Observability metrics (DriverMetrics)
├── plugins/                        # Fastify plugin definition
├── events/                         # Domain event catalogue (DRIVER_EVENT_CATALOG)
├── errors/                         # Domain errors (DriverNotVerifiedError, DriverSuspendedError, etc.)
├── constants/                      # Module constants
├── types/                          # Prisma entity re-exports & domain models
├── utils/                          # Driver code generator utility
├── index.ts                        # Entry point & DI container registration
└── README.md                       # Production module documentation
```

---

## 3. Verification & Compliance

- `npx tsc --noEmit`: 0 errors
- `npm run test:unit`: 550 / 550 tests passing (including verification gate enforcement, suspension protection, and mock location rejection tests).
