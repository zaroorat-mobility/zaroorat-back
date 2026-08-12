import { asClass, AwilixContainer } from 'awilix';

import { FileRepository } from './file.repository.js';

export { FileRepository, type CreateFileInput, type CompleteFileInput } from './file.repository.js';

export function registerFileRepositories(container: AwilixContainer): void {
  container.register({
    fileRepository: asClass(FileRepository).singleton(),
  });
}
