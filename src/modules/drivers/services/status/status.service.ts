import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { DriverRepository } from '../../repositories/driver.repository.js';
import { DriverStatusRepository } from '../../repositories/driver-status.repository.js';
import { DriverShiftRepository } from '../../repositories/driver-shift.repository.js';
import { DriverDocumentRepository } from '../../repositories/driver-document.repository.js';
import {
  DriverNotFoundError,
  DriverNotVerifiedError,
  DriverSuspendedError,
  DriverOnTripError,
} from '../../errors/driver.errors.js';
import { driverEvent, DRIVER_EVENT_CATALOG } from '../../events/catalog.js';
import { DriverMetrics } from '../../metrics/driver.metrics.js';
import { GeoService } from '@modules/geo';
import type { DriverOnlineStatus } from '../../types';
export class StatusService {
  constructor(
    private readonly driverRepo: DriverRepository,
    private readonly statusRepo: DriverStatusRepository,
    private readonly shiftRepo: DriverShiftRepository,
    private readonly docRepo: DriverDocumentRepository,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly driverMetrics: DriverMetrics,
    private readonly geoService: GeoService,
  ) {}
  async setOnline(
    driverId: string,
    metadata?: {
      batteryLevel?: number;
      networkType?: string;
    },
  ): Promise<DriverOnlineStatus> {
    return this.txManager.execute(async (tx) => {
      const driver = await this.driverRepo.lockForUpdate(driverId, tx);
      if (!driver) throw new DriverNotFoundError(driverId);
      if (driver.verificationStatus !== 'VERIFIED') {
        throw new DriverNotVerifiedError(
          `Driver verification status is '${driver.verificationStatus}', required: 'VERIFIED'`,
        );
      }
      if (driver.isSuspended) {
        throw new DriverSuspendedError('Driver is suspended and cannot go ONLINE');
      }
      const docs = await this.docRepo.findByDriverId(driverId, tx);
      const hasValidLicense = docs.some(
        (d) => d.documentType === 'DRIVING_LICENSE' && d.verificationStatus === 'VERIFIED',
      );
      if (!hasValidLicense) {
        throw new DriverNotVerifiedError('Driver does not have a verified Driving License');
      }
      const shift = await this.shiftRepo.startShift(driverId, tx);
      await this.driverRepo.updateAvailability(driverId, true, tx);
      const onlineStatus = await this.statusRepo.updateStatus(
        driverId,
        'ONLINE',
        {
          currentShiftId: shift.id,
          batteryLevel: metadata?.batteryLevel ?? null,
          networkType: metadata?.networkType ?? null,
        },
        tx,
      );
      this.driverMetrics.driverOnline({ driverId });
      await this.eventPublisher.publish(
        driverEvent(DRIVER_EVENT_CATALOG.STATUS_CHANGED, driverId, {
          driverId,
          status: 'ONLINE',
          shiftId: shift.id,
        }),
        tx,
      );
      return onlineStatus;
    });
  }
  async setOffline(driverId: string, reason = 'DRIVER_REQUESTED'): Promise<DriverOnlineStatus> {
    const status = await this.txManager.execute(async (tx) => {
      const driver = await this.driverRepo.lockForUpdate(driverId, tx);
      if (!driver) throw new DriverNotFoundError(driverId);
      const currentStatus = await this.statusRepo.getStatus(driverId, tx);
      if (currentStatus?.status === 'ON_TRIP') {
        throw new DriverOnTripError();
      }
      const activeShift = await this.shiftRepo.findActiveShift(driverId, tx);
      if (activeShift) {
        await this.shiftRepo.endShift(activeShift.id, tx);
      }
      await this.driverRepo.updateAvailability(driverId, false, tx);
      const offlineStatus = await this.statusRepo.updateStatus(
        driverId,
        'OFFLINE',
        { currentShiftId: null },
        tx,
      );
      this.driverMetrics.driverOffline({ driverId, reason });
      await this.eventPublisher.publish(
        driverEvent(DRIVER_EVENT_CATALOG.STATUS_CHANGED, driverId, {
          driverId,
          status: 'OFFLINE',
          reason,
        }),
        tx,
      );
      return offlineStatus;
    });
    await this.geoService.forgetDriverPosition(driverId);
    return status;
  }
  async recordHeartbeat(
    driverId: string,
    metadata?: {
      batteryLevel?: number;
      networkType?: string;
    },
  ): Promise<void> {
    const status = await this.statusRepo.getStatus(driverId);
    if (!status || status.status === 'OFFLINE') return;
    await this.statusRepo.updateHeartbeat(driverId, metadata?.batteryLevel, metadata?.networkType);
    this.driverMetrics.heartbeatReceived({ driverId });
  }
  async setSuspended(driverId: string, isSuspended: boolean): Promise<void> {
    await this.txManager.execute(async (tx) => {
      await this.driverRepo.lockForUpdate(driverId, tx);
      await this.driverRepo.setSuspended(driverId, isSuspended, tx);
      if (isSuspended) {
        await this.setOffline(driverId, 'ADMIN_SUSPENSION');
        this.driverMetrics.driverSuspended({ driverId });
        await this.eventPublisher.publish(
          driverEvent(DRIVER_EVENT_CATALOG.SUSPENDED, driverId, { driverId }),
          tx,
        );
      }
    });
  }
}
