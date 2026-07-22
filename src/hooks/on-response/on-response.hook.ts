import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';

async function onResponseHook(app: FastifyInstance) {
  app.addHook('onResponse', async (request, reply) => {
    const duration = Number(process.hrtime.bigint() - request.startTime) / 1_000_000;

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
