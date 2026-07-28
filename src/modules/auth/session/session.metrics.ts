import { logger } from '@shared/logger/index.js';

/** Fields attached to a session metric event (never a token or secret). */
export type SessionMetricFields = Record<string, string | number | boolean>;

/**
 * Emits session/device lifecycle counters for monitoring and capacity planning.
 *
 * Log-based (one structured `metric: session.*` line per event), a drop-in seam
 * for a Prometheus/OpenTelemetry backend later. Gauge-style metrics (e.g. current
 * active-session count) are intentionally out of scope here — they belong to a
 * periodic sampler, not these event counters.
 */
export class SessionMetrics {
  /** A session was created. */
  created(fields?: SessionMetricFields): void {
    this.emit('created', fields);
  }

  /** A session was revoked (carries the reason). */
  revoked(fields?: SessionMetricFields): void {
    this.emit('revoked', fields);
  }

  /** A global logout (logout-everywhere) occurred. */
  logoutAll(fields?: SessionMetricFields): void {
    this.emit('logout_all', fields);
  }

  /** A session was evicted by the concurrency cap. */
  capEvicted(fields?: SessionMetricFields): void {
    this.emit('cap_evicted', fields);
  }

  /** A new device was registered. */
  deviceRegistered(fields?: SessionMetricFields): void {
    this.emit('device_registered', fields);
  }

  /** A device was revoked. */
  deviceRevoked(fields?: SessionMetricFields): void {
    this.emit('device_revoked', fields);
  }

  private emit(event: string, fields?: SessionMetricFields): void {
    logger.info({ metric: `session.${event}`, ...fields }, `[metric] session.${event}`);
  }
}
