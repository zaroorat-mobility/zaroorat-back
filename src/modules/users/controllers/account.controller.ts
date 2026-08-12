import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AccountService } from '../services/account/account.service';
import { UserValidationError } from '../errors';
import {
  deactivateSchema,
  detailsFromZodIssues,
  replyFromUserError,
  replyUserError,
} from '../schemas';

export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  deactivate = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    const parsed = deactivateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }

    await this.accountService.deactivate(auth.userId, parsed.data.reason ?? null, request.id);
    return reply.status(204).send();
  };

  requestDeletion = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    const result = await this.accountService.requestDeletion(auth.userId, request.id);
    return reply.status(202).send(result);
  };
}
