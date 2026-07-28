import { createContainer, InjectionMode } from 'awilix';
import { registerDatabaseModule } from './database/DatabaseModule';
import { registerRedisModule } from './cache/RedisModule';
import { registerEventsModule } from './events';
import { registerNotificationModule } from '@modules/notifications';
import { registerAuthRepositories } from '@modules/auth/repositories';
import { registerTokenServices } from '@modules/auth/services';
import { registerOtpServices } from '@modules/auth/otp';
import { registerSessionServices } from '@modules/auth/session';
import { registerAuthService } from '@modules/auth';

export const container = createContainer({ injectionMode: InjectionMode.CLASSIC });

// Register modules (dependencies before consumers)
registerDatabaseModule(container);
registerRedisModule(container);
registerEventsModule(container);
registerNotificationModule(container);
registerAuthRepositories(container);
registerTokenServices(container);
registerOtpServices(container);
registerSessionServices(container);
registerAuthService(container);
