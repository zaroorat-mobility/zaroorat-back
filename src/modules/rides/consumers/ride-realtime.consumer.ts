import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { RealtimeGateway } from '@modules/realtime/realtime.gateway.js';
import {
  SOCKET_EVENT,
  room,
  socketEnvelope,
  type SocketEventName,
} from '@modules/realtime/events.js';
import { RideRepository } from '../repositories/ride.repository.js';
import { RIDE_EVENT_CATALOG } from '../events/catalog.js';
import { PAYMENT_EVENT_CATALOG } from '@modules/payments/events/catalog.js';

/// Ride-scoped domain events, and the client event each becomes. Every one of
/// these carries a `rideId`, so the bridge can resolve the participants from the
/// ride row rather than trusting anything in the payload.
///
/// `terminal` closes the ride room after the emit: once a ride is over, nobody
/// should still be admitted to its room streaming a position into it.
const RIDE_EVENTS: Record<string, { socketEvent: SocketEventName; terminal?: boolean }> = {
  [RIDE_EVENT_CATALOG.ACCEPTED]: { socketEvent: SOCKET_EVENT.DRIVER_ASSIGNED },
  [RIDE_EVENT_CATALOG.DRIVER_ARRIVING]: { socketEvent: SOCKET_EVENT.DRIVER_ARRIVING },
  [RIDE_EVENT_CATALOG.DRIVER_ARRIVED]: { socketEvent: SOCKET_EVENT.DRIVER_ARRIVED },
  [RIDE_EVENT_CATALOG.STARTED]: { socketEvent: SOCKET_EVENT.RIDE_STARTED },
  [RIDE_EVENT_CATALOG.COMPLETED]: { socketEvent: SOCKET_EVENT.RIDE_COMPLETED, terminal: true },
  [RIDE_EVENT_CATALOG.CANCELLED]: { socketEvent: SOCKET_EVENT.RIDE_CANCELLED, terminal: true },
  // Collection outcomes land here rather than being emitted from the payment
  // service, so a client message is impossible to send for a charge that
  // rolled back. Not terminal: the ride room stays open because a failed
  // collection can still be retried and settled.
  [PAYMENT_EVENT_CATALOG.RIDE_COLLECTED]: { socketEvent: SOCKET_EVENT.PAYMENT_SETTLED },
  [PAYMENT_EVENT_CATALOG.RIDE_COLLECTION_FAILED]: { socketEvent: SOCKET_EVENT.PAYMENT_FAILED },
};

/// Offer-scoped domain events. These carry a `driverId` and no ride yet, so they
/// go to that driver's own room and nowhere else — an offer is not public, not
/// even to the customer who caused it.
const OFFER_EVENTS: Record<string, SocketEventName> = {
  [RIDE_EVENT_CATALOG.DISPATCH_OFFERED]: SOCKET_EVENT.OFFER_RECEIVED,
  [RIDE_EVENT_CATALOG.DISPATCH_REJECTED]: SOCKET_EVENT.OFFER_REJECTED,
  [RIDE_EVENT_CATALOG.DISPATCH_EXPIRED]: SOCKET_EVENT.OFFER_EXPIRED,
};

/// The outbox → socket bridge, and the only thing in the platform that turns a
/// domain fact into a client message.
///
/// Domain services never touch the gateway: they publish inside their
/// transaction, the relay delivers the committed row to the bus, and this
/// consumer decides who is allowed to hear about it. That ordering is what makes
/// a client message impossible to send for work that rolled back.
export class RideRealtimeConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly rideRepository: RideRepository,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  register(): Unsubscribe {
    const unsubscribes = [
      this.eventBus.on(RIDE_EVENT_CATALOG.REQUESTED, (e) => this.onRideRequested(e)),
      ...Object.keys(OFFER_EVENTS).map((type) =>
        this.eventBus.on(type, (e) => this.onOfferEvent(type, e)),
      ),
      ...Object.keys(RIDE_EVENTS).map((type) =>
        this.eventBus.on(type, (e) => this.onRideEvent(type, e)),
      ),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }

  /// The customer's own confirmation that the search started. Goes to their user
  /// room: there is no ride yet, so there is no ride room to use.
  private onRideRequested(envelope: EventEnvelope): void {
    const customerId = envelope.data.customerId;
    if (typeof customerId !== 'string') return;
    this.realtimeGateway.emitToRoom(
      room.user(customerId),
      this.envelopeFor(envelope, SOCKET_EVENT.RIDE_REQUESTED, {
        requestId: envelope.data.requestId ?? null,
        vehicleTypeId: envelope.data.vehicleTypeId ?? null,
        quotedFare: envelope.data.quotedFare ?? null,
      }),
    );
  }

  private onOfferEvent(type: string, envelope: EventEnvelope): void {
    const socketEvent = OFFER_EVENTS[type];
    const driverId = envelope.data.driverId;
    if (!socketEvent || typeof driverId !== 'string') return;
    this.realtimeGateway.emitToRoom(
      room.driver(driverId),
      this.envelopeFor(envelope, socketEvent, {
        dispatchId: envelope.data.dispatchId ?? null,
        requestId: envelope.data.requestId ?? null,
        expiresAt: envelope.data.expiresAt ?? null,
        ...(envelope.data.reason !== undefined ? { reason: envelope.data.reason } : {}),
      }),
    );
  }

  private async onRideEvent(type: string, envelope: EventEnvelope): Promise<void> {
    const mapping = RIDE_EVENTS[type];
    const rideId = envelope.data.rideId;
    if (!mapping || typeof rideId !== 'string') return;

    // The envelope carries neither an aggregate id nor a subject user (see
    // `EventPublisher.buildEnvelope`), so the participants are read from the
    // ride itself — which is the authoritative answer anyway, and cheap: a
    // handful of these exist per ride, unlike location frames.
    const ride = await this.rideRepository.findById(rideId);
    if (!ride) {
      logger.warn({ rideId, type }, '[realtime] ride event referenced a ride that is gone');
      return;
    }

    // One emit across three rooms: socket.io unions them, so a customer who is
    // in both their user room and the ride room receives the message once.
    // Addressing the user and driver rooms as well as the ride room is what
    // closes the join race — a customer learns their rideId *from*
    // `ride.driver.assigned`, so at that instant they are not in the ride room
    // yet, and every later event still reaches them if they never join.
    const rooms = [room.ride(rideId), room.user(ride.customerId), room.driver(ride.driverId)];
    this.realtimeGateway.emitToRoom(
      rooms,
      this.envelopeFor(envelope, mapping.socketEvent, {
        rideId,
        status: ride.status,
        driverId: ride.driverId,
        customerId: ride.customerId,
        ...(envelope.data.cancelledBy !== undefined
          ? { cancelledBy: envelope.data.cancelledBy }
          : {}),
        ...(envelope.data.totalFare !== undefined ? { totalFare: envelope.data.totalFare } : {}),
      }),
    );

    if (mapping.terminal) {
      await this.realtimeGateway.closeRideRoom(rideId);
    }
  }

  /// Carries the outbox row's `eventId` straight through to the client. That is
  /// the de-duplication key: the same domain fact can reach a driver over the
  /// socket *and* as a push notification (`RideNotificationConsumer` listens to
  /// the same events), and this is how the app knows they are one thing.
  private envelopeFor(
    envelope: EventEnvelope,
    socketEvent: SocketEventName,
    data: Record<string, unknown>,
  ) {
    return socketEnvelope(envelope.eventId, socketEvent, data, new Date(envelope.occurredAt));
  }
}
