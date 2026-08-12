import type { FilePurposeName } from '@config/file/file.config.js';

export type ReadGrant =
  | { granted: true; actor: 'owner' }
  | { granted: true; actor: 'ops'; scope: string }
  | { granted: false };

const OPS_SCOPE_FOR_PURPOSE: Readonly<Record<FilePurposeName, string>> = Object.freeze({
  PROFILE_IMAGE: 'users:read',
  DRIVER_DOCUMENT: 'drivers:verify',
  VEHICLE_DOCUMENT: 'drivers:verify',
  VEHICLE_IMAGE: 'drivers:verify',
  SOS_EVIDENCE: 'safety:read',
  DISPUTE_EVIDENCE: 'support:read',
});

const SCOPES_FOR_ROLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  admin: Object.freeze(['users:read', 'drivers:verify', 'safety:read', 'support:read']),
  support: Object.freeze(['support:read', 'safety:read']),
});

export function decideRead(
  file: { ownerUserId: string; purpose: FilePurposeName },
  caller: { userId: string; roles: readonly string[] },
): ReadGrant {
  if (file.ownerUserId === caller.userId) return { granted: true, actor: 'owner' };

  const required = OPS_SCOPE_FOR_PURPOSE[file.purpose];
  const held = caller.roles.flatMap((role) => SCOPES_FOR_ROLE[role] ?? []);
  if (held.includes(required)) return { granted: true, actor: 'ops', scope: required };

  return { granted: false };
}
