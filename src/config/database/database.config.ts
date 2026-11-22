import { validatedEnv } from '../env/validated-env.js';
export const databaseConfig = Object.freeze({
  url: validatedEnv.DATABASE_URL,
});
