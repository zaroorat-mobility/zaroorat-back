import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverShiftLog } from '../types';
export class DriverShiftRepository {
  constructor(private readonly db: DatabaseService) {}
  async findActiveShift(driverId: string, tx?: TransactionClient): Promise<DriverShiftLog | null> {
    const client = tx ?? this.db.client;
    return client.driverShiftLog.findFirst({
      where: {
        driverId,
        shiftEnd: null,
      },
      orderBy: { shiftStart: 'desc' },
    });
  }
  async startShift(driverId: string, tx?: TransactionClient): Promise<DriverShiftLog> {
    const client = tx ?? this.db.client;
    const existing = await this.findActiveShift(driverId, tx);
    if (existing) return existing;
    return client.driverShiftLog.create({
      data: {
        driverId,
        shiftStart: new Date(),
      },
    });
  }
  async endShift(shiftId: string, tx?: TransactionClient): Promise<DriverShiftLog> {
    const client = tx ?? this.db.client;
    const now = new Date();
    const shift = await client.driverShiftLog.findUnique({
      where: { id: shiftId },
    });
    const onlineMinutes = shift
      ? Math.max(0, Math.round((now.getTime() - shift.shiftStart.getTime()) / (1000 * 60)))
      : 0;
    return client.driverShiftLog.update({
      where: { id: shiftId },
      data: {
        shiftEnd: now,
        totalOnlineMinutes: onlineMinutes,
      },
    });
  }
}
