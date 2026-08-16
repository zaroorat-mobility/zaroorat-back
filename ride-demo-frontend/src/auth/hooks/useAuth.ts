import { useSyncExternalStore } from 'react';

import { authStore } from '../auth.store.ts';
import type { AuthState } from '../auth.types.ts';

/**
 * Session state. Deliberately not TanStack Query — tokens are client state, not
 * server state, and must not sit in a cache that refetches or persists.
 *
 * Actions are plain module functions on the store; import them directly rather
 * than threading them through this hook.
 */
export function useAuth(): AuthState {
  return useSyncExternalStore(authStore.subscribe, authStore.getSnapshot, authStore.getSnapshot);
}
