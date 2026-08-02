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
import { registerUserRepositories, registerUserService } from '@modules/users';
import { registerFileModule } from '@modules/files';

export const container = createContainer({ injectionMode: InjectionMode.CLASSIC });

// Register modules (dependencies before consumers)
registerDatabaseModule(container);
registerRedisModule(container);
registerEventsModule(container);
registerNotificationModule(container);
registerFileModule(container); // storage provider — no dependants until phase 2
registerAuthRepositories(container);
registerUserRepositories(container);
registerTokenServices(container);
registerOtpServices(container);
registerSessionServices(container);
registerAuthService(container); // provisions the user profile in its login tx
registerUserService(container);
