import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { UserDevice, DeviceTrustState, AppPlatform } from '@core/database/types';

/** Fields captured when a device is first bound at login. */
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

/**
 * Data access for `UserDevice`.
 *
 * A device carries a trust state (`REGISTERED → TRUSTED → SUSPICIOUS → REVOKED`)
 * that gates step-up and revocation (auth doc 01 §6). Prisma-only; the trust
 * transition policy lives in `DeviceService`.
 */
export class DeviceRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Fetch a device by primary key.
   * @param id Device UUID (`UserDevice.id`).
   * @returns The device, or `null` if unknown.
   */
  async findById(id: string): Promise<UserDevice | null> {
    return this.client.userDevice.findUnique({ where: { id } });
  }

  /**
   * Fetch the device a session is bound to, in one query.
   *
   * Used by the sensitive-action guard, which runs on the authorize path and has
   * only a `sid` to work from — the access token carries `{sub, sid, roles,
   * epoch}` and nothing about the device (doc 02 §3.2), so this is resolved
   * rather than claimed. One join rather than two round trips, because it is on a
   * request path.
   *
   * @param sessionId Session UUID (`sid`).
   * @returns The bound device, or `null` if the session is unknown or was opened
   *          without a device binding.
   */
  async findBySession(sessionId: string): Promise<UserDevice | null> {
    const session = await this.client.userSession.findUnique({
      where: { id: sessionId },
      select: { device: true },
    });
    return session?.device ?? null;
  }

  /**
   * List a user's bound devices, most recently seen first.
   *
   * Revoked devices are included: the point of the list is to show the user
   * everything that has ever held a session on their account, and hiding a
   * revocation is hiding the security event they most need to see. The client
   * distinguishes them by `trustState`.
   *
   * @param userId Owner user UUID.
   * @returns The user's devices, newest activity first, then newest bound.
   */
  async findAllByUser(userId: string): Promise<UserDevice[]> {
    return this.client.userDevice.findMany({
      where: { userId },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
  }

  /**
   * Fetch a device, scoped to its owner.
   *
   * Ownership belongs in the `WHERE` clause: a device id that belongs to someone
   * else must return no row, not a row the caller then has to remember to check.
   * @param userId Owner user UUID.
   * @param id Device UUID.
   * @returns The device, or `null` if unknown **or not owned**.
   */
  async findOwned(userId: string, id: string): Promise<UserDevice | null> {
    return this.client.userDevice.findFirst({ where: { id, userId } });
  }

  /**
   * Find a user's device by its client-reported id.
   * @param userId Owner user UUID.
   * @param deviceId Client-reported stable device id.
   * @returns The matching device, or `null`.
   */
  async findByUserAndDevice(
    userId: string,
    deviceId: string,
    tx?: TransactionClient,
  ): Promise<UserDevice | null> {
    return (tx ?? this.client).userDevice.findFirst({ where: { userId, deviceId } });
  }

  /**
   * Bind a new device (defaults to `REGISTERED` trust).
   * @param input Owner plus optional client id, platform, and risk signals.
   * @returns The created device.
   */
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

  /**
   * Update a device's last-seen timestamp.
   * @param id Device UUID.
   * @param at Observation instant.
   */
  async touchLastSeen(id: string, at: Date = new Date(), tx?: TransactionClient): Promise<void> {
    await (tx ?? this.client).userDevice.update({ where: { id }, data: { lastSeenAt: at } });
  }

  /**
   * Set a device's trust state.
   * @param id Device UUID.
   * @param trustState New trust state.
   * @param tx Transaction client to join, so the transition and its audit event
   *           commit atomically (omit for a standalone write).
   * @returns The updated device.
   */
  async updateTrustState(
    id: string,
    trustState: DeviceTrustState,
    tx?: TransactionClient,
  ): Promise<UserDevice> {
    return (tx ?? this.client).userDevice.update({ where: { id }, data: { trustState } });
  }
}
