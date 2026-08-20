import type { TransactionClient } from '@core/database/TransactionManager';
import type { FilePurposeName } from '@config/file/file.config.js';
import type {
  CompleteUploadResult,
  CreateUploadInput,
  CreateUploadResult,
  FileCaller,
  FileReadUrl,
} from '../types/file.types.js';
import { FileAccessService } from './file-access.service.js';
import { FileLifecycleService } from './file-lifecycle.service.js';
import { FileUploadService } from './file-upload.service.js';
export class FileService {
  constructor(
    private readonly fileUploadService: FileUploadService,
    private readonly fileAccessService: FileAccessService,
    private readonly fileLifecycleService: FileLifecycleService,
  ) {}
  createUpload(input: CreateUploadInput): Promise<CreateUploadResult> {
    return this.fileUploadService.createUpload(input);
  }
  completeUpload(
    fileId: string,
    ownerUserId: string,
    requestId: string | null = null,
  ): Promise<CompleteUploadResult> {
    return this.fileUploadService.completeUpload(fileId, ownerUserId, requestId);
  }
  getReadUrl(
    fileId: string,
    caller: FileCaller,
    disposition: 'inline' | 'attachment' = 'inline',
    requestId: string | null = null,
  ): Promise<FileReadUrl> {
    return this.fileAccessService.getReadUrl(fileId, caller, disposition, requestId);
  }
  getMetadata(fileId: string, caller: FileCaller): Promise<CompleteUploadResult> {
    return this.fileAccessService.getMetadata(fileId, caller);
  }
  remove(fileId: string, ownerUserId: string, requestId: string | null = null): Promise<void> {
    return this.fileLifecycleService.remove(fileId, ownerUserId, requestId);
  }
  releaseInTransaction(
    fileId: string,
    ownerUserId: string,
    tx: TransactionClient,
    requestId: string | null = null,
  ): Promise<boolean> {
    return this.fileLifecycleService.releaseInTransaction(fileId, ownerUserId, tx, requestId);
  }
  assertReferenceable(
    fileId: string,
    ownerUserId: string,
    purpose: FilePurposeName,
    tx: TransactionClient,
  ): Promise<void> {
    return this.fileLifecycleService.assertReferenceable(fileId, ownerUserId, purpose, tx);
  }
  supersede(
    previousFileId: string,
    replacementFileId: string,
    tx: TransactionClient,
    requestId: string | null = null,
  ): Promise<void> {
    return this.fileLifecycleService.supersede(previousFileId, replacementFileId, tx, requestId);
  }
}
