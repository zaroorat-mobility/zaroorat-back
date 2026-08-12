import { TransactionManager, UniqueConstraintError } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { EventPublisher } from '@core/events';
import { userConfig } from '../../config';
import type { UserRepository } from '@modules/auth/repositories';
import {
  SavedPlaceRepository,
  type CreateSavedPlaceInput,
  type UpdateSavedPlaceInput,
} from '../../repositories';
import { userEvent } from '../../events';
import { LabelConflictError, LimitExceededError, UserNotFoundError } from '../../errors';
import type { SavedPlace } from '../../types';
import type { SavedPlaceView } from '../../schemas';

export type AddSavedPlaceInput = Omit<CreateSavedPlaceInput, 'userId'>;

export function toSavedPlaceView(place: SavedPlace): SavedPlaceView {
  return {
    id: place.id,
    label: place.label,
    address: place.address,
    buildingName: place.buildingName,
    landmark: place.landmark,
    floor: place.floor,
    instructions: place.instructions,
    latitude: place.latitude === null ? null : Number(place.latitude),
    longitude: place.longitude === null ? null : Number(place.longitude),
    createdAt: place.createdAt,
  };
}

export class SavedPlaceService {
  constructor(
    private readonly savedPlaceRepository: SavedPlaceRepository,
    private readonly userRepository: UserRepository,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async list(userId: string): Promise<SavedPlaceView[]> {
    const places = await this.savedPlaceRepository.findAllByUser(userId);
    return places.map(toSavedPlaceView);
  }

  async add(
    userId: string,
    input: AddSavedPlaceInput,
    requestId: string | null = null,
  ): Promise<SavedPlaceView> {
    const place = await this.write(async (tx) => {
      await this.userRepository.lockForUpdate(userId, tx);
      const count = await this.savedPlaceRepository.countByUser(userId, tx);
      if (count >= userConfig.maxSavedPlaces) {
        throw new LimitExceededError('savedPlaces', userConfig.maxSavedPlaces);
      }

      const created = await this.savedPlaceRepository.create({ userId, ...input }, tx);
      await this.eventPublisher.publish(
        userEvent('user.saved_place.added', {
          subjectUserId: userId,
          requestId,
          data: { userId, placeId: created.id, label: created.label },
        }),
        tx,
      );
      return created;
    });

    return toSavedPlaceView(place);
  }

  async update(
    userId: string,
    id: string,
    changes: UpdateSavedPlaceInput,
    requestId: string | null = null,
  ): Promise<SavedPlaceView> {
    const changedFields = Object.keys(changes);

    if (changedFields.length === 0) {
      const existing = await this.savedPlaceRepository.findOwned(userId, id);
      if (!existing) throw new UserNotFoundError('Saved place not found');
      return toSavedPlaceView(existing);
    }

    const place = await this.write(async (tx) => {
      const updated = await this.savedPlaceRepository.updateOwned(userId, id, changes, tx);
      if (!updated) throw new UserNotFoundError('Saved place not found');
      await this.eventPublisher.publish(
        userEvent('user.saved_place.updated', {
          subjectUserId: userId,
          requestId,
          data: { userId, placeId: id, changedFields },
        }),
        tx,
      );
      return updated;
    });

    return toSavedPlaceView(place);
  }

  async remove(userId: string, id: string, requestId: string | null = null): Promise<void> {
    await this.transactionManager.execute(async (tx) => {
      const deleted = await this.savedPlaceRepository.deleteOwned(userId, id, tx);
      if (!deleted) throw new UserNotFoundError('Saved place not found');
      await this.eventPublisher.publish(
        userEvent('user.saved_place.removed', {
          subjectUserId: userId,
          requestId,
          data: { userId, placeId: id },
        }),
        tx,
      );
    });
  }

  private async write<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.transactionManager.execute(callback);
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw new LabelConflictError();
      throw err;
    }
  }
}
