import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { container } from '@core/di';
import { errorEnvelope } from '@core/errors/envelope.js';
import { errorHandler } from '@core/errors/error-handler.js';
import { AdminDashboardController } from './dashboard.controller.js';

export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  // Invalid query parameters are a 400; everything else keeps the global handling (incl. 503).
  fastify.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send(
        errorEnvelope('VALIDATION', 'Request validation failed', request.id, {
          details: err.issues,
        }),
      );
    }
    return errorHandler(err as FastifyError, request, reply);
  });

  const controller = container.resolve<AdminDashboardController>('adminDashboardController');
  const authorizeOps = fastify.authorize({ permissions: ['operations:read'] });
  const authorizeFinance = fastify.authorize({ permissions: ['finance:read'] });
  const canReadOps = { preHandler: authorizeOps };
  const canReadFinance = { preHandler: authorizeFinance };
  // Legacy /stats mixes operational counts with a revenue trend, so it needs both.
  const canReadOpsAndFinance = { preHandler: [authorizeOps, authorizeFinance] };

  fastify.get('/overview', canReadOps, (req, reply) => controller.getOverview(req, reply));
  fastify.get('/financials', canReadFinance, (req, reply) => controller.getFinancials(req, reply));
  fastify.get('/financial-analytics', canReadFinance, (req, reply) =>
    controller.getFinancialAnalytics(req, reply),
  );
  fastify.get('/stats', canReadOpsAndFinance, (req, reply) => controller.getStats(req, reply));
  fastify.get('/analytics', canReadOps, (req, reply) => controller.getAnalytics(req, reply));
  fastify.get('/live-drivers', canReadOps, (req, reply) => controller.getLiveDrivers(req, reply));
  fastify.get('/activity', canReadOps, (req, reply) => controller.getActivity(req, reply));
  fastify.get('/health', canReadOps, (req, reply) => controller.getHealth(req, reply));
}
