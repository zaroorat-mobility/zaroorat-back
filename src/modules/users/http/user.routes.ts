import type { FastifyInstance } from 'fastify';

import { container } from '@core/di';
import { UserService } from '../user.service';
import { PhoneChangeService } from '../phone-change.service';
import { EmergencyContactService } from '../emergency-contact.service';
import { SavedPlaceService } from '../saved-place.service';
import { AccountService } from '../account.service';
import { UserController } from './user.controller';

/**
 * Registers the USER API routes (user doc 02) under the caller-provided prefix
 * (mount at `/api/v1/users`).
 *
 * **No route declares `config: { public: true }`.** This module registers no
 * authentication logic of its own: AUTH's global deny-by-default gate
 * authenticates every matched route, so every path here is protected by
 * construction — including any route a future change adds without thinking about
 * it (doc 02 §3). Suspended and deactivated accounts are stopped by the gate's
 * epoch check before a handler runs, which is why no role guard appears here.
 *
 * @param app The Fastify instance (already carrying the deny-by-default gate).
 */
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  const controller = new UserController(
    container.resolve<UserService>('userService'),
    container.resolve<PhoneChangeService>('phoneChangeService'),
    container.resolve<EmergencyContactService>('emergencyContactService'),
    container.resolve<SavedPlaceService>('savedPlaceService'),
    container.resolve<AccountService>('accountService'),
  );

  app.get('/me', controller.getMe);
  app.patch('/me/profile', controller.updateProfile);
  // The phone-number change is this module's sensitive subset. AUTH doc 02 §5.2
  // names "number-change request" as its example of an action a rooted or
  // jailbroken device must not perform, and leaves the *list* to each module
  // while AUTH enforces the flag — so the opt-in belongs here and the check
  // belongs there. Both steps are guarded: refusing only the request would let a
  // challenge obtained from a clean device be redeemed from a tampered one.
  const untamperedDevice = { preHandler: [app.authorize({ requireUntamperedDevice: true })] };
  app.post('/me/phone/change', untamperedDevice, controller.requestPhoneChange);
  app.post('/me/phone/verify', untamperedDevice, controller.verifyPhoneChange);

  app.get('/me/emergency-contacts', controller.listContacts);
  app.post('/me/emergency-contacts', controller.addContact);
  app.patch('/me/emergency-contacts/:id', controller.updateContact);
  app.delete('/me/emergency-contacts/:id', controller.removeContact);

  app.get('/me/saved-places', controller.listPlaces);
  app.post('/me/saved-places', controller.addPlace);
  app.patch('/me/saved-places/:id', controller.updatePlace);
  app.delete('/me/saved-places/:id', controller.removePlace);

  app.post('/me/deactivate', controller.deactivate);
  app.post('/me/delete-request', controller.requestDeletion);
}
