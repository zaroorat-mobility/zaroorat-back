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
}
export interface NearbyDriverQuery {
  origin: Coordinate;
  radiusMeters: number;
  freshAfter: Date;
  limit: number;
  driverIds?: readonly string[];
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
      ? Prisma.sql`AND dl."driver_id" IN (${Prisma.join(query.driverIds.map((id) => Prisma.sql`${id}::uuid`))})`
      : Prisma.empty;
    const rows = await client.$queryRaw<NearbyRow[]>`
      SELECT
        dl."driver_id",
        dl."latitude",
        dl."longitude",
        ST_Distance(dl."location", ${point}) AS distance_m,
        dl."recorded_at"
      FROM "driver_locations" dl
      WHERE ST_DWithin(dl."location", ${point}, ${query.radiusMeters})
        AND dl."recorded_at" >= ${query.freshAfter}
        ${candidateFilter}
      ORDER BY distance_m ASC
      LIMIT ${query.limit}
    `;
    return rows.map((row) => ({
      driverId: row.driver_id,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      distanceMeters: Number(row.distance_m),
      recordedAt: row.recorded_at,
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
