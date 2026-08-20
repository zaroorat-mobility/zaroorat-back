import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverDocument, DriverDocumentType, VerificationStatus } from '../types';
export class DriverDocumentRepository {
  constructor(private readonly db: DatabaseService) {}
  async upsertDocument(
    data: {
      driverId: string;
      documentType: DriverDocumentType;
      fileUrl: string;
      documentNumber?: string;
      issuedAt?: Date;
      expiresAt?: Date;
    },
    tx?: TransactionClient,
  ): Promise<DriverDocument> {
    const client = tx ?? this.db.client;
    const existing = await client.driverDocument.findFirst({
      where: {
        driverId: data.driverId,
        documentType: data.documentType,
      },
    });
    if (existing) {
      return client.driverDocument.update({
        where: { id: existing.id },
        data: {
          fileUrl: data.fileUrl,
          documentNumber: data.documentNumber ?? null,
          issuedAt: data.issuedAt ?? null,
          expiresAt: data.expiresAt ?? null,
          verificationStatus: 'PENDING',
        },
      });
    }
    return client.driverDocument.create({
      data: {
        driverId: data.driverId,
        documentType: data.documentType,
        fileUrl: data.fileUrl,
        documentNumber: data.documentNumber ?? null,
        issuedAt: data.issuedAt ?? null,
        expiresAt: data.expiresAt ?? null,
        verificationStatus: 'PENDING',
      },
    });
  }
  async findByDriverId(driverId: string, tx?: TransactionClient): Promise<DriverDocument[]> {
    const client = tx ?? this.db.client;
    return client.driverDocument.findMany({
      where: { driverId },
    });
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
