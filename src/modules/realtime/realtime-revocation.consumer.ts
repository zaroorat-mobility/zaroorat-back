import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { EPOCH_INVALIDATING } from '@modules/auth/consumers/epoch-invalidation.consumer.js';
import { DRIVER_EVENT_CATALOG } from '@modules/drivers/events/catalog.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { room } from './events.js';

/// Ends realtime access when the authentication behind it ends. A socket's token
/// is checked at the handshake and its session before every command
/// (`SocketAuthService.revalidate`); this covers what an idle socket would still
/// *hear* in its rooms. Each revocation disconnects the affected sockets
/// server-side, and a reconnect is authenticated from scratch — epoch, session,
/// roles, driver operability, then database permissions on subscribe — so no
/// room granted before the revocation survives it.
export class RealtimeRevocationConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  register(): Unsubscribe {
    const unsubscribes = [
      // Exactly the events that retire a user's tokens: their sockets end with them.
      ...[...EPOCH_INVALIDATING].map((type) =>
        this.eventBus.on(type, (e) => this.onUserTokensRetired(e)),
      ),
      // logout, logoutAll, password reset, staff removal, deactivation, cap eviction.
      this.eventBus.on('auth.session.revoked', (e) => this.onSessionRevoked(e)),
      // A suspension that leaves the session alone still ends the driver identity.
      this.eventBus.on(DRIVER_EVENT_CATALOG.SUSPENDED, (e) => this.onDriverSuspended(e)),
      this.eventBus.on('auth.role.permissions_changed', () =>
        this.realtimeGateway.reauthorizeDashboardRooms(),
      ),
    ];
    return () => unsubscribes.forEach((off) => off());
  }

  private onUserTokensRetired(envelope: EventEnvelope): void {
    // Mirrors EpochInvalidationConsumer: registration's default role retires nothing.
    if (envelope.data.initialGrant === true) return;
    const userId = envelope.subject?.userId ?? envelope.data.userId;
    if (typeof userId === 'string') this.realtimeGateway.disconnectRooms(room.user(userId));
  }

  private onSessionRevoked(envelope: EventEnvelope): void {
    const sessionId = envelope.data.sessionId;
    if (typeof sessionId === 'string')
      this.realtimeGateway.disconnectRooms(room.session(sessionId));
  }

  private onDriverSuspended(envelope: EventEnvelope): void {
    const driverId = envelope.data.driverId;
    if (typeof driverId === 'string') this.realtimeGateway.disconnectRooms(room.driver(driverId));
  }
}
