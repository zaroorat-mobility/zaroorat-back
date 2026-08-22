import { RedisService } from '@core/cache/RedisService.js';
import { EventPublisher } from '@core/events';
import { RideMetrics } from '../metrics/ride.metrics.js';
import { RideDispatchRepository } from '../repositories/ride-dispatch.repository.js';
import { DispatchService } from '../services/dispatch/dispatch.service.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../events/catalog.js';
import { logger } from '@shared/logger/index.js';

/// How many expired offers one tick will sweep. Bounds the job's runtime so a
/// backlog is worked through over several ticks rather than in one long
/// transaction-free loop holding the singleton lock.
const SWEEP_BATCH_LIMIT = 500;

export class DispatchTimeoutJob {
  constructor(
    private readonly redis: RedisService,
    private readonly rideMetrics: RideMetrics,
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly dispatchService: DispatchService,
    private readonly eventPublisher: EventPublisher,
  ) {}
  async run(): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:dispatch_timeout', 15000);
    if (!lockToken) return 0;
    let expiredCount = 0;
    try {
      const now = new Date();
      const timedOut = await this.dispatchRepo.findExpiredPending(now, SWEEP_BATCH_LIMIT);
      // One request can have several offers expiring in the same tick — that is
      // the normal case now that a round offers a batch. Collect the affected
      // requests and dispatch each exactly once, or a batch of three would kick
      // off three rounds for one customer.
      const affectedRequests = new Set<string>();
      for (const dispatch of timedOut) {
        // Conditional: a driver may have accepted or rejected between the read
        // above and now. Losing that race means the offer is no longer ours to
        // expire, and must not be counted or re-dispatched on.
        if (!(await this.dispatchRepo.respondIfPending(dispatch.id, 'TIMEOUT'))) continue;
        expiredCount++;
        this.rideMetrics.dispatchTimeout({ dispatchId: dispatch.id, driverId: dispatch.driverId });
        await this.eventPublisher.publish(
          rideEvent(RIDE_EVENT_CATALOG.DISPATCH_EXPIRED, dispatch.driverId, {
            dispatchId: dispatch.id,
            requestId: dispatch.requestId,
            driverId: dispatch.driverId,
          }),
        );
        affectedRequests.add(dispatch.requestId);
      }
      for (const requestId of affectedRequests) {
        // `dispatchNextBatch` re-reads the request and holds a per-request lock,
        // so a cancelled, expired or already-accepted request is a no-op here
        // and two overlapping ticks cannot double-dispatch.
        try {
          await this.dispatchService.dispatchNextBatch(requestId);
        } catch (err) {
          logger.warn({ err, requestId }, '[rides] failed to re-dispatch after timeout');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error running dispatch timeout job');
    } finally {
      await this.redis.lock.release('job:dispatch_timeout', lockToken);
    }
    return expiredCount;
  }
}
