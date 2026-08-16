import { asClass, AwilixContainer } from 'awilix';
import { registerFileReference } from '@modules/files';
import { UserProfileRepository } from './repositories';
import { UserService } from './services/user.service';
import { PhoneChangeService } from './services/phone/phone-change.service';
import { EmergencyContactService } from './services/emergency-contact/emergency-contact.service';
import { SavedPlaceService } from './services/saved-place/saved-place.service';
import { AccountService } from './services/account/account.service';
import { AccountErasureJob } from './jobs';
import { UserMetrics } from './metrics';
export * from './controllers';
export * from './routes';
export * from './schemas';
export * from './services';
export * from './repositories';
export * from './jobs';
export * from './metrics';
export * from './plugins';
export * from './events';
export * from './errors';
export * from './constants';
export * from './config';
export * from './types';
export * from './utils';
export { UserMetrics, type UserMetricFields } from './metrics';
export function registerUserService(container: AwilixContainer): void {
  container.register({
    userMetrics: asClass(UserMetrics).singleton(),
    userService: asClass(UserService).singleton(),
    phoneChangeService: asClass(PhoneChangeService).singleton(),
    emergencyContactService: asClass(EmergencyContactService).singleton(),
    savedPlaceService: asClass(SavedPlaceService).singleton(),
    accountService: asClass(AccountService).singleton(),
    accountErasureJob: asClass(AccountErasureJob).singleton(),
  });
  registerFileReference('PROFILE_IMAGE', {
    module: 'users',
    isReferenced: (fileId, tx) =>
      container.resolve<UserProfileRepository>('userProfileRepository').isProfileImage(fileId, tx),
  });
}
