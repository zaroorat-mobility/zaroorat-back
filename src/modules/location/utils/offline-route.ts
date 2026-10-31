import type { Coordinate } from '../types/geo.types.js';
import type { MatrixResult, RoutingResult } from '../types/map-provider.types.js';
import { haversineMeters } from './coordinate.util.js';

/// Straight line to road distance. The same assumption `pricingConfig.roadDistanceFactor`
/// makes, restated here rather than imported: the location module must not depend on
/// pricing, and this value is only ever used when no provider is reachable.
const ROAD_DISTANCE_FACTOR = 1.3;
/// Minutes per road kilometre — an assumed 20 km/h city average, matching
/// `pricingConfig.minutesPerKm`.
const MINUTES_PER_KM = 3;

/// True for an explicitly declared test environment or when ALLOW_OFFLINE_ROUTING is enabled.
export function isOfflineRoutingEnabled(): boolean {
  return (
    process.env.APP_ENV === 'test' ||
    process.env.NODE_ENV === 'test' ||
    process.env.ALLOW_OFFLINE_ROUTING === 'true' ||
    process.env.ENABLE_OFFLINE_ROUTING === 'true'
  );
}

/// Compute simulated road distance and duration derived from coordinates.
export function computeOfflineRoutingResult(
  origin: Coordinate,
  destination: Coordinate,
  providerName: string,
): RoutingResult {
  const straightLineMeters = haversineMeters(
    origin.latitude,
    origin.longitude,
    destination.latitude,
    destination.longitude,
  );
  const distanceMeters = Math.round(straightLineMeters * ROAD_DISTANCE_FACTOR);
  // Pickup and drop at the same point stays zero, so the zero-distance guard
  // above this in `PricingService.estimateTrip` still has something to catch.
  const durationSeconds =
    distanceMeters === 0 ? 0 : Math.round((distanceMeters / 1000) * MINUTES_PER_KM * 60);

  return { distanceMeters, durationSeconds, providerName };
}

/// Compute simulated distance matrix cells for driver candidate ETA calculations.
export function computeOfflineMatrixResult(
  origins: Coordinate[],
  destinations: Coordinate[],
  providerName: string,
): MatrixResult {
  const cells = origins.map((origin) =>
    destinations.map((destination) => {
      const route = computeOfflineRoutingResult(origin, destination, providerName);
      return {
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        status: 'OK' as const,
      };
    }),
  );

  return { status: 'ok', cells, providerName };
}

/// The offline stand-in for a provider's directions call, used under test or when ALLOW_OFFLINE_ROUTING=true.
///
/// It is derived from the coordinates rather than fixed, because a constant makes
/// every distance-sensitive behaviour untestable and silently unreachable: a
/// constant 12.4 km meant a 2 km ride and a 40 km ride priced identically, and
/// `ZeroDistanceTripError` could never fire because the distance was never zero.
///
/// Returns `null` when offline routing is disabled, so the caller falls through to the
/// real provider request.
export function offlineRoutingResult(
  origin: Coordinate,
  destination: Coordinate,
  providerName: string,
): RoutingResult | null {
  if (!isOfflineRoutingEnabled()) return null;
  return computeOfflineRoutingResult(origin, destination, providerName);
}

/// The offline stand-in for a provider's distance-matrix call, used under test or when ALLOW_OFFLINE_ROUTING=true.
///
/// Returns `null` when offline routing is disabled, so the caller falls through to the
/// real provider request.
export function offlineMatrixResult(
  origins: Coordinate[],
  destinations: Coordinate[],
  providerName: string,
): MatrixResult | null {
  if (!isOfflineRoutingEnabled()) return null;
  return computeOfflineMatrixResult(origins, destinations, providerName);
}
