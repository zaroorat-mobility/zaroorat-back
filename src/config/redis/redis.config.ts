import { env } from '../env/index.js';

export const redisConfig = Object.freeze({
  url: env.REDIS_URL,
});
