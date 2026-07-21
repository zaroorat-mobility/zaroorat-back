import { appConfig } from './app/index.js';
import { authConfig } from './auth/index.js';
import { databaseConfig } from './database/index.js';
import { redisConfig } from './redis/index.js';

class ConfigurationService {
  public get app() {
    return appConfig;
  }

  public get auth() {
    return authConfig;
  }

  public get database() {
    return databaseConfig;
  }

  public get redis() {
    return redisConfig;
  }
}

export const ConfigService = new ConfigurationService();
