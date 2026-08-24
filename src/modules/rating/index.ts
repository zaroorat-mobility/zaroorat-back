import { asClass, aliasTo, AwilixContainer } from 'awilix';
import { RatingRepository } from './repositories/rating.repository.js';
import { RatingService } from './services/rating.service.js';
import { RatingController } from './controllers/rating.controller.js';

export * from './controllers/rating.controller.js';
export * from './routes/rating.routes.js';
export * from './schemas/rating.schemas.js';
export * from './services/rating.service.js';
export * from './repositories/rating.repository.js';

export function registerRatingModule(container: AwilixContainer): void {
  container.register({
    ratingRepository: asClass(RatingRepository).singleton(),
    ratingService: asClass(RatingService).singleton(),
    ratingController: asClass(RatingController).singleton(),
    ratingRepo: aliasTo('ratingRepository'),
  });
}
