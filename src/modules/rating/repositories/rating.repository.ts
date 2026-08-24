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
