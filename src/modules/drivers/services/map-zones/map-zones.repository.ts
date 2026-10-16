import { Prisma } from '../../../../generated/prisma/index.js';
import type { DatabaseService } from '@core/database';
import type { MapViewport } from './map-zones.logic.js';

export interface ServiceZoneRow {
  id: string;
  code: string;
  name: string;
  zone_type: 'SERVICE' | 'AIRPORT' | 'RESTRICTED';
  allows_pickup: boolean;
  allows_dropoff: boolean;
  updated_at: Date;
  is_valid: boolean;
  geojson: string | null;
  vehicle_type_ids: string[];
}

export interface SurgeWindowRow {
  window_id: string;
  vehicle_type_id: string | null;
  multiplier: number;
  is_peak_hour_only: boolean;
  peak_hour_start: string | null;
  peak_hour_end: string | null;
  starts_at: Date;
  ends_at: Date | null;
  created_at: Date;
  zone_id: string;
  zone_name: string;
  zone_updated_at: Date;
  timezone: string | null;
  is_valid: boolean;
  geojson: string | null;
}

/// Hard caps so one map request can never return an unbounded result.
const MAX_ZONES = 500;
const MAX_SURGE_WINDOWS = 1000;
const MAX_REQUEST_POINTS = 10_000;

function envelope(v: MapViewport): Prisma.Sql {
  return Prisma.sql`ST_MakeEnvelope(${v.minLng}, ${v.minLat}, ${v.maxLng}, ${v.maxLat}, 4326)`;
}

/// The only cities whose zones pricing and pickup enforcement ever consult:
/// GeographicCoverageService.resolveCityAtPoint matches active, bounded,
/// non-GLOBAL cities, so a zone under any other city would be drawn but never apply.
const ENFORCED_CITY = Prisma.sql`c.is_active = true AND c.code <> 'GLOBAL' AND c.boundary IS NOT NULL`;

/// Read-only queries behind the driver map. Every geometry predicate is written
/// to hit an existing GiST index: `service_zones` and `cities` are indexed on
/// `boundary::geometry`, `surge_zones` on the geography column itself.
export class DriverMapZonesRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /// Active zones of the given types (active city only) touching the viewport.
  async findServiceZones(
    viewport: MapViewport,
    zoneTypes: readonly string[],
  ): Promise<ServiceZoneRow[]> {
    if (zoneTypes.length === 0) return [];
    return this.databaseService.client.$queryRaw<ServiceZoneRow[]>`
      SELECT sz.id, sz.code, sz.name, sz.zone_type::text AS zone_type,
             sz.allows_pickup, sz.allows_dropoff, sz.updated_at,
             ST_IsValid(sz.boundary::geometry) AS is_valid,
             ST_AsGeoJSON(sz.boundary::geometry, 6) AS geojson,
             COALESCE(
               array_agg(szv.vehicle_type_id::text) FILTER (WHERE szv.vehicle_type_id IS NOT NULL),
               '{}'
             ) AS vehicle_type_ids
      FROM service_zones sz
      JOIN cities c ON c.id = sz.city_id AND ${ENFORCED_CITY}
      LEFT JOIN service_zone_vehicle_types szv ON szv.service_zone_id = sz.id
      WHERE sz.is_active = true
        AND sz.zone_type::text = ANY(${zoneTypes as string[]}::text[])
        AND ST_Intersects(sz.boundary::geometry, ${envelope(viewport)})
      GROUP BY sz.id
      ORDER BY sz.priority DESC, sz.created_at ASC
      LIMIT ${MAX_ZONES}
    `;
  }

  /// Surge windows in force by date (peak hours are applied by the caller in the
  /// zone's city timezone), with the polygon they price. Mirrors SurgeRepository:
  /// a window linked to a service zone resolves through it alone; a window with
  /// only the legacy link resolves through `surge_zones` for one more release.
  async findSurgeWindows(viewport: MapViewport, now: Date): Promise<SurgeWindowRow[]> {
    const env = envelope(viewport);
    return this.databaseService.client.$queryRaw<SurgeWindowRow[]>`
      SELECT * FROM (
        SELECT sw.id AS window_id, sw.vehicle_type_id::text AS vehicle_type_id,
               sw.multiplier::float8 AS multiplier, sw.is_peak_hour_only,
               sw.peak_hour_start, sw.peak_hour_end, sw.starts_at, sw.ends_at, sw.created_at,
               sz.id AS zone_id, sz.name AS zone_name, sz.updated_at AS zone_updated_at,
               c.timezone,
               ST_IsValid(sz.boundary::geometry) AS is_valid,
               ST_AsGeoJSON(sz.boundary::geometry, 6) AS geojson
        FROM surge_windows sw
        JOIN service_zones sz ON sz.id = sw.service_zone_id AND sz.is_active = true
        JOIN cities c ON c.id = sz.city_id AND ${ENFORCED_CITY}
        WHERE sw.is_active = true
          AND sw.starts_at <= ${now}
          AND (sw.ends_at IS NULL OR sw.ends_at > ${now})
          AND ST_Intersects(sz.boundary::geometry, ${env})
        UNION ALL
        SELECT sw.id, sw.vehicle_type_id::text, sw.multiplier::float8, sw.is_peak_hour_only,
               sw.peak_hour_start, sw.peak_hour_end, sw.starts_at, sw.ends_at, sw.created_at,
               z.id, z.name, z.created_at,
               c.timezone,
               ST_IsValid(z.boundary::geometry),
               ST_AsGeoJSON(z.boundary::geometry, 6)
        FROM surge_windows sw
        JOIN surge_zones z ON z.id = sw.zone_id AND z.is_active = true
        LEFT JOIN cities c ON c.code = z.city_code
        WHERE sw.service_zone_id IS NULL
          AND sw.is_active = true
          AND sw.starts_at <= ${now}
          AND (sw.ends_at IS NULL OR sw.ends_at > ${now})
          AND ST_Intersects(z.boundary, ${env}::geography)
      ) windows
      LIMIT ${MAX_SURGE_WINDOWS}
    `;
  }

  /// Pickup points of requests made since `since` inside the viewport. Narrowed
  /// by the `created_at` index first; the box test is then a cheap numeric one.
  async findRecentRequestPoints(
    viewport: MapViewport,
    since: Date,
  ): Promise<Array<{ latitude: number; longitude: number; riderId: string }>> {
    return this.databaseService.client.$queryRaw<
      Array<{ latitude: number; longitude: number; riderId: string }>
    >`
      SELECT pickup_lat::float8 AS latitude, pickup_lng::float8 AS longitude,
             customer_id::text AS "riderId"
      FROM ride_requests
      WHERE created_at >= ${since}
        AND pickup_lat BETWEEN ${viewport.minLat} AND ${viewport.maxLat}
        AND pickup_lng BETWEEN ${viewport.minLng} AND ${viewport.maxLng}
      LIMIT ${MAX_REQUEST_POINTS}
    `;
  }

  async findVehicleTypes(
    ids: readonly string[],
  ): Promise<Array<{ id: string; code: string; name: string }>> {
    if (ids.length === 0) return [];
    return this.databaseService.client.vehicleType.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, code: true, name: true },
    });
  }

  /// The vehicle type the driver is currently operating, or null if none is assigned.
  async findDriverVehicleTypeId(driverId: string): Promise<string | null> {
    const rows = await this.databaseService.client.$queryRaw<Array<{ vehicle_type_id: string }>>`
      SELECT v.vehicle_type_id::text AS vehicle_type_id
      FROM drivers d JOIN vehicles v ON v.id = d.current_vehicle_id
      WHERE d.id = ${driverId}::uuid
    `;
    return rows[0]?.vehicle_type_id ?? null;
  }
}
