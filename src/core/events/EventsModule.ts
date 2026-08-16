import { asClass, AwilixContainer } from 'awilix';
import { OutboxRepository } from './OutboxRepository';
import { EventBus } from './EventBus';
import { EventPublisher } from './EventPublisher';
import { OutboxRelay } from './OutboxRelay';
import { OutboxMetrics } from './OutboxMetrics';
export function registerEventsModule(container: AwilixContainer): void {
  container.register({
    outboxRepository: asClass(OutboxRepository).singleton(),
    eventBus: asClass(EventBus).singleton(),
    eventPublisher: asClass(EventPublisher).singleton(),
    outboxRelay: asClass(OutboxRelay).singleton(),
    outboxMetrics: asClass(OutboxMetrics).singleton(),
  });
}
