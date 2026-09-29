import type { NotificationRepository } from '../../../../src/modules/notifications/repositories/notification.repository.js';
import type { DeviceRepository } from '../../../../src/modules/auth/repositories/device.repository.js';

/// In-memory doubles for the delivery job's two repositories, mirroring the
/// PostgreSQL semantics the real ones implement (and the integration suite
/// proves): plan binds once, claim is a compare-and-swap, finalize only moves a
/// QUEUED delivery, settle derives the notification status from its deliveries.

export interface FakeDevice {
  id: string;
  fcmToken: string | null;
  trustState?: 'REGISTERED' | 'TRUSTED' | 'SUSPICIOUS' | 'REVOKED';
}

export interface FakeDelivery {
  id: string;
  notificationId: string;
  channel: 'PUSH';
  deviceId: string | null;
  status: string;
  attempts: number;
  errorCode?: string | null;
}

export interface FakeNotification {
  id: string;
  userId: string;
  title: string | null;
  body: string | null;
  eventKey?: string | null;
  data: unknown;
  status: string;
}

export function deliveryFakes(opts: {
  /// Called with every finalize / release write, for suites that record their own shape.
  onDeliveryUpdate?: (id: string, fields: Record<string, unknown>) => void;
  /// Deliveries whose lease another worker holds: claims on them are refused
  /// while they stay QUEUED, as a live lease makes the real claim refuse.
  leasedElsewhere?: string[];
  notification: FakeNotification;
  deliveries: FakeDelivery[];
  devices: FakeDevice[];
}) {
  const notification = { ...opts.notification };
  const deliveries = opts.deliveries.map((d) => ({ ...d }));
  const devices = opts.devices.map((d) => ({ trustState: 'REGISTERED' as const, ...d }));
  const leasedElsewhere = new Set(opts.leasedElsewhere ?? []);
  /// Leases this fake handed out and that are still held: delivery id → attempt.
  const leases = new Map<string, number>();

  /// Every finalize / release write, flat: `{ id, ...fields }`.
  const deliveryUpdates: Array<Record<string, unknown>> = [];
  const record = (id: string, fields: Record<string, unknown>) => {
    deliveryUpdates.push({ id, ...fields });
    opts.onDeliveryUpdate?.(id, fields);
  };
  /// Every notification status change: `{ id, status }`.
  const notificationUpdates: Array<{ id: string; status: string }> = [];

  const withDevice = (d: FakeDelivery) => {
    const device = devices.find((x) => x.id === d.deviceId) ?? null;
    return {
      ...d,
      device: device
        ? { id: device.id, fcmToken: device.fcmToken, trustState: device.trustState }
        : null,
    };
  };

  const notificationRepository = {
    async findNotificationById(id: string) {
      return id === notification.id ? notification : null;
    },
    async planDeviceDeliveries(notificationId: string, deviceIds: string[]) {
      const mine = deliveries.filter((d) => d.notificationId === notificationId);
      const planned = mine.some((d) => d.deviceId !== null);
      const unbound = mine.find((d) => d.deviceId === null && d.status === 'QUEUED');
      const [first, ...rest] = deviceIds;
      if (!planned && unbound && first) {
        unbound.deviceId = first;
        for (const deviceId of rest) {
          deliveries.push({
            id: `del-${deliveries.length + 1}`,
            notificationId,
            channel: 'PUSH',
            deviceId,
            status: 'QUEUED',
            attempts: 0,
          });
        }
      }
      return deliveries.filter((d) => d.notificationId === notificationId).map(withDevice);
    },
    async findDeliveryById(id: string) {
      return deliveries.find((x) => x.id === id) ?? null;
    },
    async claimDelivery(id: string) {
      const d = deliveries.find((x) => x.id === id);
      if (!d || d.status !== 'QUEUED' || leasedElsewhere.has(id) || leases.has(id)) return null;
      d.attempts += 1;
      leases.set(id, d.attempts);
      return d.attempts;
    },
    async finalizeDelivery(id: string, input: Record<string, unknown>) {
      const d = deliveries.find((x) => x.id === id);
      if (!d || d.status !== 'QUEUED') return false;
      Object.assign(d, input);
      leases.delete(id);
      record(id, input);
      return true;
    },
    async releaseDelivery(id: string, attempt: number, errorCode: string, errorMessage: string) {
      const d = deliveries.find((x) => x.id === id);
      if (!d || d.status !== 'QUEUED' || d.attempts !== attempt) return false;
      d.errorCode = errorCode;
      leases.delete(id);
      record(id, { errorCode, errorMessage });
      return true;
    },
    async failQueuedDeliveries(notificationId: string, failureReason: string) {
      let count = 0;
      for (const d of deliveries) {
        if (d.notificationId === notificationId && d.status === 'QUEUED') {
          d.status = 'FAILED';
          record(d.id, { status: 'FAILED', failureReason });
          count += 1;
        }
      }
      return count;
    },
    async settleNotification(notificationId: string) {
      const mine = deliveries.filter((d) => d.notificationId === notificationId);
      if (mine.length === 0) return null;
      const anySent = mine.some((d) => d.status === 'SENT' || d.status === 'DELIVERED');
      const allTerminal = mine.every((d) => d.status !== 'QUEUED' && d.status !== 'PENDING');
      const target = anySent ? 'SENT' : allTerminal ? 'FAILED' : null;
      const allowed = anySent ? ['PENDING', 'QUEUED', 'FAILED'] : ['PENDING', 'QUEUED'];
      if (target && allowed.includes(notification.status)) {
        notification.status = target;
        notificationUpdates.push({ id: notificationId, status: target });
      }
      return target;
    },
  } as unknown as NotificationRepository;

  const deviceRepository = {
    async findDeliverableDevices(userId: string) {
      if (userId !== notification.userId) return [];
      const seen = new Set<string>();
      return devices
        .filter((d) => d.fcmToken && d.trustState !== 'REVOKED')
        .filter((d) => (seen.has(d.fcmToken!) ? false : (seen.add(d.fcmToken!), true)))
        .map((d) => ({ id: d.id, fcmToken: d.fcmToken! }));
    },
  } as unknown as DeviceRepository;

  return {
    leases,
    leasedElsewhere,
    notificationRepository,
    deviceRepository,
    deliveries,
    devices,
    notification,
    deliveryUpdates,
    notificationUpdates,
  };
}
