import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverOnlineStatus, DriverStatus } from '../types';
export class DriverStatusRepository {
  constructor(private readonly db: DatabaseService) {}
  async getStatus(driverId: string, tx?: TransactionClient): Promise<DriverOnlineStatus | null> {
    const client = tx ?? this.db.client;
    return client.driverOnlineStatus.findUnique({
      where: { driverId },
    });
  }
  async updateStatus(
    driverId: string,
    status: DriverStatus,
    extraData?: {
      currentShiftId?: string | null;
      batteryLevel?: number | null;
      networkType?: string | null;
      appVersion?: string | null;
    },
    tx?: TransactionClient,
  ): Promise<DriverOnlineStatus> {
    const client = tx ?? this.db.client;
    const now = new Date();
    const data = {
      status,
      ...extraData,
      ...(status === 'ONLINE' ? { lastOnlineAt: now } : {}),
      ...(status === 'OFFLINE' ? { lastOfflineAt: now } : {}),
    };
    return client.driverOnlineStatus.upsert({
      where: { driverId },
      create: {
        driverId,
        status,
        lastOnlineAt: status === 'ONLINE' ? now : null,
        lastOfflineAt: status === 'OFFLINE' ? now : null,
        ...extraData,
      },
      update: data,
    });
  }
  async updateHeartbeat(
    driverId: string,
    batteryLevel?: number,
    networkType?: string,
    tx?: TransactionClient,
  ): Promise<DriverOnlineStatus> {
    const client = tx ?? this.db.client;
    const now = new Date();
    const data: {
      heartbeatAt: Date;
      batteryLevel?: number;
      networkType?: string;
    } = {
      heartbeatAt: now,
      ...(batteryLevel !== undefined ? { batteryLevel } : {}),
      ...(networkType !== undefined ? { networkType } : {}),
    };
    return client.driverOnlineStatus.upsert({
      where: { driverId },
      update: data,
      create: { driverId, status: 'OFFLINE', ...data },
    });
  }
  async findStaleDrivers(
    thresholdDate: Date,
    tx?: TransactionClient,
  ): Promise<DriverOnlineStatus[]> {
    const client = tx ?? this.db.client;
    return client.driverOnlineStatus.findMany({
      where: {
        status: { in: ['ONLINE', 'BREAK'] },
        heartbeatAt: { lte: thresholdDate },
      },
    });
  }
}
