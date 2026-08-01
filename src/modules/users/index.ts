import { asClass, AwilixContainer } from 'awilix';
import { UserService } from './user.service';
import { PhoneChangeService } from './phone-change.service';
import { EmergencyContactService } from './emergency-contact.service';
import { SavedPlaceService } from './saved-place.service';
import { AccountService } from './account.service';
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
  registerUserRepositories,
  type Obligation,
  type Coordinates,
  type UpdateUserProfileInput,
  type UpdateEmergencyContactInput,
  type UpdateSavedPlaceInput,
} from './repositories';
export { USER_EVENT_CATALOG, USER_PRODUCER, userEvent } from './events';

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
 * Must therefore run after the auth repositories, the token/OTP/session modules,
 * the auth service, and the events module.
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
  });
}
