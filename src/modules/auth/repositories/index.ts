import { asClass, AwilixContainer } from 'awilix';

import { UserRepository } from './user.repository';
import { OtpRepository } from './otp.repository';
import { SessionRepository } from './session.repository';
import { RefreshTokenRepository } from './refresh-token.repository';
import { RoleRepository } from './role.repository';
import { PermissionRepository } from './permission.repository';
import { DeviceRepository } from './device.repository';
import { DriverAccessRepository } from './driver-access.repository';

export { UserRepository, type CreateUserInput } from './user.repository';
export { OtpRepository, type CreateOtpAttemptInput, type OtpOutcome } from './otp.repository';
export { SessionRepository, type CreateSessionInput } from './session.repository';
export { RefreshTokenRepository, type CreateRefreshTokenInput } from './refresh-token.repository';
export { RoleRepository, type GrantRoleInput } from './role.repository';
export { PermissionRepository } from './permission.repository';
export { DeviceRepository, type CreateDeviceInput } from './device.repository';
export { DriverAccessRepository } from './driver-access.repository';

export function registerAuthRepositories(container: AwilixContainer): void {
  container.register({
    userRepository: asClass(UserRepository).singleton(),
    otpRepository: asClass(OtpRepository).singleton(),
    sessionRepository: asClass(SessionRepository).singleton(),
    refreshTokenRepository: asClass(RefreshTokenRepository).singleton(),
    roleRepository: asClass(RoleRepository).singleton(),
    permissionRepository: asClass(PermissionRepository).singleton(),
    deviceRepository: asClass(DeviceRepository).singleton(),
    driverAccessRepository: asClass(DriverAccessRepository).singleton(),
  });
}
