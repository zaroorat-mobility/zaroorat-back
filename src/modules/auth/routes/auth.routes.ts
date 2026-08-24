import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { AuthService } from '../services/auth.service';
import { AuthController } from '../controllers/auth.controller';
import {
  deviceListResponse,
  errorResponseSchema,
  idParamSchema,
  idempotencyHeaderSchema,
  logoutBodySchema,
  refreshBodySchema,
  sendOtpBodySchema,
  sendOtpResponse,
  sessionListResponse,
  tokenPairResponse,
  verifyOtpBodySchema,
  verifyOtpResponse,
  adminPasswordLoginBodySchema,
  adminLoginResponse,
} from '../schemas/auth.responses';
const noContent = { type: 'null', description: 'No content' } as const;
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const controller = new AuthController(container.resolve<AuthService>('authService'));
  app.post(
    '/otp/send',
    {
      config: { public: true },
      preHandler: app.rateLimit(rateLimits.otpSend),
      schema: {
        tags: ['Auth'],
        summary: 'Request authentication OTP',
        description:
          'Sends an OTP code via SMS to the provided phone number. The response is identical ' +
          'whether or not an account exists, and whether or not that account is closed.',
        body: sendOtpBodySchema,
        response: {
          200: sendOtpResponse,
          400: errorResponseSchema,
          429: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.sendOtp,
  );
  app.post(
    '/otp/verify',
    {
      config: { public: true },
      preHandler: app.rateLimit(rateLimits.otpVerify),
      schema: {
        tags: ['Auth'],
        summary: 'Verify OTP & Log in or Register',
        description:
          'Verifies the OTP code and returns an access + refresh token pair. Refuses any account ' +
          'that is not ACTIVE: a deactivated account returns 403 ACCOUNT_DEACTIVATED and a ' +
          'suspended one 403 ACCOUNT_SUSPENDED, in both cases without creating a session.',
        headers: idempotencyHeaderSchema,
        body: verifyOtpBodySchema,
        response: {
          200: verifyOtpResponse,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          410: errorResponseSchema,
          429: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.verifyOtp,
  );
  app.post(
    '/token/refresh',
    {
      config: { public: true },
      preHandler: app.rateLimit(rateLimits.tokenRefresh),
      schema: {
        tags: ['Auth'],
        summary: 'Refresh access token',
        description:
          'Rotates the refresh token and issues a new access token. Replaying a consumed token ' +
          'revokes the whole session family (401 TOKEN_REUSE).',
        headers: idempotencyHeaderSchema,
        body: refreshBodySchema,
        response: {
          200: tokenPairResponse,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.refresh,
  );
  app.post(
    '/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Logout user session',
        description: 'Revokes the current session, or every session for the user.',
        security: [{ bearerAuth: [] }],
        body: logoutBodySchema,
        response: {
          204: noContent,
          400: errorResponseSchema,
          401: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.logout,
  );
  app.get(
    '/me/sessions',
    {
      schema: {
        tags: ['Auth'],
        summary: 'List active user sessions',
        security: [{ bearerAuth: [] }],
        response: {
          200: sessionListResponse,
          401: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.listSessions,
  );
  app.delete(
    '/me/sessions',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Revoke all sessions',
        security: [{ bearerAuth: [] }],
        response: {
          204: noContent,
          401: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.revokeAllSessions,
  );
  app.delete(
    '/me/sessions/:id',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Revoke specific session',
        security: [{ bearerAuth: [] }],
        params: idParamSchema,
        response: {
          204: noContent,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.revokeSession,
  );
  app.get(
    '/me/devices',
    {
      schema: {
        tags: ['Auth'],
        summary: 'List registered devices',
        security: [{ bearerAuth: [] }],
        response: {
          200: deviceListResponse,
          401: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.listDevices,
  );
  app.delete(
    '/me/devices/:id',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Revoke registered device',
        description:
          'Marks the device REVOKED and terminates every session bound to it. The device may ' +
          'register again on a future login (see module README \u00A7Device lifecycle).',
        security: [{ bearerAuth: [] }],
        params: idParamSchema,
        response: {
          204: noContent,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.revokeDevice,
  );
  app.get(
    '/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Current session identity',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              user: adminLoginResponse.properties.user,
            },
            required: ['user'],
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.getMe,
  );
  app.post(
    '/admin/login',
    {
      config: { public: true },
      preHandler: app.rateLimit(rateLimits.adminLogin),
      schema: {
        tags: ['Auth'],
        summary: 'Admin email & password login',
        description:
          'Authenticates a provisioned staff account (admin, support, or finance). ' +
          'Does not register rider or customer accounts. Unknown, non-staff, or wrong ' +
          'credentials all return 401 INVALID_CREDENTIALS.',
        body: adminPasswordLoginBodySchema,
        response: {
          200: adminLoginResponse,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          429: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.loginAdminPassword,
  );
  app.post(
    '/admin/otp/send',
    {
      config: { public: true },
      preHandler: app.rateLimit(rateLimits.otpSend),
      schema: {
        tags: ['Auth'],
        summary: 'Request admin OTP',
        description:
          'Sends an OTP only when the number belongs to an existing staff account. ' +
          'The response shape is identical otherwise, so this endpoint does not disclose ' +
          'whether a number is staff.',
        body: sendOtpBodySchema,
        response: {
          200: sendOtpResponse,
          400: errorResponseSchema,
          429: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.sendAdminOtp,
  );
  app.post(
    '/admin/otp/verify',
    {
      config: { public: true },
      preHandler: app.rateLimit(rateLimits.otpVerify),
      schema: {
        tags: ['Auth'],
        summary: 'Verify admin OTP',
        description:
          'Verifies an OTP for a staff account and issues tokens. Never creates a new ' +
          'account. A rider or customer number is refused with 401 INVALID_CREDENTIALS.',
        headers: idempotencyHeaderSchema,
        body: verifyOtpBodySchema,
        response: {
          200: adminLoginResponse,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          410: errorResponseSchema,
          429: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    controller.verifyAdminOtp,
  );
}
