import { geoConfig } from '@config/geo';
import { logger } from '@shared/logger/index.js';
import { H3Provider } from '../providers/h3.provider.js';
import { PostgisProvider } from '../providers/postgis.provider.js';
import { RedisGeoProvider } from '../providers/redis-geo.provider.js';
import { CoordinateService } from './coordinate.service.js';
import { GeoMetrics } from '../metrics/location.metrics.js';
import type {
  Coordinate,
  DriverPosition,
  NearbyDriversResult,
  NearbySearch,
} from '../types/geo.types.js';
type CandidateLookup =
  | {
      available: true;
      driverIds: string[];
    }
  | {
      available: false;
      reason: string;
    };
export class NearbyDriverService {
  constructor(
    private readonly h3Provider: H3Provider,
    private readonly postgisProvider: PostgisProvider,
    private readonly redisGeoProvider: RedisGeoProvider,
    private readonly coordinateService: CoordinateService,
    private readonly geoMetrics: GeoMetrics,
  ) {}
  async find(search: NearbySearch): Promise<NearbyDriversResult> {
    const origin = this.coordinateService.normalize(search.origin);
    const radiusMeters = this.coordinateService.assertRadius(
      search.radiusMeters ?? geoConfig.searchRadiusMeters,
    );
    const limit = search.limit ?? geoConfig.maxCandidates;
    const freshAfter = new Date(Date.now() - geoConfig.candidateStalenessSeconds * 1000);
    this.geoMetrics.nearbyRequested({ scope: 'nearby_drivers' });
    const lookup = await this.candidatesFromLiveStore(origin, radiusMeters);
    if (lookup.available && lookup.driverIds.length === 0) {
      this.geoMetrics.noLiveCandidates({ result: 'no_live_candidates' });
      return { outcome: 'no-live-candidates' };
    }
    const drivers = await this.postgisProvider.findNearbyDrivers({
      origin,
      radiusMeters,
      freshAfter,
      limit,
      ...(lookup.available ? { driverIds: lookup.driverIds } : {}),
    });
    this.geoMetrics.nearbyCandidates(drivers.length, {
      result: lookup.available ? 'ok' : 'degraded',
    });
    return lookup.available ? { outcome: 'ok', drivers } : { outcome: 'degraded', drivers };
  }
  async recordPosition(position: {
    driverId: string;
    latitude: number;
    longitude: number;
    recordedAt?: Date;
  }): Promise<DriverPosition> {
    const coordinate = this.coordinateService.normalize(position);
    const resolved: DriverPosition = {
      driverId: position.driverId,
      ...coordinate,
      h3Cell: this.h3Provider.cellFor(coordinate),
      updatedAt: position.recordedAt ?? new Date(),
    };
    try {
      if (await this.redisGeoProvider.setPosition(resolved)) {
        this.geoMetrics.positionRecorded({ driverId: resolved.driverId });
      } else {
        this.geoMetrics.positionRejectedStale({ driverId: resolved.driverId });
      }
    } catch (err) {
      this.geoMetrics.redisError({ scope: 'record_position' });
      logger.warn(
        { err, driverId: resolved.driverId },
        '[geo] live position store unavailable; PostGIS remains authoritative',
      );
    }
    return resolved;
  }
  async forgetPosition(driverId: string): Promise<void> {
    try {
      await this.redisGeoProvider.removePosition(driverId);
    } catch (err) {
      this.geoMetrics.redisError({ scope: 'forget_position' });
      logger.warn({ err, driverId }, '[geo] could not clear live position');
    }
  }
  async livePosition(driverId: string): Promise<DriverPosition | null> {
    try {
      return await this.redisGeoProvider.getPosition(driverId);
    } catch (err) {
      this.geoMetrics.redisError({ scope: 'read_position' });
      logger.warn({ err, driverId }, '[geo] live position read failed');
      return null;
    }
  }
  private async candidatesFromLiveStore(
    origin: Coordinate,
    radiusMeters: number,
  ): Promise<CandidateLookup> {
    try {
      const cells = this.h3Provider.cellsCovering(origin, radiusMeters);
      return { available: true, driverIds: await this.redisGeoProvider.driversInCells(cells) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.geoMetrics.redisError({ scope: 'candidate_lookup' });
      this.geoMetrics.postgisFallback({ reason: 'live_store_error' });
      logger.error(
        { err, radiusMeters },
        '[geo] live candidate lookup failed; falling back to the bounded PostGIS radius query',
      );
      return { available: false, reason };
    }
  }
}
