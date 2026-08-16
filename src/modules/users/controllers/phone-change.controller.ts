import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PhoneChangeService } from '../services/phone/phone-change.service';
import { UserValidationError } from '../errors';
import {
  detailsFromZodIssues,
  phoneChangeSchema,
  phoneVerifySchema,
  replyFromUserError,
  replyUserError,
} from '../schemas';
export class PhoneChangeController {
  constructor(private readonly phoneChangeService: PhoneChangeService) {}
  requestPhoneChange = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const parsed = phoneChangeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }
    const challenge = await this.phoneChangeService.requestPhoneChange({
      userId: auth.userId,
      newPhoneNumber: parsed.data.newPhoneNumber,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      requestId: request.id,
    });
    return reply.status(202).send(challenge);
  };
  verifyPhoneChange = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      return replyUserError(request, reply, 'VALIDATION', 'Idempotency-Key header is required');
    }
    const parsed = phoneVerifySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }
    const result = await this.phoneChangeService.verifyPhoneChange(
      {
        userId: auth.userId,
        sessionId: auth.sid,
        challengeId: parsed.data.challengeId,
        code: parsed.data.code,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      },
      idempotencyKey,
    );
    return reply.status(200).send(result);
  };
}
