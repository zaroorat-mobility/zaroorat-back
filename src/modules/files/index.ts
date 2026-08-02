import { asFunction, AwilixContainer } from 'awilix';

import { createStorageProvider, getStorageConfig } from './storage.config.js';

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

/**
 * Registers the FILES module into the Awilix container.
 *
 * CLASSIC injection resolves constructor parameters **by name**, so
 * `storageConfig` and `storageProvider` are the names every later consumer must
 * use — the factory registration mirrors the one `smsProvider` uses in
 * `notifications`.
 *
 * Phase 1 registers only the provider and its config; the repository, service,
 * controller, and jobs arrive in phases 2–6 (files doc 01 §12).
 * @param container The application DI container.
 */
export function registerFileModule(container: AwilixContainer): void {
  container.register({
    storageConfig: asFunction(getStorageConfig).singleton(),
    storageProvider: asFunction(createStorageProvider).singleton(),
  });
}
