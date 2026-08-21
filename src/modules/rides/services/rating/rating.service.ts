import { RideRepository } from '../../repositories/ride.repository.js';
import {
  RideRatingRepository,
  type RatedByRole,
} from '../../repositories/ride-rating.repository.js';
import {
  RideNotFoundError,
  RideDriverMismatchError,
  RideCustomerMismatchError,
  RideNotRatableError,
  AlreadyRatedError,
} from '../../errors/ride.errors.js';
import type { RideRating } from '../../types';
export class RatingService {
  constructor(
    private readonly rideRepo: RideRepository,
    private readonly ratingRepo: RideRatingRepository,
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
    if (ratedBy === 'DRIVER') {
      const driverUserId = (ride as { driver?: { userId?: string } }).driver?.userId;
      if (driverUserId !== actorId) throw new RideDriverMismatchError(rideId);
    }
    if (ride.status !== 'COMPLETED') {
      throw new RideNotRatableError(ride.status);
    }
    const existing = await this.ratingRepo.findByRideAndRater(rideId, ratedBy);
    if (existing) throw new AlreadyRatedError();
    return this.ratingRepo.create({
      rideId,
      ratedBy,
      rating,
      ...(tags !== undefined ? { tags } : {}),
      ...(comment !== undefined ? { comment } : {}),
    });
  }
}
