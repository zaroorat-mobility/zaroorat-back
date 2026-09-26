import type { PublishInput } from '@core/events/types.js';
export const RIDE_PRODUCER = 'rides';
export const RIDE_EVENT_CATALOG = {
  REQUESTED: 'ride.requested',
  REQUEST_ABANDONED: 'ride.request.abandoned',
  /// Nobody accepted before the request aged out. The rider's search is over,
  /// and this is the only thing that tells them so.
  REQUEST_EXPIRED: 'ride.request.expired',
  DISPATCH_OFFERED: 'ride.dispatch.offered',
  DISPATCH_REJECTED: 'ride.dispatch.rejected',
  DISPATCH_EXPIRED: 'ride.dispatch.expired',
  ACCEPTED: 'ride.accepted',
  DRIVER_ARRIVING: 'ride.driver_arriving',
  DRIVER_ARRIVED: 'ride.driver_arrived',
  STARTED: 'ride.started',
  COMPLETED: 'ride.completed',
  CANCELLED: 'ride.cancelled',
  SCHEDULED_ACCEPTED: 'ride.scheduled.accepted',
  SCHEDULED_DECLINED: 'ride.scheduled.declined',
  SCHEDULED_REMINDER: 'ride.scheduled.reminder',
  SCHEDULED_CREATED: 'ride.scheduled.created',
  SCHEDULED_CANCELLED: 'ride.scheduled.cancelled',
  REQUEST_BOOSTED: 'ride.request.boosted',
  DESTINATION_CHANGED: 'ride.destination_changed',
  SOS_TRIGGERED: 'ride.sos.triggered',
} as const;
export function rideEvent(
  name: (typeof RIDE_EVENT_CATALOG)[keyof typeof RIDE_EVENT_CATALOG],
  aggregateId: string,
  data: Record<string, unknown>,
): PublishInput {
  return {
    producer: RIDE_PRODUCER,
    type: name,
    classification:
      name.includes('completed') ||
      name.includes('started') ||
      name.includes('accepted') ||
      name.includes('cancelled')
        ? 'audit'
        : 'domain',
    aggregateType: 'ride',
    aggregateId,
    data,
  };
}
