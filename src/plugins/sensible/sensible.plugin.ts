import fp from 'fastify-plugin';
import sensible from '@fastify/sensible';
import { FastifyInstance } from 'fastify';

async function sensiblePlugin(app: FastifyInstance) {
  await app.register(sensible);
}

export default fp(sensiblePlugin, {
  name: 'sensible',
});
