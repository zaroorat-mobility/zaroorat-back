import { driverConfig } from '@config';

export interface PreviousFix {
  latitude: number;
  longitude: number;
  recordedAt: Date;
}

export interface IncomingFix {
  latitude: number;
  longitude: number;
  recordedAt?: Date;
}

export type PlausibilityVerdict =
  | { plausible: true }
  | { plausible: false; reason: 'out_of_range' | 'stale' | 'impossible_speed'; detail: string };

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function assessPlausibility(
  incoming: IncomingFix,
  previous: PreviousFix | null,
  now: Date = new Date(),
): PlausibilityVerdict {
  const { latitude, longitude } = incoming;

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return {
      plausible: false,
      reason: 'out_of_range',
      detail: `(${latitude}, ${longitude}) is not a valid coordinate`,
    };
  }

  const recordedAt = incoming.recordedAt ?? now;
  const ageSeconds = (now.getTime() - recordedAt.getTime()) / 1000;
  if (ageSeconds > driverConfig.locationMaxAgeSeconds) {
    return {
      plausible: false,
      reason: 'stale',
      detail: `fix is ${Math.round(ageSeconds)}s old, limit ${driverConfig.locationMaxAgeSeconds}s`,
    };
  }

  if (!previous) return { plausible: true };

  const elapsedSeconds = (recordedAt.getTime() - previous.recordedAt.getTime()) / 1000;

  if (elapsedSeconds <= 0) return { plausible: true };

  const distanceKm = haversineKm(previous.latitude, previous.longitude, latitude, longitude);

  if (distanceKm * 1000 <= driverConfig.locationNoiseFloorMeters) {
    return { plausible: true };
  }

  const impliedKmh = (distanceKm / elapsedSeconds) * 3600;
  if (impliedKmh > driverConfig.locationMaxSpeedKmh) {
    return {
      plausible: false,
      reason: 'impossible_speed',
      detail:
        `${distanceKm.toFixed(2)}km in ${elapsedSeconds.toFixed(1)}s implies ` +
        `${Math.round(impliedKmh)}km/h, limit ${driverConfig.locationMaxSpeedKmh}km/h`,
    };
  }

  return { plausible: true };
}
