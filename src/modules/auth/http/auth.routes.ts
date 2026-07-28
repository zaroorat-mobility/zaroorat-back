import type { FastifyInstance } from 'fastify';

import { container } from '@core/di';
import { AuthService } from '../auth.service';
import { AuthController } from './auth.controller';

/**
 * Registers the AUTH API routes (auth doc 04) under the caller-provided prefix
 * (mount at `/v1/auth`).
 *
 * Authentication is deny-by-default (auth doc 02 §6): the global gate installed
 * by the auth plugin protects every route, so only the credential-establishing
 * endpoints — `otp/send`, `otp/verify`, `token/refresh` — opt out with
 * `config: { public: true }`. `logout` and the `me/sessions` endpoints need no
 * explicit guard; the gate authenticates them and populates `request.auth`.
 * @param app The Fastify instance (already carrying the deny-by-default gate).
 */
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const controller = new AuthController(container.resolve<AuthService>('authService'));
  const publicRoute = { config: { public: true } };

  // Public (credential-establishing) — explicitly opted out of the auth gate.
  app.post('/otp/send', publicRoute, controller.sendOtp);
  app.post('/otp/verify', publicRoute, controller.verifyOtp);
  app.post('/token/refresh', publicRoute, controller.refresh);

  // Protected — the deny-by-default gate authenticates these before the handler.
  app.post('/logout', controller.logout);
  app.get('/me/sessions', controller.listSessions);
  app.delete('/me/sessions', controller.revokeAllSessions);
  app.delete('/me/sessions/:id', controller.revokeSession);
}
