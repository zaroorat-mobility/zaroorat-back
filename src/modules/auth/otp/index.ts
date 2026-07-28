import { asClass, asValue, AwilixContainer } from 'awilix';
import { otpConfig } from '@config/otp/otp.config';

import { OtpGenerator } from './otp.generator';
import { OtpHasher } from './otp.hasher';
import { OtpValidator } from './otp.validator';
import { OtpRateLimiter } from './otp.rate-limiter';
import { OtpMetrics } from './otp.metrics';
import { OtpService } from './otp.service';

export { OtpGenerator } from './otp.generator';
export { OtpHasher } from './otp.hasher';
export { OtpValidator } from './otp.validator';
export { OtpRateLimiter, type OtpSendContext, type RateLimitDecision } from './otp.rate-limiter';
export { OtpMetrics, type OtpMetricFields } from './otp.metrics';
export {
  OtpService,
  type SendOtpInput,
  type SendOtpResult,
  type VerifyOtpInput,
} from './otp.service';

/**
 * Registers the OTP module (Phase 6) into the Awilix container.
 *
 * `otpConfig` is a value registration; CLASSIC injection resolves the rest by
 * name (`otpGenerator`, `otpHasher`, `otpValidator`, `otpRateLimiter`,
 * `redisService`, `otpRepository`, `notificationService`). Must run after the
 * redis, notification, and auth-repository registrations.
 * @param container The application DI container.
 */
export function registerOtpServices(container: AwilixContainer): void {
  container.register({
    otpConfig: asValue(otpConfig),
    otpGenerator: asClass(OtpGenerator).singleton(),
    otpHasher: asClass(OtpHasher).singleton(),
    otpValidator: asClass(OtpValidator).singleton(),
    otpRateLimiter: asClass(OtpRateLimiter).singleton(),
    otpMetrics: asClass(OtpMetrics).singleton(),
    otpService: asClass(OtpService).singleton(),
  });
}
