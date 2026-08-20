import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { AuthService } from '../services/auth.service';
export class AuthDriverVerifiedConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly authService: AuthService,
  ) {}
  register(): Unsubscribe {
    return this.eventBus.on('driver.verified', (envelope) => this.handle(envelope));
  }
  private async handle(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { userId?: string; approvedBy?: string };
    if (!data.userId) {
      logger.warn(
        { eventId: envelope.eventId, type: envelope.type },
        '[auth] driver.verified event carried no userId',
      );
      return;
    }
    await this.authService.grantRole(data.userId, 'driver', {
      grantedBy: data.approvedBy ?? null,
    });
    logger.info(
      { eventId: envelope.eventId, userId: data.userId },
      '[auth] driver role granted from driver.verified event',
    );
  }
}
