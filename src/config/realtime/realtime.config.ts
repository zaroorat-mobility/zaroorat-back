import { numericEnv } from '../env/numeric.js';
export interface RealtimeConfig {
  /// Lets an operator run the API with no socket server at all — the HTTP API
  /// and the outbox keep working, clients simply get no live updates.
  enabled: boolean;
  path: string;
  corsOrigins: string[] | true;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  /// A location frame is a few hundred bytes; anything larger than this is not
  /// a client this server serves.
  maxPayloadBytes: number;
  /// Floor on the gap between two accepted location frames from one driver.
  /// Anything faster is dropped rather than queued — backpressure, not a buffer.
  locationMinIntervalMs: number;
  /// How often an accepted frame is actually written through to
  /// `driver_locations` and the Redis GEO index. Between writes the frame is
  /// still broadcast to the ride room; only durable storage is sampled.
  locationPersistIntervalMs: number;
  /// Frames older than this are refused as stale — a queued burst replayed
  /// after a tunnel must not overwrite a newer position.
  locationMaxAgeMs: number;
  /// 'memory' is correct for a single API instance. 'redis' fans room emits out
  /// across instances and is required the moment there is more than one.
  adapter: 'memory' | 'redis';
}
function origins(): string[] | true {
  const raw = process.env.REALTIME_CORS_ORIGINS?.trim();
  if (raw)
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  return process.env.APP_ENV === 'production'
    ? ['https://zaroorat.com', 'https://admin.zaroorat.com']
    : true;
}
export const realtimeConfig: RealtimeConfig = Object.freeze({
  enabled: process.env.REALTIME_ENABLED !== 'false',
  path: process.env.REALTIME_PATH ?? '/socket.io',
  corsOrigins: origins(),
  pingIntervalMs: numericEnv('REALTIME_PING_INTERVAL_MS', 25_000, { min: 1_000, integer: true }),
  pingTimeoutMs: numericEnv('REALTIME_PING_TIMEOUT_MS', 20_000, { min: 1_000, integer: true }),
  maxPayloadBytes: numericEnv('REALTIME_MAX_PAYLOAD_BYTES', 8_192, { min: 256, integer: true }),
  // A floor of 0 would disable backpressure entirely.
  locationMinIntervalMs: numericEnv('REALTIME_LOCATION_MIN_INTERVAL_MS', 1_000, {
    min: 1,
    integer: true,
  }),
  locationPersistIntervalMs: numericEnv('REALTIME_LOCATION_PERSIST_INTERVAL_MS', 5_000, {
    min: 0,
    integer: true,
  }),
  locationMaxAgeMs: numericEnv('REALTIME_LOCATION_MAX_AGE_MS', 30_000, {
    min: 1_000,
    integer: true,
  }),
  adapter: process.env.REALTIME_ADAPTER === 'redis' ? 'redis' : 'memory',
});
