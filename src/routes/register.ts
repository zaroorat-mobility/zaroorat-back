import { FastifyInstance } from 'fastify';
import { healthRoute } from './health/health.route.js';
import { readyRoute } from './health/ready.route.js';
import { registerAuthRoutes } from '@modules/auth/http';
import { registerUserRoutes } from '@modules/users/http';
import { registerFileRoutes } from '@modules/files/http';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoute, { prefix: '/api/v1' });
  await app.register(healthRoute); // Also register at root for basic load balancers

  await app.register(readyRoute, { prefix: '/api/v1' });
  await app.register(readyRoute); // Kubernetes probes hit the unprefixed path

  // AUTH API (doc 04) — base path /api/v1/auth (platform convention; nginx
  // proxies /api/v1/*).
  await app.register(registerAuthRoutes, { prefix: '/api/v1/auth' });

  // USER API (user doc 02) — base path /api/v1/users. Every route is protected
  // by AUTH's deny-by-default gate; this module declares no public route.
  await app.register(registerUserRoutes, { prefix: '/api/v1/users' });

  // FILES API (files doc 02) — base path /api/v1/files. Every route is
  // protected by AUTH's deny-by-default gate; this module declares no public
  // route, because a private bucket behind a public API is not private.
  await app.register(registerFileRoutes, { prefix: '/api/v1/files' });
}
