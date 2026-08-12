import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { DriverDocumentRepository } from '../repositories/driver-document.repository.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import { DriverMetrics } from '../metrics/driver.metrics.js';
import { logger } from '@shared/logger/index.js';

export class DocExpirationJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly docRepo: DriverDocumentRepository,
    private readonly driverRepo: DriverRepository,
    private readonly driverMetrics: DriverMetrics,
  ) {}

  async run(): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:driver_doc_expiration', 15000);
    if (!lockToken) return 0;

    let expiredCount = 0;

    try {
      const now = new Date();
      const expiredDocs = await this.docRepo.findExpiredDocuments(now);

      for (const doc of expiredDocs) {
        await this.docRepo.updateVerificationStatus(
          doc.id,
          'REJECTED',
          undefined,
          'Document expired',
        );
        this.driverMetrics.documentExpired({ driverId: doc.driverId, docType: doc.documentType });

        await this.driverRepo.updateVerificationStatus(
          doc.driverId,
          'DOCUMENT_REVIEW',
          undefined,
          'Required document expired',
        );

        expiredCount++;
      }
    } catch (err) {
      logger.error({ err }, 'Error running document expiration job');
    } finally {
      await this.redis.lock.release('job:driver_doc_expiration', lockToken);
    }

    return expiredCount;
  }
}
