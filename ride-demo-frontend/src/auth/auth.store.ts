import { isApiError, setAuthTokenProvider, setUnauthorizedHandler } from '../api/index.ts';
import type { ApiError } from '../api/index.ts';
import { queryClient } from '../lib/queryClient.ts';
import { userQueryKey } from '../user/api/user.api.ts';
import * as authApi from './api/auth.api.ts';
import type { DeviceContext, TokenPair, VerifyOtpResponse } from './api/auth.types.ts';
import type { AuthErrorSummary, AuthOperation, AuthState } from './auth.types.ts';

/**
 * Token storage — see README "Token storage" for the tradeoffs.
 *
 *   access token  : module variable only. Never persisted, never in state,
 *                   never rendered. Dies with the page.
 *   refresh token : sessionStorage, so a reload keeps you signed in but closing
 *                   the tab does not. Not localStorage — that would survive
 *                   indefinitely and is shared across tabs.
 *
 * Both are held outside the published snapshot, so no component, log line or
 * devtools view can reach them by rendering auth state.
 */
const REFRESH_TOKEN_KEY = 'ride-demo.refreshToken';

let accessToken: string | null = null;
let refreshToken: string | null = null;

function loadRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null; // storage unavailable (private mode, SSR) — degrade to memory
  }
}

function persistRefreshToken(value: string | null): void {
  refreshToken = value;
  try {
    if (value) sessionStorage.setItem(REFRESH_TOKEN_KEY, value);
    else sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    /* memory-only fallback */
  }
}

/** The API client's single source of the bearer token (see §5 of the module). */
setAuthTokenProvider(() => accessToken);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const initialState: AuthState = {
  status: 'initializing',
  userId: null,
  roles: [],
  accountStatus: null,
  hasAccessToken: false,
  hasRefreshToken: false,
  accessTokenExpiresAt: null,
  challenge: null,
  lastOperation: null,
  lastError: null,
  busy: false,
};

let state: AuthState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<AuthState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export const authStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): AuthState {
    return state;
  },
};

function toSummary(error: unknown): AuthErrorSummary {
  if (isApiError(error)) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      requestId: error.requestId,
      retryAfterSec: error.retryAfterSec,
      fieldErrors: error.validationErrors,
    };
  }
  return {
    status: 0,
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : 'Unexpected failure',
    requestId: null,
    retryAfterSec: null,
    fieldErrors: [],
  };
}

function applyTokens(pair: TokenPair): void {
  accessToken = pair.accessToken;
  persistRefreshToken(pair.refreshToken);
  setState({
    hasAccessToken: true,
    hasRefreshToken: true,
    accessTokenExpiresAt: Date.now() + pair.accessTokenExpiresInSec * 1000,
  });
}

/** Wipes the session locally. Leaves unrelated app state alone. */
export function clearSession(operation: AuthOperation = 'logout'): void {
  accessToken = null;
  persistRefreshToken(null);
  setState({
    status: 'anonymous',
    userId: null,
    roles: [],
    accountStatus: null,
    hasAccessToken: false,
    hasRefreshToken: false,
    accessTokenExpiresAt: null,
    challenge: null,
    lastOperation: operation,
    busy: false,
  });
  // Drop server state belonging to the old identity. Scoped to the user query
  // rather than a blanket clear(), so unrelated caches survive a sign-out.
  void queryClient.removeQueries({ queryKey: userQueryKey });
}

// ---------------------------------------------------------------------------
// Single-flight refresh
// ---------------------------------------------------------------------------

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Rotates the token pair. Concurrent callers share one in-flight request, so a
 * burst of 401s produces exactly one refresh — important here because the
 * backend revokes the session family if a consumed refresh token is replayed.
 */
export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const token = refreshToken;
    if (!token) return false;

    try {
      applyTokens(await authApi.refreshTokens({ refreshToken: token }));
      setState({ status: 'authenticated', lastOperation: 'refresh', lastError: null });
      return true;
    } catch (error) {
      // Includes TOKEN_REUSE, which means the family is already revoked
      // server-side. Nothing to retry — the session is gone.
      setState({ lastError: toSummary(error) });
      clearSession('refresh');
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Registered once with the API client. Refreshes only for the two codes that
 * actually mean "this access token is stale"; any other 401 (a revoked session,
 * a missing token) ends the session instead of burning a refresh.
 */
setUnauthorizedHandler(async (error: ApiError) => {
  if (error.code !== 'TOKEN_INVALID' && error.code !== 'TOKEN_STALE') {
    if (state.status === 'authenticated') clearSession('logout');
    return false;
  }
  if (!refreshToken) {
    if (state.status === 'authenticated') clearSession('logout');
    return false;
  }
  return refreshSession();
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const device: DeviceContext = { platform: 'WEB' };

/**
 * Boot-time restore. A refresh token in sessionStorage means a previous tab
 * session; exchange it for an access token before the UI decides what to show.
 */
export async function initializeAuth(): Promise<void> {
  if (state.status !== 'initializing') return;

  const stored = loadRefreshToken();
  if (!stored) {
    setState({ status: 'anonymous', lastOperation: 'initialize' });
    return;
  }

  refreshToken = stored;
  setState({ hasRefreshToken: true });
  const restored = await refreshSession();
  setState({ status: restored ? 'authenticated' : 'anonymous', lastOperation: 'restore' });
}

/** Step 1 of login. Also the resend action — the backend returns the active
 *  challenge unchanged until its own resend window elapses. */
export async function requestOtp(phoneNumber: string): Promise<boolean> {
  setState({ busy: true, lastError: null, lastOperation: 'send-otp' });
  try {
    const result = await authApi.sendOtp({ phoneNumber, device });
    setState({
      busy: false,
      challenge: {
        phoneNumber,
        challengeId: result.challengeId,
        expiresAt: Date.now() + result.expiresInSec * 1000,
        resendAvailableAt: Date.now() + result.resendAvailableInSec * 1000,
      },
    });
    return true;
  } catch (error) {
    setState({ busy: false, lastError: toSummary(error) });
    return false;
  }
}

/**
 * Step 2 of login, and registration: the backend creates the account when the
 * phone number is new and reports it via `user.isNew`.
 *
 * A fresh Idempotency-Key is minted per submission, so a replayed submit
 * returns the first result instead of opening a second session.
 */
export async function verifyOtp(code: string): Promise<VerifyOtpResponse | null> {
  const challenge = state.challenge;
  if (!challenge) return null;

  setState({ busy: true, lastError: null, lastOperation: 'verify-otp' });
  try {
    const result = await authApi.verifyOtp(
      {
        phoneNumber: challenge.phoneNumber,
        code,
        challengeId: challenge.challengeId,
        device,
      },
      crypto.randomUUID(),
    );

    applyTokens(result);
    setState({
      status: 'authenticated',
      userId: result.user.id,
      roles: result.user.roles,
      accountStatus: result.user.status,
      challenge: null,
      busy: false,
    });
    return result;
  } catch (error) {
    setState({ busy: false, lastError: toSummary(error) });
    return null;
  }
}

/** Revokes the session server-side, then clears it locally regardless — a
 *  failed revoke must not strand the user in a half-authenticated UI. */
export async function logout(allDevices = false): Promise<void> {
  setState({ busy: true, lastOperation: 'logout' });
  try {
    await authApi.logout(allDevices ? { allDevices } : {});
  } catch (error) {
    setState({ lastError: toSummary(error) });
  } finally {
    clearSession('logout');
  }
}

export function clearChallenge(): void {
  setState({ challenge: null, lastError: null });
}
