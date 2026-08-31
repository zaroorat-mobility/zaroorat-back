import { Prisma } from '../../../generated/prisma/index.js';
import type { ProviderClient } from '@core/database/index.js';
import { GeographicCoverageService } from '@modules/location';
import type { SurgeZone, SurgeWindow } from '../../../generated/prisma/index.js';

/// The zones a pickup point falls in, from both geographies.
///
/// BD-4 makes `ServiceZone` the single polygon of record, but the previous
/// application version is still running during a rollout and still writes surge
/// windows against `SurgeZone`, and the migration deliberately backfilled only
/// the windows it could match without guessing. So for one release a point
/// resolves through both, and a window matches on whichever link it carries.
export interface ResolvedSurgeZones {
  serviceZoneIds: string[];
  legacySurgeZoneIds: string[];
}

export class SurgeRepository {
  constructor(
    private readonly db: { client: ProviderClient },
    private readonly geographicCoverageService: GeographicCoverageService,
  ) {}

  /// FR-015. Resolves the geographic module's zones for this point, and the
  /// legacy surge polygons alongside them.
  async findZonesForLocation(
    lat: number,
    lng: number,
    cityCode?: string,
  ): Promise<ResolvedSurgeZones> {
    const serviceZoneIds: string[] = [];
    if (cityCode && cityCode !== 'GLOBAL') {
      const zones = await this.geographicCoverageService.resolveZonesAtPoint(cityCode, lat, lng);
      serviceZoneIds.push(...zones.map((zone) => zone.id));
    }
    const legacy = await this.findActiveZonesForLocation(lat, lng);
    return { serviceZoneIds, legacySurgeZoneIds: legacy.map((zone) => zone.id) };
  }

  /// @deprecated BD-4. The legacy polygon table. Retained until the follow-up
  /// release drops `surge_zones`; new configuration should point a window at a
  /// `ServiceZone` instead.
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

  /// Windows in force right now for any of the given zones.
  ///
  /// `vehicleTypeId` is deliberately optional: FR-039's batched path resolves
  /// every category from one query and filters in memory, because the containment
  /// work does not vary by category and running it per category was most of the
  /// cost of a multi-category quote.
  async findActiveWindowsForZones(
    zoneIds: string[],
    vehicleTypeId?: string,
    serviceZoneIds: string[] = [],
  ): Promise<SurgeWindow[]> {
    if (zoneIds.length === 0 && serviceZoneIds.length === 0) return [];

    const now = new Date();

    // An active window is one where:
    // 1. isActive is true
    // 2. it is linked to one of our matched zones, by either geography
    // 3. startsAt <= now
    // 4. endsAt > now OR endsAt is null
    const linkedToAZone: Prisma.SurgeWindowWhereInput[] = [];
    if (serviceZoneIds.length > 0) {
      linkedToAZone.push({ serviceZoneId: { in: serviceZoneIds } });
    }
    if (zoneIds.length > 0) {
      // Only windows that were NOT backfilled still resolve through the legacy
      // polygon; a window carrying a service zone is resolved by that alone, so
      // the two paths cannot double-count the same window.
      linkedToAZone.push({ serviceZoneId: null, zoneId: { in: zoneIds } });
    }

    const whereClause: Prisma.SurgeWindowWhereInput = {
      isActive: true,
      startsAt: { lte: now },
      AND: [{ OR: linkedToAZone }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
    };

    if (vehicleTypeId) {
      // If vehicleTypeId is provided, the window must either match it OR be null (applies to all)
      (whereClause.AND as Prisma.SurgeWindowWhereInput[]).push({
        OR: [{ vehicleTypeId: null }, { vehicleTypeId }],
      });
    }

    return this.db.client.surgeWindow.findMany({ where: whereClause });
  }
}
