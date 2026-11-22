# DRIVER MODULE — COMPLETE PRODUCTION VERIFICATION AUDIT

## 1. Executive Summary

The Driver module is fundamentally disconnected from the rest of the application and contains critical P0 blockers. A real driver **cannot** go from OTP authentication to an `ONLINE` dispatchable state in production without manual database manipulation. Key missing pieces include the inability to verify individual documents via the API, the complete absence of the `DRIVER` role assignment, and zero integration with the `Geo` dispatch system (`findNearbyDrivers` has zero callers).

## 2. Current Driver Flow

[Phone] → [OTP] → [User] → [GET /me creates Driver] → [Documents Submitted] → ❌ [BLOCKED: Documents cannot be verified] → [Admin Approves Driver] → ❌ [BLOCKED: DRIVER role is never granted] → ❌ [BLOCKED: Eligibility fails due to unverified documents] → ❌ [BLOCKED: Cannot go ONLINE] → ❌ [BLOCKED: Geo discovery never called].

## 3. Authentication

- **Working:** Driver uses existing OTP system.
- **Missing:** The `DRIVER` role is never granted, so `request.auth.roles` does not contain it. (ZAROORAT CODEBASE)

## 4. Driver Creation

- **Working/Partial:** Driver records are implicitly created via a side-effect on `GET /api/v1/drivers/me`. (ZAROORAT CODEBASE)
- **Vulnerability:** Any authenticated customer can hit `GET /me` and create a `Driver` row due to missing `fastify.authorize()` preHandlers. (INFERENCE)

## 5. Onboarding

- **Working:** Profile fields can be updated.
- **Partial:** No real state machine; status loosely changes to `DOCUMENT_REVIEW` upon document upload. (ZAROORAT CODEBASE)

## 6. Documents

- **Working:** Documents can be submitted (`fileUrl`, `documentType`).
- **Broken/Vulnerability:** `fileUrl` is blindly trusted without ownership verification against the `Files` module. (ZAROORAT CODEBASE)

## 7. Document Approval

- **MISSING / P0 BLOCKER:** There is **no production endpoint or service** to mark an individual document as `VERIFIED`. `DriverDocumentRepository.updateVerificationStatus` has zero callers outside of an automated expiration job. (ZAROORAT CODEBASE)

## 8. Vehicle

- **MISSING / P0 BLOCKER:** The `src/modules/vehicles/index.ts` file is a stub. Vehicle logic is completely unimplemented. (ZAROORAT CODEBASE)

## 9. Driver Approval

- **Working:** `POST /drivers/:id/verify` allows an admin to mark a driver as `VERIFIED`. (ZAROORAT CODEBASE)

## 10. Role Assignment

- **MISSING / P0 BLOCKER:** `AuthService.grantRole()` exists but has **zero callers** in the codebase. The `DRIVER` role is never assigned. (ZAROORAT CODEBASE)

## 11. Eligibility

- **Broken:** `StatusService.setOnline()` explicitly requires `d.documentType === 'DRIVING_LICENSE' && d.verificationStatus === 'VERIFIED'`. Since documents cannot be verified (see #7), eligibility can never be passed. (ZAROORAT CODEBASE)

## 12. Online/Offline

- **Broken:** Blocked entirely by eligibility failures. (INFERENCE)

## 13. Location

- **Vulnerability:** `POST /location` lacks authorization checks other than being a logged-in user with a Driver row. An `OFFLINE`, `UNVERIFIED`, or `SUSPENDED` user can populate the live geo index. (ZAROORAT CODEBASE)

## 14. Geo Discovery

- **MISSING / P0 BLOCKER:** `GeoService.findNearbyDrivers()` has **zero production callers**. Dispatch is not implemented. (ZAROORAT CODEBASE)

## 15. Ride State

- **Broken:** A driver can theoretically accept unlimited rides concurrently because `acceptRideRequest` does not check for existing active rides. (ZAROORAT CODEBASE)

## 16. Authorization

- **Broken / Conflicting:** Driver endpoints use `requireOperableDriver` (checks `Driver` DB table for `VERIFIED`), whereas Ride endpoints use `callerHasRole(req, 'driver')` (checks JWT roles). Because the role is never assigned, an approved driver could theoretically use driver endpoints but would receive `403 Forbidden` on all ride endpoints. (ZAROORAT CODEBASE)

## 17. Admin/Support

- **Partial:** Admins can approve the _driver_, suspend the driver, but cannot approve _documents_ or assign _roles_. (ZAROORAT CODEBASE)

## 18. Failure Cases

- Missing document verification: Fails closed (correct).
- Concurrent ride accepts: Fails open (unlimited rides allowed).
- Location from suspended driver: Fails open (Geo index populated). (ZAROORAT CODEBASE)

## 19. Tests

- **FIXTURE SHORTCUTS:** Existing tests bypass production flaws by directly inserting `VERIFIED` statuses into the database, mocking roles, or directly calling internal services instead of testing the full HTTP lifecycle. (TEST EVIDENCE)

## 20. Production Gap Matrix

| Component          | Exists | Production caller | Working     | Tested  | Blocker  |
| ------------------ | ------ | ----------------- | ----------- | ------- | -------- |
| Auth               | Yes    | Yes               | Yes         | Yes     | No       |
| Driver creation    | Yes    | Yes               | Partial     | Yes     | No       |
| Profile            | Yes    | Yes               | Yes         | Yes     | No       |
| Onboarding         | Yes    | Yes               | Partial     | Yes     | No       |
| Documents          | Yes    | Yes               | Partial     | Yes     | No       |
| Document approval  | Yes    | No                | No          | Fixture | Yes (P0) |
| Vehicle            | Stub   | No                | No          | No      | Yes (P0) |
| Vehicle approval   | No     | No                | No          | No      | Yes (P0) |
| Driver approval    | Yes    | Yes               | Yes         | Yes     | No       |
| Role assignment    | Yes    | No                | No          | Fixture | Yes (P0) |
| Eligibility        | Yes    | Yes               | Broken      | Fixture | Yes (P0) |
| Online/offline     | Yes    | Yes               | Broken      | Fixture | Yes (P0) |
| Heartbeat          | Yes    | Yes               | Yes         | Yes     | No       |
| Location           | Yes    | Yes               | Vulnerable  | Yes     | No       |
| Geo discovery      | Yes    | No                | No          | Fixture | Yes (P0) |
| Availability       | Yes    | Yes               | Broken      | Fixture | Yes (P0) |
| Ride authorization | Yes    | Yes               | Conflicting | Fixture | Yes (P0) |
| Suspension         | Yes    | Yes               | Yes         | Yes     | No       |
| Admin              | Yes    | Yes               | Partial     | Yes     | No       |
| Support            | Yes    | Yes               | Partial     | Yes     | No       |

## 21. P0

- Document Approval missing endpoints.
- Role Assignment (`DRIVER` role never granted).
- Geo Discovery (`findNearbyDrivers` has zero callers).
- Vehicles module is a stub.
- Ride Authorization conflicts (`requireOperableDriver` vs `callerHasRole`).

## 22. P1

- Unlimited concurrent ride accepts permitted.
- Location ingestion allows offline/unverified drivers to pollute the live index.

## 23. P2

- `GET /me` implicitly creates Driver rows for any authenticated user.
- Document `fileUrl` ownership not verified.

## 24. Recommended Order

1. Implement Document Approval endpoints.
2. Fix `DRIVER` role assignment upon driver approval.
3. Unify authorization (`requireOperableDriver` vs roles).
4. Implement Vehicle module.
5. Integrate Geo discovery (`findNearbyDrivers`) into ride dispatch.

## 25. Final Production Readiness Decision

1. **Can a new person enter the Driver App using existing OTP?** Yes.
2. **Is the Driver User/record created correctly?** Partially (implicitly via GET request side-effect).
3. **Can the driver complete onboarding?** Yes, but informally.
4. **Can documents be submitted?** Yes.
5. **Can an admin/support actually verify documents?** NO.
6. **Can a driver become APPROVED?** Yes.
7. **Is DRIVER role automatically assigned after approval?** NO.
8. **Can a fully approved driver pass eligibility?** NO (due to unverified documents).
9. **Can that driver go ONLINE?** NO.
10. **Can the driver location enter the live geo index?** YES (even if unverified/offline).
11. **Can Geo discover the driver?** NO.
12. **Can the driver receive a ride?** NO.
13. **Can the driver accept only one active ride?** NO (unlimited accepted rides theoretically possible).
14. **Are all driver ride endpoints correctly role-protected?** NO (conflicting authorization schemes).
15. **Can an unapproved/suspended driver operate?** Partially (can send locations).

DRIVER MODULE VERIFICATION COMPLETE

READY:

- Authentication
- Driver Profile Creation
- Heartbeats

BLOCKED:

- Eligibility
- Online Status
- Dispatch

P0:

- Missing Document Verification Endpoint
- Missing DRIVER Role Assignment
- Zero Callers for Geo Discovery (`findNearbyDrivers`)
- Vehicle Module is a stub

P1:

- Concurrent ride limits not enforced
- Unverified/Offline location tracking vulnerability

P2:

- GET /me creates Driver (BOLA risk)
- Unverified fileUrl ownership

MOST IMPORTANT BLOCKER:

- Documents cannot be verified via API, blocking the entire eligibility and ONLINE flow.

CAN A REAL DRIVER GO FROM PHONE → OTP → ONBOARDING → APPROVAL → DRIVER ROLE → ELIGIBLE → ONLINE?
NO

NO CODE CHANGES MADE.
