import {
  END_USER_ROLE_SLUGS,
  LOCKED_PERMISSION_CODES,
  SYSTEM_ADMIN_ROLE_SLUG,
  isAssignableStaffRoleSlug,
} from '@modules/auth/constants/auth.constants.js';
import { PermissionRepository } from '@modules/auth/repositories/permission.repository.js';
import { RoleRepository } from '@modules/auth/repositories/role.repository.js';
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

  async createRole(input: CreateRoleBody) {
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

    const role = await this.roleRepository.create({
      slug,
      name: input.name.trim(),
      description: input.description ?? null,
      isSystem: false,
    });

    if (input.permissionCodes && input.permissionCodes.length > 0) {
      return this.replaceRolePermissions(role.slug, input.permissionCodes);
    }
    return this.toRoleDto(role);
  }

  async replaceRolePermissions(slug: string, permissionCodes: string[]) {
    if (slug === SYSTEM_ADMIN_ROLE_SLUG) {
      throw new RbacForbiddenError('The system_admin role cannot be edited');
    }
    if (!isAssignableStaffRoleSlug(slug)) {
      throw new RbacForbiddenError('Only staff roles can have their grants changed');
    }
    const lockedRequested = permissionCodes.filter((code) => LOCKED.has(code));
    if (lockedRequested.length > 0) {
      throw new RbacForbiddenError(
        `These permissions cannot be granted: ${lockedRequested.join(', ')}`,
      );
    }
    const role = await this.roleRepository.findBySlug(slug);
    if (!role) throw new RbacNotFoundError();

    const catalog = await this.permissionRepository.listAll();
    const known = new Set(catalog.map((row) => row.code));
    const unknown = permissionCodes.filter((code) => !known.has(code));
    if (unknown.length > 0) {
      throw new RbacConflictError(`Unknown permission codes: ${unknown.join(', ')}`);
    }

    await this.permissionRepository.replaceRoleCodes(role.id, permissionCodes);
    return this.toRoleDto(role);
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
