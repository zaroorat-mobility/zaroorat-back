import type { TransactionClient } from '@core/database/TransactionManager';
import { driverConfig } from '@config';
import { DriverDocumentRepository } from '../../repositories/driver-document.repository.js';
import type { DocumentEligibilityResult, DriverDocumentType } from '../../types';
export class DriverEligibilityService {
  constructor(private readonly docRepo: DriverDocumentRepository) {}
  async checkRequiredDocuments(
    driverId: string,
    tx?: TransactionClient,
  ): Promise<DocumentEligibilityResult> {
    if (!driverConfig.requireApprovedDocuments) {
      return { eligible: true, missing: [], pending: [], rejected: [], expired: [] };
    }
    const docs = await this.docRepo.findByDriverId(driverId, tx);
    const byType = new Map(docs.map((d) => [d.documentType, d]));
    const now = new Date();
    const missing: DriverDocumentType[] = [];
    const pending: DriverDocumentType[] = [];
    const rejected: DriverDocumentType[] = [];
    const expired: DriverDocumentType[] = [];
    for (const type of driverConfig.requiredDocumentTypes as DriverDocumentType[]) {
      const doc = byType.get(type);
      if (!doc) {
        missing.push(type);
        continue;
      }
      if (doc.verificationStatus === 'PENDING') {
        pending.push(type);
        continue;
      }
      if (doc.verificationStatus === 'REJECTED') {
        rejected.push(type);
        continue;
      }
      if (doc.expiresAt && doc.expiresAt <= now) {
        expired.push(type);
        continue;
      }
    }
    const eligible = !missing.length && !pending.length && !rejected.length && !expired.length;
    return { eligible, missing, pending, rejected, expired };
  }
}
