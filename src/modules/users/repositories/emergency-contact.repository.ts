import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { EmergencyContact } from '../types';

export interface CreateEmergencyContactInput {
  userId: string;
  contactName: string;
  phoneNumber: string;
  relationship?: string | null;
  priority?: number;
}

export interface UpdateEmergencyContactInput {
  contactName?: string;
  phoneNumber?: string;
  relationship?: string | null;
  priority?: number;
}

export class EmergencyContactRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  async findAllByUser(userId: string): Promise<EmergencyContact[]> {
    return this.client.emergencyContact.findMany({
      where: { userId },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  }

  async findOwned(
    userId: string,
    id: string,
    tx?: TransactionClient,
  ): Promise<EmergencyContact | null> {
    return (tx ?? this.client).emergencyContact.findFirst({ where: { id, userId } });
  }

  async countByUser(userId: string, tx?: TransactionClient): Promise<number> {
    return (tx ?? this.client).emergencyContact.count({ where: { userId } });
  }

  async create(
    input: CreateEmergencyContactInput,
    tx?: TransactionClient,
  ): Promise<EmergencyContact> {
    return (tx ?? this.client).emergencyContact.create({
      data: {
        userId: input.userId,
        contactName: input.contactName,
        phoneNumber: input.phoneNumber,
        ...(input.relationship != null ? { relationship: input.relationship } : {}),
        ...(input.priority != null ? { priority: input.priority } : {}),
      },
    });
  }

  async updateOwned(
    userId: string,
    id: string,
    input: UpdateEmergencyContactInput,
    tx?: TransactionClient,
  ): Promise<EmergencyContact | null> {
    const client = tx ?? this.client;
    const { count } = await client.emergencyContact.updateMany({
      where: { id, userId },
      data: input,
    });
    if (count === 0) return null;
    return client.emergencyContact.findFirst({ where: { id, userId } });
  }

  async deleteOwned(userId: string, id: string, tx?: TransactionClient): Promise<boolean> {
    const { count } = await (tx ?? this.client).emergencyContact.deleteMany({
      where: { id, userId },
    });
    return count === 1;
  }

  async deleteAllForUser(userId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).emergencyContact.deleteMany({ where: { userId } });
    return count;
  }
}
