import { DatabaseService, UniqueConstraintError } from '@core/database';
import { NotificationService } from '@modules/notifications';
import type {
  AdminBroadcastStatus,
  NotificationChannel,
  Prisma,
} from '../../../generated/prisma/index.js';
import { recordAdminAction, type AuditActor } from '../audit/index.js';
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

/// Key-order-independent JSON, so a targeting object read back from Postgres compares equal
/// to the one the client sent.
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
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
    actor: AuditActor,
  ): Promise<BroadcastDto> {
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

      // The outcome row, after the provider has answered for every recipient. Its
      // REQUESTED row was written when the broadcast was claimed, so a crash mid-send
      // leaves "requested, outcome unknown" — never a success that did not happen.
      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'admin_broadcast',
        entityId: row.id,
        summary: `Sent push broadcast to ${sentCount}/${recipients.length} devices`,
        after: toBroadcastDto(row),
        result: status === 'FAILED' ? 'FAILED' : 'SUCCESS',
      });

      return row;
    });

    return toBroadcastDto(updated);
  }

  /// The broadcast row and its REQUESTED audit row commit together before any provider
  /// is called; the outcome row follows the sends.
  async send(body: SendPushBody, actor: AuditActor): Promise<BroadcastDto> {
    if (body.templateId) {
      const template = await this.client.notificationTemplate.findUnique({
        where: { id: body.templateId },
      });
      if (!template) {
        throw new TemplateNotFoundError(`Notification template '${body.templateId}' not found`);
      }
    }

    const created = await this.databaseService.transactionManager.execute(async (tx) => {
      const row = await tx.adminBroadcast.create({
        data: {
          title: body.title,
          body: body.body,
          channel: 'PUSH',
          targeting: body.targeting as Prisma.InputJsonValue,
          status: 'SENDING',
          createdBy: actor.actorId,
        },
      });
      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'admin_broadcast',
        entityId: row.id,
        summary: 'Push broadcast requested',
        after: toBroadcastDto(row),
        result: 'REQUESTED',
      });
      return row;
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
      actor,
    );
  }

  /// The broadcast row and its audit row commit together. Nothing is sent here, so there
  /// is no external step for the audit to run ahead of.
  ///
  /// With an Idempotency-Key the key is stored on the row under a (creator, key) unique
  /// index, in the same transaction: a retry or a concurrent duplicate either finds the
  /// row first or loses the insert race — its transaction, audit row included, rolls back
  /// — and is answered with the one broadcast that exists. The same key with a different
  /// broadcast is refused.
  async schedule(
    body: SchedulePushBody,
    actor: AuditActor,
    idempotencyKey?: string,
  ): Promise<BroadcastDto> {
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(actor.actorId, idempotencyKey, body);
      if (existing) return existing;
    }
    try {
      return await this.databaseService.transactionManager.execute(async (tx) => {
        const created = await tx.adminBroadcast.create({
          data: {
            title: body.title,
            body: body.body,
            channel: 'PUSH',
            targeting: body.targeting as Prisma.InputJsonValue,
            status: 'SCHEDULED',
            scheduledAt: body.scheduledAt,
            createdBy: actor.actorId,
            ...(idempotencyKey ? { idempotencyKey } : {}),
          },
        });
        await recordAdminAction(tx, {
          ...actor,
          action: 'CREATE',
          entityType: 'admin_broadcast',
          entityId: created.id,
          summary: `Scheduled push broadcast for ${body.scheduledAt.toISOString()}`,
          after: toBroadcastDto(created),
          result: 'SUCCESS',
        });
        return toBroadcastDto(created);
      });
    } catch (err) {
      if (idempotencyKey && err instanceof UniqueConstraintError) {
        const winner = await this.findByIdempotencyKey(actor.actorId, idempotencyKey, body);
        if (winner) return winner;
      }
      throw err;
    }
  }

  private async findByIdempotencyKey(
    createdBy: string,
    idempotencyKey: string,
    body: SchedulePushBody,
  ): Promise<BroadcastDto | null> {
    const row = await this.client.adminBroadcast.findUnique({
      where: { createdBy_idempotencyKey: { createdBy, idempotencyKey } },
    });
    if (!row) return null;
    const same =
      row.title === body.title &&
      row.body === body.body &&
      row.scheduledAt?.getTime() === body.scheduledAt.getTime() &&
      stableJson(row.targeting) === stableJson(body.targeting);
    if (!same) {
      throw new BroadcastConflictError(
        'This Idempotency-Key was already used to schedule a different broadcast',
      );
    }
    return toBroadcastDto(row);
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

  /// The broadcast is claimed with a conditional update — only from FAILED or SENT — in
  /// the same transaction as its REQUESTED row. Two concurrent retries used to both pass a
  /// status check made before the update, and both send.
  async retry(id: string, actor: AuditActor): Promise<BroadcastDto> {
    const broadcast = await this.databaseService.transactionManager.execute(async (tx) => {
      const row = await tx.adminBroadcast.findUnique({ where: { id } });
      if (!row) {
        throw new BroadcastNotFoundError(`Push broadcast '${id}' not found`);
      }
      const targeting =
        row.targeting && typeof row.targeting === 'object' && !Array.isArray(row.targeting)
          ? (row.targeting as BroadcastTargeting)
          : null;
      if (!targeting) {
        throw new BroadcastConflictError('Broadcast has no targeting configuration to retry');
      }

      const { count } = await tx.adminBroadcast.updateMany({
        where: { id, status: { in: ['FAILED', 'SENT'] } },
        data: {
          status: 'SENDING',
          failureReason: null,
          sentCount: 0,
          failedCount: 0,
          totalRecipients: 0,
        },
      });
      if (count === 0) {
        throw new BroadcastConflictError('Only failed or partially sent broadcasts can be retried');
      }
      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'admin_broadcast',
        entityId: id,
        summary: 'Push broadcast retry requested',
        before: { status: row.status, sentCount: row.sentCount, failedCount: row.failedCount },
        result: 'REQUESTED',
      });
      return { title: row.title, body: row.body, targeting };
    });

    return this.dispatchBroadcast(id, broadcast, actor);
  }
}
