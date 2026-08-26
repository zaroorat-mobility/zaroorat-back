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
    return this.ratingRepo.create({
      rideId,
      ratedBy,
      rating,
      ...(tags !== undefined ? { tags } : {}),
      ...(comment !== undefined ? { comment } : {}),
    });
  }
}
