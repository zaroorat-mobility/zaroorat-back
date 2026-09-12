import { Prisma } from '../../../../generated/prisma';
import { TransactionManager } from '@core/database';
import { logger } from '@shared/logger/index.js';
import { WebhookRepository } from '../../repositories/webhook.repository.js';
import { IntentService } from '../intent/intent.service.js';
import { PaymentGatewayResolverService } from '../gateway/payment-gateway-resolver.service.js';
import type { PaymentGatewayName } from '@config/payment/payment.config.js';
import { verifyRazorpayWebhookSignature } from '../../../../integrations/razorpay/razorpay.client.js';
import { verifyStripeWebhookSignature } from '../../../../integrations/stripe/stripe.client.js';
import {
  parseRazorpayWebhook,
  parseStripeWebhook,
  type GatewayWebhookPayload,
  type ParsedWebhookEvent,
} from '../../utils/webhook-payload-parser.js';
import {
  WebhookEventIdMissingError,
  WebhookReplayError,
  WebhookSignatureError,
} from '../../errors/payment.errors.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import { paymentConfig } from '@config';

export interface WebhookProcessResult {
  processed: boolean;
  isDuplicate: boolean;
  eventId: string;
}

export type { GatewayWebhookPayload };

/// Everything a provider's own webhook route hands over — the raw headers a
/// specific provider's verifier/parser needs (Razorpay's event-id header),
/// never assumed to look like any other provider's.
export interface GatewayWebhookRequest {
  gateway: PaymentGatewayName;
  rawBody: string | Buffer;
  signature: string;
  payload: GatewayWebhookPayload;
  /// Razorpay only — `X-Razorpay-Event-Id`; Razorpay puts no event id in the
  /// body at all.
  eventIdHeader?: string | undefined;
}

const SUPPORTED_GATEWAYS: readonly PaymentGatewayName[] = ['razorpay', 'stripe'];

export class WebhookService {
  constructor(
    private readonly webhookRepo: WebhookRepository,
    private readonly intentService: IntentService,
    private readonly gatewayResolver: PaymentGatewayResolverService,
    private readonly txManager: TransactionManager,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}

  /// One pipeline for both providers' own webhook routes:
  /// verify (provider-specific formula) → persist the external event id
  /// (idempotency) → parse (provider-specific payload shape) → resolve the
  /// PaymentIntent → apply the state transition → outbox event, inside one
  /// DB transaction. A duplicate delivery is a no-op at the persist step,
  /// before any business effect runs.
  async handleGatewayWebhook(request: GatewayWebhookRequest): Promise<WebhookProcessResult> {
    const { gateway } = request;
    this.paymentMetrics.webhookReceived({ gateway });

    if (!SUPPORTED_GATEWAYS.includes(gateway)) {
      this.paymentMetrics.webhookFailure({ gateway, reason: 'unsupported_gateway' });
      throw new WebhookSignatureError();
    }

    const webhookSecret = await this.gatewayResolver.webhookSecretFor(gateway);
    if (!this.verifySignature(request, webhookSecret)) {
      this.paymentMetrics.webhookFailure({ gateway, reason: 'invalid_signature' });
      throw new WebhookSignatureError();
    }

    const parsed = this.parsePayload(request);
    if (!parsed.eventId) {
      this.paymentMetrics.webhookFailure({ gateway, reason: 'missing_event_id' });
      throw new WebhookEventIdMissingError();
    }
    this.assertFresh(parsed, gateway);

    return this.txManager.execute(async (tx) => {
      const { event, isDuplicate } = await this.webhookRepo.findOrPersist(
        {
          gateway,
          eventType: parsed.eventType,
          gatewayEventId: parsed.eventId as string,
          payload: (request.payload ?? {}) as Prisma.InputJsonObject,
          signature: request.signature,
        },
        tx,
      );
      if (isDuplicate) {
        this.paymentMetrics.webhookDuplicate({ gateway, eventId: event.id });
        return { processed: true, isDuplicate: true, eventId: event.id };
      }

      if (parsed.outcome != null) {
        const reference = parsed.intentReference;
        const intent = reference
          ? await this.intentService.findByGatewayReference(reference, tx)
          : null;
        if (intent) {
          await this.intentService.applyConfirmation(
            intent.id,
            parsed.outcome,
            parsed.gatewayTxnId,
            tx,
          );
        } else if (reference) {
          logger.warn(
            { gateway, eventId: event.id, reference },
            '[payments] webhook references an unknown payment intent',
          );
        }
      }

      await this.webhookRepo.markProcessed(event.id, tx);
      return { processed: true, isDuplicate: false, eventId: event.id };
    });
  }

  private verifySignature(request: GatewayWebhookRequest, secret: string): boolean {
    if (request.gateway === 'razorpay') {
      return verifyRazorpayWebhookSignature(request.rawBody, request.signature, secret);
    }
    if (request.gateway === 'stripe') {
      return verifyStripeWebhookSignature(
        request.rawBody,
        request.signature,
        secret,
        paymentConfig.webhookToleranceSeconds,
      );
    }
    return false;
  }

  private parsePayload(request: GatewayWebhookRequest): ParsedWebhookEvent {
    if (request.gateway === 'razorpay') {
      return parseRazorpayWebhook(request.payload, request.eventIdHeader ?? null);
    }
    return parseStripeWebhook(request.payload);
  }

  private assertFresh(parsed: ParsedWebhookEvent, gateway: string): void {
    if (parsed.timestampSeconds == null) {
      this.paymentMetrics.webhookFailure({ gateway, reason: 'missing_timestamp' });
      return;
    }
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - parsed.timestampSeconds);
    if (ageSeconds > paymentConfig.webhookToleranceSeconds) {
      this.paymentMetrics.webhookFailure({ gateway, reason: 'replay_window' });
      throw new WebhookReplayError(ageSeconds, paymentConfig.webhookToleranceSeconds);
    }
  }
}
