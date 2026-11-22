import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from '../errors/auth.errors';
export const AUTH_ERROR_STATUS: Record<string, number> = {
  VALIDATION: 400,
  OTP_INVALID: 401,
  OTP_EXPIRED: 410,
  OTP_LOCKED: 429,
  RATE_LIMITED: 429,
  INVALID_CREDENTIALS: 401,
  TOKEN_INVALID: 401,
  TOKEN_STALE: 401,
  TOKEN_REUSE: 401,
  SESSION_REVOKED: 401,
  FORBIDDEN: 403,
  ACCOUNT_SUSPENDED: 403,
  ACCOUNT_DEACTIVATED: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_IN_PROGRESS: 409,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};
export function authErrorStatus(code: string): number {
  return AUTH_ERROR_STATUS[code] ?? 401;
}
export interface AuthErrorExtra {
  retryAfterSeconds?: number;
  details?: unknown;
}
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
export function replyFromAuthError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AuthError,
): FastifyReply {
  const retryAfterSeconds = (
    error as {
      retryAfterSeconds?: number;
    }
  ).retryAfterSeconds;
  return replyAuthError(
    request,
    reply,
    error.code,
    error.message,
    retryAfterSeconds != null ? { retryAfterSeconds } : undefined,
  );
}
