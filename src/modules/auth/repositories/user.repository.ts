import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { User, UserStatus } from '@core/database/types';

/** Fields required to open a new identity. Roles, profile, and devices are
 *  written by their own repositories — this creates only the `users` row. */
export interface CreateUserInput {
  phoneNumber: string;
  /** Defaults to the schema default (`UNVERIFIED`) when omitted. */
  status?: UserStatus;
  isPhoneVerified?: boolean;
  email?: string | null;
}

/**
 * Data access for the `User` (identity) aggregate root.
 *
 * Prisma-only; holds no business rules. Phone uniqueness is enforced by a
 * PARTIAL index (active rows), so lookups by phone use `findFirst` scoped to
 * non-deleted rows rather than `findUnique` (auth doc 03 §4).
 */
export class UserRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Fetch an identity by primary key.
   * @param id User UUID.
   * @returns The user, or `null` if no such id exists.
   */
  async findById(id: string): Promise<User | null> {
    return this.client.user.findUnique({ where: { id } });
  }

  /**
   * Resolve the single ACTIVE (non-soft-deleted) account for a phone number.
   * @param phoneNumber E.164 phone number.
   * @returns The live user, or `null` if none is registered/active.
   */
  async findActiveByPhone(phoneNumber: string, tx?: TransactionClient): Promise<User | null> {
    return (tx ?? this.client).user.findFirst({ where: { phoneNumber, deletedAt: null } });
  }

  /**
   * Insert a new identity.
   * @param input Phone number plus optional initial status/verification/email.
   * @returns The created user.
   * @throws Propagates a unique-violation if an active account already exists
   *         for the phone number (partial index `uq_users_phone_active`).
   */
  async create(input: CreateUserInput, tx?: TransactionClient): Promise<User> {
    return (tx ?? this.client).user.create({
      data: {
        phoneNumber: input.phoneNumber,
        isPhoneVerified: input.isPhoneVerified ?? false,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.email != null ? { email: input.email } : {}),
      },
    });
  }

  /**
   * Change an account's lifecycle state (e.g. suspend/reactivate).
   * @param id User UUID.
   * @param status New lifecycle status.
   * @param tx Transaction client to join (omit for a standalone write).
   * @returns The updated user.
   * @throws Propagates a not-found error if the id does not exist.
   */
  async updateStatus(id: string, status: UserStatus, tx?: TransactionClient): Promise<User> {
    return (tx ?? this.client).user.update({ where: { id }, data: { status } });
  }

  /**
   * Stamp the last successful login time.
   * @param id User UUID.
   * @param at Timestamp of the login.
   */
  async updateLastLoginAt(id: string, at: Date, tx?: TransactionClient): Promise<void> {
    await (tx ?? this.client).user.update({ where: { id }, data: { lastLoginAt: at } });
  }

  /**
   * Take a row lock on an identity for the rest of the caller's transaction.
   *
   * A read, not a write, so it stays inside USER's read access to this table
   * (user doc 03 §2). It exists because a per-user cap cannot be expressed as a
   * Postgres constraint: counting and then inserting is a read-then-write race
   * that only concurrent callers expose (USER-INV-7). Serialising them on the
   * owner row makes the count authoritative for the length of the transaction —
   * doc 06 §4's "a constraint **or a locked count**".
   *
   * @param id User UUID.
   * @param tx The caller's transaction — a lock outside one would release immediately.
   */
  async lockForUpdate(id: string, tx: TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /**
   * Re-bind an identity to a different phone number (user doc 03 §4.2).
   *
   * Only the column changes — `id` is untouched, so every foreign key pointing at
   * this identity follows it for free (USER-INV-3). Callers must run this inside
   * the transaction that also revokes the account's sessions (R-USER-29).
   * @param id User UUID.
   * @param phoneNumber The new E.164 number.
   * @param tx Transaction client to join (omit for a standalone write).
   * @throws Propagates a unique violation (`uq_users_phone_active`) when another
   *         active account already holds the number — **the index is the
   *         enforcement**, not the caller's pre-check (doc 03 §4.2).
   */
  async updatePhoneNumber(id: string, phoneNumber: string, tx?: TransactionClient): Promise<User> {
    return (tx ?? this.client).user.update({ where: { id }, data: { phoneNumber } });
  }

  /**
   * Mark the account's phone number as verified.
   * @param id User UUID.
   */
  async markPhoneVerified(id: string, tx?: TransactionClient): Promise<void> {
    await (tx ?? this.client).user.update({ where: { id }, data: { isPhoneVerified: true } });
  }

  /**
   * Soft-delete an identity (records are never physically removed, R-DATA-1).
   * @param id User UUID.
   * @param at Deletion timestamp (defaults to now).
   */
  async softDelete(id: string, at: Date = new Date()): Promise<void> {
    await this.client.user.update({ where: { id }, data: { deletedAt: at } });
  }
}
