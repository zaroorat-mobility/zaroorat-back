import { asClass, AwilixContainer } from 'awilix';

import { FileRepository } from './file.repository.js';

export { FileRepository, type CreateFileInput, type CompleteFileInput } from './file.repository.js';

/**
 * Registers the FILES repository layer into the Awilix container.
 *
 * Constructed with the shared `databaseService` (CLASSIC injection resolves the
 * constructor param by name), exactly as the auth and user repositories are.
 * @param container The application DI container.
 */
export function registerFileRepositories(container: AwilixContainer): void {
  container.register({
    fileRepository: asClass(FileRepository).singleton(),
  });
}
