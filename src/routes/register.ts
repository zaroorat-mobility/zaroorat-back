import { FastifyInstance } from 'fastify';
import { healthRoute } from './health/health.route.js';
import { readyRoute } from './health/ready.route.js';
import { metricsRoute } from './health/metrics.route.js';
import { registerAuthRoutes } from '@modules/auth/http';
import { registerUserRoutes } from '@modules/users/routes';
import { registerFileRoutes } from '@modules/files/routes';
import { rideRoutes } from '@modules/rides/routes';
import { driverRoutes } from '@modules/drivers/routes';
import { vehicleRoutes, vehicleTypeRoutes } from '@modules/vehicles/routes';
import { paymentRoutes } from '@modules/payments/routes';
import { adminRoutes } from '@modules/admin';

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
  await app.register(vehicleTypeRoutes, { prefix: '/api/v1/vehicle-types' });
  await app.register(paymentRoutes, { prefix: '/api/v1/payments' });
  // Admin routes declare domain-scoped bare paths (`/drivers/:id/verify`,
  // `/payments/payouts`, `/surge-zones`). Mounted at `/api/v1` those would
  // collide with the real drivers/vehicles/payments modules above and expose
  // staff-only actions on the public domain prefixes. The `/admin` segment is
  // what keeps them distinct — and is the path every admin test asserts.
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
}
