import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { incrementCounter } from '@core/metrics';
async function onResponseHook(app: FastifyInstance) {
  app.addHook('onResponse', async (request, reply) => {
    const duration =
      request.startTime !== undefined
        ? Number(process.hrtime.bigint() - request.startTime) / 1000000
        : reply.elapsedTime;
    incrementCounter('http_requests_total', {
      method: request.method,
      route: request.routeOptions?.url ?? 'unmatched',
      code: String(reply.statusCode),
    });
    request.log.info(
      {
        statusCode: reply.statusCode,
        duration,
      },
      'Request completed',
    );
  });
}
export default fp(onResponseHook, {
  name: 'on-response-hook',
});
