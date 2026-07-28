import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';

async function onResponseHook(app: FastifyInstance) {
  app.addHook('onResponse', async (request, reply) => {
    // `startTime` is set by the on-request hook, but a request rejected earlier in
    // the onRequest phase (e.g. by the deny-by-default auth gate) never reaches it.
    // Fall back to Fastify's own elapsed-time measurement so timing is always safe.
    const duration =
      request.startTime !== undefined
        ? Number(process.hrtime.bigint() - request.startTime) / 1_000_000
        : reply.elapsedTime;

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
