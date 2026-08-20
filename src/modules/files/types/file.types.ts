import type { FilePurposeName } from '@config/file/file.config.js';
export interface CreateUploadInput {
  ownerUserId: string;
  purpose: FilePurposeName;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  requestId?: string | null;
}
export interface CreateUploadResult {
  fileId: string;
  status: 'PENDING';
  upload: {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expiresAt: Date;
  };
}
export interface CompleteUploadResult {
  fileId: string;
  status: 'READY';
  purpose: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  createdAt: Date;
}
export interface AdmittedObject {
  sizeBytes: number;
  checksumSha256: string | null;
  detectedContentType: string;
  versionId: string | null;
  uploadedAt: Date;
  verifiedAt: Date;
}
export interface FileReadUrl {
  url: string;
  expiresAt: Date;
  contentType: string;
}
export interface FileCaller {
  userId: string;
  roles: readonly string[];
}
