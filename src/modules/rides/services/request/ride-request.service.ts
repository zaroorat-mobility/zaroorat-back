import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import {
  RideRequestRepository,
  CreateRideRequestInput,
} from '../../repositories/ride-request.repository.js';
import { RideRepository } from '../../repositories/ride.repository.js';
import { RideDispatchRepository } from '../../repositories/ride-dispatch.repository.js';
import { PricingService, SurgeService } from '@modules/pricing';
import { PromotionService } from '@modules/promotions';
import { UserProfileRepository } from '@modules/users/repositories/user-profile.repository.js';
import { VehicleTypeService } from '@modules/vehicles/services/vehicle-type.service.js';
import { toVehicleTypeView } from '@modules/vehicles/controllers/vehicle-type.controller.js';
import {
  ActiveRideExistsError,
  RideNotFoundError,
  RideCustomerMismatchError,
  RideRequestNotCancellableError,
  IncompleteProfileError,
} from '../../errors/ride.errors.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';
import { DebtService } from '@modules/payments/services/debt/debt.service.js';
import { RiderDebtLimitExceededError } from '@modules/payments/errors/payment.errors.js';
import { GeographicCoverageService } from '@modules/geographic';
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
  promoApplied: boolean;
  promoDiscountAmount: number;
  promoErrorCode?: string;
  promoErrorMessage?: string;
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
    private readonly promotionService: PromotionService,
    private readonly vehicleTypeService: VehicleTypeService,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly rideMetrics: RideMetrics,
    private readonly debtService: DebtService,
    private readonly geographicCoverageService: GeographicCoverageService,
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
    dropLat?: number;
    dropLng?: number;
    vehicleTypeId?: string;
    cityId?: string;
    cityCode?: string;
    promoCode?: string;
    userId?: string;
  }): Promise<RideQuote> {
    if (params.dropLat == null || params.dropLng == null) {
      throw new Error(
        'A fare quote requires drop coordinates. Quoting an open-ended ride at a ' +
          'fixed default distance produced a price unrelated to the trip.',
      );
    }

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
    let resolvedCityCode: string | undefined;
    for (const vehicleType of vehicleTypes) {
      const city = await this.geographicCoverageService.assertPickupServiceable({
        lat: params.pickupLat,
        lng: params.pickupLng,
        vehicleTypeId: vehicleType.id,
      });
      resolvedCityCode = city.code;

      if (params.dropLat != null && params.dropLng != null) {
        await this.geographicCoverageService.assertDropServiceable({
          lat: params.dropLat,
          lng: params.dropLng,
          cityCode: city.code,
        });
      }

      const rateCard = await this.pricingService.rateCardForTypeId(vehicleType.id, city.code, {
        pickupLat: params.pickupLat,
        pickupLng: params.pickupLng,
      });
      const surgeMultiplier = await this.surgeService.resolveSurgeMultiplier(
        params.pickupLat,
        params.pickupLng,
        vehicleType.id,
      );

      const baseFare = await this.pricingService.calculateFareQuote({
        pickupLat: params.pickupLat,
        pickupLng: params.pickupLng,
        dropLat: params.dropLat,
        dropLng: params.dropLng,
        vehicleTypeId: vehicleType.id,
        cityCode: city.code,
        surgeMultiplier,
        rateCard,
      });

      const promoResult = await this.promotionService.quotePromo(params.promoCode, {
        ...(params.userId !== undefined ? { userId: params.userId } : {}),
        cityCode: city.code,
        vehicleTypeId: vehicleType.id,
        subtotal: baseFare.subtotal,
        softUserChecks: params.userId == null,
      });

      const fare =
        promoResult.applied && promoResult.discountAmount > 0
          ? await this.pricingService.calculateFareQuote({
              pickupLat: params.pickupLat,
              pickupLng: params.pickupLng,
              dropLat: params.dropLat,
              dropLng: params.dropLng,
              vehicleTypeId: vehicleType.id,
              cityCode: city.code,
              surgeMultiplier,
              rateCard,
              discountAmount: promoResult.discountAmount,
            })
          : baseFare;

      const view = toVehicleTypeView(vehicleType);
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
        promoApplied: promoResult.applied,
        promoDiscountAmount: promoResult.discountAmount,
        ...(promoResult.errorCode !== undefined ? { promoErrorCode: promoResult.errorCode } : {}),
        ...(promoResult.errorMessage !== undefined
          ? { promoErrorMessage: promoResult.errorMessage }
          : {}),
      });
    }

    return {
      pickup: { latitude: params.pickupLat, longitude: params.pickupLng },
      drop: { latitude: params.dropLat, longitude: params.dropLng },
      estimatedDistanceKm: trip.distanceKm,
      estimatedDurationMin: trip.durationMin,
      currency: 'INR',
      ...(resolvedCityCode !== undefined ? { cityCode: resolvedCityCode } : {}),
      options,
    };
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
    cityCode?: string;
  }): Promise<RideRequest> {
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

    const city = await this.geographicCoverageService.assertPickupServiceable({
      lat: input.pickupLat,
      lng: input.pickupLng,
      vehicleTypeId: input.vehicleTypeId,
    });
    if (input.dropLat != null && input.dropLng != null) {
      await this.geographicCoverageService.assertDropServiceable({
        lat: input.dropLat,
        lng: input.dropLng,
        cityCode: city.code,
      });
    }

    const surgeMultiplier = await this.surgeService.resolveSurgeMultiplier(
      input.pickupLat,
      input.pickupLng,
      input.vehicleTypeId,
    );

    const baseFare = await this.pricingService.calculateFareQuote({
      pickupLat: input.pickupLat,
      pickupLng: input.pickupLng,
      vehicleTypeId: input.vehicleTypeId,
      cityCode: city.code,
      surgeMultiplier,
      ...(input.dropLat !== undefined ? { dropLat: input.dropLat } : {}),
      ...(input.dropLng !== undefined ? { dropLng: input.dropLng } : {}),
    });

    let discountAmount = 0;
    if (input.promoCode?.trim()) {
      const resolved = await this.promotionService.validateAndResolve(input.promoCode.trim(), {
        userId: input.customerId,
        cityCode: city.code,
        vehicleTypeId: input.vehicleTypeId,
        subtotal: baseFare.subtotal,
      });
      discountAmount = resolved.discountAmount;
    }

    const fareQuote =
      discountAmount > 0
        ? await this.pricingService.calculateFareQuote({
            pickupLat: input.pickupLat,
            pickupLng: input.pickupLng,
            vehicleTypeId: input.vehicleTypeId,
            cityCode: city.code,
            surgeMultiplier,
            discountAmount,
            ...(input.dropLat !== undefined ? { dropLat: input.dropLat } : {}),
            ...(input.dropLng !== undefined ? { dropLng: input.dropLng } : {}),
          })
        : baseFare;

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
      if (input.promoCode !== undefined)
        createInput.promoCode = input.promoCode.trim().toUpperCase();
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
