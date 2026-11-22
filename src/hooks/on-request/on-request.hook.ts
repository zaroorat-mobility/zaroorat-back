import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
async function onRequestHook(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        requestId: request.id,
      },
      'Incoming request',
    );
    request.startTime = process.hrtime.bigint();
  });
}
export default fp(onRequestHook, {
  name: 'on-request-hook',
});
