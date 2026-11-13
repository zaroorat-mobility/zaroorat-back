export { DatabaseService } from './DatabaseService';
export {
  PrismaClientProvider,
  type ProviderClient,
  type DatabaseHealth,
} from './client/PrismaClientProvider';
export { PrismaClientFactory } from './client/PrismaClientFactory';
export { TransactionManager, type TransactionOptions } from './TransactionManager';
export { BaseRepository } from './repositories/BaseRepository';
export { registerDatabaseModule } from './DatabaseModule';
export * from './errors/DatabaseError';
export { PrismaErrorMapper } from './errors/PrismaErrorMapper';
export {
  type DatabaseConfiguration,
  getDatabaseConfiguration,
} from './configuration/DatabaseConfiguration';
export { type PoolConfiguration, getPoolConfiguration } from './configuration/PoolConfiguration';
