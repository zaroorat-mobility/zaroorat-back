import { asClass, AwilixContainer } from 'awilix';
import { AuthService } from './services/auth.service';
import { AuthRetentionJob } from './jobs/auth-retention.job';
import { EpochInvalidationConsumer } from './consumers/epoch-invalidation.consumer';

export {
  AuthService,
  type SendOtpInput,
  type VerifyOtpInput,
  type AuthLoginResult,
  type DeviceContext,
} from './services/auth.service';

export * from './consumers';
export * from './controllers';
export * from './routes';
export * from './schemas';
export * from './repositories';
export * from './metrics';
export * from './plugins';
export * from './events';
export * from './errors';
export * from './constants';
export * from './types';
export * from './utils';
export { AuthRetentionJob, type AuthRetentionResult } from './jobs/auth-retention.job';

export function registerAuthService(container: AwilixContainer): void {
  container.register({
    authService: asClass(AuthService).singleton(),
    authRetentionJob: asClass(AuthRetentionJob).singleton(),
    epochInvalidationConsumer: asClass(EpochInvalidationConsumer).singleton(),
  });
}
