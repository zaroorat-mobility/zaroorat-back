import { geoConfig } from '@config/geo';
import { logger } from '@shared/logger/index.js';
import type { PostgisProvider } from '@modules/location/providers/postgis.provider.js';
import { FALLBACK_TIME_ZONE } from '@modules/pricing/services/surge.service.js';
import type { DriverMapZonesRepository, SurgeWindowRow } from './map-zones.repository.js';
import {
  DEMAND_WINDOW_MINUTES,
  aggregateDemand,
  demandSeverity,
  insideViewport,
  parsePolygonGeoJson,
  resolveZoneSurge,
  surgeSeverity,
  viewportRadiusMeters,
  type MapLayer,
  type MapViewport,
  type PolygonGeometry,
  type Severity,
} from './map-zones.logic.js';

/// How often the app should re-read the map. Surge windows open and close by the
/// clock and demand moves by the minute, neither of which writes anything a push
/// could hang off — so the client polls at this cadence and on reconnect.
export const MAP_REFRESH_SECONDS = 60;
/// Enough to count supply across a 1° viewport without an unbounded read.
const MAX_SUPPLY_DRIVERS = 2000;

export type MapZoneType = 'DEMAND' | 'SURGE' | 'RESTRICTED' | 'SERVICE_AREA' | 'AIRPORT';

export interface MapZoneDto {
  id: string;
  type: MapZoneType;
  name: string | null;
  geometry: PolygonGeometry;
  severity: Severity | null;
  /// Null when the zone applies to every vehicle type.
  vehicleTypes: Array<{ id: string; code: string; name: string }> | null;
  /// Whether the zone applies to the vehicle you are operating; null if you have none assigned.
  eligibleForYourVehicle: boolean | null;
  validFrom: string | null;
  validTo: string | null;
  updatedAt: string;
  details: {
    demand?: { requests: number; availableDrivers: number; windowMinutes: number };
    surge?: {
      multiplier: number | null;
      maxMultiplier: number;
      peakHours: { start: string; end: string } | null;
    };
    access?: { allowsPickup: boolean; allowsDropoff: boolean };
  };
}

export type MapLayerStatus = 'ok' | 'error' | 'unsupported' | 'skipped';
export interface MapLayerDto {
  status: MapLayerStatus;
  zones: MapZoneDto[];
}

export interface MapZonesDto {
  generatedAt: string;
  viewport: MapViewport;
  refreshAfterSeconds: number;
  layers: Record<MapLayer | 'incentives' | 'hotspots', MapLayerDto>;
}

type ZoneDraft = Omit<MapZoneDto, 'vehicleTypes'> & { vehicleTypeIds: string[] | null };

/// No backing model exists for these yet (no driver incentive campaigns, no
/// curated pickup points). They are reported as unsupported — never filled in.
const UNSUPPORTED: MapLayerDto = Object.freeze({ status: 'unsupported', zones: [] }) as MapLayerDto;

export class DriverMapZonesService {
  constructor(
    private readonly driverMapZonesRepository: DriverMapZonesRepository,
    private readonly postgisProvider: PostgisProvider,
  ) {}

  async getZones(
    driverId: string,
    viewport: MapViewport,
    layers: ReadonlySet<MapLayer>,
    now: Date = new Date(),
  ): Promise<MapZonesDto> {
    const vehicleTypeId = await this.driverMapZonesRepository.findDriverVehicleTypeId(driverId);
    const run = async (layer: MapLayer, build: () => Promise<ZoneDraft[]>) => {
      if (!layers.has(layer)) return { status: 'skipped' as const, zones: [] as ZoneDraft[] };
      try {
        return { status: 'ok' as const, zones: await build() };
      } catch (err) {
        // One failing layer must not blank the others; the app shows this one as unavailable.
        logger.error({ err, layer }, '[drivers] map layer failed');
        return { status: 'error' as const, zones: [] as ZoneDraft[] };
      }
    };

    const [demand, surge, restricted, service] = await Promise.all([
      run('demand', () => this.demandZones(viewport, now)),
      run('surge', () => this.surgeZones(viewport, vehicleTypeId, now)),
      run('restricted', () => this.serviceZones(viewport, ['RESTRICTED'], vehicleTypeId)),
      run('service', () => this.serviceZones(viewport, ['SERVICE', 'AIRPORT'], vehicleTypeId)),
    ]);

    const ids = new Set<string>();
    for (const layer of [surge, service]) {
      for (const zone of layer.zones) zone.vehicleTypeIds?.forEach((id) => ids.add(id));
    }
    const types = new Map(
      (await this.driverMapZonesRepository.findVehicleTypes([...ids])).map((t) => [t.id, t]),
    );
    const finish = (layer: { status: MapLayerStatus; zones: ZoneDraft[] }): MapLayerDto => ({
      status: layer.status,
      zones: layer.zones.map(({ vehicleTypeIds, ...zone }) => ({
        ...zone,
        vehicleTypes:
          vehicleTypeIds === null
            ? null
            : vehicleTypeIds.flatMap((id) => (types.has(id) ? [types.get(id)!] : [])),
      })),
    });

    return {
      generatedAt: now.toISOString(),
      viewport,
      refreshAfterSeconds: MAP_REFRESH_SECONDS,
      layers: {
        demand: finish(demand),
        surge: finish(surge),
        restricted: finish(restricted),
        service: finish(service),
        incentives: UNSUPPORTED,
        hotspots: UNSUPPORTED,
      },
    };
  }

  /// Requests riders actually made in the last few minutes against the drivers
  /// actually free to take them — not the surge table.
  private async demandZones(viewport: MapViewport, now: Date): Promise<ZoneDraft[]> {
    const since = new Date(now.getTime() - DEMAND_WINDOW_MINUTES * 60_000);
    const center = {
      latitude: (viewport.minLat + viewport.maxLat) / 2,
      longitude: (viewport.minLng + viewport.maxLng) / 2,
    };
    const [requests, drivers] = await Promise.all([
      this.driverMapZonesRepository.findRecentRequestPoints(viewport, since),
      // The same eligibility the dispatcher uses: ONLINE, fresh fix, verified vehicle.
      this.postgisProvider.findNearbyDrivers({
        origin: center,
        radiusMeters: viewportRadiusMeters(viewport),
        freshAfter: new Date(now.getTime() - geoConfig.candidateStalenessSeconds * 1000),
        limit: MAX_SUPPLY_DRIVERS,
      }),
    ]);
    const supply = drivers.filter((d) => insideViewport(d, viewport));
    return aggregateDemand(requests, supply, geoConfig.h3Resolution).map((cell) => ({
      id: `DEMAND:${cell.cell}`,
      type: 'DEMAND',
      name: null,
      geometry: cell.geometry,
      severity: demandSeverity(cell.requests, cell.availableDrivers),
      vehicleTypeIds: null,
      eligibleForYourVehicle: null,
      validFrom: since.toISOString(),
      validTo: null,
      updatedAt: now.toISOString(),
      details: {
        demand: {
          requests: cell.requests,
          availableDrivers: cell.availableDrivers,
          windowMinutes: DEMAND_WINDOW_MINUTES,
        },
      },
    }));
  }

  private async surgeZones(
    viewport: MapViewport,
    vehicleTypeId: string | null,
    now: Date,
  ): Promise<ZoneDraft[]> {
    const rows = await this.driverMapZonesRepository.findSurgeWindows(viewport, now);
    const byZone = new Map<string, SurgeWindowRow[]>();
    for (const row of rows) byZone.set(row.zone_id, [...(byZone.get(row.zone_id) ?? []), row]);

    const zones: ZoneDraft[] = [];
    for (const [zoneId, windows] of byZone) {
      const head = windows[0]!;
      const geometry = head.is_valid ? parsePolygonGeoJson(head.geojson) : null;
      if (!geometry) {
        logger.warn({ zoneId, layer: 'surge' }, '[drivers] map zone skipped: invalid geometry');
        continue;
      }
      const surge = resolveZoneSurge(
        windows.map((w) => ({
          vehicleTypeId: w.vehicle_type_id,
          multiplier: Number(w.multiplier),
          isPeakHourOnly: w.is_peak_hour_only,
          peakHourStart: w.peak_hour_start,
          peakHourEnd: w.peak_hour_end,
          startsAt: w.starts_at,
          endsAt: w.ends_at,
        })),
        vehicleTypeId,
        now,
        head.timezone ?? FALLBACK_TIME_ZONE,
      );
      if (!surge) continue;
      const updatedAt = windows.reduce(
        (latest, w) => Math.max(latest, w.created_at.getTime(), w.zone_updated_at.getTime()),
        0,
      );
      zones.push({
        id: `SURGE:${zoneId}`,
        type: 'SURGE',
        name: head.zone_name,
        geometry,
        severity: surgeSeverity(surge.multiplier ?? surge.maxMultiplier),
        vehicleTypeIds: surge.vehicleTypeIds,
        eligibleForYourVehicle: vehicleTypeId === null ? null : surge.multiplier !== null,
        validFrom: surge.validFrom.toISOString(),
        validTo: surge.validTo?.toISOString() ?? null,
        updatedAt: new Date(updatedAt).toISOString(),
        details: {
          surge: {
            multiplier: surge.multiplier,
            maxMultiplier: surge.maxMultiplier,
            peakHours: surge.peakHours,
          },
        },
      });
    }
    return zones;
  }

  /// Service areas, airports and restricted zones exactly as GeographicCoverageService
  /// enforces them: an empty vehicle list admits every type, and a restriction
  /// applies to every type.
  private async serviceZones(
    viewport: MapViewport,
    zoneTypes: Array<'SERVICE' | 'AIRPORT' | 'RESTRICTED'>,
    vehicleTypeId: string | null,
  ): Promise<ZoneDraft[]> {
    const rows = await this.driverMapZonesRepository.findServiceZones(viewport, zoneTypes);
    const zones: ZoneDraft[] = [];
    for (const row of rows) {
      const geometry = row.is_valid ? parsePolygonGeoJson(row.geojson) : null;
      if (!geometry) {
        logger.warn(
          { zoneId: row.id, layer: row.zone_type },
          '[drivers] map zone skipped: invalid geometry',
        );
        continue;
      }
      const restricted = row.zone_type === 'RESTRICTED';
      const ids = restricted || row.vehicle_type_ids.length === 0 ? null : row.vehicle_type_ids;
      zones.push({
        id: `${row.zone_type}:${row.id}`,
        type: restricted ? 'RESTRICTED' : row.zone_type === 'AIRPORT' ? 'AIRPORT' : 'SERVICE_AREA',
        name: row.name,
        geometry,
        severity: restricted ? (row.allows_pickup || row.allows_dropoff ? 'MEDIUM' : 'HIGH') : null,
        vehicleTypeIds: ids,
        eligibleForYourVehicle:
          vehicleTypeId === null ? null : ids === null || ids.includes(vehicleTypeId),
        validFrom: null,
        validTo: null,
        updatedAt: row.updated_at.toISOString(),
        details: { access: { allowsPickup: row.allows_pickup, allowsDropoff: row.allows_dropoff } },
      });
    }
    return zones;
  }
}
