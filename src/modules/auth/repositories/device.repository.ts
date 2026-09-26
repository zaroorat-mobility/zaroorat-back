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
  /// The most recently active device that actually has a push token — a user
  /// may have logged in from several devices, only some of which reported one.
  ///
  /// `trustState` is part of the predicate, not an afterthought. `revoke()` marks
  /// a device REVOKED and terminates its sessions; without this filter the row
  /// kept its `fcmToken` and stayed the *newest* row, so a revoked device went on
  /// receiving every notification the user was sent. Revocation has to mean
  /// revoked on the delivery path too, or it means very little.
  async findLatestFcmToken(userId: string): Promise<string | null> {
    const device = await this.client.userDevice.findFirst({
      where: { userId, fcmToken: { not: null }, trustState: { not: 'REVOKED' } },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: { fcmToken: true },
    });
    return device?.fcmToken ?? null;
  }
  /// Every device a push for this user may go to: the same rules as
  /// `findLatestFcmToken` — holds a token, not REVOKED — newest first.
  ///
  /// One row per distinct token. The same user may hold one token on more than
  /// one row (PA-6 permits it: a re-registration not yet reconciled), and sending
  /// once per row would push the same handset twice.
  async findDeliverableDevices(userId: string): Promise<Array<{ id: string; fcmToken: string }>> {
    const devices = await this.client.userDevice.findMany({
      where: { userId, fcmToken: { not: null }, trustState: { not: 'REVOKED' } },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: { id: true, fcmToken: true },
    });
    const seen = new Set<string>();
    const out: Array<{ id: string; fcmToken: string }> = [];
    for (const { id, fcmToken } of devices) {
      if (!fcmToken || seen.has(fcmToken)) continue;
      seen.add(fcmToken);
      out.push({ id, fcmToken });
    }
    return out;
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
  /// Gives a device row its client-side id, only if it has none.
  ///
  /// `deviceId: null` is part of the `where`, so the guard holds in the database
  /// rather than in a read the caller did earlier: an existing identity is never
  /// overwritten, even by a concurrent request. Scoped to `userId` as well, so a
  /// row id can only be linked by its owner. Returns whether the row was linked.
  async linkClientDeviceId(
    id: string,
    userId: string,
    deviceId: string,
    tx?: TransactionClient,
  ): Promise<boolean> {
    const { count } = await (tx ?? this.client).userDevice.updateMany({
      where: { id, userId, deviceId: null },
      data: { deviceId },
    });
    return count === 1;
  }
  async touchLastSeen(id: string, at: Date = new Date(), tx?: TransactionClient): Promise<void> {
    await (tx ?? this.client).userDevice.update({ where: { id }, data: { lastSeenAt: at } });
  }
  async updateFcmToken(id: string, fcmToken: string, tx?: TransactionClient): Promise<UserDevice> {
    return (tx ?? this.client).userDevice.update({
      where: { id },
      data: { fcmToken },
    });
  }
  /// Moves a device to a trust state, keeping `revokedAt` and `fcmToken`
  /// consistent with it.
  ///
  /// The invariant lives here, in the one place that performs the transition,
  /// rather than in each caller — so no future caller can produce a row that says
  /// REVOKED while still holding a deliverable token, which is precisely the state
  /// that let terminated devices go on receiving notifications:
  ///
  /// - **to REVOKED** — stamp `revokedAt` and release the `fcmToken`. One write, so
  ///   there is no instant at which the row is revoked and still deliverable.
  /// - **to any other state** — clear `revokedAt`. A device that registers again is
  ///   no longer revoked, and leaving the old timestamp behind would make it look
  ///   revoked to the stale-device sweep, which purges by age of revocation.
  async updateTrustState(
    id: string,
    trustState: DeviceTrustState,
    tx?: TransactionClient,
    at: Date = new Date(),
  ): Promise<UserDevice> {
    return (tx ?? this.client).userDevice.update({
      where: { id },
      data:
        trustState === 'REVOKED'
          ? { trustState, revokedAt: at, fcmToken: null }
          : { trustState, revokedAt: null },
    });
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
  /// Nulls `fcmToken` on every device row holding the exact token value.
  /// Called by FcmPushProvider when FCM returns a definitive invalid/unregistered
  /// error, so no further sends are attempted to a dead registration.
  ///
  /// Uses `updateMany` with an exact-match `where` — safe because FCM registration
  /// tokens are globally unique across all devices and users in normal operation.
  /// No `userId` is required; the provider only knows the token, not who owns it.
  async clearFcmTokenByValue(token: string): Promise<void> {
    await this.client.userDevice.updateMany({
      where: { fcmToken: token },
      data: { fcmToken: null },
    });
  }

  /// Releases the push token held by one device, by row id.
  ///
  /// `updateMany`, not `update`, on purpose: a missing or already-cleared row
  /// yields 0 instead of throwing. The caller is logout, which must not fail
  /// because a device row went away underneath it.
  ///
  /// Returns the number of rows cleared, so the caller can tell "nothing to do"
  /// from "released a live token".
  async clearFcmTokenForDevice(deviceId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).userDevice.updateMany({
      where: { id: deviceId, fcmToken: { not: null } },
      data: { fcmToken: null },
    });
    return count;
  }

  /// Releases the push tokens held by every device belonging to one user.
  ///
  /// The logout-everywhere counterpart. Deliberately does not touch `trustState`
  /// or `deviceId`: logging out is not revoking a device, and the rows must stay
  /// re-registerable on the next launch. That distinction is why this is not
  /// `anonymizeForUser`, which exists for erasure and is far more destructive.
  async clearFcmTokensForUser(userId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).userDevice.updateMany({
      where: { userId, fcmToken: { not: null } },
      data: { fcmToken: null },
    });
    return count;
  }

  /// Serialises every claim of one FCM token until the calling transaction ends.
  ///
  /// The release below is an `UPDATE … WHERE fcm_token = $1 AND user_id <> $me`.
  /// Under READ COMMITTED, two transactions claiming the same token concurrently
  /// each run that release before the other's claim is committed, so neither sees
  /// the other and both commit holding the token — reproduced against PostgreSQL,
  /// two owners of one token on the first attempt. Taking a transaction-scoped
  /// advisory lock on the token first makes the second claimant wait for the
  /// first to commit, after which its release does see, and clear, that row.
  ///
  /// Keyed by a hash of the token, so unrelated tokens never wait on each other
  /// (a hash collision costs only a brief extra wait). Released automatically at
  /// commit or rollback, which is why it requires a transaction client: outside
  /// one it would be released at the end of this statement and protect nothing.
  async lockFcmToken(token: string, tx: TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${token}, 0))`;
  }

  /// Releases an FCM token from every user *except* the one now claiming it.
  ///
  /// This is the shared-handset case, and it is the only notification defect that
  /// crosses a user boundary. FCM issues one registration token per app install,
  /// not per account: when user A logs out of a handset and user B logs in, both
  /// rows end up holding the same token. A notification for A then resolves to
  /// that token and is delivered to a phone displaying B's session — A's fare,
  /// A's ride status, on B's screen.
  ///
  /// Called immediately before writing the token to the claiming device, inside
  /// the same transaction, so there is no window in which two users both hold it.
  ///
  /// Scoped by `userId: { not: keepUserId }` rather than by row id on purpose: the
  /// claiming user may legitimately hold this token on more than one row (a
  /// re-registration that has not yet been reconciled), and clearing their own row
  /// would leave them with no deliverable device at all.
  ///
  /// Returns the number of rows released, so the caller can log a real
  /// cross-user collision rather than guessing one happened.
  async clearFcmTokenForOtherUsers(
    token: string,
    keepUserId: string,
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await (tx ?? this.client).userDevice.updateMany({
      where: { fcmToken: token, userId: { not: keepUserId } },
      data: { fcmToken: null },
    });
    return count;
  }
}
