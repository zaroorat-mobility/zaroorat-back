import { Prisma } from '../../../../generated/prisma';
import { TransactionManager } from '@core/database';
import { logger } from '@shared/logger/index.js';
import { WebhookRepository } from '../../repositories/webhook.repository.js';
import { IntentService } from '../intent/intent.service.js';
import { verifyWebhookSignature } from '../../utils/signature.util.js';
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

export type GatewayWebhookPayload = Record<string, unknown> | null | undefined;

function pick(source: GatewayWebhookPayload, ...path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Event types that settle an intent. Anything else is recorded and ignored. */
const SETTLEMENT_EVENTS = new Set([
  'payment_intent.succeeded',
  'payment.succeeded',
  'payment_intent.payment_failed',
  'payment.failed',
]);

const FAILURE_EVENTS = new Set(['payment_intent.payment_failed', 'payment.failed']);

export class WebhookService {
  constructor(
    private readonly webhookRepo: WebhookRepository,
    private readonly intentService: IntentService,
    private readonly txManager: TransactionManager,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}

  async handleGatewayWebhook(
    gateway: string,
    rawBody: string | Buffer,
    signature: string,
    payload: GatewayWebhookPayload,
  ): Promise<WebhookProcessResult> {
    this.paymentMetrics.webhookReceived({ gateway });

    if (!verifyWebhookSignature(rawBody, signature, paymentConfig.webhookSecret)) {
      this.paymentMetrics.webhookFailure({ gateway, reason: 'invalid_signature' });
      throw new WebhookSignatureError();
    }

    const eventId = this.readEventId(payload);
    if (!eventId) {
      this.paymentMetrics.webhookFailure({ gateway, reason: 'missing_event_id' });
      throw new WebhookEventIdMissingError();
    }

    this.assertFresh(payload, gateway);

    const eventType = String(pick(payload, 'event') ?? pick(payload, 'type') ?? '');

    return this.txManager.execute(async (tx) => {
      const { event, isDuplicate } = await this.webhookRepo.findOrPersist(
        {
          gateway,
          eventType,
          gatewayEventId: eventId,
          // Persist the parsed payload for the audit trail. `?? {}` because an
          // empty body parses to null and the column is non-nullable JSON.
          //
          // The cast is justified by provenance, not by assumption: this value
          // came from `JSON.parse` in the raw-body parser, so it is valid JSON
          // by construction — which is exactly what `InputJsonObject` requires
          // and what `Record<string, unknown>` cannot prove to the compiler.
          payload: (payload ?? {}) as Prisma.InputJsonObject,
          signature,
        },
        tx,
      );

      if (isDuplicate) {
        this.paymentMetrics.webhookDuplicate({ gateway, eventId });
        return { processed: true, isDuplicate: true, eventId: event.id };
      }

      if (SETTLEMENT_EVENTS.has(eventType)) {
        const reference = this.readIntentId(payload);
        // The payload names the payment in the GATEWAY's id space, so it is

        const intent = reference
          ? await this.intentService.findByGatewayReference(reference, tx)
          : null;

        if (intent) {
          await this.intentService.applyConfirmation(
            intent.id,
            FAILURE_EVENTS.has(eventType) ? 'FAILED' : 'SUCCEEDED',
            this.readGatewayTxnId(payload),
            tx,
          );
        } else if (reference) {
          logger.warn(
            { gateway, eventId, reference },
            '[payments] webhook references an unknown payment intent',
          );
        }
      }

      await this.webhookRepo.markProcessed(event.id, tx);

      return { processed: true, isDuplicate: false, eventId: event.id };
    });
  }

  private assertFresh(payload: GatewayWebhookPayload, gateway: string): void {
    const timestamp = this.readTimestampSeconds(payload);
    if (timestamp == null) {
      this.paymentMetrics.webhookFailure({ gateway, reason: 'missing_timestamp' });
      return;
    }

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (ageSeconds > paymentConfig.webhookToleranceSeconds) {
      this.paymentMetrics.webhookFailure({ gateway, reason: 'replay_window' });
      throw new WebhookReplayError(ageSeconds, paymentConfig.webhookToleranceSeconds);
    }
  }

  private readEventId(payload: GatewayWebhookPayload): string | null {
    return (
      asNonEmptyString(pick(payload, 'id')) ??
      asNonEmptyString(pick(payload, 'event_id')) ??
      asNonEmptyString(pick(payload, 'eventId'))
    );
  }

  private readIntentId(payload: GatewayWebhookPayload): string | null {
    return (
      asNonEmptyString(pick(payload, 'data', 'object', 'id')) ??
      asNonEmptyString(pick(payload, 'payment_intent_id')) ??
      asNonEmptyString(pick(payload, 'data', 'payment_intent_id'))
    );
  }

  private readGatewayTxnId(payload: GatewayWebhookPayload): string | null {
    return (
      asNonEmptyString(pick(payload, 'data', 'object', 'charge_id')) ??
      asNonEmptyString(pick(payload, 'data', 'object', 'id'))
    );
  }

  private readTimestampSeconds(payload: GatewayWebhookPayload): number | null {
    const raw =
      pick(payload, 'created') ?? pick(payload, 'created_at') ?? pick(payload, 'timestamp');
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;

    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
}
