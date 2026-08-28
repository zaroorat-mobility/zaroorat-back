import { TransactionManager } from '@core/database';
import { DriverRepository } from '../../drivers/repositories/driver.repository.js';
import { RideRepository } from '../../rides/repositories/ride.repository.js';
import { RatingRepository, type RatedByRole } from '../repositories/rating.repository.js';
import {
  RideNotFoundError,
  RideDriverMismatchError,
  RideCustomerMismatchError,
  RideNotRatableError,
  AlreadyRatedError,
} from '../../rides/errors/ride.errors.js';
import { ridePartyIds } from '../../rides/types/ride-party.js';
import type { RideRating } from '../../rides/types/index.js';
export class RatingService {
  constructor(
    private readonly rideRepo: RideRepository,
    private readonly ratingRepo: RatingRepository,
    private readonly driverRepository: DriverRepository,
    private readonly txManager: TransactionManager,
  ) {}
  async submitRating(
    rideId: string,
    ratedBy: RatedByRole,
    actorId: string,
    rating: number,
    tags?: string[],
    comment?: string,
  ): Promise<RideRating> {
    const ride = await this.rideRepo.findById(rideId);
    if (!ride) throw new RideNotFoundError(rideId);
    if (ratedBy === 'CUSTOMER' && ride.customerId !== actorId) {
      throw new RideCustomerMismatchError(rideId);
    }
    if (ratedBy === 'DRIVER' && ridePartyIds(ride).driverUserId !== actorId) {
      throw new RideDriverMismatchError(rideId);
    }
    if (ride.status !== 'COMPLETED') {
      throw new RideNotRatableError(ride.status);
    }
    const existing = await this.ratingRepo.findByRideAndRater(rideId, ratedBy);
    if (existing) throw new AlreadyRatedError();
    return this.txManager.execute(async (tx) => {
      const created = await this.ratingRepo.create(
        {
          rideId,
          ratedBy,
          rating,
          ...(tags !== undefined ? { tags } : {}),
          ...(comment !== undefined ? { comment } : {}),
        },
        tx,
      );
      // In the same transaction as the rating that caused it: a star recorded
      // without moving the average is a rating the platform took and did not
      // count, and the driver's profile would keep reporting the 5.00 it was
      // created with. `Driver.rating` was written by nothing at all before this.
      //
      // Only a customer's rating moves a driver's score. A driver rating a
      // customer still goes nowhere — there is no column for it anywhere in the
      // schema, so that half stays write-only until one exists.
      if (ratedBy === 'CUSTOMER') {
        const average = await this.ratingRepo.averageForDriver(ride.driverId, tx);
        if (average !== null) {
          await this.driverRepository.setRating(ride.driverId, Math.round(average * 100) / 100, tx);
        }
      }
      return created;
    });
  }
}
