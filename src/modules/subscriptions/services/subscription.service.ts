import { Decimal } from '../types/index.js';
import { TransactionManager } from '@core/database';
import { IntentService } from '@modules/payments/services/intent/intent.service.js';
import { IdempotencyKeyRequiredError } from '@modules/payments/errors/payment.errors.js';
import { SubscriptionPlanRepository } from '../repositories/subscription-plan.repository.js';
import { DriverSubscriptionRepository } from '../repositories/driver-subscription.repository.js';
import {
  SubscriptionPlanNotFoundError,
  SubscriptionAlreadyActiveError,
  SubscriptionNotFoundError,
} from '../errors/subscription.errors.js';
import type { DriverSubscription, SubscriptionPlan } from '../types';

import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';

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
    private readonly driverRepository: DriverRepository,
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
  /// payment intent. Serialised per driver via `drivers` FOR UPDATE row lock.
  async purchase(
    driverId: string,
    driverUserId: string,
    planId: string,
    idempotencyKey: string,
  ): Promise<{ subscription: DriverSubscription | null; intentId: string | null }> {
    if (idempotencyKey.trim() === '') throw new IdempotencyKeyRequiredError();
    const plan = await this.subscriptionPlanRepository.findById(planId);
    if (!plan || plan.status !== 'ACTIVE') {
      throw new SubscriptionPlanNotFoundError(planId);
    }

    const result = await this.txManager.execute(async (tx) => {
      // 1. Lock driver row FOR UPDATE to serialize purchase decisions per driver
      await this.driverRepository.lockForUpdate(driverId, tx);

      // 2. Check ACTIVE subscription
      const active = await this.driverSubscriptionRepository.findActive(driverId, tx);
      if (active) {
        if (active.planId === planId) {
          throw new SubscriptionAlreadyActiveError();
        }
        // BD-3: stage the change, current paid period runs its course.
        await this.driverSubscriptionRepository.stagePendingPlan(driverId, planId, tx);
        return { action: 'STAGE' as const, subscription: active, intentId: null };
      }

      // 3. Check PENDING_PAYMENT subscription
      const pending = await this.driverSubscriptionRepository.findPending(driverId, tx);
      if (pending) {
        if (pending.paymentIntentId) {
          const existingIntent = await this.intentService.findById(pending.paymentIntentId);
          if (
            existingIntent &&
            (existingIntent.status === 'PENDING' ||
              existingIntent.status === 'CREATED' ||
              existingIntent.status === 'SUCCEEDED')
          ) {
            return {
              action: 'REUSE' as const,
              subscription: pending,
              intentId: pending.paymentIntentId,
            };
          }
        }
        return { action: 'ATTACH_NEW_INTENT' as const, subscription: pending, intentId: null };
      }

      // 4. Create new PENDING_PAYMENT subscription if none exists
      const newSub = await this.driverSubscriptionRepository.create({ driverId, planId }, tx);
      return { action: 'NEW' as const, subscription: newSub, intentId: null };
    });

    if (result.action === 'STAGE' || result.action === 'REUSE') {
      return { subscription: result.subscription, intentId: result.intentId };
    }

    const subscription = result.subscription;

    // Gateway call OUTSIDE any DB transaction (constitution §8) — the same
    // pattern IntentService.createIntent already follows internally.
    const intent = await this.intentService.createIntent({
      userId: driverUserId,
      amount: new Decimal(plan.price),
      methodType: 'CARD',
      // `payment_intents.idempotency_key` is unique across ALL users, so the
      // client's key is scoped to this driver — two drivers who happen to send
      // the same key can never be handed each other's intent.
      idempotencyKey: `subscription:${driverId}:${idempotencyKey}`,
      purpose: 'DRIVER_SUBSCRIPTION_PAYMENT',
    });

    await this.txManager.execute(async (tx) => {
      await tx.driverSubscription.update({
        where: { id: subscription.id },
        data: { paymentIntentId: intent.id, planId },
      });
    });

    return { subscription, intentId: intent.id };
  }

  async cancel(driverId: string): Promise<void> {
    const cancelled = await this.driverSubscriptionRepository.requestCancel(driverId);
    if (!cancelled) throw new SubscriptionNotFoundError();
  }

  /// Billing history for the authenticated driver — one row per subscription
  /// purchase / renewal attempt, joined with plan metadata.
  async listInvoices(driverId: string, limit = 50) {
    const rows = await this.driverSubscriptionRepository.listHistory(driverId, limit);
    return rows.map((row) => ({
      id: row.id,
      planId: row.planId,
      planName: row.plan.name,
      billingPeriod: row.plan.billingPeriod,
      amount: Number(row.plan.price),
      currency: row.plan.currency,
      status: row.status,
      paymentStatus: row.paymentStatus,
      paymentIntentId: row.paymentIntentId,
      startDate: row.startDate?.toISOString() ?? null,
      expiryDate: row.expiryDate?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
