import type { OtpConfig } from '../../src/config/otp/otp.config.js';
import type { JwtConfig } from '../../src/config/jwt/jwt.config.js';

export interface OtpConfigOverrides {
  codeLength?: number;
  ttlSeconds?: number;
  maxVerifyAttempts?: number;
  lockoutSeconds?: number;
  resendIntervalSeconds?: number;
  pepper?: string;
  rateLimits?: OtpConfig['rateLimits'];
}

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

export function makeJwtConfig(overrides: Partial<JwtConfig> = {}): JwtConfig {
  const secret = overrides.accessSecret ?? 'test-access-secret-0123456789abcdef';
  const refreshSecret = overrides.refreshSecret ?? 'test-refresh-secret-0123456789abcdef';
  const primaryKid = overrides.primaryKid ?? 'v1';
  return {
    primaryKid,
    accessSecret: secret,
    accessSecrets: {
      [primaryKid]: secret,
      ...(overrides.accessSecrets ?? {}),
    },
    refreshSecret,
    accessTtlSeconds: 900,
    refreshTtlSeconds: 2_592_000,
    issuer: 'zaroorat-test',

    revokedRetentionDays: 30,
    ...overrides,
  };
}
