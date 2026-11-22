# DRIVER ONBOARDING CODEBASE AUDIT

## 1. Executive Summary

The Driver Onboarding module contains a partial, implicit implementation that currently acts as a side-effect of a GET request. While the underlying OTP and User architectures from the Customer flow are robust and successfully reused, the specific Driver onboarding endpoints lack proper state management, email collection, and concurrency safeguards.

## 2. Existing Module Structure

- **Routes:** `driver.routes.ts`
- **Controllers:** `driver-onboarding.controller.ts`
- **Services:** `onboarding.service.ts`
- **Repositories:** `driver.repository.ts`
- **Database Access:** `TransactionManager` and direct Prisma client.
- **Events:** `driver.registered`, `driver.onboarded`, etc. via `EventPublisher`.

## 3. Auth/OTP Integration

- **ZAROORAT CODEBASE:** The Driver App successfully uses the existing `POST /auth/otp/send` and `POST /auth/otp/verify`.
- **ZAROORAT CODEBASE:** No duplicate authentication system exists. The frontend does not send any role in the OTP request.
- **Working:** YES.

## 4. User Integration

- **ZAROORAT CODEBASE:** Upon successful OTP verification, the `User` is correctly loaded or created by the Auth module. The JWT is issued to the client.
- **Working:** YES.

## 5. Driver Creation

- **ZAROORAT CODEBASE:** There is no explicit `POST` onboarding endpoint. Driver creation occurs entirely as a side-effect of `GET /api/v1/drivers/me`.
- **ZAROORAT CODEBASE:** `OnboardingService.createOrGetDriver` creates a new Driver row if one does not exist for the authenticated `userId`.
- **Gap:** `GET /me` should be read-only.
- **Gap:** A Customer who calls `GET /me` will accidentally create a Driver profile.

## 6. Driver Profile

- **ZAROORAT CODEBASE:** Profile fields are split.
  - **Name (`fullLegalName`)**: Stored in `DriverProfile` model. Updatable via `PATCH /me/profile`.
  - **Gender (`gender`)**: Stored in `DriverProfile` model. Updatable via `PATCH /me/profile`.
  - **Email (`email`)**: Stored in `User` model, but is currently marked as `// reserved (OD-7), nullable` and has **no update endpoint** in either the Driver or User modules.
- **Gap:** Email collection is broken/missing during onboarding.

## 7. Validation

- **ZAROORAT CODEBASE:** `updateDriverProfileSchema` uses Zod for backend validation.
  - Name: `z.string().min(2).max(100)`
  - Gender: `z.enum(['MALE', 'FEMALE', 'OTHER'])`
  - Email: **Missing** from schema.
- **Working:** Partial (Email missing).

## 8. Authorization

- **ZAROORAT CODEBASE:** Endpoints rely on the authenticated JWT. Role is not required to begin onboarding (which is correct, since the `DRIVER` role is granted later).

## 9. BOLA/IDOR

- **ZAROORAT CODEBASE:** The controller strictly uses `actingDriverId(req, this.driverRepository)`.
- **ZAROORAT CODEBASE:** `actingDriverId` securely extracts the `userId` from the JWT and looks up the associated `Driver`. The client cannot pass `driverId` or `userId` in the body/params to modify someone else's profile.
- **Working:** YES.

## 10. Customer vs Driver

- **ZAROORAT CODEBASE:** Because `GET /me` creates a Driver, any authenticated Customer can accidentally start Driver onboarding.
- **ZAROORAT CODEBASE:** Role behavior is untouched during onboarding.

## 11. Role Behavior

- **ZAROORAT CODEBASE:** Onboarding does NOT currently require the `DRIVER` role.
- **ZAROORAT CODEBASE:** Onboarding does NOT bypass the role source or allow the client to set roles.

## 12. Onboarding State

- **ZAROORAT CODEBASE:** There is no explicit state machine. The `Driver` model has `verificationStatus` which defaults to `PENDING`.
- **ZAROORAT CODEBASE:** It only changes to `DOCUMENT_REVIEW` when a document is uploaded.
- **Gap:** No `PROFILE_COMPLETE` or explicit submission state.

## 13. Resume Behavior

- **ZAROORAT CODEBASE:** Because `GET /me` uses `createOrGetDriver`, if a user closes the app and returns, `GET /me` will fetch the existing Driver record and resume. Profile updates use `upsert`, which is safe for resumption.
- **Working:** YES.

## 14. Idempotency

- **ZAROORAT CODEBASE:** Profile updates use `upsert` and are idempotent. Driver creation checks `existing` first.

## 15. Concurrency

- **ZAROORAT CODEBASE:** In `OnboardingService.createOrGetDriver`, the check for existing driver and the creation step are vulnerable to race conditions.
- **INFERENCE:** If two concurrent requests hit `GET /me` for a new user, both will see no existing driver and both will attempt to insert into the `Driver` table. Due to the `@unique` constraint on `userId`, the second request will throw an unhandled `P2002` Prisma error (500 Internal Server Error).
- **Working:** NO.

## 16. Database

- **ZAROORAT CODEBASE:** `Driver` uses `userId` (Unique, FK to User). `DriverProfile` uses `driverId` (Unique, FK to Driver). The schema relationships are sound.

## 17. Events

- **ZAROORAT CODEBASE:** `DRIVER_EVENT_CATALOG.ONBOARDED` is published when the Driver is created.

## 18. Files Dependency

- **ZAROORAT CODEBASE:** `submitDocument` accepts a `fileUrl` directly. It does not currently verify ownership with the Files module.
- **Gap:** Will be addressed in the Documents phase.

## 19. API Responses

- **ZAROORAT CODEBASE:** Responses return the full `Driver` or `DriverProfile` objects. They do not leak other users' data.

## 20. Error Handling

- **ZAROORAT CODEBASE:** `DriverNotFoundError` and validation errors are correctly thrown. The `P2002` concurrency error is unhandled.

## 21. Tests

- **TEST EVIDENCE:** `tests/integration/auth-driver-gate.test.ts` uses fixture shortcuts. It directly calls `db().client.driver.create` and `db().client.userRoleAssignment.create` instead of using the HTTP onboarding flow.
- **Gap:** Real HTTP integration tests for driver onboarding do not exist.

## 22. Actual Current Flow

Driver App
↓
Phone (IMPLEMENTED)
↓
OTP (IMPLEMENTED)
↓
User (IMPLEMENTED)
↓
Driver (BROKEN/PARTIAL - side effect of GET)
↓
Name (IMPLEMENTED)
↓
Gender (IMPLEMENTED)
↓
Email (MISSING)
↓
Complete (MISSING)

## 23. Gap Matrix

| Area             | Exists | Production Caller | Working | Tested  | Gap                    |
| ---------------- | ------ | ----------------- | ------- | ------- | ---------------------- |
| Auth integration | Yes    | Yes               | Yes     | Yes     | None                   |
| User integration | Yes    | Yes               | Yes     | Yes     | None                   |
| Driver creation  | Yes    | Yes               | Partial | Fixture | Implicit GET           |
| Profile          | Yes    | Yes               | Partial | Yes     | No explicit completion |
| Name             | Yes    | Yes               | Yes     | Yes     | None                   |
| Gender           | Yes    | Yes               | Yes     | Yes     | None                   |
| Email            | No     | No                | No      | No      | Not updatable          |
| Validation       | Yes    | Yes               | Partial | Yes     | Missing Email          |
| Authorization    | Yes    | Yes               | Yes     | Yes     | None                   |
| BOLA             | Yes    | Yes               | Yes     | Yes     | None                   |
| Onboarding state | Yes    | Yes               | Partial | No      | Loose states           |
| Resume           | Yes    | Yes               | Yes     | Yes     | None                   |
| Idempotency      | Yes    | Yes               | Yes     | Yes     | None                   |
| Concurrency      | Yes    | Yes               | Broken  | No      | P2002 on creation      |
| Events           | Yes    | Yes               | Yes     | Yes     | None                   |
| API response     | Yes    | Yes               | Yes     | Yes     | None                   |
| Error handling   | Yes    | Yes               | Partial | Yes     | Unhandled P2002        |
| Tests            | No     | No                | No      | Fixture | No real HTTP flow      |

## 24. P0

- **Implicit Driver Creation:** `GET /me` creates a Driver as a side-effect. This must be an explicit `POST /onboard`.
- **Missing Email Field:** No endpoint exists to update the email during onboarding.
- **Concurrency Crash:** Concurrent creation causes 500 P2002 errors.

## 25. P1

- **Customer Accidental Onboarding:** Any authenticated customer calling `GET /me` will create a Driver profile.

## 26. P2

- **Loose State Machine:** Need explicit `PROFILE_COMPLETE` tracking.

## 27. Recommended Implementation Order

1. Extract driver creation from `GET /me` to an explicit `POST /onboard` endpoint with concurrency checks (`upsert` or catch `P2002`).
2. Add `email` update capability (either proxy to User model or add to DriverProfile).
3. Implement explicit onboarding state machine logic to mark profile as complete.
4. Write real HTTP integration tests replacing the fixture shortcuts.

## 28. Final Production Readiness

1. **Does Driver App correctly enter the existing Auth/OTP flow?** Yes.
2. **Does OTP create/load the correct User?** Yes.
3. **Does Driver onboarding correctly create/find the Driver?** Yes, but implicitly via GET.
4. **Is Driver creation explicit?** NO.
5. **Is GET /drivers/me read-only?** NO.
6. **Are Name/Gender/Email stored correctly?** Name/Gender yes, Email is missing.
7. **Is backend validation correct?** Yes, for existing fields.
8. **Is BOLA protected?** Yes.
9. **Can onboarding be resumed?** Yes.
10. **Is onboarding state persisted?** Partially.
11. **Is onboarding idempotent?** Yes.
12. **Is concurrent onboarding safe?** NO (P2002 crash).
13. **Can Customer accidentally create a Driver?** YES.
14. **Does onboarding require DRIVER role today?** NO (correct behavior).
15. **Does onboarding need DRIVER role to function?** NO (correct behavior).
16. **Does the Driver reach the Documents phase correctly?** Partially, state transitions are loose.
17. **What is the exact missing functionality?** Explicit POST creation, Email collection, Concurrency safety.
18. **What should be implemented first?** Explicit POST onboarding endpoint with Email support.

DRIVER ONBOARDING AUDIT COMPLETE

Current flow:
Phone -> OTP -> User -> GET /me -> Name/Gender update

Working:
Auth, OTP, BOLA protection, Name/Gender validation.

Partial:
Driver Creation (Implicit), State Machine.

Missing:
Email collection, Explicit Onboarding POST.

P0:
GET /me side effect, Missing Email, Concurrency P2002 crash.

P1:
Customer accidentally creating Driver.

P2:
Loose state transitions.

Most important finding:
Driver creation is an unhandled, concurrent-unsafe side effect of a GET request, and Email cannot be collected.

Recommended first implementation:
Create an explicit `POST /onboard` endpoint that safely creates the Driver row and collects Name, Gender, and Email.

Can Driver currently complete:
Phone → OTP → User → Driver → Name → Gender → Email → Complete onboarding
**PARTIAL** (Stops at Gender, Email and explicit completion are missing).

Report:
docs/DRIVER_ONBOARDING_CODEBASE_AUDIT.md

NO CODE CHANGES MADE.
