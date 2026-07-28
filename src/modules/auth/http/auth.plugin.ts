import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { RedisService } from '@core/cache';
import { container } from '@core/di';
import { JwtService } from '../services/jwt.service';
import { EpochService } from '../services/epoch.service';
import { DriverAccessRepository } from '../repositories/driver-access.repository';
import { AuthError, TokenInvalidError } from '../errors';
import { replyAuthError } from './error-response';

/** Options for the {@link FastifyInstance.authorize} factory. */
export interface AuthorizeOptions {
  roles?: string[];
  requireOperableDriver?: boolean;
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
 * - `authorize({ roles, requireOperableDriver })` — role check (deny-by-default),
 *   plus the live driver-operability conjunction for ride operations (R-AUTH-23).
 *
 * Services are singletons resolved once at registration.
 */
async function authPlugin(app: FastifyInstance): Promise<void> {
  const jwtService = container.resolve<JwtService>('jwtService');
  const epochService = container.resolve<EpochService>('epochService');
  const redisService = container.resolve<RedisService>('redisService');
  const driverAccess = container.resolve<DriverAccessRepository>('driverAccessRepository');

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
}

export default fp(authPlugin, { name: 'auth-guard' });
