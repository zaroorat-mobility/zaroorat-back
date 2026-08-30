import { Prisma } from '../../../../generated/prisma/index.js';
import type { DatabaseService } from '@core/database';
import type { SurgeZone } from '../../../../generated/prisma/index.js';
import { assertValidPolygon, polygonGeoJson } from '../../../geographic/utils/postgis.js';
import { uuidV7 } from '@shared/crypto';
import { recordAdminAction } from '../../audit/index.js';
import { SurgeWindowNotFoundError, SurgeZoneNotFoundError } from '../pricing.errors.js';

/// FR-014. The admin view of a surge window, with the two inert threshold
/// columns gone. They remain on the table until the deferred-drop release
/// (constitution 16.2 — the previous application version still selects them),
/// but nothing writes or returns them any more.
export interface SurgeWindowDto {
  id: string;
  serviceZoneId: string | null;
  /// @deprecated BD-4. Null for windows created against a service zone.
  zoneId: string | null;
  vehicleTypeId: string | null;
  multiplier: Prisma.Decimal;
  source: string;
  reason: string | null;
  peakHourStart: string | null;
  peakHourEnd: string | null;
  isPeakHourOnly: boolean;
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  zoneName?: string | undefined;
  vehicleTypeCode?: string | null | undefined;
}

export interface SurgeZoneDetail extends Pick<
  SurgeZone,
  'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'
> {
  boundary: number[][][];
}

interface SurgeWindowRow {
  id: string;
  serviceZoneId: string | null;
  zoneId: string | null;
  vehicleTypeId: string | null;
  multiplier: Prisma.Decimal;
  source: string;
  reason: string | null;
  peakHourStart: string | null;
  peakHourEnd: string | null;
  isPeakHourOnly: boolean;
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  zone?: { name: string } | null;
  serviceZone?: { name: string } | null;
  vehicleType?: { code: string } | null;
}

/// FR-014. The single place a surge window becomes a response.
///
/// `demandThresholdPct` and `supplyThresholdPct` are simply absent: they are
/// still columns until the deferred drop, but nothing writes them and nothing
/// returns them, so they can no longer be mistaken for a configured behaviour.
function toWindowDto(row: SurgeWindowRow): SurgeWindowDto {
  return {
    id: row.id,
    serviceZoneId: row.serviceZoneId,
    zoneId: row.zoneId,
    vehicleTypeId: row.vehicleTypeId,
    multiplier: row.multiplier,
    source: row.source,
    reason: row.reason,
    peakHourStart: row.peakHourStart,
    peakHourEnd: row.peakHourEnd,
    isPeakHourOnly: row.isPeakHourOnly,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isActive: row.isActive,
    createdAt: row.createdAt,
    ...((row.serviceZone?.name ?? row.zone?.name)
      ? { zoneName: row.serviceZone?.name ?? row.zone?.name }
      : {}),
    ...(row.vehicleType !== undefined ? { vehicleTypeCode: row.vehicleType?.code ?? null } : {}),
  };
}

export class AdminSurgeService {
  constructor(private readonly db: DatabaseService) {}

  /// FR-032. `assertValidPolygon` guarded the update path but not this one, so a
  /// self-intersecting or unclosed ring could be inserted here and would then
  /// make every `ST_Intersects` against it raise at query time — turning a bad
  /// admin input into a failure in the surge lookup on the booking path.
  async createSurgeZone(
    data: {
      cityCode: string;
      name: string;
      coordinates: number[][][];
    },
    actorId?: string,
  ): Promise<SurgeZone> {
    await assertValidPolygon(this.db, data.coordinates);

    const geoJson = polygonGeoJson(data.coordinates);

    return this.db.transactionManager.execute(async (tx) => {
      // D5. `@default(uuid(7))` is client-side in Prisma — `surge_zones.id` has
      // no column default — so `gen_random_uuid()` was the only thing supplying
      // an id here, and it gave this table v4 ids while the rest of the schema
      // is v7. `uuidV7` is the generator the codebase already uses.
      const [zone] = await tx.$queryRaw<SurgeZone[]>`
        INSERT INTO surge_zones (id, city_code, name, boundary)
        VALUES (
          ${uuidV7()}::uuid,
          ${data.cityCode},
          ${data.name},
          ST_GeomFromGeoJSON(${geoJson})
        )
        RETURNING id, city_code AS "cityCode", name, is_active AS "isActive", created_at AS "createdAt"
      `;
      const created = zone as SurgeZone;
      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'surge_zone',
        entityId: created.id,
        summary: `Created surge zone ${created.name} in ${created.cityCode}`,
        after: { cityCode: created.cityCode, name: created.name, isActive: created.isActive },
      });
      return created;
    });
  }

  async listSurgeZones(): Promise<
    Pick<SurgeZone, 'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'>[]
  > {
    return this.db.client.$queryRaw<
      Pick<SurgeZone, 'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'>[]
    >`
      SELECT id, city_code AS "cityCode", name, is_active AS "isActive", created_at AS "createdAt"
      FROM surge_zones
      ORDER BY created_at DESC
    `;
  }

  async getSurgeZone(id: string): Promise<SurgeZoneDetail | null> {
    const zones = await this.db.client.$queryRaw<
      Array<
        Pick<SurgeZone, 'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'> & {
          boundary: string;
        }
      >
    >`
      SELECT
        id,
        city_code AS "cityCode",
        name,
        is_active AS "isActive",
        created_at AS "createdAt",
        ST_AsGeoJSON(boundary::geometry) AS boundary
      FROM surge_zones
      WHERE id = ${id}::uuid
    `;
    const row = zones[0];
    if (!row) return null;
    const parsed = JSON.parse(row.boundary) as { coordinates: number[][][] };
    return {
      id: row.id,
      cityCode: row.cityCode,
      name: row.name,
      isActive: row.isActive,
      createdAt: row.createdAt,
      boundary: parsed.coordinates,
    };
  }

  /// FR-033. Every write here is a raw `UPDATE ... WHERE id = $1`, which affects
  /// zero rows for an unknown id and reports nothing. The controller then sent
  /// `{ success: true }`. Reading the row first is what turns that into a 404.
  ///
  /// FR-031. The boundary and the columns are one change: the previous code could
  /// replace a polygon and then fail to apply the name beside it.
  async updateSurgeZone(
    id: string,
    data: {
      name?: string | undefined;
      isActive?: boolean | undefined;
      coordinates?: number[][][] | undefined;
    },
    actorId?: string,
  ): Promise<void> {
    const existing = await this.db.client.surgeZone.findUnique({
      where: { id },
      select: { id: true, name: true, cityCode: true, isActive: true },
    });
    if (!existing) throw new SurgeZoneNotFoundError();

    if (data.coordinates) {
      await assertValidPolygon(this.db, data.coordinates);
    }

    await this.db.transactionManager.execute(async (tx) => {
      if (data.coordinates) {
        const geoJson = polygonGeoJson(data.coordinates);
        await tx.$executeRaw`
          UPDATE surge_zones SET boundary = ST_GeomFromGeoJSON(${geoJson}) WHERE id = ${id}::uuid
        `;
      }

      if (data.name !== undefined || data.isActive !== undefined) {
        await tx.surgeZone.update({
          where: { id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'surge_zone',
        entityId: id,
        summary: `Updated surge zone ${existing.name}`,
        before: { name: existing.name, isActive: existing.isActive },
        after: {
          name: data.name ?? existing.name,
          isActive: data.isActive ?? existing.isActive,
          ...(data.coordinates ? { boundaryReplaced: true } : {}),
        },
      });
    });
  }

  async deleteSurgeZone(id: string, actorId?: string): Promise<void> {
    await this.updateSurgeZone(id, { isActive: false }, actorId);
  }

  async createSurgeWindow(
    data: {
      serviceZoneId?: string | undefined;
      zoneId?: string | undefined;
      vehicleTypeId?: string | undefined;
      multiplier: number;
      startsAt: Date;
      endsAt?: Date | undefined;
      reason?: string | undefined;
      peakHourStart?: string | undefined;
      peakHourEnd?: string | undefined;
      isPeakHourOnly?: boolean | undefined;
    },
    actorId?: string,
  ): Promise<SurgeWindowDto> {
    // BD-4. A window needs a zone from one geography or the other. A
    // `serviceZoneId` is the supported form; `zoneId` is accepted only while
    // legacy surge polygons still exist.
    if (!data.serviceZoneId && !data.zoneId) {
      throw new Error('A surge window requires a serviceZoneId');
    }

    return this.db.transactionManager.execute(async (tx) => {
      const created = await tx.surgeWindow.create({
        data: {
          ...(data.serviceZoneId !== undefined ? { serviceZoneId: data.serviceZoneId } : {}),
          // Null unless a legacy surge polygon was named. `zone_id` carries a
          // foreign key to `surge_zones`, so it cannot be filled with a service
          // zone's id — the migration makes it nullable for exactly this reason.
          ...(data.zoneId !== undefined ? { zoneId: data.zoneId } : {}),
          vehicleTypeId: data.vehicleTypeId ?? null,
          multiplier: new Prisma.Decimal(data.multiplier),
          startsAt: data.startsAt,
          endsAt: data.endsAt ?? null,
          reason: data.reason ?? null,
          ...(data.peakHourStart !== undefined ? { peakHourStart: data.peakHourStart } : {}),
          ...(data.peakHourEnd !== undefined ? { peakHourEnd: data.peakHourEnd } : {}),
          ...(data.isPeakHourOnly !== undefined ? { isPeakHourOnly: data.isPeakHourOnly } : {}),
        },
        include: {
          zone: { select: { name: true } },
          serviceZone: { select: { name: true } },
          vehicleType: { select: { code: true } },
        },
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'surge_window',
        entityId: created.id,
        summary: `Created surge window at ${String(data.multiplier)}x`,
        after: {
          serviceZoneId: created.serviceZoneId,
          zoneId: created.zoneId,
          vehicleTypeId: created.vehicleTypeId,
          multiplier: created.multiplier,
          startsAt: created.startsAt,
          endsAt: created.endsAt,
          peakHourStart: created.peakHourStart,
          peakHourEnd: created.peakHourEnd,
          isPeakHourOnly: created.isPeakHourOnly,
        },
      });
      return toWindowDto(created);
    });
  }

  async listSurgeWindows(): Promise<SurgeWindowDto[]> {
    const windows = await this.db.client.surgeWindow.findMany({
      include: {
        zone: { select: { name: true } },
        serviceZone: { select: { name: true } },
        vehicleType: { select: { code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return windows.map(toWindowDto);
  }

  async getSurgeWindow(id: string): Promise<SurgeWindowDto | null> {
    const row = await this.db.client.surgeWindow.findUnique({
      where: { id },
      include: {
        zone: { select: { name: true } },
        serviceZone: { select: { name: true } },
        vehicleType: { select: { code: true } },
      },
    });
    return row ? toWindowDto(row) : null;
  }

  async updateSurgeWindow(
    id: string,
    data: {
      multiplier?: number | undefined;
      startsAt?: Date | undefined;
      endsAt?: Date | undefined;
      isActive?: boolean | undefined;
      reason?: string | undefined;
      peakHourStart?: string | null | undefined;
      peakHourEnd?: string | null | undefined;
      isPeakHourOnly?: boolean | undefined;
    },
    actorId?: string,
  ): Promise<SurgeWindowDto> {
    /// FR-033. Prisma's `update` on a missing id raises P2025, which the pricing
    /// error handler does not recognise as a coded error and so reports as a 500.
    /// Reading first turns a mistyped id into the 404 it is.
    const existing = await this.db.client.surgeWindow.findUnique({ where: { id } });
    if (!existing) throw new SurgeWindowNotFoundError();

    const updateData: Record<string, unknown> = {};
    if (data.multiplier !== undefined) updateData.multiplier = new Prisma.Decimal(data.multiplier);
    if (data.startsAt !== undefined) updateData.startsAt = data.startsAt;
    if (data.endsAt !== undefined) updateData.endsAt = data.endsAt;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.reason !== undefined) updateData.reason = data.reason;
    if (data.peakHourStart !== undefined) updateData.peakHourStart = data.peakHourStart;
    if (data.peakHourEnd !== undefined) updateData.peakHourEnd = data.peakHourEnd;
    if (data.isPeakHourOnly !== undefined) updateData.isPeakHourOnly = data.isPeakHourOnly;

    return this.db.transactionManager.execute(async (tx) => {
      const updated = await tx.surgeWindow.update({
        where: { id },
        data: updateData,
        include: {
          zone: { select: { name: true } },
          serviceZone: { select: { name: true } },
          vehicleType: { select: { code: true } },
        },
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'surge_window',
        entityId: id,
        summary: `Updated surge window ${id}`,
        before: {
          multiplier: existing.multiplier,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          isActive: existing.isActive,
          peakHourStart: existing.peakHourStart,
          peakHourEnd: existing.peakHourEnd,
          isPeakHourOnly: existing.isPeakHourOnly,
        },
        after: updateData,
      });
      return toWindowDto(updated);
    });
  }

  async deleteSurgeWindow(id: string, actorId?: string): Promise<void> {
    await this.updateSurgeWindow(id, { isActive: false }, actorId);
  }
}
