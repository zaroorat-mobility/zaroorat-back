import type { FastifyInstance } from 'fastify';

import { collectProcessMetrics, renderMetrics } from '@core/metrics';

export async function metricsRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/metrics',
    {
      config: { public: true },
      schema: {
        tags: ['System'],
        summary: 'Prometheus metrics',
        description:
          'Counters and gauges in the Prometheus text exposition format. Restrict to the ' +
          'monitoring network at the ingress; this endpoint is unauthenticated by necessity.',
        response: {
          200: {
            type: 'string',
            description: 'Prometheus text exposition format (v0.0.4)',
          },
        },
      },
    },
    async (_request, reply) => {
      collectProcessMetrics();
      return reply
        .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .send(renderMetrics());
    },
  );
}
