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
import { UserRepository } from '@modules/auth/repositories/user.repository.js';
import { VehicleTypeService } from '@modules/vehicles/services/vehicle-type.service.js';
import { toVehicleTypeView } from '@modules/vehicles/controllers/vehicle-type.controller.js';
import {
  ActiveRideExistsError,
  RideNotFoundError,
  RideCustomerMismatchError,
  RideRequestNotCancellableError,
  IncompleteProfileError,
  RidePinNotConfiguredError,
  WalletRidesNotAcceptedError,
  ScheduledTooSoonError,
  RideRequestNotBoostableError,
  DestinationChangeNotAllowedError,
  DestinationFareChangedError,
} from '../../errors/ride.errors.js';
import { rideConfig } from '@config';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';
import {
  NEW_RIDE_PAYMENT_METHODS,
  DESTINATION_CHANGE_STATUSES,
} from '../../constants/ride.constants.js';
import { DebtService } from '@modules/payments/services/debt/debt.service.js';
import { RiderDebtLimitExceededError } from '@modules/payments/errors/payment.errors.js';
import {
  GeographicCoverageService,
  MapProviderService,
  NearbyDriverService,
} from '@modules/location';
import { logger } from '@shared/logger/index.js';
import type { Ride, RideRequest } from '../../types';
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
  stops: Array<{ sequence: number; latitude: number; longitude: number; address: string | null }>;
  options: QuoteOption[];
}
export interface RideStopInput {
  lat: number;
  lng: number;
  address?: string;
}
export interface BoostResult {
  requestId: string;
  quotedFare: number | null;
  boostAmount: number;
  totalOffered: number | null;
}
export interface DestinationInput {
  dropLat: number;
  dropLng: number;
  dropAddress?: string;
}
export interface DestinationQuote {
  rideId: string;
  drop: { latitude: number; longitude: number; address: string | null };
  previousFare: number | null;
  newFare: number;
  fareDifference: number | null;
  estimatedDistanceKm: number;
  estimatedDurationMin: number;
  currency: string;
  fareBreakdown: ItemizedFareResult;
}
const DESTINATION_FARE_TOLERANCE = 1;
function routePoints(
  pickupLat: number,
  pickupLng: number,
  stops: readonly RideStopInput[],
  dropLat: number,
  dropLng: number,
): Array<{ lat: number; lng: number }> {
  return [
    { lat: pickupLat, lng: pickupLng },
    ...stops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
    { lat: dropLat, lng: dropLng },
  ];
}
const CANCELLABLE_REQUEST_STATUSES = new Set(['CREATED', 'SEARCHING']);
const BOOSTABLE_REQUEST_STATUSES = new Set(['CREATED', 'SEARCHING']);
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
    private readonly userRepository: UserRepository,
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
    stops?: readonly RideStopInput[];
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

    const stops = params.stops ?? [];
    const trip = await this.pricingService.estimateRoute(
      routePoints(params.pickupLat, params.pickupLng, stops, params.dropLat, params.dropLng),
    );

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
    for (const stop of stops) {
      await this.geographicCoverageService.assertDropServiceable({
        lat: stop.lat,
        lng: stop.lng,
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
              trip,
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
      stops: stops.map((stop, index) => ({
        sequence: index + 1,
        latitude: stop.lat,
        longitude: stop.lng,
        address: stop.address ?? null,
      })),
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
    stops?: readonly RideStopInput[];
    passengerName?: string;
    passengerPhone?: string;
    pickupNotes?: string;
    scheduledFor?: Date;
    boostAmount?: number;
  }): Promise<RideRequest> {
    const stops = input.stops ?? [];
    const scheduledFor = input.scheduledFor ?? null;
    if (scheduledFor) {
      const earliest = Date.now() + rideConfig.scheduledMinLeadMinutes * 60 * 1000;
      if (scheduledFor.getTime() < earliest) {
        throw new ScheduledTooSoonError(rideConfig.scheduledMinLeadMinutes);
      }
    }
    // D1. Refused here as well as in the request schema, so a caller that does
    // not go through the HTTP route cannot book a wallet ride either. Nothing
    // is written and no wallet balance is read.
    if (
      input.paymentMethod !== undefined &&
      !(NEW_RIDE_PAYMENT_METHODS as readonly string[]).includes(input.paymentMethod)
    ) {
      throw new WalletRidesNotAcceptedError();
    }
    const profile = await this.userProfileRepository.findByUserId(input.customerId);
    if (!profile?.firstName || !profile.lastName) {
      throw new IncompleteProfileError();
    }
    // The other half of onboarding, and it belongs here rather than at
    // `/start` for the same reason the name check does: a rider who cannot
    // satisfy the ride-start credential must find that out while holding their
    // phone, not with a driver already waiting at the kerb where the only
    // outcomes are a cancellation and two wasted trips.
    const ridePin = await this.userRepository.findRidePin(input.customerId);
    if (!ridePin?.ridePinVerifier) {
      throw new RidePinNotConfiguredError();
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
    // A scheduled booking is for later, so a ride in progress now does not
    // conflict with it; the partial unique index excludes it for the same reason.
    if (!scheduledFor) {
      const activeRide = await this.rideRepo.findActiveByCustomer(input.customerId);
      if (activeRide) {
        throw new ActiveRideExistsError();
      }
      const activeRequest = await this.requestRepo.findActiveByCustomer(input.customerId);
      if (activeRequest) {
        throw new ActiveRideExistsError('Customer already has an active ride request');
      }
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
    for (const stop of stops) {
      await this.geographicCoverageService.assertDropServiceable({
        lat: stop.lat,
        lng: stop.lng,
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

    // Estimated once and shared by both fare passes, so the promo pass cannot
    // land on a different route (and, with stops, sums every leg).
    const trip = await this.pricingService.estimateRoute(
      routePoints(input.pickupLat, input.pickupLng, stops, input.dropLat, input.dropLng),
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
      trip,
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
            trip,
            dropLat: input.dropLat,
            dropLng: input.dropLng,
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
          // A scheduled booking must not age out like an instant search does;
          // RequestExpiryJob only sweeps rows with an `expiresAt`.
          expiresAt: scheduledFor ? null : new Date(Date.now() + 5 * 60 * 1000),
          scheduledFor,
          passengerName: input.passengerName ?? null,
          passengerPhone: input.passengerPhone ?? null,
          pickupNotes: input.pickupNotes?.trim() ? input.pickupNotes.trim() : null,
          boostAmount: input.boostAmount ? new Decimal(input.boostAmount) : null,
        };
        if (input.pickupAddress !== undefined) createInput.pickupAddress = input.pickupAddress;
        if (input.dropLat !== undefined) createInput.dropLat = new Decimal(input.dropLat);
        if (input.dropLng !== undefined) createInput.dropLng = new Decimal(input.dropLng);
        if (input.dropAddress !== undefined) createInput.dropAddress = input.dropAddress;
        if (input.paymentMethod !== undefined) createInput.paymentMethod = input.paymentMethod;
        if (input.promoCode?.trim()) createInput.promoCode = input.promoCode.trim().toUpperCase();
        if (this.mapProviderService) {
          const policy = await this.mapProviderService.resolvePolicy();
          createInput.mapProvider = policy.primaryProvider;
          createInput.mapConfigVersion = policy.configVersion;
        }
        const request = await this.requestRepo.create(createInput, tx);
        if (stops.length > 0) {
          await this.requestRepo.createStops(request.id, stops, tx);
        }
        this.rideMetrics.requestCreated({ requestId: request.id });
        // Scheduled: parked for drivers to pick up from the scheduled list.
        // No `ride.requested`, so nothing dispatches it now.
        if (scheduledFor) {
          const scheduled = await tx.scheduledRide.create({
            data: {
              requestId: request.id,
              customerId: input.customerId,
              scheduledFor,
              status: 'SCHEDULED',
            },
          });
          await this.eventPublisher.publish(
            rideEvent(RIDE_EVENT_CATALOG.SCHEDULED_CREATED, scheduled.id, {
              scheduledRideId: scheduled.id,
              requestId: request.id,
              customerId: input.customerId,
              scheduledFor: scheduledFor.toISOString(),
            }),
            tx,
          );
          return request;
        }
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
  async getActiveRequest(customerId: string): Promise<RideRequest | null> {
    return this.requestRepo.findActiveDetailByCustomer(customerId);
  }

  async getRequestForCustomer(requestId: string, customerId: string): Promise<RideRequest> {
    const request = await this.requestRepo.findByIdWithClientInclude(requestId);
    if (!request) throw new RideNotFoundError(requestId);
    if (request.customerId !== customerId) {
      throw new RideCustomerMismatchError(requestId);
    }
    return request;
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
  /// Replaces (never accumulates) the rider's boost on a request that is still
  /// searching. Drivers see `quotedFare + boostAmount` on the offer.
  async boostRequest(
    requestId: string,
    customerId: string,
    boostAmount: number,
  ): Promise<BoostResult> {
    return this.txManager.execute(async (tx) => {
      const request = await this.requestRepo.lockForUpdate(requestId, tx);
      if (!request) throw new RideNotFoundError(requestId);
      if (request.customerId !== customerId) {
        throw new RideCustomerMismatchError(requestId);
      }
      if (!BOOSTABLE_REQUEST_STATUSES.has(request.status)) {
        throw new RideRequestNotBoostableError(request.status);
      }
      const updated = await this.requestRepo.updateBoost(requestId, new Decimal(boostAmount), tx);
      const quotedFare = updated.quotedFare != null ? Number(updated.quotedFare) : null;
      const totalOffered = quotedFare != null ? quotedFare + boostAmount : null;
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.REQUEST_BOOSTED, customerId, {
          requestId,
          customerId,
          boostAmount,
          totalOffered,
        }),
        tx,
      );
      return { requestId, quotedFare, boostAmount, totalOffered };
    });
  }
  /// Prices the trip as if it had always been going to the new drop: pickup,
  /// through any stops, to the new point, on the rule and surge it was booked
  /// on. Read-only; `confirmDestinationChange` re-runs it and applies it.
  async quoteDestinationChange(
    rideId: string,
    customerId: string,
    drop: DestinationInput,
  ): Promise<DestinationQuote> {
    const ride = await this.rideRepo.findById(rideId);
    if (!ride) throw new RideNotFoundError(rideId);
    this.assertDestinationChangeable(ride, customerId);
    return this.priceDestination(ride, drop);
  }
  /// `expectedFare`, when sent, must match the reprice to within a rupee so the
  /// rider is never moved onto a fare they were not shown.
  async confirmDestinationChange(
    rideId: string,
    customerId: string,
    drop: DestinationInput & { expectedFare?: number },
  ): Promise<DestinationQuote> {
    const ride = await this.rideRepo.findById(rideId);
    if (!ride) throw new RideNotFoundError(rideId);
    this.assertDestinationChangeable(ride, customerId);
    // Priced outside the transaction: it makes directions calls, and holding
    // the ride row lock across the network would stall the driver's own writes.
    const quote = await this.priceDestination(ride, drop);
    if (
      drop.expectedFare !== undefined &&
      Math.abs(quote.newFare - drop.expectedFare) > DESTINATION_FARE_TOLERANCE
    ) {
      throw new DestinationFareChangedError(drop.expectedFare, quote.newFare);
    }
    return this.txManager.execute(async (tx) => {
      const locked = await this.rideRepo.lockForUpdate(rideId, tx);
      if (!locked) throw new RideNotFoundError(rideId);
      this.assertDestinationChangeable(locked, customerId);
      await this.requestRepo.updateDestination(
        locked.requestId,
        {
          dropLat: drop.dropLat,
          dropLng: drop.dropLng,
          dropAddress: drop.dropAddress ?? null,
          estimatedDistanceKm: new Decimal(quote.estimatedDistanceKm),
          estimatedDurationMin: quote.estimatedDurationMin,
          quotedFare: new Decimal(quote.newFare),
        },
        tx,
      );
      await this.rideRepo.updateDrop(
        rideId,
        { dropLat: drop.dropLat, dropLng: drop.dropLng, dropAddress: drop.dropAddress ?? null },
        tx,
      );
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.DESTINATION_CHANGED, rideId, {
          rideId,
          customerId,
          driverId: locked.driverId,
          dropLat: drop.dropLat,
          dropLng: drop.dropLng,
          dropAddress: drop.dropAddress ?? null,
          previousFare: quote.previousFare,
          newFare: quote.newFare,
        }),
        tx,
      );
      return quote;
    });
  }
  private assertDestinationChangeable(ride: Ride, customerId: string): void {
    if (ride.customerId !== customerId) throw new RideCustomerMismatchError(ride.id);
    if (!(DESTINATION_CHANGE_STATUSES as readonly string[]).includes(ride.status)) {
      throw new DestinationChangeNotAllowedError(ride.status);
    }
  }
  private async priceDestination(ride: Ride, drop: DestinationInput): Promise<DestinationQuote> {
    const request = await this.requestRepo.findById(ride.requestId);
    if (!request) throw new RideNotFoundError(ride.requestId);
    const pickupLat = Number(request.pickupLat);
    const pickupLng = Number(request.pickupLng);
    const pickupContext = await this.geographicCoverageService.resolvePickupContext(
      pickupLat,
      pickupLng,
    );
    await this.geographicCoverageService.assertDropServiceable({
      lat: drop.dropLat,
      lng: drop.dropLng,
      cityCode: pickupContext.city.code,
    });
    const stops = (await this.requestRepo.findStops(request.id)).map((stop) => ({
      lat: Number(stop.lat),
      lng: Number(stop.lng),
    }));
    const trip = await this.pricingService.estimateRoute(
      routePoints(pickupLat, pickupLng, stops, drop.dropLat, drop.dropLng),
    );
    const fare = await this.pricingService.calculateFinalFare({
      actualDistanceKm: trip.distanceKm,
      actualDurationMin: trip.durationMin,
      vehicleTypeId: ride.vehicleTypeId,
      pricingRuleId: request.pricingRuleId ?? null,
      surgeMultiplier: Number(request.surgeMultiplier ?? 1),
    });
    const previousFare = request.quotedFare != null ? Number(request.quotedFare) : null;
    return {
      rideId: ride.id,
      drop: {
        latitude: drop.dropLat,
        longitude: drop.dropLng,
        address: drop.dropAddress ?? null,
      },
      previousFare,
      newFare: fare.totalFare,
      fareDifference: previousFare != null ? fare.totalFare - previousFare : null,
      estimatedDistanceKm: trip.distanceKm,
      estimatedDurationMin: trip.durationMin,
      currency: 'INR',
      fareBreakdown: fare,
    };
  }
}
