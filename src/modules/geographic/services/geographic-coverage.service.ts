import { DatabaseService } from '@core/database';
import type { RideServiceType, ServiceZoneType } from '../../../generated/prisma/index.js';
import { GeographicMetrics } from '../metrics/geographic.metrics.js';
import {
  DropOutsideServiceAreaError,
  OutsideServiceAreaError,
  OutsideServiceZoneError,
  RestrictedZoneError,
  VehicleNotSupportedInZoneError,
} from '../errors/geographic.errors.js';

export interface ResolvedCity {
  id: string;
  code: string;
  name: string;
  /// FR-013. Peak-hour surge windows are wall-clock in the city the ride starts
  /// in, not on the server. Carried here so the surge path never has to go back
  /// to the database for it.
  timezone: string;
}

export interface ResolvedZone {
  id: string;
  code: string;
  name: string;
  zoneType: ServiceZoneType;
  allowsPickup: boolean;
  allowsDropoff: boolean;
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
});

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
      Array<{ id: string; code: string; name: string; timezone: string }>
    >`
      SELECT id, code, name, timezone
      FROM cities
      WHERE is_active = true
        AND code != 'GLOBAL'
        AND boundary IS NOT NULL
        AND ST_Contains(boundary::geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
      ORDER BY launched_at DESC NULLS LAST
      LIMIT 1
    `;
    return rows[0] ?? null;
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
      }>
    >`
      SELECT sz.id, sz.code, sz.name, sz.zone_type, sz.allows_pickup, sz.allows_dropoff
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
    }));
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
    const city = await this.resolveCityAtPoint(lat, lng);
    if (!city) {
      if (await this.isCoverageConfigured()) {
        this.geographicMetrics.pickupOutsideCoverage();
        throw new OutsideServiceAreaError();
      }
      this.geographicMetrics.coverageUnconfigured({ lat, lng });
      return {
        city: UNCONFIGURED_COVERAGE_CITY,
        cityTimeZone: UNCONFIGURED_COVERAGE_CITY.timezone,
        zones: [],
        coverageConfigured: false,
      };
    }

    const zones = await this.resolveZonesAtPoint(city.code, lat, lng);
    const restricted = zones.find((z) => z.zoneType === 'RESTRICTED');
    if (restricted && !restricted.allowsPickup) {
      throw new RestrictedZoneError();
    }
    return { city, cityTimeZone: city.timezone, zones, coverageConfigured: true };
  }

  /// The per-category half: whether this zone admits this vehicle type. Cheap,
  /// and genuinely varies per category, so it stays in the loop.
  async assertVehicleTypeServiceable(context: PickupContext, vehicleTypeId: string): Promise<void> {
    if (!context.coverageConfigured) return;

    const coverageZones = await this.databaseService.client.serviceZone.count({
      where: {
        city: { code: context.city.code },
        isActive: true,
        zoneType: { in: ['SERVICE', 'AIRPORT'] },
      },
    });
    if (coverageZones === 0) return;

    const serviceable = context.zones.filter(
      (z) => (z.zoneType === 'SERVICE' || z.zoneType === 'AIRPORT') && z.allowsPickup,
    );
    if (serviceable.length === 0) {
      throw new OutsideServiceZoneError();
    }

    const best = serviceable[0]!;
    const restrictions = await this.databaseService.client.serviceZoneVehicleType.count({
      where: { serviceZoneId: best.id },
    });
    if (restrictions > 0) {
      const allowed = await this.databaseService.client.serviceZoneVehicleType.findFirst({
        where: { serviceZoneId: best.id, vehicleTypeId },
      });
      if (!allowed) {
        throw new VehicleNotSupportedInZoneError();
      }
    }
  }

  async assertPickupServiceable(input: PickupServiceabilityInput): Promise<ResolvedCity> {
    const city = await this.resolveCityAtPoint(input.lat, input.lng);
    if (!city) {
      // BD-10. Refusing every pickup is correct when coverage exists and this
      // point is outside it. It is not correct when no coverage has been drawn:
      // that state made the platform unable to quote or book a single ride, and
      // nothing said so — 12 of the 24 committed catalog tests failed on it.
      if (await this.isCoverageConfigured()) {
        this.geographicMetrics.pickupOutsideCoverage();
        throw new OutsideServiceAreaError();
      }
      this.geographicMetrics.coverageUnconfigured({ lat: input.lat, lng: input.lng });
      return UNCONFIGURED_COVERAGE_CITY;
    }

    const zones = await this.resolveZonesAtPoint(city.code, input.lat, input.lng);
    const restricted = zones.find((z) => z.zoneType === 'RESTRICTED');
    if (restricted && !restricted.allowsPickup) {
      throw new RestrictedZoneError();
    }

    const coverageZones = await this.databaseService.client.serviceZone.count({
      where: {
        city: { code: city.code },
        isActive: true,
        zoneType: { in: ['SERVICE', 'AIRPORT'] },
      },
    });

    if (coverageZones > 0) {
      const serviceable = zones.filter(
        (z) => (z.zoneType === 'SERVICE' || z.zoneType === 'AIRPORT') && z.allowsPickup,
      );
      if (serviceable.length === 0) {
        throw new OutsideServiceZoneError();
      }

      const best = serviceable[0]!;
      const restrictions = await this.databaseService.client.serviceZoneVehicleType.count({
        where: { serviceZoneId: best.id },
      });
      if (restrictions > 0) {
        const allowed = await this.databaseService.client.serviceZoneVehicleType.findFirst({
          where: { serviceZoneId: best.id, vehicleTypeId: input.vehicleTypeId },
        });
        if (!allowed) {
          throw new VehicleNotSupportedInZoneError();
        }
      }
    }

    return city;
  }

  async assertDropServiceable(input: DropServiceabilityInput): Promise<void> {
    // BD-10 again. The pickup gate already stood down for this request, so the
    // drop gate must too — otherwise an unconfigured platform quotes a pickup
    // and then refuses its destination.
    if (input.cityCode === UNCONFIGURED_COVERAGE_CITY.code) return;

    const city = await this.resolveCityAtPoint(input.lat, input.lng);
    if (!city || city.code !== input.cityCode) {
      throw new DropOutsideServiceAreaError();
    }

    const zones = await this.resolveZonesAtPoint(city.code, input.lat, input.lng);
    const restricted = zones.find((z) => z.zoneType === 'RESTRICTED');
    if (restricted && !restricted.allowsDropoff) {
      throw new RestrictedZoneError('Drop-off is in a restricted zone');
    }
  }

  async resolveServiceZoneIdAtPoint(
    cityCode: string,
    lat: number,
    lng: number,
  ): Promise<string | null> {
    const zones = await this.resolveZonesAtPoint(cityCode, lat, lng);
    const match = zones.find((z) => z.zoneType === 'SERVICE' || z.zoneType === 'AIRPORT');
    return match?.id ?? null;
  }
}
