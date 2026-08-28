import { asClass, AwilixContainer } from 'awilix';
import { GeographicCoverageService } from './services/geographic-coverage.service.js';

export * from './errors/geographic.errors.js';
export * from './services/geographic-coverage.service.js';

export function registerGeographicModule(container: AwilixContainer): void {
  container.register({
    geographicCoverageService: asClass(GeographicCoverageService).singleton(),
  });
}
