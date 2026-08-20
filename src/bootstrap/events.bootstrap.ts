import { container } from '../core/di.js';
import { OutboxRelay } from '@core/events';
import type { EpochInvalidationConsumer } from '@modules/auth';
import { logger } from '@shared/logger/index.js';
export async function bootstrapEvents(): Promise<void> {
  container.resolve<EpochInvalidationConsumer>('epochInvalidationConsumer').register();
  logger.info('Event subscribers registered');
  const relay = container.resolve<OutboxRelay>('outboxRelay');
  relay.start();
  logger.info('Outbox relay started');
}
