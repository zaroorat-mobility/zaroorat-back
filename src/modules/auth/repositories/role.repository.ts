import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { Role, UserRoleAssignment } from '@core/database/types';

/** Fields needed to grant a role. Idempotency (one live grant per user+role) is
 *  a service concern backed by the partial index `uq_user_role_active`. */
export interface GrantRoleInput {
  userId: string;
  roleId: string;
  /** Actor performing the grant; `null`/omitted denotes a system grant. */
  grantedBy?: string | null;
  /** Expiry for a scoped/temporary role; omit for a permanent grant. */
  expiresAt?: Date | null;
}

/**
 * Data access for RBAC role membership (`Role` + `UserRoleAssignment`).
 *
 * Roles are modelled as data, not a scalar (auth doc 03 OD-2). An assignment is
 * "active" when `revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now)`.
 * Prisma-only, no business rules — the service decides whether to grant/revoke.
 */
export class RoleRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Resolve a role by its canonical slug (e.g. `customer`, `driver`).
   * @param slug Stable role identifier.
   * @returns The role, or `null` if no such slug exists.
   */
  async findBySlug(slug: string, tx?: TransactionClient): Promise<Role | null> {
    return (tx ?? this.client).role.findUnique({ where: { slug } });
  }

  /**
   * Find a user's currently-active assignment for a specific role, if any.
   * @param userId Subject user UUID.
   * @param roleId Role UUID.
   * @param now Reference instant for the expiry check.
   * @returns The active assignment, or `null` if the user does not currently hold the role.
   */
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

  /**
   * List the slugs of every role a user currently holds (the JWT `roles` claim).
   * @param userId Subject user UUID.
   * @param now Reference instant for the expiry check.
   * @returns Active role slugs.
   */
  async findActiveRoleSlugs(
    userId: string,
    now: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<string[]> {
    const assignments = await (tx ?? this.client).userRoleAssignment.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { role: { select: { slug: true } } },
    });
    return assignments.map((assignment) => assignment.role.slug);
  }

  /**
   * Insert a role grant. Does not check for an existing active grant — the caller
   * composes that with {@link findActiveAssignment}; the partial index is the
   * final guard.
   * @param input User, role, and optional grantor/expiry.
   * @returns The created assignment.
   * @throws Propagates a unique-violation if an active grant already exists
   *         (partial index `uq_user_role_active`).
   */
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

  /**
   * Revoke a user's active assignment(s) for a role (revocation is a timestamp,
   * not a row delete — grant/revoke history is retained).
   * @param userId Subject user UUID.
   * @param roleId Role UUID.
   * @param revokedAt Revocation timestamp (defaults to now).
   * @param tx Transaction client to join, so the revocation and its audit event
   *           commit together — a role change that lost its trail is exactly what
   *           the outbox exists to prevent (R-AUTH-21).
   * @returns Count of assignments revoked.
   */
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
