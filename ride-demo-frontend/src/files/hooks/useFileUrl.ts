import { useQuery } from '@tanstack/react-query';

import { getReadUrl } from '../api/files.api.ts';

/** PROFILE_IMAGE read URLs live 600s (policy.readTtlSeconds). */
const READ_TTL_MS = 600_000;

export const fileUrlQueryKey = (fileId: string | null) => ['file', 'url', fileId] as const;

/**
 * Resolves a file id to a short-lived presigned URL. Refetched a minute before
 * the signature expires, so a long-lived page never shows a broken image.
 */
export function useFileUrl(fileId: string | null) {
  return useQuery({
    queryKey: fileUrlQueryKey(fileId),
    queryFn: ({ signal }) => getReadUrl(fileId as string, signal),
    enabled: Boolean(fileId),
    staleTime: READ_TTL_MS - 60_000,
    refetchInterval: READ_TTL_MS - 60_000,
  });
}
