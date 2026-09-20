import type { NotificationPriority } from '../../../generated/prisma';

export interface PriorityMapping {
  bullMqPriority: number; // 1 (highest) to 10 (lowest)
  prismaPriority: NotificationPriority;
}

const EVENT_PRIORITY_MAP: Record<string, PriorityMapping> = {
  // HIGH Priority (1) - Time-sensitive operational ride events
  'ride.dispatch.offered': { bullMqPriority: 1, prismaPriority: 'HIGH' },
  'ride.accepted': { bullMqPriority: 1, prismaPriority: 'HIGH' },
  'ride.driver_arrived': { bullMqPriority: 1, prismaPriority: 'HIGH' },
  'ride.cancelled': { bullMqPriority: 1, prismaPriority: 'HIGH' },
  'sos.alert': { bullMqPriority: 1, prismaPriority: 'CRITICAL' },

  // NORMAL Priority (2) - Standard status updates & payment receipts
  'ride.driver_arriving': { bullMqPriority: 2, prismaPriority: 'NORMAL' },
  'ride.started': { bullMqPriority: 2, prismaPriority: 'NORMAL' },
  'ride.completed': { bullMqPriority: 2, prismaPriority: 'NORMAL' },
  'ride.request.expired': { bullMqPriority: 2, prismaPriority: 'NORMAL' },
  'payment.ride.collected': { bullMqPriority: 2, prismaPriority: 'NORMAL' },
  'payment.ride.collection_failed': { bullMqPriority: 2, prismaPriority: 'NORMAL' },

  // LOW Priority (3) - Marketing & promotions
  'promotional.broadcast': { bullMqPriority: 3, prismaPriority: 'LOW' },
};

export function resolveNotificationPriority(eventKey?: string | null): PriorityMapping {
  if (eventKey && EVENT_PRIORITY_MAP[eventKey]) {
    return EVENT_PRIORITY_MAP[eventKey];
  }
  return { bullMqPriority: 2, prismaPriority: 'NORMAL' };
}
