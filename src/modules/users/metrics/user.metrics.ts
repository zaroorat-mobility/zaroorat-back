import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';
export type UserMetricFields = Record<string, string | number | boolean>;
export class UserMetrics {
  phoneChangeRequested(fields?: UserMetricFields): void {
    this.emit('phone.change_request', fields);
  }
  phoneChangeSucceeded(fields?: UserMetricFields): void {
    this.emit('phone.change_success', fields);
  }
  phoneChangeFailed(fields?: UserMetricFields): void {
    this.emit('phone.change_failed', fields);
  }
  phoneRateLimited(fields?: UserMetricFields): void {
    this.emit('phone.rate_limited', fields);
  }
  /// `method` is set | change | reset. Never carries a PIN, a verifier, or a
  /// user id — `emit` passes fields straight into the counter labels, and an id
  /// there is unbounded cardinality.
  ridePinChanged(fields?: UserMetricFields): void {
    this.emit('ride_pin.changed', fields);
  }
  ridePinRejected(fields?: UserMetricFields): void {
    this.emit('ride_pin.rejected', fields);
  }
  ridePinRateLimited(fields?: UserMetricFields): void {
    this.emit('ride_pin.rate_limited', fields);
  }
  accountsErased(fields?: UserMetricFields): void {
    this.emit('accounts.erased', fields);
  }
  erasureBlocked(fields?: UserMetricFields): void {
    this.emit('erasure.blocked', fields);
  }
  avatarReleaseFailed(fields?: UserMetricFields): void {
    this.emit('erasure.avatar_release_failed', fields);
  }
  private emit(event: string, fields?: UserMetricFields): void {
    incrementCounter(`user_${event}`, fields);
    logger.info({ metric: `user.${event}`, ...fields }, `[metric] user.${event}`);
  }
}
