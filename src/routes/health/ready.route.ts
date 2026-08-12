import { FastifyInstance } from 'fastify';
import { runReadinessChecks } from '@core/health/index.js';

const CHECKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', example: 'database' },
      ok: { type: 'boolean', example: true },
      error: { type: 'string' },
    },
  },
} as const;

export async function readyRoute(app: FastifyInstance) {
  app.get(
    '/ready',
    {
      config: { public: true },
      schema: {
        tags: ['System'],
        summary: 'Readiness check probe',
        description:
          'Verifies connectivity to primary infrastructure components (PostgreSQL DB, Redis).',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ready' },
              checks: CHECKS_SCHEMA,
              timestamp: { type: 'string', example: '2026-08-05T21:00:00.000Z' },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'not_ready' },
              checks: CHECKS_SCHEMA,
              timestamp: { type: 'string', example: '2026-08-05T21:00:00.000Z' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const report = await runReadinessChecks();

      return reply.status(report.ready ? 200 : 503).send({
        status: report.ready ? 'ready' : 'not_ready',
        checks: report.checks,
        timestamp: new Date().toISOString(),
      });
    },
  );
}
