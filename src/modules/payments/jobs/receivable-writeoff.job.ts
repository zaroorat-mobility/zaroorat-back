import { RedisService } from '@core/cache/RedisService.js';
import { logger } from '@shared/logger/index.js';
import { WriteOffService } from '../services/writeoff/writeoff.service.js';

export interface WriteOffReport {
  scanned: number;
  writtenOff: number;
}

const BATCH = 200;

/// Ages out receivables nobody is going to pay (BD-1c).
///
/// Separate from the collection sweep on purpose: that one runs every few
/// minutes because a declined card might work on the next attempt, while this
/// one measures in days. Folding them together would either hammer the
/// write-off scan pointlessly or slow retries to a daily cadence.
export class ReceivableWriteOffJob {
  constructor(
    private readonly writeOffService: WriteOffService,
    private readonly redis: RedisService,
  ) {}

  async run(now: Date = new Date()): Promise<WriteOffReport> {
    const report: WriteOffReport = { scanned: 0, writtenOff: 0 };
    const token = await this.redis.lock.acquire('job:receivable-writeoff', 300_000);
    if (!token) {
      logger.info('Receivable write-off lock held by another process');
      return report;
    }
    try {
      for (const ride of await this.writeOffService.findAgedReceivables(now, BATCH)) {
        report.scanned++;
        if ((await this.writeOffService.writeOff(ride.id)) === 'WRITTEN_OFF') report.writtenOff++;
      }
    } finally {
      await this.redis.lock.release('job:receivable-writeoff', token);
    }
    return report;
  }
}
