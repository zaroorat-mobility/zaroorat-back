import { asClass, asValue, AwilixContainer } from 'awilix';
import { config } from '@config';

import { JwtService } from './jwt.service';
import { EpochService } from './epoch.service';
import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';

export { JwtService, type AccessTokenClaims, type MintAccessTokenInput } from './jwt.service';
export { EpochService } from './epoch.service';
export {
  RefreshTokenService,
  type IssuedRefreshToken,
  type RotationResult,
} from './refresh-token.service';
export {
  TokenService,
  type TokenPair,
  type IssuePairInput,
  type RolesResolver,
} from './token.service';

/**
 * Registers the token module (Phase 5) into the Awilix container.
 *
 * `jwtConfig` is registered as a value (the frozen config object); CLASSIC
 * injection then resolves each service's constructor params by name
 * (`jwtService`, `epochService`, `refreshTokenService`, `refreshTokenRepository`,
 * `redisService`). Must run after the database, redis, and auth-repository
 * registrations that provide those dependencies.
 * @param container The application DI container.
 */
export function registerTokenServices(container: AwilixContainer): void {
  container.register({
    jwtConfig: asValue(config.jwt),
    jwtService: asClass(JwtService).singleton(),
    epochService: asClass(EpochService).singleton(),
    refreshTokenService: asClass(RefreshTokenService).singleton(),
    tokenService: asClass(TokenService).singleton(),
  });
}
