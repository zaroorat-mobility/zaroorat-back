import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { AdminFinanceService } from './finance.service.js';
import {
  approveRefundBodySchema,
  assignDisputeBodySchema,
  closeDisputeBodySchema,
  createDisputeBodySchema,
  createFinanceRefundBodySchema,
  driverBreakdownQuerySchema,
  driverIdParamSchema,
  financeIdParamSchema,
  generateSettlementBodySchema,
  listDisputesQuerySchema,
  listFinanceAuditQuerySchema,
  listFinanceRefundsQuerySchema,
  listFinanceTransactionsQuerySchema,
  listSettlementsQuerySchema,
  markRefundCompletedBodySchema,
  markRefundProcessingBodySchema,
  reconcileTransactionBodySchema,
  rejectRefundBodySchema,
  resolveDisputeBodySchema,
  searchDriversQuerySchema,
  settlementStatusBodySchema,
  startRefundReviewBodySchema,
  updateDisputeStatusBodySchema,
} from './finance.schemas.js';

function actorName(_req: FastifyRequest): string | undefined {
  return undefined;
}

export class AdminFinanceController {
  constructor(private readonly adminFinanceService: AdminFinanceService) {}

  async dashboard(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send({ data: await this.adminFinanceService.getDashboard() });
  }

  async listTransactions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listFinanceTransactionsQuerySchema.parse(req.query);
    reply.send(await this.adminFinanceService.listTransactions(query));
  }

  async getTransaction(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    reply.send({ data: await this.adminFinanceService.getTransaction(id) });
  }

  async reconcileTransaction(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = reconcileTransactionBodySchema.parse(req.body);
    reply.send({
      data: await this.adminFinanceService.reconcileTransaction(
        id,
        body,
        callerId(req),
        actorName(req),
      ),
    });
  }

  async listRefunds(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listFinanceRefundsQuerySchema.parse(req.query);
    reply.send(await this.adminFinanceService.listRefunds(query));
  }

  async getRefund(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    reply.send({ data: await this.adminFinanceService.getRefund(id) });
  }

  async createRefund(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createFinanceRefundBodySchema.parse(req.body);
    reply.status(201).send({
      data: await this.adminFinanceService.createRefund(body, callerId(req), actorName(req)),
    });
  }

  async startRefundReview(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = startRefundReviewBodySchema.parse(req.body ?? {});
    reply.send({
      data: await this.adminFinanceService.startRefundReview(
        id,
        callerId(req),
        body.reviewerName ?? actorName(req),
      ),
    });
  }

  async approveRefund(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = approveRefundBodySchema.parse(req.body);
    reply.send({
      data: await this.adminFinanceService.approveRefund(
        id,
        callerId(req),
        body.approvedAmount,
        body.notes,
        body.reviewerName ?? actorName(req),
      ),
    });
  }

  async rejectRefund(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = rejectRefundBodySchema.parse(req.body);
    reply.send({
      data: await this.adminFinanceService.rejectRefund(
        id,
        callerId(req),
        body.reason,
        body.reviewerName ?? actorName(req),
      ),
    });
  }

  async markRefundProcessing(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = markRefundProcessingBodySchema.parse(req.body ?? {});
    reply.send({
      data: await this.adminFinanceService.markRefundProcessing(
        id,
        callerId(req),
        body.actorName ?? actorName(req),
      ),
    });
  }

  async markRefundCompleted(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = markRefundCompletedBodySchema.parse(req.body ?? {});
    reply.send({
      data: await this.adminFinanceService.markRefundCompleted(
        id,
        callerId(req),
        body.actorName ?? actorName(req),
        body.notes,
      ),
    });
  }

  async listSettlements(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listSettlementsQuerySchema.parse(req.query);
    reply.send(await this.adminFinanceService.listSettlements(query));
  }

  async getSettlement(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    reply.send({ data: await this.adminFinanceService.getSettlement(id) });
  }

  async getSettlementDrivers(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    reply.send({ data: await this.adminFinanceService.getSettlementDrivers(id) });
  }

  async generateSettlement(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = generateSettlementBodySchema.parse(req.body);
    reply.status(201).send({
      data: await this.adminFinanceService.generateSettlement(body, callerId(req), actorName(req)),
    });
  }

  async updateSettlementStatus(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = settlementStatusBodySchema.parse(req.body);
    reply.send({
      data: await this.adminFinanceService.updateSettlementStatus(
        id,
        body,
        callerId(req),
        actorName(req),
      ),
    });
  }

  async searchDrivers(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = searchDriversQuerySchema.parse(req.query);
    reply.send({ data: await this.adminFinanceService.searchDrivers(query.q) });
  }

  async getDriverLedger(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId } = driverIdParamSchema.parse(req.params);
    reply.send({ data: await this.adminFinanceService.getDriverLedger(driverId) });
  }

  async getDriverBreakdown(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId } = driverIdParamSchema.parse(req.params);
    const query = driverBreakdownQuerySchema.parse(req.query);
    reply.send({
      data: await this.adminFinanceService.getDriverBreakdown(
        driverId,
        query.periodStart,
        query.periodEnd,
      ),
    });
  }

  async listDisputes(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listDisputesQuerySchema.parse(req.query);
    reply.send(await this.adminFinanceService.listDisputes(query));
  }

  async getDispute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    reply.send({ data: await this.adminFinanceService.getDispute(id) });
  }

  async createDispute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createDisputeBodySchema.parse(req.body);
    reply.status(201).send({
      data: await this.adminFinanceService.createDispute(body, callerId(req), actorName(req)),
    });
  }

  async assignDispute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = assignDisputeBodySchema.parse(req.body);
    reply.send({
      data: await this.adminFinanceService.assignDispute(
        id,
        body.agentName,
        callerId(req),
        actorName(req),
      ),
    });
  }

  async updateDisputeStatus(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = updateDisputeStatusBodySchema.parse(req.body);
    reply.send({
      data: await this.adminFinanceService.updateDisputeStatus(
        id,
        body.status,
        callerId(req),
        body.notes,
        actorName(req),
      ),
    });
  }

  async resolveDispute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = resolveDisputeBodySchema.parse(req.body);
    reply.send({
      data: await this.adminFinanceService.resolveDispute(
        id,
        {
          resolutionType: body.resolutionType,
          ...(body.resolutionNotes !== undefined ? { resolutionNotes: body.resolutionNotes } : {}),
          ...(body.adjustmentAmount !== undefined
            ? { adjustmentAmount: body.adjustmentAmount }
            : {}),
          ...(body.resolvedBy !== undefined ? { resolvedBy: body.resolvedBy } : {}),
        },
        callerId(req),
        actorName(req),
      ),
    });
  }

  async closeDispute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = financeIdParamSchema.parse(req.params);
    const body = closeDisputeBodySchema.parse(req.body ?? {});
    reply.send({
      data: await this.adminFinanceService.closeDispute(
        id,
        callerId(req),
        body.notes,
        actorName(req),
      ),
    });
  }

  async listAuditLogs(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listFinanceAuditQuerySchema.parse(req.query);
    reply.send(await this.adminFinanceService.listAuditLogs(query));
  }
}
