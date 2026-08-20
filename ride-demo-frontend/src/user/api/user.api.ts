import { apiClient } from '../../api/index.ts';
import type { UpdateProfileRequest, User, UserProfile } from './user.types.ts';

/**
 * The single owner of user-domain requests. No Authorization header is set
 * here — the API client reads the token from the provider the auth store
 * installed, and transparently refreshes and replays on a 401.
 *
 * Other user routes exist and belong to later modules, not this one:
 *   POST   /api/v1/users/me/phone/change|verify  phone change flow
 *   GET/POST/PATCH/DELETE /me/emergency-contacts
 *   GET/POST/PATCH/DELETE /me/saved-places
 *   POST   /api/v1/users/me/deactivate
 *   POST   /api/v1/users/me/delete-request
 */

/** Stable across renders; used for both fetching and logout invalidation. */
export const userQueryKey = ['user', 'me'] as const;

export function getMe(signal?: AbortSignal): Promise<User> {
  return apiClient.get<User>('/api/v1/users/me', { signal });
}

/**
 * Partial update. Send only the keys being changed — the backend's schema is
 * strict, and a key set to `null` clears the field rather than leaving it alone.
 * Returns the updated profile, not the whole account.
 */
export function updateProfile(body: UpdateProfileRequest): Promise<UserProfile> {
  return apiClient.patch<UserProfile>('/api/v1/users/me/profile', body);
}
