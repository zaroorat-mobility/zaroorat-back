import { DatabaseService, TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { User, UserRoleAssignment, Role } from '@core/database/types';
import {
  END_USER_ROLE_SLUGS,
  type StaffRoleSlug,
  isAssignableStaffRoleSlug,
  isStaffRoleSlug,
} from '@modules/auth/constants/auth.constants.js';
import { PermissionRepository } from '@modules/auth/repositories/permission.repository.js';
import { RoleRepository } from '@modules/auth/repositories/role.repository.js';
import { UserRepository } from '@modules/auth/repositories/user.repository.js';
import type { AuthService } from '@modules/auth/services/auth.service.js';
import type { SessionService } from '@modules/auth/services/session/session.service.js';
import type { EpochService } from '@modules/auth/services/token/epoch.service.js';
import { hashPassword } from '@modules/auth/utils/password.js';
import { UserProfileRepository } from '@modules/users/repositories/user-profile.repository.js';
import { recordAdminAction, type AuditActor } from '../audit/index.js';
import { StaffConflictError, StaffForbiddenError, StaffNotFoundError } from './staff.errors.js';
import type { CreateStaffBody, ListStaffQuery, UpdateStaffBody } from './staff.schemas.js';

type StaffUserRow = User & {
  profile: { firstName: string | null; lastName: string | null } | null;
  roleAssignments: Array<UserRoleAssignment & { role: Role }>;
};

export interface StaffUserDto {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  status: 'active' | 'inactive';
  lastLogin: string | null;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
}

const STAFF_PRIORITY: StaffRoleSlug[] = ['system_admin', 'admin', 'support', 'finance'];

function pickStaffRole(slugs: string[]): string | null {
  for (const role of STAFF_PRIORITY) {
    if (slugs.includes(role)) return role;
  }
  return slugs.find((slug) => isStaffRoleSlug(slug)) ?? null;
}

/// The active staff (non end-user) role slugs a staff row holds, de-duplicated.
function staffRoleSlugs(row: { roleAssignments: Array<{ role: { slug: string } }> }): string[] {
  return [
    ...new Set(row.roleAssignments.map((a) => a.role.slug).filter((slug) => isStaffRoleSlug(slug))),
  ];
}

function displayName(
  profile: { firstName: string | null; lastName: string | null } | null,
  email: string | null,
): string {
  const parts = [profile?.firstName, profile?.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return email ?? 'Staff user';
}

export class AdminStaffService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly roleRepository: RoleRepository,
    private readonly permissionRepository: PermissionRepository,
    private readonly transactionManager: TransactionManager,
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly epochService: EpochService,
  ) {}

  async list(query: ListStaffQuery): Promise<{
    data: StaffUserDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const skip = (query.page - 1) * query.limit;
    const { rows, totalCount } = await this.queryStaff({
      skip,
      take: query.limit,
      ...(query.search ? { search: query.search } : {}),
    });
    const data = await Promise.all(rows.map((row) => this.toDto(row)));
    const totalPages = Math.max(1, Math.ceil(totalCount / query.limit));
    return {
      data,
      meta: {
        currentPage: query.page,
        totalPages,
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getById(id: string): Promise<StaffUserDto> {
    const row = await this.findStaffRow(id);
    if (!row) throw new StaffNotFoundError();
    return this.toDto(row);
  }

  async create(input: CreateStaffBody, actor: AuditActor): Promise<StaffUserDto> {
    const emailTaken = await this.userRepository.findActiveByEmail(input.email);
    if (emailTaken) throw new StaffConflictError('That email is already in use');
    const phoneTaken = await this.userRepository.findActiveByPhone(input.phoneNumber);
    if (phoneTaken) throw new StaffConflictError('That phone number is already in use');

    if (!isAssignableStaffRoleSlug(input.role)) {
      throw new StaffForbiddenError('That role cannot be assigned to staff');
    }
    const role = await this.roleRepository.findBySlug(input.role);
    if (!role) throw new StaffConflictError(`Unknown staff role '${input.role}'`);

    const created = await this.transactionManager.execute(async (tx) => {
      const user = await this.userRepository.create(
        {
          phoneNumber: input.phoneNumber,
          email: input.email,
          passwordHash: hashPassword(input.password),
          status: 'ACTIVE',
          isPhoneVerified: true,
          isEmailVerified: true,
        },
        tx,
      );
      await this.userProfileRepository.update(
        user.id,
        { firstName: input.firstName, lastName: input.lastName || null },
        tx,
      );
      await this.authService.grantRoleInTransaction(
        user.id,
        role.slug,
        { grantedBy: actor.actorId },
        tx,
      );
      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'staff_user',
        entityId: user.id,
        summary: `Staff account created with role ${role.slug}`,
        after: { roles: [role.slug], status: 'ACTIVE' },
        result: 'SUCCESS',
      });
      return user.id;
    });

    return this.getById(created);
  }

  async update(id: string, input: UpdateStaffBody, actor: AuditActor): Promise<StaffUserDto> {
    const row = await this.findStaffRow(id);
    if (!row) throw new StaffNotFoundError();

    if (input.email && input.email !== row.email) {
      const emailTaken = await this.userRepository.findActiveByEmail(input.email);
      if (emailTaken && emailTaken.id !== id) {
        throw new StaffConflictError('That email is already in use');
      }
    }

    if (input.phoneNumber && input.phoneNumber !== row.phoneNumber) {
      const phoneTaken = await this.userRepository.findActiveByPhone(input.phoneNumber);
      if (phoneTaken && phoneTaken.id !== id) {
        throw new StaffConflictError('That phone number is already in use');
      }
    }

    if (input.role && !isAssignableStaffRoleSlug(input.role)) {
      throw new StaffForbiddenError('That role cannot be assigned to staff');
    }

    const nextRole = input.role ? await this.roleRepository.findBySlug(input.role) : null;
    if (input.role && !nextRole) {
      throw new StaffConflictError(`Unknown staff role '${input.role}'`);
    }

    const previousStaffRoles = staffRoleSlugs(row);
    const roleChanges = !!nextRole && pickStaffRole(previousStaffRoles) !== nextRole.slug;
    const passwordReset = !!input.password;
    // Either change retires every access token the user holds (invalidateTokens).
    const invalidates = roleChanges || passwordReset;
    const changedFields = [
      ...(input.firstName !== undefined || input.lastName !== undefined ? ['name'] : []),
      ...(input.email !== undefined && input.email !== row.email ? ['email'] : []),
      ...(input.phoneNumber !== undefined && input.phoneNumber !== row.phoneNumber
        ? ['phoneNumber']
        : []),
      ...(passwordReset ? ['password'] : []),
      ...(roleChanges ? ['role'] : []),
    ];

    await this.transactionManager.execute(async (tx: TransactionClient) => {
      if (input.firstName !== undefined || input.lastName !== undefined) {
        await this.userProfileRepository.update(
          id,
          {
            ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
            ...(input.lastName !== undefined ? { lastName: input.lastName ?? null } : {}),
          },
          tx,
        );
      }

      if (input.email !== undefined) {
        await this.userRepository.updateEmail(id, input.email, tx);
      }

      if (input.phoneNumber !== undefined) {
        await this.userRepository.updatePhoneNumber(id, input.phoneNumber, tx);
      }

      if (input.password) {
        await (tx ?? this.databaseService.client).user.update({
          where: { id },
          data: { passwordHash: hashPassword(input.password) },
        });
      }

      if (roleChanges && nextRole) {
        // Through AuthService, so this change publishes account.role.* like every other
        // role change, and EpochInvalidationConsumer retires stale claims durably.
        for (const slug of previousStaffRoles) {
          await this.authService.revokeRoleInTransaction(
            id,
            slug,
            { revokedBy: actor.actorId, reason: 'staff_role_changed' },
            tx,
          );
        }
        await this.authService.grantRoleInTransaction(
          id,
          nextRole.slug,
          { grantedBy: actor.actorId },
          tx,
        );
      }

      // An administrator setting a password is a credential reset: no session opened
      // with the previous password may continue, and no refresh token may renew one.
      const sessionsRevoked = passwordReset
        ? await this.sessionService.revokeAllInTransaction(id, 'staff_password_reset', tx)
        : 0;

      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'staff_user',
        entityId: id,
        summary: roleChanges
          ? `Staff role changed from ${previousStaffRoles.join(', ') || 'none'} to ${nextRole?.slug}`
          : 'Staff account updated',
        before: { roles: previousStaffRoles },
        after: {
          roles: roleChanges && nextRole ? [nextRole.slug] : previousStaffRoles,
          changedFields,
          tokensInvalidated: invalidates,
          sessionsRevoked,
        },
        result: 'SUCCESS',
      });

      // Inside the transaction: if the revocation store cannot be written, the change aborts.
      if (invalidates) await this.invalidateTokens(id);
    });

    // After commit: retires a token refreshed between the two bumps with pre-change roles.
    if (invalidates) await this.invalidateTokens(id);
    return this.getById(id);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    if (id === actor.actorId) {
      throw new StaffForbiddenError('You cannot remove your own admin account');
    }
    const row = await this.findStaffRow(id);
    if (!row) throw new StaffNotFoundError();
    const previousStaffRoles = staffRoleSlugs(row);

    await this.transactionManager.execute(async (tx: TransactionClient) => {
      for (const slug of previousStaffRoles) {
        await this.authService.revokeRoleInTransaction(
          id,
          slug,
          { revokedBy: actor.actorId, reason: 'staff_removed' },
          tx,
        );
      }
      await this.userRepository.updateStatus(id, 'DEACTIVATED', tx);
      // Sessions and refresh tokens end with the account, so nothing can be renewed.
      const sessionsRevoked = await this.sessionService.revokeAllInTransaction(
        id,
        'staff_removed',
        tx,
      );
      await recordAdminAction(tx, {
        ...actor,
        action: 'DELETE',
        entityType: 'staff_user',
        entityId: id,
        summary: `Staff account removed (was ${previousStaffRoles.join(', ') || 'no staff role'})`,
        before: { roles: previousStaffRoles, status: row.status },
        after: { roles: [], status: 'DEACTIVATED', tokensInvalidated: true, sessionsRevoked },
        result: 'SUCCESS',
      });
      await this.invalidateTokens(id);
    });

    await this.invalidateTokens(id);
  }

  /// Retires every access token the user holds by bumping their epoch, which
  /// `authenticate` checks on every request and the socket handshake checks on connect.
  /// Callers bump twice: inside the transaction, so a revocation store that cannot be
  /// written aborts the change instead of leaving old claims valid (fail closed); and
  /// after commit, so a token refreshed between the two, whose roles were read before
  /// the change committed, is retired too.
  private async invalidateTokens(userId: string): Promise<void> {
    await this.epochService.bump(userId);
  }

  private staffWhere(search?: string) {
    const staffFilter = {
      deletedAt: null,
      roleAssignments: {
        some: {
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          role: { slug: { notIn: [...END_USER_ROLE_SLUGS] } },
        },
      },
    };
    if (!search) return staffFilter;
    return {
      AND: [
        staffFilter,
        {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { phoneNumber: { contains: search } },
            { profile: { firstName: { contains: search, mode: 'insensitive' as const } } },
            { profile: { lastName: { contains: search, mode: 'insensitive' as const } } },
          ],
        },
      ],
    };
  }

  private async queryStaff(params: {
    skip: number;
    take: number;
    search?: string;
  }): Promise<{ rows: StaffUserRow[]; totalCount: number }> {
    const where = this.staffWhere(params.search);
    const [rows, totalCount] = await Promise.all([
      this.databaseService.client.user.findMany({
        where,
        include: {
          profile: true,
          roleAssignments: { where: { revokedAt: null }, include: { role: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }) as Promise<StaffUserRow[]>,
      this.databaseService.client.user.count({ where }),
    ]);
    return { rows, totalCount };
  }

  private async findStaffRow(id: string): Promise<StaffUserRow | null> {
    const row = (await this.databaseService.client.user.findFirst({
      where: { id, ...this.staffWhere() },
      include: {
        profile: true,
        roleAssignments: { where: { revokedAt: null }, include: { role: true } },
      },
    })) as StaffUserRow | null;
    return row;
  }

  private async toDto(row: StaffUserRow): Promise<StaffUserDto> {
    const slugs = row.roleAssignments.map((assignment) => assignment.role.slug);
    const role = pickStaffRole(slugs);
    if (!role) throw new StaffNotFoundError();
    const permissions = await this.permissionRepository.findAllowedCodesForUser(row.id);
    return {
      id: row.id,
      name: displayName(row.profile, row.email),
      email: row.email ?? '',
      phone: row.phoneNumber,
      role,
      status: row.status === 'ACTIVE' ? 'active' : 'inactive',
      lastLogin: row.lastLoginAt?.toISOString() ?? null,
      permissions,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
