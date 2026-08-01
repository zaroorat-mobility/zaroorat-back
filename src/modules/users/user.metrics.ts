import { logger } from '@shared/logger/index.js';

/** Fields attached to a USER metric event (never a phone number, masked or not). */
export type UserMetricFields = Record<string, string | number | boolean>;

/**
 * Emits USER counters for monitoring and alerting (user doc 05 §6).
 *
 * Only the phone-change flow is instrumented, and deliberately so: it is this
 * module's only account-takeover-shaped path, the one that needs alerting even
 * when the event pipeline is unhealthy. Profile edits and collection writes are
 * ordinary self-scoped writes whose events already reach analytics — a counter on
 * them would be a second copy of the event stream with none of its guarantees.
 *
 * Log-based, following `auth/otp/otp.metrics.ts`: one structured `metric: user.*`
 * line per event, a drop-in seam for Prometheus/OpenTelemetry later. Fields carry
 * `userId` and coarse reasons only — never a number, masked or otherwise (doc 05 §5).
 */
export class UserMetrics {
  /** A change was requested for a new number. */
  phoneChangeRequested(fields?: UserMetricFields): void {
    this.emit('phone.change_request', fields);
  }

  /** The change committed. */
  phoneChangeSucceeded(fields?: UserMetricFields): void {
    this.emit('phone.change_success', fields);
  }

  /** Verification failed — wrong code, expired challenge, or a lost uniqueness race. */
  phoneChangeFailed(fields?: UserMetricFields): void {
    this.emit('phone.change_failed', fields);
  }

  /** A change request was rejected by the per-account cap (R-USER-15). */
  phoneRateLimited(fields?: UserMetricFields): void {
    this.emit('phone.rate_limited', fields);
  }

  private emit(event: string, fields?: UserMetricFields): void {
    logger.info({ metric: `user.${event}`, ...fields }, `[metric] user.${event}`);
  }
}
