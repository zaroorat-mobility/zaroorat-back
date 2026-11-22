import { DatabaseService } from '@core/database';
import type { NotificationChannel, Prisma } from '../../../generated/prisma/index.js';
import { recordAdminAction } from '../audit/index.js';
import { TemplateConflictError, TemplateNotFoundError } from './communications.errors.js';
import type {
  CreateTemplateBody,
  ListTemplatesQuery,
  UpdateTemplateBody,
} from './communications.schemas.js';

export interface TemplateDto {
  id: string;
  eventKey: string;
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  variables: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function toTemplateDto(row: {
  id: string;
  eventKey: string | null;
  code: string;
  channel: NotificationChannel;
  subject: string | null;
  titleTemplate: string | null;
  bodyTemplate: string;
  variables: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): TemplateDto {
  const variables = Array.isArray(row.variables)
    ? row.variables.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    id: row.id,
    eventKey: row.eventKey ?? row.code,
    channel: row.channel,
    subject: row.subject ?? row.titleTemplate,
    body: row.bodyTemplate,
    variables,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function variablesToJson(variables: string[] | undefined): Prisma.InputJsonValue {
  return variables && variables.length > 0 ? variables : [];
}

export class AdminCommunicationsTemplateService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get client() {
    return this.databaseService.client;
  }

  async list(query: ListTemplatesQuery): Promise<{
    data: TemplateDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.NotificationTemplateWhereInput = {
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.eventKey ? { eventKey: query.eventKey } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    const skip = (query.page - 1) * query.limit;
    const [rows, totalCount] = await Promise.all([
      this.client.notificationTemplate.findMany({
        where,
        orderBy: [{ channel: 'asc' }, { eventKey: 'asc' }],
        skip,
        take: query.limit,
      }),
      this.client.notificationTemplate.count({ where }),
    ]);

    return {
      data: rows.map(toTemplateDto),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async create(body: CreateTemplateBody, actorId?: string): Promise<TemplateDto> {
    const existing = await this.client.notificationTemplate.findFirst({
      where: { channel: body.channel, eventKey: body.eventKey },
    });
    if (existing) {
      throw new TemplateConflictError(
        `Template already exists for ${body.channel}/${body.eventKey}`,
      );
    }

    const created = await this.client.$transaction(async (tx) => {
      const row = await tx.notificationTemplate.create({
        data: {
          code: body.eventKey,
          eventKey: body.eventKey,
          channel: body.channel,
          subject: body.subject ?? null,
          titleTemplate: body.subject ?? null,
          bodyTemplate: body.body,
          variables: variablesToJson(body.variables),
          isActive: body.isActive,
        },
      });

      await recordAdminAction(tx, {
        ...(actorId ? { actorId } : {}),
        action: 'CREATE',
        entityType: 'notification_template',
        entityId: row.id,
        summary: `Created notification template ${body.channel}/${body.eventKey}`,
        after: toTemplateDto(row),
      });

      return row;
    });

    return toTemplateDto(created);
  }

  async update(id: string, body: UpdateTemplateBody, actorId?: string): Promise<TemplateDto> {
    const existing = await this.client.notificationTemplate.findUnique({ where: { id } });
    if (!existing) {
      throw new TemplateNotFoundError(`Notification template '${id}' not found`);
    }

    const nextEventKey = body.eventKey ?? existing.eventKey ?? existing.code;
    const nextChannel = body.channel ?? existing.channel;

    if (nextEventKey !== existing.eventKey || nextChannel !== existing.channel) {
      const conflict = await this.client.notificationTemplate.findFirst({
        where: {
          id: { not: id },
          channel: nextChannel,
          eventKey: nextEventKey,
        },
      });
      if (conflict) {
        throw new TemplateConflictError(
          `Template already exists for ${nextChannel}/${nextEventKey}`,
        );
      }
    }

    const updated = await this.client.$transaction(async (tx) => {
      const row = await tx.notificationTemplate.update({
        where: { id },
        data: {
          ...(body.eventKey !== undefined ? { eventKey: body.eventKey, code: body.eventKey } : {}),
          ...(body.channel !== undefined ? { channel: body.channel } : {}),
          ...(body.subject !== undefined
            ? { subject: body.subject, titleTemplate: body.subject }
            : {}),
          ...(body.body !== undefined ? { bodyTemplate: body.body } : {}),
          ...(body.variables !== undefined ? { variables: variablesToJson(body.variables) } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          version: { increment: 1 },
        },
      });

      await recordAdminAction(tx, {
        ...(actorId ? { actorId } : {}),
        action: 'UPDATE',
        entityType: 'notification_template',
        entityId: row.id,
        summary: `Updated notification template ${row.channel}/${row.eventKey ?? row.code}`,
        before: toTemplateDto(existing),
        after: toTemplateDto(row),
      });

      return row;
    });

    return toTemplateDto(updated);
  }
}
