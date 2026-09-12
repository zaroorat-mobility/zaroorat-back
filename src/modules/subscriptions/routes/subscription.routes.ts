import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { SubscriptionController } from '../controllers/subscription.controller.js';
import { handleSubscriptionError } from '../schemas/error-response.js';

export async function subscriptionRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<SubscriptionController>('subscriptionController');
  fastify.setErrorHandler(handleSubscriptionError);

  const canFinanceExecute = {
    preHandler: [fastify.authorize({ permissions: ['finance:execute'] })],
  };

  fastify.get('/plans', (req, reply) => controller.listPlans(req, reply));
  fastify.post('/plans', canFinanceExecute, (req, reply) => controller.createPlan(req, reply));
  fastify.post('/', { preHandler: fastify.rateLimit(rateLimits.payment) }, (req, reply) =>
    controller.purchase(req, reply),
  );
  fastify.get('/', (req, reply) => controller.getStatus(req, reply));
  fastify.post('/cancel', (req, reply) => controller.cancel(req, reply));
}
