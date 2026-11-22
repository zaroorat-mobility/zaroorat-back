import { DatabaseService } from '@core/database';
import type {
  CityCoverageMode,
  RideServiceType,
  ServiceZoneType,
} from '../../../generated/prisma/index.js';
import { GeographicMetrics } from '../metrics/location.metrics.js';
import {
  DropOutsideServiceAreaError,
  OutsideServiceAreaError,
  OutsideServiceZoneError,
  RestrictedZoneError,
  VehicleNotSupportedInZoneError,
} from '../errors/location.errors.js';

export interface ResolvedCity {
  id: string;
  code: string;
  name: string;
  /// FR-013. Peak-hour surge windows are wall-clock in the city the ride starts
  /// in, not on the server. Carried here so the surge path never has to go back
  /// to the database for it.
  timezone: string;
  coverageMode: CityCoverageMode;
  /// The legal surge limit in this city.
  maxSurgeMultiplier: number;
}

export interface ResolvedZone {
  id: string;
  code: string;
  name: string;
  zoneType: ServiceZoneType;
  allowsPickup: boolean;
  allowsDropoff: boolean;
  /// Shown to a rider refused here.
  riderMessage: string | null;
}

export type PickupRefusal = 'OUTSIDE_SERVICE_AREA' | 'RESTRICTED_ZONE' | 'OUTSIDE_SERVICE_ZONE';
export type DropRefusal = 'DROP_OUTSIDE_SERVICE_AREA' | 'RESTRICTED_ZONE';

/// Whether a ride can start here, and why not. Booking, the rider app and the
/// admin test tool all read this, so they cannot give different answers.
export interface PickupDecision {
  allowed: boolean;
  refusal: PickupRefusal | null;
  /// The blocking zone's rider message, if it has one.
  message: string | null;
  /// Null only when the point is outside every city.
  city: ResolvedCity | null;
  zones: ResolvedZone[];
  coverageConfigured: boolean;
}

export interface DropDecision {
  allowed: boolean;
  refusal: DropRefusal | null;
  message: string | null;
}

/// The pickup point resolved once, for every category to share.
export interface PickupContext {
  city: ResolvedCity;
  cityTimeZone: string;
  zones: ResolvedZone[];
  /// False when BD-10's unconfigured-coverage fallback applied, in which case the
  /// zone-based checks have nothing to check against.
  coverageConfigured: boolean;
}

export interface PickupServiceabilityInput {
  lat: number;
  lng: number;
  vehicleTypeId: string;
  serviceType?: RideServiceType;
}

export interface DropServiceabilityInput {
  lat: number;
  lng: number;
  cityCode: string;
}

/// BD-10's fallback identity. Only `code` is read downstream — `rateCardForTypeId`
/// turns it into the `['GLOBAL']` lookup that prices a ride when no city owns the
/// pickup point. The id is deliberately empty rather than invented: nothing may
/// join on it, and an empty string fails loudly if anything ever tries.
const UNCONFIGURED_COVERAGE_CITY: ResolvedCity = Object.freeze({
  id: '',
  code: 'GLOBAL',
  name: 'Unconfigured coverage',
  timezone: 'Asia/Kolkata',
  coverageMode: 'WHOLE_CITY',
  maxSurgeMultiplier: 2,
});

/// Zones where a ride can start. RESTRICTED and SURGE are never coverage.
const isCoverageZone = (zone: ResolvedZone): boolean =>
  zone.zoneType === 'SERVICE' || zone.zoneType === 'AIRPORT';

export class GeographicCoverageService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly geographicMetrics: GeographicMetrics,
  ) {}

  /// BD-10. Distinguishes "configured and this point is outside it" from "no
  /// coverage has been drawn at all".
  ///
  /// Checked only after `resolveCityAtPoint` has already failed, so a request
  /// inside a covered city never pays for this query. That ordering matters:
  /// `assertPickupServiceable` is called once per vehicle category today
  /// (FR-039 fixes that separately), and an unconditional check here would
  /// multiply by the size of the catalog.
  private async isCoverageConfigured(): Promise<boolean> {
    const rows = await this.databaseService.client.$queryRaw<Array<{ configured: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM cities
        WHERE is_active = true AND code != 'GLOBAL' AND boundary IS NOT NULL
      ) AS configured
    `;
    return rows[0]?.configured ?? false;
  }

  async resolveCityAtPoint(lat: number, lng: number): Promise<ResolvedCity | null> {
    const rows = await this.databaseService.client.$queryRaw<
      Array<{
        id: string;
        code: string;
        name: string;
        timezone: string;
        coverage_mode: CityCoverageMode;
        max_surge_multiplier: number;
      }>
    >`
      SELECT id, code, name, timezone, coverage_mode, max_surge_multiplier::float8
      FROM cities
      WHERE is_active = true
        AND code != 'GLOBAL'
        AND boundary IS NOT NULL
        AND ST_Contains(boundary::geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
      ORDER BY launched_at DESC NULLS LAST
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      timezone: row.timezone,
      coverageMode: row.coverage_mode,
      maxSurgeMultiplier: row.max_surge_multiplier,
    };
  }

  /// FR-005. Precedence, in order: an explicit `priority` an operator set, then
  /// the *smallest* containing polygon, then creation order.
  ///
  /// Area is the tie-break rather than an afterthought. Zones nest — an airport
  /// sits inside the citywide zone that contains it — and the specific one is
  /// always the one that should win. Ordering by `created_at` alone returned
  /// whichever polygon was drawn first, so the airport's own pricing rule was
  /// never probed and `pricing-rule-resolution.test.ts` failed asserting exactly
  /// that. Requiring an operator to set a priority for the obvious case would
  /// have left the same trap armed by default; `priority` is the override for
  /// deliberate exceptions, not the mechanism for the ordinary layout.
  async resolveZonesAtPoint(cityCode: string, lat: number, lng: number): Promise<ResolvedZone[]> {
    const rows = await this.databaseService.client.$queryRaw<
      Array<{
        id: string;
        code: string;
        name: string;
        zone_type: ServiceZoneType;
        allows_pickup: boolean;
        allows_dropoff: boolean;
        rider_message: string | null;
      }>
    >`
      SELECT sz.id, sz.code, sz.name, sz.zone_type, sz.allows_pickup, sz.allows_dropoff, sz.rider_message
      FROM service_zones sz
      INNER JOIN cities c ON c.id = sz.city_id
      WHERE c.code = ${cityCode}
        AND sz.is_active = true
        AND ST_Contains(sz.boundary::geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
      ORDER BY sz.priority DESC, ST_Area(sz.boundary) ASC, sz.created_at ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      zoneType: r.zone_type,
      allowsPickup: r.allows_pickup,
      allowsDropoff: r.allows_dropoff,
      riderMessage: r.rider_message,
    }));
  }

  /// The rule for where a ride can start, in order: inside a city, no zone says no,
  /// and in a zones-only city, inside one of its zones. Reads only, so the rider's
  /// pin check and the admin test tool can ask as often as they like.
  async evaluatePickup(lat: number, lng: number): Promise<PickupDecision> {
    const city = await this.resolveCityAtPoint(lat, lng);
    if (!city) {
      const configured = await this.isCoverageConfigured();
      return {
        allowed: !configured,
        refusal: configured ? 'OUTSIDE_SERVICE_AREA' : null,
        message: null,
        city: configured ? null : UNCONFIGURED_COVERAGE_CITY,
        zones: [],
        coverageConfigured: configured,
      };
    }

    const zones = await this.resolveZonesAtPoint(city.code, lat, lng);
    const decide = (refusal: PickupRefusal | null, message: string | null): PickupDecision => ({
      allowed: refusal === null,
      refusal,
      message,
      city,
      zones,
      coverageConfigured: true,
    });

    const restricted = zones.find((z) => z.zoneType === 'RESTRICTED' && !z.allowsPickup);
    if (restricted) return decide('RESTRICTED_ZONE', restricted.riderMessage);

    const closed = zones.find((z) => !z.allowsPickup);
    if (closed) return decide('OUTSIDE_SERVICE_ZONE', closed.riderMessage);

    if (city.coverageMode === 'ZONES_ONLY' && !zones.some(isCoverageZone)) {
      return decide('OUTSIDE_SERVICE_ZONE', null);
    }
    return decide(null, null);
  }

  /// The rule for where a ride can end. A zones-only city limits where rides start,
  /// not where they end, and a drop just past the boundary is allowed for suburbs.
  async evaluateDrop(input: DropServiceabilityInput): Promise<DropDecision> {
    const refuse = (refusal: DropRefusal, message: string | null): DropDecision => ({
      allowed: false,
      refusal,
      message,
    });
    const allow: DropDecision = { allowed: true, refusal: null, message: null };

    // BD-10 again. The pickup gate already stood down for this request, so the
    // drop gate must too — otherwise an unconfigured platform quotes a pickup
    // and then refuses its destination.
    if (input.cityCode === UNCONFIGURED_COVERAGE_CITY.code) return allow;

    const city = await this.resolveCityAtPoint(input.lat, input.lng);
    if (city && city.code !== input.cityCode) return refuse('DROP_OUTSIDE_SERVICE_AREA', null);

    if (!city) {
      const nearby = await this.databaseService.client.$queryRaw<Array<{ code: string }>>`
        SELECT code
        FROM cities
        WHERE is_active = true
          AND code = ${input.cityCode}
          AND boundary IS NOT NULL
          AND ST_DWithin(
            boundary::geography,
            ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
            ${GeographicCoverageService.DROP_CITY_BUFFER_METERS}
          )
        LIMIT 1
      `;
      return nearby.length > 0 ? allow : refuse('DROP_OUTSIDE_SERVICE_AREA', null);
    }

    const zones = await this.resolveZonesAtPoint(city.code, input.lat, input.lng);
    const restricted = zones.find((z) => z.zoneType === 'RESTRICTED' && !z.allowsDropoff);
    if (restricted) return refuse('RESTRICTED_ZONE', restricted.riderMessage);

    const closed = zones.find((z) => !z.allowsDropoff);
    if (closed) return refuse('DROP_OUTSIDE_SERVICE_AREA', closed.riderMessage);

    return allow;
  }

  /// FR-039. The part of pickup serviceability that does not depend on the
  /// vehicle type, resolved once.
  ///
  /// `assertPickupServiceable` was called once per category in the multi-category
  /// quote, and each call ran a city ST_Contains, a zone ST_Contains and a zone
  /// count — for a pickup point that is identical across every category. Six
  /// categories meant eighteen spatial queries to answer the same question six
  /// times.
  async resolvePickupContext(lat: number, lng: number): Promise<PickupContext> {
    const decision = await this.evaluatePickup(lat, lng);
    if (!decision.coverageConfigured) this.geographicMetrics.coverageUnconfigured({ lat, lng });
    if (decision.refusal === 'OUTSIDE_SERVICE_AREA') this.geographicMetrics.pickupOutsideCoverage();

    if (decision.refusal || !decision.city) {
      this.geographicMetrics.pickupRefused({
        reason: decision.refusal ?? 'UNKNOWN',
        cityCode: decision.city?.code ?? 'NONE',
      });
      const message = decision.message ?? undefined;
      if (decision.refusal === 'RESTRICTED_ZONE') throw new RestrictedZoneError(message);
      if (decision.refusal === 'OUTSIDE_SERVICE_ZONE') throw new OutsideServiceZoneError(message);
      throw new OutsideServiceAreaError(message);
    }

    return {
      city: decision.city,
      cityTimeZone: decision.city.timezone,
      zones: decision.zones,
      coverageConfigured: decision.coverageConfigured,
    };
  }

  /// The per-category half: whether this zone admits this vehicle type. Cheap,
  /// and genuinely varies per category, so it stays in the loop. A zone with no
  /// vehicle list admits every type, including one added later.
  async assertVehicleTypeServiceable(context: PickupContext, vehicleTypeId: string): Promise<void> {
    if (!(await this.isVehicleTypeAllowed(context.zones, vehicleTypeId))) {
      throw new VehicleNotSupportedInZoneError();
    }
  }

  async isVehicleTypeAllowed(
    zones: readonly ResolvedZone[],
    vehicleTypeId: string,
  ): Promise<boolean> {
    const zone = zones.find(isCoverageZone);
    if (!zone) return true;

    const listed = await this.databaseService.client.serviceZoneVehicleType.findMany({
      where: { serviceZoneId: zone.id },
      select: { vehicleTypeId: true },
    });
    return listed.length === 0 || listed.some((row) => row.vehicleTypeId === vehicleTypeId);
  }

  async assertPickupServiceable(input: PickupServiceabilityInput): Promise<ResolvedCity> {
    const context = await this.resolvePickupContext(input.lat, input.lng);
    await this.assertVehicleTypeServiceable(context, input.vehicleTypeId);
    return context.city;
  }

  /// Suburbs sit a few kilometres past a tightly drawn city polygon (Hadapsar,
  /// Kondhwa, Wakad). 25 km still refuses a different metro.
  private static readonly DROP_CITY_BUFFER_METERS = 25_000;

  async assertDropServiceable(input: DropServiceabilityInput): Promise<void> {
    const decision = await this.evaluateDrop(input);
    if (decision.refusal === 'RESTRICTED_ZONE') {
      throw new RestrictedZoneError(decision.message ?? 'Drop-off is in a restricted zone');
    }
    if (decision.refusal) throw new DropOutsideServiceAreaError(decision.message ?? undefined);
  }

  async resolveServiceZoneIdAtPoint(
    cityCode: string,
    lat: number,
    lng: number,
  ): Promise<string | null> {
    return (await this.resolveServiceZoneIdsAtPoint(cityCode, lat, lng))[0] ?? null;
  }

  /// The zones a fare can come from at this point, most specific first.
  async resolveServiceZoneIdsAtPoint(
    cityCode: string,
    lat: number,
    lng: number,
  ): Promise<string[]> {
    const zones = await this.resolveZonesAtPoint(cityCode, lat, lng);
    return zones.filter(isCoverageZone).map((zone) => zone.id);
  }
}
