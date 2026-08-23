import { asClass, AwilixContainer } from 'awilix';
import { PricingService } from './services/pricing.service.js';
import { PricingRuleRepository } from './repositories/pricing-rule.repository.js';
import { SurgeRepository } from './repositories/surge.repository.js';
import { SurgeService } from './services/surge.service.js';

export * from './domain/pricing.types.js';
export * from './services/pricing.service.js';
export * from './services/surge.service.js';

export function registerPricingModule(container: AwilixContainer): void {
  container.register({
    pricingRuleRepository: asClass(PricingRuleRepository).singleton(),
    pricingService: asClass(PricingService).singleton(),
    surgeRepository: asClass(SurgeRepository).singleton(),
    surgeService: asClass(SurgeService).singleton(),
  });
}
