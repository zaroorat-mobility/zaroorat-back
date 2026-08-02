import { randomUUID } from 'node:crypto';
import {
  CONTENT_TYPE_EXTENSION,
  PURPOSE_KEY_PREFIX,
  type FilePurposeName,
} from '@config/file/file.config.js';

/**
 * Storage-key construction (files doc 03 §5).
 *
 * Grammar: `{purposePrefix}/{yyyy}/{mm}/{uuidv4}{ext}` — for example
 * `dd/2026/08/c9f0f895fb98ab9159f51fd0297e236d.pdf`.
 *
 * Read one and note what it does **not** carry: no user id, no domain id, no
 * original filename, and no ordering relative to its neighbours. Someone holding
 * a key learns only the purpose class and the month, and cannot derive a second
 * key from it.
 *
 * Key construction is deliberately **not** on `StorageProvider` (doc 07 §2.2):
 * it is policy, and if each vendor generated keys the unguessability guarantee
 * would vary by vendor.
 */

/** Matches the grammar above. Exported so tests assert against one definition. */
export const STORAGE_KEY_PATTERN =
  /^(pi|dd|vd|vi|se|de)\/\d{4}\/(0[1-9]|1[0-2])\/[0-9a-f]{32}\.(jpg|png|webp|pdf|mp4)$/;

/**
 * Build the storage key for a new upload.
 *
 * The random component is **uuid v4 with dashes stripped**, not the row's
 * uuid v7. This is the one place the time-ordered id is wrong: a v7 leaks its
 * creation time and sits adjacent to its neighbours, and a key must be
 * unguessable even to someone holding a different key (R-FILE-7). The row id is
 * also frequently visible — in API responses and logs — so deriving the key from
 * it would make every key derivable the moment one id leaked.
 *
 * The extension comes from the **content-type**, never from the client's
 * filename (doc 02 §5.0). `licence.PDF.exe` contributes nothing.
 *
 * @param purpose The file's purpose, which selects the prefix.
 * @param contentType A content-type from the purpose's allow-list.
 * @param now Clock seam; defaults to the current time.
 * @returns A key unique with overwhelming probability, and unique in fact —
 *          `uq_files_storage_key` is the guarantee (doc 03 §4.1).
 * @throws Error when `contentType` has no mapped extension, which means it was
 *         never in an allow-list and validation upstream is broken.
 */
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
