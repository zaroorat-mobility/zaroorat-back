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
import { hashPassword } from '@modules/auth/utils/password.js';
import { UserProfileRepository } from '@modules/users/repositories/user-profile.repository.js';
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

  async create(input: CreateStaffBody, grantedBy: string): Promise<StaffUserDto> {
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
      await this.roleRepository.grant({ userId: user.id, roleId: role.id, grantedBy }, tx);
      return user.id;
    });

    return this.getById(created);
  }

  async update(id: string, input: UpdateStaffBody, actorId: string): Promise<StaffUserDto> {
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

      if (input.role && nextRole) {
        const currentRole = pickStaffRole(
          row.roleAssignments.map((assignment) => assignment.role.slug),
        );
        if (currentRole !== input.role) {
          for (const assignment of row.roleAssignments) {
            if (isStaffRoleSlug(assignment.role.slug)) {
              await this.roleRepository.revoke(id, assignment.roleId, new Date(), tx);
            }
          }
          await this.roleRepository.grant(
            { userId: id, roleId: nextRole.id, grantedBy: actorId },
            tx,
          );
        }
      }
    });

    return this.getById(id);
  }

  async remove(id: string, actorId: string): Promise<void> {
    if (id === actorId) {
      throw new StaffForbiddenError('You cannot remove your own admin account');
    }
    const row = await this.findStaffRow(id);
    if (!row) throw new StaffNotFoundError();

    await this.transactionManager.execute(async (tx: TransactionClient) => {
      for (const assignment of row.roleAssignments) {
        if (isStaffRoleSlug(assignment.role.slug)) {
          await this.roleRepository.revoke(id, assignment.roleId, new Date(), tx);
        }
      }
      await this.userRepository.updateStatus(id, 'DEACTIVATED', tx);
    });
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
