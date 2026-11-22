import { DatabaseService, TransactionManager } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { logger } from '@shared/logger/index.js';
import { DriverSubscriptionRepository } from '../repositories/driver-subscription.repository.js';
import { SubscriptionPlanRepository } from '../repositories/subscription-plan.repository.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';

function addBillingPeriod(from: Date, billingPeriod: string): Date {
  const result = new Date(from);
  switch (billingPeriod) {
    case 'DAILY':
      result.setUTCDate(result.getUTCDate() + 1);
      return result;
    case 'MONTHLY':
      result.setUTCMonth(result.getUTCMonth() + 1);
      return result;
    case 'WEEKLY':
    default:
      result.setUTCDate(result.getUTCDate() + 7);
      return result;
  }
}

/// Backstop reconciliation job: finds PENDING_PAYMENT subscriptions whose
/// payment intent has already reached SUCCEEDED status (e.g. if the outbox event
/// was delayed or dead-lettered) and activates them idempotently.
export class SubscriptionReconciliationJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly driverSubscriptionRepository: DriverSubscriptionRepository,
    private readonly subscriptionPlanRepository: SubscriptionPlanRepository,
    private readonly driverRepository: DriverRepository,
    private readonly txManager: TransactionManager,
  ) {}

  async run(_now: Date = new Date()): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:subscription_reconciliation', 60000);
    if (!lockToken) return 0;
    let activatedCount = 0;
    try {
      const pendingSubscriptions = await this.db.client.driverSubscription.findMany({
        where: {
          status: 'PENDING_PAYMENT',
          paymentIntentId: { not: null },
        },
        take: 100,
      });

      for (const sub of pendingSubscriptions) {
        if (!sub.paymentIntentId) continue;
        try {
          const intent = await this.db.client.paymentIntent.findUnique({
            where: { id: sub.paymentIntentId },
            select: { status: true, purpose: true },
          });

          if (intent?.status === 'SUCCEEDED' && intent.purpose === 'DRIVER_SUBSCRIPTION_PAYMENT') {
            const plan = await this.subscriptionPlanRepository.findById(sub.planId);
            if (!plan) continue;

            const startDate = new Date();
            const expiryDate = addBillingPeriod(startDate, plan.billingPeriod);

            const didActivate = await this.txManager.execute(async (tx) => {
              const activated = await this.driverSubscriptionRepository.activateIfPending(
                sub.id,
                startDate,
                expiryDate,
                tx,
              );
              if (activated) {
                await this.driverRepository.updatePaymentModel(sub.driverId, 'SUBSCRIPTION', tx);
              }
              return activated;
            });

            if (didActivate) {
              activatedCount++;
              logger.info(
                { subscriptionId: sub.id, driverId: sub.driverId, intentId: sub.paymentIntentId },
                '[subscriptions] reconciliation activated a pending subscription with paid intent',
              );
            }
          }
        } catch (err) {
          logger.warn(
            { err, subscriptionId: sub.id },
            '[subscriptions] reconciliation failed to activate one subscription',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, '[subscriptions] error running subscription reconciliation job');
    } finally {
      await this.redis.lock.release('job:subscription_reconciliation', lockToken);
    }
    return activatedCount;
  }
}
