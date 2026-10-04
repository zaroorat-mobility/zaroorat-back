import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  submitDriverDocumentSchema,
  reviewDriverDocumentSchema,
} from '../../../src/modules/drivers/schemas/driver.schemas.js';
import { DriverEligibilityService } from '../../../src/modules/drivers/services/eligibility/eligibility.service.js';
import { AdminApplicationService } from '../../../src/modules/admin/driver-management/applications/application.service.js';
import { AdminDriverNotFoundError } from '../../../src/modules/admin/driver-management/driver.errors.js';

describe('Driver Document System Flow & Security (Phase 18)', () => {
  describe('Document Submission Schema Validation', () => {
    it('accepts AADHAAR with documentNumber and without expiresAt', () => {
      const parsed = submitDriverDocumentSchema.safeParse({
        documentType: 'AADHAAR',
        fileId: '01918a22-3456-7890-abcd-ef0123456789',
        documentNumber: '543287651234',
      });
      assert.equal(parsed.success, true);
      if (parsed.success) {
        assert.equal(parsed.data.expiresAt, undefined);
      }
    });

    it('accepts PAN with documentNumber and without expiresAt', () => {
      const parsed = submitDriverDocumentSchema.safeParse({
        documentType: 'PAN',
        fileId: '01918a22-3456-7890-abcd-ef0123456789',
        documentNumber: 'ABCDE1234F',
      });
      assert.equal(parsed.success, true);
      if (parsed.success) {
        assert.equal(parsed.data.expiresAt, undefined);
      }
    });

    it('accepts PROFILE_PHOTO without documentNumber or expiresAt', () => {
      const parsed = submitDriverDocumentSchema.safeParse({
        documentType: 'PROFILE_PHOTO',
        fileId: '01918a22-3456-7890-abcd-ef0123456789',
      });
      assert.equal(parsed.success, true);
    });

    it('accepts POLICE_VERIFICATION document type', () => {
      const parsed = submitDriverDocumentSchema.safeParse({
        documentType: 'POLICE_VERIFICATION',
        fileId: '01918a22-3456-7890-abcd-ef0123456789',
        documentNumber: 'PV87654321',
      });
      assert.equal(parsed.success, true);
    });

    it('rejects invalid or non-existent document enums like BANK_PROOF or POLICE', () => {
      const badBank = submitDriverDocumentSchema.safeParse({
        documentType: 'BANK_PROOF',
        fileId: '01918a22-3456-7890-abcd-ef0123456789',
      });
      assert.equal(badBank.success, false);

      const badPolice = submitDriverDocumentSchema.safeParse({
        documentType: 'POLICE',
        fileId: '01918a22-3456-7890-abcd-ef0123456789',
      });
      assert.equal(badPolice.success, false);

      const badProfile = submitDriverDocumentSchema.safeParse({
        documentType: 'PROFILE',
        fileId: '01918a22-3456-7890-abcd-ef0123456789',
      });
      assert.equal(badProfile.success, false);
    });
  });

  describe('Document Review Schema', () => {
    it('accepts VERIFIED status without rejectionReason', () => {
      const parsed = reviewDriverDocumentSchema.safeParse({ status: 'VERIFIED' });
      assert.equal(parsed.success, true);
    });

    it('requires rejectionReason when status is REJECTED', () => {
      const noReason = reviewDriverDocumentSchema.safeParse({ status: 'REJECTED' });
      assert.equal(noReason.success, false);

      const withReason = reviewDriverDocumentSchema.safeParse({
        status: 'REJECTED',
        rejectionReason: 'Blurred image',
      });
      assert.equal(withReason.success, true);
    });
  });

  describe('Authoritative Eligibility Gates (Expired & Missing Docs)', () => {
    it('fails eligibility if a required document is expired', async () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // yesterday

      const mockDocRepo = {
        findByDriverId: async () => [
          {
            id: 'doc-dl',
            documentType: 'DRIVING_LICENSE',
            verificationStatus: 'VERIFIED',
            expiresAt: pastDate,
          },
          {
            id: 'doc-rc',
            documentType: 'RC',
            verificationStatus: 'VERIFIED',
            expiresAt: new Date(now.getTime() + 30 * 86400000),
          },
          {
            id: 'doc-ins',
            documentType: 'INSURANCE',
            verificationStatus: 'VERIFIED',
            expiresAt: new Date(now.getTime() + 30 * 86400000),
          },
        ],
      };

      const eligibility = new DriverEligibilityService(mockDocRepo as never);
      const result = await eligibility.checkRequiredDocuments('driver-1');

      assert.equal(result.eligible, false);
      assert.equal(result.expired.includes('DRIVING_LICENSE' as never), true);
    });

    it('fails eligibility if a required document is pending verification', async () => {
      const mockDocRepo = {
        findByDriverId: async () => [
          {
            id: 'doc-dl',
            documentType: 'DRIVING_LICENSE',
            verificationStatus: 'PENDING',
            expiresAt: new Date(Date.now() + 30 * 86400000),
          },
        ],
      };

      const eligibility = new DriverEligibilityService(mockDocRepo as never);
      const result = await eligibility.checkRequiredDocuments('driver-1');

      assert.equal(result.eligible, false);
      assert.equal(result.pending.includes('DRIVING_LICENSE' as never), true);
    });
  });

  describe('Admin Vehicle Document Review Routing (Phase 13)', () => {
    it('routes vehicle document to VehicleVerificationService.reviewDocument', async () => {
      let vehicleVerificationCalled = false;
      let driverServiceReviewCalled = false;

      const mockAdminDriverService = {
        getById: async (id: string) => ({
          id,
          driverName: 'Test Driver',
          verificationStatus: 'PENDING',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          documents: [],
          bankAccounts: [],
          timeline: [],
          auditLogs: [],
        }),
      };

      const mockDriverService = {
        documents: {
          reviewDocument: async () => {
            driverServiceReviewCalled = true;
          },
        },
      };

      const mockDatabaseService = {
        client: {
          adminActivityLog: {
            findMany: async () => [],
          },
          driverDocument: {
            findUnique: async () => null, // Not a driver doc
          },
          vehicleDocument: {
            findUnique: async ({ where }: { where: { id: string } }) => {
              if (where.id === 'vdoc-123') {
                return {
                  id: 'vdoc-123',
                  vehicleId: 'veh-999',
                  vehicle: {
                    id: 'veh-999',
                    currentDriverId: 'driver-1',
                    assignments: [],
                  },
                };
              }
              return null;
            },
          },
        },
      };

      const mockVehicleVerificationService = {
        reviewDocument: async (
          vehicleId: string,
          documentId: string,
          status: string,
          actor: { actorId: string },
          _rejectionReason?: string,
        ) => {
          vehicleVerificationCalled = true;
          assert.equal(vehicleId, 'veh-999');
          assert.equal(documentId, 'vdoc-123');
          assert.equal(status, 'VERIFIED');
          assert.equal(actor.actorId, 'admin-1');
          return { id: documentId, verificationStatus: status };
        },
      };

      const adminAppService = new AdminApplicationService(
        mockAdminDriverService as never,
        mockDriverService as never,
        mockDatabaseService as never,
        {} as never,
        {} as never,
        mockVehicleVerificationService as never,
      );

      // Review vehicle document
      await adminAppService.reviewDocument('driver-1', 'vdoc-123', 'VERIFIED', {
        actorId: 'admin-1',
        ipAddress: '127.0.0.1',
      });

      assert.equal(vehicleVerificationCalled, true);
      assert.equal(driverServiceReviewCalled, false);
    });

    it('routes driver document to DriverService.documents.reviewDocument', async () => {
      let driverServiceReviewCalled = false;
      let vehicleVerificationCalled = false;

      const mockAdminDriverService = {
        getById: async (id: string) => ({
          id,
          driverName: 'Test Driver',
          verificationStatus: 'PENDING',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          documents: [],
          bankAccounts: [],
          timeline: [],
          auditLogs: [],
        }),
      };

      const mockDriverService = {
        documents: {
          reviewDocument: async (documentId: string, applicationId: string, status: string) => {
            driverServiceReviewCalled = true;
            assert.equal(documentId, 'ddoc-456');
            assert.equal(applicationId, 'driver-1');
            assert.equal(status, 'REJECTED');
          },
        },
      };

      const mockDatabaseService = {
        client: {
          adminActivityLog: {
            findMany: async () => [],
          },
          driverDocument: {
            findUnique: async ({ where }: { where: { id: string } }) => {
              if (where.id === 'ddoc-456') {
                return { id: 'ddoc-456', driverId: 'driver-1' };
              }
              return null;
            },
          },
          vehicleDocument: {
            findUnique: async () => null,
          },
        },
      };

      const mockVehicleVerificationService = {
        reviewDocument: async () => {
          vehicleVerificationCalled = true;
        },
      };

      const adminAppService = new AdminApplicationService(
        mockAdminDriverService as never,
        mockDriverService as never,
        mockDatabaseService as never,
        {} as never,
        {} as never,
        mockVehicleVerificationService as never,
      );

      await adminAppService.reviewDocument(
        'driver-1',
        'ddoc-456',
        'REJECTED',
        { actorId: 'admin-1', ipAddress: '127.0.0.1' },
        'Signature mismatch',
      );

      assert.equal(driverServiceReviewCalled, true);
      assert.equal(vehicleVerificationCalled, false);
    });

    it('throws AdminDriverNotFoundError when document does not exist', async () => {
      const mockAdminDriverService = {
        getById: async (id: string) => ({ id }),
      };

      const mockDatabaseService = {
        client: {
          driverDocument: { findUnique: async () => null },
          vehicleDocument: { findUnique: async () => null },
        },
      };

      const adminAppService = new AdminApplicationService(
        mockAdminDriverService as never,
        {} as never,
        mockDatabaseService as never,
        {} as never,
        {} as never,
        {} as never,
      );

      await assert.rejects(async () => {
        await adminAppService.reviewDocument('driver-1', 'non-existent-doc', 'VERIFIED', {
          actorId: 'admin-1',
          ipAddress: '127.0.0.1',
        });
      }, AdminDriverNotFoundError);
    });
  });
});
