import { asClass, asFunction, AwilixContainer } from 'awilix';

import { createStorageProvider, getStorageConfig } from './storage.config.js';
import { FileService } from './file.service.js';
import { FileMetrics } from './file.metrics.js';

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
export {
  createStorageProvider,
  getStorageConfig,
  type StorageConfig,
  type StorageProviderName,
} from './storage.config.js';
export { buildStorageKey, STORAGE_KEY_PATTERN } from './storage-key.js';
export {
  inspect,
  hasEnforceableDimensions,
  matchesSignature,
  type ImageDimensions,
  type InspectionResult,
} from './content-inspector.js';
export {
  assertDeclaredUploadAllowed,
  assertStoredObjectAllowed,
  peekBudgetFor,
  policyFor,
  sanitizeFileName,
} from './file.policy.js';
export {
  FileService,
  type CreateUploadInput,
  type CreateUploadResult,
  type CompleteUploadResult,
} from './file.service.js';
export { FileMetrics, type FileMetricFields } from './file.metrics.js';
export {
  FileError,
  FileNotFoundError,
  FileStateError,
  FileTooLargeError,
  FileValidationError,
  FileInUseError,
  ChecksumMismatchError,
  ContentMismatchError,
  UnsupportedMediaTypeError,
  UploadExpiredError,
  UploadNotFoundError,
  type FileErrorDetail,
} from './errors.js';
export { FileRepository, registerFileRepositories } from './repositories/index.js';
export { FILE_EVENT_CATALOG, FILE_PRODUCER, fileEvent } from './events/index.js';

/**
 * Registers the FILES module into the Awilix container.
 *
 * CLASSIC injection resolves constructor parameters **by name**, so
 * `storageConfig`, `storageProvider`, `fileRepository`, `fileMetrics`, and
 * `fileService` are the names every consumer must use. The provider is a factory
 * registration, mirroring `smsProvider` in `notifications`.
 *
 * `fileService` additionally needs `transactionManager`, `eventPublisher`, and
 * `redisService`, so this must run after the database, events, and Redis
 * modules.
 *
 * Phase 2 registers the upload pair's dependencies; the read and delete paths
 * and the two jobs arrive in phases 3–6 (files doc 01 §12).
 * @param container The application DI container.
 */
export function registerFileModule(container: AwilixContainer): void {
  container.register({
    storageConfig: asFunction(getStorageConfig).singleton(),
    storageProvider: asFunction(createStorageProvider).singleton(),
    fileMetrics: asClass(FileMetrics).singleton(),
    fileService: asClass(FileService).singleton(),
  });
}
