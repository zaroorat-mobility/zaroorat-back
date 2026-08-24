import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RedisService } from '@core/cache';
import { container } from '@core/di';
import { JwtService } from '../services/token/jwt.service';
import { EpochService } from '../services/token/epoch.service';
import { SessionService } from '../services/session/session.service';
import { DriverAccessRepository } from '../repositories/driver-access.repository';
import { DeviceRepository } from '../repositories/device.repository';
import { PermissionRepository } from '../repositories/permission.repository';
import { SYSTEM_ADMIN_ROLE_SLUG } from '../constants/auth.constants';
import { AuthError, TokenInvalidError } from '../errors/auth.errors';
import { replyAuthError } from '../schemas/error-response';
export interface AuthorizeOptions {
  roles?: string[];
  permissions?: string[];
  requireOperableDriver?: boolean;
  requireUntamperedDevice?: boolean;
}
function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new TokenInvalidError('Missing or malformed Authorization header');
  }
  return header.slice('Bearer '.length).trim();
}
export async function authPlugin(app: FastifyInstance): Promise<void> {
  const jwtService = container.resolve<JwtService>('jwtService');
  const epochService = container.resolve<EpochService>('epochService');
  const redisService = container.resolve<RedisService>('redisService');
  const sessionService = container.resolve<SessionService>('sessionService');
  const driverAccess = container.resolve<DriverAccessRepository>('driverAccessRepository');
  const deviceRepository = container.resolve<DeviceRepository>('deviceRepository');
  const permissionRepository = container.resolve<PermissionRepository>('permissionRepository');
  app.decorateRequest('auth', null);
  app.decorate(
    'authenticate',
    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      let claims;
      try {
        claims = jwtService.verify(extractBearerToken(request));
      } catch (err) {
        const code = err instanceof AuthError ? err.code : 'TOKEN_INVALID';
        return replyAuthError(request, reply, code, 'Invalid or expired access token');
      }
      try {
        if (claims.epoch !== (await epochService.current(claims.sub))) {
          return replyAuthError(request, reply, 'TOKEN_STALE', 'The access token is stale');
        }
        if (await redisService.sidBlacklist.isRevoked(claims.sid)) {
          return replyAuthError(request, reply, 'SESSION_REVOKED', 'This session has been revoked');
        }
      } catch (err) {
        request.log.error({ err }, '[auth] revocation store unavailable \u2014 failing closed');
        return replyAuthError(
          request,
          reply,
          'SERVICE_UNAVAILABLE',
          'Authentication is temporarily unavailable',
        );
      }
      request.auth = { userId: claims.sub, sid: claims.sid, roles: claims.roles ?? [] };
      await sessionService.touchLastSeenThrottled(claims.sid);
    },
  );
  app.decorate('authorize', function authorize(options: AuthorizeOptions = {}) {
    return async function authorizeHandler(request: FastifyRequest, reply: FastifyReply) {
      const auth = request.auth;
      if (!auth) {
        return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
      }
      const requiredRoles = options.roles ?? [];
      const requiredPermissions = options.permissions ?? [];
      const isSystemAdmin = auth.roles.includes(SYSTEM_ADMIN_ROLE_SLUG);
      if (!isSystemAdmin) {
        if (requiredRoles.length > 0 && !requiredRoles.some((role) => auth.roles.includes(role))) {
          return replyAuthError(request, reply, 'FORBIDDEN', 'Insufficient role');
        }
        if (requiredPermissions.length > 0) {
          let held: string[];
          try {
            held = await permissionRepository.findAllowedCodesForUser(auth.userId);
          } catch (err) {
            request.log.error({ err }, '[auth] permission lookup failed \u2014 failing closed');
            return replyAuthError(
              request,
              reply,
              'SERVICE_UNAVAILABLE',
              'Authorization is temporarily unavailable',
            );
          }
          if (!requiredPermissions.some((code) => held.includes(code))) {
            return replyAuthError(request, reply, 'FORBIDDEN', 'Insufficient permission');
          }
        }
      }
      if (options.requireUntamperedDevice) {
        try {
          const device = await deviceRepository.findBySession(auth.sid);
          if (!device || device.isRooted || device.isJailbroken) {
            return replyAuthError(
              request,
              reply,
              'FORBIDDEN',
              'This device cannot perform this action',
            );
          }
        } catch (err) {
          request.log.error({ err }, '[auth] device check failed \u2014 failing closed');
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
          request.log.error(
            { err },
            '[auth] driver operability check failed \u2014 failing closed',
          );
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
  const runAuthenticate = app.authenticate as (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  app.addHook('onRequest', async function denyByDefault(request, reply) {
    const routeUrl = request.routeOptions.url;
    if (routeUrl == null) return;
    if (request.routeOptions.config?.public === true) return;
    if (routeUrl === '/docs' || routeUrl.startsWith('/docs/')) return;
    return runAuthenticate(request, reply);
  });
}
export default fp(authPlugin, { name: 'auth-guard' });
