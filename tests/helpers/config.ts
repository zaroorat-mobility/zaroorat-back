import type { OtpConfig } from '../../src/config/otp/otp.config.js';
import type { JwtConfig } from '../../src/config/jwt/jwt.config.js';

/**
 * Loose overrides for {@link makeOtpConfig}. Widened to primitive types because
 * `OtpConfig` (via `Object.freeze`) infers literal field types that would reject
 * a different code length in a test.
 */
export interface OtpConfigOverrides {
  codeLength?: number;
  ttlSeconds?: number;
  maxVerifyAttempts?: number;
  lockoutSeconds?: number;
  resendIntervalSeconds?: number;
  pepper?: string;
  rateLimits?: OtpConfig['rateLimits'];
}

/**
 * Build a hermetic {@link OtpConfig} for unit tests. Imported as a type only, so
 * no environment/secret resolution runs — tests stay fast and deterministic.
 * @param overrides Fields to replace on the default policy.
 */
export function makeOtpConfig(overrides: OtpConfigOverrides = {}): OtpConfig {
  return {
    codeLength: 6,
    ttlSeconds: 300,
    maxVerifyAttempts: 5,
    lockoutSeconds: 900,
    resendIntervalSeconds: 60,
    rateLimits: {
      perPhone: { scope: 'otp:req', limit: 3, windowSeconds: 3600 },
      perDevice: { scope: 'otp:dev', limit: 5, windowSeconds: 3600 },
      perIp: { scope: 'otp:ip', limit: 20, windowSeconds: 3600 },
    },
    pepper: 'test-pepper-0123456789abcdef',
    ...overrides,
  } as OtpConfig;
}

/**
 * Build a hermetic {@link JwtConfig} for unit tests with a known secret so the
 * test can independently recompute HMAC signatures.
 * @param overrides Fields to replace on the default policy.
 */
export function makeJwtConfig(overrides: Partial<JwtConfig> = {}): JwtConfig {
  return {
    accessSecret: 'test-access-secret-0123456789abcdef',
    refreshSecret: 'test-refresh-secret-0123456789abcdef',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 2_592_000,
    issuer: 'zaroorat-test',
    ...overrides,
  };
}
