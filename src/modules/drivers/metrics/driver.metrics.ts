import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';

export type DriverMetricFields = Record<string, string | number | boolean>;

export class DriverMetrics {
  driverRegistered(fields?: DriverMetricFields): void {
    this.emit('registered_total', fields);
  }

  driverVerified(fields?: DriverMetricFields): void {
    this.emit('verified_total', fields);
  }

  driverOnline(fields?: DriverMetricFields): void {
    this.emit('online_total', fields);
  }

  driverOffline(fields?: DriverMetricFields): void {
    this.emit('offline_total', fields);
  }

  driverSuspended(fields?: DriverMetricFields): void {
    this.emit('suspended_total', fields);
  }

  heartbeatReceived(fields?: DriverMetricFields): void {
    this.emit('heartbeat_total', fields);
  }

  heartbeatTimeout(fields?: DriverMetricFields): void {
    this.emit('heartbeat_timeout_total', fields);
  }

  locationUpdated(fields?: DriverMetricFields): void {
    this.emit('location_update_total', fields);
  }

  mockLocationRejected(fields?: DriverMetricFields): void {
    this.emit('mock_location_rejected_total', fields);
  }

  implausibleLocationRejected(fields?: DriverMetricFields): void {
    this.emit('implausible_location_rejected_total', fields);
  }

  documentExpired(fields?: DriverMetricFields): void {
    this.emit('document_expired_total', fields);
  }

  private emit(event: string, fields?: DriverMetricFields): void {
    incrementCounter(`driver_${event}`, fields);
    logger.info({ metric: `driver.${event}`, ...fields }, `[metric] driver.${event}`);
  }
}
