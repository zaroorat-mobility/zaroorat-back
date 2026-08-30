import { Decimal } from '../../types/index.js';
import { TransactionManager, UniqueConstraintError } from '@core/database';
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
  PromotionsUnavailableError,
} from '../../errors/ride.errors.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';
import { DebtService } from '@modules/payments/services/debt/debt.service.js';
import { RiderDebtLimitExceededError } from '@modules/payments/errors/payment.errors.js';
import {
  GeographicCoverageService,
  MapProviderService,
  NearbyDriverService,
} from '@modules/location';
import { logger } from '@shared/logger/index.js';
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
  /// Name of the map provider that supplied the directions (e.g. 'ola', 'google', 'mappls').
  distanceSource: string;
  currency: string;
  /// ETA in minutes for the nearest available driver to reach the pickup point.
  /// Null when no drivers are nearby or the Matrix API call failed.
  nearbyDriverEtaMin: number | null;
  /// Status of the driver ETA calculation:
  /// 'ok' = road ETA calculated from matrix API
  /// 'no_drivers' = Redis GEO candidate search returned 0 nearby drivers
  /// 'matrix_unavailable' = candidate drivers exist but map matrix API failed
  nearbyDriverEtaStatus: 'ok' | 'no_drivers' | 'matrix_unavailable';
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
    private readonly nearbyDriverService: NearbyDriverService,
    /// Injected map provider service for driver candidate matrix ETAs
    private readonly mapProviderService?: MapProviderService,
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
    cityCode?: string;
    promoCode?: string;
    userId?: string;
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

    const trip = await this.pricingService.estimateTrip({
      pickupLat: params.pickupLat,
      pickupLng: params.pickupLng,
      dropLat: params.dropLat,
      dropLng: params.dropLng,
    });

    // FR-039. Everything that depends on the pickup point rather than on the
    // category is resolved once, before the loop.
    //
    // The loop used to call `assertPickupServiceable` (a city ST_Contains, a zone
    // ST_Contains, a zone count), `rateCardForTypeId` (another zone ST_Contains
    // plus rule lookups) and `resolveSurgeMultiplier` (a surge ST_Intersects plus
    // a window query) once per category. Six categories was roughly fifty round
    // trips, about twenty-four of them unindexed spatial scans, to answer the
    // same questions about the same point six times over. The loop's own comment
    // recorded that the haversine had been hoisted out; the database work had
    // not been.
    const pickupContext = await this.geographicCoverageService.resolvePickupContext(
      params.pickupLat,
      params.pickupLng,
    );
    const city = pickupContext.city;
    const resolvedCityCode = city.code;

    if (params.dropLat != null && params.dropLng != null) {
      await this.geographicCoverageService.assertDropServiceable({
        lat: params.dropLat,
        lng: params.dropLng,
        cityCode: city.code,
      });
    }

    const rateCards = await this.pricingService.rateCardsForPoint({
      vehicleTypeIds: vehicleTypes.map((type) => type.id),
      cityCode: city.code,
      pickupLat: params.pickupLat,
      pickupLng: params.pickupLng,
    });
    const surgeByType = await this.surgeService.resolveSurgeMultipliersForTypes(
      params.pickupLat,
      params.pickupLng,
      vehicleTypes.map((type) => type.id),
      { timeZone: pickupContext.cityTimeZone, cityCode: city.code },
    );

    const options: QuoteOption[] = [];
    for (const vehicleType of vehicleTypes) {
      // The one genuinely per-category check: does this zone admit this type.
      await this.geographicCoverageService.assertVehicleTypeServiceable(
        pickupContext,
        vehicleType.id,
      );

      const rateCard = rateCards.get(vehicleType.id) ?? this.pricingService.rateCardFor(null);
      const surgeMultiplier = surgeByType.get(vehicleType.id) ?? 1;
      const baseFare = await this.pricingService.calculateFareQuote({
        pickupLat: params.pickupLat,
        pickupLng: params.pickupLng,
        dropLat: params.dropLat,
        dropLng: params.dropLng,
        vehicleTypeId: vehicleType.id,
        cityCode: city.code,
        surgeMultiplier,
        rateCard,
        // Estimated once above. The journey is the same whichever category
        // prices it, so this loop was running the same haversine per category
        // and could disagree with the `estimatedDistanceKm` it reports.
        trip,
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

    // ── Driver ETA via Distance Matrix (MapProviderService) ──────────────────────
    // Step 1: Redis GEO lookup for nearby candidate drivers
    // Step 2: Distance Matrix routing call to get real road ETAs for candidates
    // Clearly distinguishes 'no_drivers' (0 candidates) vs 'matrix_unavailable' (API failure).
    let nearbyDriverEtaMin: number | null = null;
    let nearbyDriverEtaStatus: 'ok' | 'no_drivers' | 'matrix_unavailable' = 'no_drivers';

    try {
      const nearby = await this.nearbyDriverService.find({
        origin: { latitude: params.pickupLat, longitude: params.pickupLng },
        limit: 5,
      });
      const drivers = 'drivers' in nearby && nearby.drivers.length > 0 ? nearby.drivers : null;

      if (!drivers || drivers.length === 0) {
        nearbyDriverEtaStatus = 'no_drivers';
      } else if (this.mapProviderService) {
        const origins = drivers.map((d) => ({
          latitude: d.latitude,
          longitude: d.longitude,
        }));
        const destination = [{ latitude: params.pickupLat, longitude: params.pickupLng }];

        const matrixResult = await this.mapProviderService.getDistanceMatrix(origins, destination);

        if (matrixResult.status === 'ok' && matrixResult.cells.length > 0) {
          const etaSeconds = matrixResult.cells
            .map((row) => row[0])
            .filter((cell): cell is NonNullable<typeof cell> => !!cell && cell.status === 'OK')
            .map((cell) => cell.durationSeconds);

          if (etaSeconds.length > 0) {
            nearbyDriverEtaMin = Math.ceil(Math.min(...etaSeconds) / 60);
            nearbyDriverEtaStatus = 'ok';
          } else {
            nearbyDriverEtaStatus = 'matrix_unavailable';
          }
        } else {
          nearbyDriverEtaStatus = 'matrix_unavailable';
        }
      }
    } catch (err) {
      logger.warn({ err }, '[RideRequestService] Driver candidate ETA matrix calculation failed');
      nearbyDriverEtaStatus = 'matrix_unavailable';
    }

    return {
      pickup: { latitude: params.pickupLat, longitude: params.pickupLng },
      drop: { latitude: params.dropLat, longitude: params.dropLng },
      estimatedDistanceKm: trip.distanceKm,
      estimatedDurationMin: trip.durationMin,
      distanceSource: trip.source,
      currency: 'INR',
      nearbyDriverEtaMin,
      nearbyDriverEtaStatus,
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
    dropLat: number;
    dropLng: number;
    dropAddress?: string;
    paymentMethod?: string;
    promoCode?: string;
    cityCode?: string;
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
      // FR-013. Peak hours are read in the pickup city, not on the server.
      // FR-015. The city scopes which service zones can carry a surge window.
      { timeZone: city.timezone, cityCode: city.code },
    );

    // FR-002. Resolved once, here, and both remembered and reused: the id goes
    // onto the request so completion bills on this exact rule, and the card
    // itself is handed to every fare pass below so a second lookup cannot land
    // on a different rule mid-booking.
    const { card: rateCard, ruleId: pricingRuleId } = await this.pricingService.resolveRateCard(
      input.vehicleTypeId,
      city.code,
      { pickupLat: input.pickupLat, pickupLng: input.pickupLng },
    );

    const baseFare = await this.pricingService.calculateFareQuote({
      pickupLat: input.pickupLat,
      pickupLng: input.pickupLng,
      dropLat: input.dropLat,
      dropLng: input.dropLng,
      vehicleTypeId: input.vehicleTypeId,
      cityCode: city.code,
      surgeMultiplier,
      rateCard,
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
            rateCard,
            ...(input.dropLat !== undefined ? { dropLat: input.dropLat } : {}),
            ...(input.dropLng !== undefined ? { dropLng: input.dropLng } : {}),
          })
        : baseFare;

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
          pricingRuleId,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        };
        if (input.pickupAddress !== undefined) createInput.pickupAddress = input.pickupAddress;
        if (input.dropLat !== undefined) createInput.dropLat = new Decimal(input.dropLat);
        if (input.dropLng !== undefined) createInput.dropLng = new Decimal(input.dropLng);
        if (input.dropAddress !== undefined) createInput.dropAddress = input.dropAddress;
        if (input.paymentMethod !== undefined) createInput.paymentMethod = input.paymentMethod;
        if (input.promoCode?.trim()) createInput.promoCode = input.promoCode.trim().toUpperCase();
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
