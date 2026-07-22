import { FastifyInstance } from 'fastify';
import { config } from '@config';

export async function healthRoute(app: FastifyInstance) {
  app.get('/health', async (request, reply) => {
    return reply.send({
      status: 'ok',
      uptime: process.uptime(),
      environment: config.app.environment,
      timestamp: new Date().toISOString(),
    });
  });
}
