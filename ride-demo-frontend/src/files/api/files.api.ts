import { ApiError, apiClient } from '../../api/index.ts';
import type {
  CreateUploadRequest,
  CreateUploadResponse,
  FileMetadata,
  ReadUrlResponse,
} from './files.types.ts';

const BASE = '/api/v1/files';

/** Step 1. Reserves a file row and returns a presigned PUT. */
export function createUpload(
  body: CreateUploadRequest,
  idempotencyKey: string,
): Promise<CreateUploadResponse> {
  return apiClient.post<CreateUploadResponse>(BASE, body, { idempotencyKey });
}

/**
 * Step 2. Sends the bytes straight to object storage — a different origin, and
 * deliberately NOT through apiClient: the presigned URL carries its own
 * authorization in the signature, and attaching our bearer token or any header
 * the signature does not cover makes storage reject the request.
 *
 * Requires CORS on the bucket allowing PUT from this origin.
 */
export async function putToStorage(
  upload: CreateUploadResponse['upload'],
  file: File,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: file,
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError({
      status: 0,
      code: 'STORAGE_UNREACHABLE',
      message:
        'Could not reach object storage. Check that the bucket allows PUT from this origin ' +
        '(CORS) and that the backend is pointed at a real bucket.',
      details: cause,
    });
  }

  if (!response.ok) {
    // S3 answers with an XML error document, not the backend's envelope.
    throw new ApiError({
      status: response.status,
      code: 'STORAGE_REJECTED',
      message: `Object storage refused the upload (${response.status} ${response.statusText}).`,
      details: await response.text().catch(() => null),
    });
  }
}

/**
 * Step 3. Verifies the stored object — magic bytes, size, dimensions, checksum,
 * and EXIF location — then commits it as READY. A refused object is deleted.
 * Repeating the call on a READY file returns the same result.
 */
export function completeUpload(fileId: string): Promise<FileMetadata> {
  return apiClient.post<FileMetadata>(`${BASE}/${fileId}/complete`);
}

/** Short-lived presigned read URL. Owner only; others get 404. */
export function getReadUrl(fileId: string, signal?: AbortSignal): Promise<ReadUrlResponse> {
  return apiClient.get<ReadUrlResponse>(`${BASE}/${fileId}/url`, { signal });
}

/** Soft-delete. Refused with 409 FILE_IN_USE while a module still references it. */
export function deleteFile(fileId: string): Promise<void> {
  return apiClient.delete<void>(`${BASE}/${fileId}`);
}
