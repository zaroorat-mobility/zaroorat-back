import type { FilePurposeName } from '@config/file/file.config.js';

/**
 * The read policy (files doc 02 §4) — the whole of this module's authorization.
 *
 * Authorization here is **relational**, not role-based: it depends on the
 * caller's relationship to *this* file, which a route-level guard cannot see.
 * That is why no route declares a role check (doc 02 §3).
 */

/** How a caller is entitled to read a file, or that they are not. */
export type ReadGrant =
  | { granted: true; actor: 'owner' }
  | { granted: true; actor: 'ops'; scope: string }
  | { granted: false };

/**
 * The ops scope that may read each purpose, and nothing else may (doc 02 §4).
 *
 * A rider must never read a driver's licence, and a driver must never read a
 * rider's photo. There is no "both are on the same trip" exception in v1.
 */
const OPS_SCOPE_FOR_PURPOSE: Readonly<Record<FilePurposeName, string>> = Object.freeze({
  PROFILE_IMAGE: 'users:read',
  DRIVER_DOCUMENT: 'drivers:verify',
  VEHICLE_DOCUMENT: 'drivers:verify',
  VEHICLE_IMAGE: 'drivers:verify',
  SOS_EVIDENCE: 'safety:read',
  DISPUTE_EVIDENCE: 'support:read',
});

/**
 * Scopes each seeded role carries.
 *
 * **A stand-in, and deliberately a narrow one.** Doc 02 §4 names these scopes
 * "for the policy's sake" and says `admin` owns granting them — but that module
 * is a stub, and the JWT carries role slugs rather than permissions (auth doc 02
 * §3.2). Deriving scopes from roles is the smallest thing that makes the policy
 * executable now; when `admin` ships, this map is replaced by the permission
 * join it already models (`Permission`, `RolePermission`) and nothing else in
 * the module changes.
 *
 * Until then **only the owner branch is reachable in practice**, because nothing
 * grants `admin` or `support` to a real account (doc 02 §4).
 */
const SCOPES_FOR_ROLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  admin: Object.freeze(['users:read', 'drivers:verify', 'safety:read', 'support:read']),
  support: Object.freeze(['support:read', 'safety:read']),
});

/**
 * Decide whether a caller may read a file.
 *
 * @param file The file's owner and purpose.
 * @param caller The requesting user id and their role slugs.
 * @returns The grant, naming the actor kind — and for ops, the scope that
 *          authorized it, which the audit event records so a later review can
 *          ask "who could do this, and should they still?"
 */
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
