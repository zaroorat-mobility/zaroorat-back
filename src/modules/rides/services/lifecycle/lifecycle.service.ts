import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { RideRepository } from '../../repositories/ride.repository.js';
import { RideRequestRepository } from '../../repositories/ride-request.repository.js';
import { RideStatusEventRepository } from '../../repositories/ride-status-event.repository.js';
import { RideDispatchRepository } from '../../repositories/ride-dispatch.repository.js';
import { RideOtpService } from '../otp/ride-otp.service.js';
import { PricingService } from '@modules/pricing';
import { PromotionService } from '@modules/promotions';
import { CancellationService } from '../cancellation/cancellation.service.js';
import { RideFareRepository } from '../../repositories/ride-fare.repository.js';
import { DriverStatusRepository } from '@modules/drivers/repositories/driver-status.repository.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { UserRepository } from '@modules/auth/repositories/user.repository.js';
import { NotificationService } from '@modules/notifications';
import { VehicleRepository } from '@modules/vehicles/repositories/vehicle.repository.js';
import { VehicleEligibilityService } from '@modules/vehicles/services/vehicle-eligibility.service.js';
import { VehicleAssignmentRepository } from '@modules/vehicles/repositories/vehicle-assignment.repository.js';
import { cashConfirmationRequired } from '@config';
import { logger } from '@shared/logger/index.js';
import {
  InvalidRideStateTransitionError,
  RideNotFoundError,
  RideRequestAlreadyMatchedError,
  RideDriverMismatchError,
  RideCustomerMismatchError,
  RideActorRequiredError,
  DriverNotAvailableError,
  VehicleMismatchError,
  ImplausibleTripDataError,
  RideOfferNotFoundError,
  RideOfferNotActionableError,
  SelfRideNotAllowedError,
} from '../../errors/ride.errors.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import {
  TRIP_DISTANCE_PLAUSIBILITY_MULTIPLIER,
  TRIP_DISTANCE_PLAUSIBILITY_BUFFER_KM,
  TRIP_DURATION_PLAUSIBILITY_MULTIPLIER,
  TRIP_DURATION_PLAUSIBILITY_BUFFER_MIN,
} from '../../constants/ride.constants.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';
import { RedisService } from '@core/cache/RedisService.js';
import { LedgerService } from '@modules/payments/services/ledger/ledger.service.js';
import type { Ride, RideRequest, RideStatus } from '../../types';
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  ACCEPTED: [
    'DRIVER_ARRIVING',
    'DRIVER_ARRIVED',
    'CANCELLED_BY_CUSTOMER',
    'CANCELLED_BY_DRIVER',
    'CANCELLED_BY_SYSTEM',
  ],
  DRIVER_ARRIVING: [
    'DRIVER_ARRIVED',
    'CANCELLED_BY_CUSTOMER',
    'CANCELLED_BY_DRIVER',
    'CANCELLED_BY_SYSTEM',
  ],
  DRIVER_ARRIVED: [
    'IN_PROGRESS',
    'CANCELLED_BY_CUSTOMER',
    'CANCELLED_BY_DRIVER',
    'CANCELLED_BY_SYSTEM',
  ],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED_BY_SYSTEM'],
  COMPLETED: [],
  CANCELLED_BY_CUSTOMER: [],
  CANCELLED_BY_DRIVER: [],
  CANCELLED_BY_SYSTEM: [],
  NO_DRIVERS_FOUND: [],
};
function requireActor(actorId: string | undefined, cancelledBy: string): string {
  if (!actorId) {
    throw new RideActorRequiredError(cancelledBy);
  }
  return actorId;
}
export class LifecycleService {
  constructor(
    private readonly rideRepo: RideRepository,
    private readonly requestRepo: RideRequestRepository,
    private readonly statusEventRepo: RideStatusEventRepository,
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly rideOtpService: RideOtpService,
    private readonly pricingService: PricingService,
    private readonly promotionService: PromotionService,
    private readonly fareRepo: RideFareRepository,
    private readonly cancellationService: CancellationService,
    private readonly ledgerService: LedgerService,
    private readonly driverStatusRepository: DriverStatusRepository,
    private readonly driverRepository: DriverRepository,
    private readonly userRepository: UserRepository,
    private readonly notificationService: NotificationService,
    private readonly vehicleRepository: VehicleRepository,
    private readonly vehicleAssignmentRepository: VehicleAssignmentRepository,
    private readonly vehicleEligibilityService: VehicleEligibilityService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly rideMetrics: RideMetrics,
    private readonly redisService: RedisService,
  ) {}
  validateTransition(fromState: string, toState: string): void {
    const allowed = ALLOWED_TRANSITIONS[fromState] ?? [];
    if (!allowed.includes(toState)) {
      throw new InvalidRideStateTransitionError(fromState, toState);
    }
  }
  private async lockAndValidate(
    rideId: string,
    actor:
      | {
          kind: 'driver';
          driverId: string;
        }
      | {
          kind: 'customer';
          userId: string;
        }
      | {
          kind: 'system';
        },
    toStatus: RideStatus,
    tx: TransactionClient,
  ): Promise<Ride> {
    const ride = await this.rideRepo.lockForUpdate(rideId, tx);
    if (!ride) throw new RideNotFoundError(rideId);
    if (actor.kind === 'driver' && ride.driverId !== actor.driverId) {
      throw new RideDriverMismatchError(rideId);
    }
    if (actor.kind === 'customer' && ride.customerId !== actor.userId) {
      throw new RideCustomerMismatchError(rideId);
    }
    this.validateTransition(ride.status, toStatus);
    return ride;
  }
  /// The one place a client-supplied `vehicleId` is checked against anything
  /// at all beyond "does this row exist" (the DB foreign key). Before the
  /// vehicles module existed there was nothing to check it against — a driver
  /// could accept with any vehicle id in the table, owned by anyone, of any
  /// category.
  ///
  /// Ownership and category matching stay here because they are ride-request
  /// facts. Everything about whether the vehicle is fit to operate at all —
  /// active, verified, papers in order — is delegated to
  /// `VehicleEligibilityService`, the same implementation the go-online gate
  /// uses, so the two paths cannot drift apart.
  private async assertVehicleEligible(
    vehicleId: string,
    driverId: string,
    requestedVehicleTypeId: string,
    tx: TransactionClient,
  ): Promise<void> {
    const vehicle = await this.vehicleRepository.findById(vehicleId, tx);
    if (!vehicle) {
      throw new VehicleMismatchError('Vehicle does not exist or is not active');
    }
    if (vehicle.currentDriverId !== driverId) {
      throw new VehicleMismatchError('This vehicle is not currently assigned to you');
    }
    // `currentDriverId` is a denormalised pointer; the assignment ledger is the
    // record of account. An assignment released without the pointer being
    // cleared would otherwise still pass the check above.
    const assignment = await this.vehicleAssignmentRepository.findActiveForDriver(driverId, tx);
    if (!assignment || assignment.vehicleId !== vehicleId) {
      throw new VehicleMismatchError('This vehicle is not currently assigned to you');
    }
    if (vehicle.vehicleTypeId !== requestedVehicleTypeId) {
      throw new VehicleMismatchError("This vehicle's category does not match the ride request");
    }
    this.vehicleEligibilityService.assertEligibility(
      await this.vehicleEligibilityService.checkVehicle(vehicle, tx),
    );
  }
  /// Accepting a request used to consult the request row and nothing else: the
  /// dispatch offer was written, notified on, timed out and resolved, but never
  /// actually *checked*. Any online driver could accept any request they had
  /// never been offered, and a driver whose offer had timed out, been rejected,
  /// or been cancelled because somebody else won could still accept it — the
  /// request's own status was the only thing standing in the way.
  ///
  /// The row is locked, not merely read, so this serialises against the timeout
  /// job and against the driver's own reject.
  private async assertOfferActionable(
    requestId: string,
    driverId: string,
    tx: TransactionClient,
  ): Promise<void> {
    const offer = await this.dispatchRepo.lockActionableOffer(requestId, driverId, tx);
    if (!offer) throw new RideOfferNotFoundError(requestId);
    if (offer.response !== 'PENDING') {
      throw new RideOfferNotActionableError(offer.response);
    }
    if (offer.expiresAt && offer.expiresAt <= new Date()) {
      // Expired but not yet swept by DispatchTimeoutJob. The window is what
      // decides, not whether a cron has caught up with it.
      throw new RideOfferNotActionableError(offer.response, true);
    }
  }
  /// Not a GPS cross-check — no trip location trail is persisted anywhere in
  /// this codebase. `DriverLocation` holds only a driver's current position,
  /// overwritten on every update, and `driver_location_history` does not exist:
  /// no migration creates it and `to_regclass` returns null, so the schema
  /// comment naming it describes a table that was never built. The one real
  /// reference point that does exist is the quote this ride was requested
  /// against — a driver submitting actuals wildly beyond it is rejected rather
  /// than trusted.
  ///
  /// Duration no longer relies on this bound at all: it is measured from the
  /// server's own clocks (see `measuredDurationMin`). Distance still does.
  private assertPlausibleTripData(
    request: RideRequest | null,
    actualDistanceKm: number,
    actualDurationMin: number,
    rideId: string,
    billedDistanceKm: number,
    billedDurationMin: number,
  ): void {
    // `!= null`, not truthiness. `estimatedDistanceKm` is a nullable
    // `Decimal(8,2)`: a Prisma Decimal is an object and therefore always truthy,
    // so the old test happened to work — but the moment that column is read as a
    // plain number, a legitimate estimate of 0 would be falsy and silently
    // disable the only bound on a driver-declared distance. A guard that can be
    // switched off by a valid value is not a guard.
    const estimatedDistanceKm =
      request?.estimatedDistanceKm != null ? Number(request.estimatedDistanceKm) : null;
    const estimatedDurationMin = request?.estimatedDurationMin ?? null;
    if (estimatedDistanceKm == null || estimatedDurationMin == null) {
      // Not fatal: the driver has finished driving and a completion must not be
      // refused over missing reference data (FR-014). But distance is still
      // whatever the driver's client declared (C-3b), and this bound is the only
      // thing standing over it — so a ride billed without it should be visible
      // rather than silently unguarded.
      logger.warn(
        {
          rideId,
          requestId: request?.id ?? null,
          hasDistanceEstimate: estimatedDistanceKm != null,
          hasDurationEstimate: estimatedDurationMin != null,
        },
        '[rides] completing a ride with no quoted estimate to check the reported trip against',
      );
    }
    // Measured against what the server itself believes the trip was, not
    // against the quote alone. Both billed figures are server-derived — the
    // distance from the trip meter (C-3b), the duration from the server's own
    // clocks (C-3a) — and either can legitimately exceed the quote when a
    // driver is sent the long way round. Bounding a driver's report by the
    // quote alone refused those completions, and refused them for a number
    // that no longer decides anybody's fare: the driver had finished driving
    // and could not close the ride.
    //
    // Still bounded, and still refuses a claim the server has no support for
    // at all. The reference is only ever raised by the server's own
    // measurement, never by anything the client sent.
    if (estimatedDistanceKm != null) {
      const referenceKm = Math.max(estimatedDistanceKm, billedDistanceKm);
      const maxPlausibleKm =
        referenceKm * TRIP_DISTANCE_PLAUSIBILITY_MULTIPLIER + TRIP_DISTANCE_PLAUSIBILITY_BUFFER_KM;
      if (actualDistanceKm > maxPlausibleKm) {
        throw new ImplausibleTripDataError(
          `Reported distance (${actualDistanceKm}km) is far beyond the trip the server measured (${referenceKm}km)`,
        );
      }
    }
    if (estimatedDurationMin != null) {
      const referenceMin = Math.max(estimatedDurationMin, billedDurationMin);
      const maxPlausibleMin =
        referenceMin * TRIP_DURATION_PLAUSIBILITY_MULTIPLIER +
        TRIP_DURATION_PLAUSIBILITY_BUFFER_MIN;
      if (actualDurationMin > maxPlausibleMin) {
        throw new ImplausibleTripDataError(
          `Reported duration (${actualDurationMin}min) is far beyond the trip the server measured (${referenceMin}min)`,
        );
      }
    }
  }
  /// Trip duration, measured rather than declared.
  ///
  /// `startedAt` is stamped by `startRide` and `completedAt` by `completeRide`,
  /// both from the server's clock, so elapsed time is a fact the platform
  /// already owns — it never had to ask the driver's phone for it. It did ask:
  /// `actualDurationMin` came off the request body and went straight into the
  /// fare, so a client reporting four times the real duration was paid for four
  /// times the real duration, bounded only by `assertPlausibleTripData`.
  ///
  /// The declared value is still accepted and still cross-checked against the
  /// quote. It simply no longer decides what anybody is billed.
  private measuredDurationMin(ride: Ride, completedAt: Date, quotedMin: number | null): number {
    if (!ride.startedAt) {
      // Unreachable while IN_PROGRESS is only entered through `startRide`,
      // which stamps `startedAt` inside the same conditional claim that sets
      // the status. Falling back to the quote rather than to the client's
      // figure keeps the billed number server-derived even if that invariant is
      // ever broken.
      logger.warn(
        { rideId: ride.id },
        '[rides] completed ride had no startedAt; billing the quoted duration',
      );
      return quotedMin ?? 0;
    }
    const elapsedMs = completedAt.getTime() - ride.startedAt.getTime();
    return Math.max(0, Math.round(elapsedMs / 60_000));
  }

  async acceptRideRequest(data: {
    requestId: string;
    driverId: string;
    vehicleId: string;
  }): Promise<{
    ride: Ride;
    plaintextOtp: string;
  }> {
    const result = await this.txManager.execute(async (tx) => {
      const request = await this.requestRepo.lockForUpdate(data.requestId, tx);
      if (!request) throw new RideNotFoundError(data.requestId);
      await this.assertOfferActionable(data.requestId, data.driverId, tx);
      // A driver must not accept a request they booked themselves. Nothing
      // upstream stops it: `ensureDefaultRole` grants the `customer` role to
      // every phone login, drivers included, so no role gate on the booking
      // route can tell the two apart — and dispatch ranks an online driver's own
      // record as the nearest candidate to their own pickup point, so the offer
      // arrives unprompted. The result is a ride, a fare, a driver earning and a
      // commission entry for a journey nobody took. Checked here rather than in
      // matching because this is where a ride is actually created: every path
      // that mints one — first offer, timeout redispatch, rejection redispatch —
      // comes through this transaction.
      const acceptingDriver = await this.driverRepository.findById(data.driverId, tx);
      if (!acceptingDriver) throw new DriverNotAvailableError('Driver record not found');
      if (acceptingDriver.userId === request.customerId) throw new SelfRideNotAllowedError();
      const existingDriverRide = await this.rideRepo.findActiveByDriver(data.driverId, tx);
      if (existingDriverRide) {
        throw new DriverNotAvailableError('Driver already has an active ride in progress');
      }
      // A driver who went offline after the offer landed is no longer a driver
      // dispatch would have picked; re-checked here because an offer's window
      // outlives the decision that created it.
      const status = await this.driverStatusRepository.getStatus(data.driverId, tx);
      if (status?.status !== 'ONLINE') {
        throw new DriverNotAvailableError('You must be online to accept a ride');
      }
      await this.assertVehicleEligible(data.vehicleId, data.driverId, request.vehicleTypeId, tx);
      if (!(await this.requestRepo.claimForMatch(data.requestId, tx))) {
        throw new RideRequestAlreadyMatchedError(data.requestId);
      }
      const ride = await this.rideRepo.create(
        {
          requestId: request.id,
          customerId: request.customerId,
          driverId: data.driverId,
          vehicleId: data.vehicleId,
          vehicleTypeId: request.vehicleTypeId,
          paymentMethod: (request.paymentMethod as Ride['paymentMethod']) ?? 'CASH',
          pickupLat: request.pickupLat,
          pickupLng: request.pickupLng,
          pickupAddress: request.pickupAddress,
          dropLat: request.dropLat,
          dropLng: request.dropLng,
          dropAddress: request.dropAddress,
        },
        tx,
      );
      const { plaintextOtp } = await this.rideOtpService.generateStartOtp(ride.id, tx);
      await this.dispatchRepo.resolveOffers(request.id, data.driverId, tx);
      await this.driverStatusRepository.updateStatus(data.driverId, 'ON_TRIP', {}, tx);
      await this.statusEventRepo.record(
        {
          rideId: ride.id,
          fromStatus: null,
          toStatus: 'ACCEPTED',
          actorType: 'DRIVER',
          actorId: data.driverId,
        },
        tx,
      );
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.ACCEPTED, request.customerId, {
          rideId: ride.id,
          driverId: data.driverId,
        }),
        tx,
      );
      return { ride, plaintextOtp };
    });
    await this.deliverStartOtpToCustomer(
      result.ride.customerId,
      result.ride.id,
      result.plaintextOtp,
    );
    return result;
  }
  /// The driver is the one who types the OTP; the customer is the one who
  /// must actually receive it to read aloud. Delivered after commit — a slow
  /// or failed SMS send must never roll back an already-successful accept,
  /// and this is the only channel that currently exists (see the platform
  /// audit's P0 finding: no push/socket delivery exists yet).
  private async deliverStartOtpToCustomer(
    customerId: string,
    rideId: string,
    plaintextOtp: string,
  ): Promise<void> {
    try {
      const customer = await this.userRepository.findById(customerId);
      if (!customer) return;
      await this.notificationService.sendSms(
        customer.phoneNumber,
        `Zaroorat: Share this code with your driver to start the trip: ${plaintextOtp}. Do not share it before your driver has arrived.`,
      );
    } catch (err) {
      logger.warn({ err, rideId }, '[rides] failed to deliver start OTP to customer');
    }
  }
  /// `DRIVER_ARRIVING` was in the `RideStatus` enum and in the transition table
  /// from the start, but nothing could ever reach it: a ride went straight from
  /// ACCEPTED to DRIVER_ARRIVED, so "driver is on the way" was a state the
  /// customer app had no way to be told about. This is the transition into it.
  async markDriverArriving(rideId: string, driverId: string): Promise<Ride> {
    return this.txManager.execute(async (tx) => {
      const ride = await this.lockAndValidate(
        rideId,
        { kind: 'driver', driverId },
        'DRIVER_ARRIVING',
        tx,
      );
      if (!(await this.rideRepo.updateStatusIf(rideId, ride.status, 'DRIVER_ARRIVING', {}, tx))) {
        throw new InvalidRideStateTransitionError(ride.status, 'DRIVER_ARRIVING');
      }
      await this.statusEventRepo.record(
        {
          rideId,
          fromStatus: ride.status,
          toStatus: 'DRIVER_ARRIVING',
          actorType: 'DRIVER',
          actorId: driverId,
        },
        tx,
      );
      this.rideMetrics.driverArriving({ rideId });
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.DRIVER_ARRIVING, ride.customerId, { rideId, driverId }),
        tx,
      );
      return { ...ride, status: 'DRIVER_ARRIVING' as RideStatus };
    });
  }
  async markDriverArrived(rideId: string, driverId: string): Promise<Ride> {
    return this.txManager.execute(async (tx) => {
      const ride = await this.lockAndValidate(
        rideId,
        { kind: 'driver', driverId },
        'DRIVER_ARRIVED',
        tx,
      );
      const arrivedAt = new Date();
      if (
        !(await this.rideRepo.updateStatusIf(
          rideId,
          ride.status,
          'DRIVER_ARRIVED',
          { arrivedAt },
          tx,
        ))
      ) {
        throw new InvalidRideStateTransitionError(ride.status, 'DRIVER_ARRIVED');
      }
      await this.statusEventRepo.record(
        {
          rideId,
          fromStatus: ride.status,
          toStatus: 'DRIVER_ARRIVED',
          actorType: 'DRIVER',
          actorId: driverId,
        },
        tx,
      );
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.DRIVER_ARRIVED, ride.customerId, { rideId, driverId }),
        tx,
      );
      return { ...ride, status: 'DRIVER_ARRIVED' as RideStatus, arrivedAt };
    });
  }
  async startRide(rideId: string, driverId: string, otpCode: string): Promise<Ride> {
    const started = await this.txManager.execute(async (tx) => {
      const ride = await this.lockAndValidate(
        rideId,
        { kind: 'driver', driverId },
        'IN_PROGRESS',
        tx,
      );
      await this.rideOtpService.verifyStartOtp(rideId, otpCode, tx);
      const startedAt = new Date();
      if (
        !(await this.rideRepo.updateStatusIf(rideId, ride.status, 'IN_PROGRESS', { startedAt }, tx))
      ) {
        throw new InvalidRideStateTransitionError(ride.status, 'IN_PROGRESS');
      }
      await this.statusEventRepo.record(
        {
          rideId,
          fromStatus: ride.status,
          toStatus: 'IN_PROGRESS',
          actorType: 'DRIVER',
          actorId: driverId,
        },
        tx,
      );
      this.rideMetrics.rideStarted({ rideId });
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.STARTED, ride.customerId, { rideId, driverId }),
        tx,
      );
      return { ...ride, status: 'IN_PROGRESS' as RideStatus, startedAt };
    });
    // Outside the transaction: Redis does not roll back with it, and a counter
    // zeroed for a start that never committed would only ever discard distance
    // from before the trip. Anything accumulated from here to `completeRide` is
    // this trip.
    await this.resetTripMeter(driverId);
    return started;
  }

  /// Never allowed to fail a lifecycle transition. A meter that would not clear
  /// leaves the previous trip's distance in place, and `max(measured, quoted)`
  /// is what stops that becoming a fare nobody drove — see `billedDistanceKm`.
  private async resetTripMeter(driverId: string): Promise<void> {
    try {
      await this.redisService.tripDistance.reset(driverId);
    } catch (err) {
      logger.warn({ err, driverId }, '[rides] could not reset the trip distance meter');
    }
  }

  /// What the ride is actually billed for.
  ///
  /// `actualDistanceKm` arrives in the completion request from the driver's own
  /// app, and billing on it made the client the authority on the fare: a
  /// modified app could name its own price. The server now adds the journey up
  /// itself from the location fixes it already receives (`accrueTripDistance`),
  /// and bills the greater of that and the distance the customer was quoted.
  ///
  /// The greater, rather than the measured figure alone, because the fixes are
  /// best-effort: a driver through a tunnel, on a dead battery or with the app
  /// backgrounded produces a gappy trail that *under*-counts, and the quote is
  /// the floor that stops a real journey being billed as a short one. It also
  /// makes the Redis counter safe to lose — losing it bills the quote, which is
  /// the price the customer already agreed to.
  ///
  /// A detour longer than the quote is still paid for, because a measurement
  /// above the quote wins.
  private async billedDistanceKm(driverId: string, quotedKm: number | null): Promise<number> {
    let measuredKm = 0;
    try {
      measuredKm = await this.redisService.tripDistance.read(driverId);
    } catch (err) {
      logger.warn({ err, driverId }, '[rides] could not read the trip distance meter');
    }
    return Math.max(measuredKm, quotedKm ?? 0);
  }
  async completeRide(
    rideId: string,
    driverId: string,
    actualDistanceKm: number,
    actualDurationMin: number,
  ): Promise<Ride> {
    const completed = await this.txManager.execute(async (tx) => {
      const ride = await this.lockAndValidate(
        rideId,
        { kind: 'driver', driverId },
        'COMPLETED',
        tx,
      );
      const request = await this.requestRepo.findById(ride.requestId, tx);
      const completedAt = new Date();
      // C-3b. `actualDistanceKm` is still checked for plausibility below, but it
      // no longer decides the fare: the server bills what it measured, floored
      // at what the customer was quoted.
      const quotedDistanceKm =
        request?.estimatedDistanceKm != null ? Number(request.estimatedDistanceKm) : null;
      const billedDistanceKm = await this.billedDistanceKm(driverId, quotedDistanceKm);
      const billedDurationMin = this.measuredDurationMin(
        ride,
        completedAt,
        request?.estimatedDurationMin ?? null,
      );
      // After the server has worked out its own figures, so the bound can be
      // measured against the trip that actually happened rather than against
      // the quote alone.
      this.assertPlausibleTripData(
        request,
        actualDistanceKm,
        actualDurationMin,
        rideId,
        billedDistanceKm,
        billedDurationMin,
      );
      if (Math.abs(billedDistanceKm - actualDistanceKm) > 1) {
        logger.info(
          { rideId, driverId, billedDistanceKm, claimedDistanceKm: actualDistanceKm },
          '[rides] billing a measured distance that differs from the one the app reported',
        );
      }
      const waitingMinutes = ride.waitTimeMin ?? 0;

      // FR-001/FR-002. The rule the customer was quoted and booked on. Null only
      // for requests written before the column existed, where `calculateFinalFare`
      // falls back to live resolution.
      const pricingRuleId = request?.pricingRuleId ?? null;

      let discountAmount = 0;
      let resolvedPromo: Awaited<ReturnType<PromotionService['validateAndResolve']>> | null = null;
      if (request?.promoCode) {
        // The preview needs the booked rule as much as the final fare does: it
        // is the subtotal a promotion's `minFare` eligibility and percentage
        // discount are computed against, so pricing it on the GLOBAL default
        // card while billing on the zone card applied the discount to a number
        // the customer was never charged.
        const preview = await this.pricingService.calculateFinalFare({
          actualDistanceKm,
          actualDurationMin,
          vehicleTypeId: ride.vehicleTypeId,
          pricingRuleId,
          waitingMinutes,
        });
        try {
          resolvedPromo = await this.promotionService.validateAndResolve(
            request.promoCode,
            {
              userId: ride.customerId,
              vehicleTypeId: ride.vehicleTypeId,
              subtotal: preview.subtotal,
            },
            tx,
          );
          discountAmount = resolvedPromo.discountAmount;
        } catch {
          // Promo may have expired between request and completion — complete without discount.
          discountAmount = 0;
          resolvedPromo = null;
        }
      }

      const surgeMultiplier = Number(request?.surgeMultiplier ?? 1);
      const itemizedFare = await this.pricingService.calculateFinalFare({
        actualDistanceKm: billedDistanceKm,
        actualDurationMin: billedDurationMin,
        vehicleTypeId: ride.vehicleTypeId,
        pricingRuleId,
        surgeMultiplier,
        waitingMinutes,
        ...(discountAmount > 0 ? { discountAmount } : {}),
      });
      // BD-5. With the flag off this is byte-identical to before: a cash ride
      // is PAID the moment it ends. With it on, cash waits for someone to say
      // the money changed hands, so it completes PENDING like every other
      // method and `RideCollectionService` resolves it.
      const cashSettlesHere = ride.paymentMethod === 'CASH' && !cashConfirmationRequired();
      const paymentStatus = cashSettlesHere ? 'PAID' : 'PENDING';
      if (
        !(await this.rideRepo.updateStatusIf(
          rideId,
          ride.status,
          'COMPLETED',
          {
            completedAt,
            actualDistanceKm: new Decimal(billedDistanceKm),
            actualDurationMin: billedDurationMin,
            paymentStatus,
          },
          tx,
        ))
      ) {
        throw new InvalidRideStateTransitionError(ride.status, 'COMPLETED');
      }
      await this.fareRepo.create(
        {
          rideId,
          baseFare: new Decimal(itemizedFare.baseFare),
          distanceFare: new Decimal(itemizedFare.distanceFare),
          timeFare: new Decimal(itemizedFare.timeFare),
          waitingCharge: new Decimal(itemizedFare.waitingCharge),
          surgeMultiplier: new Decimal(itemizedFare.surgeMultiplier),
          surgeAmount: new Decimal(itemizedFare.surgeAmount),
          subtotal: new Decimal(itemizedFare.subtotal),
          discountAmount: new Decimal(itemizedFare.discountAmount),
          taxAmount: new Decimal(itemizedFare.taxAmount),
          platformFee: new Decimal(itemizedFare.platformFee),
          totalFare: new Decimal(itemizedFare.totalFare),
          driverEarning: new Decimal(itemizedFare.driverEarning),
          platformCommission: new Decimal(itemizedFare.platformCommission),
        },
        tx,
      );

      if (resolvedPromo && resolvedPromo.discountAmount > 0) {
        await this.promotionService.redeem({
          promo: resolvedPromo,
          userId: ride.customerId,
          rideId,
          client: tx,
        });
      }
      // Cash only (transition 4c). A cash ride is paid the moment it ends —
      // the driver is holding the money — so its commission group is
      // recognised here, in the completion transaction, exactly as before.
      //
      // Every other method now posts nothing at completion. The ledger used to
      // record a wallet debit, driver earnings and platform commission for a
      // ride nobody had paid for yet, asserting a payment that had not
      // happened (FR-038). `RideCollectionService` posts that group when the
      // money actually moves.
      if (cashSettlesHere) {
        await this.ledgerService.recordTripPayment(
          {
            totalFare: new Decimal(itemizedFare.totalFare),
            driverPayable: new Decimal(itemizedFare.driverEarning),
            driverEarning: new Decimal(itemizedFare.driverEarning),
            platformCommission: new Decimal(itemizedFare.platformCommission),
            // FR-006. Tax and the platform fee are now distinct destinations
            // rather than amounts swallowed by the commission line.
            taxAmount: new Decimal(itemizedFare.taxAmount),
            platformFee: new Decimal(itemizedFare.platformFee),
            customerUserId: ride.customerId,
            driverId: ride.driverId,
            rideId,
            paymentMethod: ride.paymentMethod,
          },
          tx,
        );
      }
      // Behind the conditional claim above, so only the completion that
      // actually won counts. `totalEarnings` is left alone on purpose: the
      // settlement pipeline owns what a driver has earned, and adding to it
      // here would double-count against `DriverSettlement` and the wallet. The
      // acceptance, completion and cancellation rates are left alone too —
      // each needs a window (lifetime? rolling 30 days?) that is a product
      // decision, not something to invent inside a completion.
      await this.driverRepository.recordCompletedRide(driverId, actualDistanceKm, completedAt, tx);
      await this.driverStatusRepository.updateStatus(driverId, 'ONLINE', {}, tx);
      await this.statusEventRepo.record(
        {
          rideId,
          fromStatus: ride.status,
          toStatus: 'COMPLETED',
          actorType: 'DRIVER',
          actorId: driverId,
        },
        tx,
      );
      this.rideMetrics.rideCompleted({ rideId });
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.COMPLETED, ride.customerId, {
          rideId,
          driverId,
          totalFare: itemizedFare.totalFare,
        }),
        tx,
      );
      return {
        ...ride,
        status: 'COMPLETED' as RideStatus,
        completedAt,
        actualDistanceKm: new Decimal(billedDistanceKm),
        actualDurationMin: billedDurationMin,
      };
    });
    // After the commit, for the same reason `startRide` resets after its own:
    // a meter cleared for a completion that rolled back would lose a trip's
    // distance that is still being driven.
    await this.resetTripMeter(driverId);
    return completed;
  }
  async cancelRide(
    rideId: string,
    cancelledBy: 'CUSTOMER' | 'DRIVER' | 'SYSTEM',
    actorId?: string,
    reasonCode = 'OTHER',
    reasonText?: string,
  ): Promise<Ride> {
    const toStatus: RideStatus =
      cancelledBy === 'CUSTOMER'
        ? 'CANCELLED_BY_CUSTOMER'
        : cancelledBy === 'DRIVER'
          ? 'CANCELLED_BY_DRIVER'
          : 'CANCELLED_BY_SYSTEM';
    return this.txManager.execute(async (tx) => {
      const actor =
        cancelledBy === 'DRIVER'
          ? ({ kind: 'driver', driverId: requireActor(actorId, 'DRIVER') } as const)
          : cancelledBy === 'CUSTOMER'
            ? ({ kind: 'customer', userId: requireActor(actorId, 'CUSTOMER') } as const)
            : ({ kind: 'system' } as const);
      const ride = await this.lockAndValidate(rideId, actor, toStatus, tx);
      const cancelledAt = new Date();
      if (
        !(await this.rideRepo.updateStatusIf(rideId, ride.status, toStatus, { cancelledAt }, tx))
      ) {
        throw new InvalidRideStateTransitionError(ride.status, toStatus);
      }
      await this.cancellationService.processCancellation(
        {
          ride,
          cancelledAt,
          cancelledBy,
          reasonCode,
          ...(actorId !== undefined ? { actorId } : {}),
          ...(reasonText !== undefined ? { reasonText } : {}),
        },
        tx,
      );
      // Cancellation is only reachable from ACCEPTED-and-later states (see
      // ALLOWED_TRANSITIONS above), so a driver is always assigned here and
      // was flipped to ON_TRIP at accept time — free them back up regardless
      // of who cancelled.
      await this.driverStatusRepository.updateStatus(ride.driverId, 'ONLINE', {}, tx);
      await this.statusEventRepo.record(
        {
          rideId,
          fromStatus: ride.status,
          toStatus,
          actorType: cancelledBy,
          ...(actorId !== undefined ? { actorId } : {}),
          ...(reasonText !== undefined ? { reason: reasonText } : {}),
        },
        tx,
      );
      this.rideMetrics.rideCancelled({ rideId, cancelledBy });
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.CANCELLED, ride.customerId, { rideId, cancelledBy, toStatus }),
        tx,
      );
      return { ...ride, status: toStatus, cancelledAt };
    });
  }
}
