import { DatabaseService } from '@core/database';
import { NotificationService } from '@modules/notifications';
import type {
  AdminBroadcastStatus,
  NotificationChannel,
  Prisma,
} from '../../../generated/prisma/index.js';
import { recordAdminAction } from '../audit/index.js';
import {
  BroadcastConflictError,
  BroadcastNotFoundError,
  TemplateNotFoundError,
} from './communications.errors.js';
import type {
  BroadcastTargeting,
  PushHistoryQuery,
  SchedulePushBody,
  SendPushBody,
} from './communications.schemas.js';

export interface BroadcastDto {
  id: string;
  title: string;
  body: string;
  channel: NotificationChannel;
  targeting: BroadcastTargeting | null;
  status: AdminBroadcastStatus;
  scheduledAt: string | null;
  sentAt: string | null;
  sentCount: number;
  failedCount: number;
  totalRecipients: number;
  failureReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ResolvedRecipient {
  userId: string;
  recipient: string;
  deviceId: string | null;
}

function toBroadcastDto(row: {
  id: string;
  title: string;
  body: string;
  channel: NotificationChannel;
  targeting: unknown;
  status: AdminBroadcastStatus;
  scheduledAt: Date | null;
  sentAt: Date | null;
  sentCount: number;
  failedCount: number;
  totalRecipients: number;
  failureReason: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): BroadcastDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    channel: row.channel,
    targeting:
      row.targeting && typeof row.targeting === 'object' && !Array.isArray(row.targeting)
        ? (row.targeting as BroadcastTargeting)
        : null,
    status: row.status,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    totalRecipients: row.totalRecipients,
    failureReason: row.failureReason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AdminCommunicationsPushService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationService: NotificationService,
  ) {}

  private get client() {
    return this.databaseService.client;
  }

  private async resolveRecipients(targeting: BroadcastTargeting): Promise<ResolvedRecipient[]> {
    if (targeting.all) {
      const devices = await this.client.userDevice.findMany({
        where: { fcmToken: { not: null } },
        select: { id: true, userId: true, fcmToken: true },
      });
      return devices
        .filter((device): device is typeof device & { fcmToken: string } =>
          Boolean(device.fcmToken),
        )
        .map((device) => ({
          userId: device.userId,
          recipient: device.fcmToken,
          deviceId: device.id,
        }));
    }

    const userIds = new Set<string>(targeting.userIds ?? []);

    if (targeting.roles?.length) {
      const assignments = await this.client.userRoleAssignment.findMany({
        where: { role: { slug: { in: targeting.roles } } },
        select: { userId: true },
      });
      for (const assignment of assignments) {
        userIds.add(assignment.userId);
      }
    }

    if (userIds.size === 0) {
      return [];
    }

    const devices = await this.client.userDevice.findMany({
      where: {
        userId: { in: [...userIds] },
        fcmToken: { not: null },
      },
      select: { id: true, userId: true, fcmToken: true },
    });

    return devices
      .filter((device): device is typeof device & { fcmToken: string } => Boolean(device.fcmToken))
      .map((device) => ({
        userId: device.userId,
        recipient: device.fcmToken,
        deviceId: device.id,
      }));
  }

  private async dispatchBroadcast(
    broadcastId: string,
    input: {
      title: string;
      body: string;
      templateId?: string | undefined;
      data?: Record<string, string> | undefined;
      targeting: BroadcastTargeting;
    },
    actorId?: string,
  ): Promise<BroadcastDto> {
    if (input.templateId) {
      const template = await this.client.notificationTemplate.findUnique({
        where: { id: input.templateId },
      });
      if (!template) {
        throw new TemplateNotFoundError(`Notification template '${input.templateId}' not found`);
      }
    }

    const recipients = await this.resolveRecipients(input.targeting);
    const now = new Date();
    let sentCount = 0;
    let failedCount = 0;

    await this.client.adminBroadcast.update({
      where: { id: broadcastId },
      data: {
        status: 'SENDING',
        totalRecipients: recipients.length,
      },
    });

    for (const recipient of recipients) {
      try {
        const result = await this.notificationService.sendPush(
          recipient.recipient,
          input.title,
          input.body,
          input.data,
        );

        await this.client.notificationDelivery.create({
          data: {
            channel: 'PUSH',
            templateId: input.templateId ?? null,
            recipient: recipient.recipient,
            target: recipient.recipient,
            deviceId: recipient.deviceId,
            status: result.accepted ? 'SENT' : 'FAILED',
            failureReason: result.accepted ? null : (result.error ?? 'Push delivery failed'),
            errorMessage: result.accepted ? null : (result.error ?? 'Push delivery failed'),
            provider: result.provider,
            providerMessageId: result.providerRef ?? null,
            sentAt: result.accepted ? now : null,
            metadata: {
              broadcastId,
              userId: recipient.userId,
              ...(input.data ?? {}),
            },
          },
        });

        if (result.accepted) {
          sentCount += 1;
        } else {
          failedCount += 1;
        }
      } catch (error) {
        failedCount += 1;
        const message = error instanceof Error ? error.message : 'Push delivery failed';
        await this.client.notificationDelivery.create({
          data: {
            channel: 'PUSH',
            templateId: input.templateId ?? null,
            recipient: recipient.recipient,
            target: recipient.recipient,
            deviceId: recipient.deviceId,
            status: 'FAILED',
            failureReason: message,
            errorMessage: message,
            metadata: {
              broadcastId,
              userId: recipient.userId,
            },
          },
        });
      }
    }

    const status: AdminBroadcastStatus =
      recipients.length === 0 ? 'FAILED' : failedCount === recipients.length ? 'FAILED' : 'SENT';

    const updated = await this.client.$transaction(async (tx) => {
      const row = await tx.adminBroadcast.update({
        where: { id: broadcastId },
        data: {
          status,
          sentAt: now,
          sentCount,
          failedCount,
          failureReason:
            recipients.length === 0
              ? 'No push-enabled devices matched targeting'
              : failedCount > 0
                ? `${failedCount} deliveries failed`
                : null,
        },
      });

      await recordAdminAction(tx, {
        ...(actorId ? { actorId } : {}),
        action: 'CREATE',
        entityType: 'admin_broadcast',
        entityId: row.id,
        summary: `Sent push broadcast to ${sentCount}/${recipients.length} devices`,
        after: toBroadcastDto(row),
      });

      return row;
    });

    return toBroadcastDto(updated);
  }

  async send(body: SendPushBody, actorId?: string): Promise<BroadcastDto> {
    const created = await this.client.adminBroadcast.create({
      data: {
        title: body.title,
        body: body.body,
        channel: 'PUSH',
        targeting: body.targeting as Prisma.InputJsonValue,
        status: 'SENDING',
        createdBy: actorId ?? null,
      },
    });

    return this.dispatchBroadcast(
      created.id,
      {
        title: body.title,
        body: body.body,
        targeting: body.targeting,
        ...(body.templateId ? { templateId: body.templateId } : {}),
        ...(body.data ? { data: body.data } : {}),
      },
      actorId,
    );
  }

  async schedule(body: SchedulePushBody, actorId?: string): Promise<BroadcastDto> {
    const created = await this.client.adminBroadcast.create({
      data: {
        title: body.title,
        body: body.body,
        channel: 'PUSH',
        targeting: body.targeting as Prisma.InputJsonValue,
        status: 'SCHEDULED',
        scheduledAt: body.scheduledAt,
        createdBy: actorId ?? null,
      },
    });

    if (actorId) {
      await recordAdminAction(this.client, {
        actorId,
        action: 'CREATE',
        entityType: 'admin_broadcast',
        entityId: created.id,
        summary: `Scheduled push broadcast for ${body.scheduledAt.toISOString()}`,
        after: toBroadcastDto(created),
      });
    }

    return toBroadcastDto(created);
  }

  async listHistory(query: PushHistoryQuery): Promise<{
    data: BroadcastDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.AdminBroadcastWhereInput = {
      channel: 'PUSH',
      ...(query.status ? { status: query.status } : {}),
    };

    const skip = (query.page - 1) * query.limit;
    const [rows, totalCount] = await Promise.all([
      this.client.adminBroadcast.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
      }),
      this.client.adminBroadcast.count({ where }),
    ]);

    return {
      data: rows.map(toBroadcastDto),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async retry(id: string, actorId?: string): Promise<BroadcastDto> {
    const broadcast = await this.client.adminBroadcast.findUnique({ where: { id } });
    if (!broadcast) {
      throw new BroadcastNotFoundError(`Push broadcast '${id}' not found`);
    }

    if (!['FAILED', 'SENT'].includes(broadcast.status)) {
      throw new BroadcastConflictError('Only failed or partially sent broadcasts can be retried');
    }

    const targeting =
      broadcast.targeting &&
      typeof broadcast.targeting === 'object' &&
      !Array.isArray(broadcast.targeting)
        ? (broadcast.targeting as BroadcastTargeting)
        : null;

    if (!targeting) {
      throw new BroadcastConflictError('Broadcast has no targeting configuration to retry');
    }

    await this.client.adminBroadcast.update({
      where: { id },
      data: {
        status: 'SENDING',
        failureReason: null,
        sentCount: 0,
        failedCount: 0,
        totalRecipients: 0,
      },
    });

    return this.dispatchBroadcast(
      id,
      {
        title: broadcast.title,
        body: broadcast.body,
        targeting,
      },
      actorId,
    );
  }
}
