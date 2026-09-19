import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverSubscription } from '../types';

export class DriverSubscriptionRepository {
  constructor(private readonly db: DatabaseService) {}

  /// spec.md FR-004 — the eligibility-check query, on the hot path of every
  /// subscription-model driver's ride offer/acceptance. `expiryDate > now` is
  /// re-checked by the caller as defense-in-depth against the expiry sweep
  /// lagging (data-model.md §6).
  async findActive(driverId: string, tx?: TransactionClient): Promise<DriverSubscription | null> {
    const client = tx ?? this.db.client;
    return client.driverSubscription.findFirst({
      where: { driverId, status: 'ACTIVE' },
    });
  }

  async findPending(driverId: string, tx?: TransactionClient): Promise<DriverSubscription | null> {
    const client = tx ?? this.db.client;
    return client.driverSubscription.findFirst({
      where: { driverId, status: 'PENDING_PAYMENT' },
    });
  }

  async lockForUpdate(driverId: string, tx: TransactionClient): Promise<DriverSubscription | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "driver_subscriptions"
      WHERE "driver_id" = ${driverId}::uuid AND "status" = 'ACTIVE'
      FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.driverSubscription.findUnique({ where: { id: locked[0]!.id } });
  }

  /// `paymentIntentId` is nullable in the schema — the row is created
  /// PENDING_PAYMENT before the intent exists (see `SubscriptionService
  /// .purchase`'s own comment) and back-filled once it does. Passing `''`
  /// instead of omitting it fails at the database with "invalid input syntax
  /// for type uuid" — every purchase call did, until this was caught by
  /// `subscription-lifecycle.test.ts` actually exercising the route.
  async create(
    data: { driverId: string; planId: string; paymentIntentId?: string | null },
    tx?: TransactionClient,
  ): Promise<DriverSubscription> {
    const client = tx ?? this.db.client;
    return client.driverSubscription.create({
      data: {
        driverId: data.driverId,
        planId: data.planId,
        paymentIntentId: data.paymentIntentId ?? null,
        status: 'PENDING_PAYMENT',
        paymentStatus: 'PENDING',
      },
    });
  }

  async findByPaymentIntentId(
    paymentIntentId: string,
    tx?: TransactionClient,
  ): Promise<DriverSubscription | null> {
    const client = tx ?? this.db.client;
    return client.driverSubscription.findFirst({ where: { paymentIntentId } });
  }

  /// Conditional claim (constitution §5.2) — a redelivered activation event
  /// finds the row already ACTIVE and this is a no-op, never a double
  /// activation.
  async activateIfPending(
    id: string,
    startDate: Date,
    expiryDate: Date,
    tx: TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.driverSubscription.updateMany({
      where: { id, status: 'PENDING_PAYMENT' },
      data: { status: 'ACTIVE', paymentStatus: 'PAID', startDate, expiryDate },
    });
    return count === 1;
  }

  /// Phase 1 refunds. A subscription whose payment was refunded no longer
  /// entitles the driver to new rides. PENDING_PAYMENT is included so an
  /// activation event that arrives after the refund can never activate it
  /// (`activateIfPending` only claims PENDING_PAYMENT). Rides already accepted
  /// are unaffected — completion never consults the subscription.
  async endForRefund(paymentIntentId: string, tx?: TransactionClient): Promise<number> {
    const client = tx ?? this.db.client;
    const { count } = await client.driverSubscription.updateMany({
      where: { paymentIntentId, status: { in: ['ACTIVE', 'PENDING_PAYMENT'] } },
      data: { status: 'REFUNDED' },
    });
    return count;
  }

  async requestCancel(driverId: string, tx?: TransactionClient): Promise<boolean> {
    const client = tx ?? this.db.client;
    const { count } = await client.driverSubscription.updateMany({
      where: { driverId, status: 'ACTIVE' },
      data: { cancelRequested: true },
    });
    return count === 1;
  }

  async stagePendingPlan(
    driverId: string,
    pendingPlanId: string,
    tx?: TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.db.client;
    const { count } = await client.driverSubscription.updateMany({
      where: { driverId, status: 'ACTIVE' },
      data: { pendingPlanId },
    });
    return count === 1;
  }

  /// BD-2/BD-3 — the scheduled sweep's query: ACTIVE rows past their expiry.
  async findDueForExpiry(
    now: Date,
    limit = 200,
    tx?: TransactionClient,
  ): Promise<DriverSubscription[]> {
    const client = tx ?? this.db.client;
    return client.driverSubscription.findMany({
      where: { status: 'ACTIVE', expiryDate: { lte: now } },
      take: limit,
    });
  }

  async expireIfActive(id: string, tx: TransactionClient): Promise<boolean> {
    const { count } = await tx.driverSubscription.updateMany({
      where: { id, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    return count === 1;
  }

  async listHistory(
    driverId: string,
    limit = 50,
    tx?: TransactionClient,
  ): Promise<
    Array<
      DriverSubscription & {
        plan: { name: string; billingPeriod: string; price: unknown; currency: string };
      }
    >
  > {
    const client = tx ?? this.db.client;
    return client.driverSubscription.findMany({
      where: { driverId },
      include: {
        plan: { select: { name: true, billingPeriod: true, price: true, currency: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
