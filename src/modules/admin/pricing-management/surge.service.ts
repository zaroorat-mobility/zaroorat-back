import { Prisma } from '../../../generated/prisma/index.js';
import type { ProviderClient } from '@core/database/index.js';
import type { SurgeZone, SurgeWindow } from '../../../generated/prisma/index.js';

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

  async getSurgeZone(
    id: string,
  ): Promise<Pick<SurgeZone, 'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'> | null> {
    const zones = await this.db.client.$queryRaw<
      Pick<SurgeZone, 'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'>[]
    >`
      SELECT id, city_code AS "cityCode", name, is_active AS "isActive", created_at AS "createdAt"
      FROM surge_zones
      WHERE id = ${id}::uuid
    `;
    return zones[0] ?? null;
  }

  async updateSurgeZone(
    id: string,
    data: { name?: string | undefined; isActive?: boolean | undefined },
  ): Promise<void> {
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
  }): Promise<SurgeWindow> {
    return this.db.client.surgeWindow.create({
      data: {
        zoneId: data.zoneId,
        vehicleTypeId: data.vehicleTypeId ?? null,
        multiplier: new Prisma.Decimal(data.multiplier),
        startsAt: data.startsAt,
        endsAt: data.endsAt ?? null,
        reason: data.reason ?? null,
      },
    });
  }

  async listSurgeWindows(): Promise<SurgeWindow[]> {
    return this.db.client.surgeWindow.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSurgeWindow(id: string): Promise<SurgeWindow | null> {
    return this.db.client.surgeWindow.findUnique({ where: { id } });
  }

  async updateSurgeWindow(
    id: string,
    data: {
      multiplier?: number | undefined;
      startsAt?: Date | undefined;
      endsAt?: Date | undefined;
      isActive?: boolean | undefined;
      reason?: string | undefined;
    },
  ): Promise<SurgeWindow> {
    const updateData: Record<string, unknown> = {};
    if (data.multiplier !== undefined) updateData.multiplier = new Prisma.Decimal(data.multiplier);
    if (data.startsAt !== undefined) updateData.startsAt = data.startsAt;
    if (data.endsAt !== undefined) updateData.endsAt = data.endsAt;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.reason !== undefined) updateData.reason = data.reason;

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
