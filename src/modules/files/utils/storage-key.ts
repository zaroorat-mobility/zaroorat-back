import { randomUUID } from 'node:crypto';
import {
  CONTENT_TYPE_EXTENSION,
  PURPOSE_KEY_PREFIX,
  type FilePurposeName,
} from '@config/file/file.config.js';
export const STORAGE_KEY_PATTERN =
  /^(pi|dd|vd|vi|se|de|pb)\/\d{4}\/(0[1-9]|1[0-2])\/[0-9a-f]{32}\.(jpg|png|webp|pdf|mp4)$/;
export function buildStorageKey(
  purpose: FilePurposeName,
  contentType: string,
  now: Date = new Date(),
): string {
  const extension = CONTENT_TYPE_EXTENSION[contentType];
  if (!extension) {
    throw new Error(`No extension mapped for content type "${contentType}"`);
  }
  const prefix = PURPOSE_KEY_PREFIX[purpose];
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const random = randomUUID().replaceAll('-', '');
  return `${prefix}/${year}/${month}/${random}${extension}`;
}
