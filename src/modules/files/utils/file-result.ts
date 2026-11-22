import type { CompleteUploadResult } from '../types/file.types.js';
export function toFileResult(file: {
  id: string;
  purpose: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  createdAt: Date;
}): CompleteUploadResult {
  return {
    fileId: file.id,
    status: 'READY',
    purpose: file.purpose,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    createdAt: file.createdAt,
  };
}
