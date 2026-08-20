/**
 * Transcribed from the backend source:
 *   src/modules/auth/schemas/auth.responses.ts  (request + response schemas)
 *   src/modules/auth/schemas/auth.schemas.ts    (Zod validation)
 *   src/modules/users/schemas/user.responses.ts (accountResponse)
 *
 * All auth responses are sent bare — the `{ data }` wrapper used by rides,
 * drivers and payments does not apply here.
 */

/** POST /api/v1/auth/otp/send */
export interface SendOtpRequest {
  /** E.164, validated against /^\+[1-9]\d{6,14}$/ */
  phoneNumber: string;
  device?: DeviceContext;
}

export interface SendOtpResponse {
  challengeId: string;
  expiresInSec: number;
  /** Seconds until /otp/send will issue a new code instead of the active one. */
  resendAvailableInSec: number;
}

/** POST /api/v1/auth/otp/verify — requires an Idempotency-Key header. */
export interface VerifyOtpRequest {
  phoneNumber: string;
  /** Exactly 6 digits. */
  code: string;
  challengeId?: string;
  device?: DeviceContext;
}

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresInSec: number;
  refreshToken: string;
  refreshTokenExpiresInSec: number;
}

export interface VerifyOtpResponse extends TokenPair {
  user: {
    id: string;
    status: AccountStatus;
    roles: string[];
    /** True when this verification created the account — there is no separate
     *  registration endpoint; /otp/verify both logs in and registers. */
    isNew: boolean;
  };
}

/** POST /api/v1/auth/token/refresh — requires an Idempotency-Key header.
 *  Returns a TokenPair only; no user object. */
export interface RefreshRequest {
  refreshToken: string;
}

/** POST /api/v1/auth/logout — 204, no body. */
export interface LogoutRequest {
  allDevices?: boolean;
}

export type AccountStatus = 'UNVERIFIED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

/** Optional on every auth call; the backend registers a device per session. */
export interface DeviceContext {
  deviceId?: string;
  platform?: 'IOS' | 'ANDROID' | 'WEB';
  appVersion?: string;
  osVersion?: string;
  fingerprint?: string;
  isRooted?: boolean;
  isJailbroken?: boolean;
  fcmToken?: string;
}
