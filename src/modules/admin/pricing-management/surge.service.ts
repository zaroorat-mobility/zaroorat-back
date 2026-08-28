import { Prisma } from '../../../generated/prisma/index.js';
import type { ProviderClient } from '@core/database/index.js';
import type { SurgeZone, SurgeWindow } from '../../../generated/prisma/index.js';
import { assertValidPolygon, polygonGeoJson } from '../../geographic/utils/postgis.js';

export interface SurgeZoneDetail extends Pick<
  SurgeZone,
  'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'
> {
  boundary: number[][][];
}

export class AdminSurgeService {
  constructor(private readonly db: { client: ProviderClient }) {}

  async createSurgeZone(data: {
    cityCode: string;
    name: string;
    coordinates: number[][][];
  }): Promise<SurgeZone> {
    const geoJson = JSON.stringify({
      type: 'Polygon',
      coordinates: data.coordinates,
    });

    const [zone] = await this.db.client.$queryRaw<SurgeZone[]>`
      INSERT INTO surge_zones (id, city_code, name, boundary)
      VALUES (
        gen_random_uuid(),
        ${data.cityCode},
        ${data.name},
        ST_GeomFromGeoJSON(${geoJson})
      )
      RETURNING id, city_code AS "cityCode", name, is_active AS "isActive", created_at AS "createdAt"
    `;
    return zone as SurgeZone;
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

  async updateSurgeZone(
    id: string,
    data: {
      name?: string | undefined;
      isActive?: boolean | undefined;
      coordinates?: number[][][] | undefined;
    },
  ): Promise<void> {
    if (data.coordinates) {
      await assertValidPolygon(this.db, data.coordinates);
      const geoJson = polygonGeoJson(data.coordinates);
      await this.db.client.$executeRaw`
        UPDATE surge_zones SET boundary = ST_GeomFromGeoJSON(${geoJson}) WHERE id = ${id}::uuid
      `;
    }

    if (data.name !== undefined && data.isActive !== undefined) {
      await this.db.client.$executeRaw`
        UPDATE surge_zones SET name = ${data.name}, is_active = ${data.isActive} WHERE id = ${id}::uuid
      `;
    } else if (data.name !== undefined) {
      await this.db.client.$executeRaw`
        UPDATE surge_zones SET name = ${data.name} WHERE id = ${id}::uuid
      `;
    } else if (data.isActive !== undefined) {
      await this.db.client.$executeRaw`
        UPDATE surge_zones SET is_active = ${data.isActive} WHERE id = ${id}::uuid
      `;
    }
  }

  async deleteSurgeZone(id: string): Promise<void> {
    await this.updateSurgeZone(id, { isActive: false });
  }

  async createSurgeWindow(data: {
    zoneId: string;
    vehicleTypeId?: string | undefined;
    multiplier: number;
    startsAt: Date;
    endsAt?: Date | undefined;
    reason?: string | undefined;
    demandThresholdPct?: number | undefined;
    supplyThresholdPct?: number | undefined;
    peakHourStart?: string | undefined;
    peakHourEnd?: string | undefined;
    isPeakHourOnly?: boolean | undefined;
  }): Promise<SurgeWindow> {
    return this.db.client.surgeWindow.create({
      data: {
        zoneId: data.zoneId,
        vehicleTypeId: data.vehicleTypeId ?? null,
        multiplier: new Prisma.Decimal(data.multiplier),
        startsAt: data.startsAt,
        endsAt: data.endsAt ?? null,
        reason: data.reason ?? null,
        ...(data.demandThresholdPct !== undefined
          ? { demandThresholdPct: new Prisma.Decimal(data.demandThresholdPct) }
          : {}),
        ...(data.supplyThresholdPct !== undefined
          ? { supplyThresholdPct: new Prisma.Decimal(data.supplyThresholdPct) }
          : {}),
        ...(data.peakHourStart !== undefined ? { peakHourStart: data.peakHourStart } : {}),
        ...(data.peakHourEnd !== undefined ? { peakHourEnd: data.peakHourEnd } : {}),
        ...(data.isPeakHourOnly !== undefined ? { isPeakHourOnly: data.isPeakHourOnly } : {}),
      },
    });
  }

  async listSurgeWindows(): Promise<
    Array<
      SurgeWindow & {
        zoneName?: string;
        vehicleTypeCode?: string | null;
      }
    >
  > {
    const windows = await this.db.client.surgeWindow.findMany({
      include: {
        zone: { select: { name: true } },
        vehicleType: { select: { code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return windows.map((row) => ({
      id: row.id,
      zoneId: row.zoneId,
      vehicleTypeId: row.vehicleTypeId,
      multiplier: row.multiplier,
      source: row.source,
      reason: row.reason,
      demandThresholdPct: row.demandThresholdPct,
      supplyThresholdPct: row.supplyThresholdPct,
      peakHourStart: row.peakHourStart,
      peakHourEnd: row.peakHourEnd,
      isPeakHourOnly: row.isPeakHourOnly,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      isActive: row.isActive,
      createdAt: row.createdAt,
      zoneName: row.zone.name,
      vehicleTypeCode: row.vehicleType?.code ?? null,
    }));
  }

  async getSurgeWindow(id: string): Promise<
    | (SurgeWindow & {
        zoneName?: string;
        vehicleTypeCode?: string | null;
      })
    | null
  > {
    const row = await this.db.client.surgeWindow.findUnique({
      where: { id },
      include: {
        zone: { select: { name: true } },
        vehicleType: { select: { code: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      zoneId: row.zoneId,
      vehicleTypeId: row.vehicleTypeId,
      multiplier: row.multiplier,
      source: row.source,
      reason: row.reason,
      demandThresholdPct: row.demandThresholdPct,
      supplyThresholdPct: row.supplyThresholdPct,
      peakHourStart: row.peakHourStart,
      peakHourEnd: row.peakHourEnd,
      isPeakHourOnly: row.isPeakHourOnly,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      isActive: row.isActive,
      createdAt: row.createdAt,
      zoneName: row.zone.name,
      vehicleTypeCode: row.vehicleType?.code ?? null,
    };
  }

  async updateSurgeWindow(
    id: string,
    data: {
      multiplier?: number | undefined;
      startsAt?: Date | undefined;
      endsAt?: Date | undefined;
      isActive?: boolean | undefined;
      reason?: string | undefined;
      demandThresholdPct?: number | null | undefined;
      supplyThresholdPct?: number | null | undefined;
      peakHourStart?: string | null | undefined;
      peakHourEnd?: string | null | undefined;
      isPeakHourOnly?: boolean | undefined;
    },
  ): Promise<SurgeWindow> {
    const updateData: Record<string, unknown> = {};
    if (data.multiplier !== undefined) updateData.multiplier = new Prisma.Decimal(data.multiplier);
    if (data.startsAt !== undefined) updateData.startsAt = data.startsAt;
    if (data.endsAt !== undefined) updateData.endsAt = data.endsAt;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.reason !== undefined) updateData.reason = data.reason;
    if (data.demandThresholdPct !== undefined) {
      updateData.demandThresholdPct =
        data.demandThresholdPct === null ? null : new Prisma.Decimal(data.demandThresholdPct);
    }
    if (data.supplyThresholdPct !== undefined) {
      updateData.supplyThresholdPct =
        data.supplyThresholdPct === null ? null : new Prisma.Decimal(data.supplyThresholdPct);
    }
    if (data.peakHourStart !== undefined) updateData.peakHourStart = data.peakHourStart;
    if (data.peakHourEnd !== undefined) updateData.peakHourEnd = data.peakHourEnd;
    if (data.isPeakHourOnly !== undefined) updateData.isPeakHourOnly = data.isPeakHourOnly;

    return this.db.client.surgeWindow.update({
      where: { id },
      data: updateData,
    });
  }

  async deleteSurgeWindow(id: string): Promise<void> {
    await this.db.client.surgeWindow.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
