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

/// True only for an explicitly declared test environment. Deliberately **not**
/// inferred from the shape of an API key.
///
/// This used to also fire on `apiKey.startsWith('test_')` and `'mock_'`, which are
/// properties of a credential rather than of the environment. A production
/// deployment whose provider key happened to begin with those characters served a
/// fabricated route for every journey in the country, while the response still
/// named the real provider as the source. The environment is the only thing that
/// may decide whether a route is real.
function isTestEnvironment(): boolean {
  return process.env.APP_ENV === 'test' || process.env.NODE_ENV === 'test';
}

/// The offline stand-in for a provider's directions call, used only under `test`.
///
/// It is derived from the coordinates rather than fixed, because a constant makes
/// every distance-sensitive behaviour untestable and silently unreachable: a
/// constant 12.4 km meant a 2 km ride and a 40 km ride priced identically, and
/// `ZeroDistanceTripError` could never fire because the distance was never zero.
///
/// Returns `null` outside a test environment, so the caller falls through to the
/// real provider request.
export function offlineRoutingResult(
  origin: Coordinate,
  destination: Coordinate,
  providerName: string,
): RoutingResult | null {
  if (!isTestEnvironment()) return null;

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

/// The offline stand-in for a provider's distance-matrix call, used only under `test`.
///
/// Routing had a stand-in and the matrix did not, so every quote in a test
/// environment reported `matrix_unavailable` and the driver-ETA path — Redis GEO
/// candidates through to the ETA the customer is shown — could never be exercised.
/// A provider error in production still returns `unavailable`, unchanged.
///
/// Returns `null` outside a test environment, so the caller falls through to the
/// real provider request.
export function offlineMatrixResult(
  origins: Coordinate[],
  destinations: Coordinate[],
  providerName: string,
): MatrixResult | null {
  if (!isTestEnvironment()) return null;

  const cells = origins.map((origin) =>
    destinations.map((destination) => {
      const route = offlineRoutingResult(origin, destination, providerName);
      return {
        distanceMeters: route?.distanceMeters ?? 0,
        durationSeconds: route?.durationSeconds ?? 0,
        status: 'OK' as const,
      };
    }),
  );

  return { status: 'ok', cells, providerName };
}
