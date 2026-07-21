import { FastifyInstance } from 'fastify';

export async function bootstrapRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (request, reply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };
  });
}
