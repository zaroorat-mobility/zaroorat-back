import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserService } from '../services/user.service';
import type { UpdateUserProfileInput } from '../repositories';
import { ImmutableFieldError, UserValidationError } from '../errors';
import {
  detailsFromZodIssues,
  findImmutableFields,
  replyFromUserError,
  replyUserError,
  updateProfileSchema,
  type UpdateProfileBody,
} from '../schemas';
import { parseDateOnly } from '../utils';
function toProfileUpdate(body: UpdateProfileBody): UpdateUserProfileInput {
  const changes: UpdateUserProfileInput = {};
  if (Object.hasOwn(body, 'firstName')) changes.firstName = body.firstName ?? null;
  if (Object.hasOwn(body, 'lastName')) changes.lastName = body.lastName ?? null;
  if (Object.hasOwn(body, 'dateOfBirth')) {
    changes.dateOfBirth = body.dateOfBirth == null ? null : parseDateOnly(body.dateOfBirth);
  }
  if (Object.hasOwn(body, 'gender')) changes.gender = body.gender ?? null;
  if (Object.hasOwn(body, 'profileImageFileId')) {
    changes.profileImageFileId = body.profileImageFileId ?? null;
  }
  if (Object.hasOwn(body, 'languageCode')) changes.languageCode = body.languageCode ?? null;
  if (Object.hasOwn(body, 'email')) changes.email = body.email ?? null;
  return changes;
}
export class ProfileController {
  constructor(private readonly userService: UserService) {}
  getMe = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    return reply.status(200).send(await this.userService.getMe(auth.userId));
  };
  updateProfile = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const body = request.body ?? {};
    const immutable = findImmutableFields(body);
    if (immutable.length > 0) {
      return replyFromUserError(request, reply, new ImmutableFieldError(immutable));
    }
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }
    const profile = await this.userService.updateProfile(
      auth.userId,
      toProfileUpdate(parsed.data),
      request.id,
    );
    return reply.status(200).send(profile);
  };
}
