import { loadEnvironment } from "./loader.js";
import { validateEnvironment } from "./validator.js";

// Step 1: Load .env file (if applicable)
loadEnvironment();

// Step 2: Validate environment variables
const validatedEnv = validateEnvironment();

// Step 3: Build immutable configuration object
export const env = Object.freeze({
  app: {
    name: validatedEnv.APP_NAME,
    environment: validatedEnv.APP_ENV,
    nodeEnv: validatedEnv.NODE_ENV,
  },

  server: {
    host: validatedEnv.HOST,
    port: validatedEnv.PORT,
  },

  database: {
    url: validatedEnv.DATABASE_URL,
  },

  redis: {
    url: validatedEnv.REDIS_URL,
  },

  jwt: {
    accessSecret: validatedEnv.JWT_ACCESS_SECRET,
    refreshSecret: validatedEnv.JWT_REFRESH_SECRET,
  },
});

export type AppConfig = typeof env;
