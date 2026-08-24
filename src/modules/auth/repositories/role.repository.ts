import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { Role, UserRoleAssignment } from '@core/database/types';
export interface GrantRoleInput {
  userId: string;
  roleId: string;
  grantedBy?: string | null;
  expiresAt?: Date | null;
}
export class RoleRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async findBySlug(slug: string, tx?: TransactionClient): Promise<Role | null> {
    return (tx ?? this.client).role.findUnique({ where: { slug } });
  }
  async findActiveAssignment(
    userId: string,
    roleId: string,
    now: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<UserRoleAssignment | null> {
    return (tx ?? this.client).userRoleAssignment.findFirst({
      where: {
        userId,
        roleId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }
  async findActiveRoleSlugs(userId: string, now?: Date, tx?: TransactionClient): Promise<string[]> {
    const asOf = now ?? new Date();
    const assignments = await (tx ?? this.client).userRoleAssignment.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: asOf } }],
      },
      select: { role: { select: { slug: true } } },
    });
    return assignments.map((assignment) => assignment.role.slug);
  }
  async grant(input: GrantRoleInput, tx?: TransactionClient): Promise<UserRoleAssignment> {
    return (tx ?? this.client).userRoleAssignment.create({
      data: {
        userId: input.userId,
        roleId: input.roleId,
        ...(input.grantedBy != null ? { grantedBy: input.grantedBy } : {}),
        ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
      },
    });
  }
  async revoke(
    userId: string,
    roleId: string,
    revokedAt: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await (tx ?? this.client).userRoleAssignment.updateMany({
      where: { userId, roleId, revokedAt: null },
      data: { revokedAt },
    });
    return count;
  }
}
