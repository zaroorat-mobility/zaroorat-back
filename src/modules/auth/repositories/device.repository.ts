import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { UserDevice, DeviceTrustState, AppPlatform } from '@core/database/types';
export interface CreateDeviceInput {
  userId: string;
  deviceId?: string | null;
  platform?: AppPlatform | null;
  fingerprint?: string | null;
  isRooted?: boolean;
  isJailbroken?: boolean;
  fcmToken?: string | null;
  appVersion?: string | null;
  osVersion?: string | null;
}
export class DeviceRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async findById(id: string): Promise<UserDevice | null> {
    return this.client.userDevice.findUnique({ where: { id } });
  }
  async findBySession(sessionId: string): Promise<UserDevice | null> {
    const session = await this.client.userSession.findUnique({
      where: { id: sessionId },
      select: { device: true },
    });
    return session?.device ?? null;
  }
  async findAllByUser(userId: string): Promise<UserDevice[]> {
    return this.client.userDevice.findMany({
      where: { userId },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
  }
  async findOwned(userId: string, id: string): Promise<UserDevice | null> {
    return this.client.userDevice.findFirst({ where: { id, userId } });
  }
  async findByUserAndDevice(
    userId: string,
    deviceId: string,
    tx?: TransactionClient,
  ): Promise<UserDevice | null> {
    return (tx ?? this.client).userDevice.findFirst({ where: { userId, deviceId } });
  }
  async create(input: CreateDeviceInput, tx?: TransactionClient): Promise<UserDevice> {
    return (tx ?? this.client).userDevice.create({
      data: {
        userId: input.userId,
        ...(input.deviceId != null ? { deviceId: input.deviceId } : {}),
        ...(input.platform != null ? { platform: input.platform } : {}),
        ...(input.fingerprint != null ? { fingerprint: input.fingerprint } : {}),
        ...(input.isRooted != null ? { isRooted: input.isRooted } : {}),
        ...(input.isJailbroken != null ? { isJailbroken: input.isJailbroken } : {}),
        ...(input.fcmToken != null ? { fcmToken: input.fcmToken } : {}),
        ...(input.appVersion != null ? { appVersion: input.appVersion } : {}),
        ...(input.osVersion != null ? { osVersion: input.osVersion } : {}),
      },
    });
  }
  async touchLastSeen(id: string, at: Date = new Date(), tx?: TransactionClient): Promise<void> {
    await (tx ?? this.client).userDevice.update({ where: { id }, data: { lastSeenAt: at } });
  }
  async updateTrustState(
    id: string,
    trustState: DeviceTrustState,
    tx?: TransactionClient,
  ): Promise<UserDevice> {
    return (tx ?? this.client).userDevice.update({ where: { id }, data: { trustState } });
  }
  async anonymizeForUser(userId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).userDevice.updateMany({
      where: { userId },
      data: {
        deviceId: null,
        fingerprint: null,
        fcmToken: null,
        trustState: 'REVOKED',
      },
    });
    return count;
  }
}
