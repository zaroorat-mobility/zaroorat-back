import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { NotificationService } from '@modules/notifications';
import { DeviceRepository } from '@modules/auth/repositories/device.repository.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { logger } from '@shared/logger/index.js';
import { RideRepository } from '../repositories/ride.repository.js';
import { RIDE_EVENT_CATALOG } from '../events/catalog.js';
/// Every one of these events was already published — none of them had a
/// consumer. This is the delivery half of the P1 finding "FCM tokens are
/// collected and never read": it's the first and only reader of them.
/// Delivery itself still goes through MockPushProvider (see
/// notification.config.ts) until a real provider is configured — this class
/// only owns *when* to notify, not *how* the bytes reach a device.
export class RideNotificationConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly rideRepo: RideRepository,
    private readonly driverRepository: DriverRepository,
    private readonly deviceRepository: DeviceRepository,
    private readonly notificationService: NotificationService,
  ) {}
  register(): Unsubscribe {
    const unsubscribes = [
      this.eventBus.on(RIDE_EVENT_CATALOG.DISPATCH_OFFERED, (e) => this.onDispatchOffered(e)),
      this.eventBus.on(RIDE_EVENT_CATALOG.ACCEPTED, (e) =>
        this.onRideEvent(
          e,
          'Driver assigned',
          'Your driver is on the way to your pickup location.',
        ),
      ),
      this.eventBus.on(RIDE_EVENT_CATALOG.DRIVER_ARRIVING, (e) =>
        this.onRideEvent(e, 'Your driver is on the way', 'Your driver has started heading to you.'),
      ),
      this.eventBus.on(RIDE_EVENT_CATALOG.DRIVER_ARRIVED, (e) =>
        this.onRideEvent(
          e,
          'Your driver has arrived',
          'Your driver is waiting at the pickup point.',
        ),
      ),
      this.eventBus.on(RIDE_EVENT_CATALOG.STARTED, (e) =>
        this.onRideEvent(e, 'Trip started', 'Your trip is now in progress.'),
      ),
      this.eventBus.on(RIDE_EVENT_CATALOG.COMPLETED, (e) => this.onCompleted(e)),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }
  private async onDispatchOffered(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { driverId?: string };
    if (!data.driverId) return;
    await this.pushToDriver(
      data.driverId,
      'New ride request',
      'A ride is nearby — open the app to accept.',
      envelope,
    );
  }
  private async onRideEvent(envelope: EventEnvelope, title: string, body: string): Promise<void> {
    const data = envelope.data as { rideId?: string };
    if (!data.rideId) return;
    await this.pushToRideCustomer(data.rideId, title, body, envelope);
  }
  private async onCompleted(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { rideId?: string; totalFare?: number };
    if (!data.rideId) return;
    const fareText =
      typeof data.totalFare === 'number' ? ` Fare: ₹${data.totalFare.toFixed(2)}.` : '';
    await this.pushToRideCustomer(
      data.rideId,
      'Trip completed',
      `You have arrived at your destination.${fareText}`,
      envelope,
    );
  }
  /// The de-duplication key. `RideRealtimeConsumer` puts this same outbox event
  /// id on the socket message for the same domain fact, so a driver whose app
  /// was backgrounded during an offer — and therefore got both a push and, on
  /// reconnect, the socket event — can tell they are one thing rather than two.
  private dedupeData(envelope: EventEnvelope): Record<string, string> {
    return { eventId: envelope.eventId, eventType: envelope.type };
  }
  private async pushToDriver(
    driverId: string,
    title: string,
    body: string,
    envelope: EventEnvelope,
  ): Promise<void> {
    try {
      const driver = await this.driverRepository.findById(driverId);
      if (!driver) return;
      await this.pushToUser(driver.userId, title, body, envelope);
    } catch (err) {
      logger.warn({ err, driverId }, '[rides] failed to push-notify driver');
    }
  }
  private async pushToRideCustomer(
    rideId: string,
    title: string,
    body: string,
    envelope: EventEnvelope,
  ): Promise<void> {
    try {
      const ride = await this.rideRepo.findById(rideId);
      if (!ride) return;
      await this.pushToUser(ride.customerId, title, body, envelope);
    } catch (err) {
      logger.warn({ err, rideId }, '[rides] failed to push-notify customer');
    }
  }
  private async pushToUser(
    userId: string,
    title: string,
    body: string,
    envelope: EventEnvelope,
  ): Promise<void> {
    const fcmToken = await this.deviceRepository.findLatestFcmToken(userId);
    if (!fcmToken) return;
    await this.notificationService.sendPush(fcmToken, title, body, this.dedupeData(envelope));
  }
}
