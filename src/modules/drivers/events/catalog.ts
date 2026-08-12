import type { PublishInput } from '@core/events/types.js';

export const DRIVER_PRODUCER = 'drivers';

export const DRIVER_EVENT_CATALOG = {
  ONBOARDED: 'driver.onboarded',
  VERIFIED: 'driver.verified',
  STATUS_CHANGED: 'driver.status_changed',
  SHIFT_STARTED: 'driver.shift_started',
  SHIFT_ENDED: 'driver.shift_ended',
  LOCATION_UPDATED: 'driver.location_updated',
  DOCUMENT_EXPIRED: 'driver.document_expired',
  SUSPENDED: 'driver.suspended',
} as const;

export function driverEvent(
  name: (typeof DRIVER_EVENT_CATALOG)[keyof typeof DRIVER_EVENT_CATALOG],
  aggregateId: string,
  data: Record<string, unknown>,
): PublishInput {
  return {
    producer: DRIVER_PRODUCER,
    type: name,
    classification:
      name.includes('verified') || name.includes('status_changed') || name.includes('suspended')
        ? 'audit'
        : 'domain',
    aggregateType: 'driver',
    aggregateId,
    data,
  };
}
