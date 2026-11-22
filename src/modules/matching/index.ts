import { asClass, AwilixContainer } from 'awilix';
import { MatchingService } from './services/index.js';

export * from './services/index.js';

export function registerMatchingModule(container: AwilixContainer): void {
  container.register({
    matchingService: asClass(MatchingService).singleton(),
  });
}
