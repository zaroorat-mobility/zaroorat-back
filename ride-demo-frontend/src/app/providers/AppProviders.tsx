import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { queryClient } from '../../lib/queryClient.ts';

/**
 * Application-level providers. Router lives in App.tsx so that every provider
 * here is available to route elements.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
