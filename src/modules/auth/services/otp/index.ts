import { asClass, asValue, AwilixContainer } from 'awilix';
import { otpConfig } from '@config/otp/otp.config';
import { enqueueOtpDelivery } from '@/jobs/producers/index.js';
import { OtpGenerator } from './otp.generator';
import { OtpHasher } from './otp.hasher';
import { OtpValidator } from './otp.validator';
import { OtpRateLimiter } from './otp.rate-limiter';
import { OtpMetrics } from '../../metrics';
import { OtpService } from './otp.service';
export { OtpGenerator } from './otp.generator';
export { OtpHasher } from './otp.hasher';
export { OtpValidator } from './otp.validator';
export { OtpRateLimiter, type OtpSendContext, type RateLimitDecision } from './otp.rate-limiter';
export { OtpMetrics, type OtpMetricFields } from '../../metrics';
export {
  OtpService,
  type OtpDeliveryProducer,
  type SendOtpInput,
  type SendOtpResult,
  type VerifyOtpInput,
} from './otp.service';
export function registerOtpServices(container: AwilixContainer): void {
  container.register({
    otpConfig: asValue(otpConfig),
    otpProducer: asValue({ enqueue: enqueueOtpDelivery }),
    otpGenerator: asClass(OtpGenerator).singleton(),
    otpHasher: asClass(OtpHasher).singleton(),
    otpValidator: asClass(OtpValidator).singleton(),
    otpRateLimiter: asClass(OtpRateLimiter).singleton(),
    otpMetrics: asClass(OtpMetrics).singleton(),
    otpService: asClass(OtpService).singleton(),
  });
}
