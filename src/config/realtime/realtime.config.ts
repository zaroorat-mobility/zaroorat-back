import { numericEnv } from '../env/numeric.js';
export interface RealtimeConfig {
  enabled: boolean;
  path: string;
  corsOrigins: string[] | true;
  pingIntervalMs: number;
  pingTimeoutMs: number;

  maxPayloadBytes: number;

  locationMinIntervalMs: number;

  locationPersistIntervalMs: number;

  locationMaxAgeMs: number;

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
