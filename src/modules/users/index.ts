import { asClass, AwilixContainer } from 'awilix';
import { registerFileReference } from '@modules/files';
import { UserProfileRepository } from './repositories';
import { UserService } from './user.service';
import { PhoneChangeService } from './phone-change.service';
import { EmergencyContactService } from './emergency-contact.service';
import { SavedPlaceService } from './saved-place.service';
import { AccountService } from './account.service';
import { AccountErasureJob } from './jobs/account-erasure.job';
import { UserMetrics } from './user.metrics';

export { UserService, type UserAccountView, type UserProfileView } from './user.service';
export {
  EmergencyContactService,
  type AddEmergencyContactInput,
  type EmergencyContactView,
} from './emergency-contact.service';
export {
  SavedPlaceService,
  type AddSavedPlaceInput,
  type SavedPlaceView,
} from './saved-place.service';
export {
  AccountService,
  type DeactivationReason,
  type DeletionRequestResult,
} from './account.service';
export {
  PhoneChangeService,
  maskPhone,
  type PhoneChangeChallenge,
  type PhoneChangeResult,
  type RequestPhoneChangeInput,
  type VerifyPhoneChangeInput,
} from './phone-change.service';
export { UserMetrics, type UserMetricFields } from './user.metrics';
export {
  UserError,
  ImmutableFieldError,
  UserValidationError,
  UserNotFoundError,
  PhoneUnchangedError,
  PhoneInUseError,
  LimitExceededError,
  LabelConflictError,
  AccountHasObligationsError,
  AccountNotDeactivatedError,
  type ErrorDetail,
} from './errors';
export {
  UserProfileRepository,
  EmergencyContactRepository,
  SavedPlaceRepository,
  ObligationsRepository,
  DeletionRequestRepository,
  registerUserRepositories,
  type DeletionRequest,
  type Obligation,
  type Coordinates,
  type UpdateUserProfileInput,
  type UpdateEmergencyContactInput,
  type UpdateSavedPlaceInput,
} from './repositories';
export { USER_EVENT_CATALOG, USER_PRODUCER, userEvent } from './events';
export { AccountErasureJob, type ErasureResult } from './jobs/account-erasure.job';

/**
 * Registers the USER services into the Awilix container.
 *
 * CLASSIC injection resolves dependencies by name — `userService` needs
 * `userRepository`, `userProfileRepository`, `roleRepository`,
 * `transactionManager`, and `eventPublisher`; `phoneChangeService` additionally
 * needs `otpService`, `otpRepository`, `sessionService`, `sessionRepository`,
 * `tokenService`, `epochService`, `redisService`, `userMetrics`, and `jwtConfig`;
 * the two collection services need their own repository plus `userRepository`
 * (whose row they lock to make the cap check safe under concurrency); and
 * `accountService` needs `userRepository` and `authService` itself, since AUTH
 * owns `users.status`.
 * `userService` also needs `fileService`, for the avatar attach (R-FILE-27).
 * Must therefore run after the auth repositories, the token/OTP/session modules,
 * the auth service, the events module, and the files module.
 * @param container The application DI container.
 */
export function registerUserService(container: AwilixContainer): void {
  container.register({
    userMetrics: asClass(UserMetrics).singleton(),
    userService: asClass(UserService).singleton(),
    phoneChangeService: asClass(PhoneChangeService).singleton(),
    emergencyContactService: asClass(EmergencyContactService).singleton(),
    savedPlaceService: asClass(SavedPlaceService).singleton(),
    accountService: asClass(AccountService).singleton(),
    // Scheduled on `users-maintenance` (handbook volume 08); the worker resolves
    // it by this name.
    accountErasureJob: asClass(AccountErasureJob).singleton(),
  });

  // The first live reference any module claims (files doc 03 §6, §7.2).
  //
  // Two things turn on this one call. `DELETE /files/{id}` starts refusing an
  // avatar somebody is wearing with `409 FILE_IN_USE`, and **retention starts
  // processing `PROFILE_IMAGE` at all** — the job skips any purpose no module
  // has claimed, because a purpose nobody can be asked about must never have its
  // bytes destroyed on a shrug (R-FILE-19).
  //
  // Resolved lazily inside the closure so registration order stays irrelevant:
  // this runs at boot, and the repository is only needed when a file is released.
  registerFileReference('PROFILE_IMAGE', {
    module: 'users',
    isReferenced: (fileId, tx) =>
      container.resolve<UserProfileRepository>('userProfileRepository').isProfileImage(fileId, tx),
  });
}
