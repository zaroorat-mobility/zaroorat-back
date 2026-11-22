import { CONTENT_TYPE_EXTENSION } from '@config/file/file.config.js';
import { MAX_FILENAME_BYTES, RESERVED_FILENAMES } from '../constants/index.js';
const REPLACED = /[/\\:*?"<>|]/g;
const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0, 31],
  [127, 159],
  [8234, 8238],
  [8294, 8297],
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
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}
export function sanitizeFileName(raw: string, contentType: string): string {
  const extension = CONTENT_TYPE_EXTENSION[contentType] ?? '';
  const basename = raw.normalize('NFC').split(/[/\\]/).pop() ?? '';
  let cleaned = stripUnsafeCodePoints(basename).replace(REPLACED, '_').replace(/^\.+/, '').trim();
  cleaned = cleaned.replace(/\.[^.]*$/, '');
  if (RESERVED_FILENAMES.has(cleaned.toLowerCase())) cleaned = `${cleaned}_`;
  if (cleaned.length === 0) cleaned = 'file';
  return truncateToBytes(cleaned, MAX_FILENAME_BYTES - Buffer.byteLength(extension)) + extension;
}
