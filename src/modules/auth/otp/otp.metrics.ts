import { logger } from '@shared/logger/index.js';

/** Fields attached to an OTP metric event (never a code or secret). */
export type OtpMetricFields = Record<string, string | number | boolean>;

/**
 * Emits OTP lifecycle counters for monitoring and alerting.
 *
 * This log-based implementation writes one structured line per event (`metric:
 * otp.*`), which a log pipeline can turn into counters today. It is a drop-in
 * seam: swapping in a Prometheus/OpenTelemetry backend later means changing only
 * this class, not any call site. Never include the OTP code in `fields`.
 */
export class OtpMetrics {
  /** OTP requested and delivered (a code was minted and sent). */
  sent(fields?: OtpMetricFields): void {
    this.emit('sent', fields);
  }

  /** A code verified successfully. */
  success(fields?: OtpMetricFields): void {
    this.emit('success', fields);
  }

  /** A verification failed on a wrong code. */
  failed(fields?: OtpMetricFields): void {
    this.emit('failed', fields);
  }

  /** A verification failed because the challenge had expired. */
  expired(fields?: OtpMetricFields): void {
    this.emit('expired', fields);
  }

  /** A phone crossed the lockout threshold. */
  locked(fields?: OtpMetricFields): void {
    this.emit('locked', fields);
  }

  /** A send was rejected by a rate limit. */
  rateLimited(fields?: OtpMetricFields): void {
    this.emit('rate_limited', fields);
  }

  /** The SMS provider did not accept a send. */
  providerFailure(fields?: OtpMetricFields): void {
    this.emit('provider_failure', fields);
  }

  private emit(event: string, fields?: OtpMetricFields): void {
    logger.info({ metric: `otp.${event}`, ...fields }, `[metric] otp.${event}`);
  }
}
