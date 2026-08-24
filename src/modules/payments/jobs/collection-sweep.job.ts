import { cashConfirmationRequired, paymentConfig } from '@config';
import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { logger } from '@shared/logger/index.js';
import { RideCollectionService } from '../services/collection/collection.service.js';

export interface CollectionSweepReport {
  scanned: number;
  collected: number;
  retried: number;
  receivable: number;
  cashResolved: number;
}

const BATCH = 100;

/// Retries collections the completion consumer did not finish.
///
/// The consumer covers the happy path; this covers everything else — a ride
/// whose event was delivered while the gateway was down, a decline that has
/// earned another attempt, a relay that died mid-batch.
///
/// Bounded by construction (BD-4): the attempt cap is enforced inside
/// `RideCollectionService`, and once it is reached the obligation moves to
/// `FAILED` and stops matching this query at all. No combination of the
/// configuration knobs can produce an unbounded loop, because the exit is a
/// state transition rather than a counter this job keeps.
export class CollectionSweepJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly rideCollectionService: RideCollectionService,
  ) {}

  async run(now: Date = new Date()): Promise<CollectionSweepReport> {
    const report: CollectionSweepReport = {
      scanned: 0,
      collected: 0,
      retried: 0,
      receivable: 0,
      cashResolved: 0,
    };
    // Only stops two replicas scanning the same rows. Correctness comes from
    // the per-ride conditional claim, so a lost lock cannot double-charge.
    const token = await this.redis.lock.acquire('job:collection-sweep', 60_000);
    if (!token) {
      logger.info('Collection sweep lock held by another process');
      return report;
    }
    try {
      const due = await this.findDue(now);
      for (const ride of due) {
        report.scanned++;
        const result = await this.rideCollectionService.collect(ride.id);
        if (result === 'COLLECTED') report.collected++;
        else if (result === 'RETRYING') report.retried++;
        else if (result === 'RECEIVABLE') report.receivable++;
      }
      // BD-6. One job rather than two, because both halves scan the same rows:
      // rides that completed and are still owed.
      for (const ride of await this.findUnconfirmedCash(now)) {
        report.scanned++;
        if (
          (await this.rideCollectionService.confirmCash(ride.id, { automatic: true })) ===
          'COLLECTED'
        ) {
          report.cashResolved++;
        }
      }
    } finally {
      await this.redis.lock.release('job:collection-sweep', token);
    }
    return report;
  }

  /// Completed, still owed, and not attempted too recently.
  ///
  /// The backoff doubles per failed attempt so a persistently declining card
  /// is not hammered every minute — with the defaults that is 5 minutes, then
  /// 10, 20, 40. Cash is excluded: it is settled at completion while BD-5's
  /// flag is off, and waits on a driver rather than on this job when it is on.
  private async findDue(now: Date): Promise<{ id: string }[]> {
    return this.db.client.$queryRaw<{ id: string }[]>`
      SELECT r."id"
      FROM "rides" r
      LEFT JOIN LATERAL (
        SELECT p."created_at", count(*) OVER () AS attempts
        FROM "ride_payments" p
        WHERE p."ride_id" = r."id" AND p."status" = 'FAILED'
        ORDER BY p."created_at" DESC
        LIMIT 1
      ) last ON true
      WHERE r."status" = 'COMPLETED'
        AND r."payment_status" = 'PENDING'
        AND r."payment_method" <> 'CASH'
        AND (
          last."created_at" IS NULL
          OR last."created_at" <= ${now}::timestamptz
            - (${paymentConfig.collectionRetryBaseSeconds}::int
               * power(2, least(last.attempts - 1, 6))) * interval '1 second'
        )
      ORDER BY r."completed_at" ASC
      LIMIT ${BATCH}
    `;
  }

  /// Cash rides nobody acknowledged in time (BD-6).
  ///
  /// Five of the six required conditions are here; the sixth — the flag — is
  /// the early return above. Every one is checked again inside
  /// `confirmCash`'s claiming transaction, because a row that matched this
  /// query can be confirmed by a driver before the loop reaches it.
  private async findUnconfirmedCash(now: Date): Promise<{ id: string }[]> {
    if (!cashConfirmationRequired()) return [];
    return this.db.client.$queryRaw<{ id: string }[]>`
      SELECT r."id"
      FROM "rides" r
      WHERE r."status" = 'COMPLETED'
        AND r."payment_method" = 'CASH'
        AND r."payment_status" = 'PENDING'
        AND r."completed_at" <= ${now}::timestamptz
          - ${paymentConfig.cashConfirmGraceSeconds}::int * interval '1 second'
        AND NOT EXISTS (
          SELECT 1 FROM "ride_payments" p
          WHERE p."ride_id" = r."id" AND p."status" = 'SUCCEEDED'
        )
      ORDER BY r."completed_at" ASC
      LIMIT ${BATCH}
    `;
  }
}
