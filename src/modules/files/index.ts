import { asClass, asFunction, AwilixContainer } from 'awilix';
import { createStorageProvider, getStorageConfig } from './config/index.js';
import { FileMetrics } from './metrics/index.js';
import { FileReconciliationJob, FileRetentionJob, FileSweeperJob } from './jobs/index.js';
import {
  FileAccessService,
  FileLifecycleService,
  FileService,
  FileStorageService,
  FileUploadService,
  FileValidationService,
} from './services/index.js';
export * from './config/index.js';
export * from './constants/index.js';
export * from './controllers/index.js';
export * from './errors/index.js';
export * from './events/index.js';
export * from './jobs/index.js';
export * from './metrics/index.js';
export * from './plugins/index.js';
export * from './routes/index.js';
export * from './schemas/index.js';
export * from './services/index.js';
export * from './types/index.js';
export * from './utils/index.js';
export { FileRepository, registerFileRepositories } from './repositories/index.js';
export function registerFileModule(container: AwilixContainer): void {
  container.register({
    storageConfig: asFunction(getStorageConfig).singleton(),
    storageProvider: asFunction(createStorageProvider).singleton(),
    fileMetrics: asClass(FileMetrics).singleton(),
    fileStorageService: asClass(FileStorageService).singleton(),
    fileValidationService: asClass(FileValidationService).singleton(),
    fileUploadService: asClass(FileUploadService).singleton(),
    fileAccessService: asClass(FileAccessService).singleton(),
    fileLifecycleService: asClass(FileLifecycleService).singleton(),
    fileService: asClass(FileService).singleton(),
    fileSweeperJob: asClass(FileSweeperJob).singleton(),
    fileRetentionJob: asClass(FileRetentionJob).singleton(),
    fileReconciliationJob: asClass(FileReconciliationJob).singleton(),
  });
}
