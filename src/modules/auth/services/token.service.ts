import type { JwtConfig } from '@config/jwt/jwt.config';
import { JwtService } from './jwt.service';
import { RefreshTokenService } from './refresh-token.service';
import { EpochService } from './epoch.service';

/** The access + refresh pair returned to a client (shape per auth doc 04 §2.2). */
export interface TokenPair {
  accessToken: string;
  accessTokenExpiresInSec: number;
  refreshToken: string;
  refreshTokenExpiresInSec: number;
}

/** Identity context needed to mint a pair for a session. */
export interface IssuePairInput {
  userId: string;
  sessionId: string;
  roles: string[];
}

/** Resolves a user's current role slugs (supplied by the caller to keep the
 *  token module decoupled from the RBAC repository). */
export type RolesResolver = (userId: string) => Promise<string[]>;

/**
 * Facade over the token primitives: issues a fresh access+refresh pair on login
 * and rotates the pair on refresh. Composes {@link JwtService} (access),
 * {@link RefreshTokenService} (refresh rotation/reuse), and {@link EpochService}
 * (mint-time epoch). Role resolution is injected per call so the token module
 * does not depend on the RBAC layer — the auth service supplies it (Phase 8).
 */
export class TokenService {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  /**
   * @param jwtService Access-token minting.
   * @param refreshTokenService Refresh issuance/rotation.
   * @param epochService Current-epoch lookup for the access claim.
   * @param jwtConfig Supplies the TTLs echoed to the client.
   */
  constructor(
    private readonly jwtService: JwtService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly epochService: EpochService,
    jwtConfig: JwtConfig,
  ) {
    this.accessTtl = jwtConfig.accessTtlSeconds;
    this.refreshTtl = jwtConfig.refreshTtlSeconds;
  }

  /**
   * Mint a fresh access+refresh pair for a session (login / first verify).
   * @param input User, session, and role snapshot.
   * @returns The token pair.
   */
  async issuePair(input: IssuePairInput): Promise<TokenPair> {
    const epoch = await this.epochService.current(input.userId);
    const accessToken = this.jwtService.sign({
      userId: input.userId,
      sessionId: input.sessionId,
      roles: input.roles,
      epoch,
    });
    const refresh = await this.refreshTokenService.issue(input.userId, input.sessionId);
    return this.toPair(accessToken, refresh.token);
  }

  /**
   * Rotate a presented refresh token and mint a matching new access token.
   *
   * Reuse/expiry is surfaced by the refresh service as `TokenReuseError` /
   * `TokenInvalidError`. Roles for the new access token are resolved via the
   * injected resolver against the rotated token's owner.
   * @param presentedRefreshToken The raw refresh token from the client.
   * @param resolveRoles Resolver for the owner's current role slugs.
   * @returns The rotated token pair.
   */
  async rotate(presentedRefreshToken: string, resolveRoles: RolesResolver): Promise<TokenPair> {
    const rotated = await this.refreshTokenService.rotate(presentedRefreshToken);
    const roles = await resolveRoles(rotated.userId);
    const epoch = await this.epochService.current(rotated.userId);
    const accessToken = this.jwtService.sign({
      userId: rotated.userId,
      sessionId: rotated.sessionId,
      roles,
      epoch,
    });
    return this.toPair(accessToken, rotated.refresh.token);
  }

  private toPair(accessToken: string, refreshToken: string): TokenPair {
    return {
      accessToken,
      accessTokenExpiresInSec: this.accessTtl,
      refreshToken,
      refreshTokenExpiresInSec: this.refreshTtl,
    };
  }
}
