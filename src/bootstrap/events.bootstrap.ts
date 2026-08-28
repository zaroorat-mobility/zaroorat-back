import { container } from '../core/di.js';
import { OutboxRelay } from '@core/events';
import type { Unsubscribe } from '@core/events';
import type { EpochInvalidationConsumer, AuthDriverVerifiedConsumer } from '@modules/auth';
import type {
  RideRequestedConsumer,
  RideNotificationConsumer,
  RideRealtimeConsumer,
} from '@modules/rides';
import type { RideCollectionConsumer } from '@modules/payments';
import type {
  ReferralRideCompletedConsumer,
  ReferralDriverVerifiedConsumer,
} from '@modules/referrals/consumers/index.js';
import { logger } from '@shared/logger/index.js';

const CONSUMER_KEYS = [
  'epochInvalidationConsumer',
  'authDriverVerifiedConsumer',
  'rideRequestedConsumer',
  'rideNotificationConsumer',
  'rideRealtimeConsumer',
  'rideCollectionConsumer',
  'referralRideCompletedConsumer',
  'referralDriverVerifiedConsumer',
] as const;

type Consumer =
  | EpochInvalidationConsumer
  | AuthDriverVerifiedConsumer
  | RideRequestedConsumer
  | RideNotificationConsumer
  | RideRealtimeConsumer
  | RideCollectionConsumer
  | ReferralRideCompletedConsumer
  | ReferralDriverVerifiedConsumer;

/// Subscribing consumers to the in-process bus, and nothing else.
///
/// This used to be inseparable from starting the outbox relay's polling loop,
/// which is why no integration test could ever exercise a consumer: the harness
/// boots with `createApp()` and calling `bootstrapEvents()` would have started a
/// background timer the tests then had to fight. Subscription is pure — it opens
/// no sockets, starts no timers, touches no queue — so tests can call this and
/// drive the relay by hand with `processBatch()`.
///
/// Returns an unsubscribe handle so a test (or a reload) can tear the
/// subscriptions down again without leaking listeners between suites.
export function registerEventConsumers(): Unsubscribe {
  const unsubscribes = CONSUMER_KEYS.map((key) => container.resolve<Consumer>(key).register());
  logger.info({ consumers: CONSUMER_KEYS.length }, 'Event subscribers registered');
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}

/// Production wiring: subscribe, then start the relay that actually pumps
/// committed outbox rows onto the bus. Only `startup()` calls this.
export async function bootstrapEvents(): Promise<void> {
  registerEventConsumers();
  const relay = container.resolve<OutboxRelay>('outboxRelay');
  relay.start();
  logger.info('Outbox relay started');
}
