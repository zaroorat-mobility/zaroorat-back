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
        isPhoneVerified: false,
        isEmailVerified: false,
        deletedAt: at,
      },
    });
  }
}
