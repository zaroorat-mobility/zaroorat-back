import { container } from '../core/di.js';
import { OutboxRelay } from '@core/events';
import { logger } from '@shared/logger/index.js';

/**
 * Starts the transactional-outbox relay, which polls `outbox_events` and
 * dispatches durable domain events to the in-process bus (auth doc 06 §2).
 */
export async function bootstrapEvents(): Promise<void> {
  const relay = container.resolve<OutboxRelay>('outboxRelay');
  relay.start();
  logger.info('Outbox relay started');
}
