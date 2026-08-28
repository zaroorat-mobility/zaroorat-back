import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { ReferralController } from '../referral.controller.js';

export async function referralRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<ReferralController>('referralController');

  fastify.get('/rider/me', { preHandler: fastify.authorize() }, (req, reply) =>
    controller.getMe(req, reply),
  );
  fastify.post('/rider/apply', { preHandler: fastify.authorize() }, (req, reply) =>
    controller.apply(req, reply),
  );

  fastify.get(
    '/driver/me',
    { preHandler: fastify.authorize({ requireOperableDriver: false }) },
    (req, reply) => controller.getMe(req, reply),
  );
  fastify.post(
    '/driver/apply',
    { preHandler: fastify.authorize({ requireOperableDriver: false }) },
    (req, reply) => controller.apply(req, reply),
  );
}
