import { asClass, AwilixContainer } from 'awilix';
import { UserProfileRepository } from './user-profile.repository';
import { EmergencyContactRepository } from './emergency-contact.repository';
import { SavedPlaceRepository } from './saved-place.repository';
import { ObligationRepository } from './obligation.repository';
import { DeletionRequestRepository } from './deletion-request.repository';
export { UserRepository } from './user.repository';
export { UserProfileRepository, type UpdateUserProfileInput } from './user-profile.repository';
export {
  ObligationRepository,
  ObligationsRepository,
  type Obligation,
} from './obligation.repository';
export { DeletionRequestRepository, type DeletionRequest } from './deletion-request.repository';
export {
  EmergencyContactRepository,
  type CreateEmergencyContactInput,
  type UpdateEmergencyContactInput,
} from './emergency-contact.repository';
export {
  SavedPlaceRepository,
  type Coordinates,
  type CreateSavedPlaceInput,
  type UpdateSavedPlaceInput,
} from './saved-place.repository';
export function registerUserRepositories(container: AwilixContainer): void {
  container.register({
    userProfileRepository: asClass(UserProfileRepository).singleton(),
    emergencyContactRepository: asClass(EmergencyContactRepository).singleton(),
    savedPlaceRepository: asClass(SavedPlaceRepository).singleton(),
    obligationsRepository: asClass(ObligationRepository).singleton(),
    deletionRequestRepository: asClass(DeletionRequestRepository).singleton(),
  });
}
