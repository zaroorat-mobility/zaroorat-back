import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

/// A ride's distance is longer than any journey the platform expects to serve,
/// so a counter left behind by a ride that never completed expires on its own
/// rather than leaking into a driver's next trip. `startRide` resets it anyway;
/// this is the backstop for a ride that was abandoned without one.
const TRIP_DISTANCE_TTL_SECONDS = 12 * 60 * 60;

/// The distance a driver has actually covered on the trip they are currently
/// running, accumulated from the location fixes their app already sends.
///
/// Keyed by driver rather than by ride, which is safe because
/// `rides_active_driver_key` permits exactly one active ride per driver, and
/// means the location endpoint never has to resolve a ride: the lifecycle
/// resets the counter when the trip starts and reads it when the trip ends.
/// A client-supplied `rideId` is never trusted for this — the fare depends on
/// it.
///
/// Redis, not a column, so this needed no migration. Losing the key loses the
/// accumulation, and the fare then falls back to the quoted distance — which is
/// what `max(measured, quoted)` does anyway, so the failure mode is a fare that
/// is never higher than the trip justified, never a fare invented from nothing.
export class TripDistanceStore {
  private readonly client: Redis;
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  async add(driverId: string, km: number): Promise<void> {
    if (!Number.isFinite(km) || km <= 0) return;
    const key = RedisKeys.tripDistance(driverId);
    await this.client.incrbyfloat(key, km);
    await this.client.expire(key, TRIP_DISTANCE_TTL_SECONDS);
  }

  /// Zero rather than null when nothing was accumulated: a trip with no usable
  /// fixes has covered no *measured* distance, and the caller's `max` against
  /// the quote is what decides the fare from there.
  async read(driverId: string): Promise<number> {
    const raw = await this.client.get(RedisKeys.tripDistance(driverId));
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  async reset(driverId: string): Promise<void> {
    await this.client.del(RedisKeys.tripDistance(driverId));
  }
}
