import { asClass, AwilixContainer } from 'awilix';
import { AuthService } from './auth.service';

export {
  AuthService,
  type SendOtpInput,
  type VerifyOtpInput,
  type AuthLoginResult,
  type DeviceContext,
} from './auth.service';

/**
 * Registers the top-level auth service (Phase 8) into the Awilix container.
 *
 * CLASSIC injection resolves its dependencies by name (`otpService`,
 * `userRepository`, `roleRepository`, `deviceService`, `sessionService`,
 * `tokenService`, `redisService`, `jwtConfig`, `sessionConfig`). Must run after
 * every module it composes has been registered.
 * @param container The application DI container.
 */
export function registerAuthService(container: AwilixContainer): void {
  container.register({
    authService: asClass(AuthService).singleton(),
  });
}
