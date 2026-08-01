import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_ERROR_STATUS } from '@modules/auth/http';
import { UserError, type ErrorDetail } from '../errors';

/**
 * HTTP status for each error code reachable from this module (user doc 04 §2).
 *
 * Extends `AUTH_ERROR_STATUS` with the USER-only codes rather than restating the
 * shared ones, so a code's status is defined in exactly one place and the two
 * modules can never disagree about, say, what `TOKEN_STALE` returns.
 */
export const USER_ERROR_STATUS: Record<string, number> = {
  ...AUTH_ERROR_STATUS,
  IMMUTABLE_FIELD: 400,
  PHONE_UNCHANGED: 400,
  NOT_FOUND: 404,
  PHONE_IN_USE: 409,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 409,
  ACCOUNT_HAS_OBLIGATIONS: 409,
};

/** Resolve the HTTP status for an error code (unknown codes are a 500, not a guess). */
export function userErrorStatus(code: string): number {
  return USER_ERROR_STATUS[code] ?? 500;
}

/** Extra fields that may accompany a USER error body. */
export interface UserErrorExtra {
  retryAfterSeconds?: number;
  details?: ErrorDetail[];
}

/** The platform error envelope, `users` namespace (user doc 04 §1). */
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

/**
 * Build the doc 04 §1 error envelope.
 *
 * `messageKey` is derived as `user.<code>` — the same derivation AUTH uses in its
 * namespace. Doc 04 §1's example shows a more specific key
 * (`user.emergency_contact.limit_exceeded`); deriving from the code keeps one
 * rule for both modules, and a per-context key can be layered on later without
 * changing the envelope.
 */
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

/** Send a doc 04 error response with the mapped status (and `Retry-After` when applicable). */
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

/** Send a {@link UserError} using its code, message, and field details. */
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
