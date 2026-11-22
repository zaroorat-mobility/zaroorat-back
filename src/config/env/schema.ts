import { z } from 'zod';
import { APP_ENVIRONMENTS, isDeployed, normalizeEnvironment } from './environment.js';
export const EnvironmentSchema = z
  .object({
    // Required: a container that forgets APP_ENV must not boot with development behaviour.
    // Legacy spellings are accepted and reported as their canonical name.
    APP_ENV: z
      .enum([...APP_ENVIRONMENTS, 'development', 'testing', 'production'])
      .transform((name) => normalizeEnvironment(name)!),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().default('zaroorat-backend'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string(),
    REDIS_URL: z.string(),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    // Key material for `encryptSecret`/`decryptSecret` — provider API keys,
    // payment keys, SMS and SMTP credentials in `system_settings`. Optional
    // outside production so development and test keep working off
    // JWT_ACCESS_SECRET; required below where it matters.
    ENCRYPTION_KEY: z.string().min(32).optional(),
    // Pepper for the rider's standing 4-digit Ride PIN verifier. Optional
    // outside production so development and test keep working off a derivation
    // of JWT_REFRESH_SECRET; required below where it matters.
    RIDE_PIN_PEPPER: z.string().min(32).optional(),
    // Which push provider to boot. 'fcm' requires FIREBASE_SERVICE_ACCOUNT_JSON
    // (or Application Default Credentials). 'mock' is for development/test only.
    PUSH_PROVIDER: z.string().optional(),
    // Full Firebase service-account JSON blob. Required in prod/staging when
    // PUSH_PROVIDER=fcm and Application Default Credentials are not configured.
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    // Driver bank-account protection (bank-account-crypto.ts). Separate from
    // ENCRYPTION_KEY on purpose: bank data and settings credentials rotate on
    // different schedules. Optional outside production; required below.
    BANK_DATA_ENCRYPTION_KEY: z.string().min(32).optional(),
    BANK_ACCOUNT_HASH_KEY: z.string().min(32).optional(),
    // SMS & DLT configuration
    SMS_PROVIDER: z.string().optional(),
    AIRTEL_API_KEY: z.string().optional(),
    AIRTEL_USERNAME: z.string().optional(),
    AIRTEL_PASSWORD: z.string().optional(),
    AIRTEL_CUSTOMER_ID: z.string().optional(),
    AIRTEL_SENDER_ID: z.string().optional(),
    AIRTEL_ENTITY_ID: z.string().optional(),
    AIRTEL_OTP_TEMPLATE_ID: z.string().optional(),
    AIRTEL_CUSTOMER_OTP_TEMPLATE_ID: z.string().optional(),
    AIRTEL_CUSTOMER_OTP_MESSAGE: z.string().optional(),
    AIRTEL_DRIVER_OTP_TEMPLATE_ID: z.string().optional(),
    AIRTEL_DRIVER_OTP_MESSAGE: z.string().optional(),
    AIRTEL_DRIVER_DOC_REJECTED_TEMPLATE_ID: z.string().optional(),
    AIRTEL_DRIVER_DOC_REJECTED_MESSAGE: z.string().optional(),
    AIRTEL_DRIVER_ACTIVATED_TEMPLATE_ID: z.string().optional(),
    AIRTEL_DRIVER_ACTIVATED_MESSAGE: z.string().optional(),
    ALLOW_OFFLINE_ROUTING: z.string().optional(),
    ENABLE_OFFLINE_ROUTING: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const deployed = isDeployed(env.APP_ENV);
    for (const name of ['BANK_DATA_ENCRYPTION_KEY', 'BANK_ACCOUNT_HASH_KEY'] as const) {
      if (deployed && !env[name]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message:
            `required when APP_ENV=${env.APP_ENV}: driver bank account numbers are encrypted ` +
            'and hashed with it. Set it once and never change it without a key-rotation run.',
        });
      }
    }
    if (deployed && !env.ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_KEY'],
        message:
          `required when APP_ENV=${env.APP_ENV}. If this deployment already has stored ` +
          'credentials, set it to the current JWT_ACCESS_SECRET value to keep them readable; ' +
          'any other value requires re-entering every credential in the admin panel.',
      });
    }
    if (deployed && !env.RIDE_PIN_PEPPER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RIDE_PIN_PEPPER'],
        message:
          `required when APP_ENV=${env.APP_ENV}. Generate 32+ random bytes and store it in ` +
          'the secret manager. It must NOT be derived from, or equal to, JWT_REFRESH_SECRET. ' +
          'Changing it later invalidates every rider Ride PIN.',
      });
    }
    if (deployed && env.PUSH_PROVIDER === 'fcm' && !env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_SERVICE_ACCOUNT_JSON'],
        message:
          `required when APP_ENV=${env.APP_ENV} and PUSH_PROVIDER=fcm. ` +
          'Set it to the Firebase service-account JSON blob from the Firebase console, ' +
          'or configure Application Default Credentials and leave this unset.',
      });
    }
  });
export type Environment = z.infer<typeof EnvironmentSchema>;
