import { appConfig } from './app/app.config.js';
import { databaseConfig } from './database/database.config.js';
import { jwtConfig } from './jwt/jwt.config.js';
import { redisConfig } from './redis/redis.config.js';
import { serverConfig } from './server/server.config.js';
import { workerConfig } from './worker/worker.config.js';
export const config = Object.freeze({
  app: appConfig,
  server: serverConfig,
  database: databaseConfig,
  redis: redisConfig,
  jwt: jwtConfig,
  worker: workerConfig,
});
export type AppConfig = typeof config;
