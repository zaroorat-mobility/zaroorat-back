import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { realtimeConfig } from '@config';
import { updateLocationSchema } from '@modules/drivers/schemas/driver.schemas.js';
import { LocationService } from '@modules/drivers/services/location/location.service.js';
import { SOCKET_EVENT, socketEnvelope, type SocketEnvelope } from './events.js';
import {
  InvalidSocketPayloadError,
  LocationRateLimitedError,
  SocketForbiddenError,
  StaleLocationError,
} from './realtime.errors.js';
import type { SocketPrincipal } from './socket-auth.service.js';

/// The socket frame. Built from the module's own `updateLocationSchema` so the
/// HTTP endpoint and the socket accept exactly the same fields with exactly the
/// same bounds; `recordedAt` is the one addition, because a socket frame can
/// arrive out of order in a way an HTTP request effectively cannot.
///
/// `rideId` is deliberately omitted from the client's reach: which ride a frame
/// belongs to is decided by which ride rooms the server has admitted this socket
/// to, never by the payload.
export const locationFrameSchema = updateLocationSchema
  .omit({ rideId: true })
  .extend({ recordedAt: z.string().datetime().optional() });

export type LocationFrame = z.infer<typeof locationFrameSchema>;

export interface AcceptedLocation {
  envelope: SocketEnvelope;
  /// Whether this frame was also written through to durable storage, or only
  /// broadcast. Sampling means most frames are broadcast-only.
  persisted: boolean;
}

interface DriverStreamState {
  lastAcceptedAtMs: number;
  lastPersistedAtMs: number;
  lastRecordedAtMs: number;
}

/// Live driver position: validate, rate-limit, sample, broadcast.
///
/// Storage is deliberately unchanged. There is no `driver_location_history`
/// table in this codebase — the name appears only in a schema comment — so
/// nothing is "persisted as history" here. What exists is
/// `driver_locations` (one upserted row per driver) plus the Redis GEO index,
/// and both are written through `LocationService.updateLocation`, the same call
/// `POST /drivers/location` makes, so plausibility checks, the verified-and-
/// online geo-publish gate and the heartbeat all keep applying.
export class LocationStreamService {
  /// Per-driver stream state. In-memory on purpose: a driver has one socket, and
  /// that socket lives on exactly one instance, so the throttle is correct
  /// per-process without a round trip. It is a rate limiter, not a source of
  /// truth — losing it on restart costs one extra write.
  private readonly state = new Map<string, DriverStreamState>();

  constructor(private readonly locationService: LocationService) {}

  parse(payload: unknown): LocationFrame {
    const result = locationFrameSchema.safeParse(payload);
    if (!result.success) {
      throw new InvalidSocketPayloadError('Malformed location frame', result.error.issues);
    }
    return result.data;
  }

  /// Validates and applies one frame. Throws a coded `RealtimeError` for every
  /// rejection so the caller can answer the client without leaking internals.
  async accept(
    principal: SocketPrincipal,
    payload: unknown,
    now = Date.now(),
  ): Promise<AcceptedLocation> {
    // Only an operable driver has a driverId; a customer, or a suspended driver,
    // never gets one, so this is what refuses both.
    if (!principal.driverId) {
      throw new SocketForbiddenError('Only an operable driver may publish a location');
    }
    const frame = this.parse(payload);
    const driverId = principal.driverId;
    const previous = this.state.get(driverId);

    // Backpressure. Frames arriving faster than the floor are dropped, not
    // queued — a client with a runaway timer must not be able to make the
    // server buffer on its behalf.
    if (previous && now - previous.lastAcceptedAtMs < realtimeConfig.locationMinIntervalMs) {
      throw new LocationRateLimitedError(
        realtimeConfig.locationMinIntervalMs - (now - previous.lastAcceptedAtMs),
      );
    }

    const recordedAtMs = frame.recordedAt ? Date.parse(frame.recordedAt) : now;
    if (Number.isNaN(recordedAtMs)) {
      throw new InvalidSocketPayloadError('recordedAt is not a valid timestamp');
    }
    // A frame from the future is a broken client clock, not a position.
    if (recordedAtMs > now + realtimeConfig.locationMaxAgeMs) {
      throw new StaleLocationError('This location frame is timestamped in the future');
    }
    if (now - recordedAtMs > realtimeConfig.locationMaxAgeMs) {
      throw new StaleLocationError();
    }
    // Out of order: a burst replayed after a tunnel must never overwrite a
    // newer fix that already landed.
    if (previous && recordedAtMs < previous.lastRecordedAtMs) {
      throw new StaleLocationError();
    }

    // Sampling. Every accepted frame is broadcast; only every
    // `locationPersistIntervalMs` is written through to Postgres and Redis.
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

    this.state.set(driverId, {
      lastAcceptedAtMs: now,
      lastRecordedAtMs: recordedAtMs,
      lastPersistedAtMs: shouldPersist ? now : (previous?.lastPersistedAtMs ?? now),
    });

    return {
      persisted: shouldPersist,
      envelope: socketEnvelope(
        randomUUID(),
        SOCKET_EVENT.DRIVER_LOCATION,
        {
          driverId,
          latitude: frame.latitude,
          longitude: frame.longitude,
          heading: frame.heading ?? null,
          speedKmh: frame.speedKmh ?? null,
          accuracyMeters: frame.accuracyMeters ?? null,
          recordedAt: new Date(recordedAtMs).toISOString(),
        },
        new Date(recordedAtMs),
      ),
    };
  }

  /// Called on disconnect so a long-lived process does not accumulate one entry
  /// per driver that ever connected.
  forget(driverId: string): void {
    this.state.delete(driverId);
  }
}
