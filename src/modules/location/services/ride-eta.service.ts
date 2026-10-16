import { logger } from '@shared/logger/index.js';
import { MapProviderService } from '../business-services/map-provider.service.js';
import type { MapProviderName } from '@modules/admin/system-settings/map/types/map-settings.types.js';
import type { Coordinate } from '../types/geo.types.js';
import { geoConfig } from '@config';

export interface RideEtaSnapshot {
  rideId: string;
  destinationType: 'PICKUP' | 'DROP';
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

/// The cache is per-instance soft state: losing an entry costs one provider call.
/// A streaming ride recomputes at least every `etaRefreshMinIntervalMs`, so an
/// entry idle this long belongs to a finished ride — or to a driver now streaming
/// to another instance, which is why this is a sweep and not an end-of-ride
/// event (that event is handled by whichever instance claims it). Without it the
/// map kept one entry per ride for the life of the process.
const ETA_CACHE_IDLE_MS = 10 * 60_000;

export class RideEtaService {
  private readonly cache = new Map<string, EtaCacheEntry>();
  private lastSweepAtMs = 0;

  constructor(private readonly mapProviderService: MapProviderService) {}

  private sweep(now: number): void {
    if (now - this.lastSweepAtMs < ETA_CACHE_IDLE_MS) return;
    this.lastSweepAtMs = now;
    for (const [rideId, entry] of this.cache) {
      if (now - entry.lastComputedAtMs >= ETA_CACHE_IDLE_MS) this.cache.delete(rideId);
    }
  }

  getEta(rideId: string): RideEtaSnapshot | null {
    const entry = this.cache.get(rideId);
    return entry ? entry.snapshot : null;
  }

  async refreshEta(input: {
    rideId: string;
    driverPosition: Coordinate;
    destination: Coordinate;
    destinationType?: 'PICKUP' | 'DROP';
    pinnedProvider?: MapProviderName;
  }): Promise<RideEtaSnapshot | null> {
    const destinationType = input.destinationType ?? 'DROP';
    const previous = this.cache.get(input.rideId);
    const now = Date.now();
    this.sweep(now);

    if (previous && previous.snapshot.destinationType === destinationType) {
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
        destinationType,
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
      if (previous && previous.snapshot.destinationType === destinationType) {
        return { ...previous.snapshot, stale: true };
      }
      return null;
    }
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
