import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { FastifyInstance } from 'fastify';

import { config } from '@config';

async function corsPlugin(app: FastifyInstance) {
  await app.register(cors, {
    origin:
      config.app.environment === 'local'
        ? true
        : ['https://zaroorat.com', 'https://admin.zaroorat.com'],
    credentials: true,
  });
}

export default fp(corsPlugin, {
  name: 'cors',
});
