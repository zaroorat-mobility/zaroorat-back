import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { FastifyInstance } from 'fastify';
import { config } from '@config';
import { isLocal } from '@config/env/environment.js';
function resolveAllowedOrigins() {
  if (isLocal(config.app.environment)) {
    return true;
  }
  const raw = process.env.CORS_ALLOWED_ORIGINS?.trim() || process.env.REALTIME_CORS_ORIGINS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
  return ['https://zaroorat.com', 'https://admin.zaroorat.com'];
}

async function corsPlugin(app: FastifyInstance) {
  await app.register(cors, {
    origin: resolveAllowedOrigins(),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
}
export default fp(corsPlugin, {
  name: 'cors',
});
