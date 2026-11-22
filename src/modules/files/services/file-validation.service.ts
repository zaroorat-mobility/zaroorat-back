import {
  filePurposePolicy,
  type FilePurposeName,
  type FilePurposePolicy,
} from '@config/file/file.config.js';
import { FileTooLargeError, UnsupportedMediaTypeError } from '../errors/file.errors.js';
import {
  hasEnforceableDimensions,
  inspect,
  matchesSignature,
  type ImageDimensions,
  type InspectionResult,
} from '../utils/inspection/content-inspector.js';
import type { ObjectHead } from '../utils/storage/storage.provider.js';
export function policyFor(purpose: FilePurposeName): FilePurposePolicy {
  return filePurposePolicy[purpose];
}
export function assertDeclaredUploadAllowed(
  purpose: FilePurposeName,
  contentType: string,
  sizeBytes: number,
): void {
  const policy = policyFor(purpose);
  if (!policy.mimeTypes.includes(contentType)) {
    throw new UnsupportedMediaTypeError(policy.mimeTypes);
  }
  if (sizeBytes > policy.maxBytes) {
    throw new FileTooLargeError('sizeBytes', policy.maxBytes);
  }
}
export function assertStoredObjectAllowed(
  purpose: FilePurposeName,
  contentType: string,
  actualBytes: number,
  dimensions: ImageDimensions | null,
): void {
  const policy = policyFor(purpose);
  if (actualBytes > policy.maxBytes) {
    throw new FileTooLargeError('sizeBytes', policy.maxBytes);
  }
  if (!hasEnforceableDimensions(contentType) || !policy.maxPixels || !dimensions) return;
  const { width, height } = policy.maxPixels;
  if (dimensions.width > width || dimensions.height > height) {
    throw new FileTooLargeError('dimensions', width * height);
  }
}
export function peekBudgetFor(
  contentType: string,
  signatureBytes: number,
  imageBytes: number,
): number {
  return hasEnforceableDimensions(contentType) ? imageBytes : signatureBytes;
}
export function refusesLocation(purpose: FilePurposeName, location: string): boolean {
  return policyFor(purpose).rejectExifLocation && location !== 'ABSENT';
}
export function detectContentType(purpose: FilePurposeName, header: Buffer): string | null {
  return (
    policyFor(purpose).mimeTypes.find((candidate) => matchesSignature(candidate, header)) ?? null
  );
}
export type RejectionReason =
  | 'SIZE_LIMIT_EXCEEDED'
  | 'CONTENT_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'EXIF_LOCATION_PRESENT'
  | 'DIMENSIONS_EXCEEDED';
export type ValidationOutcome =
  | {
      ok: true;
      sizeBytes: number;
      checksumSha256: string | null;
      detectedContentType: string;
      versionId: string | null;
    }
  | {
      ok: false;
      reason: RejectionReason;
    };
export class FileValidationService {
  policyFor(purpose: FilePurposeName): FilePurposePolicy {
    return policyFor(purpose);
  }
  assertDeclaredUploadAllowed(
    purpose: FilePurposeName,
    contentType: string,
    sizeBytes: number,
  ): void {
    assertDeclaredUploadAllowed(purpose, contentType, sizeBytes);
  }
  assertStoredObjectAllowed(
    purpose: FilePurposeName,
    contentType: string,
    actualBytes: number,
    dimensions: ImageDimensions | null,
  ): void {
    assertStoredObjectAllowed(purpose, contentType, actualBytes, dimensions);
  }
  peekBudgetFor(contentType: string, signatureBytes: number, imageBytes: number): number {
    return peekBudgetFor(contentType, signatureBytes, imageBytes);
  }
  refusesLocation(purpose: FilePurposeName, location: string): boolean {
    return refusesLocation(purpose, location);
  }
  inspect(declared: string, header: Buffer): InspectionResult {
    return inspect(declared, header);
  }
  detectContentType(purpose: FilePurposeName, header: Buffer): string | null {
    return detectContentType(purpose, header);
  }
  validateStoredObject(
    purpose: FilePurposeName,
    declared: {
      contentType: string;
      checksumSha256: string | null;
    },
    head: ObjectHead,
  ): ValidationOutcome {
    const policy = policyFor(purpose);
    if (head.sizeBytes > policy.maxBytes) {
      return { ok: false, reason: 'SIZE_LIMIT_EXCEEDED' };
    }
    const detected = detectContentType(purpose, head.peek);
    if (detected === null || detected !== declared.contentType) {
      return { ok: false, reason: 'CONTENT_MISMATCH' };
    }
    if (
      declared.checksumSha256 != null &&
      head.checksumSha256 != null &&
      declared.checksumSha256 !== head.checksumSha256
    ) {
      return { ok: false, reason: 'CHECKSUM_MISMATCH' };
    }
    const inspection = inspect(detected, head.peek);
    if (!inspection.ok) return { ok: false, reason: 'CONTENT_MISMATCH' };
    if (hasEnforceableDimensions(detected) && policy.maxPixels && inspection.dimensions) {
      const { width, height } = policy.maxPixels;
      if (inspection.dimensions.width > width || inspection.dimensions.height > height) {
        return { ok: false, reason: 'DIMENSIONS_EXCEEDED' };
      }
    }
    if (refusesLocation(purpose, inspection.location)) {
      return { ok: false, reason: 'EXIF_LOCATION_PRESENT' };
    }
    return {
      ok: true,
      sizeBytes: head.sizeBytes,
      checksumSha256: head.checksumSha256 ?? declared.checksumSha256,
      detectedContentType: detected,
      versionId: head.versionId,
    };
  }
}
