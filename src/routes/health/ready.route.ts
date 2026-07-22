import { FastifyInstance } from 'fastify';
import { runReadinessChecks } from '@core/health/index.js';

export async function readyRoute(app: FastifyInstance) {
  app.get('/ready', async (request, reply) => {
    const report = await runReadinessChecks();

    // 503 is what makes the orchestrator pull this pod out of the load-balancer
    // rotation without restarting it. A failing readiness probe must never
    // return 200, or a broken instance keeps taking traffic.
    return reply.status(report.ready ? 200 : 503).send({
      status: report.ready ? 'ready' : 'not_ready',
      checks: report.checks,
      timestamp: new Date().toISOString(),
    });
  });
}
