import { container } from '../core/di.js';
import { OutboxRelay } from '@core/events';
import type { EpochInvalidationConsumer, AuthDriverVerifiedConsumer } from '@modules/auth';
import type { RideRequestedConsumer, RideNotificationConsumer } from '@modules/rides';
import { logger } from '@shared/logger/index.js';
export async function bootstrapEvents(): Promise<void> {
  container.resolve<EpochInvalidationConsumer>('epochInvalidationConsumer').register();
  container.resolve<AuthDriverVerifiedConsumer>('authDriverVerifiedConsumer').register();
  container.resolve<RideRequestedConsumer>('rideRequestedConsumer').register();
  container.resolve<RideNotificationConsumer>('rideNotificationConsumer').register();
  logger.info('Event subscribers registered');
  const relay = container.resolve<OutboxRelay>('outboxRelay');
  relay.start();
  logger.info('Outbox relay started');
}
