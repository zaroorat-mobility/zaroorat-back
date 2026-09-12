import { asClass, aliasTo, AwilixContainer } from 'awilix';
import { SubscriptionPlanRepository, DriverSubscriptionRepository } from './repositories/index.js';
import { SubscriptionService } from './services/index.js';
import { SubscriptionController } from './controllers/index.js';
import { SubscriptionPaymentConsumer } from './consumers/index.js';
import { SubscriptionExpiryJob } from './jobs/index.js';
export * from './controllers/index.js';
export * from './routes/index.js';
export * from './schemas/index.js';
export * from './services/index.js';
export * from './repositories/index.js';
export * from './consumers/index.js';
export * from './jobs/index.js';
export * from './errors/index.js';
export * from './types/index.js';

export function registerSubscriptionsModule(container: AwilixContainer): void {
  container.register({
    subscriptionPlanRepository: asClass(SubscriptionPlanRepository).singleton(),
    driverSubscriptionRepository: asClass(DriverSubscriptionRepository).singleton(),
    subscriptionService: asClass(SubscriptionService).singleton(),
    subscriptionController: asClass(SubscriptionController).singleton(),
    subscriptionPaymentConsumer: asClass(SubscriptionPaymentConsumer).singleton(),
    subscriptionExpiryJob: asClass(SubscriptionExpiryJob).singleton(),
    txManager: aliasTo('transactionManager'),
  });
}
