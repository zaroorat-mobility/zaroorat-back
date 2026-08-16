import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../../auth/index.ts';
import { getMe, userQueryKey } from '../api/user.api.ts';

/**
 * The authenticated user, straight from GET /api/v1/users/me.
 *
 * Server state only — it is never copied into the auth store, which owns the
 * session and nothing else. Disabled while anonymous or still restoring, so an
 * unauthenticated app makes no request at all.
 *
 * A token refresh does not reset this: the API client replays the request
 * underneath, so the query never sees the 401.
 */
export function useUser() {
  const { status } = useAuth();

  return useQuery({
    queryKey: userQueryKey,
    queryFn: ({ signal }) => getMe(signal),
    enabled: status === 'authenticated',
    staleTime: 60_000,
  });
}
