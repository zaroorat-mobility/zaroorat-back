import type { FastifyReply, FastifyRequest } from 'fastify';
import { AUTH_ERROR_STATUS } from '@modules/auth/http';
import { UserError, type ErrorDetail } from '../errors';
export const USER_ERROR_STATUS: Record<string, number> = {
  ...AUTH_ERROR_STATUS,
  IMMUTABLE_FIELD: 400,
  PHONE_UNCHANGED: 400,
  NOT_FOUND: 404,
  PHONE_IN_USE: 409,
  EMAIL_IN_USE: 409,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 409,
  ACCOUNT_HAS_OBLIGATIONS: 409,
};
export function userErrorStatus(code: string): number {
  return USER_ERROR_STATUS[code] ?? 500;
}
export interface UserErrorExtra {
  retryAfterSeconds?: number;
  details?: ErrorDetail[];
}
export interface UserErrorBody {
  error: {
    code: string;
    messageKey: string;
    message: string;
    requestId: string;
    retryAfterSec?: number;
    details?: ErrorDetail[];
  };
}
export function buildUserErrorBody(
  code: string,
  message: string,
  requestId: string,
  extra?: UserErrorExtra,
): UserErrorBody {
  return {
    error: {
      code,
      messageKey: `user.${code.toLowerCase()}`,
      message,
      requestId,
      ...(extra?.retryAfterSeconds != null ? { retryAfterSec: extra.retryAfterSeconds } : {}),
      ...(extra?.details != null ? { details: extra.details } : {}),
    },
  };
}
export function replyUserError(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  extra?: UserErrorExtra,
): FastifyReply {
  if (extra?.retryAfterSeconds != null) {
    reply.header('Retry-After', String(extra.retryAfterSeconds));
  }
  return reply
    .status(userErrorStatus(code))
    .send(buildUserErrorBody(code, message, request.id, extra));
}
export function replyFromUserError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: UserError,
): FastifyReply {
  return replyUserError(
    request,
    reply,
    error.code,
    error.message,
    error.details ? { details: error.details } : undefined,
  );
}
