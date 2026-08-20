import type { StorageConfig } from '../config/storage.config.js';
import type {
  ObjectHead,
  SignDownloadInput,
  SignUploadInput,
  SignedDownload,
  SignedUpload,
  StorageProvider,
} from '../utils/storage/storage.provider.js';
export class FileStorageService {
  constructor(
    private readonly storageProvider: StorageProvider,
    private readonly storageConfig: StorageConfig,
  ) {}
  get providerName(): string {
    return this.storageProvider.name;
  }
  get quarantineBucket(): string | null {
    return this.storageConfig.quarantineBucket;
  }
  get trustedBucket(): string | null {
    return this.storageConfig.bucket;
  }
  signUpload(input: SignUploadInput): Promise<SignedUpload> {
    return this.storageProvider.signUpload(input);
  }
  signDownload(input: SignDownloadInput): Promise<SignedDownload> {
    return this.storageProvider.signDownload(input);
  }
  headQuarantined(key: string, peekBytes: number): Promise<ObjectHead | null> {
    return this.storageProvider.head(key, peekBytes, 'quarantine');
  }
  promote(key: string): Promise<void> {
    return this.storageProvider.promote(key);
  }
  discardQuarantined(key: string): Promise<void> {
    return this.storageProvider.delete(key, 'quarantine');
  }
}
