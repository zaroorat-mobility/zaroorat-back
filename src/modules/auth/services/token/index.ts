import { asClass, asValue, AwilixContainer } from 'awilix';
import { jwtConfig } from '@config/jwt/jwt.config';

import { EpochService } from './epoch.service';
import { JwtService } from './jwt.service';
import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';

export * from './epoch.service';
export * from './jwt.service';
export * from './refresh-token.service';
export * from './token.service';

export function registerTokenServices(container: AwilixContainer): void {
  container.register({
    jwtConfig: asValue(jwtConfig),
    epochService: asClass(EpochService).singleton(),
    jwtService: asClass(JwtService).singleton(),
    refreshTokenService: asClass(RefreshTokenService).singleton(),
    tokenService: asClass(TokenService).singleton(),
  });
}
