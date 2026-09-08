import { z } from 'zod';
export const EnvironmentSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
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
  })
  .superRefine((env, ctx) => {
    // Deployed environments must key credential encryption to a secret of its
    // own. Falling through to JWT_ACCESS_SECRET ties the lifetime of every
    // stored credential to a token secret that is rotated on a different
    // schedule: rotating it would leave every credential undecryptable, and
    // `decryptSecret` reports that as an empty string, so providers would read
    // as "not configured" rather than raising anything.
    if ((env.APP_ENV === 'production' || env.APP_ENV === 'staging') && !env.ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_KEY'],
        message:
          `required when APP_ENV=${env.APP_ENV}. If this deployment already has stored ` +
          'credentials, set it to the current JWT_ACCESS_SECRET value to keep them readable; ' +
          'any other value requires re-entering every credential in the admin panel.',
      });
    }
    // A Ride PIN is four digits — 10,000 possibilities — and stands for the life
    // of the account, so the pepper is the control that keeps a stolen database
    // from being brute-forced offline in isolation. Deriving it from
    // JWT_REFRESH_SECRET, the way OTP_PEPPER does, would make a leak of the
    // token signing secret a leak of every rider's PIN as well: two secrets that
    // look independent would not be. Deployed environments must give it its own.
    //
    // Rotating this value invalidates every stored verifier, so every rider
    // would have to reset their PIN. Set it once, before the first PIN is
    // stored, and keep it in the secret manager.
    if ((env.APP_ENV === 'production' || env.APP_ENV === 'staging') && !env.RIDE_PIN_PEPPER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RIDE_PIN_PEPPER'],
        message:
          `required when APP_ENV=${env.APP_ENV}. Generate 32+ random bytes and store it in ` +
          'the secret manager. It must NOT be derived from, or equal to, JWT_REFRESH_SECRET. ' +
          'Changing it later invalidates every rider Ride PIN.',
      });
    }
  });
export type Environment = z.infer<typeof EnvironmentSchema>;
