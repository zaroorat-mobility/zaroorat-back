import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { RideMetrics } from '../metrics/ride.metrics.js';
import { RideRequestRepository } from '../repositories/ride-request.repository.js';
import { RideDispatchRepository } from '../repositories/ride-dispatch.repository.js';
import { DispatchService } from '../services/dispatch/dispatch.service.js';
import { MatchingService } from '../services/dispatch/matching.service.js';
import { logger } from '@shared/logger/index.js';
export class DispatchTimeoutJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly rideMetrics: RideMetrics,
    private readonly requestRepo: RideRequestRepository,
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly dispatchService: DispatchService,
    private readonly matchingService: MatchingService,
  ) {}
  async run(): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:dispatch_timeout', 15000);
    if (!lockToken) return 0;
    let expiredCount = 0;
    try {
      const now = new Date();
      const timedOutDispatches = await this.db.client.rideDispatch.findMany({
        where: {
          response: 'PENDING',
          expiresAt: { lte: now },
        },
      });
      for (const dispatch of timedOutDispatches) {
        await this.db.client.rideDispatch.update({
          where: { id: dispatch.id },
          data: {
            response: 'TIMEOUT',
            respondedAt: now,
          },
        });
        expiredCount++;
        this.rideMetrics.dispatchTimeout({ dispatchId: dispatch.id, driverId: dispatch.driverId });
        await this.retryNextCandidate(dispatch.requestId, dispatch.dispatchRound);
      }
    } catch (err) {
      logger.error({ err }, 'Error running dispatch timeout job');
    } finally {
      await this.redis.lock.release('job:dispatch_timeout', lockToken);
    }
    return expiredCount;
  }
  /// A timed-out offer used to just be a dead end — the request sat in
  /// SEARCHING until RequestExpiryJob eventually expired it, with exactly one
  /// driver ever having been asked. This tries the next nearest eligible
  /// candidate, excluding every driver already offered this request
  /// (accepted, rejected, cancelled, or timed out) so nobody is asked twice.
  /// RequestExpiryJob's own window (default 5 minutes) is what bounds the
  /// number of rounds — no separate cap is needed here.
  private async retryNextCandidate(requestId: string, previousRound: number): Promise<void> {
    const request = await this.requestRepo.findById(requestId);
    if (!request || !['CREATED', 'SEARCHING'].includes(request.status)) return;
    const alreadyTried = await this.dispatchRepo.findAllDriverIdsForRequest(requestId);
    const candidate = await this.matchingService.findNextEligibleCandidate(
      { latitude: Number(request.pickupLat), longitude: Number(request.pickupLng) },
      alreadyTried,
    );
    if (!candidate) {
      logger.info(
        { requestId },
        '[rides] dispatch timed out and no further eligible candidates remain',
      );
      return;
    }
    try {
      await this.dispatchService.offerToDriver({
        requestId,
        driverId: candidate.driverId,
        driverDistanceM: Math.round(candidate.distanceMeters),
        dispatchRound: previousRound + 1,
      });
    } catch (err) {
      logger.warn(
        { err, requestId, driverId: candidate.driverId },
        '[rides] failed to offer the retry candidate',
      );
    }
  }
}
