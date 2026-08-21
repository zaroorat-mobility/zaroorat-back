import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { RideRepository } from '../../repositories/ride.repository.js';
import { RideRequestRepository } from '../../repositories/ride-request.repository.js';
import { RideStatusEventRepository } from '../../repositories/ride-status-event.repository.js';
import { RideDispatchRepository } from '../../repositories/ride-dispatch.repository.js';
import { RideOtpService } from '../otp/ride-otp.service.js';
import { FareService } from '../fare/fare.service.js';
import { CancellationService } from '../cancellation/cancellation.service.js';
import { RideFareRepository } from '../../repositories/ride-fare.repository.js';
import { DriverStatusRepository } from '@modules/drivers/repositories/driver-status.repository.js';
import { UserRepository } from '@modules/auth/repositories/user.repository.js';
import { NotificationService } from '@modules/notifications';
import { VehicleRepository } from '@modules/vehicles/repositories/vehicle.repository.js';
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
} from '../../errors/ride.errors.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';
import { LedgerService } from '@modules/payments/services/ledger/ledger.service.js';
import type { Ride, RideStatus } from '../../types';
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
    private readonly fareService: FareService,
    private readonly fareRepo: RideFareRepository,
    private readonly cancellationService: CancellationService,
    private readonly ledgerService: LedgerService,
    private readonly driverStatusRepository: DriverStatusRepository,
    private readonly userRepository: UserRepository,
    private readonly notificationService: NotificationService,
    private readonly vehicleRepository: VehicleRepository,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly rideMetrics: RideMetrics,
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
  private async assertVehicleEligible(
    vehicleId: string,
    driverId: string,
    requestedVehicleTypeId: string,
    tx: TransactionClient,
  ): Promise<void> {
    const vehicle = await this.vehicleRepository.findById(vehicleId, tx);
    if (!vehicle || !vehicle.isActive) {
      throw new VehicleMismatchError('Vehicle does not exist or is not active');
    }
    if (vehicle.currentDriverId !== driverId) {
      throw new VehicleMismatchError('This vehicle is not currently assigned to you');
    }
    if (vehicle.vehicleTypeId !== requestedVehicleTypeId) {
      throw new VehicleMismatchError("This vehicle's category does not match the ride request");
    }
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
      const existingDriverRide = await this.rideRepo.findActiveByDriver(data.driverId, tx);
      if (existingDriverRide) {
        throw new DriverNotAvailableError('Driver already has an active ride in progress');
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
    return this.txManager.execute(async (tx) => {
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
  }
  async completeRide(
    rideId: string,
    driverId: string,
    actualDistanceKm: number,
    actualDurationMin: number,
  ): Promise<Ride> {
    return this.txManager.execute(async (tx) => {
      const ride = await this.lockAndValidate(
        rideId,
        { kind: 'driver', driverId },
        'COMPLETED',
        tx,
      );
      const waitingMinutes = ride.waitTimeMin ?? 0;
      const itemizedFare = await this.fareService.calculateFinalFare({
        actualDistanceKm,
        actualDurationMin,
        vehicleTypeId: ride.vehicleTypeId,
        waitingMinutes,
      });
      const completedAt = new Date();
      const paymentStatus = ride.paymentMethod === 'CASH' ? 'PAID' : 'PENDING';
      if (
        !(await this.rideRepo.updateStatusIf(
          rideId,
          ride.status,
          'COMPLETED',
          {
            completedAt,
            actualDistanceKm: new Decimal(actualDistanceKm),
            actualDurationMin,
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
      await this.ledgerService.recordTripPayment(
        {
          totalFare: new Decimal(itemizedFare.totalFare),
          driverPayable: new Decimal(itemizedFare.driverEarning),
          platformCommission: new Decimal(itemizedFare.platformCommission),
          customerUserId: ride.customerId,
          driverId: ride.driverId,
          rideId,
          paymentMethod: ride.paymentMethod,
        },
        tx,
      );
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
        actualDistanceKm: new Decimal(actualDistanceKm),
        actualDurationMin,
      };
    });
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
