import { queryOptions } from '@tanstack/react-query';

import { apiClient } from './client.ts';

/**
 * `GET /api/v1/health` — src/routes/health/health.route.ts. Marked
 * `config: { public: true }`, so it is exempt from the backend's
 * deny-by-default auth hook. Returns the payload unwrapped.
 */
export interface HealthResponse {
  status: string;
  uptime: number;
  environment: string;
  /** ISO 8601 UTC. */
  timestamp: string;
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiClient.get<HealthResponse>('/api/v1/health', { signal, timeoutMs: 5_000 });
}

export const healthQueryOptions = queryOptions({
  queryKey: ['health'],
  queryFn: ({ signal }) => getHealth(signal),
  refetchInterval: 30_000,
  staleTime: 15_000,
});
