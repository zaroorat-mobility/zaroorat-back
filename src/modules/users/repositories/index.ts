import { asClass, AwilixContainer } from 'awilix';

import { UserProfileRepository } from './user-profile.repository';
import { EmergencyContactRepository } from './emergency-contact.repository';
import { SavedPlaceRepository } from './saved-place.repository';
import { ObligationsRepository } from './obligations.repository';

export { UserProfileRepository, type UpdateUserProfileInput } from './user-profile.repository';
export { ObligationsRepository, type Obligation } from './obligations.repository';
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

/**
 * Registers the USER repository layer into the Awilix container.
 *
 * Each repository is a singleton constructed with the shared `databaseService`
 * (CLASSIC injection resolves the constructor param by name), exactly as the
 * auth repositories do.
 * @param container The application DI container.
 */
export function registerUserRepositories(container: AwilixContainer): void {
  container.register({
    userProfileRepository: asClass(UserProfileRepository).singleton(),
    emergencyContactRepository: asClass(EmergencyContactRepository).singleton(),
    savedPlaceRepository: asClass(SavedPlaceRepository).singleton(),
    obligationsRepository: asClass(ObligationsRepository).singleton(),
  });
}
