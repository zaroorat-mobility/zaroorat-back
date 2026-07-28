import { EventPublisher } from '@core/events';
import { TransactionManager } from '@core/database/TransactionManager';
import type { UserDevice } from '@core/database/types';
import { DeviceRepository, type CreateDeviceInput } from '../repositories/device.repository';
import { authEvent } from '../events';
import { SessionService } from './session.service';
import { SessionMetrics } from './session.metrics';

/**
 * Device identity and trust management (auth doc 01 §6, doc 02 §5.2).
 *
 * Binds a device at login and owns its trust-state transitions
 * (`REGISTERED → TRUSTED → SUSPICIOUS → REVOKED`). The signals that drive a
 * device to `SUSPICIOUS` are a post-v1 risk concern; the states and the
 * deterministic transitions (bind, trust, revoke) exist now. Revoking a device
 * also kills its sessions (AUTH-INV-6).
 */
export class DeviceService {
  /**
   * @param deviceRepository Device persistence.
   * @param sessionService Used to revoke a device's sessions on revocation.
   * @param sessionMetrics Device lifecycle counters.
   * @param eventPublisher Emits device trust-transition events.
   * @param transactionManager Commits a trust transition and its audit event atomically.
   */
  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly sessionService: SessionService,
    private readonly sessionMetrics: SessionMetrics,
    private readonly eventPublisher: EventPublisher,
    private readonly transactionManager: TransactionManager,
  ) {}

  /**
   * Bind a device at login: return (and refresh) the existing record for a
   * known client id, or create a new one.
   * @param input Owner plus optional client id, platform, and risk signals.
   * @returns The bound device (its `id` is used as the session's `deviceId`).
   */
  async register(input: CreateDeviceInput): Promise<UserDevice> {
    if (input.deviceId) {
      const existing = await this.deviceRepository.findByUserAndDevice(
        input.userId,
        input.deviceId,
      );
      if (existing) {
        await this.deviceRepository.touchLastSeen(existing.id);
        // A revoked device re-registers on re-verification (AUTH-INV-6): clear
        // the revocation so a fresh session may bind to it.
        if (existing.trustState === 'REVOKED') {
          return this.deviceRepository.updateTrustState(existing.id, 'REGISTERED');
        }
        return existing;
      }
    }
    const device = await this.deviceRepository.create(input);
    this.sessionMetrics.deviceRegistered({ userId: input.userId });
    return device;
  }

  /**
   * Update a device's last-seen timestamp.
   * @param deviceId Device UUID.
   * @param at Observation instant.
   */
  async touchLastSeen(deviceId: string, at: Date = new Date()): Promise<void> {
    await this.deviceRepository.touchLastSeen(deviceId, at);
  }

  /**
   * Promote a device to `TRUSTED` (good history).
   * @param deviceId Device UUID.
   * @returns The updated device.
   */
  async markTrusted(deviceId: string): Promise<UserDevice> {
    return this.deviceRepository.updateTrustState(deviceId, 'TRUSTED');
  }

  /**
   * Flag a device as `SUSPICIOUS` (anomaly observed — step-up may be required).
   * @param deviceId Device UUID.
   * @returns The updated device.
   */
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

  /**
   * Revoke a device: mark it `REVOKED` and kill its active sessions (INV-6).
   * @param deviceId Device UUID.
   * @returns The number of sessions revoked.
   */
  async revoke(deviceId: string): Promise<number> {
    // Mark the device REVOKED and record the audit event atomically; the device
    // is the authoritative gate, so it must never be revoked without its trail.
    await this.transactionManager.execute(async (tx) => {
      const device = await this.deviceRepository.updateTrustState(deviceId, 'REVOKED', tx);
      await this.eventPublisher.publish(
        authEvent('auth.device.revoked', {
          aggregateId: deviceId,
          subjectUserId: device.userId,
          data: { userId: device.userId, deviceId, to: 'REVOKED', actor: 'system' },
        }),
        tx,
      );
    });
    // Each session revoke is itself atomic (session + family + event); run them
    // after the device is durably revoked.
    const revoked = await this.sessionService.revokeDeviceSessions(deviceId);
    this.sessionMetrics.deviceRevoked({ deviceId, sessionsRevoked: revoked });
    return revoked;
  }
}
