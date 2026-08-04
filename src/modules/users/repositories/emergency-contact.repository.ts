import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { EmergencyContact } from '../types';

/** Fields required to add a contact (doc 02 §2.5). */
export interface CreateEmergencyContactInput {
  userId: string;
  contactName: string;
  phoneNumber: string;
  relationship?: string | null;
  priority?: number;
}

/**
 * A partial contact edit. Only the keys **present** are written; an absent key
 * leaves its column unchanged, an explicit `null` clears it (the same
 * absent-vs-`null` discipline the profile uses, R-USER-5).
 *
 * `contactName`, `phoneNumber`, and `priority` are `NOT NULL` in the schema, so
 * they are settable but never clearable.
 */
export interface UpdateEmergencyContactInput {
  contactName?: string;
  phoneNumber?: string;
  relationship?: string | null;
  priority?: number;
}

/**
 * Data access for `emergency_contacts` (user doc 03 §3.2). Prisma-only, no
 * business rules — the cap lives in the service, which holds the lock that makes
 * it safe.
 *
 * **Every method is scoped by `userId` in its `WHERE` clause**, including the
 * ones that take an item id. That is doc 02 §3's second rule and the reason
 * USER-INV-2 is a property of the queries rather than of each handler: a wrong id
 * returns no row, so there is no fetched object to forget to compare.
 */
export class EmergencyContactRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * List a user's contacts in notification order (R-USER-23).
   *
   * `id` breaks ties on equal priority so the order is total and stable — two
   * contacts at priority 1 must not swap places between two reads of an unchanged
   * list. No pagination: the cap bounds the result (doc 02 §2.5).
   * @param userId Owner's user UUID.
   * @returns Contacts, priority ascending.
   */
  async findAllByUser(userId: string): Promise<EmergencyContact[]> {
    return this.client.emergencyContact.findMany({
      where: { userId },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Fetch one contact, scoped to its owner.
   * @param userId Owner's user UUID.
   * @param id Contact UUID.
   * @param tx Transaction client to join (omit for a standalone read).
   * @returns The contact, or `null` if it does not exist **or is not owned**.
   */
  async findOwned(
    userId: string,
    id: string,
    tx?: TransactionClient,
  ): Promise<EmergencyContact | null> {
    return (tx ?? this.client).emergencyContact.findFirst({ where: { id, userId } });
  }

  /**
   * Count a user's contacts, for the cap check.
   * @param userId Owner's user UUID.
   * @param tx The transaction holding the owner-row lock — counting outside it is
   *           a read-then-write race (USER-INV-7).
   */
  async countByUser(userId: string, tx?: TransactionClient): Promise<number> {
    return (tx ?? this.client).emergencyContact.count({ where: { userId } });
  }

  /**
   * Insert a contact.
   * @param input Owner, name, number, and optional relationship/priority.
   * @param tx Transaction client to join, so the row and its outbox event commit
   *           together (R-USER-28).
   * @returns The created contact.
   */
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

  /**
   * Apply a partial edit, scoped to the owner.
   *
   * Uses `updateMany` rather than `update` so ownership stays in the `WHERE`
   * clause: `update` addresses by primary key alone and would edit another user's
   * row if the scope check were ever dropped upstream.
   * @param userId Owner's user UUID.
   * @param id Contact UUID.
   * @param input The keys to write.
   * @param tx Transaction client to join.
   * @returns The updated contact, or `null` if no owned row matched.
   */
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

  /**
   * Delete a contact, scoped to the owner.
   * @param userId Owner's user UUID.
   * @param id Contact UUID.
   * @param tx Transaction client to join.
   * @returns `true` if an owned row was deleted; `false` if none matched.
   */
  async deleteOwned(userId: string, id: string, tx?: TransactionClient): Promise<boolean> {
    const { count } = await (tx ?? this.client).emergencyContact.deleteMany({
      where: { id, userId },
    });
    return count === 1;
  }

  /**
   * Delete every contact an account holds (account erasure, R-USER-18/19).
   *
   * A hard delete, not a soft one. These rows are personal data about **third
   * parties** who never signed up — doc 03 §6 says they are "erased with the
   * account, never retained past it", and a `deleted_at` on somebody else's
   * phone number retains it.
   *
   * @param userId Owner's user UUID.
   * @param tx Transaction client to join.
   * @returns Count removed — reported in the erasure audit event.
   */
  async deleteAllForUser(userId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).emergencyContact.deleteMany({ where: { userId } });
    return count;
  }
}
