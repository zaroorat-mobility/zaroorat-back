import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { EpochService } from '../services/token/epoch.service';
const EPOCH_INVALIDATING = new Set([
  'account.role.granted',
  'account.role.revoked',
  'account.suspended',
  'auth.refresh.reuse_detected',
]);
export class EpochInvalidationConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly epochService: EpochService,
  ) {}
  register(): Unsubscribe {
    const unsubscribes = [...EPOCH_INVALIDATING].map((type) =>
      this.eventBus.on(type, (envelope) => this.handle(envelope)),
    );
    return () => unsubscribes.forEach((off) => off());
  }
  private async handle(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { userId?: string; initialGrant?: boolean } | undefined;
    // The default role granted while the account is being created is not a
    // privilege change against any existing session — there are none — and
    // bumping for it invalidated the very tokens registration had just issued.
    if (data?.initialGrant === true) return;
    const userId = envelope.subject?.userId ?? data?.userId;
    if (!userId) {
      logger.warn(
        { eventId: envelope.eventId, type: envelope.type },
        '[auth] epoch-invalidating event carried no subject user',
      );
      return;
    }
    const epoch = await this.epochService.bump(userId);
    logger.info(
      { eventId: envelope.eventId, type: envelope.type, userId, epoch },
      '[auth] session epoch bumped',
    );
  }
}
