import { TransactionManager, UniqueConstraintError } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { EventPublisher } from '@core/events';
import { userConfig } from '@config/user';
import type { UserRepository } from '@modules/auth/repositories';
import {
  SavedPlaceRepository,
  type CreateSavedPlaceInput,
  type UpdateSavedPlaceInput,
} from './repositories';
import { userEvent } from './events';
import { LabelConflictError, LimitExceededError, UserNotFoundError } from './errors';
import type { SavedPlace } from './types';

/** A saved place as the API returns it (doc 02 §2.6). */
export interface SavedPlaceView {
  id: string;
  label: string;
  address: string | null;
  buildingName: string | null;
  landmark: string | null;
  floor: string | null;
  instructions: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: Date;
}

/** What a caller may set when adding a place. */
export type AddSavedPlaceInput = Omit<CreateSavedPlaceInput, 'userId'>;

/**
 * Present a row.
 *
 * The decimals are rendered as numbers, which is what the client sends and what
 * doc 02 §2.6 shows; `Decimal(10,7)` is well inside a double's exact range, so
 * this round-trips the stored value rather than approximating it. `location` is
 * never returned — the client sends lat/lng and reads lat/lng back; the geography
 * exists for `rides`/`geo` to index (doc 03 §3.3).
 */
function toView(place: SavedPlace): SavedPlaceView {
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

/**
 * The saved-places collection (user doc 02 §2.6, R-USER-24/25).
 *
 * Every method takes its subject from the caller's verified token and scopes each
 * query by it, so an id belonging to someone else is indistinguishable from one
 * that never existed (USER-INV-2).
 *
 * **Home and work addresses are among the most sensitive rows the platform
 * holds** (doc 03 §6). No event carries an address, a landmark, instructions, or
 * a coordinate — only the item id and the user-chosen `label` (doc 05 §3.4).
 */
export class SavedPlaceService {
  /**
   * @param savedPlaceRepository This collection's persistence.
   * @param userRepository AUTH's identity repository, for the owner-row lock.
   * @param transactionManager Unit-of-work boundary for the write plus its event.
   * @param eventPublisher Transactional-outbox publisher.
   */
  constructor(
    private readonly savedPlaceRepository: SavedPlaceRepository,
    private readonly userRepository: UserRepository,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}

  /**
   * List the caller's places, label ascending, case-insensitively (doc 02 §2.6).
   * @param userId Subject from the verified token.
   * @returns Every place — the cap bounds the list, so there is no pagination.
   */
  async list(userId: string): Promise<SavedPlaceView[]> {
    const places = await this.savedPlaceRepository.findAllByUser(userId);
    return places.map(toView);
  }

  /**
   * Add a place, if the caller is under the cap and the label is free.
   *
   * The count and the insert share a transaction that opens by locking the owner
   * row, so concurrent creates serialise and the count stays authoritative
   * (USER-INV-7). The label check needs no such lock: `uq_saved_places_user_label`
   * settles it, and a loser's insert simply raises.
   *
   * @param userId Subject from the verified token.
   * @param input Label plus optional address parts and coordinates.
   * @param requestId Correlation id for the event envelope.
   * @returns The created place.
   * @throws {LimitExceededError} The cap is already reached (R-USER-24).
   * @throws {LabelConflictError} The label is taken, case-insensitively.
   */
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
          // The label is user-chosen and low-risk, and `rides` uses it for UI
          // freshness. The address and the coordinates stay in the row (doc 05 §3.4).
          data: { userId, placeId: created.id, label: created.label },
        }),
        tx,
      );
      return created;
    });

    return toView(place);
  }

  /**
   * Apply a partial edit to one of the caller's places.
   * @param userId Subject from the verified token.
   * @param id Place UUID.
   * @param changes Keys to write; absent ⇒ unchanged, `null` ⇒ cleared.
   * @param requestId Correlation id for the event envelope.
   * @returns The place as it stands after the write.
   * @throws {UserNotFoundError} No such place, **or** it belongs to someone else.
   * @throws {LabelConflictError} The new label is taken, case-insensitively.
   */
  async update(
    userId: string,
    id: string,
    changes: UpdateSavedPlaceInput,
    requestId: string | null = null,
  ): Promise<SavedPlaceView> {
    const changedFields = Object.keys(changes);

    // An empty PATCH is a no-op: no write, and no event claiming a change that did
    // not happen. The read still enforces ownership, so the 404 is unaffected.
    if (changedFields.length === 0) {
      const existing = await this.savedPlaceRepository.findOwned(userId, id);
      if (!existing) throw new UserNotFoundError('Saved place not found');
      return toView(existing);
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

    return toView(place);
  }

  /**
   * Delete one of the caller's places.
   *
   * Idempotent in effect but not in status (doc 02 §2.6): the first call reports
   * success, a retry reports `NOT_FOUND` because the item is genuinely gone.
   * @param userId Subject from the verified token.
   * @param id Place UUID.
   * @param requestId Correlation id for the event envelope.
   * @throws {UserNotFoundError} No such place, **or** it belongs to someone else.
   */
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

  /**
   * Run a write transaction, translating a label collision into its API error.
   *
   * The pre-check a caller could do before inserting would still lose a race, so
   * there is no pre-check: `uq_saved_places_user_label` is the enforcement (doc 03
   * §5) and this is where its violation becomes `409 CONFLICT`. The mapping lives
   * outside the callback because a violation aborts the whole transaction — it
   * cannot be caught and recovered from inside one.
   */
  private async write<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.transactionManager.execute(callback);
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw new LabelConflictError();
      throw err;
    }
  }
}
