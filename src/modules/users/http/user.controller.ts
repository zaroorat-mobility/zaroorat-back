import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { AuthError } from '@modules/auth/errors';
import { replyFromAuthError } from '@modules/auth/http';
import type {
  UpdateEmergencyContactInput,
  UpdateSavedPlaceInput,
  UpdateUserProfileInput,
} from '../repositories';
import { UserService } from '../user.service';
import { PhoneChangeService } from '../phone-change.service';
import {
  EmergencyContactService,
  type AddEmergencyContactInput,
} from '../emergency-contact.service';
import { SavedPlaceService, type AddSavedPlaceInput } from '../saved-place.service';
import { AccountService } from '../account.service';
import { ImmutableFieldError, UserError, UserValidationError } from '../errors';
import { replyFromUserError, replyUserError } from './error-response';
import {
  createContactSchema,
  createPlaceSchema,
  deactivateSchema,
  detailsFromZodIssues,
  findImmutableFields,
  itemIdSchema,
  parseDateOnly,
  phoneChangeSchema,
  phoneVerifySchema,
  updateContactSchema,
  updatePlaceSchema,
  updateProfileSchema,
  type CreateContactBody,
  type CreatePlaceBody,
  type DeactivateBody,
  type UpdateContactBody,
  type UpdatePlaceBody,
  type UpdateProfileBody,
} from './user.schemas';

/**
 * Translate a validated body into a repository write.
 *
 * Only keys **present** on the parsed body are copied, which is what preserves
 * the absent-vs-`null` distinction end to end (R-USER-5): Zod drops absent
 * optional keys entirely, so `Object.hasOwn` is an accurate record of what the
 * client actually sent. `dateOfBirth` is converted from its calendar-date string
 * to the UTC-midnight instant the `date` column stores (doc 03 §3.1).
 */
function toProfileUpdate(body: UpdateProfileBody): UpdateUserProfileInput {
  const changes: UpdateUserProfileInput = {};
  if (Object.hasOwn(body, 'firstName')) changes.firstName = body.firstName ?? null;
  if (Object.hasOwn(body, 'lastName')) changes.lastName = body.lastName ?? null;
  if (Object.hasOwn(body, 'dateOfBirth')) {
    changes.dateOfBirth = body.dateOfBirth == null ? null : parseDateOnly(body.dateOfBirth);
  }
  if (Object.hasOwn(body, 'gender')) changes.gender = body.gender ?? null;
  if (Object.hasOwn(body, 'profileImage')) changes.profileImage = body.profileImage ?? null;
  if (Object.hasOwn(body, 'languageCode')) changes.languageCode = body.languageCode ?? null;
  return changes;
}

/**
 * Translate a validated contact body into a repository write.
 *
 * Same present-key discipline as {@link toProfileUpdate}: only what the client
 * actually sent is copied, so an absent key stays absent all the way down.
 */
function toContactWrite(body: UpdateContactBody): UpdateEmergencyContactInput {
  const changes: UpdateEmergencyContactInput = {};
  if (body.contactName !== undefined) changes.contactName = body.contactName;
  if (body.phoneNumber !== undefined) changes.phoneNumber = body.phoneNumber;
  if (Object.hasOwn(body, 'relationship')) changes.relationship = body.relationship ?? null;
  if (body.priority !== undefined) changes.priority = body.priority;
  return changes;
}

/**
 * Translate a validated place body into a repository write.
 *
 * `latitude`/`longitude` collapse into one `coordinates` key, because they are
 * only meaningful as a pair and because the derived `location` has to move
 * whenever either does (doc 03 §4.4). The schema has already guaranteed they
 * arrive together, so reading one implies the other.
 */
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

/**
 * HTTP controllers for the USER API (user doc 02).
 *
 * Each handler validates the request, calls {@link UserService}, and shapes the
 * response — no business logic. Domain (`UserError`) failures map to the doc 04
 * envelope; anything else propagates to the global handler as a 500.
 *
 * **The subject always comes from `request.auth.userId`.** No handler here reads
 * a user identifier from params, query, or body — that is the rule doc 02 §3
 * states and USER-INV-2 depends on.
 */
export class UserController {
  /**
   * @param userService The user/profile orchestrator.
   * @param phoneChangeService The two-step phone-number change (doc 02 §2.4).
   * @param emergencyContactService The emergency-contact collection (doc 02 §2.5).
   * @param savedPlaceService The saved-places collection (doc 02 §2.6).
   * @param accountService Deactivation and delete-request (doc 02 §2.7–§2.8).
   */
  constructor(
    private readonly userService: UserService,
    private readonly phoneChangeService: PhoneChangeService,
    private readonly emergencyContactService: EmergencyContactService,
    private readonly savedPlaceService: SavedPlaceService,
    private readonly accountService: AccountService,
  ) {}

  /** `GET /me` — read the caller's account, profile, and live roles. */
  getMe = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    try {
      return reply.status(200).send(await this.userService.getMe(auth.userId));
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  /** `PATCH /me/profile` — partial profile update. */
  updateProfile = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    const body = request.body ?? {};

    // Immutable fields are checked against the RAW body, before schema parsing:
    // the strict schema would otherwise report them as unknown keys and the
    // client would get `VALIDATION` where doc 02 §2.2 promises `IMMUTABLE_FIELD`.
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

    try {
      const profile = await this.userService.updateProfile(
        auth.userId,
        toProfileUpdate(parsed.data),
        request.id,
      );
      return reply.status(200).send(profile);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  /** `POST /me/phone/change` — send an OTP to the number the caller wants to move to. */
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

    try {
      const challenge = await this.phoneChangeService.requestPhoneChange({
        userId: auth.userId,
        newPhoneNumber: parsed.data.newPhoneNumber,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });
      return reply.status(202).send(challenge);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  /** `POST /me/phone/verify` — consume the OTP, re-bind the number, re-issue tokens. */
  verifyPhoneChange = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    // Required, not optional: this flow revokes every session, so a dropped
    // response that the client retries without a key would revoke the session the
    // first attempt just issued (doc 02 §5).
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

    try {
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
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  /** `GET /me/emergency-contacts` — the caller's contacts, priority ascending. */
  listContacts = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    this.respond(request, reply, 200, (userId) => this.emergencyContactService.list(userId));

  /** `POST /me/emergency-contacts` — add a contact, subject to the cap. */
  addContact = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const body = this.parse<CreateContactBody>(request, reply, createContactSchema);
    if (!body) return reply;
    const input: AddEmergencyContactInput = {
      contactName: body.contactName,
      phoneNumber: body.phoneNumber,
      ...toContactWrite(body),
    };
    return this.respond(request, reply, 201, (userId) =>
      this.emergencyContactService.add(userId, input, request.id),
    );
  };

  /** `PATCH /me/emergency-contacts/:id` — partial edit of an owned contact. */
  updateContact = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const id = this.parseId(request, reply);
    if (!id) return reply;
    const body = this.parse<UpdateContactBody>(request, reply, updateContactSchema);
    if (!body) return reply;
    return this.respond(request, reply, 200, (userId) =>
      this.emergencyContactService.update(userId, id, toContactWrite(body), request.id),
    );
  };

  /** `DELETE /me/emergency-contacts/:id` — remove an owned contact. */
  removeContact = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const id = this.parseId(request, reply);
    if (!id) return reply;
    return this.respond(request, reply, 204, (userId) =>
      this.emergencyContactService.remove(userId, id, request.id),
    );
  };

  /** `GET /me/saved-places` — the caller's places, label ascending. */
  listPlaces = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    this.respond(request, reply, 200, (userId) => this.savedPlaceService.list(userId));

  /** `POST /me/saved-places` — add a place, subject to the cap and label uniqueness. */
  addPlace = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const body = this.parse<CreatePlaceBody>(request, reply, createPlaceSchema);
    if (!body) return reply;
    const input: AddSavedPlaceInput = { ...toPlaceWrite(body), label: body.label };
    return this.respond(request, reply, 201, (userId) =>
      this.savedPlaceService.add(userId, input, request.id),
    );
  };

  /** `PATCH /me/saved-places/:id` — partial edit of an owned place. */
  updatePlace = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const id = this.parseId(request, reply);
    if (!id) return reply;
    const body = this.parse<UpdatePlaceBody>(request, reply, updatePlaceSchema);
    if (!body) return reply;
    return this.respond(request, reply, 200, (userId) =>
      this.savedPlaceService.update(userId, id, toPlaceWrite(body), request.id),
    );
  };

  /** `DELETE /me/saved-places/:id` — remove an owned place. */
  removePlace = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const id = this.parseId(request, reply);
    if (!id) return reply;
    return this.respond(request, reply, 204, (userId) =>
      this.savedPlaceService.remove(userId, id, request.id),
    );
  };

  /** `POST /me/deactivate` — end the caller's own account (doc 02 §2.7). */
  deactivate = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const body = this.parse<DeactivateBody>(request, reply, deactivateSchema);
    if (!body) return reply;
    return this.respond(request, reply, 204, (userId) =>
      this.accountService.deactivate(userId, body.reason ?? null, request.id),
    );
  };

  /** `POST /me/delete-request` — deactivate and record a request for erasure (doc 02 §2.8). */
  requestDeletion = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    this.respond(request, reply, 202, (userId) =>
      this.accountService.requestDeletion(userId, request.id),
    );

  /**
   * Authenticate, run, and shape — the plumbing every collection handler repeats.
   *
   * The subject is taken from the token here and nowhere else, so no collection
   * handler is in a position to read a user id from `params`, `query`, or `body`
   * even by accident (doc 02 §3, USER-INV-2).
   *
   * @param status The success status; `204` sends no body.
   * @param action Receives the authenticated subject and returns the response body.
   */
  private async respond(
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    action: (userId: string) => Promise<unknown>,
  ): Promise<FastifyReply> {
    const auth = request.auth;
    if (!auth) return replyUserError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    try {
      const body = await action(auth.userId);
      return status === 204 ? reply.status(204).send() : reply.status(status).send(body);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  }

  /**
   * Parse a body, or send `VALIDATION` and return `null`.
   *
   * The details come from {@link detailsFromZodIssues}, which strips the submitted
   * value Zod attaches to an issue — an address or a contact's name must not ride
   * back out in an error body (doc 04 §5).
   */
  private parse<T>(request: FastifyRequest, reply: FastifyReply, schema: z.ZodType<T>): T | null {
    const parsed = schema.safeParse(request.body ?? {});
    if (parsed.success) return parsed.data;
    replyFromUserError(
      request,
      reply,
      new UserValidationError(detailsFromZodIssues(parsed.error.issues)),
    );
    return null;
  }

  /**
   * Read the path `:id`, or send `VALIDATION` and return `null`.
   *
   * A malformed id is rejected before it reaches a `uuid` column comparison. It is
   * a `400` rather than the `404` a valid-but-unknown id gets, and that difference
   * leaks nothing: it distinguishes a broken client from a stale one, never one
   * user's rows from another's (doc 04 §5).
   */
  private parseId(request: FastifyRequest, reply: FastifyReply): string | null {
    const parsed = itemIdSchema.safeParse((request.params as { id?: unknown }).id);
    if (parsed.success) return parsed.data;
    replyFromUserError(
      request,
      reply,
      new UserValidationError([{ field: 'id', code: 'INVALID_FORMAT' }]),
    );
    return null;
  }

  /**
   * Map a domain error to its envelope; rethrow anything unexpected.
   *
   * An `AuthError` raised inside a USER flow — an OTP failure on the phone-change
   * verify, AUTH's per-phone rate limiter — is answered with AUTH's envelope and
   * AUTH's `auth.*` message key, not re-badged as a USER error. Doc 04 §2.2: the
   * client needs one implementation of these codes, not two.
   */
  private handle(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
    if (err instanceof UserError) return replyFromUserError(request, reply, err);
    if (err instanceof AuthError) return replyFromAuthError(request, reply, err);
    throw err;
  }
}
