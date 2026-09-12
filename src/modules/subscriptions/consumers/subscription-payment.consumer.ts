import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { TransactionManager } from '@core/database';
import { logger } from '@shared/logger/index.js';
import { PAYMENT_EVENT_CATALOG } from '@modules/payments/events/catalog.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { DriverSubscriptionRepository } from '../repositories/driver-subscription.repository.js';
import { SubscriptionPlanRepository } from '../repositories/subscription-plan.repository.js';

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

/// decisions.md BD-7 (subscription activation, not time-critical the way a
/// wallet credit is, goes through the outbox — constitution §1.5). Reacts to
/// `IntentService.applyConfirmation`'s DRIVER_SUBSCRIPTION_PAYMENT branch.
/// Idempotent by construction: `activateIfPending` is a conditional claim, so
/// a redelivered envelope for an already-ACTIVE subscription is a no-op
/// (spec.md FR-003 duplicate-confirmation requirement).
export class SubscriptionPaymentConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly driverSubscriptionRepository: DriverSubscriptionRepository,
    private readonly subscriptionPlanRepository: SubscriptionPlanRepository,
    private readonly driverRepository: DriverRepository,
    private readonly txManager: TransactionManager,
  ) {}

  register(): Unsubscribe {
    return this.eventBus.on(PAYMENT_EVENT_CATALOG.DRIVER_SUBSCRIPTION_PAYMENT_COMPLETED, (e) =>
      this.onPaymentCompleted(e),
    );
  }

  private async onPaymentCompleted(envelope: EventEnvelope): Promise<void> {
    const { paymentIntentId } = envelope.data as { paymentIntentId?: string };
    if (!paymentIntentId) return;
    try {
      const subscription =
        await this.driverSubscriptionRepository.findByPaymentIntentId(paymentIntentId);
      if (!subscription) {
        logger.warn(
          { paymentIntentId },
          '[subscriptions] payment-confirmed event for an unknown subscription',
        );
        return;
      }
      if (subscription.status !== 'PENDING_PAYMENT') {
        // Already activated by a prior delivery — safe to replay.
        return;
      }
      const plan = await this.subscriptionPlanRepository.findById(subscription.planId);
      if (!plan) return;
      const startDate = new Date();
      const expiryDate = addBillingPeriod(startDate, plan.billingPeriod);
      await this.txManager.execute(async (tx) => {
        const activated = await this.driverSubscriptionRepository.activateIfPending(
          subscription.id,
          startDate,
          expiryDate,
          tx,
        );
        if (activated) {
          // decisions.md BD-5: first selection or a COMMISSION→SUBSCRIPTION
          // switch both finalise here, on confirmed activation — never on a
          // client-reported success.
          await this.driverRepository.updatePaymentModel(subscription.driverId, 'SUBSCRIPTION', tx);
        }
      });
      logger.info(
        { subscriptionId: subscription.id, driverId: subscription.driverId },
        '[subscriptions] subscription activated',
      );
    } catch (err) {
      // Swallowed deliberately, matching RideCollectionConsumer: the relay
      // must not stall on one driver, and this is safe to retry on redelivery.
      logger.error({ err, paymentIntentId }, '[subscriptions] activation failed unexpectedly');
    }
  }
}
