import { EventPublisher } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { NotificationService } from '@modules/notifications';
import type { OtpDeliveryJobData } from '@/jobs/producers/index.js';
import { authEvent } from '../events';
import { OtpRepository } from '../repositories/otp.repository';
import { OtpMetrics } from '../metrics';
export interface OtpDeliveryResult {
  delivered: boolean;
  provider: string;
}
export class OtpDeliveryRetryableError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = 'OtpDeliveryRetryableError';
  }
}
export class OtpDeliveryJob {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly otpRepository: OtpRepository,
    private readonly otpMetrics: OtpMetrics,
    private readonly eventPublisher: EventPublisher,
  ) {}
  async run(data: OtpDeliveryJobData): Promise<OtpDeliveryResult> {
    const startedAt = performance.now();
    const delivery = await this.notificationService.sendOtp(data.phoneNumber, data.code);
    const latencyMs = Math.round(performance.now() - startedAt);
    if (delivery.accepted) {
      await this.otpRepository.recordDelivery(data.challengeId, 'sent', {
        provider: delivery.provider,
        latencyMs,
        ...(delivery.providerRef != null ? { providerRef: delivery.providerRef } : {}),
      });
      this.otpMetrics.sent({ provider: delivery.provider, latencyMs });
      await this.eventPublisher.publish(
        authEvent('auth.otp.sent', {
          data: {
            phoneNumber: data.phoneNumber,
            purpose: data.purpose,
            provider: delivery.provider,
            providerRef: delivery.providerRef ?? null,
          },
        }),
      );
      return { delivered: true, provider: delivery.provider };
    }
    this.otpMetrics.providerFailure({
      provider: delivery.provider,
      result: delivery.retryable ? 'retryable' : 'terminal',
    });
    if (delivery.retryable) {
      this.otpMetrics.retry({ provider: delivery.provider });
      throw new OtpDeliveryRetryableError(
        delivery.error ?? 'provider rejected the message',
        delivery.provider,
      );
    }
    await this.otpRepository.recordDelivery(data.challengeId, 'failed', {
      provider: delivery.provider,
      latencyMs,
      failureReason: delivery.error ?? 'delivery_rejected',
    });
    logger.warn(
      { challengeId: data.challengeId, provider: delivery.provider, error: delivery.error },
      '[OTP] delivery permanently rejected by provider',
    );
    return { delivered: false, provider: delivery.provider };
  }
  async markExhausted(challengeId: string, reason: string): Promise<void> {
    await this.otpRepository.recordDelivery(challengeId, 'failed', {
      failureReason: `delivery_exhausted: ${reason}`,
    });
    this.otpMetrics.deliveryExhausted();
    logger.error({ challengeId, reason }, '[OTP] delivery exhausted every attempt');
  }
}
