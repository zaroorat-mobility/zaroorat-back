import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RidePinService } from '../services/ride-pin/ride-pin.service';
import { UserValidationError } from '../errors';
import {
  detailsFromZodIssues,
  replyFromUserError,
  replyUserError,
  resetRidePinVerifySchema,
  setRidePinSchema,
} from '../schemas';

export class RidePinController {
  constructor(private readonly ridePinService: RidePinService) {}

  getStatus = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    return reply.status(200).send(await this.ridePinService.status(auth.userId));
  };

  setPin = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const parsed = setRidePinSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }
    const status = await this.ridePinService.setPin({
      userId: auth.userId,
      newPin: parsed.data.newPin,
      ...(parsed.data.currentPin !== undefined ? { currentPin: parsed.data.currentPin } : {}),
      requestId: request.id,
    });
    return reply.status(200).send(status);
  };

  requestReset = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const challenge = await this.ridePinService.requestReset({
      userId: auth.userId,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      requestId: request.id,
    });
    return reply.status(202).send(challenge);
  };

  verifyReset = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const parsed = resetRidePinVerifySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }
    const status = await this.ridePinService.verifyReset({
      userId: auth.userId,
      challengeId: parsed.data.challengeId,
      code: parsed.data.code,
      newPin: parsed.data.newPin,
      requestId: request.id,
    });
    return reply.status(200).send(status);
  };
}
