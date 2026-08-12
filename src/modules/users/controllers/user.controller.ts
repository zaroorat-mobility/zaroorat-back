import type { FastifyReply, FastifyRequest } from 'fastify';

import { IdempotencyInFlightError } from '@core/cache';
import { AuthError } from '@modules/auth/errors';
import { replyFromAuthError } from '@modules/auth/http';
import { FileError } from '@modules/files';
import { replyFromFileError } from '@modules/files/http';

import type { UserService } from '../services/user.service';
import type { PhoneChangeService } from '../services/phone/phone-change.service';
import type { EmergencyContactService } from '../services/emergency-contact/emergency-contact.service';
import type { SavedPlaceService } from '../services/saved-place/saved-place.service';
import type { AccountService } from '../services/account/account.service';
import { UserError } from '../errors';
import { replyFromUserError, replyUserError } from '../schemas';

import { ProfileController } from './profile.controller';
import { PhoneChangeController } from './phone-change.controller';
import { EmergencyContactController } from './emergency-contact.controller';
import { SavedPlaceController } from './saved-place.controller';
import { AccountController } from './account.controller';

export class UserController {
  private readonly profileController: ProfileController;
  private readonly phoneChangeController: PhoneChangeController;
  private readonly emergencyContactController: EmergencyContactController;
  private readonly savedPlaceController: SavedPlaceController;
  private readonly accountController: AccountController;

  constructor(
    userService: UserService,
    phoneChangeService: PhoneChangeService,
    emergencyContactService: EmergencyContactService,
    savedPlaceService: SavedPlaceService,
    accountService: AccountService,
  ) {
    this.profileController = new ProfileController(userService);
    this.phoneChangeController = new PhoneChangeController(phoneChangeService);
    this.emergencyContactController = new EmergencyContactController(emergencyContactService);
    this.savedPlaceController = new SavedPlaceController(savedPlaceService);
    this.accountController = new AccountController(accountService);
  }

  getMe = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.profileController.getMe(req, reply));

  updateProfile = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.profileController.updateProfile(req, reply));

  requestPhoneChange = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.phoneChangeController.requestPhoneChange(req, reply));

  verifyPhoneChange = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.phoneChangeController.verifyPhoneChange(req, reply));

  listContacts = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.emergencyContactController.listContacts(req, reply));

  addContact = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.emergencyContactController.addContact(req, reply));

  updateContact = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.emergencyContactController.updateContact(req, reply));

  removeContact = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.emergencyContactController.removeContact(req, reply));

  listPlaces = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.savedPlaceController.listPlaces(req, reply));

  addPlace = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.savedPlaceController.addPlace(req, reply));

  updatePlace = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.savedPlaceController.updatePlace(req, reply));

  removePlace = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.savedPlaceController.removePlace(req, reply));

  deactivate = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.accountController.deactivate(req, reply));

  requestDeletion = (req: FastifyRequest, reply: FastifyReply) =>
    this.wrap(req, reply, () => this.accountController.requestDeletion(req, reply));

  private async wrap(
    request: FastifyRequest,
    reply: FastifyReply,
    fn: () => Promise<FastifyReply>,
  ): Promise<FastifyReply> {
    try {
      return await fn();
    } catch (err) {
      return this.handle(request, reply, err);
    }
  }

  private handle(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
    if (err instanceof UserError) return replyFromUserError(request, reply, err);
    if (err instanceof AuthError) return replyFromAuthError(request, reply, err);
    if (err instanceof FileError) return replyFromFileError(request, reply, err);
    if (err instanceof IdempotencyInFlightError) {
      return replyUserError(request, reply, err.code, err.message);
    }
    throw err;
  }
}
