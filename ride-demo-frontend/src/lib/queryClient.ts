import { QueryClient } from '@tanstack/react-query';

/**
 * Lives outside the provider so non-React code (the auth store) can invalidate
 * queries on logout without importing React.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    // This console talks to a backend under active development: surface real
    // failures instead of masking them behind retries and background refetches.
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});
