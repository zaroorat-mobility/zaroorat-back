import { EventPublisher } from '@core/events';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager';
import type { UserDevice } from '@core/database/types';
import { DeviceRepository, type CreateDeviceInput } from '../../repositories/device.repository';
import { authEvent } from '../../events';
import { SessionService } from './session.service';
import { SessionMetrics } from '../../metrics';
export class DeviceService {
  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly sessionService: SessionService,
    private readonly sessionMetrics: SessionMetrics,
    private readonly eventPublisher: EventPublisher,
    private readonly transactionManager: TransactionManager,
  ) {}
  async register(input: CreateDeviceInput, tx?: TransactionClient): Promise<UserDevice> {
    if (input.deviceId) {
      const existing = await this.deviceRepository.findByUserAndDevice(
        input.userId,
        input.deviceId,
        tx,
      );
      if (existing) {
        await this.deviceRepository.touchLastSeen(existing.id, undefined, tx);
        if (existing.trustState === 'REVOKED') {
          return this.deviceRepository.updateTrustState(existing.id, 'REGISTERED', tx);
        }
        return existing;
      }
    }
    const device = await this.deviceRepository.create(input, tx);
    this.sessionMetrics.deviceRegistered({ userId: input.userId });
    return device;
  }
  async listDevices(userId: string): Promise<UserDevice[]> {
    return this.deviceRepository.findAllByUser(userId);
  }
  async revokeForUser(userId: string, deviceId: string): Promise<number | null> {
    const device = await this.deviceRepository.findOwned(userId, deviceId);
    if (!device) return null;
    return this.revoke(deviceId, 'self');
  }
  async touchLastSeen(deviceId: string, at: Date = new Date()): Promise<void> {
    await this.deviceRepository.touchLastSeen(deviceId, at);
  }
  async markTrusted(deviceId: string): Promise<UserDevice> {
    return this.deviceRepository.updateTrustState(deviceId, 'TRUSTED');
  }
  async markSuspicious(deviceId: string): Promise<UserDevice> {
    return this.transactionManager.execute(async (tx) => {
      const device = await this.deviceRepository.updateTrustState(deviceId, 'SUSPICIOUS', tx);
      await this.eventPublisher.publish(
        authEvent('auth.device.flagged', {
          aggregateId: deviceId,
          subjectUserId: device.userId,
          data: { userId: device.userId, deviceId, from: 'REGISTERED', to: 'SUSPICIOUS' },
        }),
        tx,
      );
      return device;
    });
  }
  async revoke(deviceId: string, actor: string = 'system'): Promise<number> {
    await this.transactionManager.execute(async (tx) => {
      const device = await this.deviceRepository.updateTrustState(deviceId, 'REVOKED', tx);
      await this.eventPublisher.publish(
        authEvent('auth.device.revoked', {
          aggregateId: deviceId,
          subjectUserId: device.userId,
          data: { userId: device.userId, deviceId, to: 'REVOKED', actor },
        }),
        tx,
      );
    });
    const revoked = await this.sessionService.revokeDeviceSessions(deviceId);
    this.sessionMetrics.deviceRevoked({ deviceId, sessionsRevoked: revoked });
    return revoked;
  }
}
