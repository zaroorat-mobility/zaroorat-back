import { asClass, AwilixContainer } from 'awilix';
import { GeographicCoverageService } from './services/geographic-coverage.service.js';
import { GeographicMetrics } from './metrics/geographic.metrics.js';

export * from './errors/geographic.errors.js';
export * from './services/geographic-coverage.service.js';
export * from './metrics/geographic.metrics.js';

export function registerGeographicModule(container: AwilixContainer): void {
  container.register({
    geographicMetrics: asClass(GeographicMetrics).singleton(),
    geographicCoverageService: asClass(GeographicCoverageService).singleton(),
  });
}
