import type { TransactionManager } from '@core/database/TransactionManager';
import type { EventPublisher } from '@core/events';
import { userConfig } from '../../config';
import type { UserRepository } from '@modules/auth/repositories';
import {
  EmergencyContactRepository,
  type CreateEmergencyContactInput,
  type UpdateEmergencyContactInput,
} from '../../repositories';
import { userEvent } from '../../events';
import { LimitExceededError, UserNotFoundError } from '../../errors';
import type { EmergencyContact } from '../../types';
import type { EmergencyContactView } from '../../schemas';

export type AddEmergencyContactInput = Omit<CreateEmergencyContactInput, 'userId'>;

export function toEmergencyContactView(contact: EmergencyContact): EmergencyContactView {
  return {
    id: contact.id,
    contactName: contact.contactName,
    phoneNumber: contact.phoneNumber,
    relationship: contact.relationship,
    priority: contact.priority,
    createdAt: contact.createdAt,
  };
}

export class EmergencyContactService {
  constructor(
    private readonly emergencyContactRepository: EmergencyContactRepository,
    private readonly userRepository: UserRepository,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async list(userId: string): Promise<EmergencyContactView[]> {
    const contacts = await this.emergencyContactRepository.findAllByUser(userId);
    return contacts.map(toEmergencyContactView);
  }

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
          data: { userId, contactId: created.id, priority: created.priority },
        }),
        tx,
      );
      return created;
    });

    return toEmergencyContactView(contact);
  }

  async update(
    userId: string,
    id: string,
    changes: UpdateEmergencyContactInput,
    requestId: string | null = null,
  ): Promise<EmergencyContactView> {
    const changedFields = Object.keys(changes);

    if (changedFields.length === 0) {
      const existing = await this.emergencyContactRepository.findOwned(userId, id);
      if (!existing) throw new UserNotFoundError('Emergency contact not found');
      return toEmergencyContactView(existing);
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

    return toEmergencyContactView(contact);
  }

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
