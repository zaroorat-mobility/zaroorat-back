import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { DriverDocumentRepository } from '../repositories/driver-document.repository.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import { DriverStatusRepository } from '../repositories/driver-status.repository.js';
import { StatusService } from '../services/status/status.service.js';
import { DriverMetrics } from '../metrics/driver.metrics.js';
import { logger } from '@shared/logger/index.js';
export class DocExpirationJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly docRepo: DriverDocumentRepository,
    private readonly driverRepo: DriverRepository,
    private readonly driverMetrics: DriverMetrics,
    private readonly statusRepo: DriverStatusRepository,
    private readonly statusService: StatusService,
  ) {}
  async run(): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:driver_doc_expiration', 15000);
    if (!lockToken) return 0;
    let expiredCount = 0;
    try {
      const now = new Date();
      const expiredDocs = await this.docRepo.findExpiredDocuments(now);
      for (const doc of expiredDocs) {
        if (!(await this.expire(doc, now))) continue;
        this.driverMetrics.documentExpired({ driverId: doc.driverId, docType: doc.documentType });
        const currentStatus = await this.statusRepo.getStatus(doc.driverId);
        if (currentStatus?.status === 'ONLINE' || currentStatus?.status === 'BREAK') {
          await this.statusService.setOffline(doc.driverId, 'DOCUMENT_EXPIRED');
        }
        expiredCount++;
      }
    } catch (err) {
      logger.error({ err }, 'Error running document expiration job');
    } finally {
      await this.redis.lock.release('job:driver_doc_expiration', lockToken);
    }
    return expiredCount;
  }

  /// One document per transaction, under the driver row lock that uploads, decisions and
  /// suspensions take, so both updates act on committed state rather than the earlier read.
  /// The document expires only if it is still the verified, expired one that was read (a
  /// re-upload in between stands). The driver goes back to review only from VERIFIED and
  /// while not suspended, blocked or deleted: a final rejection, a suspension, a block, or a
  /// resubmission request and its instructions are operator decisions this job must not
  /// undo. A driver it leaves VERIFIED still cannot go online: that re-checks the documents.
  private expire(doc: { id: string; driverId: string }, now: Date): Promise<boolean> {
    return this.db.transactionManager.execute(async (tx) => {
      await this.driverRepo.lockForUpdate(doc.driverId, tx);
      const { count } = await tx.driverDocument.updateMany({
        where: { id: doc.id, verificationStatus: 'VERIFIED', expiresAt: { lte: now } },
        data: { verificationStatus: 'REJECTED', rejectionReason: 'Document expired' },
      });
      if (count === 0) return false;
      await tx.driver.updateMany({
        where: {
          id: doc.driverId,
          verificationStatus: 'VERIFIED',
          isSuspended: false,
          deletedAt: null,
          user: { status: 'ACTIVE', deletedAt: null },
        },
        data: {
          verificationStatus: 'DOCUMENT_REVIEW',
          rejectionReason: 'Required document expired',
        },
      });
      return true;
    });
  }
}
