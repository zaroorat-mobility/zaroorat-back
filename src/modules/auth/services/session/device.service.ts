import { EventPublisher } from '@core/events';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager';
import type { UserDevice } from '@core/database/types';
import { DeviceRepository, type CreateDeviceInput } from '../../repositories/device.repository';
import { authEvent } from '../../events';
import { DeviceIdRequiredError } from '../../errors/auth.errors.js';
import { logger } from '@shared/logger/index.js';
import { isUuid } from '@shared/validation/index.js';
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
  /// Login-time device registration. A token supplied at login (`device.fcmToken`
  /// on OTP verify) is claimed under the same rule as `updateFcmToken`: released
  /// from every other user first, then written to this device — for an existing
  /// row as well as a new one. Previously a new row was created holding the token
  /// with no release, so a shared handset left two users deliverable to it, and an
  /// existing row silently ignored the token.
  ///
  /// Always transactional: the claim is two writes that must commit together. The
  /// login flow passes its own transaction; any other caller gets one here.
  async register(input: CreateDeviceInput, tx?: TransactionClient): Promise<UserDevice> {
    if (!tx) {
      return this.transactionManager.execute((own) => this.register(input, own));
    }

    const token = input.fcmToken ?? null;
    const released = token ? await this.releaseTokenFromOtherUsers(token, input.userId, tx) : 0;
    if (released > 0) {
      logger.warn(
        { userId: input.userId, releasedFromOtherUsers: released },
        '[auth] push token supplied at login was held by another user and has been released',
      );
    }

    if (input.deviceId) {
      const existing = await this.deviceRepository.findByUserAndDevice(
        input.userId,
        input.deviceId,
        tx,
      );
      if (existing) {
        await this.deviceRepository.touchLastSeen(existing.id, undefined, tx);
        let device = existing;
        if (existing.trustState === 'REVOKED') {
          device = await this.deviceRepository.updateTrustState(existing.id, 'REGISTERED', tx);
        }
        if (token && device.fcmToken !== token) {
          device = await this.deviceRepository.updateFcmToken(existing.id, token, tx);
        }
        return device;
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

  /// Makes one device undeliverable without revoking it.
  ///
  /// The logout counterpart to `revoke`: the device stays REGISTERED and
  /// re-registerable, it simply holds no push token until the next launch. Called
  /// by `AuthService`, which owns logout cleanup — `SessionService` deliberately
  /// has no device dependency (D-1).
  async clearPushTokenForDevice(deviceId: string): Promise<number> {
    return this.deviceRepository.clearFcmTokenForDevice(deviceId);
  }

  /// The logout-everywhere counterpart: every device this user holds becomes
  /// undeliverable, and every one of them stays re-registerable.
  async clearPushTokensForUser(userId: string): Promise<number> {
    return this.deviceRepository.clearFcmTokensForUser(userId);
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
  /// Revokes a device and stops it being deliverable, in one transaction.
  ///
  /// The call is unchanged — `updateTrustState(id, 'REVOKED', tx)` — because the
  /// token release and the `revokedAt` stamp now belong to that transition itself
  /// (see `DeviceRepository.updateTrustState`). Previously the row kept its
  /// `fcmToken`, and `findLatestFcmToken` did not filter on trust state, so a
  /// device whose sessions had just been terminated carried on receiving every
  /// notification the user was sent. PA-5 closed the read side; the repository
  /// change closes the write side.
  ///
  /// The event publish stays inside the same transaction, as before, so a
  /// revocation is never announced for work that rolled back.
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

  /// Binds an FCM token to one of the caller's devices, releasing it from anyone
  /// else who holds it.
  ///
  /// ## Why the cross-user clear exists
  ///
  /// FCM issues one registration token per app install, not per account. On a
  /// shared handset, user A logs out and user B logs in, and both `UserDevice`
  /// rows end up holding the same token. A notification for A then resolves to
  /// that token and is delivered to a phone showing B's session — A's fare, A's
  /// ride status, on B's screen. That is the only notification defect that crosses
  /// a user boundary, so it is closed here at the moment of the claim.
  ///
  /// ## Why one transaction
  ///
  /// Release-then-claim must be atomic in both directions. If the claim failed
  /// after the release committed, the previous owner would be stripped of a token
  /// nobody took ownership of — a user silently unsubscribed from their own
  /// notifications. If the release failed after the claim committed, two users
  /// would hold the token and the leak would be live. Neither partial state is
  /// acceptable, so both writes share one transaction and fail together.
  ///
  /// ## Why a missing deviceId is refused
  ///
  /// See `DeviceIdRequiredError`. The previous fallback minted a row with a NULL
  /// `deviceId`, which the `@@unique([userId, deviceId])` constraint cannot bound,
  /// so repeated calls accumulated unbounded token-holding rows for one user.
  async updateFcmToken(
    userId: string,
    sessionId: string,
    fcmToken: string,
    deviceId?: string,
  ): Promise<{ deviceId: string; fcmToken: string }> {
    const targetId = deviceId ?? (await this.sessionService.deviceIdFor(sessionId));
    if (!targetId) {
      throw new DeviceIdRequiredError();
    }

    // Resolved before the transaction so it stays short: these are reads, and the
    // row they find is only written to inside it. `deviceId` from the body is the
    // client-side stable id (`user_devices.device_id`), but a row id is still
    // accepted, so both are tried. The row-id lookup only runs for UUID-shaped
    // input: `user_devices.id` is a UUID column, and PostgreSQL rejects any other
    // literal with an error rather than a miss — which is how `dev_…` ids became
    // a 500.
    const owned =
      (isUuid(targetId) ? await this.deviceRepository.findOwned(userId, targetId) : null) ??
      (await this.deviceRepository.findByUserAndDevice(userId, targetId));

    // A client id nobody holds yet may belong to the device this session logged in
    // on: clients that sent no `device` at login got a row with a NULL `deviceId`.
    // That row, not a new one, must take the id and the token — logout clears the
    // session's device, so a token on any other row would survive logout.
    const sessionDeviceId =
      !owned && deviceId ? await this.sessionService.deviceIdFor(sessionId) : null;

    const { resolvedDeviceId, releasedFromOtherUsers } = await this.transactionManager.execute(
      async (tx) => {
        // Release first. Doing it after the claim would leave a window in which
        // two users both hold the token, which is the leak itself.
        const released = await this.releaseTokenFromOtherUsers(fcmToken, userId, tx);

        if (owned) {
          await this.deviceRepository.updateFcmToken(owned.id, fcmToken, tx);
          await this.deviceRepository.touchLastSeen(owned.id, undefined, tx);
          return { resolvedDeviceId: owned.id, releasedFromOtherUsers: released };
        }

        // The `deviceId IS NULL` guard is in the write itself, so a session row that
        // already has an identity is never overwritten — it falls through to create.
        if (
          sessionDeviceId &&
          (await this.deviceRepository.linkClientDeviceId(sessionDeviceId, userId, targetId, tx))
        ) {
          await this.deviceRepository.updateFcmToken(sessionDeviceId, fcmToken, tx);
          await this.deviceRepository.touchLastSeen(sessionDeviceId, undefined, tx);
          return { resolvedDeviceId: sessionDeviceId, releasedFromOtherUsers: released };
        }

        // First registration for this client-side device id. `targetId` is a real
        // client-reported id here, never invented.
        const created = await this.deviceRepository.create(
          { userId, deviceId: targetId, fcmToken },
          tx,
        );
        return { resolvedDeviceId: created.id, releasedFromOtherUsers: released };
      },
    );

    if (releasedFromOtherUsers > 0) {
      // Worth a warning, not a debug line: every one of these is a handset that
      // changed hands while the previous account was still deliverable to it.
      logger.warn(
        { userId, deviceId: resolvedDeviceId, releasedFromOtherUsers },
        '[auth] push token was held by another user and has been released',
      );
    }

    return { deviceId: resolvedDeviceId, fcmToken };
  }

  /// The one step every token claim goes through, `register` and
  /// `updateFcmToken` alike: at most one user may hold a given FCM token.
  ///
  /// Lock, then release. The lock makes a concurrent claim of the same token wait
  /// for this transaction to finish (see `DeviceRepository.lockFcmToken`); without
  /// it both claimants' releases miss each other and both keep the token. The
  /// caller writes its own claim afterwards, in the same transaction.
  private async releaseTokenFromOtherUsers(
    token: string,
    userId: string,
    tx: TransactionClient,
  ): Promise<number> {
    await this.deviceRepository.lockFcmToken(token, tx);
    return this.deviceRepository.clearFcmTokenForOtherUsers(token, userId, tx);
  }
}
