import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EmergencyContactService } from '../services/emergency-contact/emergency-contact.service';
import type { UpdateEmergencyContactInput } from '../repositories';
import { UserValidationError } from '../errors';
import {
  createContactSchema,
  detailsFromZodIssues,
  itemIdSchema,
  replyFromUserError,
  replyUserError,
  updateContactSchema,
  type UpdateContactBody,
} from '../schemas';
function toContactWrite(body: UpdateContactBody): UpdateEmergencyContactInput {
  const changes: UpdateEmergencyContactInput = {};
  if (body.contactName !== undefined) changes.contactName = body.contactName;
  if (body.phoneNumber !== undefined) changes.phoneNumber = body.phoneNumber;
  if (Object.hasOwn(body, 'relationship')) changes.relationship = body.relationship ?? null;
  if (body.priority !== undefined) changes.priority = body.priority;
  return changes;
}
export class EmergencyContactController {
  constructor(private readonly emergencyContactService: EmergencyContactService) {}
  listContacts = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    return reply.status(200).send(await this.emergencyContactService.list(auth.userId));
  };
  addContact = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const parsed = createContactSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }
    const body = parsed.data;
    const input = {
      contactName: body.contactName,
      phoneNumber: body.phoneNumber,
      ...toContactWrite(body),
    };
    const created = await this.emergencyContactService.add(auth.userId, input, request.id);
    return reply.status(201).send(created);
  };
  updateContact = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const idParsed = itemIdSchema.safeParse(
      (
        request.params as {
          id?: unknown;
        }
      ).id,
    );
    if (!idParsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError([{ field: 'id', code: 'INVALID_FORMAT' }]),
      );
    }
    const parsed = updateContactSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }
    const updated = await this.emergencyContactService.update(
      auth.userId,
      idParsed.data,
      toContactWrite(parsed.data),
      request.id,
    );
    return reply.status(200).send(updated);
  };
  removeContact = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const idParsed = itemIdSchema.safeParse(
      (
        request.params as {
          id?: unknown;
        }
      ).id,
    );
    if (!idParsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError([{ field: 'id', code: 'INVALID_FORMAT' }]),
      );
    }
    await this.emergencyContactService.remove(auth.userId, idParsed.data, request.id);
    return reply.status(204).send();
  };
}
