import {
  CONTENT_TYPE_EXTENSION,
  filePurposePolicy,
  type FilePurposeName,
  type FilePurposePolicy,
} from '@config/file/file.config.js';
import { FileTooLargeError, UnsupportedMediaTypeError } from './errors.js';
import { hasEnforceableDimensions, type ImageDimensions } from './content-inspector.js';

/** Maximum stored `fileName` length, in UTF-8 **bytes** (doc 02 §5.1). */
const MAX_FILENAME_BYTES = 255;

/** Windows device names, which are unusable as filenames on a reviewer's machine. */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * Characters replaced with `_`: path separators, shell and glob metacharacters,
 * and the Windows-illegal set.
 */
const REPLACED = /[/\\:*?"<>|]/g;

/**
 * Code-point ranges removed outright, as `[lo, hi]` inclusive pairs.
 *
 * Written as numbers rather than a regex literal deliberately: a character class
 * of control codes puts raw `0x00`–`0x1F` bytes in the source file, which makes
 * the file binary to git and unreviewable in a diff.
 *
 * - `0000–001F`, `007F–009F` — C0 and C1 controls.
 * - `202A–202E`, `2066–2069` — bidirectional overrides and isolates. These
 *   matter more than they look: `invoice<RLO>gnp.exe` renders as
 *   `invoiceexe.png`, so a reviewer sees a PNG and opens an executable.
 *   Magic-byte validation makes that non-fatal, but an ops console is exactly
 *   where a human decides, and the rendering deceives the human.
 */
const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

/**
 * Remove every code point falling in {@link STRIPPED_RANGES}.
 *
 * Iterates code points, not UTF-16 units, so an astral character is never split
 * into a lone surrogate.
 * @param value The string to clean.
 * @returns The string without control or bidi-override characters.
 */
function stripUnsafeCodePoints(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const stripped = STRIPPED_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
    if (!stripped) result += character;
  }
  return result;
}

/**
 * Resolve the policy for a purpose.
 * @param purpose The upload purpose.
 * @returns Its validation and retention policy.
 */
export function policyFor(purpose: FilePurposeName): FilePurposePolicy {
  return filePurposePolicy[purpose];
}

/**
 * Sanitize a client-supplied filename (R-FILE-28, doc 02 §5.1).
 *
 * `fileName` never reaches the storage key (doc 03 §5), so traversal cannot
 * escape a prefix — but the value is stored, returned to other readers, and
 * rendered in an ops console, so it is cleaned on the way in.
 *
 * Unicode is **preserved and NFC-normalized**: rejecting non-ASCII would reject
 * Urdu and Hindi filenames on a platform whose users write in both. Emoji are
 * ordinary code points and are kept.
 *
 * @param raw The client's filename.
 * @param contentType The verified content-type, which supplies the extension.
 * @returns A safe display name, always non-empty and always correctly suffixed.
 */
export function sanitizeFileName(raw: string, contentType: string): string {
  const extension = CONTENT_TYPE_EXTENSION[contentType] ?? '';

  // Keep only the basename: `../../etc/passwd` contributes `passwd`, and the
  // traversal is gone before any other rule runs.
  const basename = raw.normalize('NFC').split(/[/\\]/).pop() ?? '';

  let cleaned = stripUnsafeCodePoints(basename).replace(REPLACED, '_').replace(/^\.+/, '').trim();

  // The client's extension is discarded; the verified one is appended below.
  cleaned = cleaned.replace(/\.[^.]*$/, '');

  if (RESERVED_NAMES.has(cleaned.toLowerCase())) cleaned = `${cleaned}_`;
  if (cleaned.length === 0) cleaned = 'file';

  return truncateToBytes(cleaned, MAX_FILENAME_BYTES - Buffer.byteLength(extension)) + extension;
}

/**
 * Truncate a string to a UTF-8 byte budget without splitting a code point.
 *
 * Bytes, not characters: the column and every filesystem count bytes, and a
 * 255-character Urdu name is far more than 255 bytes.
 * @param value The string to truncate.
 * @param maxBytes The budget.
 * @returns The longest prefix fitting the budget.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

/**
 * Validate an upload's declared intent, before any permission is signed.
 *
 * Cheap rejection (R-FILE-4): the client's claims are all we have at this point,
 * and refusing a 20 MB PDF costs nothing. The claims are re-checked against the
 * stored object at completion, where they can actually be disproved.
 *
 * @param purpose The upload purpose.
 * @param contentType The declared content-type.
 * @param sizeBytes The declared size.
 * @throws {UnsupportedMediaTypeError} When the type is not on the allow-list.
 * @throws {FileTooLargeError} When the declared size exceeds the ceiling.
 */
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

/**
 * Validate the **stored object** at completion (R-FILE-5, R-FILE-35).
 *
 * @param purpose The upload purpose.
 * @param contentType The verified content-type.
 * @param actualBytes The object's real size.
 * @param dimensions The dimensions read from its header, or `null`.
 * @throws {FileTooLargeError} When the real size or the pixel count exceeds the
 *         purpose ceiling.
 */
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
    // The ceiling reported is the pixel budget, not one axis: a client that
    // learns "4096" cannot tell whether it was too wide or too tall, and does
    // not need to — it must downscale either way.
    throw new FileTooLargeError('dimensions', width * height);
  }
}

/**
 * The leading-byte budget to request for a content-type.
 *
 * A signature needs a handful of bytes; a **JPEG's dimensions** can sit past a
 * 64 KB EXIF block, several ICC profiles, and an embedded thumbnail. Asking for
 * 512 bytes and then failing closed on "dimensions unreadable" would reject
 * ordinary camera photographs.
 * @param contentType The declared content-type.
 * @param signatureBytes The configured signature budget.
 * @param imageBytes The configured image-header budget.
 * @returns How many leading bytes to fetch.
 */
export function peekBudgetFor(
  contentType: string,
  signatureBytes: number,
  imageBytes: number,
): number {
  return hasEnforceableDimensions(contentType) ? imageBytes : signatureBytes;
}
