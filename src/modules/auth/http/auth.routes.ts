import type { FastifyInstance } from 'fastify';

import { container } from '@core/di';
import { AuthService } from '../auth.service';
import { AuthController } from './auth.controller';

/**
 * Registers the AUTH API routes (auth doc 04) under the caller-provided prefix
 * (mount at `/v1/auth`).
 *
 * Public: `otp/send`, `otp/verify`, `token/refresh`. Protected (require
 * `authenticate`): `logout` and the `me/sessions` management endpoints. The
 * guard decorators come from the auth plugin registered on the app.
 * @param app The Fastify instance (already decorated with `authenticate`).
 */
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const controller = new AuthController(container.resolve<AuthService>('authService'));
  const authenticated = { onRequest: [app.authenticate] };

  // Public
  app.post('/otp/send', controller.sendOtp);
  app.post('/otp/verify', controller.verifyOtp);
  app.post('/token/refresh', controller.refresh);

  // Protected
  app.post('/logout', authenticated, controller.logout);
  app.get('/me/sessions', authenticated, controller.listSessions);
  app.delete('/me/sessions', authenticated, controller.revokeAllSessions);
  app.delete('/me/sessions/:id', authenticated, controller.revokeSession);
}
