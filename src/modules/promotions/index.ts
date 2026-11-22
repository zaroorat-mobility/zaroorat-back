import { asClass, AwilixContainer } from 'awilix';
import { PromotionService } from './promotion.service.js';
import { PromotionController } from './controllers/promotion.controller.js';

export * from './errors.js';
export * from './types.js';
export * from './promotion.service.js';
export * from './controllers/promotion.controller.js';
export * from './routes/promotion.routes.js';
export * from './presenters/promotion-client.presenter.js';

export function registerPromotionsModule(container: AwilixContainer): void {
  container.register({
    promotionService: asClass(PromotionService).singleton(),
    promotionController: asClass(PromotionController).singleton(),
  });
}
