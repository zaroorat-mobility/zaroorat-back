import { FastifyInstance } from 'fastify';
import { config } from '@config';

export async function healthRoute(app: FastifyInstance) {
  // Public: load balancers and liveness probes hit this without credentials.
  app.get('/health', { config: { public: true } }, async (request, reply) => {
    return reply.send({
      status: 'ok',
      uptime: process.uptime(),
      environment: config.app.environment,
      timestamp: new Date().toISOString(),
    });
  });
}
