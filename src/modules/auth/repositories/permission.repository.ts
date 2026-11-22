import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { Permission } from '@core/database/types';
export class PermissionRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async findByCode(code: string): Promise<Permission | null> {
    return this.client.permission.findUnique({ where: { code } });
  }
  async findAllowedForRole(roleId: string): Promise<Permission[]> {
    const rows = await this.client.rolePermission.findMany({
      where: { roleId, effect: 'ALLOW' },
      select: { permission: true },
    });
    return rows.map((row) => row.permission);
  }
  async findAllowedCodesForUser(userId: string, now: Date = new Date()): Promise<string[]> {
    const assignments = await this.client.userRoleAssignment.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { roleId: true },
    });
    const roleIds = assignments.map((assignment) => assignment.roleId);
    if (roleIds.length === 0) return [];
    const rows = await this.client.rolePermission.findMany({
      where: { roleId: { in: roleIds }, effect: 'ALLOW' },
      select: { permission: { select: { code: true } } },
    });
    return [...new Set(rows.map((row) => row.permission.code))];
  }

  async listAll(): Promise<Permission[]> {
    return this.client.permission.findMany({ orderBy: [{ resource: 'asc' }, { code: 'asc' }] });
  }

  async listCodesForRole(roleId: string, tx?: TransactionClient): Promise<string[]> {
    const rows = await (tx ?? this.client).rolePermission.findMany({
      where: { roleId, effect: 'ALLOW' },
      select: { permission: { select: { code: true } } },
    });
    return rows.map((row) => row.permission.code);
  }

  /// Replaces a role's grants. With `tx`, the replacement joins the caller's transaction
  /// (so an audit row can commit or roll back with it); without, it runs in its own.
  async replaceRoleCodes(roleId: string, codes: string[], tx?: TransactionClient): Promise<void> {
    const replace = async (db: TransactionClient) => {
      const permissions = await db.permission.findMany({
        where: { code: { in: codes } },
        select: { id: true, code: true },
      });
      await db.rolePermission.deleteMany({ where: { roleId } });
      if (permissions.length === 0) return;
      await db.rolePermission.createMany({
        data: permissions.map((permission) => ({
          roleId,
          permissionId: permission.id,
          effect: 'ALLOW',
        })),
      });
    };
    if (tx) return replace(tx);
    await this.client.$transaction(replace);
  }
}
