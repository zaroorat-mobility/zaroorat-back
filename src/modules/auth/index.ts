import { asClass, AwilixContainer } from 'awilix';
import { AuthService } from './services/auth.service';
import { AuthRetentionJob } from './jobs/auth-retention.job';
import { OtpDeliveryJob } from './jobs/otp-delivery.job';
import { EpochInvalidationConsumer } from './consumers/epoch-invalidation.consumer';
import { AuthDriverVerifiedConsumer } from './consumers/driver-verified.consumer';
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
export {
  OtpDeliveryJob,
  OtpDeliveryRetryableError,
  type OtpDeliveryResult,
} from './jobs/otp-delivery.job';
export function registerAuthService(container: AwilixContainer): void {
  container.register({
    authService: asClass(AuthService).singleton(),
    authRetentionJob: asClass(AuthRetentionJob).singleton(),
    otpDeliveryJob: asClass(OtpDeliveryJob).singleton(),
    epochInvalidationConsumer: asClass(EpochInvalidationConsumer).singleton(),
    authDriverVerifiedConsumer: asClass(AuthDriverVerifiedConsumer).singleton(),
  });
}
