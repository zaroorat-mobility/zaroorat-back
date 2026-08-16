import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { UpdateProfileRequest, User, UserProfile } from '../api/user.types.ts';
import { updateProfile, userQueryKey } from '../api/user.api.ts';

/**
 * The endpoint returns the updated profile only, so the cached user is patched
 * in place rather than refetched — one request, and no flash of stale fields.
 * Not retried: this is a mutation, and a silent replay could clobber a value
 * the user has since changed.
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: UpdateProfileRequest) => updateProfile(body),
    onSuccess: (profile: UserProfile) => {
      queryClient.setQueryData<User>(userQueryKey, (current) =>
        current ? { ...current, profile } : current,
      );
    },
  });
}
