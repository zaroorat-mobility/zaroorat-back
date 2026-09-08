import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { User, UserStatus } from '@core/database/types';
export interface CreateUserInput {
  phoneNumber: string;
  status?: UserStatus;
  isPhoneVerified?: boolean;
  isEmailVerified?: boolean;
  email?: string | null;
  passwordHash?: string | null;
}
export class UserRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async findById(id: string, tx?: TransactionClient): Promise<User | null> {
    return (tx ?? this.client).user.findUnique({ where: { id } });
  }
  async findActiveByPhone(phoneNumber: string, tx?: TransactionClient): Promise<User | null> {
    return (tx ?? this.client).user.findFirst({ where: { phoneNumber, deletedAt: null } });
  }
  async findActiveByEmail(email: string, tx?: TransactionClient): Promise<User | null> {
    return (tx ?? this.client).user.findFirst({
      where: { email, deletedAt: null },
    });
  }
  async create(input: CreateUserInput, tx?: TransactionClient): Promise<User> {
    return (tx ?? this.client).user.create({
      data: {
        phoneNumber: input.phoneNumber,
        isPhoneVerified: input.isPhoneVerified ?? false,
        ...(input.isEmailVerified !== undefined ? { isEmailVerified: input.isEmailVerified } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.email != null ? { email: input.email } : {}),
        ...(input.passwordHash != null ? { passwordHash: input.passwordHash } : {}),
      },
    });
  }
  async updateStatus(id: string, status: UserStatus, tx?: TransactionClient): Promise<User> {
    return (tx ?? this.client).user.update({ where: { id }, data: { status } });
  }
  async updateLastLoginAt(id: string, at: Date, tx?: TransactionClient): Promise<void> {
    await (tx ?? this.client).user.update({ where: { id }, data: { lastLoginAt: at } });
  }
  async lockForUpdate(id: string, tx: TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${id}::uuid FOR UPDATE`;
  }
  async updatePhoneNumber(id: string, phoneNumber: string, tx?: TransactionClient): Promise<User> {
    return (tx ?? this.client).user.update({ where: { id }, data: { phoneNumber } });
  }
  async markPhoneVerified(id: string, tx?: TransactionClient): Promise<void> {
    await (tx ?? this.client).user.update({ where: { id }, data: { isPhoneVerified: true } });
  }
  async updateEmail(id: string, email: string | null, tx?: TransactionClient): Promise<User> {
    return (tx ?? this.client).user.update({ where: { id }, data: { email } });
  }
  /// Everything the Ride PIN flows need, and nothing else. A narrow `select`
  /// rather than a whole `User`, so a verifier cannot ride along into a caller
  /// that was only after the account.
  async findRidePin(
    id: string,
    tx?: TransactionClient,
  ): Promise<{ ridePinVerifier: string | null; ridePinVersion: number } | null> {
    return (tx ?? this.client).user.findUnique({
      where: { id },
      select: { ridePinVerifier: true, ridePinVersion: true },
    });
  }
  /// Returns the new version. `increment` rather than a read-then-write, so two
  /// concurrent changes cannot land on the same version number — the audit trail
  /// is only useful if a version identifies exactly one PIN generation.
  async setRidePin(id: string, verifier: string, tx?: TransactionClient): Promise<number> {
    const updated = await (tx ?? this.client).user.update({
      where: { id },
      data: {
        ridePinVerifier: verifier,
        ridePinUpdatedAt: new Date(),
        ridePinVersion: { increment: 1 },
      },
      select: { ridePinVersion: true },
    });
    return updated.ridePinVersion;
  }
  async softDelete(id: string, at: Date = new Date()): Promise<void> {
    await this.client.user.update({ where: { id }, data: { deletedAt: at } });
  }
  async anonymize(id: string, at: Date, tx?: TransactionClient): Promise<void> {
    await (tx ?? this.client).user.update({
      where: { id },
      data: {
        phoneNumber: `erased:${id}`,
        email: null,
        passwordHash: null,
        // A Ride PIN is a credential the rider very likely reuses elsewhere, and
        // it outlives the ride it was for. Erasure that left the verifier behind
        // would keep an offline-attackable secret about a person who asked to be
        // forgotten. `ridePinVersion` is left alone: it is a counter, carries
        // nothing about the rider, and zeroing it would make a re-registered
        // account's audit trail collide with the erased one's.
        ridePinVerifier: null,
        ridePinUpdatedAt: null,
        isPhoneVerified: false,
        isEmailVerified: false,
        deletedAt: at,
      },
    });
  }
}
