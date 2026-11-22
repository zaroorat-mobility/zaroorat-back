import type { FastifyRequest } from 'fastify';
export interface Caller {
  userId: string;
  sid: string;
  roles: string[];
}
export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  readonly statusCode = 401;
  constructor(message = 'This request has no authenticated caller') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}
export class ForbiddenResourceError extends Error {
  readonly code = 'FORBIDDEN';
  readonly statusCode = 403;
  constructor(message = 'You do not have access to this resource') {
    super(message);
    this.name = 'ForbiddenResourceError';
  }
}
export function requireCaller(request: FastifyRequest): Caller {
  const auth = request.auth;
  if (!auth?.userId) throw new UnauthenticatedError();
  return auth;
}
export function callerId(request: FastifyRequest): string {
  return requireCaller(request).userId;
}
export function callerHasRole(request: FastifyRequest, ...roles: string[]): boolean {
  const held = request.auth?.roles ?? [];
  return roles.some((role) => held.includes(role));
}
export const DEFAULT_STAFF_ROLES: readonly string[] = Object.freeze([
  'system_admin',
  'admin',
  'support',
]);

export function callerIsStaff(request: FastifyRequest): boolean {
  const held = request.auth?.roles ?? [];
  return held.some((role) => DEFAULT_STAFF_ROLES.includes(role) || role === 'finance');
}

export function assertOwnerOrStaff(
  request: FastifyRequest,
  ownerUserId: string | null | undefined,
  staffRoles: readonly string[] = DEFAULT_STAFF_ROLES,
): void {
  const caller = requireCaller(request);
  if (ownerUserId && ownerUserId === caller.userId) return;
  if (caller.roles.includes('system_admin')) return;
  if (staffRoles.some((role) => caller.roles.includes(role))) return;
  throw new ForbiddenResourceError();
}

export function assertRideParty(
  request: FastifyRequest,
  ride: {
    customerId: string;
    driverUserId?: string | null;
  },
  staffRoles: readonly string[] = DEFAULT_STAFF_ROLES,
): void {
  const caller = requireCaller(request);
  if (ride.customerId === caller.userId) return;
  if (ride.driverUserId && ride.driverUserId === caller.userId) return;
  if (caller.roles.includes('system_admin')) return;
  if (staffRoles.some((role) => caller.roles.includes(role))) return;
  throw new ForbiddenResourceError();
}
