import { asClass, AwilixContainer } from 'awilix';
import { PricingService } from './services/pricing.service.js';
import { PricingRuleRepository } from './repositories/pricing-rule.repository.js';
import { SurgeRepository } from './repositories/surge.repository.js';
import { SurgeService } from './services/surge.service.js';
import { CancellationPolicyService } from './services/cancellation-policy.service.js';
import { CommissionService } from './services/commission.service.js';
import { TaxService } from './services/tax.service.js';
import { GstRecoveryService } from './services/gst-recovery.service.js';
import { FeatureFlagDependencyValidator } from './services/feature-flag-dependency.validator.js';
import { PricingMetrics } from './metrics/pricing.metrics.js';

export * from './constants.js';
export * from './domain/pricing.types.js';
export * from './services/pricing.service.js';
export * from './services/surge.service.js';
export * from './services/cancellation-policy.service.js';
export * from './services/commission.service.js';
export * from './services/tax.service.js';
export * from './services/gst-recovery.service.js';
export * from './services/feature-flag-dependency.validator.js';
export * from './metrics/pricing.metrics.js';
export * from './utils/peak-window.js';
export * from './utils/scope-precedence.js';

export function registerPricingModule(container: AwilixContainer): void {
  container.register({
    pricingMetrics: asClass(PricingMetrics).singleton(),
    pricingRuleRepository: asClass(PricingRuleRepository).singleton(),
    pricingService: asClass(PricingService).singleton(),
    surgeRepository: asClass(SurgeRepository).singleton(),
    surgeService: asClass(SurgeService).singleton(),
    cancellationPolicyService: asClass(CancellationPolicyService).singleton(),
    commissionService: asClass(CommissionService).singleton(),
    taxService: asClass(TaxService).singleton(),
    gstRecoveryService: asClass(GstRecoveryService).singleton(),
    featureFlagDependencyValidator: asClass(FeatureFlagDependencyValidator).singleton(),
  });
}
