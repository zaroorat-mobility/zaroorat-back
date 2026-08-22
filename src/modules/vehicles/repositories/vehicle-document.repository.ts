import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { VehicleDocument, VerificationStatus } from '../types/index.js';

export interface UpsertVehicleDocumentInput {
  vehicleId: string;
  documentType: string;
  fileId: string;
  documentNumber?: string;
  issuedAt?: Date;
  expiresAt?: Date;
}

/// Mirrors `DriverDocumentRepository` method for method — same upsert-against-
/// the-unique-key shape, same review-field reset on resubmission.
export class VehicleDocumentRepository {
  constructor(private readonly db: DatabaseService) {}

  async upsertDocument(
    data: UpsertVehicleDocumentInput,
    tx?: TransactionClient,
  ): Promise<VehicleDocument> {
    const client = tx ?? this.db.client;
    return client.vehicleDocument.upsert({
      where: {
        vehicleId_documentType: {
          vehicleId: data.vehicleId,
          documentType: data.documentType,
        },
      },
      create: {
        vehicleId: data.vehicleId,
        documentType: data.documentType,
        fileId: data.fileId,
        documentNumber: data.documentNumber ?? null,
        issuedAt: data.issuedAt ?? null,
        expiresAt: data.expiresAt ?? null,
        verificationStatus: 'PENDING',
      },
      update: {
        fileId: data.fileId,
        documentNumber: data.documentNumber ?? null,
        issuedAt: data.issuedAt ?? null,
        expiresAt: data.expiresAt ?? null,
        verificationStatus: 'PENDING',
        verifiedBy: null,
        verifiedAt: null,
        rejectionReason: null,
      },
    });
  }

  async findByVehicleId(vehicleId: string, tx?: TransactionClient): Promise<VehicleDocument[]> {
    const client = tx ?? this.db.client;
    return client.vehicleDocument.findMany({ where: { vehicleId } });
  }

  async findById(id: string, tx?: TransactionClient): Promise<VehicleDocument | null> {
    const client = tx ?? this.db.client;
    return client.vehicleDocument.findUnique({ where: { id } });
  }

  /// Backs the Files module's `registerFileReference` hook: a file still
  /// referenced by a vehicle document must not be soft-deletable.
  async isDocumentFile(fileId: string, tx?: TransactionClient): Promise<boolean> {
    const client = tx ?? this.db.client;
    const count = await client.vehicleDocument.count({ where: { fileId } });
    return count > 0;
  }

  async updateVerificationStatus(
    id: string,
    verificationStatus: VerificationStatus,
    verifiedBy?: string,
    rejectionReason?: string,
    tx?: TransactionClient,
  ): Promise<VehicleDocument> {
    const client = tx ?? this.db.client;
    return client.vehicleDocument.update({
      where: { id },
      data: {
        verificationStatus,
        ...(verificationStatus === 'VERIFIED'
          ? {
              verifiedAt: new Date(),
              ...(verifiedBy !== undefined ? { verifiedBy } : {}),
            }
          : {}),
        ...(rejectionReason !== undefined ? { rejectionReason } : {}),
      },
    });
  }
}
