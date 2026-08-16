import { ApiError, isApiError } from '../api/index.ts';
import { completeUpload, createUpload, putToStorage } from './api/files.api.ts';
import type { FileMetadata } from './api/files.types.ts';
import { PROFILE_IMAGE_POLICY } from './api/files.types.ts';

/**
 * Checks the browser can already rule out, so a doomed 5 MB PUT is never sent.
 * The backend re-checks every one of these and stays authoritative.
 */
export async function validateProfileImage(file: File): Promise<string | null> {
  if (!PROFILE_IMAGE_POLICY.mimeTypes.includes(file.type as never)) {
    return `That file is ${file.type || 'an unknown type'}. Accepted: JPEG, PNG or WebP.`;
  }
  if (file.size > PROFILE_IMAGE_POLICY.maxBytes) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `That image is ${mb} MB. The limit is 5 MB.`;
  }

  const { width, height } = PROFILE_IMAGE_POLICY.maxPixels;
  try {
    const bitmap = await createImageBitmap(file);
    const tooBig = bitmap.width > width || bitmap.height > height;
    const dimensions = `${bitmap.width}×${bitmap.height}`;
    bitmap.close();
    if (tooBig) return `That image is ${dimensions}. The limit is ${width}×${height}.`;
  } catch {
    return 'That file could not be read as an image.';
  }

  return null;
}

/** Lowercase hex SHA-256, so storage can reject a corrupted transfer. */
async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export type UploadStage = 'validating' | 'reserving' | 'transferring' | 'verifying';

/**
 * The whole three-step upload: reserve a slot, send the bytes straight to
 * storage, then have the backend verify and commit the object.
 *
 * The Idempotency-Key is minted once per call, so a retried *attempt* is a new
 * upload while a replayed *request* is not.
 */
export async function uploadProfileImage(
  file: File,
  onStage?: (stage: UploadStage) => void,
): Promise<FileMetadata> {
  onStage?.('validating');
  const problem = await validateProfileImage(file);
  if (problem) throw new ApiError({ status: 0, code: 'INVALID_IMAGE', message: problem });

  const checksumSha256 = await sha256Hex(file);

  onStage?.('reserving');
  const reservation = await createUpload(
    {
      purpose: 'PROFILE_IMAGE',
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      checksumSha256,
    },
    crypto.randomUUID(),
  );

  onStage?.('transferring');
  await putToStorage(reservation.upload, file);

  onStage?.('verifying');
  return completeUpload(reservation.fileId);
}

/** The backend's file error codes, worded for someone looking at the screen. */
const MESSAGES: Record<string, string> = {
  EXIF_LOCATION_PRESENT:
    'That photo has GPS location data embedded in it, which this upload refuses. Re-save or ' +
    'screenshot the image to strip it, then try again.',
  UNSUPPORTED_MEDIA_TYPE: 'That file type is not accepted. Use JPEG, PNG or WebP.',
  FILE_TOO_LARGE: 'That image is over the 5 MB limit.',
  CONTENT_MISMATCH: 'The file contents do not match its type — it may be renamed or corrupted.',
  CHECKSUM_MISMATCH: 'The upload was corrupted in transfer. Try again.',
  UPLOAD_EXPIRED: 'The upload window closed before the transfer finished. Try again.',
  UPLOAD_NOT_FOUND: 'The upload did not arrive in storage. Try again.',
  FILE_IN_USE: 'That file is still attached elsewhere and cannot be removed.',
};

export function uploadErrorMessage(error: unknown): string {
  if (!isApiError(error)) return 'The upload failed.';
  return MESSAGES[error.code] ?? error.message;
}
