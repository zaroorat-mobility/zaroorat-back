import { asClass, asFunction, AwilixContainer } from 'awilix';
import { DatabaseService } from './DatabaseService';
import { PrismaClientProvider } from './client/PrismaClientProvider';
import { PrismaClientFactory } from './client/PrismaClientFactory';
import { TransactionManager } from './TransactionManager';
import { RetryService } from './retry/RetryService';
import { DatabaseMetrics } from './monitoring/DatabaseMetrics';
import { getDatabaseConfiguration } from './configuration/DatabaseConfiguration';
import { getPoolConfiguration } from './configuration/PoolConfiguration';
export function registerDatabaseModule(container: AwilixContainer) {
  container.register({
    dbConfig: asFunction(getDatabaseConfiguration).singleton(),
    poolConfig: asFunction(getPoolConfiguration).singleton(),
    databaseMetrics: asClass(DatabaseMetrics).singleton(),
    retryService: asClass(RetryService).singleton(),
    factory: asClass(PrismaClientFactory).singleton(),
    provider: asClass(PrismaClientProvider).singleton(),
    transactionManager: asClass(TransactionManager).singleton(),
    databaseService: asClass(DatabaseService).singleton(),
  });
}
