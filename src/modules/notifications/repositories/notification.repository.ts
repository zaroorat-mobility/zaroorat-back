import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import {
  Prisma,
  type Notification,
  type NotificationDelivery,
  type NotificationCategory,
  type NotificationPriority,
  type NotificationStatus,
  type NotificationChannel,
  type DeviceTrustState,
} from '../../../generated/prisma';

export interface CreateNotificationInput {
  userId: string;
  category?: NotificationCategory | undefined;
  priority?: NotificationPriority | undefined;
  eventKey?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  templateId?: string | null | undefined;
  title?: string | null | undefined;
  body?: string | null | undefined;
  data?: Record<string, unknown> | null | undefined;
  referenceType?: string | null | undefined;
  referenceId?: string | null | undefined;
  channel?: NotificationChannel | undefined;
  recipient?: string | null | undefined;
  deviceId?: string | null | undefined;
}

export interface CreateNotificationResult {
  notification: Notification;
  delivery: NotificationDelivery | null;
  isDuplicate: boolean;
}

export interface UpdateDeliveryInput {
  status?: NotificationStatus | undefined;
  provider?: string | null | undefined;
  providerMessageId?: string | null | undefined;
  deviceId?: string | null | undefined;
  attempts?: number | undefined;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  failureReason?: string | null | undefined;
  sentAt?: Date | null | undefined;
  deliveredAt?: Date | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

export class NotificationRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Atomically creates a Notification and its initial NotificationDelivery.
   * Enforces database-level idempotency via idempotencyKey @unique constraint.
   */
  async createNotificationWithDelivery(
    input: CreateNotificationInput,
    tx?: TransactionClient,
  ): Promise<CreateNotificationResult> {
    const client = tx ?? this.client;

    if (input.idempotencyKey) {
      const existing = await client.notification.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { deliveries: true },
      });

      if (existing) {
        const existingDelivery = existing.deliveries[0] ?? null;
        return {
          notification: existing,
          delivery: existingDelivery,
          isDuplicate: true,
        };
      }
    }

    try {
      const category = input.category ?? 'TRANSACTIONAL';
      const priority = input.priority ?? 'NORMAL';
      const channel = input.channel ?? 'PUSH';

      const notification = await client.notification.create({
        data: {
          userId: input.userId,
          category,
          priority,
          eventKey: input.eventKey ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          templateId: input.templateId ?? null,
          title: input.title ?? null,
          body: input.body ?? null,
          data: input.data ? (input.data as Prisma.InputJsonValue) : Prisma.JsonNull,
          status: 'QUEUED',
          referenceType: input.referenceType ?? null,
          referenceId: input.referenceId ?? null,
          deliveries: {
            create: {
              channel,
              recipient: input.recipient ?? null,
              deviceId: input.deviceId ?? null,
              status: 'QUEUED',
            },
          },
        },
        include: {
          deliveries: true,
        },
      });

      return {
        notification,
        delivery: notification.deliveries[0] ?? null,
        isDuplicate: false,
      };
    } catch (err: unknown) {
      if (
        input.idempotencyKey &&
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        // Unique constraint race condition hit
        const existing = await client.notification.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          include: { deliveries: true },
        });
        if (existing) {
          return {
            notification: existing,
            delivery: existing.deliveries[0] ?? null,
            isDuplicate: true,
          };
        }
      }
      throw err;
    }
  }

  async findNotificationById(id: string, tx?: TransactionClient): Promise<Notification | null> {
    return (tx ?? this.client).notification.findUnique({ where: { id } });
  }

  async findDeliveryById(
    id: string,
    tx?: TransactionClient,
  ): Promise<(NotificationDelivery & { notification: Notification | null }) | null> {
    return (tx ?? this.client).notificationDelivery.findUnique({
      where: { id },
      include: { notification: true },
    });
  }

  async updateDeliveryStatus(
    id: string,
    input: UpdateDeliveryInput,
    tx?: TransactionClient,
  ): Promise<NotificationDelivery> {
    return (tx ?? this.client).notificationDelivery.update({
      where: { id },
      data: deliveryData(input),
    });
  }

  // ── Per-device push delivery ─────────────────────────────────────────────
  //
  // State machine for one delivery: QUEUED → SENT | FAILED. Both are terminal;
  // nothing here ever writes QUEUED back. While QUEUED, a worker sending to the
  // device holds a short lease (`metadata.leaseUntil`), so two workers cannot
  // send the same delivery at once. The provider call happens between claim and
  // finalize, never inside a transaction.

  /// Binds a push notification's deliveries to devices — once, however many
  /// workers, retries or redeliveries reach it.
  ///
  /// The consumer creates one unbound QUEUED delivery with the notification. The
  /// first run that finds devices binds that row to the first device and adds
  /// one row per further device. The notification row is locked for the check
  /// and the writes, so a concurrent run waits and then sees the deliveries
  /// already bound, and adds nothing: one delivery per (notification, device).
  ///
  /// Returns every push delivery with its device's current token and trust
  /// state, read after the plan, so the caller sends to what the device holds now.
  async planDeviceDeliveries(
    notificationId: string,
    deviceIds: string[],
  ): Promise<PushDeliveryWithDevice[]> {
    return this.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM notifications WHERE id = ${notificationId}::uuid FOR UPDATE`;
      const existing = await tx.notificationDelivery.findMany({
        where: { notificationId, channel: 'PUSH' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const alreadyPlanned = existing.some((d) => d.deviceId !== null);
      const unbound = existing.find((d) => d.deviceId === null && d.status === 'QUEUED');
      const [first, ...rest] = deviceIds;

      if (!alreadyPlanned && unbound && first) {
        await tx.notificationDelivery.update({
          where: { id: unbound.id },
          data: { deviceId: first },
        });
        if (rest.length > 0) {
          await tx.notificationDelivery.createMany({
            data: rest.map((deviceId) => ({
              notificationId,
              channel: 'PUSH' as const,
              deviceId,
              status: 'QUEUED' as const,
            })),
          });
        }
      }

      return tx.notificationDelivery.findMany({
        where: { notificationId, channel: 'PUSH' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { device: { select: { id: true, fcmToken: true, trustState: true } } },
      });
    });
  }

  /// Takes the send lease on one QUEUED delivery, counting the attempt. Returns
  /// the new attempt number, or `null` if the delivery is terminal or another
  /// worker holds an unexpired lease — in which case the caller must not send.
  ///
  /// One conditional UPDATE, so exactly one of any number of concurrent callers
  /// wins. The lease uses the database clock on both sides of the comparison.
  async claimDelivery(deliveryId: string, leaseSeconds: number): Promise<number | null> {
    const rows = await this.client.$queryRaw<Array<{ attempts: number }>>`
      UPDATE notification_deliveries
      SET attempts = attempts + 1,
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{leaseUntil}',
            to_jsonb(now() + make_interval(secs => ${leaseSeconds}::double precision))
          )
      WHERE id = ${deliveryId}::uuid
        AND status = 'QUEUED'
        AND (metadata->>'leaseUntil' IS NULL OR (metadata->>'leaseUntil')::timestamptz < now())
      RETURNING attempts`;
    return rows[0]?.attempts ?? null;
  }

  /// Moves a delivery to a terminal state — only from QUEUED. Returns false if it
  /// was already terminal, so no path can overwrite SENT with FAILED or the reverse.
  async finalizeDelivery(
    deliveryId: string,
    input: UpdateDeliveryInput & { status: 'SENT' | 'FAILED' },
  ): Promise<boolean> {
    const { count } = await this.client.notificationDelivery.updateMany({
      where: { id: deliveryId, status: 'QUEUED' },
      data: deliveryData(input),
    });
    return count === 1;
  }

  /// A failed attempt: records why, drops the caller's lease, stays QUEUED for
  /// the retry.
  ///
  /// Ownership-safe: `attempt` is the number `claimDelivery` returned, and only a
  /// claim increments `attempts`, so `attempts = attempt` holds exactly while no
  /// other worker has reclaimed the delivery. A worker whose lease expired and was
  /// taken over matches nothing here, and cannot drop the new owner's lease.
  /// Returns whether this caller's lease was released.
  async releaseDelivery(
    deliveryId: string,
    attempt: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const count = await this.client.$executeRaw`
      UPDATE notification_deliveries
      SET error_code = ${errorCode},
          error_message = ${errorMessage},
          metadata = COALESCE(metadata, '{}'::jsonb) - 'leaseUntil'
      WHERE id = ${deliveryId}::uuid AND status = 'QUEUED' AND attempts = ${attempt}`;
    return count === 1;
  }

  /// Every delivery still QUEUED becomes FAILED — on exhausted retries, and when
  /// the reconciliation sweep settles a notification that must not be sent. Takes
  /// the sweep's transaction so the write happens under its row lock.
  async failQueuedDeliveries(
    notificationId: string,
    failureReason: string,
    options: { errorCode?: string; tx?: TransactionClient } = {},
  ): Promise<number> {
    const { count } = await (options.tx ?? this.client).notificationDelivery.updateMany({
      where: { notificationId, status: 'QUEUED' },
      data: {
        status: 'FAILED',
        failureReason,
        ...(options.errorCode ? { errorCode: options.errorCode } : {}),
      },
    });
    return count;
  }

  /// Derives the notification's status from its deliveries.
  ///
  /// SENT as soon as any device got it — one dead handset does not make the
  /// notification a failure. FAILED only when every delivery is terminal and none
  /// was sent. Otherwise unchanged, while deliveries are still being retried.
  /// Conditional writes: FAILED only from PENDING/QUEUED; SENT also from FAILED,
  /// which only a concurrent settle racing a late success could have written.
  async settleNotification(
    notificationId: string,
    tx?: TransactionClient,
  ): Promise<NotificationStatus | null> {
    const client = tx ?? this.client;
    const deliveries = await client.notificationDelivery.findMany({
      where: { notificationId },
      select: { status: true },
    });
    if (deliveries.length === 0) return null;
    const anySent = deliveries.some((d) => d.status === 'SENT' || d.status === 'DELIVERED');
    const allTerminal = deliveries.every((d) => d.status !== 'QUEUED' && d.status !== 'PENDING');
    if (anySent) {
      await client.notification.updateMany({
        where: { id: notificationId, status: { in: ['PENDING', 'QUEUED', 'FAILED'] } },
        data: { status: 'SENT' },
      });
      return 'SENT';
    }
    if (allTerminal) {
      await client.notification.updateMany({
        where: { id: notificationId, status: { in: ['PENDING', 'QUEUED'] } },
        data: { status: 'FAILED' },
      });
      return 'FAILED';
    }
    return null;
  }

  // ── Reconciliation (PA-11) ───────────────────────────────────────────────

  /// QUEUED notifications created before `createdBefore`, oldest first, bounded,
  /// continuing after `after` when given (keyset on `(createdAt, id)`). Only the
  /// keys: each is re-read under its own row lock before anything is decided.
  async findStaleQueuedNotifications(
    createdBefore: Date,
    limit: number,
    after?: { createdAt: Date; id: string },
  ): Promise<Array<{ id: string; createdAt: Date }>> {
    return this.client.notification.findMany({
      where: {
        status: 'QUEUED',
        createdAt: { lt: createdBefore },
        ...(after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, createdAt: true },
    });
  }

  /// Runs `work` with the notification row locked, if it is still QUEUED and no
  /// one else holds it. Returns `null` otherwise — another reconciler has it, a
  /// worker is planning it, or it settled since the scan.
  ///
  /// `FOR UPDATE SKIP LOCKED` is the claim: at most one reconciler evaluates a
  /// notification at a time, and the delivery job's planning step (which locks
  /// the same row) waits for the decision rather than racing it. No column is
  /// needed; the lock lasts exactly as long as the decision. The timeout covers
  /// the bounded queue calls `work` may make.
  async withQueuedNotificationLocked<T>(
    notificationId: string,
    work: (
      tx: TransactionClient,
      notification: Notification & {
        deliveries: Array<{ id: string; status: NotificationStatus }>;
      },
    ) => Promise<T>,
  ): Promise<T | null> {
    return this.client.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM notifications
          WHERE id = ${notificationId}::uuid AND status = 'QUEUED'
          FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return null;
        const notification = await tx.notification.findUnique({
          where: { id: notificationId },
          include: {
            deliveries: {
              where: { channel: 'PUSH' },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, status: true },
            },
          },
        });
        return notification ? work(tx, notification) : null;
      },
      { maxWait: 5_000, timeout: 15_000 },
    );
  }

  async updateNotificationStatus(
    id: string,
    status: NotificationStatus,
    tx?: TransactionClient,
  ): Promise<Notification> {
    return (tx ?? this.client).notification.update({
      where: { id },
      data: { status },
    });
  }
}

export type PushDeliveryWithDevice = NotificationDelivery & {
  device: { id: string; fcmToken: string | null; trustState: DeviceTrustState } | null;
};

function deliveryData(
  input: UpdateDeliveryInput,
): Prisma.NotificationDeliveryUncheckedUpdateManyInput {
  return {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.providerMessageId !== undefined
      ? { providerMessageId: input.providerMessageId }
      : {}),
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
    ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
    ...(input.deliveredAt !== undefined ? { deliveredAt: input.deliveredAt } : {}),
    ...(input.metadata !== undefined
      ? {
          metadata: input.metadata ? (input.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
        }
      : {}),
  };
}
