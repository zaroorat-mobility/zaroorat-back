import { Decimal } from '../types/index.js';
import { TransactionManager } from '@core/database';
import { IntentService } from '@modules/payments/services/intent/intent.service.js';
import { SubscriptionPlanRepository } from '../repositories/subscription-plan.repository.js';
import { DriverSubscriptionRepository } from '../repositories/driver-subscription.repository.js';
import {
  SubscriptionPlanNotFoundError,
  SubscriptionAlreadyActiveError,
  SubscriptionNotFoundError,
} from '../errors/subscription.errors.js';
import type { DriverSubscription, SubscriptionPlan } from '../types';

/// spec.md FR-001–FR-006b, decisions.md BD-2/BD-3/BD-5. Subscription
/// purchase/activation follows the existing intent → gateway → webhook →
/// applyConfirmation pipeline unmodified (purpose='DRIVER_SUBSCRIPTION_PAYMENT')
/// — this service never activates a subscription itself; activation happens
/// only in `SubscriptionPaymentConsumer`, reacting to the payment-confirmed
/// event, never on a client-reported success (FR-003).
export class SubscriptionService {
  constructor(
    private readonly subscriptionPlanRepository: SubscriptionPlanRepository,
    private readonly driverSubscriptionRepository: DriverSubscriptionRepository,
    private readonly intentService: IntentService,
    private readonly txManager: TransactionManager,
  ) {}

  async listActivePlans(): Promise<SubscriptionPlan[]> {
    return this.subscriptionPlanRepository.listActive();
  }

  async getStatus(driverId: string): Promise<DriverSubscription | null> {
    return this.driverSubscriptionRepository.findActive(driverId);
  }

  /// BD-3, generalised by BD-5 to a first-time purchase too: if the driver
  /// already has an ACTIVE subscription, this stages a plan change
  /// (no proration, applied at the next renewal) rather than starting a new
  /// payment. Otherwise it starts a fresh PENDING_PAYMENT subscription +
  /// payment intent.
  async purchase(
    driverId: string,
    driverUserId: string,
    planId: string,
    idempotencyKey: string,
  ): Promise<{ subscription: DriverSubscription | null; intentId: string | null }> {
    const plan = await this.subscriptionPlanRepository.findById(planId);
    if (!plan || plan.status !== 'ACTIVE') {
      throw new SubscriptionPlanNotFoundError(planId);
    }
    const active = await this.driverSubscriptionRepository.findActive(driverId);
    if (active) {
      if (active.planId === planId) {
        throw new SubscriptionAlreadyActiveError();
      }
      // BD-3: stage the change, current paid period runs its course.
      await this.driverSubscriptionRepository.stagePendingPlan(driverId, planId);
      return { subscription: active, intentId: null };
    }
    // Created PENDING_PAYMENT before the intent exists, so the driver's plan
    // selection is recorded even if intent creation is interrupted.
    // `paymentIntentId` is nullable precisely for this moment — there is no
    // intent yet to reference.
    const subscription = await this.driverSubscriptionRepository.create({
      driverId,
      planId,
    });
    // Gateway call OUTSIDE any DB transaction (constitution §8) — the same
    // pattern IntentService.createIntent already follows internally.
    const intent = await this.intentService.createIntent({
      userId: driverUserId,
      amount: new Decimal(plan.price),
      methodType: 'CARD',
      idempotencyKey,
      purpose: 'DRIVER_SUBSCRIPTION_PAYMENT',
    });
    await this.txManager.execute(async (tx) => {
      await tx.driverSubscription.update({
        where: { id: subscription.id },
        data: { paymentIntentId: intent.id },
      });
    });
    return { subscription, intentId: intent.id };
  }

  async cancel(driverId: string): Promise<void> {
    const cancelled = await this.driverSubscriptionRepository.requestCancel(driverId);
    if (!cancelled) throw new SubscriptionNotFoundError();
  }
}
