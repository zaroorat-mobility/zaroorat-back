import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import { Prisma } from '../../../generated/prisma/index.js';
import { Decimal } from '@modules/payments/types/index.js';
import { RefundService } from '@modules/payments/services/refund/refund.service.js';
import { SettlementService } from '@modules/payments/services/settlement/settlement.service.js';
import { recordAdminAction } from '../audit/index.js';
import { FinanceConflictError, FinanceNotFoundError } from './finance.errors.js';
import type {
  CreateDisputeBody,
  CreateFinanceRefundBody,
  GenerateSettlementBody,
  ListDisputesQuery,
  ListFinanceAuditQuery,
  ListFinanceRefundsQuery,
  ListFinanceTransactionsQuery,
  ListSettlementsQuery,
  ReconcileTransactionBody,
  SettlementStatusBody,
} from './finance.schemas.js';
import {
  appendTimeline,
  asTimeline,
  actorLabel,
  dec,
  displayName,
  isoDate,
  mapGateway,
  mapPaymentMethod,
  mapSettlementDriverStatus,
  mapTxnStatus,
  mapTxnType,
  mapWalletTxnType,
  pageMeta,
  type TimelineEvent,
} from './finance.mappers.js';

type TxnRow = Prisma.PaymentTransactionGetPayload<{
  include: {
    intent: true;
    ride: {
      include: {
        fare: true;
        driver: { include: { profile: true } };
      };
    };
    user: { include: { profile: true } };
    refunds: true;
  };
}>;

type RefundRow = Prisma.RefundGetPayload<{
  include: {
    user: { include: { profile: true } };
    ride: true;
    transaction: true;
  };
}>;

type BatchRow = Prisma.SettlementBatchGetPayload<{
  include: {
    settlements: {
      include: {
        driver: {
          include: {
            profile: true;
            wallet: true;
            user: { include: { profile: true } };
          };
        };
      };
    };
  };
}>;

export class AdminFinanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly refundService: RefundService,
    private readonly settlementService: SettlementService,
  ) {}

  private get client() {
    return this.db.client;
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────

  async getDashboard() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(todayStart.getTime() - 7 * 86400000);
    const monthAgo = new Date(todayStart.getTime() - 30 * 86400000);

    const [
      allTxns,
      refundPending,
      openDisputes,
      openDisputeAgg,
      pendingSettlements,
      refundOutstanding,
    ] = await Promise.all([
      this.client.paymentTransaction.findMany({
        include: { refunds: { where: { status: { in: ['PENDING', 'SUCCEEDED'] } } } },
      }),
      this.client.refund.count({
        where: { workflowStatus: { in: ['requested', 'under_review'] } },
      }),
      this.client.paymentDispute.count({
        where: { status: { in: ['open', 'assigned', 'investigating', 'pending_approval'] } },
      }),
      this.client.paymentDispute.aggregate({
        where: { status: { in: ['open', 'assigned', 'investigating', 'pending_approval'] } },
        _sum: { amount: true },
      }),
      this.client.driverSettlement.aggregate({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
        _sum: { netPayable: true },
      }),
      this.client.refund.aggregate({
        where: {
          workflowStatus: { in: ['requested', 'under_review', 'approved', 'processing'] },
        },
        _sum: { amount: true },
      }),
    ]);

    const mapped = allTxns.map((t) => {
      const refunded = t.refunds.reduce((s, r) => s + dec(r.amount), 0);
      const amount = dec(t.amount);
      const status = mapTxnStatus(t.status, refunded, amount);
      const captured =
        status === 'failed' || status === 'processing' || status === 'initiated' ? 0 : amount;
      const variance = amount - captured;
      return {
        status,
        amount,
        amountCharged: amount,
        refundAmount: refunded,
        variance,
        varianceStatus: t.varianceStatus ?? (variance !== 0 ? 'variance_found' : 'matched'),
        gateway: mapGateway(t.gateway),
        createdAt: t.createdAt,
      };
    });

    const capturedTxns = mapped.filter((t) => t.status === 'captured');
    const gtv = capturedTxns.reduce((s, t) => s + t.amount, 0);
    const netRevenue = capturedTxns.reduce((s, t) => s + (t.amountCharged - t.refundAmount), 0);

    const sumCapturedSince = (since: Date) =>
      mapped
        .filter((t) => t.status === 'captured' && t.createdAt >= since)
        .reduce((s, t) => s + t.amount, 0);

    const totalAttempts = mapped.length || 1;
    const successCount = mapped.filter((t) => t.status === 'captured').length;
    const refundedCount = mapped.filter(
      (t) => t.status === 'fully_refunded' || t.status === 'partially_refunded',
    ).length;

    const gateways = ['razorpay', 'phonepe', 'cashfree', 'paytm'] as const;
    const gatewayPerformance = gateways.map((pg) => {
      const pgTxns = mapped.filter((t) => t.gateway === pg);
      const totalPg = pgTxns.length;
      const successPg = pgTxns.filter((t) => t.status === 'captured').length;
      const failedPg = pgTxns.filter((t) => t.status === 'failed').length;
      return {
        gateway: pg.toUpperCase(),
        successRate: totalPg > 0 ? Math.round((successPg / totalPg) * 1000) / 10 : 100,
        failedCount: failedPg,
        avgResponseTime:
          pg === 'razorpay' ? 1.2 : pg === 'phonepe' ? 1.5 : pg === 'cashfree' ? 2.1 : 1.8,
      };
    });

    const settlementTotal = await this.client.driverSettlement.count();
    const settlementPaid = await this.client.driverSettlement.count({
      where: { status: { in: ['PAID', 'COMPLETED'] } },
    });

    return {
      revenue: {
        gtv,
        netRevenue,
        todayCollection: sumCapturedSince(todayStart),
        weeklyCollection: sumCapturedSince(weekAgo),
        monthlyCollection: sumCapturedSince(monthAgo),
        outstandingRefunds: dec(refundOutstanding._sum.amount),
        outstandingSettlements: dec(pendingSettlements._sum.netPayable),
        openDisputesValue: dec(openDisputeAgg._sum.amount),
      },
      actions: {
        failedTransactions: mapped.filter((t) => t.status === 'failed').length,
        openDisputes,
        refundsPendingReview: refundPending,
        settlementVariances: mapped.filter((t) => t.variance > 0).length,
        unreconciledTransactions: mapped.filter((t) => t.varianceStatus === 'variance_found')
          .length,
        transactionsStuck: mapped.filter((t) => t.status === 'processing').length,
      },
      health: {
        successRate: Math.round((successCount / totalAttempts) * 1000) / 10,
        avgGatewayResponseTime: 1.3,
        refundRatio: Math.round((refundedCount / totalAttempts) * 1000) / 10,
        disputeRatio: Math.round((openDisputes / Math.max(1, allTxns.length)) * 1000) / 10,
        settlementSuccessRate:
          settlementTotal > 0 ? Math.round((settlementPaid / settlementTotal) * 1000) / 10 : 100,
      },
      gateways: gatewayPerformance,
    };
  }

  // ─── Transactions ─────────────────────────────────────────────────────────

  private toTransactionDto(row: TxnRow) {
    const refundAmount = row.refunds
      .filter((r) => ['PENDING', 'SUCCEEDED'].includes(r.status))
      .reduce((s, r) => s + dec(r.amount), 0);
    const amount = dec(row.amount);
    const rideFare = dec(row.ride?.fare?.totalFare) || amount;
    const mapped = mapTxnType(row.txnType);
    const status = mapTxnStatus(row.status, refundAmount, amount);
    const amountCaptured =
      status === 'failed' || status === 'processing' || status === 'initiated' ? 0 : amount;
    const variance = amount - amountCaptured;
    const varianceStatus = row.varianceStatus ?? (variance !== 0 ? 'variance_found' : 'matched');

    return {
      id: row.id,
      transactionId: row.gatewayTxnId ?? row.id,
      rideId: row.rideId ?? undefined,
      riderId: row.userId,
      driverId: row.ride?.driverId ?? undefined,
      entityType: mapped.entityType,
      entityId: row.rideId ?? row.id,
      type: mapped.type,
      source: mapped.source,
      direction: mapped.direction,
      amount,
      currency: 'INR' as const,
      paymentMethod: mapPaymentMethod(row.intent.methodType),
      paymentGateway: mapGateway(row.gateway),
      gatewayReference: row.gatewayTxnId ?? undefined,
      gatewayStatus: row.status,
      gatewayErrorCode: row.errorCode ?? undefined,
      gatewayErrorMessage: row.errorMessage ?? undefined,
      rideFare,
      amountCharged: amount,
      amountCaptured,
      refundAmount,
      settlementImpact: mapped.direction === 'credit' ? amount * 0.93 : 0,
      variance,
      varianceStatus,
      reconciledBy: row.reconciledBy ?? undefined,
      lastReconciledAt: row.lastReconciledAt?.toISOString(),
      status,
      createdAt: row.createdAt.toISOString(),
      completedAt:
        status === 'captured' || status === 'fully_refunded'
          ? row.createdAt.toISOString()
          : undefined,
      updatedAt: row.createdAt.toISOString(),
    };
  }

  private txnInclude = {
    intent: true,
    ride: {
      include: {
        fare: true,
        driver: { include: { profile: true } },
      },
    },
    user: { include: { profile: true } },
    refunds: true,
  } satisfies Prisma.PaymentTransactionInclude;

  async listTransactions(query: ListFinanceTransactionsQuery) {
    const where: Prisma.PaymentTransactionWhereInput = {};
    if (query.search) {
      const s = query.search;
      const or: Prisma.PaymentTransactionWhereInput[] = [
        { gatewayTxnId: { contains: s, mode: 'insensitive' } },
      ];
      if (s.length === 36) {
        or.push({ id: s }, { rideId: s }, { userId: s });
      }
      where.OR = or;
    }
    if (query.paymentGateway && query.paymentGateway !== 'all') {
      where.gateway = { contains: query.paymentGateway, mode: 'insensitive' };
    }
    if (query.varianceStatus && query.varianceStatus !== 'all') {
      where.varianceStatus = query.varianceStatus;
    }

    const [rows, totalCount] = await Promise.all([
      this.client.paymentTransaction.findMany({
        where,
        include: this.txnInclude,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.client.paymentTransaction.count({ where }),
    ]);

    let data = rows.map((r) => this.toTransactionDto(r as TxnRow));
    if (query.status && query.status !== 'all') {
      data = data.filter((t) => t.status === query.status);
    }
    if (query.paymentMethod && query.paymentMethod !== 'all') {
      data = data.filter((t) => t.paymentMethod === query.paymentMethod);
    }
    if (query.type && query.type !== 'all') {
      data = data.filter((t) => t.type === query.type);
    }

    return { data, meta: pageMeta(query.page, query.limit, totalCount) };
  }

  async getTransaction(id: string) {
    const row = await this.client.paymentTransaction.findUnique({
      where: { id },
      include: this.txnInclude,
    });
    if (!row) throw new FinanceNotFoundError('Transaction was not found');
    return this.toTransactionDto(row as TxnRow);
  }

  async reconcileTransaction(
    id: string,
    body: ReconcileTransactionBody,
    actorId: string,
    actorName?: string,
  ) {
    const existing = await this.client.paymentTransaction.findUnique({ where: { id } });
    if (!existing) throw new FinanceNotFoundError('Transaction was not found');

    const updated = await this.client.$transaction(async (tx) => {
      const row = await tx.paymentTransaction.update({
        where: { id },
        data: {
          varianceStatus: body.varianceStatus,
          reconciledBy: actorLabel(actorName, actorId),
          lastReconciledAt: new Date(),
        },
        include: this.txnInclude,
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'payment',
        entityId: id,
        summary: `Reconciled transaction to ${body.varianceStatus}`,
        before: { varianceStatus: existing.varianceStatus },
        after: { varianceStatus: body.varianceStatus, notes: body.notes },
      });
      return row;
    });

    return this.toTransactionDto(updated as TxnRow);
  }

  // ─── Refunds ──────────────────────────────────────────────────────────────

  private toRefundDto(row: RefundRow) {
    const timeline = asTimeline(row.timeline);
    const workflow = row.workflowStatus || 'requested';
    const approved = ['approved', 'processing', 'completed'].includes(workflow)
      ? dec(row.amount)
      : undefined;

    return {
      id: row.id,
      refundId: row.displayCode ?? `REF-${row.id.slice(0, 8).toUpperCase()}`,
      rideId: row.rideId ?? undefined,
      disputeId: row.disputeId ?? undefined,
      riderId: row.userId,
      riderName: row.riderName ?? displayName(row.user.profile, 'Rider'),
      refundType: row.refundType ?? 'SERVICE_ISSUE',
      requestedAmount: dec(row.amount),
      approvedAmount: approved,
      reason: row.reason ?? '',
      status: workflow,
      requestedAt: row.createdAt.toISOString(),
      reviewedBy: row.reviewedBy ?? undefined,
      reviewedAt: row.reviewedAt?.toISOString(),
      processedBy: row.processedBy ?? undefined,
      processedAt: row.completedAt?.toISOString(),
      notes: row.adminNotes ?? undefined,
      approvalLevel: row.approvalLevel ?? (dec(row.amount) > 500 ? 'finance' : 'support'),
      refundSource: row.refundSource ?? 'manual',
      timeline,
      createdAt: row.createdAt.toISOString(),
      updatedAt: (row.reviewedAt ?? row.completedAt ?? row.createdAt).toISOString(),
    };
  }

  private refundInclude = {
    user: { include: { profile: true } },
    ride: true,
    transaction: true,
  } satisfies Prisma.RefundInclude;

  async listRefunds(query: ListFinanceRefundsQuery) {
    const where: Prisma.RefundWhereInput = {};
    if (query.status && query.status !== 'all') {
      where.workflowStatus = query.status;
    }
    if (query.search) {
      const s = query.search;
      where.OR = [
        { displayCode: { contains: s, mode: 'insensitive' } },
        { riderName: { contains: s, mode: 'insensitive' } },
        { refundType: { contains: s, mode: 'insensitive' } },
        ...(s.length === 36 ? [{ id: s }, { rideId: s }, { disputeId: s }, { userId: s }] : []),
      ];
    }

    const [rows, totalCount] = await Promise.all([
      this.client.refund.findMany({
        where,
        include: this.refundInclude,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.client.refund.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.toRefundDto(r as RefundRow)),
      meta: pageMeta(query.page, query.limit, totalCount),
    };
  }

  async getRefund(id: string) {
    const row = await this.client.refund.findUnique({
      where: { id },
      include: this.refundInclude,
    });
    if (!row) throw new FinanceNotFoundError('Refund was not found');
    return this.toRefundDto(row as RefundRow);
  }

  async createRefund(body: CreateFinanceRefundBody, actorId: string, actorName?: string) {
    let txn = body.transactionId
      ? await this.client.paymentTransaction.findUnique({
          where: { id: body.transactionId },
          include: {
            user: { include: { profile: true } },
            ride: true,
          },
        })
      : null;

    if (!txn && body.rideId) {
      txn = await this.client.paymentTransaction.findFirst({
        where: {
          rideId: body.rideId,
          status: { in: ['SUCCEEDED', 'SUCCESS', 'CAPTURED'] },
        },
        include: {
          user: { include: { profile: true } },
          ride: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!txn) throw new FinanceNotFoundError('Payment transaction was not found');

    const userId = body.riderId ?? txn.userId;
    const amount = new Decimal(body.requestedAmount);
    const now = new Date();
    const actor = actorLabel(actorName);
    const year = now.getFullYear();
    const seq = Math.floor(Math.random() * 9000) + 1000;
    const displayCode = `REF-${year}-${seq}`;
    const timeline: TimelineEvent[] = [
      {
        action: 'Refund Requested',
        actor,
        timestamp: now.toISOString(),
        notes: `Reason: ${body.reason.slice(0, 45)}...`,
      },
    ];

    const created = await this.client.$transaction(async (tx) => {
      const row = await tx.refund.create({
        data: {
          transactionId: txn.id,
          rideId: body.rideId ?? txn.rideId,
          userId,
          amount,
          reason: body.reason,
          status: 'PENDING',
          idempotencyKey: `admin-refund-${randomUUID()}`,
          displayCode,
          refundType: body.refundType,
          workflowStatus: 'requested',
          approvalLevel: body.requestedAmount > 500 ? 'finance' : 'support',
          refundSource: body.refundSource,
          disputeId: body.disputeId ?? null,
          adminNotes: body.notes ?? null,
          riderName: body.riderName ?? displayName(txn.user.profile, 'Rider'),
          timeline: timeline as unknown as Prisma.InputJsonValue,
        },
        include: this.refundInclude,
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'refund',
        entityId: row.id,
        summary: `Refund requested ${displayCode} for ₹${body.requestedAmount}`,
        after: { displayCode, amount: body.requestedAmount, refundType: body.refundType },
      });
      return row;
    });

    return this.toRefundDto(created as RefundRow);
  }

  private async updateRefundWorkflow(
    id: string,
    actorId: string,
    mutator: (
      row: RefundRow,
      now: Date,
      actor: string,
    ) => {
      data: Prisma.RefundUpdateInput;
      summary: string;
      event: TimelineEvent;
    },
    actorName?: string,
  ) {
    const existing = await this.client.refund.findUnique({
      where: { id },
      include: this.refundInclude,
    });
    if (!existing) throw new FinanceNotFoundError('Refund was not found');

    const now = new Date();
    const actor = actorLabel(actorName);
    const { data, summary, event } = mutator(existing as RefundRow, now, actor);

    const updated = await this.client.$transaction(async (tx) => {
      const row = await tx.refund.update({
        where: { id },
        data: {
          ...data,
          timeline: appendTimeline(existing.timeline, event),
        },
        include: this.refundInclude,
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'refund',
        entityId: id,
        summary,
        before: { workflowStatus: existing.workflowStatus },
        after: { workflowStatus: row.workflowStatus },
      });
      return row;
    });

    return this.toRefundDto(updated as RefundRow);
  }

  async startRefundReview(id: string, actorId: string, reviewerName?: string) {
    return this.updateRefundWorkflow(
      id,
      actorId,
      (row, now, actor) => {
        if (!['requested', 'under_review'].includes(row.workflowStatus)) {
          throw new FinanceConflictError(`Cannot start review from status ${row.workflowStatus}`);
        }
        return {
          data: { workflowStatus: 'under_review' },
          summary: `Started review for refund ${row.displayCode ?? row.id}`,
          event: {
            action: 'Review Started',
            actor: reviewerName?.trim() || actor,
            timestamp: now.toISOString(),
            notes: `Assigned review agent: ${reviewerName?.trim() || actor}`,
          },
        };
      },
      reviewerName,
    );
  }

  async approveRefund(
    id: string,
    actorId: string,
    approvedAmount: number,
    notes?: string,
    reviewerName?: string,
  ) {
    return this.updateRefundWorkflow(
      id,
      actorId,
      (row, now, actor) => {
        if (!['requested', 'under_review', 'approved'].includes(row.workflowStatus)) {
          throw new FinanceConflictError(`Cannot approve from status ${row.workflowStatus}`);
        }
        const name = reviewerName?.trim() || actor;
        return {
          data: {
            workflowStatus: 'approved',
            amount: new Decimal(approvedAmount),
            reviewedBy: name,
            reviewedAt: now,
            adminNotes: notes ?? row.adminNotes,
          },
          summary: `Approved refund ${row.displayCode ?? row.id} for ₹${approvedAmount}`,
          event: {
            action: 'Refund Approved',
            actor: name,
            timestamp: now.toISOString(),
            notes: `Approved amount: ₹${approvedAmount}. Notes: ${notes ?? ''}`,
          },
        };
      },
      reviewerName,
    );
  }

  async rejectRefund(id: string, actorId: string, reason: string, reviewerName?: string) {
    return this.updateRefundWorkflow(
      id,
      actorId,
      (row, now, actor) => {
        if (['completed', 'rejected'].includes(row.workflowStatus)) {
          throw new FinanceConflictError(`Cannot reject from status ${row.workflowStatus}`);
        }
        const name = reviewerName?.trim() || actor;
        return {
          data: {
            workflowStatus: 'rejected',
            reviewedBy: name,
            reviewedAt: now,
            adminNotes: reason,
            status: 'FAILED',
          },
          summary: `Rejected refund ${row.displayCode ?? row.id}`,
          event: {
            action: 'Refund Rejected',
            actor: name,
            timestamp: now.toISOString(),
            notes: reason,
          },
        };
      },
      reviewerName,
    );
  }

  async markRefundProcessing(id: string, actorId: string, actorName?: string) {
    await this.updateRefundWorkflow(
      id,
      actorId,
      (row, now, actor) => {
        if (!['approved', 'processing'].includes(row.workflowStatus)) {
          throw new FinanceConflictError(
            `Cannot mark processing from status ${row.workflowStatus}`,
          );
        }
        return {
          data: {
            workflowStatus: 'processing',
            processedBy: actorName?.trim() || actor,
          },
          summary: `Refund ${row.displayCode ?? row.id} marked processing`,
          event: {
            action: 'Refund Processing',
            actor: actorName?.trim() || actor,
            timestamp: now.toISOString(),
          },
        };
      },
      actorName,
    );

    const row = await this.client.refund.findUnique({ where: { id } });
    if (row && row.status !== 'SUCCEEDED') {
      await this.refundService.processPendingRefund(id);
    }
    return this.getRefund(id);
  }

  async markRefundCompleted(id: string, actorId: string, actorName?: string, notes?: string) {
    const row = await this.client.refund.findUnique({ where: { id } });
    if (!row) throw new FinanceNotFoundError('Refund was not found');

    if (row.status !== 'SUCCEEDED') {
      if (row.workflowStatus === 'requested' || row.workflowStatus === 'under_review') {
        throw new FinanceConflictError('Refund must be approved before completion');
      }
      await this.refundService.processPendingRefund(id);
    }

    return this.updateRefundWorkflow(
      id,
      actorId,
      (current, now, actor) => {
        const name = actorName?.trim() || actor;
        return {
          data: {
            workflowStatus: 'completed',
            processedBy: name,
            completedAt: current.completedAt ?? now,
            adminNotes: notes ?? current.adminNotes,
          },
          summary: `Completed refund ${current.displayCode ?? current.id}`,
          event: {
            action: 'Refund Completed',
            actor: name,
            timestamp: now.toISOString(),
            ...(notes ? { notes } : {}),
          },
        };
      },
      actorName,
    );
  }

  // ─── Settlements ──────────────────────────────────────────────────────────

  private toDriverSettlementDto(s: BatchRow['settlements'][number]) {
    const name = s.driver.profile?.fullLegalName ?? displayName(s.driver.user?.profile, s.driverId);
    const gross = dec(s.grossEarnings);
    const commission = dec(s.commission);
    const adjustments = dec(s.adjustments);
    const refundAdjustments = adjustments < 0 ? Math.abs(adjustments) : 0;
    const bonuses = adjustments > 0 ? adjustments : 0;
    const commissionPercent = gross > 0 ? Math.round((commission / gross) * 1000) / 10 : 0;

    return {
      driverId: s.driverId,
      driverName: name,
      totalTrips: s.driver.totalRides ?? 0,
      grossEarnings: gross,
      commissionAmount: commission,
      commissionPercent,
      refundAdjustments,
      penalties: 0,
      bonuses,
      incentives: 0,
      netPayable: dec(s.netPayable),
      walletBalance: dec(s.driver.wallet?.balance),
      status: mapSettlementDriverStatus(s.status),
    };
  }

  private toBatchDto(row: BatchRow) {
    return {
      id: row.id,
      batchNumber: row.batchNumber,
      periodStart: isoDate(row.periodStart),
      periodEnd: isoDate(row.periodEnd),
      totalDrivers: row.totalDrivers,
      totalGrossAmount: dec(row.totalGrossAmount),
      totalCommission: dec(row.totalCommission),
      totalRefundAdjustments: dec(row.totalRefundAdjustments),
      totalPenalties: dec(row.totalPenalties),
      totalBonuses: dec(row.totalBonuses),
      totalNetPayable: dec(row.totalNetPayable),
      status: row.status,
      generatedBy: row.generatedBy,
      processedAt: row.processedAt?.toISOString(),
      completedAt: row.completedAt?.toISOString(),
      drivers: row.settlements.map((s) => this.toDriverSettlementDto(s)),
      adjustments: [] as Array<{
        id: string;
        driverId: string;
        driverName: string;
        type: 'deduction' | 'addition';
        reason: string;
        amount: number;
        appliedAt: string;
      }>,
      timeline: asTimeline(row.timeline),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private batchInclude = {
    settlements: {
      include: {
        driver: {
          include: {
            profile: true,
            wallet: true,
            user: { include: { profile: true } },
          },
        },
      },
    },
  } satisfies Prisma.SettlementBatchInclude;

  async listSettlements(query: ListSettlementsQuery) {
    const where: Prisma.SettlementBatchWhereInput = {};
    if (query.status && query.status !== 'all') where.status = query.status;
    if (query.search) {
      const s = query.search;
      where.OR = [
        { batchNumber: { contains: s, mode: 'insensitive' } },
        { status: { contains: s, mode: 'insensitive' } },
        { generatedBy: { contains: s, mode: 'insensitive' } },
      ];
    }

    const [rows, totalCount] = await Promise.all([
      this.client.settlementBatch.findMany({
        where,
        include: this.batchInclude,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.client.settlementBatch.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.toBatchDto(r as BatchRow)),
      meta: pageMeta(query.page, query.limit, totalCount),
    };
  }

  async getSettlement(id: string) {
    const row = await this.client.settlementBatch.findUnique({
      where: { id },
      include: this.batchInclude,
    });
    if (!row) throw new FinanceNotFoundError('Settlement batch was not found');
    return this.toBatchDto(row as BatchRow);
  }

  async getSettlementDrivers(id: string) {
    const batch = await this.getSettlement(id);
    return batch.drivers;
  }

  async generateSettlement(body: GenerateSettlementBody, actorId: string, actorName?: string) {
    if (body.periodEnd < body.periodStart) {
      throw new FinanceConflictError('periodEnd must be on or after periodStart');
    }

    const existing = await this.client.settlementBatch.findFirst({
      where: { periodStart: body.periodStart, periodEnd: body.periodEnd },
      include: this.batchInclude,
    });
    if (existing) return this.toBatchDto(existing as BatchRow);

    await this.settlementService.calculateSettlementsForPeriod(body.periodStart, body.periodEnd);

    const settlements = await this.client.driverSettlement.findMany({
      where: { periodStart: body.periodStart, periodEnd: body.periodEnd },
      include: {
        driver: {
          include: {
            profile: true,
            wallet: true,
            user: { include: { profile: true } },
          },
        },
      },
    });

    const actor = actorLabel(actorName);
    const now = new Date();
    const count = await this.client.settlementBatch.count();
    const batchNumber = `SET-${now.getFullYear()}-${1000 + count + 1}`;

    let totalGross = new Decimal(0);
    let totalCommission = new Decimal(0);
    let totalRefundAdj = new Decimal(0);
    let totalBonuses = new Decimal(0);
    let totalNet = new Decimal(0);

    for (const s of settlements) {
      totalGross = totalGross.add(s.grossEarnings);
      totalCommission = totalCommission.add(s.commission);
      totalNet = totalNet.add(s.netPayable);
      if (s.adjustments.lt(0)) totalRefundAdj = totalRefundAdj.add(s.adjustments.abs());
      if (s.adjustments.gt(0)) totalBonuses = totalBonuses.add(s.adjustments);
    }

    const timeline: TimelineEvent[] = [
      {
        action: 'Settlement Generated',
        actor,
        timestamp: now.toISOString(),
        notes: `Period: ${isoDate(body.periodStart)} → ${isoDate(body.periodEnd)}. ${settlements.length} drivers, ₹${totalNet.toFixed(2)} net payable.`,
      },
    ];

    const batch = await this.client.$transaction(async (tx) => {
      const created = await tx.settlementBatch.create({
        data: {
          batchNumber,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          status: 'draft',
          generatedBy: actor,
          totalDrivers: settlements.length,
          totalGrossAmount: totalGross,
          totalCommission,
          totalRefundAdjustments: totalRefundAdj,
          totalPenalties: 0,
          totalBonuses,
          totalNetPayable: totalNet,
          timeline: timeline as unknown as Prisma.InputJsonValue,
        },
      });

      if (settlements.length > 0) {
        await tx.driverSettlement.updateMany({
          where: { id: { in: settlements.map((s) => s.id) } },
          data: { settlementBatchId: created.id },
        });
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'settlement',
        entityId: created.id,
        summary: `Generated settlement batch ${batchNumber}`,
        after: {
          batchNumber,
          totalDrivers: settlements.length,
          totalNetPayable: totalNet.toNumber(),
        },
      });

      return tx.settlementBatch.findUniqueOrThrow({
        where: { id: created.id },
        include: this.batchInclude,
      });
    });

    return this.toBatchDto(batch as BatchRow);
  }

  async updateSettlementStatus(
    id: string,
    body: SettlementStatusBody,
    actorId: string,
    actorName?: string,
  ) {
    const existing = await this.client.settlementBatch.findUnique({
      where: { id },
      include: this.batchInclude,
    });
    if (!existing) throw new FinanceNotFoundError('Settlement batch was not found');

    const actor = actorLabel(actorName);
    const now = new Date();
    const actionMap: Record<string, string> = {
      pending: 'Settlement Approved for Processing',
      processing: 'Settlement Processing Started',
      completed: 'Settlement Completed',
      failed: 'Settlement Failed',
      draft: 'Settlement Reverted to Draft',
    };

    const updated = await this.client.$transaction(async (tx) => {
      const data: Prisma.SettlementBatchUpdateInput = {
        status: body.status,
        timeline: appendTimeline(existing.timeline, {
          action: actionMap[body.status] ?? `Status changed to ${body.status}`,
          actor,
          timestamp: now.toISOString(),
        }),
      };
      if (body.status === 'processing') data.processedAt = now;
      if (body.status === 'completed') data.completedAt = now;

      const batch = await tx.settlementBatch.update({
        where: { id },
        data,
        include: this.batchInclude,
      });

      const driverStatus =
        body.status === 'completed'
          ? 'PAID'
          : body.status === 'failed'
            ? 'FAILED'
            : body.status === 'processing'
              ? 'PROCESSING'
              : 'PENDING';

      await tx.driverSettlement.updateMany({
        where: { settlementBatchId: id },
        data: { status: driverStatus },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'settlement',
        entityId: id,
        summary: `Settlement batch ${existing.batchNumber} → ${body.status}`,
        before: { status: existing.status },
        after: { status: body.status },
      });

      return tx.settlementBatch.findUniqueOrThrow({
        where: { id: batch.id },
        include: this.batchInclude,
      });
    });

    return this.toBatchDto(updated as BatchRow);
  }

  async searchDrivers(q: string) {
    const drivers = await this.client.driver.findMany({
      where: {
        deletedAt: null,
        OR: [
          { driverCode: { contains: q, mode: 'insensitive' } },
          { profile: { fullLegalName: { contains: q, mode: 'insensitive' } } },
          { user: { phoneNumber: { contains: q } } },
        ],
      },
      take: 20,
      include: {
        profile: true,
        user: { include: { profile: true } },
      },
    });

    return drivers.map((d) => ({
      driverId: d.id,
      driverName: d.profile?.fullLegalName ?? displayName(d.user.profile, d.driverCode),
    }));
  }

  async getDriverLedger(driverId: string) {
    const driver = await this.client.driver.findUnique({
      where: { id: driverId },
      include: { profile: true, user: { include: { profile: true } } },
    });
    if (!driver) throw new FinanceNotFoundError('Driver was not found');

    const name =
      driver.profile?.fullLegalName ?? displayName(driver.user.profile, driver.driverCode);

    const rows = await this.client.driverWalletTransaction.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return rows.map((r) => {
      const amount = dec(r.amount);
      const isDebit = ['PENALTY', 'WITHDRAWAL', 'REFUND'].includes(r.txnType);
      return {
        id: r.id,
        driverId,
        driverName: name,
        type: mapWalletTxnType(r.txnType),
        description: r.description ?? r.txnType,
        amount: isDebit ? -Math.abs(amount) : Math.abs(amount),
        rideId: r.referenceType === 'RIDE' ? (r.referenceId ?? undefined) : undefined,
        settlementBatchId:
          r.referenceType === 'SETTLEMENT' ? (r.referenceId ?? undefined) : undefined,
        balance: dec(r.balanceAfter),
        entryDate: r.createdAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.createdAt.toISOString(),
      };
    });
  }

  async getDriverBreakdown(driverId: string, periodStart: Date, periodEnd: Date) {
    const driver = await this.client.driver.findUnique({
      where: { id: driverId },
      include: {
        profile: true,
        wallet: true,
        user: { include: { profile: true } },
      },
    });
    if (!driver) throw new FinanceNotFoundError('Driver was not found');

    const settlement = await this.client.driverSettlement.findUnique({
      where: {
        driverId_periodStart_periodEnd: { driverId, periodStart, periodEnd },
      },
    });

    const name =
      driver.profile?.fullLegalName ?? displayName(driver.user.profile, driver.driverCode);

    if (settlement) {
      return this.toDriverSettlementDto({
        ...settlement,
        driver: {
          ...driver,
          totalRides: driver.totalRides,
        },
      } as BatchRow['settlements'][number]);
    }

    const trips = await this.client.ride.count({
      where: {
        driverId,
        status: 'COMPLETED',
        completedAt: { gte: periodStart, lte: periodEnd },
      },
    });

    return {
      driverId,
      driverName: name,
      totalTrips: trips,
      grossEarnings: 0,
      commissionAmount: 0,
      commissionPercent: 0,
      refundAdjustments: 0,
      penalties: 0,
      bonuses: 0,
      incentives: 0,
      netPayable: 0,
      walletBalance: dec(driver.wallet?.balance),
      status: 'pending' as const,
    };
  }

  // ─── Disputes ─────────────────────────────────────────────────────────────

  private toDisputeDto(row: Prisma.PaymentDisputeGetPayload<object>) {
    return {
      id: row.id,
      rideId: row.rideId,
      complaintId: row.complaintId ?? undefined,
      type: row.type,
      status: row.status,
      riderId: row.riderUserId,
      riderName: row.riderName,
      driverId: row.driverId,
      driverName: row.driverName,
      amount: dec(row.amount),
      requestedAmount: row.requestedAmount != null ? dec(row.requestedAmount) : undefined,
      reason: row.reason,
      assignedTo: row.assignedTo ?? undefined,
      assignedAt: row.assignedAt?.toISOString(),
      resolvedBy: row.resolvedBy ?? undefined,
      resolvedAt: row.resolvedAt?.toISOString(),
      resolutionType: row.resolutionType ?? undefined,
      resolutionNotes: row.resolutionNotes ?? undefined,
      adjustmentAmount: row.adjustmentAmount != null ? dec(row.adjustmentAmount) : undefined,
      version: row.version,
      timeline: asTimeline(row.timeline),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listDisputes(query: ListDisputesQuery) {
    const where: Prisma.PaymentDisputeWhereInput = {};
    if (query.status && query.status !== 'all') where.status = query.status;
    if (query.type && query.type !== 'all') where.type = query.type;
    if (query.search) {
      const s = query.search;
      where.OR = [
        { riderName: { contains: s, mode: 'insensitive' } },
        { driverName: { contains: s, mode: 'insensitive' } },
        { type: { contains: s, mode: 'insensitive' } },
        ...(s.length === 36 ? [{ id: s }, { rideId: s }] : []),
      ];
    }

    const [rows, totalCount] = await Promise.all([
      this.client.paymentDispute.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.client.paymentDispute.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.toDisputeDto(r)),
      meta: pageMeta(query.page, query.limit, totalCount),
    };
  }

  async getDispute(id: string) {
    const row = await this.client.paymentDispute.findUnique({ where: { id } });
    if (!row) throw new FinanceNotFoundError('Dispute was not found');
    return this.toDisputeDto(row);
  }

  async createDispute(body: CreateDisputeBody, actorId: string, actorName?: string) {
    const ride = await this.client.ride.findUnique({
      where: { id: body.rideId },
      include: {
        customer: { include: { profile: true } },
        driver: {
          include: {
            profile: true,
            user: { include: { profile: true } },
          },
        },
      },
    });
    if (!ride) throw new FinanceNotFoundError('Ride was not found');

    const now = new Date();
    const actor = actorLabel(actorName);
    const riderName = body.riderName ?? displayName(ride.customer.profile, 'Rider');
    const driverName =
      body.driverName ??
      ride.driver.profile?.fullLegalName ??
      displayName(ride.driver.user.profile, 'Driver');

    const timeline: TimelineEvent[] = [
      {
        action: 'Dispute Created',
        actor,
        timestamp: now.toISOString(),
        notes: `Reason: ${body.reason.slice(0, 45)}...`,
      },
    ];

    const created = await this.client.$transaction(async (tx) => {
      const row = await tx.paymentDispute.create({
        data: {
          rideId: body.rideId,
          complaintId: body.complaintId ?? null,
          type: body.type,
          status: 'open',
          riderUserId: body.riderId ?? ride.customerId,
          riderName,
          driverId: body.driverId ?? ride.driverId,
          driverName,
          amount: new Decimal(body.amount),
          requestedAmount: body.requestedAmount != null ? new Decimal(body.requestedAmount) : null,
          reason: body.reason,
          timeline: timeline as unknown as Prisma.InputJsonValue,
        },
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'dispute',
        entityId: row.id,
        summary: `Dispute created for ride ${body.rideId}`,
        after: { type: body.type, amount: body.amount },
      });
      return row;
    });

    return this.toDisputeDto(created);
  }

  async assignDispute(id: string, agentName: string, actorId: string, actorName?: string) {
    const existing = await this.client.paymentDispute.findUnique({ where: { id } });
    if (!existing) throw new FinanceNotFoundError('Dispute was not found');

    const now = new Date();
    const updated = await this.client.$transaction(async (tx) => {
      const row = await tx.paymentDispute.update({
        where: { id },
        data: {
          status: 'assigned',
          assignedTo: agentName,
          assignedAt: now,
          timeline: appendTimeline(existing.timeline, {
            action: 'Dispute Assigned',
            actor: actorLabel(actorName),
            timestamp: now.toISOString(),
            notes: `Assigned to ${agentName}`,
          }),
        },
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'dispute',
        entityId: id,
        summary: `Dispute assigned to ${agentName}`,
      });
      return row;
    });
    return this.toDisputeDto(updated);
  }

  async updateDisputeStatus(
    id: string,
    status: string,
    actorId: string,
    notes?: string,
    actorName?: string,
  ) {
    const existing = await this.client.paymentDispute.findUnique({ where: { id } });
    if (!existing) throw new FinanceNotFoundError('Dispute was not found');

    const now = new Date();
    const updated = await this.client.$transaction(async (tx) => {
      const row = await tx.paymentDispute.update({
        where: { id },
        data: {
          status,
          timeline: appendTimeline(existing.timeline, {
            action: `Status → ${status}`,
            actor: actorLabel(actorName),
            timestamp: now.toISOString(),
            ...(notes ? { notes } : {}),
          }),
        },
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'dispute',
        entityId: id,
        summary: `Dispute status ${existing.status} → ${status}`,
        before: { status: existing.status },
        after: { status },
      });
      return row;
    });
    return this.toDisputeDto(updated);
  }

  async resolveDispute(
    id: string,
    input: {
      resolutionType: string;
      resolutionNotes?: string;
      adjustmentAmount?: number;
      resolvedBy?: string;
    },
    actorId: string,
    actorName?: string,
  ) {
    const existing = await this.client.paymentDispute.findUnique({ where: { id } });
    if (!existing) throw new FinanceNotFoundError('Dispute was not found');

    const now = new Date();
    const resolver = input.resolvedBy?.trim() || actorLabel(actorName);
    const updated = await this.client.$transaction(async (tx) => {
      const row = await tx.paymentDispute.update({
        where: { id },
        data: {
          status: 'resolved',
          resolvedBy: resolver,
          resolvedAt: now,
          resolutionType: input.resolutionType,
          resolutionNotes: input.resolutionNotes ?? null,
          adjustmentAmount:
            input.adjustmentAmount != null ? new Decimal(input.adjustmentAmount) : null,
          timeline: appendTimeline(existing.timeline, {
            action: 'Dispute Resolved',
            actor: resolver,
            timestamp: now.toISOString(),
            notes: input.resolutionNotes ?? input.resolutionType,
          }),
        },
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'dispute',
        entityId: id,
        summary: `Dispute resolved: ${input.resolutionType}`,
      });
      return row;
    });
    return this.toDisputeDto(updated);
  }

  async closeDispute(id: string, actorId: string, notes?: string, actorName?: string) {
    return this.updateDisputeStatus(id, 'closed', actorId, notes, actorName);
  }

  // ─── Audit ────────────────────────────────────────────────────────────────

  async listAuditLogs(query: ListFinanceAuditQuery) {
    const financeEntities = ['payment', 'refund', 'settlement', 'dispute'];
    const where: Prisma.AdminActivityLogWhereInput = {
      OR: [
        { entityType: { in: financeEntities } },
        { summary: { contains: 'refund', mode: 'insensitive' } },
        { summary: { contains: 'settlement', mode: 'insensitive' } },
        { summary: { contains: 'dispute', mode: 'insensitive' } },
        { summary: { contains: 'finance', mode: 'insensitive' } },
        { summary: { contains: 'transaction', mode: 'insensitive' } },
      ],
    };

    if (query.search) {
      const s = query.search;
      const searchOr: Prisma.AdminActivityLogWhereInput[] = [
        { summary: { contains: s, mode: 'insensitive' } },
        { actor: { profile: { firstName: { contains: s, mode: 'insensitive' } } } },
      ];
      if (s.length === 36) {
        searchOr.push({ entityId: s });
      }
      where.AND = [{ OR: searchOr }];
    }

    const [rows, totalCount] = await Promise.all([
      this.client.adminActivityLog.findMany({
        where,
        include: { actor: { include: { profile: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.client.adminActivityLog.count({ where }),
    ]);

    const moduleFromEntity = (
      entityType?: string | null,
    ): 'transactions' | 'disputes' | 'refunds' | 'settlements' | 'dashboard' => {
      if (entityType === 'refund') return 'refunds';
      if (entityType === 'dispute') return 'disputes';
      if (entityType === 'settlement') return 'settlements';
      if (entityType === 'payment') return 'transactions';
      return 'dashboard';
    };

    const entityTypeMap = (
      entityType?: string | null,
    ): 'ride' | 'refund' | 'dispute' | 'settlement' | 'adjustment' => {
      if (entityType === 'refund') return 'refund';
      if (entityType === 'dispute') return 'dispute';
      if (entityType === 'settlement') return 'settlement';
      return 'ride';
    };

    let data = rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const module = moduleFromEntity(r.entityType);
      const severity =
        r.action === 'REJECT' || (r.summary ?? '').toLowerCase().includes('fail')
          ? 'critical'
          : r.action === 'APPROVE'
            ? 'warning'
            : 'info';

      return {
        id: r.id,
        correlationId: `CORR-FIN-${r.id.slice(0, 8).toUpperCase()}`,
        user: displayName(r.actor?.profile, r.actorId ?? 'System'),
        ipAddress: r.ipAddress ?? '0.0.0.0',
        action: r.summary ?? r.action,
        module,
        entityType: entityTypeMap(r.entityType),
        entityId: r.entityId ?? r.id,
        oldValue: meta.before ? JSON.stringify(meta.before) : undefined,
        newValue: meta.after ? JSON.stringify(meta.after) : undefined,
        severity: severity as 'info' | 'warning' | 'critical',
        notes: r.summary ?? undefined,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.createdAt.toISOString(),
      };
    });

    if (query.module && query.module !== 'all') {
      data = data.filter((d) => d.module === query.module);
    }
    if (query.severity && query.severity !== 'all') {
      data = data.filter((d) => d.severity === query.severity);
    }

    return { data, meta: pageMeta(query.page, query.limit, totalCount) };
  }
}
