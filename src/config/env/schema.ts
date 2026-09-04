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
  });
export type Environment = z.infer<typeof EnvironmentSchema>;
