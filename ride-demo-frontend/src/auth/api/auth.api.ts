import { apiClient } from '../../api/index.ts';
import type {
  LogoutRequest,
  RefreshRequest,
  SendOtpRequest,
  SendOtpResponse,
  TokenPair,
  VerifyOtpRequest,
  VerifyOtpResponse,
} from './auth.types.ts';

/**
 * Thin transport for the four auth endpoints that exist. No token is read or
 * attached here — the API client does that from the provider the store installs.
 *
 * There is no login endpoint and no registration endpoint: /otp/verify is both.
 */

const BASE = '/api/v1/auth';

/** Public. Rate limited per IP (20/h) and per phone (3/h) — the backend is
 *  authoritative and answers 429 RATE_LIMITED with retryAfterSec. */
export function sendOtp(body: SendOtpRequest, signal?: AbortSignal): Promise<SendOtpResponse> {
  return apiClient.post<SendOtpResponse>(`${BASE}/otp/send`, body, { signal });
}

/** Public. Requires an Idempotency-Key; the caller owns the key so a replay of
 *  the same submission cannot create a second session. */
export function verifyOtp(
  body: VerifyOtpRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<VerifyOtpResponse> {
  return apiClient.post<VerifyOtpResponse>(`${BASE}/otp/verify`, body, {
    idempotencyKey,
    signal,
  });
}

/**
 * Public. Rotates the refresh token — the old one is consumed, and replaying it
 * revokes the whole session family (401 TOKEN_REUSE).
 *
 * `skipAuthRetry` is mandatory: this is the call the 401 handler makes, so
 * letting it trigger the handler again would recurse.
 */
export function refreshTokens(body: RefreshRequest): Promise<TokenPair> {
  return apiClient.post<TokenPair>(`${BASE}/token/refresh`, body, {
    idempotencyKey: crypto.randomUUID(),
    skipAuthRetry: true,
  });
}

/** Authenticated. 204 on success. Revokes this session, or all of them. */
export function logout(body: LogoutRequest = {}): Promise<void> {
  return apiClient.post<void>(`${BASE}/logout`, body, { skipAuthRetry: true });
}
