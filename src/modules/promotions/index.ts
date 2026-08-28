import { asClass, AwilixContainer } from 'awilix';
import { PromotionService } from './promotion.service.js';

export * from './errors.js';
export * from './types.js';
export * from './promotion.service.js';

export function registerPromotionsModule(container: AwilixContainer): void {
  container.register({
    promotionService: asClass(PromotionService).singleton(),
  });
}
