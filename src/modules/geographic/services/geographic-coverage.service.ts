import { DatabaseService } from '@core/database';
import type { RideServiceType, ServiceZoneType } from '../../../generated/prisma/index.js';
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
}

export interface ResolvedZone {
  id: string;
  code: string;
  name: string;
  zoneType: ServiceZoneType;
  allowsPickup: boolean;
  allowsDropoff: boolean;
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

export class GeographicCoverageService {
  constructor(private readonly databaseService: DatabaseService) {}

  async resolveCityAtPoint(lat: number, lng: number): Promise<ResolvedCity | null> {
    const rows = await this.databaseService.client.$queryRaw<
      Array<{ id: string; code: string; name: string }>
    >`
      SELECT id, code, name
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
      ORDER BY sz.created_at ASC
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

  async assertPickupServiceable(input: PickupServiceabilityInput): Promise<ResolvedCity> {
    const city = await this.resolveCityAtPoint(input.lat, input.lng);
    if (!city) {
      throw new OutsideServiceAreaError();
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
