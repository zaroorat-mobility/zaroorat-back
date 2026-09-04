import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { realtimeConfig, geoConfig } from '@config';
import { updateLocationSchema } from '@modules/drivers/schemas/driver.schemas.js';
import { LocationService } from '@modules/drivers/services/location/location.service.js';
import { RideRepository } from '@modules/rides/repositories/ride.repository.js';
import { RideLocationHistoryService } from '@modules/location/services/ride-location-history.service.js';
import { RideEtaService } from '@modules/location/services/ride-eta.service.js';
import type { MapProviderName } from '@modules/admin/system-settings/map/types/map-settings.types.js';
import { SOCKET_EVENT, socketEnvelope, type SocketEnvelope } from './events.js';
import {
  InvalidSocketPayloadError,
  LocationRateLimitedError,
  SocketForbiddenError,
  StaleLocationError,
} from './realtime.errors.js';
import type { SocketPrincipal } from './socket-auth.service.js';

export const locationFrameSchema = updateLocationSchema.omit({ rideId: true }).extend({
  recordedAt: z.string().datetime().optional(),
  fixId: z.string().uuid().optional(),
  sequence: z.number().int().nonnegative().optional(),
});

export type LocationFrame = z.infer<typeof locationFrameSchema>;

export interface AcceptedLocation {
  envelope: SocketEnvelope;
  etaEnvelope?: SocketEnvelope;
  persisted: boolean;
}

interface DriverStreamState {
  lastAcceptedAtMs: number;
  lastPersistedAtMs: number;
  lastRecordedAtMs: number;
  lastHistoryAtMs: number;
}

const LIVE_RIDE_STATUSES = new Set([
  'ACCEPTED',
  'DRIVER_ARRIVING',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
]);

export class LocationStreamService {
  private readonly state = new Map<string, DriverStreamState>();

  constructor(
    private readonly locationService: LocationService,
    private readonly rideRepository: RideRepository,
    private readonly rideLocationHistoryService: RideLocationHistoryService,
    private readonly rideEtaService: RideEtaService,
  ) {}

  parse(payload: unknown): LocationFrame {
    const result = locationFrameSchema.safeParse(payload);
    if (!result.success) {
      throw new InvalidSocketPayloadError('Malformed location frame', result.error.issues);
    }
    return result.data;
  }

  async accept(
    principal: SocketPrincipal,
    payload: unknown,
    now = Date.now(),
  ): Promise<AcceptedLocation> {
    if (!principal.driverId) {
      throw new SocketForbiddenError('Only an operable driver may publish a location');
    }
    const frame = this.parse(payload);
    const driverId = principal.driverId;
    const previous = this.state.get(driverId);

    if (previous && now - previous.lastAcceptedAtMs < realtimeConfig.locationMinIntervalMs) {
      throw new LocationRateLimitedError(
        realtimeConfig.locationMinIntervalMs - (now - previous.lastAcceptedAtMs),
      );
    }

    const recordedAtMs = frame.recordedAt ? Date.parse(frame.recordedAt) : now;
    if (Number.isNaN(recordedAtMs)) {
      throw new InvalidSocketPayloadError('recordedAt is not a valid timestamp');
    }
    if (recordedAtMs > now + realtimeConfig.locationMaxAgeMs) {
      throw new StaleLocationError('This location frame is timestamped in the future');
    }
    if (now - recordedAtMs > realtimeConfig.locationMaxAgeMs) {
      throw new StaleLocationError();
    }
    if (previous && recordedAtMs < previous.lastRecordedAtMs) {
      throw new StaleLocationError();
    }

    const shouldPersist =
      !previous || now - previous.lastPersistedAtMs >= realtimeConfig.locationPersistIntervalMs;

    if (shouldPersist) {
      await this.locationService.updateLocation({
        driverId,
        latitude: frame.latitude,
        longitude: frame.longitude,
        ...(frame.heading !== undefined ? { heading: frame.heading } : {}),
        ...(frame.bearing !== undefined ? { bearing: frame.bearing } : {}),
        ...(frame.speedKmh !== undefined ? { speedKmh: frame.speedKmh } : {}),
        ...(frame.accuracyMeters !== undefined ? { accuracyMeters: frame.accuracyMeters } : {}),
        ...(frame.isMockLocation !== undefined ? { isMockLocation: frame.isMockLocation } : {}),
      });
    }

    const fixId = frame.fixId ?? randomUUID();
    const activeRide = await this.rideRepository.findActiveByDriver(driverId);
    let historyRecorded = false;
    if (
      activeRide &&
      LIVE_RIDE_STATUSES.has(activeRide.status) &&
      (!previous || now - previous.lastHistoryAtMs >= geoConfig.rideLocationSampleIntervalMs)
    ) {
      historyRecorded = await this.rideLocationHistoryService.recordPoint({
        rideId: activeRide.id,
        driverId,
        latitude: frame.latitude,
        longitude: frame.longitude,
        heading: frame.heading ?? null,
        speedKmh: frame.speedKmh ?? null,
        accuracyMeters: frame.accuracyMeters ?? null,
        fixId,
        sequence: frame.sequence ?? null,
        recordedAt: new Date(recordedAtMs),
      });
    }

    let etaEnvelope: SocketEnvelope | undefined;
    const dropLat = activeRide?.request?.dropLat;
    const dropLng = activeRide?.request?.dropLng;
    if (
      activeRide &&
      LIVE_RIDE_STATUSES.has(activeRide.status) &&
      dropLat != null &&
      dropLng != null
    ) {
      const eta = await this.rideEtaService.refreshEta({
        rideId: activeRide.id,
        driverPosition: { latitude: frame.latitude, longitude: frame.longitude },
        destination: {
          latitude: Number(dropLat),
          longitude: Number(dropLng),
        },
        ...(activeRide.mapProvider
          ? { pinnedProvider: activeRide.mapProvider as MapProviderName }
          : {}),
      });
      if (eta) {
        etaEnvelope = socketEnvelope(
          randomUUID(),
          SOCKET_EVENT.ETA_UPDATED,
          {
            rideId: activeRide.id,
            remainingDistanceMeters: eta.remainingDistanceMeters,
            remainingDurationSeconds: eta.remainingDurationSeconds,
            providerName: eta.providerName,
            stale: eta.stale,
            computedAt: eta.computedAt,
          },
          new Date(recordedAtMs),
        );
      }
    }

    this.state.set(driverId, {
      lastAcceptedAtMs: now,
      lastRecordedAtMs: recordedAtMs,
      lastPersistedAtMs: shouldPersist ? now : (previous?.lastPersistedAtMs ?? now),
      lastHistoryAtMs: historyRecorded ? now : (previous?.lastHistoryAtMs ?? 0),
    });

    return {
      persisted: shouldPersist,
      ...(etaEnvelope ? { etaEnvelope } : {}),
      envelope: socketEnvelope(
        fixId,
        SOCKET_EVENT.DRIVER_LOCATION,
        {
          driverId,
          latitude: frame.latitude,
          longitude: frame.longitude,
          heading: frame.heading ?? null,
          speedKmh: frame.speedKmh ?? null,
          accuracyMeters: frame.accuracyMeters ?? null,
          recordedAt: new Date(recordedAtMs).toISOString(),
          fixId,
          sequence: frame.sequence ?? null,
        },
        new Date(recordedAtMs),
      ),
    };
  }

  forget(driverId: string): void {
    this.state.delete(driverId);
  }
}
