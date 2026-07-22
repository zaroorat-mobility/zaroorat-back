import { validatedEnv } from '../env/validated-env.js';

export const jwtConfig = Object.freeze({
  accessSecret: validatedEnv.JWT_ACCESS_SECRET,
  refreshSecret: validatedEnv.JWT_REFRESH_SECRET,
});
