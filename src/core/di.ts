import { createContainer, InjectionMode } from 'awilix';
import { registerDatabaseModule } from './database/DatabaseModule';

export const container = createContainer({ injectionMode: InjectionMode.CLASSIC });

// Register modules
registerDatabaseModule(container);
