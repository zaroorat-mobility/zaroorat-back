import type { FastifyInstance } from 'fastify';

import { container } from '@core/di';
import { UserService } from '../services/user.service';
import { PhoneChangeService } from '../services/phone/phone-change.service';
import { EmergencyContactService } from '../services/emergency-contact/emergency-contact.service';
import { SavedPlaceService } from '../services/saved-place/saved-place.service';
import { AccountService } from '../services/account/account.service';
import { UserController } from '../controllers/user.controller';
import {
  accountResponse,
  contactListResponse,
  contactResponse,
  createContactBodySchema,
  createPlaceBodySchema,
  deactivateBodySchema,
  deletionRequestResponse,
  idempotencyHeaderSchema,
  itemIdParamSchema,
  noContentResponse,
  phoneChangeBodySchema,
  phoneChangeChallengeResponse,
  phoneChangeResultResponse,
  phoneVerifyBodySchema,
  placeListResponse,
  placeResponse,
  profileResponse,
  updateContactBodySchema,
  updatePlaceBodySchema,
  updateProfileBodySchema,
  userErrorResponseSchema as err,
} from '../schemas';

const commonErrors = { 400: err, 401: err, 403: err, 500: err } as const;

const itemErrors = { ...commonErrors, 404: err, 409: err } as const;

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  const controller = new UserController(
    container.resolve<UserService>('userService'),
    container.resolve<PhoneChangeService>('phoneChangeService'),
    container.resolve<EmergencyContactService>('emergencyContactService'),
    container.resolve<SavedPlaceService>('savedPlaceService'),
    container.resolve<AccountService>('accountService'),
  );

  const untamperedDevice = [app.authorize({ requireUntamperedDevice: true })];

  app.get(
    '/me',
    {
      schema: {
        tags: ['Users'],
        summary: 'Get current user profile',
        description: 'Account state, roles, and profile projection for the authenticated user.',
        security: [{ bearerAuth: [] }],
        response: { 200: accountResponse, ...commonErrors, 404: err },
      },
    },
    controller.getMe,
  );

  app.patch(
    '/me/profile',
    {
      schema: {
        tags: ['Users'],
        summary: 'Update profile details',
        description:
          'Partial update. Identity fields (phoneNumber, status, roles, referralCode, …) are ' +
          'rejected with 400 IMMUTABLE_FIELD.',
        security: [{ bearerAuth: [] }],
        body: updateProfileBodySchema,
        response: { 200: profileResponse, ...itemErrors },
      },
    },
    controller.updateProfile,
  );

  app.post(
    '/me/phone/change',
    {
      preHandler: untamperedDevice,
      schema: {
        tags: ['Users'],
        summary: 'Request phone number change',
        description: 'Sends an OTP to the new number. Rate limited per account.',
        security: [{ bearerAuth: [] }],
        body: phoneChangeBodySchema,
        response: {
          202: phoneChangeChallengeResponse,
          ...commonErrors,
          404: err,
          409: err,
          429: err,
        },
      },
    },
    controller.requestPhoneChange,
  );

  app.post(
    '/me/phone/verify',
    {
      preHandler: untamperedDevice,
      schema: {
        tags: ['Users'],
        summary: 'Verify phone number change',
        description:
          'Confirms the OTP, re-binds the number, revokes every existing session, and returns a ' +
          'fresh token pair.',
        security: [{ bearerAuth: [] }],
        headers: idempotencyHeaderSchema,
        body: phoneVerifyBodySchema,
        response: {
          200: phoneChangeResultResponse,
          ...commonErrors,
          404: err,
          409: err,
          410: err,
          429: err,
        },
      },
    },
    controller.verifyPhoneChange,
  );

  app.get(
    '/me/emergency-contacts',
    {
      schema: {
        tags: ['Users'],
        summary: 'List emergency contacts',
        security: [{ bearerAuth: [] }],
        response: { 200: contactListResponse, ...commonErrors },
      },
    },
    controller.listContacts,
  );

  app.post(
    '/me/emergency-contacts',
    {
      schema: {
        tags: ['Users'],
        summary: 'Add emergency contact',
        description: 'Capped per account; 409 LIMIT_EXCEEDED once the cap is reached.',
        security: [{ bearerAuth: [] }],
        body: createContactBodySchema,
        response: { 201: contactResponse, ...itemErrors },
      },
    },
    controller.addContact,
  );

  app.patch(
    '/me/emergency-contacts/:id',
    {
      schema: {
        tags: ['Users'],
        summary: 'Update emergency contact',
        security: [{ bearerAuth: [] }],
        params: itemIdParamSchema,
        body: updateContactBodySchema,
        response: { 200: contactResponse, ...itemErrors },
      },
    },
    controller.updateContact,
  );

  app.delete(
    '/me/emergency-contacts/:id',
    {
      schema: {
        tags: ['Users'],
        summary: 'Remove emergency contact',
        security: [{ bearerAuth: [] }],
        params: itemIdParamSchema,
        response: { 204: noContentResponse, ...itemErrors },
      },
    },
    controller.removeContact,
  );

  app.get(
    '/me/saved-places',
    {
      schema: {
        tags: ['Users'],
        summary: 'List saved places',
        security: [{ bearerAuth: [] }],
        response: { 200: placeListResponse, ...commonErrors },
      },
    },
    controller.listPlaces,
  );

  app.post(
    '/me/saved-places',
    {
      schema: {
        tags: ['Users'],
        summary: 'Add saved place',
        description:
          'Capped per account (409 LIMIT_EXCEEDED). Labels are unique per user, ' +
          'case-insensitively (409 CONFLICT).',
        security: [{ bearerAuth: [] }],
        body: createPlaceBodySchema,
        response: { 201: placeResponse, ...itemErrors },
      },
    },
    controller.addPlace,
  );

  app.patch(
    '/me/saved-places/:id',
    {
      schema: {
        tags: ['Users'],
        summary: 'Update saved place',
        security: [{ bearerAuth: [] }],
        params: itemIdParamSchema,
        body: updatePlaceBodySchema,
        response: { 200: placeResponse, ...itemErrors },
      },
    },
    controller.updatePlace,
  );

  app.delete(
    '/me/saved-places/:id',
    {
      schema: {
        tags: ['Users'],
        summary: 'Remove saved place',
        security: [{ bearerAuth: [] }],
        params: itemIdParamSchema,
        response: { 204: noContentResponse, ...itemErrors },
      },
    },
    controller.removePlace,
  );

  app.post(
    '/me/deactivate',
    {
      schema: {
        tags: ['Users'],
        summary: 'Deactivate account',
        description:
          'Closes the account and revokes every session. Refused with 409 ' +
          'ACCOUNT_HAS_OBLIGATIONS while a ride, wallet balance, or dispute is open. A ' +
          'deactivated account can no longer authenticate; only an operator restore ' +
          'brings it back.',
        security: [{ bearerAuth: [] }],
        body: deactivateBodySchema,
        response: { 204: noContentResponse, ...itemErrors },
      },
    },
    controller.deactivate,
  );

  app.post(
    '/me/delete-request',
    {
      schema: {
        tags: ['Users'],
        summary: 'Request account deletion',
        description:
          'Deactivates now and records an erasure date. Same obligation gate as ' +
          '/me/deactivate. Cancelling a request is an operator action — there is no ' +
          'self-service endpoint for it.',
        security: [{ bearerAuth: [] }],
        response: { 202: deletionRequestResponse, ...itemErrors },
      },
    },
    controller.requestDeletion,
  );
}
