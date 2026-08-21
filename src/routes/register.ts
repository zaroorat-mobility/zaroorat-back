import { FastifyInstance } from 'fastify';
import { healthRoute } from './health/health.route.js';
import { readyRoute } from './health/ready.route.js';
import { metricsRoute } from './health/metrics.route.js';
import { registerAuthRoutes } from '@modules/auth/http';
import { registerUserRoutes } from '@modules/users/routes';
import { registerFileRoutes } from '@modules/files/routes';
import { rideRoutes } from '@modules/rides/routes';
import { driverRoutes } from '@modules/drivers/routes';
import { vehicleRoutes } from '@modules/vehicles/routes';
import { paymentRoutes } from '@modules/payments/routes';
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoute, { prefix: '/api/v1' });
  await app.register(healthRoute);
  await app.register(readyRoute, { prefix: '/api/v1' });
  await app.register(readyRoute);
  await app.register(metricsRoute);
  await app.register(registerAuthRoutes, { prefix: '/api/v1/auth' });
  await app.register(registerUserRoutes, { prefix: '/api/v1/users' });
  await app.register(registerFileRoutes, { prefix: '/api/v1/files' });
  await app.register(rideRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/drivers' });
  await app.register(vehicleRoutes, { prefix: '/api/v1/vehicles' });
  await app.register(paymentRoutes, { prefix: '/api/v1/payments' });
}
