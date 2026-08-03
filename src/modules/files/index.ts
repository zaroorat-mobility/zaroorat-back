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
export { S3StorageProvider } from './providers/s3.provider.js';
export {
  createStorageProvider,
  getStorageConfig,
  type ServerSideEncryptionMode,
  type StorageConfig,
  type StorageProviderName,
} from './storage.config.js';
export { buildStorageKey, STORAGE_KEY_PATTERN } from './storage-key.js';
export { decideRead, type ReadGrant } from './read-policy.js';
export {
  clearFileReferences,
  findLiveReference,
  registerFileReference,
  type FileReferenceCheck,
} from './file-references.js';
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
 * Phases 2–4 register the upload, read, and lifecycle paths, which share one
 * service and so one registration; the S3 provider and the two jobs arrive in
 * phases 5–6 (files doc 01 §12). The reference guard is a module-level registry
 * rather than a container entry — it is written to by other modules at boot, and
 * a DI singleton would make "who registered this?" harder to answer, not easier.
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
