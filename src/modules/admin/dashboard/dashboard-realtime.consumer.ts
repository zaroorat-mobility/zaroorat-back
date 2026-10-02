import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { RealtimeGateway } from '@modules/realtime/realtime.gateway.js';
import {
  SOCKET_EVENT,
  room,
  socketEnvelope,
  type SocketEventName,
} from '@modules/realtime/events.js';
import { RIDE_EVENT_CATALOG } from '@modules/rides/events/catalog.js';
import { DRIVER_EVENT_CATALOG } from '@modules/drivers/events/catalog.js';
import { PAYMENT_EVENT_CATALOG } from '@modules/payments/events/catalog.js';

type Hint = { socketEvent: SocketEventName; idField: string; fields: Record<string, string> };

/// Operational domain events → the hint the ops dashboard room hears. Only
/// events that change a dashboard number are bridged (arriving / arrived /
/// started move nothing the dashboard counts). The hint carries the entity id
/// and the transition — never the fare, the customer, a reason or a position.
const OPS_HINTS: Record<string, Hint> = {
  [RIDE_EVENT_CATALOG.ACCEPTED]: {
    socketEvent: SOCKET_EVENT.DASHBOARD_RIDE_CHANGED,
    idField: 'rideId',
    fields: { status: 'ACCEPTED' },
  },
  [RIDE_EVENT_CATALOG.COMPLETED]: {
    socketEvent: SOCKET_EVENT.DASHBOARD_RIDE_CHANGED,
    idField: 'rideId',
    fields: { status: 'COMPLETED' },
  },
  [RIDE_EVENT_CATALOG.CANCELLED]: {
    socketEvent: SOCKET_EVENT.DASHBOARD_RIDE_CHANGED,
    idField: 'rideId',
    fields: { status: 'CANCELLED' },
  },
  [RIDE_EVENT_CATALOG.REQUESTED]: {
    socketEvent: SOCKET_EVENT.DASHBOARD_RIDE_REQUEST_CHANGED,
    idField: 'requestId',
    fields: { status: 'SEARCHING' },
  },
  [RIDE_EVENT_CATALOG.REQUEST_EXPIRED]: {
    socketEvent: SOCKET_EVENT.DASHBOARD_RIDE_REQUEST_CHANGED,
    idField: 'requestId',
    fields: { status: 'EXPIRED' },
  },
  [RIDE_EVENT_CATALOG.REQUEST_ABANDONED]: {
    socketEvent: SOCKET_EVENT.DASHBOARD_RIDE_REQUEST_CHANGED,
    idField: 'requestId',
    fields: { status: 'ABANDONED' },
  },
  [DRIVER_EVENT_CATALOG.ONBOARDED]: {
    socketEvent: SOCKET_EVENT.DASHBOARD_DRIVER_REGISTRATION_CHANGED,
    idField: 'driverId',
    fields: { change: 'ONBOARDED' },
  },
  [DRIVER_EVENT_CATALOG.VERIFIED]: {
    socketEvent: SOCKET_EVENT.DASHBOARD_DRIVER_REGISTRATION_CHANGED,
    idField: 'driverId',
    fields: { change: 'VERIFIED' },
  },
};

/// `driver.status_changed` is published only for ONLINE and OFFLINE
/// (`status.service.ts`); ON_TRIP arrives as `ride.accepted`.
const DRIVER_STATUSES = new Set(['ONLINE', 'OFFLINE']);

/// Events that post platform ledger legs or change gross ride value. The
/// finance room hears only that something moved, with no data at all.
const FINANCE_EVENTS = [
  RIDE_EVENT_CATALOG.COMPLETED,
  PAYMENT_EVENT_CATALOG.RIDE_COLLECTED,
  PAYMENT_EVENT_CATALOG.DRIVER_SUBSCRIPTION_PAYMENT_COMPLETED,
  PAYMENT_EVENT_CATALOG.REFUND_PROCESSED,
];

/// Outbox → admin dashboard bridge. Runs beside `RideRealtimeConsumer` on the
/// same committed events, so a hint is never sent for work that rolled back.
/// Rooms are joined only through `dashboard.subscribe`, which checks
/// `operations:read` / `finance:read` server-side.
export class DashboardRealtimeConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  register(): Unsubscribe {
    const unsubscribes = [
      ...Object.keys(OPS_HINTS).map((type) =>
        this.eventBus.on(type, (e) => this.onOpsEvent(type, e)),
      ),
      this.eventBus.on(DRIVER_EVENT_CATALOG.STATUS_CHANGED, (e) => this.onDriverStatus(e)),
      ...FINANCE_EVENTS.map((type) => this.eventBus.on(type, (e) => this.onFinanceEvent(e))),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }

  private onOpsEvent(type: string, envelope: EventEnvelope): void {
    const hint = OPS_HINTS[type];
    const id = hint ? envelope.data[hint.idField] : undefined;
    if (!hint || typeof id !== 'string') return;
    this.emit(room.opsDashboard(), envelope, hint.socketEvent, {
      [hint.idField]: id,
      ...hint.fields,
    });
  }

  private onDriverStatus(envelope: EventEnvelope): void {
    const { driverId, status } = envelope.data;
    if (typeof driverId !== 'string' || typeof status !== 'string' || !DRIVER_STATUSES.has(status))
      return;
    this.emit(room.opsDashboard(), envelope, SOCKET_EVENT.DASHBOARD_DRIVER_STATUS_CHANGED, {
      driverId,
      status,
    });
  }

  private onFinanceEvent(envelope: EventEnvelope): void {
    this.emit(room.financeDashboard(), envelope, SOCKET_EVENT.DASHBOARD_FINANCIALS_CHANGED, {});
  }

  /// The outbox `eventId` is carried through, as the ride bridge does, so a
  /// client can discard a hint it has already applied.
  private emit(
    roomName: string,
    envelope: EventEnvelope,
    socketEvent: SocketEventName,
    data: Record<string, unknown>,
  ): void {
    this.realtimeGateway.emitToRoom(
      roomName,
      socketEnvelope(envelope.eventId, socketEvent, data, new Date(envelope.occurredAt)),
    );
  }
}
