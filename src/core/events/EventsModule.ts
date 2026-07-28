import { asClass, AwilixContainer } from 'awilix';

import { OutboxRepository } from './OutboxRepository';
import { EventBus } from './EventBus';
import { EventPublisher } from './EventPublisher';
import { OutboxRelay } from './OutboxRelay';

/**
 * Registers the event infrastructure into the Awilix container.
 *
 * CLASSIC injection resolves by name (`outboxRepository`, `eventBus`,
 * `eventPublisher`, `outboxRelay`, `databaseService`). Must run after the
 * database module. `eventBus` is a singleton so publishers and subscribers share
 * one instance.
 * @param container The application DI container.
 */
export function registerEventsModule(container: AwilixContainer): void {
  container.register({
    outboxRepository: asClass(OutboxRepository).singleton(),
    eventBus: asClass(EventBus).singleton(),
    eventPublisher: asClass(EventPublisher).singleton(),
    outboxRelay: asClass(OutboxRelay).singleton(),
  });
}
