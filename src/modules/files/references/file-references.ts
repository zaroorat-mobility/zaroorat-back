import type { TransactionClient } from '@core/database/TransactionManager';
import type { FilePurposeName } from '@config/file/file.config.js';

export interface FileReferenceCheck {
  module: string;
  isReferenced(fileId: string, tx?: TransactionClient): Promise<boolean>;
}

const CHECKS = new Map<FilePurposeName, FileReferenceCheck>();

export function registerFileReference(purpose: FilePurposeName, check: FileReferenceCheck): void {
  CHECKS.set(purpose, check);
}

export function hasFileReferenceOwner(purpose: FilePurposeName): boolean {
  return CHECKS.has(purpose);
}

export function clearFileReferences(): void {
  CHECKS.clear();
}

export async function findLiveReference(
  purpose: FilePurposeName,
  fileId: string,
  tx?: TransactionClient,
): Promise<string | null> {
  const check = CHECKS.get(purpose);
  if (!check) return null;
  return (await check.isReferenced(fileId, tx)) ? check.module : null;
}
