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

  async aggregateForCustomer(customerId: string, tx?: TransactionClient) {
    const client = tx ?? this.db.client;
    const ratings = await client.rideRating.findMany({
      where: { ratedBy: 'DRIVER', ride: { customerId } },
      select: { rating: true },
    });
    if (ratings.length === 0) return null;
    const totalRatings = ratings.length;
    let sum = 0;
    const counts = { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0 };
    for (const r of ratings) {
      sum += r.rating;
      if (r.rating === 1) counts.star1++;
      else if (r.rating === 2) counts.star2++;
      else if (r.rating === 3) counts.star3++;
      else if (r.rating === 4) counts.star4++;
      else if (r.rating === 5) counts.star5++;
    }
    const avgRating = Number((sum / totalRatings).toFixed(2));
    return { avgRating, totalRatings, ...counts };
  }

  async updateCustomerRatingAggregate(
    userId: string,
    aggregate: {
      avgRating: number;
      totalRatings: number;
      star1: number;
      star2: number;
      star3: number;
      star4: number;
      star5: number;
    },
    tx?: TransactionClient,
  ) {
    const client = tx ?? this.db.client;
    await client.customerRatingAggregate.upsert({
      where: { userId },
      create: {
        userId,
        avgRating: aggregate.avgRating,
        totalRatings: aggregate.totalRatings,
        star1: aggregate.star1,
        star2: aggregate.star2,
        star3: aggregate.star3,
        star4: aggregate.star4,
        star5: aggregate.star5,
        lastRatedAt: new Date(),
      },
      update: {
        avgRating: aggregate.avgRating,
        totalRatings: aggregate.totalRatings,
        star1: aggregate.star1,
        star2: aggregate.star2,
        star3: aggregate.star3,
        star4: aggregate.star4,
        star5: aggregate.star5,
        lastRatedAt: new Date(),
      },
    });
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
