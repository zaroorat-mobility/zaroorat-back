import type { TransactionClient } from '@core/database/TransactionManager';
import type { FilePurposeName } from '@config/file/file.config.js';

/**
 * The reference guard (files doc 01 R-FILE-19/33, doc 02 §2.5, FILE-INV-5).
 *
 * `files` never reads another module's table and never learns what a licence is
 * (doc 01 §2.2). So the only way it can answer *"is anyone still using this?"* is
 * to **ask the module that would know** — which is exactly what R-FILE-19 says
 * retention does before erasing, and what `DELETE /files/{id}` does before
 * soft-deleting.
 *
 * One checker per purpose, because doc 02 §6A maps each purpose to exactly one
 * owning module. That is also what keeps the answer a yes/no rather than a count:
 * FILES-OD-13 rejects reference counting outright, since a count turns "is this
 * still needed?" into a distributed-consistency problem this module has no reason
 * to take on.
 */

/** How one module answers whether it still holds a file. */
export interface FileReferenceCheck {
  /** The module name, for `details.module` on `FILE_IN_USE` (doc 04 §2.2). */
  module: string;
  /**
   * Whether a live row in that module still points at this file.
   * @param fileId The file being released.
   * @param tx The caller's transaction, when the question is asked inside one.
   * @returns `true` while a live row references it.
   */
  isReferenced(fileId: string, tx?: TransactionClient): Promise<boolean>;
}

const CHECKS = new Map<FilePurposeName, FileReferenceCheck>();

/**
 * Register the module that owns a purpose's references.
 *
 * **Empty in v1, and that is the honest state**: no domain table has a file-id
 * column yet (doc 01 §13.1), so nothing can hold a reference and every delete
 * succeeds. Phase 7 registers `users` for `PROFILE_IMAGE` as the cutover lands,
 * and `documents` follows when it ships — neither needs a change here.
 * @param purpose The purpose whose references that module owns.
 * @param check The module's answer.
 */
export function registerFileReference(purpose: FilePurposeName, check: FileReferenceCheck): void {
  CHECKS.set(purpose, check);
}

/**
 * Whether any module has claimed a purpose's references.
 *
 * The distinction {@link findLiveReference} cannot make: it returns `null` both
 * for "nobody holds this" and for "nobody is here to ask". Deletion may treat
 * those alike — the caller owns the file and asked. **Retention may not**:
 * erasure is irreversible, so a purpose with no module to ask is a purpose
 * retention leaves alone (doc 03 §6).
 * @param purpose The purpose to check.
 * @returns `true` when a module owns that purpose's references.
 */
export function hasFileReferenceOwner(purpose: FilePurposeName): boolean {
  return CHECKS.has(purpose);
}

/** Drop every registration. For tests, which register a stand-in module. */
export function clearFileReferences(): void {
  CHECKS.clear();
}

/**
 * Ask whether a live domain row still references a file.
 * @param purpose The file's purpose, which selects the owning module.
 * @param fileId The file being released or attached.
 * @param tx The caller's transaction, when asked inside one (R-FILE-27).
 * @returns The holding module's name, or `null` when nothing holds it.
 */
export async function findLiveReference(
  purpose: FilePurposeName,
  fileId: string,
  tx?: TransactionClient,
): Promise<string | null> {
  const check = CHECKS.get(purpose);
  if (!check) return null;
  return (await check.isReferenced(fileId, tx)) ? check.module : null;
}
