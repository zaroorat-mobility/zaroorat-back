import { env } from '../env/index.js';

export const appConfig = Object.freeze({
  env: env.APP_ENV,
  nodeEnv: env.NODE_ENV,
  appName: env.APP_NAME,
  host: env.HOST,
  port: env.PORT,
});
