import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Prisma } from '../../../generated/prisma';
import type { Coordinate, NearbyDriver } from '../types/geo.types.js';

interface NearbyRow {
  driver_id: string;
  latitude: string | number | null;
  longitude: string | number | null;
  distance_m: number;
  recorded_at: Date;
  heading: string | number | null;
  bearing: string | number | null;
  vehicle_type_id: string | null;
  vehicle_type_code: string | null;
}

export interface NearbyDriverQuery {
  origin: Coordinate;
  radiusMeters: number;
  freshAfter: Date;
  limit: number;
  driverIds?: readonly string[];
  vehicleTypeId?: string;
  vehicleTypeCode?: string;
}

export class PostgisProvider {
  constructor(private readonly db: DatabaseService) {}

  async findNearbyDrivers(
    query: NearbyDriverQuery,
    tx?: TransactionClient,
  ): Promise<NearbyDriver[]> {
    if (query.driverIds && query.driverIds.length === 0) return [];
    const client = tx ?? this.db.client;
    const point = this.pointSql(query.origin);
    const candidateFilter = query.driverIds
      ? Prisma.sql`AND dl."driver_id" IN (${Prisma.join(
          query.driverIds.map((id) => Prisma.sql`${id}::uuid`),
        )})`
      : Prisma.empty;
    const vehicleTypeFilter = query.vehicleTypeId
      ? Prisma.sql`AND v."vehicle_type_id" = ${query.vehicleTypeId}::uuid`
      : query.vehicleTypeCode
        ? Prisma.sql`AND UPPER(vt."code") = UPPER(${query.vehicleTypeCode})`
        : Prisma.empty;

    const rows = await client.$queryRaw<NearbyRow[]>`
      SELECT
        dl."driver_id",
        dl."latitude",
        dl."longitude",
        ST_Distance(dl."location", ${point}) AS distance_m,
        dl."recorded_at",
        dl."heading",
        dl."bearing",
        vt."id" AS vehicle_type_id,
        vt."code" AS vehicle_type_code
      FROM "driver_locations" dl
      INNER JOIN "driver_online_status" dos
        ON dos."driver_id" = dl."driver_id"
       AND dos."status" = 'ONLINE'
      INNER JOIN "vehicle_assignments" va
        ON va."driver_id" = dl."driver_id"
       AND va."status" = 'ACTIVE'
      INNER JOIN "vehicles" v
        ON v."id" = va."vehicle_id"
       AND v."is_active" = true
       AND v."verification_status" = 'VERIFIED'
      INNER JOIN "vehicle_types" vt
        ON vt."id" = v."vehicle_type_id"
       AND vt."is_active" = true
      WHERE ST_DWithin(dl."location", ${point}, ${query.radiusMeters})
        AND dl."recorded_at" >= ${query.freshAfter}
        ${candidateFilter}
        ${vehicleTypeFilter}
      ORDER BY distance_m ASC
      LIMIT ${query.limit}
    `;

    return rows.map((row) => ({
      driverId: row.driver_id,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      distanceMeters: Number(row.distance_m),
      recordedAt: row.recorded_at,
      heading: row.heading != null ? Number(row.heading) : null,
      bearing: row.bearing != null ? Number(row.bearing) : null,
      vehicleTypeId: row.vehicle_type_id,
      vehicleTypeCode: row.vehicle_type_code,
    }));
  }

  async distanceMeters(from: Coordinate, to: Coordinate, tx?: TransactionClient): Promise<number> {
    const client = tx ?? this.db.client;
    const rows = await client.$queryRaw<
      {
        distance_m: number;
      }[]
    >`
      SELECT ST_Distance(${this.pointSql(from)}, ${this.pointSql(to)}) AS distance_m
    `;
    return Number(rows[0]?.distance_m ?? 0);
  }

  async isWithin(
    from: Coordinate,
    to: Coordinate,
    radiusMeters: number,
    tx?: TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.db.client;
    const rows = await client.$queryRaw<
      {
        within: boolean;
      }[]
    >`
      SELECT ST_DWithin(${this.pointSql(from)}, ${this.pointSql(to)}, ${radiusMeters}) AS within
    `;
    return rows[0]?.within === true;
  }

  private pointSql(coordinate: Coordinate): Prisma.Sql {
    return Prisma.sql`ST_SetSRID(ST_MakePoint(${coordinate.longitude}, ${coordinate.latitude}), 4326)::geography`;
  }
}
