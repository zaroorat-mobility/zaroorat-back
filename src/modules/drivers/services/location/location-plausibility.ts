import { driverConfig, rideConfig } from '@config';
import { haversineKm, isValidCoordinate } from '@modules/location';
export interface PreviousFix {
  latitude: number;
  longitude: number;
  recordedAt: Date;
}
export interface IncomingFix {
  latitude: number;
  longitude: number;
  /// Client-reported fix time. Only ever used to refuse a fix that is invalid,
  /// stale or from the future — never to measure elapsed time.
  recordedAt?: Date;
  accuracyMeters?: number;
}
/// The numbers behind a verdict, for structured logs. They never decide anything.
export interface PlausibilityFacts {
  elapsedSeconds: number;
  distanceKm: number;
  /// null when no time has elapsed since the last fix.
  impliedKmh: number | null;
}
export type PlausibilityRejectionReason =
  | 'out_of_range'
  | 'invalid_timestamp'
  | 'future_timestamp'
  | 'stale'
  | 'impossible_speed'
  | 'poor_accuracy';
export type PlausibilityVerdict =
  | {
      plausible: true;
      /// Set when a stale last fix was replaced rather than speed-checked.
      baselineReset?: PlausibilityFacts;
    }
  | {
      plausible: false;
      reason: PlausibilityRejectionReason;
      detail: string;
      facts?: PlausibilityFacts;
    };
export interface PlausibilityPolicy {
  maxSpeedKmh: number;
  maxAgeSeconds: number;
  noiseFloorMeters: number;
  staleBaselineSeconds: number;
  /// A fix less accurate than this cannot replace a stale baseline — the same
  /// trust bar the trip meter applies before a fix may move a fare.
  resetMaxAccuracyMeters: number;
}
export function defaultPlausibilityPolicy(): PlausibilityPolicy {
  return {
    maxSpeedKmh: driverConfig.locationMaxSpeedKmh,
    maxAgeSeconds: driverConfig.locationMaxAgeSeconds,
    noiseFloorMeters: driverConfig.locationNoiseFloorMeters,
    staleBaselineSeconds: driverConfig.locationStaleBaselineSeconds,
    resetMaxAccuracyMeters: rideConfig.distanceMaxAccuracyMeters,
  };
}
function reject(
  reason: PlausibilityRejectionReason,
  detail: string,
  facts?: PlausibilityFacts,
): PlausibilityVerdict {
  return { plausible: false, reason, detail, ...(facts ? { facts } : {}) };
}
/// Is this fix believable given the last accepted one?
///
/// Elapsed time is measured on the server clock (`now` against the server-
/// stamped `previous.recordedAt`), so nothing the client sends can stretch it
/// to get past the speed check.
///
/// The speed check only means something against a recent fix. A last fix
/// older than `staleBaselineSeconds` no longer says where the driver is — the
/// device was off, the driver flew, or that fix was itself wrong — and
/// measuring against it refused every new fix until enough hours passed for
/// the jump to look slow, keeping the driver out of dispatch the whole time.
/// So a jump from a stale baseline replaces it (reported as `baselineReset`),
/// provided the new fix is accurate enough to be trusted as the new baseline.
export function assessPlausibility(
  incoming: IncomingFix,
  previous: PreviousFix | null,
  now: Date = new Date(),
  policy: PlausibilityPolicy = defaultPlausibilityPolicy(),
): PlausibilityVerdict {
  const { latitude, longitude } = incoming;
  if (!isValidCoordinate(latitude, longitude)) {
    return reject('out_of_range', `(${latitude}, ${longitude}) is not a valid coordinate`);
  }
  if (latitude === 0 && longitude === 0) {
    return reject('out_of_range', '(0, 0) is the null fix a failed GPS reports, not a position');
  }
  if (incoming.recordedAt !== undefined) {
    const recordedMs = incoming.recordedAt.getTime();
    if (!Number.isFinite(recordedMs)) {
      return reject('invalid_timestamp', 'fix timestamp is not a valid date');
    }
    const ageSeconds = (now.getTime() - recordedMs) / 1000;
    if (ageSeconds < -policy.maxAgeSeconds) {
      return reject(
        'future_timestamp',
        `fix is timestamped ${Math.round(-ageSeconds)}s in the future, tolerance ${policy.maxAgeSeconds}s`,
      );
    }
    if (ageSeconds > policy.maxAgeSeconds) {
      return reject(
        'stale',
        `fix is ${Math.round(ageSeconds)}s old, limit ${policy.maxAgeSeconds}s`,
      );
    }
  }
  if (!previous) return { plausible: true };

  const distanceKm = haversineKm(previous.latitude, previous.longitude, latitude, longitude);
  if (distanceKm * 1000 <= policy.noiseFloorMeters) {
    return { plausible: true };
  }
  const elapsedSeconds = (now.getTime() - previous.recordedAt.getTime()) / 1000;
  const impliedKmh = elapsedSeconds > 0 ? (distanceKm / elapsedSeconds) * 3600 : null;
  if (impliedKmh !== null && impliedKmh <= policy.maxSpeedKmh) {
    return { plausible: true };
  }

  const facts: PlausibilityFacts = {
    elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
    distanceKm: Math.round(distanceKm * 100) / 100,
    impliedKmh: impliedKmh === null ? null : Math.round(impliedKmh),
  };
  // Older than the stale window in either direction (a baseline stamped
  // far in the future is just as unusable) — or unreadable.
  const staleBaseline =
    !Number.isFinite(elapsedSeconds) || Math.abs(elapsedSeconds) > policy.staleBaselineSeconds;
  if (!staleBaseline) {
    return reject(
      'impossible_speed',
      impliedKmh === null
        ? `${distanceKm.toFixed(2)}km with no time elapsed since the last fix`
        : `${distanceKm.toFixed(2)}km in ${elapsedSeconds.toFixed(1)}s implies ` +
            `${Math.round(impliedKmh)}km/h, limit ${policy.maxSpeedKmh}km/h`,
      facts,
    );
  }
  if (
    incoming.accuracyMeters !== undefined &&
    incoming.accuracyMeters > policy.resetMaxAccuracyMeters
  ) {
    return reject(
      'poor_accuracy',
      `a fix accurate only to ${Math.round(incoming.accuracyMeters)}m cannot replace a stale ` +
        `location, limit ${policy.resetMaxAccuracyMeters}m`,
      facts,
    );
  }
  return { plausible: true, baselineReset: facts };
}
