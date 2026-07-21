import { z } from "zod";

export const EnvironmentSchema = z.object({
  APP_ENV: z.enum([
    "local",
    "test",
    "staging",
    "production",
  ]).default("local"),

  NODE_ENV: z.enum([
    "development",
    "test",
    "production",
  ]).default("development"),

  APP_NAME: z.string().default("zaroorat-backend"),

  HOST: z.string().default("0.0.0.0"),

  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string(),

  REDIS_URL: z.string(),

  JWT_ACCESS_SECRET: z.string().min(32),

  JWT_REFRESH_SECRET: z.string().min(32),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
