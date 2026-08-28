import type { ProviderClient } from '@core/database/index.js';
import type { PricingRule, RideServiceType } from '../../../generated/prisma/index.js';

export interface FindBestActiveRuleParams {
  vehicleTypeId: string;
  cityCode?: string | undefined;
  serviceType?: RideServiceType | undefined;
  pickupLat?: number | undefined;
  pickupLng?: number | undefined;
}

export class PricingRuleRepository {
  constructor(private readonly db: { client: ProviderClient }) {}

  /** @deprecated Prefer findBestActiveRule */
  async findActiveRule(vehicleTypeId: string, cityCode: string): Promise<PricingRule | null> {
    return this.findBestActiveRule({ vehicleTypeId, cityCode, serviceType: 'INSTANT' });
  }

  async resolveServiceZoneAtPoint(
    cityCode: string,
    lat: number,
    lng: number,
  ): Promise<string | null> {
    const rows = await this.db.client.$queryRaw<Array<{ id: string }>>`
      SELECT sz.id
      FROM service_zones sz
      INNER JOIN cities c ON c.id = sz.city_id
      WHERE c.code = ${cityCode}
        AND sz.is_active = true
        AND ST_Contains(
          sz.boundary::geometry,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
        )
      ORDER BY sz.created_at ASC
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  async findBestActiveRule(params: FindBestActiveRuleParams): Promise<PricingRule | null> {
    const serviceType = params.serviceType ?? 'INSTANT';
    let resolvedZoneId: string | null = null;
    if (
      params.cityCode &&
      params.cityCode !== 'GLOBAL' &&
      params.pickupLat != null &&
      params.pickupLng != null
    ) {
      resolvedZoneId = await this.resolveServiceZoneAtPoint(
        params.cityCode,
        params.pickupLat,
        params.pickupLng,
      );
    }

    const cityCodes =
      params.cityCode && params.cityCode !== 'GLOBAL' ? [params.cityCode, 'GLOBAL'] : ['GLOBAL'];

    for (const cityCode of cityCodes) {
      const candidates = await this.db.client.pricingRule.findMany({
        where: {
          vehicleTypeId: params.vehicleTypeId,
          cityCode,
          isActive: true,
        },
        orderBy: { effectiveFrom: 'desc' },
      });

      const tries: Array<{ zoneId: string | null; svc: RideServiceType | null }> = [];
      if (resolvedZoneId) {
        tries.push({ zoneId: resolvedZoneId, svc: serviceType });
        tries.push({ zoneId: resolvedZoneId, svc: null });
      }
      tries.push({ zoneId: null, svc: serviceType });
      tries.push({ zoneId: null, svc: null });

      for (const attempt of tries) {
        const match = candidates.find(
          (row) =>
            (row.serviceZoneId ?? null) === attempt.zoneId &&
            (row.serviceType ?? null) === attempt.svc,
        );
        if (match) return match;
      }
    }

    return null;
  }
}
