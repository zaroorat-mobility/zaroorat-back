import { geoConfig, rideConfig } from '@config';
import { TransactionManager } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { EventPublisher } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { RideDispatchRepository } from '../../repositories/ride-dispatch.repository.js';
import { RideRequestRepository } from '../../repositories/ride-request.repository.js';
import { MatchingService, type MatchCandidate } from '@modules/matching/index.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';
import {
  RideOfferDriverMismatchError,
  RideOfferNotActionableError,
  RideOfferNotFoundError,
} from '../../errors/ride.errors.js';
import type { RideDispatch } from '../../types';
import type { TransactionClient } from '@core/database/TransactionManager';

/// A request is only worth dispatching while nobody has taken it and it has not
/// been abandoned or aged out.
const DISPATCHABLE_REQUEST_STATUSES = new Set(['CREATED', 'SEARCHING']);

/// The radii one dispatch round will try, in order: this round's own circle
/// first, then progressively wider ones up to the operator's maximum.
///
/// Dispatch used to pass no radius at all, so every round of every request fell
/// back to `GEO_SEARCH_RADIUS_M` and `GEO_MAX_SEARCH_RADIUS_M` was only ever a
/// validation ceiling — nothing in the codebase ever searched up to it.
///
/// Two different situations need widening and they meet here. A later round
/// starts wider because the drivers nearest the pickup have already declined.
/// And a round that finds nobody at all widens on the spot rather than
/// returning empty, because `DispatchTimeoutJob` only re-dispatches requests
/// whose offers expired: a round that made no offers is never retried, so a
/// request with nobody inside the default circle would simply age out however
/// many drivers sat just beyond it.
///
/// The maximum is load-bearing rather than tidiness — `CoordinateService`
/// throws above it, so an uncapped radius would take dispatch down instead of
/// searching wider.
function searchRadiiFrom(round: number): number[] {
  const { searchRadiusMeters: step, maxSearchRadiusMeters: max } = geoConfig;
  const radii: number[] = [];
  for (let n = Math.max(1, round); step * n < max; n++) radii.push(step * n);
  radii.push(max);
  return radii;
}

export class DispatchService {
  constructor(
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly requestRepo: RideRequestRepository,
    private readonly matchingService: MatchingService,
    private readonly redis: RedisService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly rideMetrics: RideMetrics,
  ) {}
  async offerToDriver(
    data: {
      requestId: string;
      driverId: string;
      vehicleId?: string;
      driverDistanceM?: number;
      driverEtaSeconds?: number;
      dispatchRound?: number;
    },
    tx?: TransactionClient,
  ): Promise<RideDispatch> {
    // Was hardcoded to 30s, silently ignoring `RIDE_DISPATCH_TIMEOUT_SEC`.
    const expiresAt = new Date(Date.now() + rideConfig.dispatchTimeoutSeconds * 1000);
    const offerParams = {
      requestId: data.requestId,
      driverId: data.driverId,
      dispatchRound: data.dispatchRound ?? 1,
      expiresAt,
      ...(data.vehicleId !== undefined ? { vehicleId: data.vehicleId } : {}),
      ...(data.driverDistanceM !== undefined ? { driverDistanceM: data.driverDistanceM } : {}),
      ...(data.driverEtaSeconds !== undefined ? { driverEtaSeconds: data.driverEtaSeconds } : {}),
    };
    const dispatch = await this.dispatchRepo.createOffer(offerParams, tx);
    this.rideMetrics.dispatchOffered({ requestId: data.requestId, driverId: data.driverId });
    await this.eventPublisher.publish(
      rideEvent(RIDE_EVENT_CATALOG.DISPATCH_OFFERED, data.driverId, {
        dispatchId: dispatch.id,
        requestId: data.requestId,
        driverId: data.driverId,
        expiresAt: expiresAt.toISOString(),
      }),
      tx,
    );
    return dispatch;
  }

  /// The single entry point for "offer this request to whoever is next", used
  /// by the first attempt (`RideRequestedConsumer`), a timed-out offer
  /// (`DispatchTimeoutJob`) and an explicit rejection. Those three each carried
  /// their own copy of find-candidate-then-offer before; this is that logic,
  /// once.
  ///
  /// Offers go to several drivers at a time (`RIDE_DISPATCH_BATCH_SIZE`), all in
  /// the same round, all racing for the same request — exactly one can win, and
  /// `LifecycleService.acceptRideRequest` is what decides which.
  ///
  /// Returns how many offers were actually created.
  async dispatchNextBatch(requestId: string, batchSize?: number): Promise<number> {
    // Two dispatch rounds for one request must not interleave: they would pick
    // the same nearest drivers and race on the [requestId, driverId] unique
    // index. The rounds are not inside one transaction (each offer commits on
    // its own), so the database cannot serialise them for us. Held briefly;
    // whoever loses simply skips this round rather than queueing behind it.
    const lockKey = `dispatch:request:${requestId}`;
    const lockToken = await this.redis.lock.acquire(lockKey, 10000);
    if (!lockToken) return 0;
    try {
      return await this.runDispatchRound(requestId, batchSize ?? rideConfig.dispatchBatchSize);
    } finally {
      await this.redis.lock.release(lockKey, lockToken);
    }
  }

  private async runDispatchRound(requestId: string, batchSize: number): Promise<number> {
    const request = await this.requestRepo.findById(requestId);
    if (!request) return 0;
    // Re-read rather than trust the caller: by the time a timeout job or a
    // rejection gets here the request may have been accepted by somebody else,
    // cancelled by the customer, or aged out.
    if (!DISPATCHABLE_REQUEST_STATUSES.has(request.status)) return 0;
    if (request.expiresAt && request.expiresAt <= new Date()) return 0;

    // `batchSize` is how many drivers may be *holding* an offer at once, not how
    // many to add per round. Without the difference, one driver rejecting out of
    // a batch of three would trigger three more offers on top of the two still
    // live, and a run of rejections would stack rounds until far more of the
    // city held an offer than the operator ever configured.
    const live = await this.dispatchRepo.countLiveOffers(requestId);
    const slots = batchSize - live;
    if (slots <= 0) return 0;

    const alreadyOffered = await this.dispatchRepo.findAllDriverIdsForRequest(requestId);
    const dispatchRound = (await this.dispatchRepo.highestRound(requestId)) + 1;
    const origin = { latitude: Number(request.pickupLat), longitude: Number(request.pickupLng) };
    // ponytail: the widening steps are searched one at a time, and only while
    // each comes back empty — an empty result is the cheap query. Batch them
    // into a single wide query if the extra round trips ever show up.
    let candidates: MatchCandidate[] = [];
    let searchRadiusMeters = 0;
    for (const radius of searchRadiiFrom(dispatchRound)) {
      searchRadiusMeters = radius;
      candidates = await this.matchingService.findEligibleCandidates(
        origin,
        alreadyOffered,
        slots,
        request.vehicleTypeId,
        radius,
      );
      if (candidates.length > 0) break;
    }
    if (candidates.length === 0) {
      logger.info(
        { requestId, alreadyOffered: alreadyOffered.length, dispatchRound, searchRadiusMeters },
        '[rides] no further eligible driver candidates for this request',
      );
      return 0;
    }

    let offered = 0;
    for (const candidate of candidates) {
      try {
        await this.offerToDriver({
          requestId,
          driverId: candidate.driverId,
          driverDistanceM: Math.round(candidate.distanceMeters),
          dispatchRound,
        });
        offered++;
      } catch (err) {
        // Most likely the [requestId, driverId] unique index rejecting a driver
        // another round already offered — the backstop behind the lock above.
        logger.warn(
          { err, requestId, driverId: candidate.driverId },
          '[rides] failed to offer a dispatch candidate',
        );
      }
    }
    if (offered > 0 && request.status === 'CREATED') {
      await this.requestRepo.updateStatus(requestId, 'SEARCHING');
    }
    return offered;
  }

  /// A driver saying "no" explicitly. Before this existed the enum value,
  /// `reject_reason` column and `ride.dispatch.rejected` event were all present
  /// and unreachable: a driver's only way to decline was to let the offer age
  /// out, costing the customer a full timeout window per uninterested driver.
  ///
  /// Idempotent: rejecting an already-rejected offer returns it unchanged rather
  /// than erroring, so a retried request from a flaky mobile connection is safe.
  async rejectOffer(input: {
    dispatchId: string;
    driverId: string;
    reason?: string;
  }): Promise<RideDispatch> {
    const outcome = await this.txManager.execute(async (tx) => {
      const offer = await this.dispatchRepo.lockForUpdate(input.dispatchId, tx);
      if (!offer) throw new RideOfferNotFoundError(input.dispatchId);
      if (offer.driverId !== input.driverId) {
        throw new RideOfferDriverMismatchError(input.dispatchId);
      }
      if (offer.response === 'REJECTED') return { offer, changed: false };
      if (offer.response !== 'PENDING') {
        // ACCEPTED, CANCELLED (another driver won) or TIMEOUT — the decision has
        // already been made and must not be overwritten.
        throw new RideOfferNotActionableError(offer.response);
      }
      // An offer past `expiresAt` that the timeout job has not swept yet is
      // still rejectable: the driver's explicit answer is better information
      // than a job that has not run, and either way the driver ends up excluded.
      if (!(await this.dispatchRepo.respondIfPending(offer.id, 'REJECTED', input.reason, tx))) {
        throw new RideOfferNotActionableError(offer.response);
      }
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.DISPATCH_REJECTED, input.driverId, {
          dispatchId: offer.id,
          requestId: offer.requestId,
          driverId: input.driverId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        }),
        tx,
      );
      return { offer, changed: true };
    });

    if (outcome.changed) {
      this.rideMetrics.dispatchRejected({
        dispatchId: outcome.offer.id,
        driverId: input.driverId,
      });
      // The whole point of an explicit reject: the next drivers are asked now,
      // not up to a minute later when the timeout job next runs. A failure to
      // find anyone must not fail the driver's rejection, which has committed.
      await this.dispatchNextBatch(outcome.offer.requestId).catch((err: unknown) => {
        logger.warn(
          { err, requestId: outcome.offer.requestId },
          '[rides] rejection could not immediately re-dispatch',
        );
      });
      return { ...outcome.offer, response: 'REJECTED', respondedAt: new Date() };
    }
    return outcome.offer;
  }
}
