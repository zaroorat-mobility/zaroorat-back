import { DatabaseService } from '@core/database';
import type { Prisma } from '../../../generated/prisma/index.js';
import { CommissionWalletService } from '@modules/payments/services/commission-wallet/commission-wallet.service.js';

/// Read-only admin views of the two ways a driver pays the platform: the prepaid commission
/// wallet and the subscription. Nothing here writes. Balances and totals come straight from the
/// wallet row and the append-only transaction table; a subscription's paid amount comes from its
/// payment intent, because the subscription row itself does not record what was charged.

const toNum = (v: { toString(): string } | null | undefined) =>
  v == null ? 0 : Number(v.toString());

function displayName(user: {
  phoneNumber: string;
  profile?: { firstName: string | null; lastName: string | null } | null;
}): string {
  const name = [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(' ');
  return name || user.phoneNumber;
}

export interface MonetizationPageQuery {
  page: number;
  limit: number;
}

export class AdminDriverMonetizationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly commissionWalletService: CommissionWalletService,
  ) {}

  async listCommissionWallets(query: MonetizationPageQuery & { search?: string | undefined }) {
    const client = this.databaseService.client;
    const where: Prisma.DriverCommissionWalletWhereInput = query.search
      ? {
          driver: {
            OR: [
              { driverCode: { contains: query.search, mode: 'insensitive' } },
              { user: { phoneNumber: { contains: query.search } } },
              { user: { profile: { firstName: { contains: query.search, mode: 'insensitive' } } } },
              { user: { profile: { lastName: { contains: query.search, mode: 'insensitive' } } } },
            ],
          },
        }
      : {};
    const [totalCount, wallets] = await Promise.all([
      client.driverCommissionWallet.count({ where }),
      client.driverCommissionWallet.findMany({
        where,
        orderBy: [{ lastTransactionAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          driver: {
            select: {
              id: true,
              driverCode: true,
              paymentModel: true,
              pendingPaymentModel: true,
              user: {
                select: {
                  phoneNumber: true,
                  profile: { select: { firstName: true, lastName: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    // One aggregate for the page, not one per driver.
    const sums = wallets.length
      ? await client.driverCommissionWalletTransaction.groupBy({
          by: ['driverId', 'txnType'],
          where: { driverId: { in: wallets.map((w) => w.driverId) } },
          _sum: { amount: true },
        })
      : [];
    const sumOf = (driverId: string, types: string[]) =>
      sums
        .filter((row) => row.driverId === driverId && types.includes(row.txnType))
        .reduce((acc, row) => acc + toNum(row._sum.amount), 0);

    return {
      data: wallets.map((w) => {
        const balance = toNum(w.balance);
        return {
          driverId: w.driverId,
          driverCode: w.driver.driverCode,
          driverName: displayName(w.driver.user),
          paymentModel: w.driver.paymentModel,
          pendingPaymentModel: w.driver.pendingPaymentModel,
          balance,
          currency: w.currency,
          lastTransactionAt: w.lastTransactionAt?.toISOString() ?? null,
          totals: {
            recharged: sumOf(w.driverId, ['MANUAL_RECHARGE']),
            // Stored as positive amounts on RIDE_COMMISSION rows; reported as a positive total.
            commissionDeducted: Math.abs(sumOf(w.driverId, ['RIDE_COMMISSION'])),
            refunded: Math.abs(sumOf(w.driverId, ['REFUND', 'REFUND_REVERSAL'])),
            adminCredited: sumOf(w.driverId, ['ADMIN_CREDIT']),
          },
          // The only approved eligibility rule is per ride (balance ≥ that ride's commission).
          // A zero balance covers no ride that carries a commission; no fixed threshold exists.
          canCoverCommission: balance > 0,
        };
      }),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async listCommissionWalletTransactions(driverId: string, limit: number) {
    const rows = await this.commissionWalletService.listTransactions(driverId, limit);
    return rows.map((t) => ({
      id: t.id,
      txnType: t.txnType,
      amount: toNum(t.amount),
      balanceAfter: toNum(t.balanceAfter),
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      description: t.description,
      rideId: t.rideId,
      ride: t.ride ?? null,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  async listSubscriptionPlans() {
    const client = this.databaseService.client;
    const [plans, active] = await Promise.all([
      client.subscriptionPlan.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] }),
      client.driverSubscription.groupBy({
        by: ['planId'],
        where: { status: 'ACTIVE' },
        _count: { _all: true },
      }),
    ]);
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      billingPeriod: p.billingPeriod,
      price: toNum(p.price),
      currency: p.currency,
      status: p.status,
      activeSubscribers: active.find((a) => a.planId === p.id)?._count._all ?? 0,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
  }

  async listDriverSubscriptions(query: MonetizationPageQuery & { status?: string | undefined }) {
    const client = this.databaseService.client;
    const where: Prisma.DriverSubscriptionWhereInput = query.status ? { status: query.status } : {};
    const [totalCount, rows] = await Promise.all([
      client.driverSubscription.count({ where }),
      client.driverSubscription.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          plan: true,
          driver: {
            select: {
              driverCode: true,
              user: {
                select: {
                  phoneNumber: true,
                  profile: { select: { firstName: true, lastName: true } },
                },
              },
            },
          },
        },
      }),
    ]);
    const intentIds = rows.map((r) => r.paymentIntentId).filter((id): id is string => Boolean(id));
    const pendingPlanIds = rows
      .map((r) => r.pendingPlanId)
      .filter((id): id is string => Boolean(id));
    const [intents, pendingPlans] = await Promise.all([
      intentIds.length
        ? client.paymentIntent.findMany({
            where: { id: { in: intentIds } },
            select: { id: true, amount: true },
          })
        : [],
      pendingPlanIds.length
        ? client.subscriptionPlan.findMany({
            where: { id: { in: pendingPlanIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    return {
      data: rows.map((r) => {
        const intent = intents.find((i) => i.id === r.paymentIntentId);
        return {
          id: r.id,
          driverId: r.driverId,
          driverCode: r.driver.driverCode,
          driverName: displayName(r.driver.user),
          planId: r.planId,
          planName: r.plan.name,
          billingPeriod: r.plan.billingPeriod,
          paidAmount: intent ? toNum(intent.amount) : null,
          currentPlanPrice: toNum(r.plan.price),
          currency: r.plan.currency,
          status: r.status,
          paymentStatus: r.paymentStatus,
          startDate: r.startDate?.toISOString() ?? null,
          expiryDate: r.expiryDate?.toISOString() ?? null,
          autoRenew: r.autoRenew,
          cancelRequested: r.cancelRequested,
          pendingPlanName: pendingPlans.find((p) => p.id === r.pendingPlanId)?.name ?? null,
          paymentIntentId: r.paymentIntentId,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }
}
