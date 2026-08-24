import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId, callerHasRole } from '@core/auth';
import { RatingService } from '../services/rating.service.js';
import { submitRatingSchema } from '../schemas/rating.schemas.js';

export class RatingController {
  constructor(private readonly ratingService: RatingService) {}

  async submitRating(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const body = submitRatingSchema.parse(req.body);
    const ratedBy = callerHasRole(req, 'driver') ? 'DRIVER' : 'CUSTOMER';

    const rating = await this.ratingService.submitRating(
      id,
      ratedBy,
      callerId(req),
      body.rating,
      body.tags,
      body.comment,
    );

    reply.send({ data: rating });
  }
}
