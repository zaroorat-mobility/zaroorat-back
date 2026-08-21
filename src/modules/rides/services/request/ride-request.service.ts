import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import {
  RideRequestRepository,
  CreateRideRequestInput,
} from '../../repositories/ride-request.repository.js';
import { RideRepository } from '../../repositories/ride.repository.js';
import { RideDispatchRepository } from '../../repositories/ride-dispatch.repository.js';
import { FareService } from '../fare/fare.service.js';
import { UserProfileRepository } from '@modules/users/repositories/user-profile.repository.js';
import {
  ActiveRideExistsError,
  RideNotFoundError,
  RideCustomerMismatchError,
  RideRequestNotCancellableError,
  IncompleteProfileError,
} from '../../errors/ride.errors.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';
import type { RideRequest } from '../../types';
const CANCELLABLE_REQUEST_STATUSES = new Set(['CREATED', 'SEARCHING']);
export class RideRequestService {
  constructor(
    private readonly requestRepo: RideRequestRepository,
    private readonly rideRepo: RideRepository,
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly fareService: FareService,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly rideMetrics: RideMetrics,
  ) {}
  async createQuote(params: {
    pickupLat: number;
    pickupLng: number;
    dropLat?: number;
    dropLng?: number;
    vehicleTypeId: string;
  }) {
    return this.fareService.calculateFareQuote(params);
  }
  async createRequest(input: {
    customerId: string;
    vehicleTypeId: string;
    pickupLat: number;
    pickupLng: number;
    pickupAddress?: string;
    dropLat?: number;
    dropLng?: number;
    dropAddress?: string;
    paymentMethod?: string;
    promoCode?: string;
  }): Promise<RideRequest> {
    const profile = await this.userProfileRepository.findByUserId(input.customerId);
    if (!profile?.firstName || !profile.lastName) {
      throw new IncompleteProfileError();
    }
    const activeRide = await this.rideRepo.findActiveByCustomer(input.customerId);
    if (activeRide) {
      throw new ActiveRideExistsError();
    }
    const activeRequest = await this.requestRepo.findActiveByCustomer(input.customerId);
    if (activeRequest) {
      throw new ActiveRideExistsError('Customer already has an active ride request');
    }
    const quoteParams = {
      pickupLat: input.pickupLat,
      pickupLng: input.pickupLng,
      vehicleTypeId: input.vehicleTypeId,
      ...(input.dropLat !== undefined ? { dropLat: input.dropLat } : {}),
      ...(input.dropLng !== undefined ? { dropLng: input.dropLng } : {}),
    };
    const fareQuote = await this.createQuote(quoteParams);
    return this.txManager.execute(async (tx) => {
      const createInput: CreateRideRequestInput = {
        customerId: input.customerId,
        vehicleTypeId: input.vehicleTypeId,
        pickupLat: new Decimal(input.pickupLat),
        pickupLng: new Decimal(input.pickupLng),
        estimatedDistanceKm: new Decimal(fareQuote.estimatedDistanceKm),
        estimatedDurationMin: fareQuote.estimatedDurationMin,
        quotedFare: new Decimal(fareQuote.totalFare),
        surgeMultiplier: new Decimal(fareQuote.surgeMultiplier),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      };
      if (input.pickupAddress !== undefined) createInput.pickupAddress = input.pickupAddress;
      if (input.dropLat !== undefined) createInput.dropLat = new Decimal(input.dropLat);
      if (input.dropLng !== undefined) createInput.dropLng = new Decimal(input.dropLng);
      if (input.dropAddress !== undefined) createInput.dropAddress = input.dropAddress;
      if (input.paymentMethod !== undefined) createInput.paymentMethod = input.paymentMethod;
      if (input.promoCode !== undefined) createInput.promoCode = input.promoCode;
      const request = await this.requestRepo.create(createInput, tx);
      this.rideMetrics.requestCreated({ requestId: request.id });
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.REQUESTED, input.customerId, {
          requestId: request.id,
          customerId: input.customerId,
          vehicleTypeId: input.vehicleTypeId,
          quotedFare: fareQuote.totalFare,
        }),
        tx,
      );
      return request;
    });
  }
  /// A request nobody has accepted yet has no `Ride` row, so `LifecycleService`'s
  /// cancel path (which acts on a `Ride`) can't reach it — this is the only
  /// cancel path for that window. Without it a customer's sole recourse was to
  /// wait out RequestExpiryJob's five-minute window.
  async cancelRequest(requestId: string, customerId: string): Promise<RideRequest> {
    return this.txManager.execute(async (tx) => {
      const request = await this.requestRepo.lockForUpdate(requestId, tx);
      if (!request) throw new RideNotFoundError(requestId);
      if (request.customerId !== customerId) {
        throw new RideCustomerMismatchError(requestId);
      }
      if (!CANCELLABLE_REQUEST_STATUSES.has(request.status)) {
        throw new RideRequestNotCancellableError(request.status);
      }
      const cancelled = await this.requestRepo.updateStatus(requestId, 'ABANDONED', tx);
      await this.dispatchRepo.cancelAllPendingForRequest(requestId, tx);
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.REQUEST_ABANDONED, customerId, { requestId }),
        tx,
      );
      return cancelled;
    });
  }
}
