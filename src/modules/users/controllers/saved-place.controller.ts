import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SavedPlaceService } from '../services/saved-place/saved-place.service';
import type { UpdateSavedPlaceInput } from '../repositories';
import { UserValidationError } from '../errors';
import {
  createPlaceSchema,
  detailsFromZodIssues,
  itemIdSchema,
  replyFromUserError,
  replyUserError,
  updatePlaceSchema,
  type UpdatePlaceBody,
} from '../schemas';
function toPlaceWrite(body: UpdatePlaceBody): UpdateSavedPlaceInput {
  const changes: UpdateSavedPlaceInput = {};
  if (body.label !== undefined) changes.label = body.label;
  if (Object.hasOwn(body, 'address')) changes.address = body.address ?? null;
  if (Object.hasOwn(body, 'buildingName')) changes.buildingName = body.buildingName ?? null;
  if (Object.hasOwn(body, 'landmark')) changes.landmark = body.landmark ?? null;
  if (Object.hasOwn(body, 'floor')) changes.floor = body.floor ?? null;
  if (Object.hasOwn(body, 'instructions')) changes.instructions = body.instructions ?? null;
  if (Object.hasOwn(body, 'latitude')) {
    changes.coordinates =
      body.latitude == null || body.longitude == null
        ? null
        : { latitude: body.latitude, longitude: body.longitude };
  }
  return changes;
}
export class SavedPlaceController {
  constructor(private readonly savedPlaceService: SavedPlaceService) {}
  listPlaces = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    return reply.status(200).send(await this.savedPlaceService.list(auth.userId));
  };
  addPlace = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const parsed = createPlaceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }
    const body = parsed.data;
    const input = { ...toPlaceWrite(body), label: body.label };
    const created = await this.savedPlaceService.add(auth.userId, input, request.id);
    return reply.status(201).send(created);
  };
  updatePlace = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
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
    const parsed = updatePlaceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyFromUserError(
        request,
        reply,
        new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
      );
    }
    const updated = await this.savedPlaceService.update(
      auth.userId,
      idParsed.data,
      toPlaceWrite(parsed.data),
      request.id,
    );
    return reply.status(200).send(updated);
  };
  removePlace = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
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
    await this.savedPlaceService.remove(auth.userId, idParsed.data, request.id);
    return reply.status(204).send();
  };
}
