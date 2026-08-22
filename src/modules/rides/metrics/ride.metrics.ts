import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';
export type RideMetricFields = Record<string, string | number | boolean>;
export class RideMetrics {
  requestCreated(fields?: RideMetricFields): void {
    this.emit('request_created_total', fields);
  }
  dispatchOffered(fields?: RideMetricFields): void {
    this.emit('dispatch_offered_total', fields);
  }
  dispatchAccepted(fields?: RideMetricFields): void {
    this.emit('dispatch_accepted_total', fields);
  }
  dispatchRejected(fields?: RideMetricFields): void {
    this.emit('dispatch_rejected_total', fields);
  }
  dispatchTimeout(fields?: RideMetricFields): void {
    this.emit('dispatch_timeout_total', fields);
  }
  driverArriving(fields?: RideMetricFields): void {
    this.emit('driver_arriving_total', fields);
  }
  rideStarted(fields?: RideMetricFields): void {
    this.emit('started_total', fields);
  }
  rideCompleted(fields?: RideMetricFields): void {
    this.emit('completed_total', fields);
  }
  rideCancelled(fields?: RideMetricFields): void {
    this.emit('cancelled_total', fields);
  }
  otpFailure(fields?: RideMetricFields): void {
    this.emit('otp_failure_total', fields);
  }
  private emit(event: string, fields?: RideMetricFields): void {
    incrementCounter(`ride_${event}`, fields);
    logger.info({ metric: `ride.${event}`, ...fields }, `[metric] ride.${event}`);
  }
}
