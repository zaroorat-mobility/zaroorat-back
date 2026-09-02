import { logger } from '@shared/logger/index.js';
import { MapProviderService } from '../business-services/map-provider.service.js';
import type { MapProviderName } from '@modules/admin/system-settings/map/types/map-settings.types.js';
import type { Coordinate } from '../types/geo.types.js';
import { geoConfig } from '@config';

export interface RideEtaSnapshot {
  rideId: string;
  remainingDistanceMeters: number;
  remainingDurationSeconds: number;
  providerName: string;
  stale: boolean;
  computedAt: string;
}

interface EtaCacheEntry {
  snapshot: RideEtaSnapshot;
  lastComputedAtMs: number;
  lastOrigin: Coordinate;
}

export class RideEtaService {
  private readonly cache = new Map<string, EtaCacheEntry>();

  constructor(private readonly mapProviderService: MapProviderService) {}

  async refreshEta(input: {
    rideId: string;
    driverPosition: Coordinate;
    destination: Coordinate;
    pinnedProvider?: MapProviderName;
  }): Promise<RideEtaSnapshot | null> {
    const previous = this.cache.get(input.rideId);
    const now = Date.now();

    if (previous) {
      const movedEnough =
        haversineMeters(previous.lastOrigin, input.driverPosition) >=
        geoConfig.etaRefreshMinMovementMeters;
      const recent = now - previous.lastComputedAtMs < geoConfig.etaRefreshMinIntervalMs;
      if (!movedEnough && recent) {
        return { ...previous.snapshot, stale: true };
      }
    }

    try {
      const route = await this.mapProviderService.getDirections(
        input.driverPosition,
        input.destination,
        input.pinnedProvider,
      );
      const snapshot: RideEtaSnapshot = {
        rideId: input.rideId,
        remainingDistanceMeters: route.distanceMeters,
        remainingDurationSeconds: route.durationSeconds,
        providerName: route.providerName,
        stale: false,
        computedAt: new Date().toISOString(),
      };
      this.cache.set(input.rideId, {
        snapshot,
        lastComputedAtMs: now,
        lastOrigin: input.driverPosition,
      });
      return snapshot;
    } catch (err) {
      logger.warn({ err, rideId: input.rideId }, '[RideEtaService] ETA refresh failed');
      if (previous) return { ...previous.snapshot, stale: true };
      return null;
    }
  }

  forget(rideId: string): void {
    this.cache.delete(rideId);
  }
}

function haversineMeters(a: Coordinate, b: Coordinate): number {
  const R = 6371e3;
  const φ1 = (a.latitude * Math.PI) / 180;
  const φ2 = (b.latitude * Math.PI) / 180;
  const Δφ = ((b.latitude - a.latitude) * Math.PI) / 180;
  const Δλ = ((b.longitude - a.longitude) * Math.PI) / 180;
  const x =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
