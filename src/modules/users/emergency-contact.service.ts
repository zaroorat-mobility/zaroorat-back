import type { TransactionManager } from '@core/database/TransactionManager';
import type { EventPublisher } from '@core/events';
import { userConfig } from '@config/user';
import type { UserRepository } from '@modules/auth/repositories';
import {
  EmergencyContactRepository,
  type CreateEmergencyContactInput,
  type UpdateEmergencyContactInput,
} from './repositories';
import { userEvent } from './events';
import { LimitExceededError, UserNotFoundError } from './errors';
import type { EmergencyContact } from './types';

/** A contact as the API returns it (doc 02 §2.5). */
export interface EmergencyContactView {
  id: string;
  contactName: string;
  phoneNumber: string;
  relationship: string | null;
  priority: number;
  createdAt: Date;
}

/** What a caller may set when adding a contact. */
export type AddEmergencyContactInput = Omit<CreateEmergencyContactInput, 'userId'>;

/** Present a row. `userId` is omitted — it is always the caller's own. */
function toView(contact: EmergencyContact): EmergencyContactView {
  return {
    id: contact.id,
    contactName: contact.contactName,
    phoneNumber: contact.phoneNumber,
    relationship: contact.relationship,
    priority: contact.priority,
    createdAt: contact.createdAt,
  };
}

/**
 * The emergency-contact collection (user doc 02 §2.5, R-USER-22/23).
 *
 * Every method takes its subject from the caller's verified token and scopes each
 * query by it, so an id belonging to someone else is indistinguishable from one
 * that never existed (R-USER-25, USER-INV-2).
 *
 * **The rows here are personal data about third parties** who never accepted
 * platform terms. That is why no event carries a contact's name or number
 * (doc 05 §3.4) — `sos` reads the row from the database at the moment it needs to
 * call someone, and nothing else ever sees it.
 */
export class EmergencyContactService {
  /**
   * @param emergencyContactRepository This collection's persistence.
   * @param userRepository AUTH's identity repository, for the owner-row lock.
   * @param transactionManager Unit-of-work boundary for the write plus its event.
   * @param eventPublisher Transactional-outbox publisher.
   */
  constructor(
    private readonly emergencyContactRepository: EmergencyContactRepository,
    private readonly userRepository: UserRepository,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}

  /**
   * List the caller's contacts in notification order (R-USER-23).
   * @param userId Subject from the verified token.
   * @returns Every contact, priority ascending — the cap bounds the list, so
   *          there is nothing to paginate (doc 02 §2.5).
   */
  async list(userId: string): Promise<EmergencyContactView[]> {
    const contacts = await this.emergencyContactRepository.findAllByUser(userId);
    return contacts.map(toView);
  }

  /**
   * Add a contact, if the caller is under the cap.
   *
   * The count and the insert share a transaction that opens by locking the owner
   * row. Without that lock, `cap` concurrent creates each read `cap - 1` and each
   * decides it may proceed — the read-then-write race USER-INV-7 exists to catch.
   *
   * @param userId Subject from the verified token.
   * @param input Name, number, and optional relationship/priority.
   * @param requestId Correlation id for the event envelope.
   * @returns The created contact.
   * @throws {LimitExceededError} The cap is already reached (R-USER-22).
   */
  async add(
    userId: string,
    input: AddEmergencyContactInput,
    requestId: string | null = null,
  ): Promise<EmergencyContactView> {
    const contact = await this.transactionManager.execute(async (tx) => {
      await this.userRepository.lockForUpdate(userId, tx);
      const count = await this.emergencyContactRepository.countByUser(userId, tx);
      if (count >= userConfig.maxEmergencyContacts) {
        throw new LimitExceededError('emergencyContacts', userConfig.maxEmergencyContacts);
      }

      const created = await this.emergencyContactRepository.create({ userId, ...input }, tx);
      await this.eventPublisher.publish(
        userEvent('user.emergency_contact.added', {
          subjectUserId: userId,
          requestId,
          // Identifiers and the notification rank only. A contact's name and
          // number never leave the row (doc 05 §3.4, NFR-PRIV).
          data: { userId, contactId: created.id, priority: created.priority },
        }),
        tx,
      );
      return created;
    });

    return toView(contact);
  }

  /**
   * Apply a partial edit to one of the caller's contacts.
   * @param userId Subject from the verified token.
   * @param id Contact UUID.
   * @param changes Keys to write; absent ⇒ unchanged.
   * @param requestId Correlation id for the event envelope.
   * @returns The contact as it stands after the write.
   * @throws {UserNotFoundError} No such contact, **or** it belongs to someone else.
   */
  async update(
    userId: string,
    id: string,
    changes: UpdateEmergencyContactInput,
    requestId: string | null = null,
  ): Promise<EmergencyContactView> {
    const changedFields = Object.keys(changes);

    // An empty PATCH is a no-op: no write, and no event claiming a change that did
    // not happen. The read still enforces ownership, so the 404 is unaffected.
    if (changedFields.length === 0) {
      const existing = await this.emergencyContactRepository.findOwned(userId, id);
      if (!existing) throw new UserNotFoundError('Emergency contact not found');
      return toView(existing);
    }

    const contact = await this.transactionManager.execute(async (tx) => {
      const updated = await this.emergencyContactRepository.updateOwned(userId, id, changes, tx);
      if (!updated) throw new UserNotFoundError('Emergency contact not found');
      await this.eventPublisher.publish(
        userEvent('user.emergency_contact.updated', {
          subjectUserId: userId,
          requestId,
          data: { userId, contactId: id, changedFields },
        }),
        tx,
      );
      return updated;
    });

    return toView(contact);
  }

  /**
   * Delete one of the caller's contacts.
   *
   * Idempotent in effect but not in status (doc 02 §2.5): the first call reports
   * success, a retry reports `NOT_FOUND` because the item is genuinely gone.
   * @param userId Subject from the verified token.
   * @param id Contact UUID.
   * @param requestId Correlation id for the event envelope.
   * @throws {UserNotFoundError} No such contact, **or** it belongs to someone else.
   */
  async remove(userId: string, id: string, requestId: string | null = null): Promise<void> {
    await this.transactionManager.execute(async (tx) => {
      const deleted = await this.emergencyContactRepository.deleteOwned(userId, id, tx);
      if (!deleted) throw new UserNotFoundError('Emergency contact not found');
      await this.eventPublisher.publish(
        userEvent('user.emergency_contact.removed', {
          subjectUserId: userId,
          requestId,
          data: { userId, contactId: id },
        }),
        tx,
      );
    });
  }
}
