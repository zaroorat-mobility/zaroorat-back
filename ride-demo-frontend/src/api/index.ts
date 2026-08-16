export {
  apiClient,
  onRequestDiagnostic,
  setAuthTokenProvider,
  setUnauthorizedHandler,
} from './client.ts';
export { ApiError, isApiError, toApiError } from './errors.ts';
export { getHealth, healthQueryOptions } from './health.api.ts';
export type { HealthResponse } from './health.api.ts';
export type {
  DataEnvelope,
  HttpMethod,
  RequestDiagnostic,
  RequestOptions,
  ValidationIssue,
} from './types.ts';
