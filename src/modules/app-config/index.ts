import { asClass, AwilixContainer } from 'awilix';
import { AppConfigRepository } from './repositories/app-config.repository.js';
import { AppConfigCache } from './cache/app-config.cache.js';
import { AppConfigService } from './services/app-config.service.js';
import { AppConfigAdminService } from './services/app-config-admin.service.js';
import { AppConfigController } from './controllers/app-config.controller.js';
import { AppConfigAdminController } from './controllers/app-config-admin.controller.js';

export function registerAppConfigModule(container: AwilixContainer): void {
  container.register({
    appConfigRepository: asClass(AppConfigRepository).singleton(),
    appConfigCache: asClass(AppConfigCache).singleton(),
    appConfigService: asClass(AppConfigService).singleton(),
    appConfigAdminService: asClass(AppConfigAdminService).singleton(),
    appConfigController: asClass(AppConfigController).singleton(),
    appConfigAdminController: asClass(AppConfigAdminController).singleton(),
  });
}

export * from './routes/app-config.routes.js';
export * from './routes/app-config-admin.routes.js';
export * from './services/app-config.service.js';
export * from './services/app-config-admin.service.js';
export * from './repositories/app-config.repository.js';
export * from './constants/app-config.constants.js';
