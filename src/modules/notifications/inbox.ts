import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { asClass, type AwilixContainer } from 'awilix';
import { callerId } from '@core/auth';
import { container } from '@core/di';
import { NotificationRepository } from './repositories/notification.repository.js';

const PREFERENCE_CATEGORIES = ['TRANSACTIONAL', 'PROMOTIONAL', 'SAFETY', 'SYSTEM'] as const;
const LOCKED_CATEGORIES = new Set(['TRANSACTIONAL', 'SAFETY']);

const listQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const putPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        category: z.enum(PREFERENCE_CATEGORIES),
        channel: z.enum(['PUSH', 'SMS', 'EMAIL', 'IN_APP', 'WHATSAPP']).default('PUSH'),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(20),
});

function publicNotification(row: {
  id: string;
  eventKey: string | null;
  category: string;
  priority: string;
  title: string | null;
  body: string | null;
  data: unknown;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
  readAt: Date | null;
}) {
  return {
    id: row.id,
    eventKey: row.eventKey,
    category: row.category,
    priority: row.priority,
    title: row.title,
    body: row.body,
    data: row.data,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    unread: row.readAt == null,
  };
}

export class NotificationInboxService {
  constructor(private readonly notificationRepository: NotificationRepository) {}

  async list(userId: string, query: { cursor?: string; limit?: number }) {
    const page = await this.notificationRepository.listForUser(userId, query);
    return {
      items: page.items.map(publicNotification),
      nextCursor: page.nextCursor,
    };
  }

  async markRead(userId: string, id: string) {
    const updated = await this.notificationRepository.markRead(userId, id);
    if (!updated) return null;
    return publicNotification(updated);
  }

  async markAllRead(userId: string) {
    const count = await this.notificationRepository.markAllRead(userId);
    return { updated: count };
  }

  async getPreferences(userId: string) {
    const rows = await this.notificationRepository.listPreferences(userId);
    const byKey = new Map(rows.map((r) => [`${r.category}:${r.channel}`, r]));
    return PREFERENCE_CATEGORIES.map((category) => {
      const existing = byKey.get(`${category}:PUSH`);
      const locked = LOCKED_CATEGORIES.has(category);
      return {
        category,
        channel: 'PUSH' as const,
        enabled: locked ? true : (existing?.enabled ?? true),
        locked,
      };
    });
  }

  async putPreferences(
    userId: string,
    preferences: Array<{
      category: (typeof PREFERENCE_CATEGORIES)[number];
      channel: string;
      enabled: boolean;
    }>,
  ) {
    for (const pref of preferences) {
      if (LOCKED_CATEGORIES.has(pref.category)) continue;
      await this.notificationRepository.upsertPreference(
        userId,
        pref.category,
        (pref.channel as 'PUSH') ?? 'PUSH',
        pref.enabled,
      );
    }
    return this.getPreferences(userId);
  }
}

export class NotificationInboxController {
  constructor(private readonly notificationInboxService: NotificationInboxService) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listQuerySchema.parse(req.query ?? {});
    const data = await this.notificationInboxService.list(callerId(req), {
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit != null ? { limit: query.limit } : {}),
    });
    reply.send({ data });
  }

  async markRead(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const data = await this.notificationInboxService.markRead(callerId(req), id);
    if (!data) {
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Notification not found' } });
      return;
    }
    reply.send({ data });
  }

  async markAllRead(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.notificationInboxService.markAllRead(callerId(req));
    reply.send({ data });
  }

  async getPreferences(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.notificationInboxService.getPreferences(callerId(req));
    reply.send({ data });
  }

  async putPreferences(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = putPreferencesSchema.parse(req.body);
    const data = await this.notificationInboxService.putPreferences(
      callerId(req),
      body.preferences,
    );
    reply.send({ data });
  }
}

export function registerNotificationInbox(c: AwilixContainer): void {
  c.register({
    notificationInboxService: asClass(NotificationInboxService).singleton(),
    notificationInboxController: asClass(NotificationInboxController).singleton(),
  });
}

export async function notificationInboxRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<NotificationInboxController>('notificationInboxController');
  const uuidParams = {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            pattern:
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          },
        },
      },
    },
  } as const;

  fastify.get('/', (req, reply) => controller.list(req, reply));
  fastify.post('/read-all', (req, reply) => controller.markAllRead(req, reply));
  fastify.get('/preferences', (req, reply) => controller.getPreferences(req, reply));
  fastify.put('/preferences', (req, reply) => controller.putPreferences(req, reply));
  fastify.post('/:id/read', uuidParams, (req, reply) => controller.markRead(req, reply));
}
