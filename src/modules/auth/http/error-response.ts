import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from '../errors';

/**
 * HTTP status for each AUTH error code (auth doc 05 §2, doc 04 §4). The single
 * source of truth for code → status, shared by the auth hooks and (Phase 10) the
 * controllers so every auth failure maps consistently.
 */
export const AUTH_ERROR_STATUS: Record<string, number> = {
  VALIDATION: 400,
  OTP_INVALID: 401,
  OTP_EXPIRED: 410,
  OTP_LOCKED: 429,
  RATE_LIMITED: 429,
  TOKEN_INVALID: 401,
  TOKEN_STALE: 401,
  TOKEN_REUSE: 401,
  SESSION_REVOKED: 401,
  FORBIDDEN: 403,
  ACCOUNT_SUSPENDED: 403,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** Resolve the HTTP status for an error code (defaults to 401 for unknown auth codes). */
export function authErrorStatus(code: string): number {
  return AUTH_ERROR_STATUS[code] ?? 401;
}

/** Extra fields that may accompany an error body. */
export interface AuthErrorExtra {
  retryAfterSeconds?: number;
  details?: unknown;
}

/** The AUTH error envelope (auth doc 05 §1). */
export interface AuthErrorBody {
  error: {
    code: string;
    messageKey: string;
    message: string;
    requestId: string;
    retryAfterSec?: number;
    details?: unknown;
  };
}

/** Build the doc-05 error envelope. */
export function buildAuthErrorBody(
  code: string,
  message: string,
  requestId: string,
  extra?: AuthErrorExtra,
): AuthErrorBody {
  return {
    error: {
      code,
      messageKey: `auth.${code.toLowerCase()}`,
      message,
      requestId,
      ...(extra?.retryAfterSeconds != null ? { retryAfterSec: extra.retryAfterSeconds } : {}),
      ...(extra?.details != null ? { details: extra.details } : {}),
    },
  };
}

/**
 * Send a doc-05 auth error response with the mapped status (and `Retry-After`
 * header when applicable).
 */
export function replyAuthError(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  extra?: AuthErrorExtra,
): FastifyReply {
  if (extra?.retryAfterSeconds != null) {
    reply.header('Retry-After', String(extra.retryAfterSeconds));
  }
  return reply
    .status(authErrorStatus(code))
    .send(buildAuthErrorBody(code, message, request.id, extra));
}

/** Send an {@link AuthError} using its code, message, and any retry hint. */
export function replyFromAuthError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AuthError,
): FastifyReply {
  const retryAfterSeconds = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
  return replyAuthError(
    request,
    reply,
    error.code,
    error.message,
    retryAfterSeconds != null ? { retryAfterSeconds } : undefined,
  );
}
