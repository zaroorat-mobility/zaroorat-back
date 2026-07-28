import { BaseRepository, DatabaseService } from '@core/database';
import type { Permission } from '@core/database/types';

/**
 * Data access for fine-grained RBAC permissions (`Permission` + `RolePermission`).
 *
 * Permissions are attached to roles via `RolePermission` with an `effect`
 * (ALLOW/DENY). This layer resolves the ALLOW set for a role or for a user's
 * currently-active roles; it does not evaluate DENY precedence or cache results —
 * those are service concerns. Prisma-only, no business rules.
 */
export class PermissionRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Resolve a permission by its unique code.
   * @param code Stable permission identifier (e.g. `ride.accept`).
   * @returns The permission, or `null` if no such code exists.
   */
  async findByCode(code: string): Promise<Permission | null> {
    return this.client.permission.findUnique({ where: { code } });
  }

  /**
   * List the ALLOW-effect permissions attached to a single role.
   * @param roleId Role UUID.
   * @returns The role's allowed permissions.
   */
  async findAllowedForRole(roleId: string): Promise<Permission[]> {
    const rows = await this.client.rolePermission.findMany({
      where: { roleId, effect: 'ALLOW' },
      select: { permission: true },
    });
    return rows.map((row) => row.permission);
  }

  /**
   * Resolve the distinct ALLOW permission codes granted by a user's currently
   * active roles.
   * @param userId Subject user UUID.
   * @param now Reference instant for the role-expiry check.
   * @returns Distinct allowed permission codes (empty if the user holds no active roles).
   */
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
}
