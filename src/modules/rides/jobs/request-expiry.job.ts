import { DatabaseService } from '@core/database';
import { TransactionManager } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { EventPublisher } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../events/catalog.js';

/// Ages out ride requests nobody accepted, and — this is the part that was
/// missing — tells the rider it happened.
///
/// The job used to flip the row to EXPIRED and stop there. It published nothing,
/// so no push and no socket message was ever sent for it, and a customer whose
/// request found no driver sat on "searching for a driver" until they gave up
/// and closed the app. Every other terminal outcome in the ride lifecycle
/// announces itself; this one was silent.
export class RequestExpiryJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}
  async run(): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:request_expiry', 15000);
    if (!lockToken) return 0;
    let expiredCount = 0;
    try {
      const now = new Date();
      const expiredRequests = await this.db.client.rideRequest.findMany({
        where: {
          status: { in: ['CREATED', 'SEARCHING'] },
          expiresAt: { lte: now },
        },
      });
      for (const request of expiredRequests) {
        if (await this.expire(request.id, request.customerId)) expiredCount++;
      }
    } catch (err) {
      logger.error({ err }, 'Error running request expiry job');
    } finally {
      await this.redis.lock.release('job:request_expiry', lockToken);
    }
    return expiredCount;
  }

  /// One request, in one transaction, announced exactly once.
  ///
  /// The status write is a conditional claim rather than a plain update: the
  /// Redis lock above is not the correctness boundary here any more than it is
  /// anywhere else in this codebase, and a driver accepting between the read
  /// and the write would otherwise have their MATCHED request stamped back to
  /// EXPIRED — and the rider told their search failed for a ride that had just
  /// been assigned. `count === 1` decides, and only the winner publishes.
  ///
  /// That window is deliberately not covered by a test: staging it needs the
  /// accept to land between this method's read and its write, which the
  /// integration harness cannot interleave. The suite covers the read filter
  /// either side of it; this is the guard for what happens in between.
  ///
  /// The event goes through the outbox inside the same transaction, so it
  /// cannot announce an expiry that rolled back, and it survives this process
  /// dying between the write and the send.
  private async expire(requestId: string, customerId: string): Promise<boolean> {
    try {
      return await this.txManager.execute(async (tx) => {
        const { count } = await tx.rideRequest.updateMany({
          where: { id: requestId, status: { in: ['CREATED', 'SEARCHING'] } },
          data: { status: 'EXPIRED' },
        });
        if (count !== 1) return false;
        await this.eventPublisher.publish(
          rideEvent(RIDE_EVENT_CATALOG.REQUEST_EXPIRED, customerId, { requestId, customerId }),
          tx,
        );
        return true;
      });
    } catch (err) {
      // One request that will not expire must not stop the rest of the batch;
      // the next tick picks it up again because its status is unchanged.
      logger.error({ err, requestId }, '[rides] failed to expire a ride request');
      return false;
    }
  }
}
