import { RedisService } from '@core/cache';
import { JwtService } from '@modules/auth/services/token/jwt.service.js';
import { EpochService } from '@modules/auth/services/token/epoch.service.js';
import { DriverAccessRepository } from '@modules/auth/repositories/driver-access.repository.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { SocketUnauthenticatedError } from './realtime.errors.js';

/// Who the server decided is on the other end of a socket. Every field is
/// derived from the signed token or from the database — nothing here is ever
/// taken from a payload the client sent.
export interface SocketPrincipal {
  userId: string;
  sid: string;
  roles: string[];
  /// Set only for a driver who is currently *operable* (verified, not suspended,
  /// not soft-deleted) — the same predicate `authorize({requireOperableDriver})`
  /// applies to driver HTTP routes. A suspended driver still gets a socket, as a
  /// customer would, but carries no driver identity, so every driver-only action
  /// on it is refused.
  driverId: string | null;
}

export interface SocketHandshake {
  auth?: Record<string, unknown> | undefined;
  headers?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
}

/// Pulls the access token out of a handshake. `auth.token` is the canonical
/// place (socket.io sends it out of band, not in the URL); an Authorization
/// header is accepted for parity with the HTTP API. The query string is
/// deliberately NOT read — tokens in URLs end up in proxy and access logs.
export function tokenFromHandshake(handshake: SocketHandshake): string {
  const fromAuth = handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.trim()) return fromAuth.trim();

  const header = handshake.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const bearer = header.slice('Bearer '.length).trim();
    if (bearer) return bearer;
  }
  throw new SocketUnauthenticatedError('No access token was supplied with the handshake');
}

/// The socket half of authentication. Deliberately not a second auth system:
/// it runs the same four checks `authPlugin.authenticate` runs, against the same
/// services, so a token that has been rotated, staled or revoked is refused on
/// a socket exactly as it is on an HTTP route.
export class SocketAuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly epochService: EpochService,
    private readonly redisService: RedisService,
    private readonly driverAccessRepository: DriverAccessRepository,
    private readonly driverRepository: DriverRepository,
  ) {}

  async authenticate(handshake: SocketHandshake): Promise<SocketPrincipal> {
    const token = tokenFromHandshake(handshake);

    // 1. Signature and expiry. `verify` throws TokenExpiredError /
    //    TokenInvalidError — the socket layer never re-implements either check.
    let claims;
    try {
      claims = this.jwtService.verify(token);
    } catch {
      throw new SocketUnauthenticatedError('Invalid or expired access token');
    }

    // 2. Epoch: a password change, logout-everywhere or role change bumps it,
    //    which retires every token minted before.
    // 3. Session revocation.
    // Both fail closed if the store is unreachable, matching the HTTP guard.
    try {
      if (claims.epoch !== (await this.epochService.current(claims.sub))) {
        throw new SocketUnauthenticatedError('The access token is stale');
      }
      if (await this.redisService.sidBlacklist.isRevoked(claims.sid)) {
        throw new SocketUnauthenticatedError('This session has been revoked');
      }
    } catch (err) {
      if (err instanceof SocketUnauthenticatedError) throw err;
      throw new SocketUnauthenticatedError('Authentication is temporarily unavailable');
    }

    // 4. Driver identity, resolved server-side from the user id in the token.
    //    A client cannot nominate which driver it is.
    return {
      userId: claims.sub,
      sid: claims.sid,
      roles: claims.roles,
      driverId: await this.resolveOperableDriverId(claims.sub, claims.roles),
    };
  }

  private async resolveOperableDriverId(userId: string, roles: string[]): Promise<string | null> {
    if (!roles.includes('driver')) return null;
    if (!(await this.driverAccessRepository.isOperableDriver(userId))) return null;
    const driver = await this.driverRepository.findByUserId(userId);
    return driver?.id ?? null;
  }
}
