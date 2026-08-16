import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';
export type OtpMetricFields = Record<string, string | number | boolean>;
export class OtpMetrics {
  queued(fields?: OtpMetricFields): void {
    this.emit('queued', fields);
  }
  sent(fields?: OtpMetricFields): void {
    this.emit('sent', fields);
  }
  retry(fields?: OtpMetricFields): void {
    this.emit('retry', fields);
  }
  deliveryExhausted(fields?: OtpMetricFields): void {
    this.emit('delivery_exhausted', fields);
  }
  success(fields?: OtpMetricFields): void {
    this.emit('success', fields);
  }
  failed(fields?: OtpMetricFields): void {
    this.emit('failed', fields);
  }
  expired(fields?: OtpMetricFields): void {
    this.emit('expired', fields);
  }
  locked(fields?: OtpMetricFields): void {
    this.emit('locked', fields);
  }
  rateLimited(fields?: OtpMetricFields): void {
    this.emit('rate_limited', fields);
  }
  providerFailure(fields?: OtpMetricFields): void {
    this.emit('provider_failure', fields);
  }
  private emit(event: string, fields?: OtpMetricFields): void {
    incrementCounter(`otp_${event}`, fields);
    logger.info({ metric: `otp.${event}`, ...fields }, `[metric] otp.${event}`);
  }
}
