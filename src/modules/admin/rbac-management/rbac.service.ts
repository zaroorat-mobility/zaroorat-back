import {
  END_USER_ROLE_SLUGS,
  LOCKED_PERMISSION_CODES,
  SYSTEM_ADMIN_ROLE_SLUG,
  isAssignableStaffRoleSlug,
} from '@modules/auth/constants/auth.constants.js';
import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { authEvent } from '@modules/auth/events/index.js';
import { PermissionRepository } from '@modules/auth/repositories/permission.repository.js';
import { RoleRepository } from '@modules/auth/repositories/role.repository.js';
import { recordAdminAction, type AuditActor } from '../audit/index.js';
import { RbacConflictError, RbacForbiddenError, RbacNotFoundError } from './rbac.errors.js';
import type { CreateRoleBody } from './rbac.schemas.js';

const LOCKED = new Set<string>(LOCKED_PERMISSION_CODES);
const RESERVED_ROLE_SLUGS = new Set<string>([SYSTEM_ADMIN_ROLE_SLUG, ...END_USER_ROLE_SLUGS]);

export function slugifyRoleName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

export class AdminRbacService {
  constructor(
    private readonly roleRepository: RoleRepository,
    private readonly permissionRepository: PermissionRepository,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async listPermissions() {
    const rows = await this.permissionRepository.listAll();
    return rows.map((row) => ({
      code: row.code,
      resource: row.resource,
      action: row.action,
      description: row.description,
      locked: LOCKED.has(row.code),
    }));
  }

  async listRoles() {
    const roles = await this.roleRepository.listAssignableStaffRoles([
      SYSTEM_ADMIN_ROLE_SLUG,
      ...END_USER_ROLE_SLUGS,
    ]);
    return Promise.all(roles.map((role) => this.toRoleDto(role)));
  }

  /// Grants take effect on the next request of every holder without any token change:
  /// `authorize` reads permissions from the database per request, and access tokens
  /// carry role slugs, never permission codes.
  async createRole(input: CreateRoleBody, actor: AuditActor) {
    const slug = slugifyRoleName(input.name);
    if (!slug) {
      throw new RbacConflictError('Role name must include letters or numbers');
    }
    if (RESERVED_ROLE_SLUGS.has(slug)) {
      throw new RbacForbiddenError(`The role '${slug}' is reserved`);
    }
    const existing = await this.roleRepository.findBySlug(slug);
    if (existing) {
      throw new RbacConflictError(`A role named '${slug}' already exists`);
    }

    const codes = input.permissionCodes ?? [];
    if (codes.length > 0) await this.assertGrantable(codes);

    const role = await this.transactionManager.execute(async (tx) => {
      const created = await this.roleRepository.create(
        {
          slug,
          name: input.name.trim(),
          description: input.description ?? null,
          isSystem: false,
        },
        tx,
      );
      if (codes.length > 0) await this.permissionRepository.replaceRoleCodes(created.id, codes, tx);
      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'role',
        entityId: created.id,
        summary: `Role ${created.slug} created`,
        after: { slug: created.slug, permissionCodes: [...codes].sort() },
        result: 'SUCCESS',
      });
      return created;
    });
    return this.toRoleDto(role);
  }

  async replaceRolePermissions(slug: string, permissionCodes: string[], actor: AuditActor) {
    if (slug === SYSTEM_ADMIN_ROLE_SLUG) {
      throw new RbacForbiddenError('The system_admin role cannot be edited');
    }
    if (!isAssignableStaffRoleSlug(slug)) {
      throw new RbacForbiddenError('Only staff roles can have their grants changed');
    }
    await this.assertGrantable(permissionCodes);
    const role = await this.roleRepository.findBySlug(slug);
    if (!role) throw new RbacNotFoundError();

    await this.transactionManager.execute(async (tx) => {
      const before = await this.permissionRepository.listCodesForRole(role.id, tx);
      await this.permissionRepository.replaceRoleCodes(role.id, permissionCodes, tx);
      const after = [...new Set(permissionCodes)].sort();
      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'role',
        entityId: role.id,
        summary: `Permissions of role ${role.slug} replaced`,
        before: { slug: role.slug, permissionCodes: [...before].sort() },
        after: {
          slug: role.slug,
          permissionCodes: after,
          added: after.filter((code) => !before.includes(code)),
          removed: before.filter((code) => !after.includes(code)).sort(),
        },
        result: 'SUCCESS',
      });
      // HTTP reads permissions per request, but an open socket's dashboard rooms were
      // granted at subscribe time; this is what makes the socket layer decide again.
      await this.eventPublisher.publish(
        authEvent('auth.role.permissions_changed', {
          aggregateId: role.id,
          data: { roleId: role.id, roleSlug: role.slug },
        }),
        tx,
      );
    });
    return this.toRoleDto(role);
  }

  /// Locked codes (rbac:manage, staff:write) can never be granted, and every code must exist.
  private async assertGrantable(permissionCodes: string[]): Promise<void> {
    const lockedRequested = permissionCodes.filter((code) => LOCKED.has(code));
    if (lockedRequested.length > 0) {
      throw new RbacForbiddenError(
        `These permissions cannot be granted: ${lockedRequested.join(', ')}`,
      );
    }
    const catalog = await this.permissionRepository.listAll();
    const known = new Set(catalog.map((row) => row.code));
    const unknown = permissionCodes.filter((code) => !known.has(code));
    if (unknown.length > 0) {
      throw new RbacConflictError(`Unknown permission codes: ${unknown.join(', ')}`);
    }
  }

  private async toRoleDto(role: {
    slug: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    id: string;
  }) {
    return {
      slug: role.slug,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      editable: role.slug !== SYSTEM_ADMIN_ROLE_SLUG,
      permissionCodes: await this.permissionRepository.listCodesForRole(role.id),
    };
  }
}
