import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverDocument, DriverDocumentType, VerificationStatus } from '../types';
export class DriverDocumentRepository {
  constructor(private readonly db: DatabaseService) {}
  async upsertDocument(
    data: {
      driverId: string;
      documentType: DriverDocumentType;
      fileId: string;
      documentNumber?: string;
      issuedAt?: Date;
      expiresAt?: Date;
    },
    tx?: TransactionClient,
  ): Promise<DriverDocument> {
    const client = tx ?? this.db.client;
    return client.driverDocument.upsert({
      where: {
        driverId_documentType: {
          driverId: data.driverId,
          documentType: data.documentType,
        },
      },
      create: {
        driverId: data.driverId,
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
        verificationNotes: null,
        rejectionReason: null,
      },
    });
  }
  async findByDriverId(driverId: string, tx?: TransactionClient): Promise<DriverDocument[]> {
    const client = tx ?? this.db.client;
    return client.driverDocument.findMany({
      where: { driverId },
    });
  }
  async findById(id: string, tx?: TransactionClient): Promise<DriverDocument | null> {
    const client = tx ?? this.db.client;
    return client.driverDocument.findUnique({ where: { id } });
  }
  async isDocumentFile(fileId: string, tx?: TransactionClient): Promise<boolean> {
    const client = tx ?? this.db.client;
    const count = await client.driverDocument.count({ where: { fileId } });
    return count > 0;
  }
  async updateVerificationStatus(
    id: string,
    verificationStatus: VerificationStatus,
    verifiedBy?: string,
    rejectionReason?: string,
    tx?: TransactionClient,
  ): Promise<DriverDocument> {
    const client = tx ?? this.db.client;
    return client.driverDocument.update({
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
  async findExpiredDocuments(now = new Date(), tx?: TransactionClient): Promise<DriverDocument[]> {
    const client = tx ?? this.db.client;
    return client.driverDocument.findMany({
      where: {
        verificationStatus: 'VERIFIED',
        expiresAt: { lte: now },
      },
    });
  }
}
