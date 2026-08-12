import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';

async function preHandlerHook(app: FastifyInstance) {
  app.addHook('preHandler', async (_request, _reply) => {});
}

export default fp(preHandlerHook, {
  name: 'pre-handler-hook',
});
