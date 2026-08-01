import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { RedisService } from '@core/cache';
import { container } from '@core/di';
import { JwtService } from '../services/jwt.service';
import { EpochService } from '../services/epoch.service';
import { DriverAccessRepository } from '../repositories/driver-access.repository';
import { DeviceRepository } from '../repositories/device.repository';
import { AuthError, TokenInvalidError } from '../errors';
import { replyAuthError } from './error-response';

/** Options for the {@link FastifyInstance.authorize} factory. */
export interface AuthorizeOptions {
  roles?: string[];
  requireOperableDriver?: boolean;
  /**
   * Refuse the action when the calling device reports root or jailbreak
   * (doc 02 §5.2, R-DEVICE-5).
   *
   * Opt-in per route, because **the sensitive-action list is owned by each
   * module and AUTH only enforces the flag**. Normal authentication is
   * unaffected — a tampered device may still sign in and use the app; it is the
   * sensitive subset each module names that closes.
   */
  requireUntamperedDevice?: boolean;
}

/** Extract the bearer token, or throw `TokenInvalidError` if absent/malformed. */
function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new TokenInvalidError('Missing or malformed Authorization header');
  }
  return header.slice('Bearer '.length).trim();
}

/**
 * Registers the AUTH guard decorators (auth doc 02 §6, doc 04 §3):
 *
 * - `authenticate` — verify the JWT signature, then the epoch and sid denylist
 *   in Redis. A bad/expired/tampered token → 401 `TOKEN_INVALID`; a stale epoch →
 *   `TOKEN_STALE`; a revoked sid → `SESSION_REVOKED`. If the revocation store is
 *   unavailable it **fails closed** with 503 (never falls through to success).
 * - `authorize({ roles, requireOperableDriver, requireUntamperedDevice })` — role
 *   check (deny-by-default), the live driver-operability conjunction for ride
 *   operations (R-AUTH-23), and the root/jailbreak refusal for the sensitive
 *   subset each module names (doc 02 §5.2).
 *
 * It also installs the **deny-by-default** gate: a global `onRequest` hook that
 * authenticates every matched route unless it explicitly opts out with
 * `config: { public: true }` (auth doc 02 §6, doc 07 §3 row 5). A new route that
 * forgets to declare its posture is therefore protected, not open. Unmatched
 * routes fall through to the 404 handler unchanged.
 *
 * Services are singletons resolved once at registration.
 */
async function authPlugin(app: FastifyInstance): Promise<void> {
  const jwtService = container.resolve<JwtService>('jwtService');
  const epochService = container.resolve<EpochService>('epochService');
  const redisService = container.resolve<RedisService>('redisService');
  const driverAccess = container.resolve<DriverAccessRepository>('driverAccessRepository');
  const deviceRepository = container.resolve<DeviceRepository>('deviceRepository');

  app.decorateRequest('auth', null);

  app.decorate(
    'authenticate',
    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      // 1. Stateless JWT verification (signature, exp, issuer, alg pinning).
      let claims;
      try {
        claims = jwtService.verify(extractBearerToken(request));
      } catch (err) {
        const code = err instanceof AuthError ? err.code : 'TOKEN_INVALID';
        return replyAuthError(request, reply, code, 'Invalid or expired access token');
      }

      // 2. Revocation checks (Redis). Fail closed on infra failure — never 200.
      try {
        if (claims.epoch !== (await epochService.current(claims.sub))) {
          return replyAuthError(request, reply, 'TOKEN_STALE', 'The access token is stale');
        }
        if (await redisService.sidBlacklist.isRevoked(claims.sid)) {
          return replyAuthError(request, reply, 'SESSION_REVOKED', 'This session has been revoked');
        }
      } catch (err) {
        request.log.error({ err }, '[auth] revocation store unavailable — failing closed');
        return replyAuthError(
          request,
          reply,
          'SERVICE_UNAVAILABLE',
          'Authentication is temporarily unavailable',
        );
      }

      request.auth = { userId: claims.sub, sid: claims.sid, roles: claims.roles };
    },
  );

  app.decorate('authorize', function authorize(options: AuthorizeOptions = {}) {
    return async function authorizeHandler(request: FastifyRequest, reply: FastifyReply) {
      const auth = request.auth;
      if (!auth) {
        return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
      }

      const required = options.roles ?? [];
      if (required.length > 0 && !required.some((role) => auth.roles.includes(role))) {
        return replyAuthError(request, reply, 'FORBIDDEN', 'Insufficient role');
      }

      if (options.requireUntamperedDevice) {
        try {
          const device = await deviceRepository.findBySession(auth.sid);
          // An unknown device is a denial, not a pass. Every OTP login binds one,
          // so the only way to arrive here without a device is a session this
          // guard cannot assess — and "cannot assess" must not mean "allowed" on
          // the one subset of actions the flag exists to protect.
          if (!device || device.isRooted || device.isJailbroken) {
            return replyAuthError(
              request,
              reply,
              'FORBIDDEN',
              'This device cannot perform this action',
            );
          }
        } catch (err) {
          request.log.error({ err }, '[auth] device check failed — failing closed');
          return replyAuthError(
            request,
            reply,
            'SERVICE_UNAVAILABLE',
            'Authorization is temporarily unavailable',
          );
        }
      }

      if (options.requireOperableDriver) {
        try {
          if (!(await driverAccess.isOperableDriver(auth.userId))) {
            return replyAuthError(request, reply, 'FORBIDDEN', 'Driver is not operable');
          }
        } catch (err) {
          request.log.error({ err }, '[auth] driver operability check failed — failing closed');
          return replyAuthError(
            request,
            reply,
            'SERVICE_UNAVAILABLE',
            'Authorization is temporarily unavailable',
          );
        }
      }
    };
  });

  // Deny-by-default: authenticate every matched route unless it opts out with
  // `config: { public: true }`. Unmatched routes (routeOptions.url == null) are
  // left to the 404 handler so unknown paths still 404 rather than 401.
  const runAuthenticate = app.authenticate as (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  app.addHook('onRequest', async function denyByDefault(request, reply) {
    if (request.routeOptions.url == null) return;
    if (request.routeOptions.config?.public === true) return;
    return runAuthenticate(request, reply);
  });
}

export default fp(authPlugin, { name: 'auth-guard' });
