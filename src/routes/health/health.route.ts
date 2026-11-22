import { FastifyInstance } from 'fastify';
import { config } from '@config';
export async function healthRoute(app: FastifyInstance) {
  app.get(
    '/health',
    {
      config: { public: true },
      schema: {
        tags: ['System'],
        summary: 'Health check probe',
        description: 'Returns basic system uptime, environment, and current timestamp.',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ok' },
              uptime: { type: 'number', example: 124.5 },
              environment: { type: 'string', example: 'development' },
              timestamp: { type: 'string', example: '2026-08-05T21:00:00.000Z' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      return reply.send({
        status: 'ok',
        uptime: process.uptime(),
        environment: config.app.environment,
        timestamp: new Date().toISOString(),
      });
    },
  );
}
