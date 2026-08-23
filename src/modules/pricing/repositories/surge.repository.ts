import { Prisma } from '../../../generated/prisma/index.js';
import type { ProviderClient } from '@core/database/index.js';
import type { SurgeZone, SurgeWindow } from '../../../generated/prisma/index.js';

export class SurgeRepository {
  constructor(private readonly db: { client: ProviderClient }) {}

  async findActiveZonesForLocation(lat: number, lng: number): Promise<SurgeZone[]> {
    // We only need to check if the point intersects with the zone boundary.
    // In PostGIS, geography ST_Intersects is the robust way to do containment.
    return this.db.client.$queryRaw<SurgeZone[]>`
      SELECT *
      FROM surge_zones
      WHERE is_active = true
        AND ST_Intersects(
          boundary,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
        )
    `;
  }

  async findActiveWindowsForZones(
    zoneIds: string[],
    vehicleTypeId?: string,
  ): Promise<SurgeWindow[]> {
    if (zoneIds.length === 0) return [];

    const now = new Date();

    // An active window is one where:
    // 1. isActive is true
    // 2. zoneId is in our matched zones
    // 3. startsAt <= now
    // 4. endsAt > now OR endsAt is null
    const whereClause: Prisma.SurgeWindowWhereInput = {
      zoneId: { in: zoneIds },
      isActive: true,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    };

    if (vehicleTypeId) {
      // If vehicleTypeId is provided, the window must either match it OR be null (applies to all)
      whereClause.AND = [
        {
          OR: [{ vehicleTypeId: null }, { vehicleTypeId: vehicleTypeId }],
        },
      ];
    }

    return this.db.client.surgeWindow.findMany({
      where: whereClause,
    });
  }
}
