import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';
export type SessionMetricFields = Record<string, string | number | boolean>;
export class SessionMetrics {
  created(fields?: SessionMetricFields): void {
    this.emit('created', fields);
  }
  revoked(fields?: SessionMetricFields): void {
    this.emit('revoked', fields);
  }
  logoutAll(fields?: SessionMetricFields): void {
    this.emit('logout_all', fields);
  }
  capEvicted(fields?: SessionMetricFields): void {
    this.emit('cap_evicted', fields);
  }
  deviceRegistered(fields?: SessionMetricFields): void {
    this.emit('device_registered', fields);
  }
  deviceRevoked(fields?: SessionMetricFields): void {
    this.emit('device_revoked', fields);
  }
  retentionPurged(fields?: SessionMetricFields): void {
    this.emit('retention_purged', fields);
  }
  private emit(event: string, fields?: SessionMetricFields): void {
    incrementCounter(`session_${event}`, fields);
    logger.info({ metric: `session.${event}`, ...fields }, `[metric] session.${event}`);
  }
}
