import { asClass, asFunction, AwilixContainer } from 'awilix';

import { createStorageProvider, getStorageConfig } from './config/index.js';
import { FileService } from './services/index.js';
import { FileMetrics } from './metrics/index.js';
import { FileSweeperJob } from './jobs/sweeper.job.js';
import { FileRetentionJob } from './jobs/retention.job.js';

export type {
  ObjectHead,
  SignDownloadInput,
  SignUploadInput,
  SignedDownload,
  SignedUpload,
  StorageHealth,
  StorageOperation,
  StorageProvider,
} from './providers/storage.provider.js';
export { StorageError } from './providers/storage.provider.js';
export {
  MockStorageProvider,
  type MockUrlRejection,
  type MockUrlVerdict,
} from './providers/mock.provider.js';
export { S3StorageProvider } from './providers/s3.provider.js';
export * from './config/index.js';
export * from './policies/index.js';
export * from './references/index.js';
export * from './utils/index.js';
export * from './services/index.js';
export * from './metrics/index.js';
export * from './errors/index.js';
export { FileSweeperJob, type SweepResult } from './jobs/sweeper.job.js';
export {
  FileRetentionJob,
  type DeadLetteredFile,
  type RetentionResult,
} from './jobs/retention.job.js';
export { FileRepository, registerFileRepositories } from './repositories/index.js';
export { FILE_EVENT_CATALOG, FILE_PRODUCER, fileEvent } from './events/index.js';

export function registerFileModule(container: AwilixContainer): void {
  container.register({
    storageConfig: asFunction(getStorageConfig).singleton(),
    storageProvider: asFunction(createStorageProvider).singleton(),
    fileMetrics: asClass(FileMetrics).singleton(),
    fileService: asClass(FileService).singleton(),
    fileSweeperJob: asClass(FileSweeperJob).singleton(),
    fileRetentionJob: asClass(FileRetentionJob).singleton(),
  });
}
