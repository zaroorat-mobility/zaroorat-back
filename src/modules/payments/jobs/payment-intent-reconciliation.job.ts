import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { logger } from '@shared/logger/index.js';
import { IntentService } from '../services/intent/intent.service.js';
import { PaymentMetrics } from '../metrics/payment.metrics.js';

export interface PaymentIntentReconciliationReport {
  scanned: number;
  transitioned: number;
  stillPending: number;
  failed: number;
}

const STALE_AFTER_MS = 15 * 60 * 1000;
const BATCH_SIZE = 100;

/// spec section 14. A `PaymentIntent` stuck at `PENDING`/`PROCESSING` past a
/// reasonable window means either the webhook never arrived (dropped
/// delivery, misconfigured endpoint) or arrived and failed before reaching
/// `applyConfirmation`. This job is the backstop: for each stale intent it
/// actively queries the provider it was actually created with
/// (`PaymentIntent.gateway` — never current routing, exactly like every
/// other post-creation gateway lookup in this module) and runs the SAME
/// `IntentService.confirmIntent` → `applyConfirmation` path a webhook would
/// have taken, so a driver's subscription/recharge or a customer's fare
/// still settles correctly even if the webhook itself never showed up.
///
/// Deliberately never writes to a wallet, ledger, or subscription directly —
/// `confirmIntent` is the only entry point, so this can only ever produce
/// the exact same idempotent business effect a normal webhook would have.
export class PaymentIntentReconciliationJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly intentService: IntentService,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}

  async run(now: Date = new Date()): Promise<PaymentIntentReconciliationReport> {
    const lockToken = await this.redis.lock.acquire('job:payment_intent_reconciliation', 60_000);
    if (!lockToken) {
      logger.info('Payment intent reconciliation job lock held by another process');
      return { scanned: 0, transitioned: 0, stillPending: 0, failed: 0 };
    }
    let scanned = 0;
    let transitioned = 0;
    let stillPending = 0;
    let failed = 0;
    try {
      const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
      const staleIntents = await this.db.client.paymentIntent.findMany({
        where: {
          status: { in: ['PENDING', 'PROCESSING'] },
          updatedAt: { lt: staleBefore },
        },
        select: { id: true, gateway: true, status: true },
        take: BATCH_SIZE,
      });
      for (const intent of staleIntents) {
        scanned++;
        try {
          const before = intent.status;
          const updated = await this.intentService.confirmIntent(intent.id);
          if (updated.status !== before) {
            transitioned++;
            logger.info(
              { intentId: intent.id, gateway: intent.gateway, from: before, to: updated.status },
              '[payments] reconciliation transitioned a stale intent',
            );
          } else {
            stillPending++;
          }
        } catch (err) {
          failed++;
          this.paymentMetrics.reconciliationMismatch({ walletId: intent.id, difference: 0 });
          logger.warn(
            { err, intentId: intent.id, gateway: intent.gateway },
            '[payments] reconciliation could not resolve a stale intent — left as-is for the next run',
          );
        }
      }
    } finally {
      await this.redis.lock.release('job:payment_intent_reconciliation', lockToken);
    }
    return { scanned, transitioned, stillPending, failed };
  }
}
