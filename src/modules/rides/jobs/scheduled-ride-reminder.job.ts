import { RedisService } from '@core/cache/RedisService.js';
import { EventPublisher } from '@core/events';
import { RealtimeGateway } from '@modules/realtime/realtime.gateway.js';
import { SOCKET_EVENT, room, socketEnvelope } from '@modules/realtime/events.js';
import { logger } from '@shared/logger/index.js';
import { uuidV7 } from '@shared/crypto';
import { ScheduledRideService } from '../services/scheduled/scheduled-ride.service.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../events/catalog.js';

export class ScheduledRideReminderJob {
  constructor(
    private readonly redis: RedisService,
    private readonly scheduledRideService: ScheduledRideService,
    private readonly eventPublisher: EventPublisher,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  async run(now: Date = new Date()): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:scheduled_ride_reminder', 15000);
    if (!lockToken) return 0;
    let sent = 0;
    try {
      const claimed = await this.scheduledRideService.claimDueReminders(now);
      for (const row of claimed) {
        const eventId = uuidV7();
        await this.eventPublisher.publish(
          rideEvent(RIDE_EVENT_CATALOG.SCHEDULED_REMINDER, row.id, {
            scheduledRideId: row.id,
            driverId: row.driverId,
            customerId: row.customerId,
            scheduledFor: row.scheduledFor.toISOString(),
          }),
        );
        const envelope = socketEnvelope(eventId, SOCKET_EVENT.SCHEDULED_REMINDER, {
          scheduledRideId: row.id,
          driverId: row.driverId,
          customerId: row.customerId,
          scheduledFor: row.scheduledFor.toISOString(),
        });
        if (row.driverId) {
          this.realtimeGateway.emitToRoom(room.driver(row.driverId), envelope);
        }
        this.realtimeGateway.emitToRoom(room.user(row.customerId), envelope);
        sent++;
      }
    } catch (err) {
      logger.error({ err }, 'Error running scheduled ride reminder job');
    } finally {
      await this.redis.lock.release('job:scheduled_ride_reminder', lockToken);
    }
    return sent;
  }
}
