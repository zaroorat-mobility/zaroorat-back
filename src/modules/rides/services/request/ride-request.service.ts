import { Decimal } from '../../types/index.js';
import { rideConfig } from '@config';
import { TransactionManager, UniqueConstraintError } from '@core/database';
import { EventPublisher } from '@core/events';
import {
  RideRequestRepository,
  CreateRideRequestInput,
} from '../../repositories/ride-request.repository.js';
import { RideRepository } from '../../repositories/ride.repository.js';
import { RideDispatchRepository } from '../../repositories/ride-dispatch.repository.js';
import { PricingService, SurgeService } from '@modules/pricing';
import { UserProfileRepository } from '@modules/users/repositories/user-profile.repository.js';
import { VehicleTypeService } from '@modules/vehicles/services/vehicle-type.service.js';
import { toVehicleTypeView } from '@modules/vehicles/controllers/vehicle-type.controller.js';
import {
  ActiveRideExistsError,
  RideNotFoundError,
  RideCustomerMismatchError,
  RideRequestNotCancellableError,
  IncompleteProfileError,
  PromotionsUnavailableError,
} from '../../errors/ride.errors.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';
import { DebtService } from '@modules/payments/services/debt/debt.service.js';
import { RiderDebtLimitExceededError } from '@modules/payments/errors/payment.errors.js';
import type { RideRequest } from '../../types';
import type { ItemizedFareResult } from '@modules/pricing';

export interface QuoteOption {
  vehicleTypeId: string;
  vehicleTypeCode: string;
  displayName: string;
  icon: string | null;
  passengerCapacity: number | null;
  luggageCapacity: number | null;
  estimatedFare: number;
  minimumFare: number;
  fareBreakdown: ItemizedFareResult;
}

export interface RideQuote {
  pickup: { latitude: number; longitude: number };
  drop: { latitude: number; longitude: number };
  estimatedDistanceKm: number;
  estimatedDurationMin: number;
  currency: string;
  options: QuoteOption[];
}
const CANCELLABLE_REQUEST_STATUSES = new Set(['CREATED', 'SEARCHING']);
export class RideRequestService {
  constructor(
    private readonly requestRepo: RideRequestRepository,
    private readonly rideRepo: RideRepository,
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly pricingService: PricingService,
    private readonly surgeService: SurgeService,
    private readonly vehicleTypeService: VehicleTypeService,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly rideMetrics: RideMetrics,
    private readonly debtService: DebtService,
  ) {}
  /// One request, every category. `vehicleTypeId` narrows the result to a
  /// single option; omitting it prices every active type so the customer app
  /// renders its picker from one call instead of one call per category.
  ///
  /// Types are loaded once and their rate cards passed into the fare service,
  /// so pricing N categories costs one query, not N.
  async createQuote(params: {
    pickupLat: number;
    pickupLng: number;
    dropLat: number;
    dropLng: number;
    vehicleTypeId?: string;
    cityId?: string;
  }): Promise<RideQuote> {
    // The `dropLat == null` guard that used to stand here was a second copy of
    // the one in `calculateFareQuote`, and both threw a bare `Error` that
    // surfaced as 500. `quoteFareSchema` now requires the coordinates, so this
    // is unreachable input rather than an error path.
    const vehicleTypes = params.vehicleTypeId
      ? [await this.vehicleTypeService.requireActive(params.vehicleTypeId)]
      : await this.vehicleTypeService.listActive(
          params.cityId !== undefined ? { cityId: params.cityId } : {},
        );

    const trip = this.pricingService.estimateTrip({
      pickupLat: params.pickupLat,
      pickupLng: params.pickupLng,
      dropLat: params.dropLat,
      dropLng: params.dropLng,
    });

    const options: QuoteOption[] = [];
    for (const vehicleType of vehicleTypes) {
      // Deliberately not passed a city: `rateCardForTypeId`'s second argument is
      // a `PricingRule.cityCode` — a short string like 'BLR' — and `params.cityId`
      // is a `City` UUID. Feeding one to the other could never match, so the
      // city-specific lookup was a guaranteed miss that fell through to GLOBAL
      // and cost a query to do it. `City.code` makes the translation available
      // whenever per-city rate cards are actually wanted; until something writes
      // one, resolving it here would be a second query for a table that has only
      // GLOBAL rows in it.
      const rateCard = await this.pricingService.rateCardForTypeId(vehicleType.id);
      const surgeMultiplier = await this.surgeService.resolveSurgeMultiplier(
        params.pickupLat,
        params.pickupLng,
        vehicleType.id,
      );

      const fare = await this.pricingService.calculateFareQuote({
        pickupLat: params.pickupLat,
        pickupLng: params.pickupLng,
        dropLat: params.dropLat,
        dropLng: params.dropLng,
        vehicleTypeId: vehicleType.id,
        surgeMultiplier,
        rateCard,
      });
      const view = toVehicleTypeView(vehicleType, rateCard);
      options.push({
        vehicleTypeId: vehicleType.id,
        vehicleTypeCode: view.code,
        displayName: view.name,
        icon: view.icon,
        passengerCapacity: view.passengerCapacity,
        luggageCapacity: view.luggageCapacity,
        estimatedFare: fare.totalFare,
        minimumFare: rateCard.minimumFare,
        fareBreakdown: fare,
      });
    }

    return {
      pickup: { latitude: params.pickupLat, longitude: params.pickupLng },
      drop: { latitude: params.dropLat, longitude: params.dropLng },
      estimatedDistanceKm: trip.distanceKm,
      estimatedDurationMin: trip.durationMin,
      currency: 'INR',
      options,
    };
  }
  async createRequest(input: {
    customerId: string;
    vehicleTypeId: string;
    pickupLat: number;
    pickupLng: number;
    pickupAddress?: string;
    dropLat: number;
    dropLng: number;
    dropAddress?: string;
    paymentMethod?: string;
    promoCode?: string;
  }): Promise<RideRequest> {
    // Refused before anything is written, and before the debt and active-ride
    // checks, because it is a fact about the request itself rather than about
    // the rider: nothing in this codebase can apply a promotion, so a booking
    // carrying a code would be billed in full without ever saying so.
    if (input.promoCode !== undefined && input.promoCode.trim() !== '') {
      throw new PromotionsUnavailableError();
    }
    const profile = await this.userProfileRepository.findByUserId(input.customerId);
    if (!profile?.firstName || !profile.lastName) {
      throw new IncompleteProfileError();
    }
    // BD-2. Blocks a *new* ride, never settling an existing one — refusing
    // someone permission to pay what they owe would be self-defeating, so
    // `POST /rides/:rideId/payment/retry` deliberately does not consult this.
    //
    // No lock and no transaction here: the boundary that stops a rider opening
    // several rides at once is the existing `rides_active_customer_key` partial
    // unique index, and a debt check that raced it would add nothing.
    const debt = await this.debtService.riderDebt(input.customerId);
    if (debt.blocked) {
      throw new RiderDebtLimitExceededError(debt.outstanding.toFixed(2), debt.limit.toFixed(2));
    }
    const activeRide = await this.rideRepo.findActiveByCustomer(input.customerId);
    if (activeRide) {
      throw new ActiveRideExistsError();
    }
    const activeRequest = await this.requestRepo.findActiveByCustomer(input.customerId);
    if (activeRequest) {
      throw new ActiveRideExistsError('Customer already has an active ride request');
    }
    // Validates the client-supplied type before anything is written: an
    // unknown id is 404 VEHICLE_TYPE_NOT_FOUND, a retired one is 409
    // VEHICLE_TYPE_INACTIVE. Before the catalog existed the only check was the
    // database foreign key, which could not tell the two apart. Called for
    // that guard alone — pricing now resolves its own rate card from
    // PricingRuleRepository, so the returned type is not needed here.
    await this.vehicleTypeService.requireActive(input.vehicleTypeId);

    const surgeMultiplier = await this.surgeService.resolveSurgeMultiplier(
      input.pickupLat,
      input.pickupLng,
      input.vehicleTypeId,
    );

    const fareQuote = await this.pricingService.calculateFareQuote({
      pickupLat: input.pickupLat,
      pickupLng: input.pickupLng,
      dropLat: input.dropLat,
      dropLng: input.dropLng,
      vehicleTypeId: input.vehicleTypeId,
      surgeMultiplier,
    });
    // The `findActiveByCustomer` check above is a read outside this write's
    // transaction, so it cannot see a sibling booking that has not committed
    // yet — the `ride_requests_active_customer_key` partial index is what
    // actually stops the second row, exactly as its migration says.
    try {
      return await this.txManager.execute(async (tx) => {
        const createInput: CreateRideRequestInput = {
          customerId: input.customerId,
          vehicleTypeId: input.vehicleTypeId,
          pickupLat: new Decimal(input.pickupLat),
          pickupLng: new Decimal(input.pickupLng),
          estimatedDistanceKm: new Decimal(fareQuote.estimatedDistanceKm),
          estimatedDurationMin: fareQuote.estimatedDurationMin,
          quotedFare: new Decimal(fareQuote.totalFare),
          surgeMultiplier: new Decimal(fareQuote.surgeMultiplier),
          // Was a hardcoded five minutes while `RIDE_REQUEST_EXPIRY_MIN` — which
          // exists for exactly this, defaults to the same five, and is what
          // `.env.example` tells an operator bounds the search — went unread.
          expiresAt: new Date(Date.now() + rideConfig.requestExpiryMinutes * 60_000),
        };
        createInput.dropLat = new Decimal(input.dropLat);
        createInput.dropLng = new Decimal(input.dropLng);
        if (input.pickupAddress !== undefined) createInput.pickupAddress = input.pickupAddress;
        if (input.dropAddress !== undefined) createInput.dropAddress = input.dropAddress;
        if (input.paymentMethod !== undefined) createInput.paymentMethod = input.paymentMethod;
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
    } catch (err) {
      // That index is the only unique constraint this insert can violate — the
      // id is a uuid7 and the outbox event id is freshly generated — so
      // reaching here means the rider booked twice at once and lost the race.
      //
      // They used to be told what the database was told: nothing.
      // `UniqueConstraintError` carries no `code` and no `statusCode`, so
      // `handleRideError` could only call it 500 — a server fault reported to a
      // rider who tapped Book twice, where the identical sequential retry gets
      // a clean 409. Same intent, same end state, two different answers.
      if (err instanceof UniqueConstraintError) {
        throw new ActiveRideExistsError('Customer already has an active ride request');
      }
      throw err;
    }
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
