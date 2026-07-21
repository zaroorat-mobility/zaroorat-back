import { env } from '../env/index.js';

export const databaseConfig = Object.freeze({
  url: env.DATABASE_URL,
});
