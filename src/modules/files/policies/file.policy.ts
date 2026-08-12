import {
  CONTENT_TYPE_EXTENSION,
  filePurposePolicy,
  type FilePurposeName,
  type FilePurposePolicy,
} from '@config/file/file.config.js';
import { FileTooLargeError, UnsupportedMediaTypeError } from '../errors/file.errors.js';
import { hasEnforceableDimensions, type ImageDimensions } from '../utils/content-inspector.js';

const MAX_FILENAME_BYTES = 255;

const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

const REPLACED = /[/\\:*?"<>|]/g;

const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function stripUnsafeCodePoints(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const stripped = STRIPPED_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
    if (!stripped) result += character;
  }
  return result;
}

export function policyFor(purpose: FilePurposeName): FilePurposePolicy {
  return filePurposePolicy[purpose];
}

export function sanitizeFileName(raw: string, contentType: string): string {
  const extension = CONTENT_TYPE_EXTENSION[contentType] ?? '';

  const basename = raw.normalize('NFC').split(/[/\\]/).pop() ?? '';

  let cleaned = stripUnsafeCodePoints(basename).replace(REPLACED, '_').replace(/^\.+/, '').trim();

  cleaned = cleaned.replace(/\.[^.]*$/, '');

  if (RESERVED_NAMES.has(cleaned.toLowerCase())) cleaned = `${cleaned}_`;
  if (cleaned.length === 0) cleaned = 'file';

  return truncateToBytes(cleaned, MAX_FILENAME_BYTES - Buffer.byteLength(extension)) + extension;
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
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
