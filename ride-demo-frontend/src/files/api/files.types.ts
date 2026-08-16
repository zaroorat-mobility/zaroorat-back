/**
 * Transcribed from the backend source:
 *   src/modules/files/http/file.routes.ts, file.responses.ts
 *   src/config/file/file.config.ts   (per-purpose policy)
 *   src/modules/files/errors/file.errors.ts
 *
 * Returned bare — no `{ data }` wrapper on these routes.
 */

export type FilePurpose =
  | 'PROFILE_IMAGE'
  | 'DRIVER_DOCUMENT'
  | 'VEHICLE_DOCUMENT'
  | 'VEHICLE_IMAGE'
  | 'SOS_EVIDENCE'
  | 'DISPUTE_EVIDENCE';

/** POST /api/v1/files — requires an Idempotency-Key header. */
export interface CreateUploadRequest {
  purpose: FilePurpose;
  /** Sanitized server-side; the stored extension comes from contentType. */
  fileName: string;
  /** Must be allowed for the purpose, and is re-checked against magic bytes. */
  contentType: string;
  /** Declared size; the stored object is re-measured at completion. */
  sizeBytes: number;
  /** Lowercase hex SHA-256. When given, storage enforces it on upload. */
  checksumSha256?: string;
}

export interface CreateUploadResponse {
  fileId: string;
  status: 'PENDING';
  upload: {
    method: 'PUT';
    url: string;
    /** Must be sent verbatim with the PUT, or storage refuses it. */
    headers: Record<string, string>;
    expiresAt: string;
  };
}

/** POST /api/v1/files/:id/complete, and GET /api/v1/files/:id. */
export interface FileMetadata {
  fileId: string;
  status: 'READY';
  purpose: FilePurpose;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  createdAt: string;
}

/** GET /api/v1/files/:id/url */
export interface ReadUrlResponse {
  /** Presigned, short-lived. 600s for PROFILE_IMAGE (policy.readTtlSeconds). */
  url: string;
  expiresAt: string;
  contentType: string;
}

/**
 * `filePurposePolicy.PROFILE_IMAGE`. Mirrored here only to fail fast in the
 * browser — the backend re-checks all of it and remains authoritative.
 */
export const PROFILE_IMAGE_POLICY = {
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxBytes: 5 * 1024 * 1024,
  maxPixels: { width: 4096, height: 4096 },
  /** Photos straight off a phone are commonly refused for this reason. */
  rejectExifLocation: true,
} as const;
