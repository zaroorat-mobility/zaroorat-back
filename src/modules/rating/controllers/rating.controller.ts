import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { RideRepository } from '../../rides/repositories/ride.repository.js';
import { rideParty } from '../../rides/types/ride-party.js';
import { RatingService } from '../services/rating.service.js';
import { submitRatingSchema } from '../schemas/rating.schemas.js';

export class RatingController {
  constructor(
    private readonly ratingService: RatingService,
    private readonly rideRepo: RideRepository,
  ) {}

  /// Who is rating whom comes from the ride, not from the caller's roles.
  ///
  /// `ratedBy` was `callerHasRole(req, 'driver') ? 'DRIVER' : 'CUSTOMER'`. A
  /// verified driver keeps that role while off duty, so a driver rating a ride
  /// they took as a passenger was recorded as the driver's rating, checked
  /// against the ride's actual driver, and refused with 403
  /// RIDE_DRIVER_MISMATCH — they could never rate a ride they had paid for.
  ///
  /// A caller who is party to neither side falls through to 'CUSTOMER' exactly
  /// as before, and `RatingService` refuses them with the same
  /// RIDE_CUSTOMER_MISMATCH; the service still re-checks both sides against the
  /// ride, so this is a correction to the guess, not a replacement for the
  /// authorization.
  async submitRating(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const body = submitRatingSchema.parse(req.body);
    const actorId = callerId(req);
    const ride = await this.rideRepo.findById(id);
    const ratedBy = ride && rideParty(actorId, ride) === 'DRIVER' ? 'DRIVER' : 'CUSTOMER';

    const rating = await this.ratingService.submitRating(
      id,
      ratedBy,
      actorId,
      body.rating,
      body.tags,
      body.comment,
    );

    reply.send({ data: rating });
  }
}
