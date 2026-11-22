import { logger } from '@shared/logger/index.js';
import type { RideLocationHistoryService } from '@modules/location/services/ride-location-history.service.js';

export async function purgeRideLocationHistory(
  rideLocationHistoryService: RideLocationHistoryService,
): Promise<void> {
  const removed = await rideLocationHistoryService.purgeExpired();
  if (removed > 0) {
    logger.info({ removed }, '[jobs] purged expired ride location breadcrumbs');
  }
}
