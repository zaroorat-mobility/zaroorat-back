import type { AccountStatus } from './api/auth.types.ts';

/**
 * `initializing` covers the boot-time session restore, so the UI can hold
 * still instead of flashing the login screen before the refresh call lands.
 */
export type AuthStatus = 'initializing' | 'authenticated' | 'anonymous';

export type AuthOperation =
  'initialize' | 'send-otp' | 'verify-otp' | 'refresh' | 'logout' | 'restore';

/** An in-progress OTP challenge, kept out of the URL so no phone number leaks. */
export interface OtpChallenge {
  phoneNumber: string;
  challengeId: string;
  /** Epoch ms after which the code is dead and a new one must be requested. */
  expiresAt: number;
  /** Epoch ms before which /otp/send returns the same challenge rather than a
   *  new code — the backend's own resend window. */
  resendAvailableAt: number;
}

/** Trimmed ApiError: enough to explain a failure, nothing sensitive. */
export interface AuthErrorSummary {
  status: number;
  code: string;
  message: string;
  requestId: string | null;
  retryAfterSec: number | null;
  fieldErrors: { path: string; message: string }[];
}

/**
 * The published snapshot. Deliberately contains no token — only whether one is
 * held — so nothing that renders or logs this object can leak a credential.
 */
export interface AuthState {
  status: AuthStatus;
  userId: string | null;
  roles: string[];
  accountStatus: AccountStatus | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  /** Epoch ms; from the backend's accessTokenExpiresInSec. */
  accessTokenExpiresAt: number | null;
  challenge: OtpChallenge | null;
  lastOperation: AuthOperation | null;
  lastError: AuthErrorSummary | null;
  busy: boolean;
}
