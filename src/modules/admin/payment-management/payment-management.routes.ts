import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { AdminPaymentManagementController } from './payment-management.controller.js';
import { AdminFinanceController } from './finance.controller.js';
import { DocumentComplianceController } from './document-compliance.controller.js';
import { handlePaymentError } from '@modules/payments/schemas/error-response.js';
import { FinanceAdminError } from './finance.errors.js';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';

export async function adminPaymentRoutes(fastify: FastifyInstance): Promise<void> {
  // Error handlers are scoped to the Fastify plugin that registers them. These
  // routes moved here from their domain module and left its handler behind, so
  // coded domain errors were falling through to the global handler and losing
  // their code/status/details. Restored per constitution S13.3.
  fastify.setErrorHandler((err, request, reply) => {
    if (err instanceof FinanceAdminError || isCodedError(err)) {
      const coded = err as { code: string; statusCode: number; message: string; details?: unknown };
      if (coded.statusCode < 500) {
        reply.status(coded.statusCode).send(
          errorEnvelope(coded.code, coded.message, request.id, {
            ...(coded.details !== undefined ? { details: coded.details } : {}),
          }),
        );
        return;
      }
    }
    handlePaymentError(err, request, reply);
  });

  const payoutController = container.resolve<AdminPaymentManagementController>(
    'adminPaymentManagementController',
  );
  const finance = container.resolve<AdminFinanceController>('adminFinanceController');
  const documents = container.resolve<DocumentComplianceController>('documentComplianceController');

  const canFinanceRead = {
    preHandler: [fastify.authorize({ permissions: ['finance:read'] })],
  };
  const canFinanceExecute = {
    preHandler: [
      fastify.authorize({ permissions: ['finance:execute'] }),
      fastify.rateLimit(rateLimits.payment),
    ],
  };
  const canDocsRead = {
    preHandler: [fastify.authorize({ permissions: ['documents:read'] })],
  };
  const canDocsVerify = {
    preHandler: [fastify.authorize({ permissions: ['drivers:verify'] })],
  };

  // Existing payout endpoint (unchanged)
  fastify.post('/payments/payouts', canFinanceExecute, (req, reply) =>
    payoutController.executePayout(req, reply),
  );

  // ─── Finance dashboard / transactions ─────────────────────────────────────
  fastify.get('/finance/dashboard', canFinanceRead, (req, reply) => finance.dashboard(req, reply));
  fastify.get('/finance/transactions', canFinanceRead, (req, reply) =>
    finance.listTransactions(req, reply),
  );
  fastify.get('/finance/transactions/:id', canFinanceRead, (req, reply) =>
    finance.getTransaction(req, reply),
  );
  fastify.post('/finance/transactions/:id/reconcile', canFinanceExecute, (req, reply) =>
    finance.reconcileTransaction(req, reply),
  );

  // ─── Refunds ──────────────────────────────────────────────────────────────
  fastify.get('/finance/refunds', canFinanceRead, (req, reply) => finance.listRefunds(req, reply));
  fastify.get('/finance/refunds/:id', canFinanceRead, (req, reply) =>
    finance.getRefund(req, reply),
  );
  fastify.post('/finance/refunds', canFinanceExecute, (req, reply) =>
    finance.createRefund(req, reply),
  );
  fastify.post('/finance/refunds/:id/start-review', canFinanceExecute, (req, reply) =>
    finance.startRefundReview(req, reply),
  );
  fastify.post('/finance/refunds/:id/approve', canFinanceExecute, (req, reply) =>
    finance.approveRefund(req, reply),
  );
  fastify.post('/finance/refunds/:id/reject', canFinanceExecute, (req, reply) =>
    finance.rejectRefund(req, reply),
  );
  fastify.post('/finance/refunds/:id/mark-processing', canFinanceExecute, (req, reply) =>
    finance.markRefundProcessing(req, reply),
  );
  fastify.post('/finance/refunds/:id/mark-completed', canFinanceExecute, (req, reply) =>
    finance.markRefundCompleted(req, reply),
  );

  // ─── Settlements ──────────────────────────────────────────────────────────
  fastify.get('/finance/settlements', canFinanceRead, (req, reply) =>
    finance.listSettlements(req, reply),
  );
  fastify.get('/finance/settlements/:id', canFinanceRead, (req, reply) =>
    finance.getSettlement(req, reply),
  );
  fastify.get('/finance/settlements/:id/drivers', canFinanceRead, (req, reply) =>
    finance.getSettlementDrivers(req, reply),
  );
  fastify.post('/finance/settlements/generate', canFinanceExecute, (req, reply) =>
    finance.generateSettlement(req, reply),
  );
  fastify.post('/finance/settlements/:id/status', canFinanceExecute, (req, reply) =>
    finance.updateSettlementStatus(req, reply),
  );

  // ─── Driver ledger / search ───────────────────────────────────────────────
  fastify.get('/finance/drivers/search', canFinanceRead, (req, reply) =>
    finance.searchDrivers(req, reply),
  );
  fastify.get('/finance/drivers/:driverId/ledger', canFinanceRead, (req, reply) =>
    finance.getDriverLedger(req, reply),
  );
  fastify.get('/finance/drivers/:driverId/breakdown', canFinanceRead, (req, reply) =>
    finance.getDriverBreakdown(req, reply),
  );

  // ─── Disputes ─────────────────────────────────────────────────────────────
  fastify.get('/finance/disputes', canFinanceRead, (req, reply) =>
    finance.listDisputes(req, reply),
  );
  fastify.get('/finance/disputes/:id', canFinanceRead, (req, reply) =>
    finance.getDispute(req, reply),
  );
  fastify.post('/finance/disputes', canFinanceExecute, (req, reply) =>
    finance.createDispute(req, reply),
  );
  fastify.post('/finance/disputes/:id/assign', canFinanceExecute, (req, reply) =>
    finance.assignDispute(req, reply),
  );
  fastify.post('/finance/disputes/:id/status', canFinanceExecute, (req, reply) =>
    finance.updateDisputeStatus(req, reply),
  );
  fastify.post('/finance/disputes/:id/resolve', canFinanceExecute, (req, reply) =>
    finance.resolveDispute(req, reply),
  );
  fastify.post('/finance/disputes/:id/close', canFinanceExecute, (req, reply) =>
    finance.closeDispute(req, reply),
  );

  // ─── Finance audit ────────────────────────────────────────────────────────
  fastify.get('/finance/audit-logs', canFinanceRead, (req, reply) =>
    finance.listAuditLogs(req, reply),
  );

  // ─── Document compliance ──────────────────────────────────────────────────
  fastify.get('/documents/compliance', canDocsRead, (req, reply) =>
    documents.listCompliance(req, reply),
  );
  fastify.get('/documents/compliance/:driverId', canDocsRead, (req, reply) =>
    documents.getCompliance(req, reply),
  );
  fastify.get('/documents/settings', canDocsRead, (req, reply) =>
    documents.getSettings(req, reply),
  );
  fastify.put('/documents/settings', canDocsVerify, (req, reply) =>
    documents.updateSettings(req, reply),
  );
  fastify.post('/documents/:documentId/review', canDocsVerify, (req, reply) =>
    documents.reviewDocument(req, reply),
  );
}
