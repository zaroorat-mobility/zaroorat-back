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
  const own = await actingDriverId(request, driverRepository);

  if (!requestedDriverId || requestedDriverId === own) return own;
  if (callerHasRole(request, ...staffRoles)) return requestedDriverId;

  throw new ForbiddenResourceError('You may only act on your own driver profile');
}
