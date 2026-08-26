import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { RideRating } from '../../rides/types/index.js';

export type RatedByRole = 'CUSTOMER' | 'DRIVER';

export interface CreateRideRatingInput {
  rideId: string;
  ratedBy: RatedByRole;
  rating: number;
  tags?: string[];
  comment?: string;
}

export class RatingRepository {
  constructor(private readonly db: DatabaseService) {}
  async findByRideAndRater(
    rideId: string,
    ratedBy: RatedByRole,
    tx?: TransactionClient,
  ): Promise<RideRating | null> {
    const client = tx ?? this.db.client;
    return client.rideRating.findUnique({ where: { rideId_ratedBy: { rideId, ratedBy } } });
  }
  /// The driver's star average across every ride a customer has rated.
  ///
  /// Recomputed from the rating rows rather than nudged incrementally: `Driver`
  /// has no rating *count* to carry an incremental average, and a stored average
  /// with no count behind it drifts the moment a rating is corrected or a ride
  /// is removed. One `AVG` over a driver's own ratings cannot drift, and there
  /// are only ever as many rows as the driver has completed rated rides.
  ///
  /// `ratedBy: 'CUSTOMER'` only — a driver's own ratings *of* customers are not
  /// part of their score.
  async averageForDriver(driverId: string, tx?: TransactionClient): Promise<number | null> {
    const client = tx ?? this.db.client;
    const result = await client.rideRating.aggregate({
      _avg: { rating: true },
      where: { ratedBy: 'CUSTOMER', ride: { driverId } },
    });
    return result._avg.rating ?? null;
  }

  async create(input: CreateRideRatingInput, tx?: TransactionClient): Promise<RideRating> {
    const client = tx ?? this.db.client;
    return client.rideRating.create({
      data: {
        rideId: input.rideId,
        ratedBy: input.ratedBy,
        rating: input.rating,
        tags: input.tags ?? [],
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
      },
    });
  }
}
