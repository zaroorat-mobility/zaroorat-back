import { env } from '../env/index.js';

export const authConfig = Object.freeze({
  jwtAccessSecret: env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: env.JWT_REFRESH_SECRET,
});
