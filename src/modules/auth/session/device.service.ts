import { EventPublisher } from '@core/events';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager';
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
  async register(input: CreateDeviceInput, tx?: TransactionClient): Promise<UserDevice> {
    if (input.deviceId) {
      const existing = await this.deviceRepository.findByUserAndDevice(
        input.userId,
        input.deviceId,
        tx,
      );
      if (existing) {
        await this.deviceRepository.touchLastSeen(existing.id, undefined, tx);
        // A revoked device re-registers on re-verification (AUTH-INV-6): clear
        // the revocation so a fresh session may bind to it.
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

  /**
   * List the devices bound to an account (self-service device management).
   * @param userId Owner user UUID.
   * @returns The user's devices, most recently seen first.
   */
  async listDevices(userId: string): Promise<UserDevice[]> {
    return this.deviceRepository.findAllByUser(userId);
  }

  /**
   * Revoke a device, but only if it belongs to the caller.
   *
   * The ownership check is a scoped read, not a comparison after an unscoped
   * fetch: an id belonging to another account finds nothing, so there is no row
   * to leak and no branch to forget. Idempotent — revoking an already-revoked
   * device re-runs the transition and reports zero sessions killed, because there
   * were none left to kill.
   *
   * @param userId The caller's user UUID.
   * @param deviceId The device to revoke.
   * @returns The number of sessions revoked, or `null` if the device is unknown
   *          or not owned by the caller.
   */
  async revokeForUser(userId: string, deviceId: string): Promise<number | null> {
    const device = await this.deviceRepository.findOwned(userId, deviceId);
    if (!device) return null;
    return this.revoke(deviceId, 'self');
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
   * @param actor Who revoked it — `self` for the account's owner, `system` for
   *              ops and automated revocation. Recorded on the audit event so a
   *              user-initiated revoke is distinguishable from one done to them.
   * @returns The number of sessions revoked.
   */
  async revoke(deviceId: string, actor: string = 'system'): Promise<number> {
    // Mark the device REVOKED and record the audit event atomically; the device
    // is the authoritative gate, so it must never be revoked without its trail.
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
    // Each session revoke is itself atomic (session + family + event); run them
    // after the device is durably revoked.
    const revoked = await this.sessionService.revokeDeviceSessions(deviceId);
    this.sessionMetrics.deviceRevoked({ deviceId, sessionsRevoked: revoked });
    return revoked;
  }
}
