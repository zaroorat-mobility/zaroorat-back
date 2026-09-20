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
      data: {
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
              metadata: input.metadata
                ? (input.metadata as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            }
          : {}),
      },
    });
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
