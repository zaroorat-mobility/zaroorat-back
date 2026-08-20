import type { FastifyRequest } from 'fastify';
import { callerHasRole, callerId, ForbiddenResourceError } from '@core/auth';
import type { DriverRepository } from '../repositories/driver.repository.js';
import { DriverNotFoundError } from '../errors/driver.errors.js';
export async function actingDriverId(
  request: FastifyRequest,
  driverRepository: DriverRepository,
): Promise<string> {
  const userId = callerId(request);
  const driver = await driverRepository.findByUserId(userId);
  if (!driver) throw new DriverNotFoundError(userId);
  return driver.id;
}
export async function authorizedDriverId(
  request: FastifyRequest,
  driverRepository: DriverRepository,
  requestedDriverId?: string | undefined,
  staffRoles: string[] = ['admin', 'support'],
): Promise<string> {
  // A staff caller acting on an explicit :driverId does not need a Driver row
  // of their own — requiring one would make every staff-only endpoint 404 for
  // any admin/support user who never onboarded as a driver themselves.
  if (requestedDriverId && callerHasRole(request, ...staffRoles)) {
    return requestedDriverId;
  }
  const own = await actingDriverId(request, driverRepository);
  if (!requestedDriverId || requestedDriverId === own) return own;
  throw new ForbiddenResourceError('You may only act on your own driver profile');
}
