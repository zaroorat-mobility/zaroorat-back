import { validatedEnv } from "../env/validated-env.js";

export const redisConfig = Object.freeze({
  url: validatedEnv.REDIS_URL,
});
