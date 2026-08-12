import type { JwtConfig } from '@config/jwt/jwt.config';
import type { TransactionClient } from '@core/database/TransactionManager';
import { JwtService } from './jwt.service';
import { RefreshTokenService } from './refresh-token.service';
import { EpochService } from './epoch.service';

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresInSec: number;
  refreshToken: string;
  refreshTokenExpiresInSec: number;
}

export interface IssuePairInput {
  userId: string;
  sessionId: string;
  roles: string[];
}

export type RolesResolver = (userId: string) => Promise<string[]>;

export class TokenService {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(
    private readonly jwtService: JwtService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly epochService: EpochService,
    jwtConfig: JwtConfig,
  ) {
    this.accessTtl = jwtConfig.accessTtlSeconds;
    this.refreshTtl = jwtConfig.refreshTtlSeconds;
  }

  async issuePair(input: IssuePairInput, tx?: TransactionClient): Promise<TokenPair> {
    const epoch = await this.epochService.current(input.userId);
    const accessToken = this.jwtService.sign({
      userId: input.userId,
      sessionId: input.sessionId,
      roles: input.roles,
      epoch,
    });
    const refresh = await this.refreshTokenService.issue(input.userId, input.sessionId, tx);
    return this.toPair(accessToken, refresh.token);
  }

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
